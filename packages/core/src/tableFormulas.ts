/**
 * Die vier Formelarten einer Tabellenkarte (CALC-01) als reine, exakt getestete Funktionen —
 * bewusst ohne jede Ein-/Ausgabe und ohne Fremdimporte (Konvention aus geometry.ts). Geldbeträge
 * laufen intern IMMER als ganzzahlige Cent-Werte; die Umwandlung von/nach Dezimaldarstellung
 * geschieht ausschließlich an der Eingabe- (`parseEuroToCents`) und der Anzeigegrenze
 * (`formatCentsDe`) — nie über eine Gleitkomma-Multiplikation mit 100 (08-RESEARCH.md Pitfall 5).
 *
 * Client (optimistische Neuberechnung in der Tabellenkarte) und Server/Export rufen exakt diese
 * Funktionen auf — zwei Implementierungen wären zwei Wahrheiten (08-PATTERNS.md).
 */

/** Die vier unterstützten Formelarten (CALC-01) — weitere Arten sind ausdrücklich außerhalb des
 *  Scopes (REQUIREMENTS.md schließt einen Excel-Nachbau aus). Reihenfolge = Anzeigereihenfolge. */
export const FORMEL_ARTEN = ['summe', 'datumsdifferenz', 'zinsen', 'wiederkehrende-zahlung'] as const;
export type FormelArt = (typeof FORMEL_ARTEN)[number];

/**
 * Zinsmethode für `simpleInterestCents` — taggenau/365. Planner-Festlegung ohne fachliche
 * Gegenprüfung (08-06-PLAN.md `planner_assumptions`): die deutsche kaufmännische Zinsmethode
 * 30/360 war nicht vorgegeben, taggenau/365 entspricht der Regel für gesetzliche Verzugszinsen.
 * Wandert als Punkt nach 08-UAT.md — als benannte Konstante bleibt eine fachliche Korrektur eine
 * Einzeiler-Änderung.
 */
export const ZINS_TAGE_BASIS = 365;

const MILLISEKUNDEN_PRO_TAG = 86_400_000;
const ISO_KALENDERTAG = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Kaufmännisches Runden auf ganze Einheiten: halbe Einheit von der Null weg, damit negative
 * Beträge (Gutschriften) symmetrisch zu positiven behandelt werden. Jede Formel unten ruft diesen
 * Helfer genau einmal am Ende auf, nie auf Zwischenschritten — ein Zwischenschritt-Runden würde
 * bei wiederkehrenden Zahlungen sichtbare Abweichungen akkumulieren (08-06-PLAN.md).
 */
function kaufmaennischRunden(wert: number): number {
  return wert >= 0 ? Math.floor(wert + 0.5) : -Math.floor(-wert + 0.5);
}

/** Summe einer Geldspalte in Cent — reine ganzzahlige Addition, daher niemals von
 *  Fließkomma-Drift betroffen; eine leere Liste ergibt 0. */
export function sumColumnCents(valuesCents: number[]): number {
  return kaufmaennischRunden(valuesCents.reduce((summe, wert) => summe + wert, 0));
}

/**
 * Wandelt eine deutsche ODER punktbasierte Euro-Schreibweise in ganzzahlige Cent — über
 * String-/Ganzzahl-Verarbeitung der Nachkommastellen, NIE über eine Multiplikation eines
 * Gleitkommawerts mit 100 (genau dort entsteht sonst die in Pitfall 5 beschriebene Abweichung).
 * Enthält die Eingabe ein Komma, gilt es als Dezimaltrenner (deutsche Schreibweise, Punkte
 * dazwischen sind Tausendertrenner); sonst gilt ein vorhandener Punkt als Dezimaltrenner
 * (punktbasierte Schreibweise). Leere oder nicht interpretierbare Eingaben ergeben `undefined`.
 */
export function parseEuroToCents(eingabe: string): number | undefined {
  if (typeof eingabe !== 'string') return undefined;
  let rest = eingabe.trim();
  if (rest === '') return undefined;

  let negativ = false;
  if (rest.startsWith('-')) {
    negativ = true;
    rest = rest.slice(1);
  } else if (rest.startsWith('+')) {
    rest = rest.slice(1);
  }
  if (rest === '') return undefined;

  let ganzzahlTeil: string;
  let nachkommaTeil: string;

  if (rest.includes(',')) {
    const teile = rest.split(',');
    if (teile.length !== 2) return undefined;
    ganzzahlTeil = teile[0].split('.').join('');
    nachkommaTeil = teile[1];
  } else if (rest.includes('.')) {
    const teile = rest.split('.');
    if (teile.length !== 2) return undefined;
    [ganzzahlTeil, nachkommaTeil] = teile;
  } else {
    ganzzahlTeil = rest;
    nachkommaTeil = '';
  }

  if (!/^\d+$/.test(ganzzahlTeil)) return undefined;
  if (nachkommaTeil !== '' && !/^\d{1,2}$/.test(nachkommaTeil)) return undefined;

  const nachkommaCents = nachkommaTeil === '' ? 0 : Number(nachkommaTeil.padEnd(2, '0'));
  const ganzzahlCents = Number(ganzzahlTeil) * 100;
  const gesamt = ganzzahlCents + nachkommaCents;
  return negativ ? -gesamt : gesamt;
}

