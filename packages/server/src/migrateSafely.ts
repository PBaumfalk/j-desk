import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from './db';
import { migrate } from './db';
import { BACKUP_DIR, backupTo, restoreDbFile } from './backup';

/** Namenspräfix für das Pre-Migration-Backup (D-21) — eigenständig von der `keep = 5`-Rotation
 *  der regulären Backups in backup.ts: rotateBackup() legt Dateien nach dem Muster
 *  `desktop-<stamp>.sqlite` an und rührt Dateien mit diesem Präfix nicht an. Das
 *  Pre-Migration-Backup ist der letzte bekanntgute Stand vor einem Update und darf nicht von
 *  turnusmäßigen Backups verdrängt werden (T-05-18). */
export const PRE_MIGRATION_PREFIX = 'pre-migration-';

/** Wird geworfen, wenn ein Migrationsschritt fehlschlägt — NACHDEM der Vorzustand bereits
 *  zurückgespielt wurde. `ursache` trägt den ursprünglichen Fehler aus migrate(), `backupPfad`
 *  den Pfad des benutzten Pre-Migration-Backups (bleibt auf der Platte erhalten). */
export class MigrationFehlgeschlagen extends Error {
  constructor(
    public readonly ursache: unknown,
    public readonly backupPfad: string,
  ) {
    super('Migration fehlgeschlagen — Vorzustand wurde wiederhergestellt');
    this.name = 'MigrationFehlgeschlagen';
  }
}

/** WR-01: das Pre-Migration-Backup entsteht auf JEDEM Boot (nicht nur bei tatsächlichem
 *  Schema-Update, s. Kommentar an der Aufrufstelle unten) und unterliegt bewusst NICHT der
 *  turnusmäßigen `keep=5`-Rotation der regulären Backups (T-05-18/D-21) — ohne eigene Grenze
 *  würde aber eine Crash-Loop- oder Redeploy-Serie einen vollen Datenbank-Snapshot PRO Neustart
 *  anhäufen und irgendwann die Platte füllen. Sobald ein Migrationslauf erfolgreich durchläuft
 *  (der Normalfall — nur der Fehlerpfad braucht den soeben gezogenen Stand für den Rollback),
 *  ist der GERADE gezogene Pre-Migration-Stand der einzige, der als Rückfallstand noch gebraucht
 *  wird: er erfasst den Zustand unmittelbar vor DIESEM (erfolgreichen) Lauf, jeder ältere ist
 *  strikt überholt. Entfernt deshalb nach einem Migrationserfolg alle ÄLTEREN
 *  Pre-Migration-Backups und behält ausschliesslich den soeben erzeugten. Ein Fehlschlag in
 *  dieser Aufräumfunktion selbst darf den (bereits erfolgreichen) Boot nicht mitreissen — sie
 *  wird deshalb bewusst nicht innerhalb des try/catch der Migration selbst aufgerufen. */
function raeumeAeltereVorMigrationsBackupsAuf(dataDir: string, aktuellerPfad: string): void {
  const backupDir = join(dataDir, BACKUP_DIR);
  let dateien: string[];
  try {
    dateien = readdirSync(backupDir).filter((f) => f.startsWith(PRE_MIGRATION_PREFIX) && f.endsWith('.sqlite'));
  } catch {
    return; // Verzeichnis (noch) nicht lesbar — kein Grund, den Boot zu gefährden.
  }
  for (const datei of dateien) {
    const vollerPfad = join(backupDir, datei);
    if (vollerPfad === aktuellerPfad) continue;
    try {
      rmSync(vollerPfad);
    } catch (fehler) {
      // Aufräumen ist ein Aufräumen, kein Sicherheitsmechanismus — ein einzelner nicht
      // entfernbarer Altstand darf weder den Boot noch die übrigen Aufräumversuche stoppen.
      console.error('Altes Pre-Migration-Backup konnte nicht entfernt werden:', vollerPfad, fehler);
    }
  }
}

/** Zieht vor jedem Migrationslauf ein Pre-Migration-Backup aus der bereits geöffneten
 *  Verbindung (SAFE-04, D-06) und ruft danach migrate() unverändert auf. Bei Erfolg wird nichts
 *  zurückgespielt — das Pre-Migration-Backup bleibt als Rückfallstand liegen, ältere
 *  Pre-Migration-Backups werden entfernt (WR-01, s. raeumeAeltereVorMigrationsBackupsAuf()).
 *  Schlägt migrate() fehl, wird die Verbindung geschlossen, der Vorzustand über restoreDbFile()
 *  zurückgespielt (das entfernt zugleich die verwaisten WAL-/SHM-Seitendateien der defekten
 *  Fassung), die Ursache protokolliert und mit MigrationFehlgeschlagen laut weitergereicht — es
 *  wird ausdrücklich KEINE neue Verbindung geöffnet, der Start darf mit einem halb migrierten
 *  Schema NIEMALS weiterlaufen (T-05-15, ASVS V1 „fail-safe defaults"). `dbPfad` ist Teil der
 *  Signatur, damit der Aufrufer (main.ts) den Datenbankpfad explizit benennt; migrate() und
 *  restoreDbFile() arbeiten unverändert über die geöffnete Verbindung bzw. `dataDir`. */
export async function migrateSafely(db: Db, dbPfad: string, dataDir: string): Promise<{ db: Db }> {
  void dbPfad;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const zielPfad = join(dataDir, BACKUP_DIR, `${PRE_MIGRATION_PREFIX}${stamp}.sqlite`);
  await backupTo(db, zielPfad);

  try {
    migrate(db);
    raeumeAeltereVorMigrationsBackupsAuf(dataDir, zielPfad);
    return { db };
  } catch (fehler) {
    console.error('Migration fehlgeschlagen — Vorzustand wird wiederhergestellt:', fehler);
    db.close();
    restoreDbFile(dataDir, zielPfad);
    console.error('Vorzustand wiederhergestellt aus:', zielPfad);
    throw new MigrationFehlgeschlagen(fehler, zielPfad);
  }
}
