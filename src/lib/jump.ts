import { findCutout, stackOf, trashedFileIds, type BelegRef, type Cutout, type DesktopState, type Doc, type Flag, type Mark, type Stamp, type TaskDocRef } from '@j-desk/core';
import type { Box, Viewport } from '@j-desk/core';
import { aufzeichnen, labelFuer, type VerlaufEintrag } from './verlauf';
import { ui } from './ui.svelte';

/**
 * Sprungziel: eine Fundstelle im Originaldokument. Die beiden Anker sind fachlich
 * verschieden und dürfen nicht vermischt werden:
 * - `fileId`: Ausschnitte. Überlebt das Entfernen der Karte — die Quelle kann neu
 *   auf den Tisch geholt werden (`art: 'anlegen'`).
 * - `docId`: Markierungen, Schwärzungen, Stempel, Fahnen. Diese Objekte leben an der
 *   Karte; ist sie fort, ist das Objekt fort (`art: 'weg'`) — aus einer docId lässt
 *   sich keine Datei rekonstruieren.
 */
export interface Fundstelle {
  fileId?: string;
  docId?: string;
  page: number;
  /** Fehlt bei Objekten ohne Fläche (z. B. Fahnen): dann wird nur die Seite angesprungen. */
  rect?: Box;
  /** Unterschied zu `rect === undefined` (Fahne: keine Fläche, keine Hervorhebung möglich):
   *  hier FEHLEN nur die Wortkoordinaten (PDF-Text-/OCR-Treffer, FTS5 liefert keine Position),
   *  aber die Seite SELBST ist die Fundstelle — die ganze sichtbare Seite pulst statt eines
   *  Wortausschnitts (SourceHighlight.svelte bildet das Rechteck aus der Basis-Seitengröße). */
  ganzeSeite?: true;
  /** Nur für den Fall 'anlegen': Tischposition, neben der die neue Karte erscheinen soll. */
  ankerPosition?: { x: number; y: number };
}

export type SprungPlan =
  | { art: 'springen'; doc: Doc; brauchtExpand: boolean; brauchtPage: boolean }
  | { art: 'papierkorb' }
  | { art: 'stapel'; stackName: string }
  | { art: 'anlegen' }
  | { art: 'weg' };

/** Stempel haben nur einen Mittelpunkt — für die Hervorhebung wird ein Rechteck darum gelegt. */
export function STEMPEL_SPRUNG_RECT(x: number, y: number): Box {
  const w = 160;
  const h = 56;
  return { x: x - w / 2, y: y - h / 2, w, h };
}

/** Bequemer Weg vom Ausschnitt zur Fundstelle (der fileId-Anker bleibt erhalten). */
export function fundstelleAusCutout(c: Cutout): Fundstelle {
  return { fileId: c.fileId, page: c.page, rect: c.rect, ankerPosition: c.position };
}

/** Markierung/Schwärzung -> Fundstelle: lebt an der Karte, also docId-Anker (kein fileId). */
export function fundstelleAusMark(m: Mark): Fundstelle {
  return { docId: m.docId, page: m.page, rect: m.rect };
}

/** Stempel hat nur einen Mittelpunkt (x/y) — das Sprung-Rechteck wird darum gelegt. */
export function fundstelleAusStamp(s: Stamp): Fundstelle {
  return { docId: s.docId, page: s.page, rect: STEMPEL_SPRUNG_RECT(s.x, s.y) };
}

/** Fahne hat keine Fläche — planeSprung springt in diesem Fall nur die Seite an. */
export function fundstelleAusFlag(f: Flag): Fundstelle {
  return { docId: f.docId, page: f.page };
}

/** Gemeinsame Form für PDF-Text-/OCR-Treffer (SucheTreffer, packages/server/src/search/searchQuery.ts):
 *  docId-Anker, wenn vorhanden, sonst fileId-Anker — dieselbe Ankerunterscheidung wie der Rest
 *  der fundstelleAus*-Familie (Kopfkommentar dieser Datei). */
function fundstelleAusVolltextTreffer(t: { docId?: string; fileId?: string; page: number }): Fundstelle {
  return t.docId !== undefined
    ? { docId: t.docId, page: t.page, ganzeSeite: true }
    : { fileId: t.fileId, page: t.page, ganzeSeite: true };
}

/** PDF-Text-Treffer -> Fundstelle: keine Wortkoordinaten bekannt (FTS5 liefert nur Text), aber
 *  die ganze Seite IST die Fundstelle — anders als bei einer Fahne (keine Fläche, kein Highlight). */
export function fundstelleAusPdfTreffer(t: { docId?: string; fileId?: string; page: number }): Fundstelle {
  return fundstelleAusVolltextTreffer(t);
}

/** OCR-Treffer -> Fundstelle: fachlich identische Form wie fundstelleAusPdfTreffer, aber eine
 *  eigene Funktion — 07-06 erweitert genau diesen Fall um die Unsicherheits-Kennzeichnung, ohne
 *  den PDF-Text-Fall anzufassen. */