/** Formatiert Cent als deutsche Dezimalzahl mit zwei Nachkommastellen und Tausendertrennzeichen —
 *  OHNE Währungssymbol (die Zelle entscheidet über die Einheitenanzeige). Rechnet über
 *  Ganzzahl-Division/-Modulo statt Gleitkomma-Division, um jede Rundungsunschärfe bei der
 *  Darstellung auszuschließen. */
export function formatCentsDe(cents: number): string {
  const negativ = cents < 0;
  const absolutCents = Math.abs(Math.trunc(cents));
  const euroTeil = Math.floor(absolutCents / 100);
  const centTeil = absolutCents % 100;
  const euroFormatiert = new Intl.NumberFormat('de-DE').format(euroTeil);
  const centFormatiert = String(centTeil).padStart(2, '0');
  return `${negativ ? '-' : ''}${euroFormatiert},${centFormatiert}`;
}

/** Parst einen ISO-Kalendertag (`YYYY-MM-DD`) zu UTC-Millisekunden — Date.parse() behandelt
 *  datumsreine ISO-Strings bereits als UTC (ECMA-262), daher entsteht keine
 *  Zeitzonenverschiebung; die strikte Regex verhindert, dass Date.parse()s Nachsichtigkeit
 *  (z. B. bei "2026") ein eigentlich nicht parsbares Datum durchwinkt. */
function parseIsoKalendertagUtcMillis(iso: string): number | undefined {
  if (typeof iso !== 'string' || !ISO_KALENDERTAG.test(iso)) return undefined;
  const millis = Date.parse(iso);
  return Number.isFinite(millis) ? millis : undefined;
}

/**
 * Differenz zweier Kalendertage in vollen Tagen (negativ, wenn `bIso` vor `aIso` liegt). Die
 * Berechnung läuft über auf UTC normalisierte Kalendertage (`parseIsoKalendertagUtcMillis`),
 * damit ein Sommerzeitwechsel innerhalb des Zeitraums die Tageszahl NICHT um eine Stunde und
 * damit gelegentlich um einen ganzen Tag verschiebt. Ein nicht parsbares Datum ergibt `undefined`.
 */
export function dateDiffDays(aIso: string, bIso: string): number | undefined {
  const a = parseIsoKalendertagUtcMillis(aIso);
  const b = parseIsoKalendertagUtcMillis(bIso);
  if (a === undefined || b === undefined) return undefined;
  return Math.round((b - a) / MILLISEKUNDEN_PRO_TAG);
}

/**
 * Einfache Zinsen über `ZINS_TAGE_BASIS` (taggenau/365): `kapitalCents * zinssatzProzent% *
 * tage/ZINS_TAGE_BASIS`, kaufmännisch auf ganze Cent gerundet. Negative Tage oder ein nicht
 * endlicher Eingabewert ergeben `undefined`.
 */
export function simpleInterestCents(kapitalCents: number, zinssatzProzent: number, tage: number): number | undefined {
  if (!Number.isFinite(kapitalCents) || !Number.isFinite(zinssatzProzent) || !Number.isFinite(tage)) return undefined;
  if (tage < 0) return undefined;
  const roh = (kapitalCents * zinssatzProzent * tage) / (100 * ZINS_TAGE_BASIS);
  return kaufmaennischRunden(roh);
}

/** Gesamtsumme wiederkehrender Zahlungen: `betragCents * anzahl`. Ein negativer oder nicht
 *  ganzzahliger Zähler ergibt `undefined`. */
export function recurringPaymentTotalCents(betragCents: number, anzahl: number): number | undefined {
  if (!Number.isFinite(betragCents) || !Number.isFinite(anzahl)) return undefined;
  if (!Number.isInteger(anzahl) || anzahl < 0) return undefined;
  return kaufmaennischRunden(betragCents * anzahl);
}
