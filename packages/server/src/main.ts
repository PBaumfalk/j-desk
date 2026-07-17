import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db';
import { rotateBackup } from './backup';
import { buildApp } from './app';

const port = Number(process.env.PORT ?? 4810);
const dataDir = process.env.DATA_DIR ?? join(process.cwd(), 'data');
const webDir =
  process.env.WEB_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'build');

mkdirSync(dataDir, { recursive: true });
rotateBackup(dataDir); // vor dem Öffnen der DB — kein WAL-Zwischenstand im Backup
const db = openDb(join(dataDir, 'desktop.sqlite'));

const app = await buildApp({ db, dataDir, ...(existsSync(webDir) ? { webDir } : {}) });
await app.listen({ port, host: '0.0.0.0' });
console.log(
  `Digital-Desktop-Server läuft auf Port ${port} (Daten: ${dataDir}${existsSync(webDir) ? `, Web-App: ${webDir}` : ', ohne Web-App'})`,
);
