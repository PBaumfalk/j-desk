import type { ZeitleistenEintrag } from '@j-desk/core';

/**
 * Achsenrechnung der Zeitleistenkarte (CHRONO-01/02) als reine, exakt getestete Funktionen —
 * bewusst ohne jede Ein-/Ausgabe und ohne Fremdimporte außer Typen aus `@j-desk/core` (Konvention
 * aus `geometry.ts`). Achsenspanne, Tickabstände und Reihenstapelung sind die einzigen Stellen mit
 * echter Logik in der Zeitleistendarstellung, und in einer `.svelte`-Datei wären sie in diesem
 * Projekt nicht testbar (die Testumgebung ist `node`, es gibt keine Komponententests) — deshalb
 * liegt die Rechnung hier, außerhalb der Komponente (09-05-PLAN.md).
 *
 * Eine Zoomstufe ist für dieses Modul nur ein Faktor auf `breitePx` — die Zoomknöpfe der Karte
 * verändern nichts an dieser Rechnung außer diesem einen Wert; die Karte multipliziert ihre
 * Basisbreite selbst, bevor sie sie hier hereinreicht.
 */

const MILLISEKUNDEN_PRO_TAG = 86_400_000;
const ISO_KALENDERTAG = /^\d{4}-\d{2}-\d{2}$/;
/** Rand links/rechts der Spanne (Tage), damit ein Marker am Rand nicht abgeschnitten wird. */
const ACHSEN_RAND_TAGE = 14;
/** Standardspanne (Tage vor/nach heute) für eine Zeitleiste ohne Einträge. */
const STANDARD_SPANNE_TAGE = 30;
/** Mindestabstand zweier Tickmarken in Pixeln — darunter gilt eine Beschriftungsdichte als unlesbar. */
const MIN_TICK_ABSTAND_PX = 48;

/** Parst einen ISO-Kalendertag (`JJJJ-MM-TT`) zu UTC-Millisekunden; ein nicht parsbarer Wert
 *  ergibt `undefined` statt eine Ausnahme auszulösen (Muster `tableFormulas.ts`). */
function parseIsoTag(iso: string): number | undefined {
  if (typeof iso !== 'string' || !ISO_KALENDERTAG.test(iso)) return undefined;
  const millis = Date.parse(iso);
  return Number.isFinite(millis) ? millis : undefined;
}

function tageSeitEpoche(iso: string): number | undefined {
  const millis = parseIsoTag(iso);
  return millis === undefined ? undefined : Math.floor(millis / MILLISEKUNDEN_PRO_TAG);
}

function isoAusTagen(tage: number): string {
  return new Date(tage * MILLISEKUNDEN_PRO_TAG).toISOString().slice(0, 10);
}

function heuteTage(): number {
  return Math.floor(Date.now() / MILLISEKUNDEN_PRO_TAG);
}

/**
 * Kalendertag-Spanne über allen gültigen Einträgen (inklusive Zeitraum-Enddaten), plus Rand links
 * und rechts. Eine leere Liste — oder eine Liste ganz ohne gültiges Datum — liefert eine
 * Standardspanne um das heutige Datum statt einer Spanne der Länge null. Ein Eintrag mit
 * ungültigem Datum wird dabei übersprungen, nicht als Fehler behandelt.
 */
export function achsenSpanne(eintraege: readonly ZeitleistenEintrag[]): { von: string; bis: string } {
  const tage: number[] = [];
  for (const e of eintraege) {
    const start = tageSeitEpoche(e.datum);
    if (start === undefined) continue;
    tage.push(start);
    if (e.zeitangabe === 'zeitraum' && e.datumBis !== undefined) {
      const ende = tageSeitEpoche(e.datumBis);
      if (ende !== undefined) tage.push(ende);
    }
  }
  if (tage.length === 0) {
    const heute = heuteTage();
    return { von: isoAusTagen(heute - STANDARD_SPANNE_TAGE), bis: isoAusTagen(heute + STANDARD_SPANNE_TAGE) };
  }
  const minTag = Math.min(...tage);
  const maxTag = Math.max(...tage);
  return { von: isoAusTagen(minTag - ACHSEN_RAND_TAGE), bis: isoAusTagen(maxTag + ACHSEN_RAND_TAGE) };
}

function monatsMarken(vonTag: number, bisTag: number, pxProTag: number): { x: number; label: string; art: 'monat' }[] {
  const ticks: { x: number; label: string; art: 'monat' }[] = [];
  const start = new Date(vonTag * MILLISEKUNDEN_PRO_TAG);
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const endeMs = bisTag * MILLISEKUNDEN_PRO_TAG;
  let grenze = 0;
  while (cursor.getTime() <= endeMs && grenze < 1000) {
    grenze += 1;
    const tag = Math.floor(cursor.getTime() / MILLISEKUNDEN_PRO_TAG);
    if (tag >= vonTag) {
      const label = cursor.getUTCMonth() === 0
        ? `${cursor.getUTCFullYear()}`
        : cursor.toLocaleDateString('de-DE', { month: 'short', timeZone: 'UTC' });
      ticks.push({ x: (tag - vonTag) * pxProTag, label, art: 'monat' });
    }
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return ticks;
}

function jahresMarken(vonTag: number, bisTag: number, pxProTag: number): { x: number; label: string; art: 'jahr' }[] {
  const ticks: { x: number; label: string; art: 'jahr' }[] = [];
  const start = new Date(vonTag * MILLISEKUNDEN_PRO_TAG);
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), 0, 1));
  const endeMs = bisTag * MILLISEKUNDEN_PRO_TAG;
  let grenze = 0;
  while (cursor.getTime() <= endeMs && grenze < 1000) {
    grenze += 1;
    const tag = Math.floor(cursor.getTime() / MILLISEKUNDEN_PRO_TAG);
    if (tag >= vonTag) {
      ticks.push({ x: (tag - vonTag) * pxProTag, label: `${cursor.getUTCFullYear()}`, art: 'jahr' });
    }
    cursor.setUTCFullYear(cursor.getUTCFullYear() + 1);
  }
  return ticks;
}

