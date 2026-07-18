import type { DesktopState, Doc, Stack } from './model';
import type { Note } from './notes';
import type { Cutout } from './cutouts';
import type { Stroke } from './ink';
import type { Mark } from './marks';
import type { Stamp } from './stamps';
import type { Flag } from './flags';
import { findDoc, findStack } from './model';
import { findNote } from './notes';
import { findCutout } from './cutouts';
import { removeDoc, removeStack } from './removal';
import { removeNote } from './notes';
import { removeCutout } from './cutouts';
import { uid } from './uid';

/** Papierkorb: entfernte Objekte liegen IM Korb und sind wiederherstellbar, bis geleert wird. */
export interface TrashPayload {
  docs: Doc[];
  notes: Note[];
  cutouts: Cutout[];
  stacks: Stack[];
  strokes: Stroke[];
  marks: Mark[];
  stamps: Stamp[];
  flags: Flag[];
}

export interface TrashedItem {
  id: string;
  kind: 'doc' | 'note' | 'cutout' | 'stack';
  name: string;        // Anzeigename fürs Korb-Panel
  trashedAt: string;   // ISO-Zeitpunkt, vom Client geliefert
  payload: TrashPayload;
}

function annotationsFor(s: DesktopState, docIds: string[]): Pick<TrashPayload, 'strokes' | 'marks' | 'stamps' | 'flags'> {
  return {
    strokes: (s.strokes ?? []).filter((x) => docIds.includes(x.docId)),
    marks: (s.marks ?? []).filter((x) => docIds.includes(x.docId)),
    stamps: (s.stamps ?? []).filter((x) => docIds.includes(x.docId)),
    flags: (s.flags ?? []).filter((x) => docIds.includes(x.docId)),
  };
}

export function trashObject(s: DesktopState, objectId: string, trashedAt: string, id: string = uid()): DesktopState {
  if (typeof trashedAt !== 'string' || trashedAt === '') throw new Error('Zeitstempel fehlt');
  const leer: TrashPayload = { docs: [], notes: [], cutouts: [], stacks: [], strokes: [], marks: [], stamps: [], flags: [] };
  let item: TrashedItem | null = null;
  let next: DesktopState = s;

  const doc = findDoc(s, objectId);
  const note = findNote(s, objectId);
  const cutout = findCutout(s, objectId);
  const stack = findStack(s, objectId);
  if (doc) {
    item = { id, kind: 'doc', name: doc.name, trashedAt, payload: { ...leer, docs: [doc], ...annotationsFor(s, [doc.id]) } };
    next = removeDoc(s, doc.id);
  } else if (stack) {
    const members = stack.docIds.map((d) => findDoc(s, d)).filter((d): d is Doc => !!d);
    const name = stack.name || `Stapel (${stack.docIds.length})`;
    item = { id, kind: 'stack', name, trashedAt, payload: { ...leer, docs: members, stacks: [stack], ...annotationsFor(s, stack.docIds) } };
    next = removeStack(s, stack.id);
  } else if (note) {
    item = { id, kind: 'note', name: note.text.slice(0, 60) || 'Zettel', trashedAt, payload: { ...leer, notes: [note] } };
    next = removeNote(s, note.id);
  } else if (cutout) {
    item = { id, kind: 'cutout', name: 'Ausschnitt', trashedAt, payload: { ...leer, cutouts: [cutout] } };
    next = removeCutout(s, cutout.id);
  } else {
    throw new Error(`Objekt "${objectId}" nicht gefunden`);
  }
  return { ...next, trash: [...(next.trash ?? []), item] };
}

export function restoreObject(s: DesktopState, trashId: string): DesktopState {
  const item = (s.trash ?? []).find((t) => t.id === trashId);
  if (!item) throw new Error(`Korb-Eintrag "${trashId}" nicht gefunden`);
  const p = item.payload;
  const belegt =
    p.docs.some((d) => s.docs.some((x) => x.id === d.id || x.fileId === d.fileId)) ||
    p.notes.some((n) => (s.notes ?? []).some((x) => x.id === n.id)) ||
    p.cutouts.some((c) => (s.cutouts ?? []).some((x) => x.id === c.id)) ||
    p.stacks.some((st) => s.stacks.some((x) => x.id === st.id));
  if (belegt) throw new Error('Ein Objekt aus diesem Korb-Eintrag liegt bereits wieder auf dem Tisch');
  return {
    ...s,
    docs: [...s.docs, ...p.docs],
    notes: [...(s.notes ?? []), ...p.notes],
    cutouts: [...(s.cutouts ?? []), ...p.cutouts],
    stacks: [...s.stacks, ...p.stacks],
    strokes: [...(s.strokes ?? []), ...p.strokes],
    marks: [...(s.marks ?? []), ...p.marks],
    stamps: [...(s.stamps ?? []), ...p.stamps],
    flags: [...(s.flags ?? []), ...p.flags],
    trash: (s.trash ?? []).filter((t) => t.id !== trashId),
  };
}

export function emptyTrash(s: DesktopState): DesktopState {
  return { ...s, trash: [] };
}

/** fileIds aller Dokumente im Korb — der j-lawyer-Abgleich behandelt sie als vorhanden. */
export function trashedFileIds(s: DesktopState): string[] {
  return (s.trash ?? []).flatMap((t) => t.payload.docs.map((d) => d.fileId));
}
