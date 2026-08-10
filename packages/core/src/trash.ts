import type { DesktopState, Doc, Stack, CommandMeta } from './model';
import type { Note } from './notes';
import type { Cutout } from './cutouts';
import type { Stroke } from './ink';
import type { Mark } from './marks';
import type { Stamp } from './stamps';
import type { Flag } from './flags';
import type { LegalObject } from './legalObjects';
import type { TableCard } from './tables';
import type { ZeitleisteCard } from './zeitleiste';
import { findDoc, findStack } from './model';
import { findNote } from './notes';
import { findCutout } from './cutouts';
import { findLegalObject } from './legalObjects';
import { findTable } from './tables';
import { findZeitleiste } from './zeitleiste';
import { removeDoc, removeStack } from './removal';
import { removeNote } from './notes';
import { removeCutout } from './cutouts';
import { removeLegalObject } from './legalObjects';
import { removeTable } from './tables';
import { removeZeitleiste } from './zeitleiste';
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
  legalObjects: LegalObject[];
  tables: TableCard[];
  zeitleisten: ZeitleisteCard[];
}

export interface TrashedItem {
  id: string;
  kind: 'doc' | 'note' | 'cutout' | 'stack' | 'legalObject' | 'table' | 'zeitleiste';
  name: string;        // Anzeigename fürs Korb-Panel
  trashedAt: string;   // ISO-Zeitpunkt, vom Client geliefert
  payload: TrashPayload;
  trashedBy?: string;  // Provenienz: wer hat entfernt; fehlt in Alt-States (der Papierkorb-Zeitpunkt steckt schon in trashedAt)
}

function annotationsFor(s: DesktopState, docIds: string[]): Pick<TrashPayload, 'strokes' | 'marks' | 'stamps' | 'flags'> {
  return {
    strokes: (s.strokes ?? []).filter((x) => docIds.includes(x.docId)),
    marks: (s.marks ?? []).filter((x) => docIds.includes(x.docId)),
    stamps: (s.stamps ?? []).filter((x) => docIds.includes(x.docId)),
    flags: (s.flags ?? []).filter((x) => docIds.includes(x.docId)),
  };
}

export function trashObject(s: DesktopState, objectId: string, trashedAt: string, id: string = uid(), meta?: CommandMeta): DesktopState {
  if (typeof trashedAt !== 'string' || trashedAt === '') throw new Error('Zeitstempel fehlt');
  const leer: TrashPayload = { docs: [], notes: [], cutouts: [], stacks: [], strokes: [], marks: [], stamps: [], flags: [], legalObjects: [], tables: [], zeitleisten: [] };
  const trashedBy = meta ? { trashedBy: meta.createdBy } : {};
  let item: TrashedItem | null = null;
  let next: DesktopState = s;

  const doc = findDoc(s, objectId);
  const note = findNote(s, objectId);
  const cutout = findCutout(s, objectId);
  const stack = findStack(s, objectId);
  const legalObject = findLegalObject(s, objectId);
  const table = findTable(s, objectId);
  const zeitleiste = findZeitleiste(s, objectId);
  if (doc) {
    item = { id, kind: 'doc', name: doc.name, trashedAt, payload: { ...leer, docs: [doc], ...annotationsFor(s, [doc.id]) }, ...trashedBy };
    next = removeDoc(s, doc.id);
  } else if (stack) {
    const members = stack.docIds.map((d) => findDoc(s, d)).filter((d): d is Doc => !!d);
    const name = stack.name || `Stapel (${stack.docIds.length})`;
    item = { id, kind: 'stack', name, trashedAt, payload: { ...leer, docs: members, stacks: [stack], ...annotationsFor(s, stack.docIds) }, ...trashedBy };
    next = removeStack(s, stack.id);
  } else if (note) {
    item = { id, kind: 'note', name: note.text.slice(0, 60) || 'Zettel', trashedAt, payload: { ...leer, notes: [note] }, ...trashedBy };
    next = removeNote(s, note.id);
  } else if (cutout) {
    item = { id, kind: 'cutout', name: 'Ausschnitt', trashedAt, payload: { ...leer, cutouts: [cutout] }, ...trashedBy };
    next = removeCutout(s, cutout.id);
  } else if (legalObject) {
    item = { id, kind: 'legalObject', name: legalObject.text.slice(0, 60) || 'Juristisches Objekt', trashedAt, payload: { ...leer, legalObjects: [legalObject] }, ...trashedBy };
    next = removeLegalObject(s, legalObject.id);
  } else if (table) {
    item = { id, kind: 'table', name: table.titel || 'Tabelle', trashedAt, payload: { ...leer, tables: [table] }, ...trashedBy };
    next = removeTable(s, table.id);
  } else if (zeitleiste) {
    item = { id, kind: 'zeitleiste', name: zeitleiste.titel || 'Zeitleiste', trashedAt, payload: { ...leer, zeitleisten: [zeitleiste] }, ...trashedBy };
    next = removeZeitleiste(s, zeitleiste.id);
  } else {
    throw new Error(`Objekt "${objectId}" nicht gefunden`);
  }
  return { ...next, trash: [...(next.trash ?? []), item] };
}

export function restoreObject(s: DesktopState, trashId: string): DesktopState {
  const item = (s.trash ?? []).find((t) => t.id === trashId);
  if (!item) throw new Error(`Korb-Eintrag "${trashId}" nicht gefunden`);
  const p = item.payload;
  // fileId-Duplikate sind seit dem Kopierer legitim (copyObject teilt sich die fileId der Quelle) —
  // nur die Objekt-Identität (doc-ID) zählt als Kollision. Der j-lawyer-Abgleich prüft ohnehin
  // separat über trashedFileIds, daher ist der fileId-Vergleich hier nicht mehr nötig.
  const belegt =
    p.docs.some((d) => s.docs.some((x) => x.id === d.id)) ||
    p.notes.some((n) => (s.notes ?? []).some((x) => x.id === n.id)) ||
    p.cutouts.some((c) => (s.cutouts ?? []).some((x) => x.id === c.id)) ||
    p.stacks.some((st) => s.stacks.some((x) => x.id === st.id)) ||
    p.legalObjects.some((o) => (s.legalObjects ?? []).some((x) => x.id === o.id)) ||
    p.tables.some((t) => (s.tables ?? []).some((x) => x.id === t.id)) ||
    (p.zeitleisten ?? []).some((z) => (s.zeitleisten ?? []).some((x) => x.id === z.id));
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
    legalObjects: [...(s.legalObjects ?? []), ...p.legalObjects],
    tables: [...(s.tables ?? []), ...p.tables],
    zeitleisten: [...(s.zeitleisten ?? []), ...(p.zeitleisten ?? [])],
    trash: (s.trash ?? []).filter((t) => t.id !== trashId),
  };
}

export function emptyTrash(s: DesktopState): DesktopState {
  return { ...s, trash: [] };
}

/** Schredder: entfernt genau einen Korb-Eintrag endgültig (kein Wiederherstellen mehr). */
export function shredTrashItem(s: DesktopState, trashId: string): DesktopState {
  if (!(s.trash ?? []).some((t) => t.id === trashId)) throw new Error(`Korb-Eintrag "${trashId}" nicht gefunden`);
  return { ...s, trash: (s.trash ?? []).filter((t) => t.id !== trashId) };
}

/** fileIds aller Dokumente im Korb — der j-lawyer-Abgleich behandelt sie als vorhanden. */
export function trashedFileIds(s: DesktopState): string[] {
  return (s.trash ?? []).flatMap((t) => t.payload.docs.map((d) => d.fileId));
}
