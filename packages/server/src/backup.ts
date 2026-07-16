import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** Sichert die SQLite-Datei nach backup/ und behält die letzten `keep` Stände. */
export function rotateBackup(dataDir: string, keep = 5): void {
  const dbFile = join(dataDir, 'desktop.sqlite');
  if (!existsSync(dbFile)) return;
  const backupDir = join(dataDir, 'backup');
  mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  copyFileSync(dbFile, join(backupDir, `desktop-${stamp}.sqlite`));
  const backups = readdirSync(backupDir).filter((f) => f.endsWith('.sqlite')).sort();
  for (const old of backups.slice(0, Math.max(0, backups.length - keep))) {
    rmSync(join(backupDir, old));
  }
}
