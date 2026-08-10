import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { openDb, migrate, type Db } from './db';
import { createDesk, applyDeskCommand, getDeskState, listDesks } from './deskStore';
import { rotateBackup, restoreDbFile, newestBackupFile } from './backup';
import { migrateSafely } from './migrateSafely';

/**
 * Dieser Test bildet GENAU den Ablauf ab, den `docs/deployment/backup-strategy.md` im Abschnitt
 * „Wiederherstellung (Runbook)" beschreibt — Zeile für Zeile abgleichbar über die nummerierten
 * Schritte in den Kommentaren. Die Anleitung ist damit kein Papierversprechen: sie läuft bei
 * jedem Suite-Lauf mit (SAFE-03, D-24).
 */

/** sha256-Prüfsumme über den ausgelieferten Zustand eines Schreibtischs — Grundlage des
 *  Nachweises, dass die Wiederherstellung bit-identisch mit dem Vorzustand ist (D-05). */
function fingerabdruck(db: Db, deskId: string): string {
  return createHash('sha256').update(JSON.stringify(getDeskState(db, deskId)!.state)).digest('hex');
}

describe('Restore-Runbook (SAFE-03)', () => {
  it('Totalverlust: desktop.sqlite und Seitendateien entfernt, Wiederherstellung ausschließlich über die dokumentierten Schritte, identischer Bestand danach', async () => {
    // Schritt 1 — Ausgangsbestand: drei Schreibtische, je mindestens zwei Zustandsänderungen
    // (rev > 0 je Schreibtisch).
    const dataDir = mkdtempSync(join(tmpdir(), 'dd-runbook-'));
    const dbFile = join(dataDir, 'desktop.sqlite');
    const db = openDb(dbFile);
    db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)').run(
      'u1', 'anna', 'hash', Date.now(),
    );
    const desks = [
      createDesk(db, 'u1', 'Schreibtisch A'),
      createDesk(db, 'u1', 'Schreibtisch B'),
      createDesk(db, 'u1', 'Schreibtisch C'),
    ];
    for (const desk of desks) {
      applyDeskCommand(db, desk.id, { type: 'addNote', payload: { kind: 'notiz', text: `Notiz 1 auf ${desk.name}`, position: { x: 10, y: 20 } } });
      applyDeskCommand(db, desk.id, { type: 'addNote', payload: { kind: 'notiz', text: `Notiz 2 auf ${desk.name}`, position: { x: 30, y: 40 } } });
    }

    // Schritt 2 — Referenzwerte erfassen: Schreibtischanzahl, rev je Schreibtisch, Zustands-Hash.
    // migrate() ist idempotent (db.test.ts/migration.real.test.ts) — hier explizit vorgezogen,
    // damit der Vergleich denselben Endzustand sieht, den auch openDb() nach dem Zurückspielen
    // herstellt (openDb() ruft migrate() erneut auf; Backfills wie layerId griffen sonst erst
    // beim zweiten Aufruf und würden fälschlich als Abweichung erscheinen — dieselbe Lehre wie
    // in backup.test.ts, Restore-Integrität D-05).
    migrate(db);
    const deskCountVorher = listDesks(db).length;
    const revsVorher = desks.map((d) => getDeskState(db, d.id)!.rev);
    const hashesVorher = desks.map((d) => fingerabdruck(db, d.id));
    expect(revsVorher.every((rev) => rev > 0)).toBe(true);

    // Schritt 3 — Sicherung.
    const backupPfad = await rotateBackup(db, dataDir);
    expect(existsSync(backupPfad)).toBe(true);

    // Schritt 4 — Totalverlust nachbilden: Verbindung schließen, Hauptdatei und beide
    // Seitendateien entfernen, deren Nichtexistenz belegen (kein versehentliches Bedienen aus
    // einer Restdatei).
    db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      const pfad = `${dbFile}${suffix}`;
      if (existsSync(pfad)) rmSync(pfad);
    }
    expect(existsSync(dbFile)).toBe(false);
    expect(existsSync(`${dbFile}-wal`)).toBe(false);
    expect(existsSync(`${dbFile}-shm`)).toBe(false);

    // Schritt 5 — Wiederherstellung nach Anleitung: Backup-Datei über die Datenbankdatei legen,
    // Server starten (Migrationslauf läuft regulär mit, hier über openDb()).
    restoreDbFile(dataDir, backupPfad);
    const wiederhergestellt = openDb(dbFile);

    // Schritt 6 — Nachweis: Schreibtischanzahl, alle rev-Werte und alle Prüfsummen stimmen exakt
    // mit den Referenzwerten aus Schritt 2 überein.
    expect(listDesks(wiederhergestellt).length).toBe(deskCountVorher);
    const revsNachher = desks.map((d) => getDeskState(wiederhergestellt, d.id)!.rev);
    const hashesNachher = desks.map((d) => fingerabdruck(wiederhergestellt, d.id));
    expect(revsNachher).toEqual(revsVorher);
    expect(hashesNachher).toEqual(hashesVorher);

    wiederhergestellt.close();
  });

  it('Wiederherstellung aus dem Pre-Migration-Stand: die jüngste Sicherung im Backup-Verzeichnis gewinnt über newestBackupFile(), unabhängig vom Namenspräfix', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dd-runbook-'));
    const dbFile = join(dataDir, 'desktop.sqlite');
    const db = openDb(dbFile);
    db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)').run(
      'u1', 'anna', 'hash', Date.now(),
    );
    const desk = createDesk(db, 'u1', 'Schreibtisch');
    applyDeskCommand(db, desk.id, { type: 'addNote', payload: { kind: 'notiz', text: 'Notiz', position: { x: 1, y: 2 } } });
    migrate(db); // s. Kommentar im ersten Fall — idempotenter Endzustand vor dem Referenzwert.
    const revVorher = getDeskState(db, desk.id)!.rev;
    const hashVorher = fingerabdruck(db, desk.id);

    // Erst ein regulärer Rotationsstand (Präfix 'desktop-') ...
    await rotateBackup(db, dataDir);
    await new Promise((r) => setTimeout(r, 5)); // eindeutige Zeitstempel, wie backup.test.ts
    // ... dann ein Pre-Migration-Backup aus einem echten migrateSafely()-Lauf (Präfix
    // 'pre-migration-', Plan 05-04). Die Migration ist bereits vollständig durchgelaufen
    // (openDb() hat migrate() bereits ausgeführt) — migrateSafely() nimmt hier den No-Op-
    // Erfolgspfad: nichts wird zurückgespielt, aber das Backup entsteht wie beim regulären
    // Boot-Ablauf VOR dem (hier folgenlosen) Migrationsversuch.
    await migrateSafely(db, dbFile, dataDir);

    const backupDir = join(dataDir, 'backup');
    // Die im Runbook (Abschnitt 5, Schritt 2) beschriebene Auswahlregel „jüngster
    // eingebetteter Zeitstempel gewinnt, unabhängig vom Namenspräfix" wird über
    // newestBackupFile() umgesetzt (CR-01) — NICHT über eine naive alphabetische Sortierung
    // der vollständigen Dateinamen (die scheitert, sobald ein 'desktop-…'-Stand nach einem
    // 'pre-migration-…'-Stand entsteht, s. nächster Testfall).
    const juengsteSicherung = newestBackupFile(backupDir);
    expect(juengsteSicherung).not.toBeNull();
    expect(juengsteSicherung!.startsWith('pre-migration-')).toBe(true);

    // Totalverlust nachbilden.
    db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      const pfad = `${dbFile}${suffix}`;
      if (existsSync(pfad)) rmSync(pfad);
    }

    // Wiederherstellung über genau die im Runbook beschriebenen Schritte, ausgehend von der
    // per newestBackupFile() ermittelten jüngsten Sicherung.
    restoreDbFile(dataDir, join(backupDir, juengsteSicherung!));
    const wiederhergestellt = openDb(dbFile);
    expect(getDeskState(wiederhergestellt, desk.id)!.rev).toBe(revVorher);
    expect(fingerabdruck(wiederhergestellt, desk.id)).toBe(hashVorher);
    wiederhergestellt.close();
  });

  it('CR-01-Regression: ein regulärer Stand, der NACH einem Pre-Migration-Backup entsteht, gewinnt trotz ungünstiger alphabetischer Präfix-Reihenfolge', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dd-runbook-'));
    const dbFile = join(dataDir, 'desktop.sqlite');
    const db = openDb(dbFile);
    db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)').run(
      'u1', 'anna', 'hash', Date.now(),
    );
    const desk = createDesk(db, 'u1', 'Schreibtisch');
    applyDeskCommand(db, desk.id, { type: 'addNote', payload: { kind: 'notiz', text: 'Notiz vor Migration', position: { x: 1, y: 2 } } });
    migrate(db);

    // Erst ein Pre-Migration-Backup (Präfix 'pre-migration-') ...
    await migrateSafely(db, dbFile, dataDir);
    await new Promise((r) => setTimeout(r, 5)); // eindeutige Zeitstempel, wie backup.test.ts

    // ... dann Zustandsänderungen NACH der Migration und ein strikt späterer regulärer
    // Rotationsstand (Präfix 'desktop-'). Genau dieser Fall wurde von der alten
    // restoreRunbook.test.ts-Suite nicht abgedeckt (s. REVIEW.md CR-01).
    applyDeskCommand(db, desk.id, { type: 'addNote', payload: { kind: 'notiz', text: 'Notiz nach Migration', position: { x: 3, y: 4 } } });
    // migrate() erneut aufrufen, bevor der Referenzwert erfasst wird — s. Kommentar im ersten
    // Testfall dieser Datei: Backfills wie layerId greifen bei einem frisch angelegten Objekt
    // erst beim NÄCHSTEN migrate()-Aufruf, den openDb() beim Zurückspielen ohnehin ausführt.
    // Ohne diesen Aufruf würde der Referenzwert (vor dem Backfill) vom wiederhergestellten
    // Zustand (nach dem Backfill) abweichen — ein Testartefakt, kein echter Datenverlust.
    migrate(db);
    const revVorher = getDeskState(db, desk.id)!.rev;
    const hashVorher = fingerabdruck(db, desk.id);
    await rotateBackup(db, dataDir);

    const backupDir = join(dataDir, 'backup');
    const alleBackups = readdirSync(backupDir).filter((f) => f.endsWith('.sqlite'));
    expect(alleBackups.some((f) => f.startsWith('pre-migration-'))).toBe(true);
    expect(alleBackups.some((f) => f.startsWith('desktop-'))).toBe(true);

    // Eine naive alphabetische Sortierung des vollständigen Dateinamens würde hier fälschlich
    // den ÄLTEREN 'pre-migration-…'-Stand als "letzten Eintrag" liefern, weil 'desktop-' immer
    // lexikographisch vor 'pre-migration-' sortiert — unabhängig vom eingebetteten
    // Zeitstempel. Das belegt genau die im Runbook (Abschnitt 5, Schritt 2) jetzt korrigierte
    // Warnung.
    const naivAlphabetisch = [...alleBackups].sort().at(-1)!;
    expect(naivAlphabetisch.startsWith('pre-migration-')).toBe(true);

    // newestBackupFile() vergleicht stattdessen den eingebetteten Zeitstempel und liefert
    // korrekt den strikt später entstandenen 'desktop-…'-Stand.
    const juengsteSicherung = newestBackupFile(backupDir);
    expect(juengsteSicherung).not.toBeNull();
    expect(juengsteSicherung!.startsWith('desktop-')).toBe(true);

    // Wiederherstellung anhand der korrekt ermittelten (jüngeren) Sicherung liefert den
    // Zustand NACH der zweiten Notiz — nicht den älteren Pre-Migration-Stand.
    db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      const pfad = `${dbFile}${suffix}`;
      if (existsSync(pfad)) rmSync(pfad);
    }
    restoreDbFile(dataDir, join(backupDir, juengsteSicherung!));
    const wiederhergestellt = openDb(dbFile);
    expect(getDeskState(wiederhergestellt, desk.id)!.rev).toBe(revVorher);
    expect(fingerabdruck(wiederhergestellt, desk.id)).toBe(hashVorher);
    wiederhergestellt.close();
  });
});