/**
 * Tickmarken über der Spanne: Monatsmarken bei einer Spanne von wenigen Monaten, Jahresmarken bei
 * vielen Jahren — und nie mehr Marken, als bei `breitePx` lesbar sind (Mindestabstand
 * `MIN_TICK_ABSTAND_PX`). Ist selbst die Jahresstaffelung noch zu dicht (extrem schmale Breite),
 * wird sie ausgedünnt statt unlesbar dicht zu bleiben.
 */
export function achsenTicks(
  spanne: { von: string; bis: string },
  breitePx: number,
): { x: number; label: string; art: 'monat' | 'jahr' }[] {
  const vonTag = tageSeitEpoche(spanne.von);
  const bisTag = tageSeitEpoche(spanne.bis);
  if (vonTag === undefined || bisTag === undefined || bisTag <= vonTag || breitePx <= 0) return [];
  const pxProTag = breitePx / (bisTag - vonTag);
  const maxMarken = Math.max(1, Math.floor(breitePx / MIN_TICK_ABSTAND_PX));

  const monate = monatsMarken(vonTag, bisTag, pxProTag);
  if (monate.length <= maxMarken) return monate;

  const jahre = jahresMarken(vonTag, bisTag, pxProTag);
  if (jahre.length <= maxMarken) return jahre;

  // Selbst Jahresmarken sind bei dieser Breite noch zu dicht — jedes n-te Jahr behalten.
  const schritt = Math.ceil(jahre.length / maxMarken);
  return jahre.filter((_, i) => i % schritt === 0);
}

/**
 * x-Positionen (und bei Zeitraum-Einträgen zusätzlich Endpositionen) sowie Achsenreihen je
 * Eintrag. Ein Datum am Spannenanfang bildet auf x=0 ab, eines am Spannenende auf die volle
 * `breitePx`. Der Belegungslauf geht in deterministischer Sortierreihenfolge (Datum, dann id —
 * dieselbe Ordnung wie `sortierteEintraege` im Kern) vor und setzt jeden Marker in die erste
 * Reihe, deren letzter belegter x-Bereich weit genug links liegt (Kartenstapel-Metapher,
 * 09-UI-SPEC.md). Ein Eintrag mit ungültigem Datum wird übersprungen statt eine Ausnahme
 * auszulösen.
 */
export function markerPositionen(
  eintraege: readonly ZeitleistenEintrag[],
  spanne: { von: string; bis: string },
  breitePx: number,
  markerBreitePx: number,
): { eintragId: string; x: number; xBis?: number; reihe: number }[] {
  const vonTag = tageSeitEpoche(spanne.von);
  const bisTag = tageSeitEpoche(spanne.bis);
  if (vonTag === undefined || bisTag === undefined || bisTag <= vonTag) return [];
  const pxProTag = breitePx / (bisTag - vonTag);

  const roh: { eintrag: ZeitleistenEintrag; x: number; xBis?: number }[] = [];
  for (const e of eintraege) {
    const tag = tageSeitEpoche(e.datum);
    if (tag === undefined) continue;
    const x = (tag - vonTag) * pxProTag;
    if (e.zeitangabe === 'zeitraum' && e.datumBis !== undefined) {
      const tagBis = tageSeitEpoche(e.datumBis);
      if (tagBis !== undefined) {
        roh.push({ eintrag: e, x, xBis: (tagBis - vonTag) * pxProTag });
        continue;
      }
    }
    roh.push({ eintrag: e, x });
  }

  roh.sort((a, b) => {
    if (a.eintrag.datum !== b.eintrag.datum) return a.eintrag.datum < b.eintrag.datum ? -1 : 1;
    return a.eintrag.id < b.eintrag.id ? -1 : a.eintrag.id > b.eintrag.id ? 1 : 0;
  });

  const reihenEnden: number[] = [];
  const ergebnis: { eintragId: string; x: number; xBis?: number; reihe: number }[] = [];
  for (const r of roh) {
    const eigenesEnde = (r.xBis ?? r.x) + markerBreitePx;
    let reihe = reihenEnden.findIndex((ende) => r.x >= ende);
    if (reihe === -1) {
      reihe = reihenEnden.length;
      reihenEnden.push(eigenesEnde);
    } else {
      reihenEnden[reihe] = eigenesEnde;
    }
    ergebnis.push(
      r.xBis !== undefined
        ? { eintragId: r.eintrag.id, x: r.x, xBis: r.xBis, reihe }
        : { eintragId: r.eintrag.id, x: r.x, reihe },
    );
  }
  return ergebnis;
}
