/**
 * Lokale Pfade für tesseract.js (SEARCH-03, T-07-32, 07-RESEARCH Pitfall 1). Ohne diese Angaben
 * lädt die Bibliothek Sprachmodell und Kern beim ersten Erkennungslauf von einem öffentlichen
 * Netzdienst nach — für ein Kanzleiprodukt mit Vertraulichkeitszusage und teils ohne
 * Internetzugang kommt das nicht in Frage. Dieses Modul stellt sicher, dass `langPath`,
 * `cachePath`, `corePath` und `workerPath` ausschließlich auf lokale Dateisystempfade zeigen.
 *
 * Gegengelesen nach der Installation (07-07-PLAN.md `<read_first>`): `node_modules/tesseract.js/
 * docs/local-installation.md` und der tatsächliche Quellcode (`worker-script/index.js`,
 * `worker-script/node/getCore.js`) bestätigen, dass tesseract.js im Node-Kontext den Kern immer
 * lokal aus dem `tesseract.js-core`-Paket lädt (nie über `corePath` aus dem Netz) und das
 * Sprachmodell nur dann von einem entfernten Ort holt, wenn `langPath` NICHT gesetzt ist — genau
 * dieser Fall wird hier durch einen expliziten, lokalen `langPath` ausgeschlossen.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

/**
 * Standardmäßig `packages/server/tessdata` (relativ zum Modul aufgelöst — dasselbe Verfahren wie
 * `WEB_DIR` in `main.ts`: `dirname(fileURLToPath(import.meta.url))` statt eines
 * arbeitsverzeichnisabhängigen Pfads), über die Umgebungsvariable `TESSDATA_DIR` überschreibbar
 * (z. B. für ein Docker-Volume oder einen abweichenden Ablageort im Betrieb).
 */
export const TESSDATA_DIR = process.env.TESSDATA_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tessdata');

/** Prüft die Existenz von `deu.traineddata` in `TESSDATA_DIR` — die einzige Voraussetzung, damit
 *  die OCR-Stufe (ocrQueue.ts, 07-07) überhaupt anläuft. */
export function sprachdatenVorhanden(): boolean {
  return existsSync(join(TESSDATA_DIR, 'deu.traineddata'));
}

/**
 * `corePath`: das installierte `tesseract.js-core`-Paket selbst (im Node-Kontext ohnehin nie über
 * das Netz nachgeladen, s. Kommentar oben — hier trotzdem explizit lokal gesetzt, damit die
 * Konfiguration für sich genommen bereits eindeutig lokal ist, unabhängig vom internen
 * Node-/Browser-Verzweigungsverhalten der Bibliothek).
 * `workerPath`: das im Paket mitgelieferte Node-Worker-Skript (identisch mit dem Standardwert,
 * den `tesseract.js` für den Node-Kontext ohnehin selbst setzt — hier ausdrücklich benannt, damit
 * diese Datei die vollständige, lokale Konfiguration an einer Stelle zeigt).
 */
const TESSERACT_CORE_DIR = dirname(require.resolve('tesseract.js-core/package.json'));
const TESSERACT_WORKER_PATH = require.resolve('tesseract.js/src/worker-script/node/index.js');

/**
 * Vollständige, ausschließlich lokale Pfadkonfiguration für `createWorker()` (ocrQueue.ts).
 * `gzip: false`, weil `deu.traineddata` unkomprimiert abgelegt wird (s. tessdata/README.md) —
 * andernfalls würde tesseract.js `deu.traineddata.gz` erwarten, das hier nicht vorliegt.
 */
export const TESSERACT_OPTIONEN = {
  langPath: TESSDATA_DIR,
  cachePath: TESSDATA_DIR,
  corePath: TESSERACT_CORE_DIR,
  workerPath: TESSERACT_WORKER_PATH,
  gzip: false,
} as const;
