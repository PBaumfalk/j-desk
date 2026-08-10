import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSetting, openDbRaw } from './db';
import { rotateBackup, starteBackupIntervall } from './backup';
import { migrateSafely } from './migrateSafely';
import { buildApp } from './app';
import { parseHours } from './envConfig';

const port = Number(process.env.PORT ?? 4810);
const dataDir = process.env.DATA_DIR ?? join(process.cwd(), 'data');
const webDir =
  process.env.WEB_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'build');
// Euro-Office-DocumentServer für die Vorschau-Konvertierung — beide Variablen gesetzt = aktiv.
const euroOfficeUrl = process.env.EUROOFFICE_URL;
const euroOfficeJwtSecret = process.env.EUROOFFICE_JWT_SECRET;
const convert = euroOfficeUrl && euroOfficeJwtSecret ? { url: euroOfficeUrl, jwtSecret: euroOfficeJwtSecret } : null;
// Basis-URL, unter der DIESER Server für den DocumentServer erreichbar ist (im Docker-Netz
// z. B. der Containername statt localhost — deshalb per Env überschreibbar).
const publicUrl = process.env.PUBLIC_URL ?? `http://localhost:${port}`;
// VOICE-01 (14-09): Anymize-Transkription — NUR hier aus der Umgebung gelesen (Disziplin wie
// diagnosepaket.ts) und als Wert an buildApp() weitergereicht. Fehlt der Schlüssel, ist das
// KEIN Startfehler (anders als der MCP-Prozess, packages/mcp/src/config.ts wirft dort hart) —
// eine Instanz ohne Transkription muss weiterlaufen, die Route meldet sich nur als nicht
// verfügbar (transkription.ts: GET /api/v1/transkription → { verfuegbar: false }).
const anymizeApiKey = process.env.ANYMIZE_API_KEY;
const anymizeApiUrl = (process.env.ANYMIZE_API_URL ?? 'https://app.anymize.ai').replace(/\/+$/, '');
const transkriptionConfig = anymizeApiKey ? { apiUrl: anymizeApiUrl, apiKey: anymizeApiKey } : null;

mkdirSync(dataDir, { recursive: true });
// Boot-Reihenfolge (SAFE-03): erst öffnen (ohne Migration), dann sichern — das Backup entsteht
// über die Online-Backup-Schnittstelle der geöffneten Verbindung aus dem konsistenten
// Vorzustand — erst danach migriert.
const db = openDbRaw(join(dataDir, 'desktop.sqlite'));
// WR-04: dieselbe Toleranz wie der periodische Takt (starteBackupIntervall(), T-05-12) — ein
// Fehlschlag DIESES einzelnen Rotationslaufs (z. B. kurzzeitiger Plattendruck) ist für sich kein
// Datenverlust (die Stände der letzten Rotation liegen weiterhin auf der Platte) und darf den
// gesamten Serverstart nicht mitreissen, obwohl das Schema vielleicht gar keine Migration
// braucht und sonst unverändert hochgefahren wäre. Bewusst NICHT betroffen: das
// SICHERHEITSKRITISCHE Pre-Migration-Backup gleich unten in migrateSafely() bleibt fail-fast
// (SAFE-04/T-05-15) — ohne einen frischen Rückfallstand darf migrate() gar nicht erst versucht
// werden, das ist eine andere Garantie als die turnusmäßige Rotation hier.
try {
  await rotateBackup(db, dataDir);
} catch (fehler) {
  console.error('Boot-Backup (rotateBackup) fehlgeschlagen — Start läuft ohne frisches Backup weiter:', fehler);
}
// SAFE-04: ein fehlschlagender Migrationsschritt spielt den Vorzustand zurück und bricht den
// Start laut ab (Exit-Code ungleich 0), statt mit halb migriertem Schema weiterzulaufen.
await migrateSafely(db, join(dataDir, 'desktop.sqlite'), dataDir);

