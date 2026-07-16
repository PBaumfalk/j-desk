import type { DesktopState, Vec2 } from './model';
import { addDoc, moveDoc, bringToFront } from './documents';
import { addLink, setLinkNote, removeLink } from './links';
import { stackDocs, removeFromStack, dissolveStack, renameStack, moveStack } from './stacks';
import { removeDoc, removeStack } from './removal';

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
};

export function applyCommand(state: DesktopState, cmd: Command): DesktopState {
  const handler = handlers[cmd.type];
  if (!handler) throw new CommandError(`Unbekanntes Kommando: ${String(cmd.type)}`);
  return handler(state, cmd.payload ?? {});
}
