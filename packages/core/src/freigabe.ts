import type { DesktopState } from './model';
import { findeEbene, type Ebene } from './layers';
import type { Mark } from './marks';
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
 * Schwärzende Markierungen einer Seite — die EINZIGE Ausnahme vom freigabeFilter, und der
 * einzige Weg, auf dem die Exportkette an Schwärzungs-Rects kommen darf.
 *
 * Der Filter oben ist für ADDITIVE Objekte gebaut (Zettel, Stempel, Fähnchen): sie
 * weglassen schützt die Vertraulichkeit, deshalb ist der Default 'intern' fail-CLOSED
 * (D-14). Eine Schwärzung ist das Gegenteil — SUBTRAKTIV: sie weglassen legt den
 * darunterliegenden Text frei. Durch den Filter gereicht war dieselbe Regel damit
 * fail-OPEN, und zwar im Normalfall: eine frisch gezogene Fläche trägt weder `freigabe`
 * noch `layerId` (addMark, marks.ts), fällt also auf 'intern' und verschwand still aus
 * dem Export — der Anwender sah einen schwarzen Balken auf dem Schirm und verschickte
 * eine Datei, in der alles stand.
 *
 * Deshalb: die Freigabe-Stufe einer Schwärzung ist für das ARTEFAKT bedeutungslos, eine
 * Schwärzung wirkt immer. Maßgeblich bleibt allein die Projektion (projectStateForActor):
 * angewendet wird, was der Anfragende auch auf dem Schirm sieht — genau die Flächen, auf
 * deren Wirkung er sich verlässt. Aufrufer übergeben deshalb den PROJIZIERTEN,
 * NICHT freigabe-gefilterten State.
 *
 * `freigabeFilter` bleibt bewusst unverändert: ein Mark führt in `textSnapshot` den
 * überdeckten Klartext (marks.ts) — ein State, der von sich behauptet „alles hierin darf
 * ins Artefakt", darf ihn niemals enthalten. Die Ausnahme gehört an die Stelle, die die
 * Rects zum Löschen braucht, nicht in den generischen Filter.
 */
export function schwaerzendeMarks(state: DesktopState, docId: string, page: number): Mark[] {
  return (state.marks ?? []).filter(
    (m) => m.docId === docId && m.page === page && (m.kind === 'redact' || m.kind === 'tippex'),
  );
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