// D-14: zusätzlich zum Boot-Lauf rotiert der Server in einem konfigurierbaren Takt — kein
// externer Cron, kein neuer Dienst, derselbe rotateBackup() unterliegt weiterhin der
// keep=5-Aufräumlogik. 0 schaltet den Takt ab.
// WR-02: ein Tippfehler (z. B. "6h" statt "6") wird laut protokolliert und fällt auf den
// dokumentierten Standardwert zurück, statt still als NaN in starteBackupIntervall() zu landen.
const backupStunden = parseHours('BACKUP_INTERVAL_HOURS', process.env.BACKUP_INTERVAL_HOURS, 6);
starteBackupIntervall(db, dataDir, backupStunden);

// Effektive j-lawyer-URL: Env hat Vorrang (Docker-Deployments), sonst das im
// Setup-Dialog gespeicherte Setting; nichts gesetzt = Standalone.
// || statt ??: eine GESETZTE, aber leere Env-Variable soll das Setting nicht maskieren.
function effektiveJlUrl(): string | undefined {
  return process.env.JLAWYER_URL?.replace(/\/+$/, '') || getSetting(db, 'jlawyer_url') || undefined;
}

// TASK-02 (08-08): Kalender-Kennung für Aufgaben-Wiedervorlagen — dieselbe Fallback-Kette wie
// effektiveJlUrl oben (Env hat Vorrang, sonst Datenbank-Einstellung, sonst unkonfiguriert). Ohne
// diese Kennung antwortet die Übergaberoute mit einem Klartexthinweis statt j-lawyer aufzurufen
// (docs/deployment/jlawyer-aufgabenuebergabe.md).
function effektiveJlTaskCalendarId(): string | undefined {
  return process.env.JLAWYER_TASK_CALENDAR_ID || getSetting(db, 'jlawyer_task_calendar_id') || undefined;
}

// Doppelte Setup-POSTs (Race über den Probe-Await) dürfen nur EINEN Rebuild auslösen —
// der zweite would-be-Rebuild liefe sonst in EADDRINUSE und risse den Prozess (Review-Fund).
// Bewusst NICHT zurückgesetzt: Der Modus ist nach dem ersten Rebuild fix konfiguriert
// (Setting gesetzt → setupGesperrt greift für alle weiteren Requests), pro Prozesslebenszeit
// ist also genau ein Setup-Rebuild vorgesehen.
let rebuildGeplant = false;

async function startApp(): Promise<void> {
  const jlUrl = effektiveJlUrl();
  const jlTaskCalendarId = effektiveJlTaskCalendarId();
  const app = await buildApp({
    db, dataDir, convert, publicUrl,
    backupIntervalHours: backupStunden,
    transkriptionConfig,
    ...(existsSync(webDir) ? { webDir } : {}),
    ...(jlUrl ? { jlawyerUrl: jlUrl } : {}),
    ...(jlTaskCalendarId ? { jlawyerTaskCalendarId: jlTaskCalendarId } : {}),
    // Setup hat den Modus konfiguriert: App intern neu aufbauen (Routen sind
    // modusabhängig registriert). Verzögert, damit die Antwort noch rausgeht.
    onModeConfigured: () => {
      if (rebuildGeplant) return;
      rebuildGeplant = true;
      setTimeout(() => {
        void app.close().then(startApp).catch((e) => {
          console.error('Neustart nach Setup fehlgeschlagen:', e);
          process.exit(1);
        });
      }, 150);
    },
  });
  await app.listen({ port, host: '0.0.0.0' });
  console.log(
    `Digital-Desktop-Server läuft auf Port ${port}${existsSync('/.dockerenv') ? ` (im Container — von außen gilt der beim Start gemappte Port, z. B. -p 4811:${port})` : ''} (Daten: ${dataDir}${existsSync(webDir) ? `, Web-App: ${webDir}` : ', ohne Web-App'}${jlUrl ? `, j-lawyer: ${jlUrl}` : ''}${convert ? `, Vorschau-Konverter: ${convert.url}` : ', ohne Vorschau-Konverter'}, Backup-Takt: ${backupStunden > 0 ? `alle ${backupStunden}h` : 'abgeschaltet'})`,
  );
}

await startApp();
