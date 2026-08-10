import { mkdtempSync, existsSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { Db } from './db';
import { openDbRaw } from './db';
import { BACKUP_DIR } from './backup';
import { createDesk, applyDeskCommand, getDeskState } from './deskStore';
import { migrateSafely, MigrationFehlgeschlagen, PRE_MIGRATION_PREFIX } from './migrateSafely';

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * SAFE-04: vor jeder Schema-Migration entsteht ein Pre-Migration-Backup; scheitert migrate(),
 * wird es zurückgespielt, die verwaisten WAL-/SHM-Seitendateien entfernt und der Fehler laut
 * weitergereicht (05-RESEARCH „Architecture Pattern 3", D-06/D-07). Baut auf den in Plan 05-03
 * geschaffenen Bausteinen backupTo()/restoreDbFile()/openDbRaw() auf (05-03-SUMMARY.md).
 *
 * Fehlschlag-Einspeisung (D-20): ein vi.spyOn auf Database.prototype.exec wirft genau bei der
 * ersten DDL-Anweisung, die eine in migrate() angelegte Tabelle betrifft — kein Produktivcode
 * wird für die Testbarkeit umgebaut, migrate() bleibt Zeile für Zeile unverändert.
 */

/** Baut eine Bestands-Datenbank auf, wie sie VOR dieser Phase auf der Platte läge: desk_roles
 *  existiert noch nicht (analog zum Muster in migration.real.test.ts). Liefert die offene
 *  Verbindung, den Dateipfad und die id des angelegten Schreibtischs. */
function baueBestandsDb(dir: string): { dbFile: string; db: Db; deskId: string } {
  const dbFile = join(dir, 'desktop.sqlite');
  const db = openDbRaw(dbFile);
  db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)').run('u1', 'anwalt', 'h', 0);
  const desk = createDesk(db, 'u1', 'Bestand');
  applyDeskCommand(db, desk.id, { type: 'addNote', payload: { kind: 'notiz', text: 'Bestands-Notiz', position: { x: 1, y: 2 } } });
  // Bestands-DB VOR dieser Phase simulieren: desk_roles existiert noch nicht.
  db.exec('DROP TABLE desk_roles');
  return { dbFile, db, deskId: desk.id };
}

/** Schema- und Datenstand, wie im Tracer-Fall gefordert: Tabellenliste, Spaltenliste von
 *  `files`, Desk-Anzahl und der Zustand des Schreibtischs. Nimmt bewusst eine beliebige
 *  Database-Verbindung entgegen (auch eine readonly-Rohverbindung ohne Schema-Bootstrap), damit
 *  eine Prüfung des zurückgespielten Standes nicht selbst Tabellen nachzieht. */
function schemaSchnappschuss(db: Database.Database, deskId: string) {
  return {
    tabellen: (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map(
      (r) => r.name,
    ),
    dateiSpalten: (db.prepare('PRAGMA table_info(files)').all() as { name: string }[]).map((c) => c.name),
    deskCount: (db.prepare('SELECT COUNT(*) AS n FROM desks').get() as { n: number }).n,
    deskState: getDeskState(db, deskId),
  };
}

/** D-20: wirft genau bei der ersten DDL-Anweisung, die `desk_roles` (eine von migrate()
 *  angelegte Tabelle) betrifft — alle anderen exec()-Aufrufe laufen unverändert durch den
 *  echten Aufruf. */
function installiereFehlschlagSpy(): ReturnType<typeof vi.spyOn> {
  const originalExec = Database.prototype.exec;
  let geworfen = false;
  return vi.spyOn(Database.prototype, 'exec').mockImplementation(function (this: Database.Database, sql: string) {
    if (!geworfen && sql.includes('CREATE TABLE IF NOT EXISTS desk_roles')) {
      geworfen = true;
      throw new Error('Simulierter Migrationsfehler (D-20)');
    }
    return originalExec.call(this, sql);
  });
}

/** Öffnet eine bestehende Datenbankdatei erneut, OHNE das Basisschema aus openDbRaw() nachzuziehen
 *  (das würde eine fehlende `desk_roles`-Tabelle additiv wiederherstellen und damit genau den
 *  Bestandszustand maskieren, den ein wiederholter migrateSafely()-Aufruf hier prüfen soll). Nur
 *  für die Wiederholbarkeits-Prüfung (D-07) gedacht — der reguläre Öffnungsweg bleibt openDbRaw(). */
function reopneOhneSchemaBootstrap(path: string): Db {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

/** Objektzahlen je Art — dieselbe Prüfung wie in migration.real.test.ts: eine erfolgreiche
 *  Migration darf keine Objekte stillschweigend wegnehmen. */
function zaehleObjekteProArt(state: { docs: unknown[]; notes: unknown[] }): { docs: number; notes: number } {
  return { docs: state.docs.length, notes: state.notes.length };
}

describe('migrateSafely — Tracer: Migration scheitert, Vorzustand steht wieder, Start bricht laut ab', () => {
  it('rollt bei einem Fehlschlag zur Vorzustands-DB zurück (Schema, Spalten, Desk-Anzahl, Schreibtisch-Zustand unverändert) und wirft MigrationFehlgeschlagen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dd-migrate-safely-'));
    const { dbFile, db, deskId } = baueBestandsDb(dir);
    const vorher = schemaSchnappschuss(db, deskId);
    expect(vorher.tabellen).not.toContain('desk_roles');

    const spy = installiereFehlschlagSpy();
    try {
      await expect(migrateSafely(db, dbFile, dir)).rejects.toBeInstanceOf(MigrationFehlgeschlagen);
    } finally {
      spy.mockRestore();
    }
    // migrateSafely() hat die Verbindung im catch-Zweig bereits selbst geschlossen (db.close()) —
    // der Prozess soll laut abbrechen statt mit einer offenen Verbindung auf halb migriertem
    // Schema weiterzulaufen (T-05-15). Die Prüfung unten öffnet deshalb bewusst neu.

    // Zurückgespielter Stand: eigenständige (readonly) Rohverbindung, damit die Prüfung selbst
    // KEINE Tabellen nachzieht (openDbRaw()/openDb() würden desk_roles beim Öffnen additiv
    // wiederherstellen und den Vergleich verfälschen).
    const dbNachRollback = new Database(dbFile, { readonly: true });
    const nachher = schemaSchnappschuss(dbNachRollback, deskId);
    expect(nachher).toEqual(vorher);
    dbNachRollback.close();
  });
});

