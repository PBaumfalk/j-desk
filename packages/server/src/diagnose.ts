import { readFileSync, statSync, statfsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './db';
import { probeJLawyer } from './jlawyer';
import type { ConvertConfig } from './convert';
import { BACKUP_DIR, newestBackupFile } from './backup';

/**
 * Systemdiagnose (OPS-02, 14-01/14-06): serverseitige Aggregation für das Eigentümer-only
 * Diagnose-Overlay — Version, Schema, Verbindungszustände, Speicher- und Sicherungslage, ohne
 * SQL und ohne Serverzugang. Analog `legalQueries.ts`: Ergebnisform + Konstanten leben im
 * Modul, der Route-Handler (app.ts) bleibt ein Einzeiler.
 */

/** Vier Zustände, entsprechend den vier UI-SPEC-Statusfarben (14-UI-SPEC.md Color) —
 *  SYSTEM-Zeilen tragen laut Copywriting Contract keinen Statuspunkt und setzen `status`
 *  einheitlich auf 'ok' (rein faktisch; die Unterscheidung läuft über den Abschnitt, nicht
 *  über einen Sonderstatus). */
export type DiagnoseStatus = 'ok' | 'warnung' | 'fehler' | 'nicht-konfiguriert';

export interface DiagnoseZeile {
  status: DiagnoseStatus;
  label: string;
  wert?: string;
  /** Normalisierte, einzeilige Klartextursache — nie ein roher Stacktrace (T-14-01-03). */
  ursache?: string;
  /** Handlungsempfehlung aus dem Copywriting Contract, getrennt von `ursache`. */
  empfehlung?: string;
  /** Rohe Byte-Anzahl (SPEICHER-Abschnitt, 14-06) — der Client formatiert lesbar (KB/MB/GB),
   *  damit die Formatierungslogik nicht doppelt (Server+Client) gepflegt werden muss. */
  bytes?: number;
  /** Stückzahl (SPEICHER-Abschnitt „Dateispeicher", 14-06). */
  anzahl?: number;
  /** ISO-Zeitstempel (BACKUP-Abschnitt, 14-06) — Rohwert, der Client formatiert lokal im
   *  gewohnten deutschen Datumsformat. */
  zeitpunkt?: string;
  /** Kennzeichnet einen ERRECHNETEN (nicht persistierten) Zeitpunkt — BACKUP-Abschnitt
   *  „Nächste geplante Sicherung" (D-C, 14-RESEARCH.md Open Question 2): nach einem
   *  Serverneustart verschiebt sich der reale Takt, die Zeile darf nicht als Zusage
   *  missverstanden werden (T-14-06-05, Repudiation). */
  errechnet?: boolean;
}

/**
 * Vier feste Abschnittsschlüssel (14-01-PLAN.md must_haves). SPEICHER/BACKUP werden in 14-06
 * befüllt — dieselbe Zeilenform (`DiagnoseZeile`) wie SYSTEM/VERBINDUNGEN, nur mit den oben
 * ergänzten optionalen Feldern; der Client rendert einen leeren Abschnitt schlicht nicht (kein
 * Platzhaltertext).
 */
export interface DiagnoseBericht {
  system: DiagnoseZeile[];
  verbindungen: DiagnoseZeile[];
  speicher: DiagnoseZeile[];
  backup: DiagnoseZeile[];
}

// Root-package.json einmalig beim Modul-Laden lesen (kein Import-Assert, kein JSON-Import
// jenseits von package.json) — dieselbe „drei Ebenen hoch"-Ableitung wie main.ts (webDir-
// Default): packages/server/src -> packages/server -> packages -> Repo-Wurzel.
const ROOT_PACKAGE_JSON = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'package.json');
const APP_VERSION = (JSON.parse(readFileSync(ROOT_PACKAGE_JSON, 'utf8')) as { version: string }).version;

/** Euro-Office-DocumentServer antwortet nicht innerhalb dieser Frist → Zeile mit Status
 *  'fehler' statt einer offen hängenden Prüfung. Der Copywriting Contract (14-UI-SPEC.md)
 *  nennt „Zeitüberschreitung nach 5 Sekunden" wörtlich als Beispielursache — dieser Wert ist
 *  damit gesetzt, keine freie Ausführungswahl. */
export const EUROOFFICE_PROBE_TIMEOUT_MS = 5_000;

