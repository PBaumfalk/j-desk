import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from './db';
import { rotateBackup } from './backup';
import { buildApp } from './app';

const port = Number(process.env.PORT ?? 4810);
const dataDir = process.env.DATA_DIR ?? join(process.cwd(), 'data');

mkdirSync(dataDir, { recursive: true });
rotateBackup(dataDir); // vor dem Öffnen der DB — kein WAL-Zwischenstand im Backup
const db = openDb(join(dataDir, 'desktop.sqlite'));

const app = await buildApp({ db, dataDir });
await app.listen({ port, host: '0.0.0.0' });
console.log(`Digital-Desktop-Server läuft auf Port ${port} (Daten: ${dataDir})`);