export function fundstelleAusOcrTreffer(t: { docId?: string; fileId?: string; page: number }): Fundstelle {
  return fundstelleAusVolltextTreffer(t);
}

/** Bezug einer Aufgabe zu Dokument/Fundstelle (TASK-01) -> Fundstelle: cutoutId bevorzugt (der
 *  Ausschnitt trägt bereits seinen eigenen fileId-Anker und überlebt das Entfernen der
 *  Quellkarte), sonst der docId-Anker mit der gespeicherten Seite — derselbe Bestandsmechanismus
 *  wie jede andere Fundstelle in dieser Datei, kein zweiter Sprungweg. */
export function fundstelleAusTaskDocRef(state: DesktopState, docRef: TaskDocRef): Fundstelle {
  if (docRef.cutoutId) {
    const c = findCutout(state, docRef.cutoutId);
    if (c) return fundstelleAusCutout(c);
  }
  return { docId: docRef.docId, page: docRef.page ?? 1 };
}

/** Beleg-Bezug einer Tabellenzeile (CALC-01, 08-07) -> Fundstelle: strukturgleich zu
 *  fundstelleAusTaskDocRef (TASK-01) — cutoutId bevorzugt, sonst der docId-Anker mit der
 *  gespeicherten Seite. Eigene Funktion statt Wiederverwendung, weil BelegRef und TaskDocRef
 *  fachlich getrennte Bezugsarten sind (tables.ts-Kopfkommentar „eigenständig benannt"). */
export function fundstelleAusBelegRef(state: DesktopState, belegRef: BelegRef): Fundstelle {
  if (belegRef.cutoutId) {
    const c = findCutout(state, belegRef.cutoutId);
    if (c) return fundstelleAusCutout(c);
  }
  return { docId: belegRef.docId, page: belegRef.page ?? 1 };
}

export function planeSprung(state: DesktopState, ziel: Fundstelle): SprungPlan {
  const doc = ziel.fileId !== undefined
    ? state.docs.find((d) => d.fileId === ziel.fileId)
    : ziel.docId !== undefined
      ? state.docs.find((d) => d.id === ziel.docId)
      : undefined;

  if (doc) {
    // Doc bleibt in state.docs, auch wenn es in einem Stapel steckt (kein eigener freier
    // Viewer) — expandDoc/Zentrieren würden dann ins Leere laufen. Erst hier auf den
    // Stapel-Fall prüfen, sonst würde jeder gestapelte Fund fälschlich als "springen" gelten.
    const stack = stackOf(state, doc.id);
    if (stack) return { art: 'stapel', stackName: stack.name || `Stapel (${stack.docIds.length})` };
    return {
      art: 'springen',
      doc,
      brauchtExpand: !doc.open,
      brauchtPage: (doc.page ?? 1) !== ziel.page,
    };
  }

  // Ab hier: kein Dokument auf dem Tisch. Beide Anker können im Papierkorb liegen, werden
  // dort aber unterschiedlich gefunden: trashedFileIds() sammelt die fileIds der Karten,
  // der docId-Weg vergleicht die Doc-ids in payload.docs (siehe packages/core/src/trash.ts).
  if (ziel.fileId !== undefined) {
    if (trashedFileIds(state).includes(ziel.fileId)) return { art: 'papierkorb' };
    // Nur der fileId-Anker kann die Quelle neu auf den Tisch holen.
    return { art: 'anlegen' };
  }

  if (ziel.docId !== undefined) {
    const imKorb = (state.trash ?? []).some((t) => t.payload.docs.some((d) => d.id === ziel.docId));
    if (imKorb) return { art: 'papierkorb' };
  }
  return { art: 'weg' };
}

/**
 * Zeichnet einen erfolgreichen Fundstellen-Sprung im Positions-Verlauf auf (UX-03, 13-05 Task 1).
 * Wird an der Sprung-AUSFÜHRUNGSSTELLE gerufen (Desktop.svelte, im $effect auf ui.jumpRequest —
 * NACH springeZuBox(), die den finalen `vp` berechnet) — niemals bei freiem Pannen/Zoomen
 * (Lärm-Regel auch im Verlauf) und niemals bei abgebrochenen Sprüngen (Papierkorb/weg/Stapel),
 * weil dieser Pfad nur nach `plan.art === 'springen'` erreicht wird. `vp` kommt vom Aufrufer, weil
 * weder jump.ts noch store.svelte.ts die Bildschirmgröße kennen, die springeZuBox() zur
 * Zentrierung braucht (component-lokaler Zustand in Desktop.svelte).
 */
export function zeichneFundstelleAuf(vp: Viewport, dokumentName: string, seite: number): void {
  const eintrag: VerlaufEintrag = {
    vp,
    ausloeser: 'fundstelle',
    label: labelFuer({ ausloeser: 'fundstelle', dokument: dokumentName, seite }),
  };
  ui.verlauf = aufzeichnen(ui.verlauf, eintrag);
}
