import { findDoc, type DesktopState } from './model';
import { findNote } from './notes';
import { findCutout } from './cutouts';
import { rotationFor } from './documents';
import { uid } from './uid';

const OFFSET = { x: 28, y: 20 };

function maxZ(s: DesktopState): number {
  return Math.max(
    0,
    ...s.docs.map((d) => d.zIndex),
    ...s.stacks.map((st) => st.zIndex),
    ...(s.notes ?? []).map((n) => n.zIndex),
    ...(s.cutouts ?? []).map((c) => c.zIndex),
  );
}

/**
 * Kopierer: dupliziert Karte, Seitenkarte, Zettel oder Ausschnitt inkl. Annotationen.
 * Gleiche Datei-Referenz, keine Datei-Duplizierung, kein j-lawyer-Schreibvorgang.
 */
export function copyObject(s: DesktopState, objectId: string): DesktopState {
  const doc = findDoc(s, objectId);
  if (doc) {
    const neueId = uid();
    const { open: _o, openSize: _os, taped: _t, ...rest } = doc;
    const kopie = {
      ...rest,
      id: neueId,
      position: { x: doc.position.x + OFFSET.x, y: doc.position.y + OFFSET.y },
      rotation: rotationFor(neueId),
      zIndex: maxZ(s) + 1,
    };
    return {
      ...s,
      docs: [...s.docs, kopie],
      strokes: [...(s.strokes ?? []), ...(s.strokes ?? []).filter((x) => x.docId === doc.id).map((x) => ({ ...x, id: uid(), docId: neueId }))],
      marks: [...(s.marks ?? []), ...(s.marks ?? []).filter((x) => x.docId === doc.id).map((x) => ({ ...x, id: uid(), docId: neueId }))],
      stamps: [...(s.stamps ?? []), ...(s.stamps ?? []).filter((x) => x.docId === doc.id).map((x) => ({ ...x, id: uid(), docId: neueId }))],
      flags: [...(s.flags ?? []), ...(s.flags ?? []).filter((x) => x.docId === doc.id).map((x) => ({ ...x, id: uid(), docId: neueId }))],
    };
  }
  const note = findNote(s, objectId);
  if (note) {
    const { taped: _t, ...rest } = note;
    const kopie = { ...rest, id: uid(), position: { x: note.position.x + OFFSET.x, y: note.position.y + OFFSET.y }, zIndex: maxZ(s) + 1 };
    return { ...s, notes: [...(s.notes ?? []), kopie] };
  }
  const cutout = findCutout(s, objectId);
  if (cutout) {
    const { taped: _t, ...rest } = cutout;
    const kopie = { ...rest, id: uid(), position: { x: cutout.position.x + OFFSET.x, y: cutout.position.y + OFFSET.y }, zIndex: maxZ(s) + 1 };
    return { ...s, cutouts: [...(s.cutouts ?? []), kopie] };
  }
  if (s.stacks.some((st) => st.id === objectId)) throw new Error('Stapel lassen sich nicht kopieren');
  throw new Error(`Objekt "${objectId}" nicht gefunden`);
}
