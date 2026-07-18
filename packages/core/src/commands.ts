import type { DesktopState, Vec2, Size } from './model';
import { addDoc, moveDoc, bringToFront } from './documents';
import { addLink, setLinkNote, removeLink } from './links';
import { stackDocs, removeFromStack, dissolveStack, renameStack, moveStack } from './stacks';
import { removeDoc, removeStack } from './removal';
import { expandDoc, collapseDoc, setDocPage, resizeDoc, extractPage } from './viewer';
import { addStroke, removeStroke, type Stroke, type StrokeTool } from './ink';
import { addNote, editNote, moveNote, removeNote, type NoteKind } from './notes';
import { addCutout, moveCutout, removeCutout } from './cutouts';
import { addMark, removeMark, type Mark, type MarkKind } from './marks';
import { addStamp, removeStamp, type Stamp } from './stamps';
import { addFlag, removeFlag, type Flag } from './flags';
import { addClip, removeClip } from './clips';
import { setTaped } from './tape';

export class CommandError extends Error {}

export interface Command {
  type: string;
  payload?: Record<string, unknown>;
}

function id(v: unknown, field: string): string {
  if (typeof v !== 'string' || v === '') throw new CommandError(`Feld "${field}" fehlt oder ist leer`);
  return v;
}

function optId(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function text(v: unknown, field: string): string {
  if (typeof v !== 'string') throw new CommandError(`Feld "${field}" fehlt oder ist kein Text`);
  return v;
}

function vec(v: unknown, field: string): Vec2 {
  const p = v as Vec2 | undefined;
  if (!p || typeof p !== 'object' || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
    throw new CommandError(`Feld "${field}" fehlt oder ist keine Position {x, y}`);
  }
  return { x: p.x, y: p.y };
}

function num(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new CommandError(`Feld "${field}" fehlt oder ist keine Zahl`);
  return v;
}

function size(v: unknown, field: string): Size {
  const p = v as Size | undefined;
  if (!p || typeof p !== 'object' || !Number.isFinite(p.w) || !Number.isFinite(p.h)) {
    throw new CommandError(`Feld "${field}" fehlt oder ist keine Größe {w, h}`);
  }
  return { w: p.w, h: p.h };
}

function wrap(fn: () => DesktopState): DesktopState {
  try {
    return fn();
  } catch (e) {
    if (e instanceof CommandError) throw e;
    throw new CommandError(e instanceof Error ? e.message : 'Ungültige Aktion');
  }
}

const handlers: Record<string, (s: DesktopState, p: Record<string, unknown>) => DesktopState> = {
  addDoc: (s, p) => addDoc(s, id(p.fileId, 'fileId'), text(p.name, 'name'), vec(p.position, 'position'), optId(p.id)),
  moveDoc: (s, p) => moveDoc(s, id(p.id, 'id'), vec(p.position, 'position')),
  bringToFront: (s, p) => bringToFront(s, id(p.id, 'id')),
  removeDoc: (s, p) => removeDoc(s, id(p.id, 'id')),
  addLink: (s, p) => addLink(s, id(p.fromId, 'fromId'), id(p.toId, 'toId'), optId(p.id)),
  setLinkNote: (s, p) => setLinkNote(s, id(p.linkId, 'linkId'), text(p.note, 'note')),
  removeLink: (s, p) => removeLink(s, id(p.linkId, 'linkId')),
  stackDocs: (s, p) => stackDocs(s, id(p.draggedId, 'draggedId'), id(p.targetId, 'targetId'), optId(p.id)),
  removeFromStack: (s, p) => removeFromStack(s, id(p.docId, 'docId'), vec(p.position, 'position')),
  dissolveStack: (s, p) => dissolveStack(s, id(p.stackId, 'stackId')),
  renameStack: (s, p) => renameStack(s, id(p.stackId, 'stackId'), text(p.name, 'name')),
  moveStack: (s, p) => moveStack(s, id(p.stackId, 'stackId'), vec(p.position, 'position')),
  removeStack: (s, p) => removeStack(s, id(p.stackId, 'stackId')),
  expandDoc: (s, p) => wrap(() => expandDoc(s, id(p.id, 'id'))),
  collapseDoc: (s, p) => wrap(() => collapseDoc(s, id(p.id, 'id'))),
  setDocPage: (s, p) => wrap(() => setDocPage(s, id(p.id, 'id'), num(p.page, 'page'))),
  resizeDoc: (s, p) => wrap(() => resizeDoc(s, id(p.id, 'id'), size(p.size, 'size'))),
  extractPage: (s, p) => wrap(() => extractPage(s, id(p.docId, 'docId'), num(p.page, 'page'), vec(p.position, 'position'), optId(p.id))),
  addStroke: (s, p) => wrap(() => addStroke(s, strokePayload(p.stroke))),
  removeStroke: (s, p) => wrap(() => removeStroke(s, id(p.strokeId, 'strokeId'))),
  addNote: (s, p) => wrap(() => addNote(s, p.kind as NoteKind, text(p.text, 'text'), vec(p.position, 'position'), optId(p.id))),
  editNote: (s, p) => wrap(() => editNote(s, id(p.id, 'id'), text(p.text, 'text'))),
  moveNote: (s, p) => wrap(() => moveNote(s, id(p.id, 'id'), vec(p.position, 'position'))),
  removeNote: (s, p) => wrap(() => removeNote(s, id(p.id, 'id'))),
  addCutout: (s, p) => wrap(() => addCutout(s, id(p.docId, 'docId'), num(p.page, 'page'), rect(p.rect), vec(p.position, 'position'), optId(p.id))),
  moveCutout: (s, p) => wrap(() => moveCutout(s, id(p.id, 'id'), vec(p.position, 'position'))),
  removeCutout: (s, p) => wrap(() => removeCutout(s, id(p.id, 'id'))),
  addMark: (s, p) => wrap(() => addMark(s, markPayload(p.mark))),
  removeMark: (s, p) => wrap(() => removeMark(s, id(p.markId, 'markId'))),
  addStamp: (s, p) => wrap(() => addStamp(s, stampPayload(p.stamp))),
  removeStamp: (s, p) => wrap(() => removeStamp(s, id(p.stampId, 'stampId'))),
  addFlag: (s, p) => wrap(() => addFlag(s, flagPayload(p.flag))),
  removeFlag: (s, p) => wrap(() => removeFlag(s, id(p.flagId, 'flagId'))),
  addClip: (s, p) => wrap(() => addClip(s, id(p.aId, 'aId'), id(p.bId, 'bId'), optId(p.id))),
  removeClip: (s, p) => wrap(() => removeClip(s, id(p.clipId, 'clipId'))),
  tapeObject: (s, p) => wrap(() => setTaped(s, id(p.id, 'id'), true)),
  untapeObject: (s, p) => wrap(() => setTaped(s, id(p.id, 'id'), false)),
};

function rect(v: unknown): { x: number; y: number; w: number; h: number } {
  const r = v as { x: number; y: number; w: number; h: number } | undefined;
  if (!r || typeof r !== 'object' || !Number.isFinite(r.x) || !Number.isFinite(r.y) || !Number.isFinite(r.w) || !Number.isFinite(r.h)) {
    throw new CommandError('Feld "rect" fehlt oder ist kein Rechteck {x, y, w, h}');
  }
  return { x: r.x, y: r.y, w: r.w, h: r.h };
}

function strokePayload(v: unknown): Omit<Stroke, 'id'> & { id?: string } {
  const st = v as Partial<Stroke> | undefined;
  if (!st || typeof st !== 'object') throw new CommandError('Feld "stroke" fehlt');
  if (!Array.isArray(st.points)) throw new CommandError('Feld "stroke.points" fehlt');
  return {
    ...(typeof st.id === 'string' && st.id !== '' ? { id: st.id } : {}),
    docId: id(st.docId, 'stroke.docId'),
    page: num(st.page, 'stroke.page'),
    tool: st.tool as StrokeTool,
    color: text(st.color, 'stroke.color'),
    width: num(st.width, 'stroke.width'),
    points: st.points.map((p, i) => vec(p, `stroke.points[${i}]`)),
  };
}

function markPayload(v: unknown): Omit<Mark, 'id'> & { id?: string } {
  const m = v as Partial<Mark> | undefined;
  if (!m || typeof m !== 'object') throw new CommandError('Feld "mark" fehlt');
  return {
    ...(typeof m.id === 'string' && m.id !== '' ? { id: m.id } : {}),
    docId: id(m.docId, 'mark.docId'),
    page: num(m.page, 'mark.page'),
    rect: rect(m.rect),
    kind: m.kind as MarkKind,
  };
}

function stampPayload(v: unknown): Omit<Stamp, 'id'> & { id?: string } {
  const st = v as Partial<Stamp> | undefined;
  if (!st || typeof st !== 'object') throw new CommandError('Feld "stamp" fehlt');
  return {
    ...(typeof st.id === 'string' && st.id !== '' ? { id: st.id } : {}),
    docId: id(st.docId, 'stamp.docId'),
    page: num(st.page, 'stamp.page'),
    x: num(st.x, 'stamp.x'),
    y: num(st.y, 'stamp.y'),
    angle: num(st.angle, 'stamp.angle'),
    text: text(st.text, 'stamp.text'),
    color: st.color as Stamp['color'],
    ...(st.date !== undefined ? { date: text(st.date, 'stamp.date') } : {}),
    baseW: num(st.baseW, 'stamp.baseW'),
    baseH: num(st.baseH, 'stamp.baseH'),
  };
}

function flagPayload(v: unknown): Omit<Flag, 'id'> & { id?: string } {
  const f = v as Partial<Flag> | undefined;
  if (!f || typeof f !== 'object') throw new CommandError('Feld "flag" fehlt');
  return {
    ...(typeof f.id === 'string' && f.id !== '' ? { id: f.id } : {}),
    docId: id(f.docId, 'flag.docId'),
    page: num(f.page, 'flag.page'),
    offset: num(f.offset, 'flag.offset'),
    color: text(f.color, 'flag.color'),
    ...(f.label !== undefined ? { label: text(f.label, 'flag.label') } : {}),
  };
}

export function applyCommand(state: DesktopState, cmd: Command): DesktopState {
  const handler = handlers[cmd.type];
  if (!handler) throw new CommandError(`Unbekanntes Kommando: ${String(cmd.type)}`);
  return handler(state, cmd.payload ?? {});
}
