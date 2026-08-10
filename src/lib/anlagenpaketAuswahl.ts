import { effektiveFreigabe, type Doc, type Stack, type DesktopState } from '@j-desk/core';
import type { AnlagenpaketPruefung } from './api';

/**
 * Anlagenpaket-Auswahllogik (KONV-01, 10-01): reine, testbare Funktionen ohne Svelte-Bezug —
 * liegt bewusst außerhalb von `ui.svelte.ts`, damit sie ohne Runen-Kontext getestet werden kann.
 * Alle Funktionen geben neue Arrays zurück und verändern die Eingabe nicht (Bestandsregel des
 * Projekts, s. CLAUDE.md Module Design).
 */

export interface AuswahlEintrag {
  docId: string;
  bezeichnung: string;
}

/** K-Nummer aus der Listenposition (0-basiert) — „K1", „K2", … (KONV-02, exakter Wortlaut). */
export function kNummer(index: number): string {
  return `K${index + 1}`;
}

/**
 * Hängt ein Dokument ans Ende der Auswahl an. Ist die `docId` bereits enthalten, bleibt die
 * Liste unverändert (`ergaenzt: false`) — die Oberfläche zeigt dann den Hinweistext aus dem
 * Copywriting Contract statt eines zweiten Eintrags (Idempotenz-Anforderung 10-UI-SPEC.md).
 */
export function ergaenzeAuswahl(
  auswahl: AuswahlEintrag[],
  docId: string,
  bezeichnung: string
): { auswahl: AuswahlEintrag[]; ergaenzt: boolean } {
  if (auswahl.some((e) => e.docId === docId)) {
    return { auswahl, ergaenzt: false };
  }
  return { auswahl: [...auswahl, { docId, bezeichnung }], ergaenzt: true };
}

/** Entfernt einen Eintrag aus der Auswahl (per docId). */
export function entferneAuswahl(auswahl: AuswahlEintrag[], docId: string): AuswahlEintrag[] {
  return auswahl.filter((e) => e.docId !== docId);
}

/**
 * Tauscht einen Eintrag mit seinem Nachbarn (Richtung -1 = nach oben, +1 = nach unten). Am
 * Rand (erster Eintrag nach oben, letzter nach unten) bleibt die Liste unverändert — kein
 * Umlauf.
 */
export function verschiebeAuswahl(auswahl: AuswahlEintrag[], docId: string, richtung: -1 | 1): AuswahlEintrag[] {
  const index = auswahl.findIndex((e) => e.docId === docId);
  if (index === -1) return auswahl;
  const ziel = index + richtung;
  if (ziel < 0 || ziel >= auswahl.length) return auswahl;
  const neu = [...auswahl];
  [neu[index], neu[ziel]] = [neu[ziel], neu[index]];
  return neu;
}

/** Setzt die Bezeichnung eines Eintrags neu (editierbares Feld in Abschnitt 3). */
export function benenneAuswahl(auswahl: AuswahlEintrag[], docId: string, bezeichnung: string): AuswahlEintrag[] {
  return auswahl.map((e) => (e.docId === docId ? { ...e, bezeichnung } : e));
}

/**
 * Alle Dokumente mit effektiver Freigabe `export`, die noch nicht in der Auswahl stehen —
 * identischer Filter wie `UebergabeDialog.svelte dokumentOptionen` (EXP-03-Kontinuität).
 * Reihenfolge wie im Zustand.
 */
export function verfuegbareDokumente(state: DesktopState, auswahl: AuswahlEintrag[]): Doc[] {
  const gewaehlt = new Set(auswahl.map((e) => e.docId));
  return (state.docs ?? []).filter(
    (d) => effektiveFreigabe(d, state.layers) === 'export' && !gewaehlt.has(d.id)
  );
}

/** Eine Zeile der Reihenfolge-Liste im Dialog: Auswahl-Eintrag + tatsächlicher Zustand (10-03). */
export interface AuswahlZeile {
  docId: string;
  bezeichnung: string;
  verfuegbar: boolean;
  nummer?: number;   // K-Nummer (nur Ziffer), 1-basiert über die verfügbaren Zeilen — fehlt, wenn nicht verfügbar
  hinweis?: string;  // Grund für Nichtverfügbarkeit (Papierkorb vs. sonstiger Wegfall)
}

/**
 * Bildet jede Auswahlzeile auf ihren aktuellen Zustand ab, in unveränderter Reihenfolge (10-03,
 * KONV-01). Die Nummerierung folgt exakt der Regel, die der Server beim Zusammenbau anwendet
 * (`packages/server/src/export/anlagenpaket.ts`): sie zählt ausschließlich über die verfügbaren
 * Zeilen, nicht über die Rohliste — sonst zeigt der Dialog andere Nummern als das Artefakt.
 */