export interface BaueDiagnoseDeps {
  db: Db;
  dataDir: string;
  /** Effektive j-lawyer-Basis-URL (main.ts effektiveJlUrl()) — gesetzt = j-lawyer-Modus. */
  jlBase: string | undefined;
  /** null/undefined = Euro-Office-Vorschau nicht konfiguriert. */
  convert: ConvertConfig | null | undefined;
  /** Überschreibbar für Tests; Standard = die aus der Root-package.json gelesene Version. */
  appVersion?: string;
  /** Backup-Takt in Stunden — main.ts liest/validiert BACKUP_INTERVAL_HOURS einmalig
   *  (`parseHours`, WR-02) und reicht das Ergebnis über app.ts durch; dieses Modul liest
   *  process.env dafür NICHT erneut (14-06-PLAN.md Task 1). `<= 0`/nicht endlich = Takt
   *  abgeschaltet — dieselbe Semantik wie `starteBackupIntervall()` (backup.ts). */
  backupTaktStunden: number;
}

/**
 * Schlanker Erreichbarkeits-Ping gegen die Basis-URL des DocumentServers — Rückgabeform und
 * Fehlernormalisierung exakt nach dem `probeJLawyer`-Vorbild (jlawyer.ts). Neu gebaut, weil
 * `createConverter().enabled()` (convert.ts) nur „konfiguriert?" beantwortet, keinen echten
 * Erreichbarkeits-Ping kennt (14-RESEARCH.md A5).
 */
export async function probeEuroOffice(baseUrl: string, timeoutMs: number): Promise<{ ok: boolean; message: string }> {
  try {
    // Die Basis-URL selbst ist meist kein sinnvoller Endpunkt — wie bei probeJLawyer zählt
    // schon eine Antwort (unabhängig vom Statuscode) als „erreichbar"; ein Netzwerkfehler/
    // Timeout wirft.
    await fetch(baseUrl, { signal: AbortSignal.timeout(timeoutMs) });
    return { ok: true, message: 'Euro-Office-DocumentServer erreichbar' };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : 'Euro-Office-DocumentServer nicht erreichbar',
    };
  }
}

async function baueJLawyerZeile(jlBase: string | undefined): Promise<DiagnoseZeile> {
  if (!jlBase) return { status: 'nicht-konfiguriert', label: 'j-lawyer' };
  try {
    const ergebnis = await probeJLawyer(jlBase);
    if (ergebnis.ok) return { status: 'ok', label: 'j-lawyer' };
    return {
      status: 'fehler',
      label: 'j-lawyer',
      ursache: ergebnis.message,
      empfehlung: 'Prüfen Sie die j-lawyer-Adresse in den Verbindungseinstellungen.',
    };
  } catch (e) {
    // probeJLawyer fängt eigene Fehler bereits ab — dieser Zweig ist ein zusätzliches
    // Sicherheitsnetz, damit eine unerwartete Ausnahme nur DIESE Zeile trifft (die übrigen
    // Prüfungen laufen unabhängig weiter, T-14-01-04).
    return {
      status: 'fehler',
      label: 'j-lawyer',
      ursache: e instanceof Error ? e.message : 'j-lawyer nicht erreichbar',
      empfehlung: 'Prüfen Sie die j-lawyer-Adresse in den Verbindungseinstellungen.',
    };
  }
}

async function baueEuroOfficeZeile(convert: ConvertConfig | null): Promise<DiagnoseZeile> {
  if (!convert) return { status: 'nicht-konfiguriert', label: 'Euro-Office-Vorschau' };
  try {
    const ergebnis = await probeEuroOffice(convert.url, EUROOFFICE_PROBE_TIMEOUT_MS);
    if (ergebnis.ok) return { status: 'ok', label: 'Euro-Office-Vorschau' };
    return {
      status: 'fehler',
      label: 'Euro-Office-Vorschau',
      ursache: ergebnis.message,
      empfehlung: 'Prüfen Sie EUROOFFICE_URL in der Server-Konfiguration.',
    };
  } catch (e) {
    return {
      status: 'fehler',
      label: 'Euro-Office-Vorschau',
      ursache: e instanceof Error ? e.message : 'Euro-Office-DocumentServer nicht erreichbar',
      empfehlung: 'Prüfen Sie EUROOFFICE_URL in der Server-Konfiguration.',
    };
  }
}

