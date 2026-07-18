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
// Gesetzt = Anmeldung mit j-lawyer-Konto (Basis-URL inkl. /j-lawyer-io, z. B. http://host:8080/j-lawyer-io)
const jlawyerUrl = process.env.JLAWYER_URL?.replace(/\/+$/, '');
// Euro-Office-DocumentServer für die Vorschau-Konvertierung — beide Variablen gesetzt = aktiv.
const euroOfficeUrl = process.env.EUROOFFICE_URL;
const euroOfficeJwtSecret = process.env.EUROOFFICE_JWT_SECRET;
const convert = euroOfficeUrl && euroOfficeJwtSecret ? { url: euroOfficeUrl, jwtSecret: euroOfficeJwtSecret } : null;
// Basis-URL, unter der DIESER Server für den DocumentServer erreichbar ist (im Docker-Netz
// z. B. der Containername statt localhost — deshalb per Env überschreibbar).
const publicUrl = process.env.PUBLIC_URL ?? `http://localhost:${port}`;

mkdirSync(dataDir, { recursive: true });
rotateBackup(dataDir); // vor dem Öffnen der DB — kein WAL-Zwischenstand im Backup
const db = openDb(join(dataDir, 'desktop.sqlite'));

const app = await buildApp({
  db, dataDir, convert, publicUrl,
  ...(existsSync(webDir) ? { webDir } : {}),
  ...(jlawyerUrl ? { jlawyerUrl } : {}),
});
await app.listen({ port, host: '0.0.0.0' });
console.log(
  `Digital-Desktop-Server läuft auf Port ${port} (Daten: ${dataDir}${existsSync(webDir) ? `, Web-App: ${webDir}` : ', ohne Web-App'}${jlawyerUrl ? `, j-lawyer: ${jlawyerUrl}` : ''}${convert ? `, Vorschau-Konverter: ${convert.url}` : ', ohne Vorschau-Konverter'})`,
);