export function auswahlZeilen(state: DesktopState, auswahl: AuswahlEintrag[]): AuswahlZeile[] {
  let nummer = 0;
  return auswahl.map((eintrag) => {
    const doc = state.docs.find((d) => d.id === eintrag.docId);
    const verfuegbar = !!doc && effektiveFreigabe(doc, state.layers) === 'export';
    const bezeichnung = eintrag.bezeichnung || doc?.name || eintrag.bezeichnung;
    if (verfuegbar) {
      nummer++;
      return { docId: eintrag.docId, bezeichnung, verfuegbar, nummer };
    }
    const imPapierkorb = (state.trash ?? []).some((t) => t.payload.docs.some((d) => d.id === eintrag.docId));
    const hinweis = imPapierkorb
      ? 'im Papierkorb — wird beim Erzeugen ausgelassen'
      : 'nicht mehr verfügbar — wird beim Erzeugen ausgelassen';
    return { docId: eintrag.docId, bezeichnung, verfuegbar, hinweis };
  });
}

/**
 * Übernimmt einen Stapel als geordnete Auswahl (10-03, KONV-01): läuft `stack.docIds` in
 * Arrayreihenfolge — diese Reihenfolge ist die Leserichtung des Bestands (konvolutPages()) und
 * wird ausdrücklich nicht umgedreht. Eine verwaiste id und ein Dokument ohne effektive Freigabe
 * `export` werden übersprungen, wie `konvolutPages()` verwaiste ids überspringt.
 */
export function auswahlAusStapel(state: DesktopState, stack: Stack): AuswahlEintrag[] {
  const ergebnis: AuswahlEintrag[] = [];
  for (const docId of stack.docIds) {
    const doc = state.docs.find((d) => d.id === docId);
    if (!doc) continue;
    if (effektiveFreigabe(doc, state.layers) !== 'export') continue;
    ergebnis.push({ docId: doc.id, bezeichnung: doc.name });
  }
  return ergebnis;
}

/**
 * Ankreuzungslogik für den Abschnitt „Dubletten & Leerseiten" (KONV-03, 10-05). Ankreuzungen
 * werden über einen zusammengesetzten Schlüssel aus Dokument-id und lokaler Seite geführt
 * (F-16), nicht über den Listenindex — beim Umsortieren oder Entfernen von Zeilen bliebe ein
 * Index sonst auf die falsche Seite zeigen.
 */

/** Kanonischer Seitenschlüssel — an genau dieser Stelle gebildet, überall sonst wiederverwendet. */
export type SeitenSchluessel = string;

export function seitenSchluessel(docId: string, seite: number): SeitenSchluessel {
  return `${docId}#${seite}`;
}

/**
 * Vorbelegung nach einem Prüfergebnis: je Dublettenzeile der Schlüssel der ZWEITEN Fundstelle
 * (die erste bleibt im Paket) — kein einziger Leerseitenschlüssel. Dubletten sind damit
 * vorausgewählt, Leerseiten nicht (Copywriting Contract, Default: Dubletten an, Leerseiten aus).
 */
export function vorbelegteAusschluesse(pruefung: AnlagenpaketPruefung): Set<SeitenSchluessel> {
  return new Set(pruefung.dubletten.map((d) => seitenSchluessel(d.docId, d.lokaleSeite)));
}

/**
 * Verwirft Ankreuzungen zu Seiten, die im neuen Prüfergebnis nicht mehr vorkommen (F-17): eine
 * stehengebliebene Ankreuzung schlösse sonst eine Seite aus, die der Nutzer nie als Dublette
 * oder Leerseite gesehen hat. Behält nur Schlüssel, die im neuen Ergebnis als Dublettenzeile
 * (beide Seiten der Zeile) oder als Leerseite vorkommen.
 */
export function bereinigeAusschluesse(
  ausschluesse: Set<SeitenSchluessel>,
  pruefung: AnlagenpaketPruefung,
): Set<SeitenSchluessel> {
  const gueltig = new Set<SeitenSchluessel>();
  for (const d of pruefung.dubletten) {
    gueltig.add(seitenSchluessel(d.docId, d.lokaleSeite));
    gueltig.add(seitenSchluessel(d.gleichWieDocId, d.gleichWieLokaleSeite));
  }
  for (const l of pruefung.leerseiten) gueltig.add(seitenSchluessel(l.docId, l.lokaleSeite));
  return new Set([...ausschluesse].filter((s) => gueltig.has(s)));
}

/**
 * Zerlegt die Ankreuzungs-Schlüssel wieder in die Form, die der Server erwartet — stabil
 * sortiert nach Dokument-id und Seite, damit zwei gleiche Auswahlen dieselbe Anfrage ergeben.
 */
export function ausschlussListe(ausschluesse: Set<SeitenSchluessel>): { docId: string; seite: number }[] {
  const eintraege = [...ausschluesse].map((schluessel) => {
    const trennstelle = schluessel.lastIndexOf('#');
    return { docId: schluessel.slice(0, trennstelle), seite: Number(schluessel.slice(trennstelle + 1)) };
  });
  eintraege.sort((a, b) => (a.docId === b.docId ? a.seite - b.seite : a.docId < b.docId ? -1 : 1));
  return eintraege;
}
