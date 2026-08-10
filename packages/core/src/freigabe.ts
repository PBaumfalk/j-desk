import type { DesktopState } from './model';
import { findeEbene, type Ebene } from './layers';
import { findeObjekt, VERSIONIERTE_ARTEN } from './stempel';
import type { TrashedItem } from './trash';

/**
 * Freigabe-Stufe eines Objekts für die Export- & Übergabeschicht (EXP-03, D-05):
 * 'intern' (nie im Export), 'mandant' (sichtbar für externe Gäste in der Projektion,
 * aber NICHT im Export, D-06), 'export' (darf in Übergabe-Artefakte).
 */
export type Freigabe = 'intern' | 'mandant' | 'export';
export const ALLE_FREIGABEN: readonly Freigabe[] = ['intern', 'mandant', 'export'];

/**
 * Effektive Freigabe eines Objekts (EXP-03, D-05): der Override am Objekt (`freigabe`)
 * gewinnt immer; ohne Override entscheidet die Ebene — `exportierbar`-Typ ODER
 * `exportierbar`-Flag ⇒ 'export', alles andere ⇒ 'intern'.
 *
 * Bewusst FAIL-CLOSED (D-14), im bewussten Gegensatz zu istObjektSichtbarFuer
 * (layers.ts): dort bleibt eine unbekannte oder fehlende layerId sichtbar
 * (Bestandsschutz — kein stilles Verschwinden vorhandener Inhalte aus der
 * Arbeitsansicht); hier führt dieselbe Lage zu 'intern', weil ein Irrtum in
 * Export-Richtung Vertraulichkeit kostet, ein Irrtum in intern-Richtung nur eine
 * fehlende Seite im Artefakt (vom Nutzer bemerkbar und korrigierbar).
 * Vertraulichkeit schlägt Vollständigkeit.
 */
export function effektiveFreigabe(objekt: { freigabe?: Freigabe; layerId?: string }, layers?: Ebene[]): Freigabe {
  if (objekt.freigabe !== undefined) return objekt.freigabe;
  const ebene = objekt.layerId !== undefined ? findeEbene(objekt.layerId, layers) : undefined;
  if (ebene && (ebene.exportierbar === true || ebene.typ === 'exportierbar')) return 'export';
  return 'intern';
}

/**
 * Lautloser Export-Filter (EXP-03, D-08): entfernt alle Objekte mit effektiver Stufe ≠
 * 'export' aus allen VERSIONIERTE_ARTEN — kein Platzhalter, kein Zählhinweis, kein Log
 * im Artefakt (Existenz-Leck-Verbot). Iteriert nach dem projectStateForActor-Muster
 * (projection.ts) über VERSIONIERTE_ARTEN, damit keine ebenenfähige Objektart vergessen
 * werden kann. Papierkorb-Einträge tragen Vollkopien entfernter Objekte und bleiben nur,
 * wenn ihre GESAMTE Payload freigegeben ist (gleiche Regel wie die Korb-Projektion,
 * CR-02). Das layers-Array wird unverändert durchgereicht; bei nichts zu filtern bleibt
 * der State-Bezug unverändert (geaendert-Konvention).
 *
 * Reihenfolge in der Exportkette: projectStateForActor VOR freigabeFilter (erst
 * rollengerechte Sicht, dann Freigabe) — begründet in pdfExport.ts.
 */
export function freigabeFilter(state: DesktopState): DesktopState {
  const ergebnis = { ...state } as unknown as Record<string, unknown>;
  let geaendert = false;

  for (const art of VERSIONIERTE_ARTEN) {
    const liste = (state as unknown as Record<string, { freigabe?: Freigabe; layerId?: string }[] | undefined>)[art];
    if (!liste) continue;

    const gefiltert = liste.filter((obj) => effektiveFreigabe(obj, state.layers) === 'export');

    if (gefiltert.length !== liste.length) {
      ergebnis[art] = gefiltert;
      geaendert = true;
    }
  }

  const korb = state.trash;
  if (korb && korb.length > 0) {
    const gefiltert = korb.filter((t: TrashedItem) =>
      Object.values(t.payload).every((liste: { freigabe?: Freigabe; layerId?: string }[]) =>
        liste.every((o) => effektiveFreigabe(o, state.layers) === 'export')));
    if (gefiltert.length !== korb.length) {
      ergebnis.trash = gefiltert;
      geaendert = true;
    }
  }

  return geaendert ? (ergebnis as unknown as DesktopState) : state;
}

/**
 * Setzt den Freigabe-Override eines Objekts (EXP-03, D-05) — reine State-Transformation
 * in changeLayerId-Form (layers.ts): die Rechteprüfung (darf DIESER Actor DIESES Objekt
 * umstufen) passiert bewusst NICHT hier, sondern serverseitig im Command-Guard (app.ts,
 * Kommentator-Eigenregel + Privat-Ebenen-Schutz über zielObjektIdsFuerCommand). Ein
 * unbekanntes Objekt wirft (kein stiller No-Op).
 */
export function setFreigabeIn(state: DesktopState, objectId: string, stufe: Freigabe): DesktopState {
  const treffer = findeObjekt(state, objectId);
  if (!treffer) throw new Error(`Unbekanntes Objekt: ${objectId}`);
  const { art } = treffer;
  const liste = (state as unknown as Record<string, { id: string; freigabe?: Freigabe }[]>)[art];
  const neueListe = liste.map((o) => (o.id === objectId ? { ...o, freigabe: stufe } : o));
  return { ...state, [art]: neueListe } as DesktopState;
}
