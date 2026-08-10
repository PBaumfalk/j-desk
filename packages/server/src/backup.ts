import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from './db';

export const BACKUP_DIR = 'backup';

/** Namenspräfix der regulären (turnusmäßigen) Backups aus rotateBackup() — bewusst getrennt
 *  vom Präfix der Pre-Migration-Backups (`PRE_MIGRATION_PREFIX` in migrateSafely.ts), damit die
 *  `keep`-Rotation unten ausschliesslich reguläre Backups zählt/löscht und die dauerhaften
 *  Pre-Migration-Stände unangetastet lässt (T-05-18, CR-01). */
export const REGULAR_BACKUP_PREFIX = 'desktop-';

/** Zieht ein konsistentes Backup über die Online-Backup-Schnittstelle der geöffneten
 *  Verbindung — anders als ein roher Dateikopiervorgang erfasst dies auch Transaktionen,
 *  die im WAL-Modus noch nur im Seitenspeicher stehen (SAFE-03, 05-RESEARCH Pitfall 2). */
export async function backupTo(db: Db, zielPfad: string): Promise<void> {
  mkdirSync(join(zielPfad, '..'), { recursive: true });
  await db.backup(zielPfad);
}

/** Sichert die geöffnete Datenbankverbindung nach backup/ und behält die letzten `keep`
 *  Stände. Liefert den Pfad des neu erzeugten Backups (leer, wenn keine Quelldatei existiert
 *  — Plan 05-04 nutzt den Rückgabewert für den Rollback). */
export async function rotateBackup(db: Db, dataDir: string, keep = 5): Promise<string> {
  const dbFile = join(dataDir, 'desktop.sqlite');
  if (!existsSync(dbFile)) return '';
  const backupDir = join(dataDir, BACKUP_DIR);
  mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const zielPfad = join(backupDir, `${REGULAR_BACKUP_PREFIX}${stamp}.sqlite`);
  await backupTo(db, zielPfad);
  // Nur reguläre Backups zählen für die keep-Rotation — Pre-Migration-Backups (anderes
  // Präfix) bleiben dauerhaft liegen, wie von migrateSafely.ts und der Runbook-Doku
  // versprochen (CR-01).
  const backups = readdirSync(backupDir)
    .filter((f) => f.startsWith(REGULAR_BACKUP_PREFIX) && f.endsWith('.sqlite'))
    .sort();
  for (const old of backups.slice(0, Math.max(0, backups.length - keep))) {
    rmSync(join(backupDir, old));
  }
  return zielPfad;
}

/** Erkennt den eingebetteten ISO-Zeitstempel eines Backup-Dateinamens (beide Präfixe:
 *  `desktop-` und `pre-migration-`), z. B. `desktop-2026-07-26T13-10-51-123Z.sqlite` ->
 *  `2026-07-26T13-10-51-123Z`. Liefert einen leeren String für Dateien ohne erkennbaren
 *  Zeitstempel (sortieren dann als älteste ein). */
const ZEITSTEMPEL_MUSTER = /(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.sqlite$/;

/** Ermittelt aus einem Backup-Verzeichnis die Datei mit dem jüngsten eingebetteten
 *  Zeitstempel — über beide Namenspräfixe (reguläre und Pre-Migration-Backups) hinweg. Eine
 *  reine alphabetische Sortierung der vollständigen Dateinamen ist dafür NICHT ausreichend:
 *  `'desktop-'` sortiert lexikographisch immer vor `'pre-migration-'`, unabhängig vom
 *  eingebetteten Zeitstempel — genau die Falle aus CR-01. Diese Funktion vergleicht stattdessen
 *  nur den eingebetteten Zeitstempel und ist die einzige Quelle der Wahrheit für „jüngste
 *  Sicherung", die sowohl das Runbook (Abschnitt 5) als auch künftige Tooling-Skripte nutzen
 *  sollten, statt den Verzeichnisinhalt naiv alphabetisch zu sortieren. Liefert `null` bei einem
 *  leeren (oder nicht existierenden) Verzeichnis. */
export function newestBackupFile(backupDir: string): string | null {
  if (!existsSync(backupDir)) return null;
  const dateien = readdirSync(backupDir).filter((f) => f.endsWith('.sqlite'));
  if (dateien.length === 0) return null;
  return dateien
    .map((datei) => ({ datei, zeitstempel: datei.match(ZEITSTEMPEL_MUSTER)?.[1] ?? '' }))
    .sort((a, b) => a.zeitstempel.localeCompare(b.zeitstempel))
    .at(-1)!.datei;
}

/** Spielt ein Backup als aktuelle desktop.sqlite zurück. Entfernt zuerst die WAL-/SHM-
 *  Seitendateien der bisherigen Fassung — ein zurückbleibender Seitenspeicher der defekten
 *  Fassung würde beim nächsten Öffnen in die frisch zurückgespielte Datei eingerechnet. */
export function restoreDbFile(dataDir: string, backupPfad: string): void {
  const dbFile = join(dataDir, 'desktop.sqlite');
  for (const suffix of ['', '-wal', '-shm']) {
    const pfad = `${dbFile}${suffix}`;
    if (existsSync(pfad)) rmSync(pfad);
  }
  copyFileSync(backupPfad, dbFile);
}

/** Startet den periodischen Rotationstakt (D-14, zusätzlich zum Boot-Lauf). `stunden <= 0`
 *  (oder ein nicht endlicher Wert) schaltet den Takt ab und startet nichts. Ein Fehlschlag im
 *  Rotationslauf wird protokolliert und nie weitergereicht — ein fehlgeschlagenes Backup darf
 *  den laufenden Betrieb nicht mitreißen (T-05-12). `.unref()` hält den Prozess (und die
 *  Testsuite) nicht am Leben. */
export function starteBackupIntervall(db: Db, dataDir: string, stunden: number): NodeJS.Timeout | null {
  if (!Number.isFinite(stunden) || stunden <= 0) return null;
  const timer = setInterval(() => {
    void rotateBackup(db, dataDir).catch((fehler: unknown) => {
      console.error('Periodisches Backup fehlgeschlagen:', fehler);
    });
  }, stunden * 60 * 60 * 1000);
  timer.unref();
  return timer;
}
