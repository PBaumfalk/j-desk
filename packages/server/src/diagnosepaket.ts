import { platform, arch } from 'node:os';
import type { Db } from './db';
import { baueDiagnose, type BaueDiagnoseDeps } from './diagnose';

/**
 * Diagnosepaket (OPS-02/OPS-05, 14-06): ein Support-Bundle als lesbare JSON-Textdatei —
 * ausschließlich technische Diagnosedaten, NIE Mandanteninhalte/Dokumente/Passwörter/
 * Zugangsmerkmale (T-14-06-01, kritisch — die Zusicherung, wegen der das Paket überhaupt
 * herausgegeben werden darf).
 *
 * VERBINDLICHE BAUREGEL: jedes Feld wird EINZELN benannt und EINZELN befüllt. Es wird KEIN
 * Objekt übernommen, weitergereicht oder ausgebreitet (kein Spread-Operator über ein fremdes
 * Objekt) — insbesondere keine Umgebungs-, Konfigurations- oder Zustandsobjekte als Ganzes.
 * Externe Anbindungen (j-lawyer, Euro-Office) erscheinen ausschließlich als Zustandsangabe
 * (aus dem bereits ausgewerteten DiagnoseBericht), nie mit ihrer Adresse und nie mit einem
 * gemeinsamen Geheimnis. Dieses Modul liest `process.env` an KEINER Stelle — der
 * Betriebszustand kommt ausschließlich über die typisierten `BaueDiagnoseDeps` herein, die
 * app.ts aus main.ts durchreicht (dieselbe Kette wie bei der /diagnose-Route).
 *
 * Kein Archiv, keine Protokolldateien: Protokolle könnten Mandantsnamen enthalten und sind
 * deshalb ausdrücklich NICHT Teil des Pakets — diese Entscheidung ist bewusst und soll nicht
 * versehentlich aufgeweicht werden (14-UI-SPEC.md Planner-Entscheidungen).
 */

/** Verbindungs-Zeile im Paket — NUR Zustand + feste Handlungsempfehlung, bewusst OHNE
 *  Ursache-Text: `ursache` bei j-lawyer/Euro-Office kommt aus einer dynamischen
 *  fetch()-Fehlermeldung (z. B. Node-Netzwerkfehler „connect ECONNREFUSED
 *  <ip>:<port>") und könnte damit die konfigurierte Adresse embedded enthalten — das Paket
 *  verlässt die Instanz, deshalb strukturell (typisiert) kein Ursache-Feld hier (T-14-06-01).
 *  `empfehlung` ist dagegen eine feste Server-Konstante (diagnose.ts) ohne Adressbezug. */
export interface DiagnosepaketVerbindung {
  label: string;
  status: string;
  empfehlung?: string;
}

/** Speicher-Zeile im Paket — Rohzahlen, kein Dateiinhalt/-name. */
export interface DiagnosepaketSpeicher {
  label: string;
  status: string;
  bytes?: number;
  anzahl?: number;
  ursache?: string;
}

/** Backup-Zeile im Paket — Zeitpunkt/Zustand, kein Dateipfad. */
export interface DiagnosepaketBackup {
  label: string;
  status: string;
  zeitpunkt?: string;
  errechnet?: boolean;
}

export interface Diagnosepaket {
  erstelltAm: string;
  anwendungsVersion: string;
  schemaVersion: number;
  nodeVersion: string;
  plattform: string;
  architektur: string;
  laufzeitSekunden: number;
  betriebsmodus: string;
  verbindungen: DiagnosepaketVerbindung[];
  speicher: DiagnosepaketSpeicher[];
  backup: DiagnosepaketBackup[];
  zaehlwerte: { schreibtische: number; dateien: number; journalzeilen: number; nutzer: number };
}

/** Reine Zählwerte über die Betriebstabellen (COUNT(*) — kein Inhalt, keine Namen). */
function ermittleZaehlwerte(db: Db): Diagnosepaket['zaehlwerte'] {
  const zaehl = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
  return {
    schreibtische: zaehl('SELECT COUNT(*) AS n FROM desks'),
    dateien: zaehl('SELECT COUNT(*) AS n FROM files'),
    journalzeilen: zaehl('SELECT COUNT(*) AS n FROM command_journal'),
    nutzer: zaehl('SELECT COUNT(*) AS n FROM users'),
  };
}

/**
 * Baut das Diagnosepaket aus dem bereits ausgewerteten DiagnoseBericht (dieselbe Quelle wie
 * die /diagnose-Route, „Nutzer nur einer einzigen reinen Funktion vertrauen müssen" — Muster
 * aus `projectStateForActor()`, 14-PATTERNS.md Shared Patterns) PLUS den zusätzlichen
 * Betriebstabellen-Zählwerten. Jedes Feld unten wird einzeln aus dem Bericht herausgegriffen
 * (`z.label`, `z.status`, …) — nie ein `DiagnoseZeile`-Objekt als Ganzes übernommen, damit
 * künftige, hier nicht vorgesehene Felder auf `DiagnoseZeile` nicht unbeabsichtigt mit ins
 * Paket rutschen.
 */
export async function baueDiagnosepaket(deps: BaueDiagnoseDeps): Promise<Diagnosepaket> {
  const bericht = await baueDiagnose(deps);
  const systemWert = (label: string): string | undefined => bericht.system.find((z) => z.label === label)?.wert;

  return {
    erstelltAm: new Date().toISOString(),
    anwendungsVersion: systemWert('J-Desk-Version') ?? 'unbekannt',
    schemaVersion: Number(systemWert('Datenbankschema') ?? 0),
    nodeVersion: process.version,
    plattform: platform(),
    architektur: arch(),
    laufzeitSekunden: Math.round(process.uptime()),
    betriebsmodus: systemWert('Betriebsmodus') ?? 'unbekannt',
    verbindungen: bericht.verbindungen.map((z) => ({
      label: z.label,
      status: z.status,
      empfehlung: z.empfehlung,
    })),
    speicher: bericht.speicher.map((z) => ({
      label: z.label,
      status: z.status,
      bytes: z.bytes,
      anzahl: z.anzahl,
      ursache: z.ursache,
    })),
    backup: bericht.backup.map((z) => ({
      label: z.label,
      status: z.status,
      zeitpunkt: z.zeitpunkt,
      errechnet: z.errechnet,
    })),
    zaehlwerte: ermittleZaehlwerte(deps.db),
  };
}