/**
 * Baut den VERBINDUNGEN-Abschnitt: Server ist immer 'ok' (die Antwort selbst ist der Beweis),
 * j-lawyer/Euro-Office laufen unabhängig parallel (Promise.all) und fangen ihre eigenen
 * Fehler — eine gescheiterte Prüfung verschluckt nie die übrigen Zeilen (T-14-01-04). Die
 * WebSocket-Zeile entsteht bewusst NICHT hier: der Server kann den Verbindungszustand der
 * fragenden Sitzung nicht beobachten — sie wird client-seitig aus dem Reconnect-Zustand des
 * Stores abgeleitet und dort einsortiert (SystemdiagnoseOverlay.svelte, Task 3).
 */
async function baueVerbindungen(jlBase: string | undefined, convert: ConvertConfig | null): Promise<DiagnoseZeile[]> {
  const [jlawyerZeile, euroOfficeZeile] = await Promise.all([
    baueJLawyerZeile(jlBase),
    baueEuroOfficeZeile(convert),
  ]);
  return [{ status: 'ok', label: 'Server' }, jlawyerZeile, euroOfficeZeile];
}

/** Ab wann die „Dateispeicher"-Zeile den Warnzustand statt reiner Information trägt — weniger
 *  als 1 GiB frei auf dem Dateisystem des Datenverzeichnisses. Ein fester Byte-Wert (statt
 *  eines Prozentsatzes der Gesamtgröße) ist die verständlichere Schwelle für ein Verzeichnis,
 *  dessen Host-Gesamtgröße stark variiert; die Konstante entscheidet NUR, wann die Zeile den
 *  Warnton statt „in Ordnung" trägt (Copywriting Contract „rein informativ … außer bei
 *  Warnschwelle"), nicht die Aggregatzahlen selbst (T-14-06-04, low-severity/accept). */
export const SPEICHER_WARNSCHWELLE_FREI_BYTES = 1024 * 1024 * 1024; // 1 GiB

/** Menschliches Kurzformat NUR für den fertigen Ursache-Satz der Warnschwelle unten (die
 *  {Größe}-Hauptwerte der Zeilen selbst bleiben rohe `bytes`-Zahlen, die der Client formatiert —
 *  SystemdiagnoseOverlay.svelte). */
function formatBytesDe(bytes: number): string {
  const einheiten = ['B', 'KB', 'MB', 'GB', 'TB'];
  let wert = bytes;
  let i = 0;
  while (wert >= 1024 && i < einheiten.length - 1) {
    wert /= 1024;
    i += 1;
  }
  return i === 0 ? `${Math.round(wert)} ${einheiten[i]}` : `${wert.toFixed(1).replace('.', ',')} ${einheiten[i]}`;
}

/**
 * SPEICHER-Abschnitt: Datenbankgröße über eine Größenabfrage auf die eine bekannte
 * Datenbankdatei, Dateianzahl/-gesamtgröße über EINE Aggregationsabfrage auf die `files`-Tabelle
 * (die Größe steht dort bereits je Zeile) — bewusst KEIN Verzeichnisdurchlauf: die
 * inhaltsadressierte Ablage (`files.ts`) bedeutet, dass mehrere Karten dieselbe Datei teilen;
 * die Aggregationsabfrage zählt das korrekt, ein Verzeichnis-Scan müsste Dubletten,
 * Berechtigungen und Verweise selbst nachbauen (14-RESEARCH.md Pattern 6).
 */
function baueSpeicher(db: Db, dataDir: string): DiagnoseZeile[] {
  let dbGroesse = 0;
  try {
    dbGroesse = statSync(join(dataDir, 'desktop.sqlite')).size;
  } catch {
    // In-Memory-Testumgebungen (z. B. createTestAppMitZweiNutzern) haben keine Datenbankdatei
    // auf der Platte — im Produktivbetrieb existiert sie immer (main.ts öffnet die echte Datei
    // vor buildApp()). 0 statt eines Absturzes ist hier die ehrliche Angabe, kein Rätestand.
  }
  const { anzahl, gesamt } = db
    .prepare('SELECT COUNT(*) AS anzahl, COALESCE(SUM(size), 0) AS gesamt FROM files')
    .get() as { anzahl: number; gesamt: number };

  let freiBytes: number | undefined;
  try {
    const fsInfo = statfsSync(dataDir);
    freiBytes = fsInfo.bavail * fsInfo.bsize;
  } catch {
    // statfsSync kann auf exotischen Dateisystemen scheitern — die Warnschwelle entfällt dann
    // einfach (Zeile bleibt informativ), die Größenangaben selbst sind davon unberührt.
    freiBytes = undefined;
  }
  const knapp = freiBytes !== undefined && freiBytes < SPEICHER_WARNSCHWELLE_FREI_BYTES;

  return [
    { status: 'ok', label: 'Datenbank', bytes: dbGroesse },
    knapp
      ? {
          status: 'warnung',
          label: 'Dateispeicher',
          bytes: gesamt,
          anzahl,
          // Wortlaut exakt aus dem Copywriting Contract (14-UI-SPEC.md): „Warnung: Speicher
          // wird knapp — {X} frei" — der Client hängt den „Warnung: "-Präfix über dieselbe
          // zeilenText()-Funktion an, die schon die VERBINDUNGEN-Zeilen bedient.
          ursache: `Speicher wird knapp — ${formatBytesDe(freiBytes!)} frei`,
        }
      : { status: 'ok', label: 'Dateispeicher', bytes: gesamt, anzahl },
  ];
}

