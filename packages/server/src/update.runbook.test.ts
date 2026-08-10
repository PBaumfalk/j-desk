import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { openDb, openDbRaw, migrate, type Db } from './db';
import { createDesk, applyDeskCommand, getDeskState, listDesks } from './deskStore';
import { rotateBackup } from './backup';
import { migrateSafely } from './migrateSafely';

/**
 * Dieser Test bildet GENAU den Ablauf ab, den `docs/deployment/update-runbook.md` im Abschnitt
 * „Update (Runbook)" beschreibt — Zeile für Zeile abgleichbar über die nummerierten Schritte in
 * den Kommentaren (dieselbe Kopplung wie `restoreRunbook.test.ts` ↔ `backup-strategy.md`). Die
 * Anleitung ist damit kein Papierversprechen: sie läuft bei jedem Suite-Lauf mit (OPS-01).
 *
 * NICHT hier abgedeckt (bewusst, damit niemand denselben Fall ein drittes Mal baut):
 * - Rollback bei einem tatsächlich fehlschlagenden Migrationsschritt → migration.rollback.test.ts
 * - Migration gegen eine echte Bestands-Datenbankkopie (reales Schema-Alter) →
 *   migration.real.test.ts
 * - Der `npm ci`/native-Modul-Rebuild aus Runbook-Schritt 3 (dependency install unter der
 *   Zielversion) — das ist Prozessebene, kein Datenbankverhalten; siehe stattdessen den
 *   `<verify>`-Block von 14-02 Task 1 (`npm rebuild better-sqlite3` unter Node 22).
 */

/** sha256-Prüfsumme über den ausgelieferten Zustand eines Schreibtischs — Grundlage des
 *  Nachweises, dass ein Update das Datenbild nicht verändert (dasselbe Muster wie
 *  restoreRunbook.test.ts, D-05). */
function fingerabdruck(db: Db, deskId: string): string {
  return createHash('sha256').update(JSON.stringify(getDeskState(db, deskId)!.state)).digest('hex');
}

describe('Update-Runbook (OPS-01)', () => {
  it(
    'Update-Ablauf nach docs/deployment/update-runbook.md: Bestand unverändert, Rückweg vorhanden, Schemastand wie eine Neuinstallation',
    async () => {
      // Runbook Schritt 1 — Ausgangsbestand VOR dem Update: ein echtes temporäres
      // Datenverzeichnis (nicht in-memory), weil Sicherungs-/Migrationspfade Dateien anfassen.
      // Drei Schreibtische, je mehrere Zustandsänderungen (rev > 0 je Schreibtisch) — dieselbe
      // Fixture-Form wie restoreRunbook.test.ts.
      const dataDir = mkdtempSync(join(tmpdir(), 'dd-update-runbook-'));
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

      // migrate() ist idempotent (db.test.ts/migration.real.test.ts) — hier explizit vorgezogen,
      // damit der Referenzwert denselben Endzustand sieht, den auch der reguläre Boot-Ablauf
      // unten (Schritt 4) herstellt. Ohne diesen Vorlauf würden Backfills (z. B. updatedRev)
      // erst beim nächsten migrate()-Aufruf greifen und fälschlich als Abweichung erscheinen —
      // dieselbe Lehre wie in restoreRunbook.test.ts.
      migrate(db);
      const deskCountVorher = listDesks(db).length;
      const revsVorher = desks.map((d) => getDeskState(db, d.id)!.rev);
      const hashesVorher = desks.map((d) => fingerabdruck(db, d.id));
      const schemaVersionVorher = db.pragma('user_version', { simple: true }) as number;
      expect(revsVorher.every((rev) => rev > 0)).toBe(true);

      // Runbook Schritt 1 (Fortsetzung) — Server stoppen: kein Prozess darf während des Updates
      // schreiben. Technischer Effekt hier: die Verbindung schließen.
      db.close();

      // Runbook Schritte 2+3 (Neuen Stand einspielen / Abhängigkeiten installieren) laufen auf
      // Prozess-/Dateisystemebene außerhalb dieses Tests — der Code, der im Test ab hier läuft,
      // IST bereits „der neue Stand"; das Datenverzeichnis (`dataDir`) bleibt unverändert
      // bestehen, exakt wie es Runbook-Schritt 2 verspricht.

      // Runbook Schritt 4 — Server starten: derselbe Boot-Ablauf wie main.ts (SAFE-03) —
      // öffnen ohne Migration, Boot-Backup rotieren, danach migrateSafely() mit eigenem
      // Pre-Migration-Backup vor dem eigentlichen Migrationslauf.
      const geoeffnet = openDbRaw(dbFile);
      await rotateBackup(geoeffnet, dataDir);
      const { db: nachDemUpdate } = await migrateSafely(geoeffnet, dbFile, dataDir);

      // Runbook Schritt 5 (Startmeldung prüfen) ist auf Prozessebene (main.ts protokolliert die
      // Startzeile) — der äquivalente Nachweis auf Datenebene ist, dass die Verbindung nach
      // migrateSafely() geöffnet und benutzbar geblieben ist (kein Absturz, kein Rückbau nötig).
      expect(listDesks(nachDemUpdate).length).toBe(deskCountVorher);

      // Runbook Schritt 6 — In der Systemdiagnose gegenprüfen: App-/Schemaversion entsprechen dem
      // erwarteten Stand. Zusicherung „ein Update verliert nichts": Fingerabdruck jedes
      // Schreibtischs ist vor und nach dem Update-Durchlauf identisch.
      const revsNachher = desks.map((d) => getDeskState(nachDemUpdate, d.id)!.rev);
      const hashesNachher = desks.map((d) => fingerabdruck(nachDemUpdate, d.id));
      expect(revsNachher).toEqual(revsVorher);
      expect(hashesNachher).toEqual(hashesVorher);

      // Schemastand entspricht dem einer Neuinstallation: eine frisch angelegte Datenbank
      // durchläuft in migrate() dieselben user_version-Schritte (0 -> 1 -> 2 -> 3) wie eine
      // Bestands-DB — der Update-Pfad führt also zu demselben Schema wie eine Neuanlage.
      const frischeDbPfad = join(dataDir, 'frisch.sqlite');
      const frisch = openDb(frischeDbPfad);
      const schemaVersionNeuinstallation = frisch.pragma('user_version', { simple: true }) as number;
      const schemaVersionNachher = nachDemUpdate.pragma('user_version', { simple: true }) as number;
      expect(schemaVersionNachher).toBe(schemaVersionNeuinstallation);
      expect(schemaVersionNachher).toBeGreaterThanOrEqual(schemaVersionVorher);
      frisch.close();

      // Der Rückweg aus dem Runbook existiert real: migrateSafely() zieht vor JEDEM
      // Migrationslauf ein Pre-Migration-Backup — unabhängig davon, ob am Ende überhaupt etwas
      // zu migrieren war (docs/deployment/update-runbook.md Abschnitt 3).
      const backupDir = join(dataDir, 'backup');
      const vorMigrationsBackups = readdirSync(backupDir).filter((f) => f.startsWith('pre-migration-') && f.endsWith('.sqlite'));
      expect(vorMigrationsBackups.length).toBeGreaterThan(0);
      expect(existsSync(join(backupDir, vorMigrationsBackups[0]))).toBe(true);

      nachDemUpdate.close();
    },
    30_000,
  );
});