describe('migrateSafely — Rollback-Testmatrix: Erfolgspfad, Seitendateien, Wiederholbarkeit, Backup-Erhalt (D-07)', () => {
  it('Erfolgspfad: migrate() gelingt, es wird NICHTS zurückgespielt, die additiven Schemateile stehen, die Objektzahlen je Art bleiben unverändert, und genau ein Pre-Migration-Backup liegt vor', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dd-migrate-safely-'));
    const { dbFile, db, deskId } = baueBestandsDb(dir);
    const vorherZaehlung = zaehleObjekteProArt(getDeskState(db, deskId)!.state);

    const ergebnis = await migrateSafely(db, dbFile, dir);
    expect(ergebnis.db).toBe(db);

    // Additiver Schemateil aus migrate(): desk_roles existiert wieder und der Eigentümer hat
    // seine Rolle zurück (Backfill, T-02-06) — nichts wurde zurückgespielt.
    const tabellen = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map(
      (r) => r.name,
    );
    expect(tabellen).toContain('desk_roles');
    const eigentuemerZeile = db.prepare('SELECT rolle FROM desk_roles WHERE desk_id = ? AND user_id = ?').get(deskId, 'u1') as
      | { rolle: string }
      | undefined;
    expect(eigentuemerZeile?.rolle).toBe('Eigentümer');

    // Keine stille Wegnahme: Objektzahlen je Art unverändert.
    const nachherZaehlung = zaehleObjekteProArt(getDeskState(db, deskId)!.state);
    expect(nachherZaehlung).toEqual(vorherZaehlung);

    // Genau ein Pre-Migration-Backup liegt vor (D-21) — die keep=5-Rotation der regulären
    // Backups betrifft es nicht, weil rotateBackup() hier gar nicht lief.
    const backupDir = join(dir, BACKUP_DIR);
    const preMigrationDateien = readdirSync(backupDir).filter((f) => f.startsWith(PRE_MIGRATION_PREFIX));
    expect(preMigrationDateien).toHaveLength(1);

    db.close();
  });

  it('entfernt die WAL-/SHM-Seitendateien der defekten Fassung: eine nicht-leere -wal-Datei existiert vor dem Fehlschlag, nach dem Rollback keine mehr', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dd-migrate-safely-'));
    const { dbFile, db, deskId } = baueBestandsDb(dir);

    const walPfad = `${dbFile}-wal`;
    expect(existsSync(walPfad)).toBe(true);
    expect(statSync(walPfad).size).toBeGreaterThan(0);

    const spy = installiereFehlschlagSpy();
    try {
      await expect(migrateSafely(db, dbFile, dir)).rejects.toBeInstanceOf(MigrationFehlgeschlagen);
    } finally {
      spy.mockRestore();
    }

    expect(existsSync(walPfad)).toBe(false);
    expect(existsSync(`${dbFile}-shm`)).toBe(false);

    const dbNachRollback = new Database(dbFile, { readonly: true });
    expect(schemaSchnappschuss(dbNachRollback, deskId).tabellen).not.toContain('desk_roles');
    dbNachRollback.close();
  });

  it('Rollback ist wiederholbar: ein zweiter fehlschlagender Aufruf lehnt erneut mit MigrationFehlgeschlagen ab und hinterlässt denselben Datenstand wie nach dem ersten Rollback', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dd-migrate-safely-'));
    const { dbFile, db, deskId } = baueBestandsDb(dir);

    const spy1 = installiereFehlschlagSpy();
    try {
      await expect(migrateSafely(db, dbFile, dir)).rejects.toBeInstanceOf(MigrationFehlgeschlagen);
    } finally {
      spy1.mockRestore();
    }
    const nachErstemRollback = new Database(dbFile, { readonly: true });
    const standNachErstem = schemaSchnappschuss(nachErstemRollback, deskId);
    nachErstemRollback.close();

    // Zweiter, unabhängiger Anlauf gegen dieselbe (bereits einmal zurückgespielte) Datei —
    // bewusst OHNE Schema-Bootstrap erneut geöffnet, damit die fehlende desk_roles-Tabelle
    // (der eigentliche Bestandszustand) für den zweiten Migrationsversuch erhalten bleibt.
    const dbZweiterVersuch = reopneOhneSchemaBootstrap(dbFile);
    const spy2 = installiereFehlschlagSpy();
    try {
      await expect(migrateSafely(dbZweiterVersuch, dbFile, dir)).rejects.toBeInstanceOf(MigrationFehlgeschlagen);
    } finally {
      spy2.mockRestore();
    }
    const nachZweitemRollback = new Database(dbFile, { readonly: true });
    const standNachZweitem = schemaSchnappschuss(nachZweitemRollback, deskId);
    nachZweitemRollback.close();

    // Der Fehlerpfad ist nicht destruktiv: zweiter Durchlauf hinterlässt denselben Stand wie der
    // erste — keine kumulierten Schäden.
    expect(standNachZweitem).toEqual(standNachErstem);
  });

  it('WR-01-Regression: mehrere erfolgreiche Boot-Läufe hintereinander häufen KEINE Pre-Migration-Backups an — nur der jüngste Stand bleibt liegen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dd-migrate-safely-'));
    const { dbFile, db } = baueBestandsDb(dir);

    // Drei "Neustarts" hintereinander simulieren (z. B. eine Crash-Loop oder mehrere
    // Redeploys) — migrate() ist idempotent, jeder Lauf ist ein No-Op-Erfolg nach dem ersten.
    await migrateSafely(db, dbFile, dir);
    await new Promise((r) => setTimeout(r, 5)); // eindeutige Zeitstempel, wie backup.test.ts
    await migrateSafely(db, dbFile, dir);
    await new Promise((r) => setTimeout(r, 5));
    await migrateSafely(db, dbFile, dir);

    const backupDir = join(dir, BACKUP_DIR);
    const preMigrationDateien = readdirSync(backupDir).filter((f) => f.startsWith(PRE_MIGRATION_PREFIX)).sort();
    // Ohne die WR-01-Aufräumung wären es nach drei erfolgreichen Läufen drei Dateien — ein
    // voller Datenbank-Snapshot PRO Neustart, unbegrenzt anwachsend.
    expect(preMigrationDateien).toHaveLength(1);

    db.close();
  });

  it('das Pre-Migration-Backup bleibt nach dem Rollback erhalten und lässt sich eigenständig mit demselben Vorzustand öffnen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dd-migrate-safely-'));
    const { dbFile, db, deskId } = baueBestandsDb(dir);
    const vorher = schemaSchnappschuss(db, deskId);

    const spy = installiereFehlschlagSpy();
    let migrationsFehler: MigrationFehlgeschlagen | undefined;
    try {
      await migrateSafely(db, dbFile, dir);
      throw new Error('migrateSafely() hätte ablehnen müssen');
    } catch (fehler) {
      if (!(fehler instanceof MigrationFehlgeschlagen)) throw fehler;
      migrationsFehler = fehler;
    } finally {
      spy.mockRestore();
    }

    expect(migrationsFehler).toBeDefined();
    expect(existsSync(migrationsFehler!.backupPfad)).toBe(true);
    const backupDb = new Database(migrationsFehler!.backupPfad, { readonly: true });
    expect(schemaSchnappschuss(backupDb, deskId)).toEqual(vorher);
    backupDb.close();
  });
});