/**
 * BACKUP-Abschnitt: die letzte Sicherung AUSSCHLIESSLICH über `newestBackupFile()` — die
 * instanzweite Sicherungsrotation (SAFE-03, `backup/desktop-*.sqlite`), NICHT die
 * desk-bezogene Automatiksicherung (SAFE-06, eigene Spalte auf der Desk-Zeile). Jene ist die
 * opportunistische `.jdesk`-Sicherung EINES Desks in die j-lawyer-Akte — bei mehreren
 * Schreibtischen mehrdeutig und ein ganz anderer, viel häufigerer Takt (14-RESEARCH.md
 * Pitfall 2). Der Zeitpunkt der Datei kommt aus ihrer Dateisystem-mtime (nicht aus dem
 * eingebetteten Namensmuster — das ist ausschließlich für die Sortierung in
 * `newestBackupFile()` gedacht und dort bewusst privat gehalten).
 * „Nächste geplante Sicherung" ist eine BERECHNUNG (letzte Sicherung + Takt), keine
 * persistierte Angabe (D-C) — fehlt eine Sicherung oder ist der Takt abgeschaltet, entfallen
 * die jeweiligen Angaben ehrlich statt einen Wert zu erfinden.
 */
function baueBackup(dataDir: string, backupTaktStunden: number): DiagnoseZeile[] {
  const backupDir = join(dataDir, BACKUP_DIR);
  const neuesteDatei = newestBackupFile(backupDir);
  if (!neuesteDatei) {
    return [{ status: 'nicht-konfiguriert', label: 'Letzte Sicherung' }];
  }
  const letzteSicherung = statSync(join(backupDir, neuesteDatei)).mtime;
  const zeilen: DiagnoseZeile[] = [
    { status: 'ok', label: 'Letzte Sicherung', zeitpunkt: letzteSicherung.toISOString() },
  ];
  if (Number.isFinite(backupTaktStunden) && backupTaktStunden > 0) {
    const naechste = new Date(letzteSicherung.getTime() + backupTaktStunden * 60 * 60 * 1000);
    zeilen.push({
      status: 'ok',
      label: 'Nächste geplante Sicherung',
      zeitpunkt: naechste.toISOString(),
      errechnet: true,
    });
  }
  return zeilen;
}

/** Baut den vollständigen Diagnosebericht aus expliziten Abhängigkeiten (kein Modul-Global) —
 *  so ist die Funktion im Test ohne laufenden Server aufrufbar. */
export async function baueDiagnose(deps: BaueDiagnoseDeps): Promise<DiagnoseBericht> {
  const { db, dataDir, jlBase, convert, backupTaktStunden } = deps;
  const version = deps.appVersion ?? APP_VERSION;
  const schemaVersion = db.pragma('user_version', { simple: true }) as number;
  const system: DiagnoseZeile[] = [
    { status: 'ok', label: 'J-Desk-Version', wert: version },
    { status: 'ok', label: 'Datenbankschema', wert: String(schemaVersion) },
    { status: 'ok', label: 'Node-Laufzeit', wert: process.version },
    { status: 'ok', label: 'Betriebsmodus', wert: jlBase ? 'j-lawyer' : 'eigenstaendig' },
  ];
  const verbindungen = await baueVerbindungen(jlBase, convert ?? null);
  const speicher = baueSpeicher(db, dataDir);
  const backup = baueBackup(dataDir, backupTaktStunden);
  return { system, verbindungen, speicher, backup };
}
