/**
 * IN-01: kleines CLI-Werkzeug für Schritt 2 des Wiederherstellungs-Runbooks
 * (docs/deployment/backup-strategy.md §5) — ermittelt deterministisch die jüngste Sicherung in
 * einem Backup-Verzeichnis, über beide Namenspräfixe hinweg (reguläre `desktop-…`- UND
 * `pre-migration-…`-Stände, s. `newestBackupFile()` in `../backup.ts`). Ohne dieses Werkzeug
 * müsste ein Betriebsverantwortlicher während eines laufenden Vorfalls eingebettete Zeitstempel
 * von Hand vergleichen — genau der Fehleranfällige Schritt, den `newestBackupFile()` eigentlich
 * überflüssig macht.
 *
 * Aufruf (aus dem Repo-Wurzelverzeichnis, Node 20 wegen better-sqlite3s nativer Bindung —
 * dieses Skript selbst braucht better-sqlite3 nicht, aber `tsx` lädt die gesamte
 * `@j-desk/server`-Workspace-Auflösung, s. docs/deployment/backup-strategy.md §5):
 *
 *   fnm exec --using=20 npx tsx packages/server/src/scripts/newestBackup.ts <DATA_DIR>/backup
 */
import { newestBackupFile } from '../backup';

const backupDir = process.argv[2];
if (!backupDir) {
  console.error('Nutzung: npx tsx packages/server/src/scripts/newestBackup.ts <backup-verzeichnis>');
  process.exit(1);
}

const datei = newestBackupFile(backupDir);
if (datei === null) {
  console.error(`Keine Sicherung gefunden in: ${backupDir}`);
  process.exit(1);
}
console.log(datei);
