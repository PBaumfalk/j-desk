import { type DesktopState, type Vec2 } from './model';
import { removeLinksFor } from './links';
import type { Box } from './viewport';
import { uid } from './uid';

/** Gedankenobjekte der Vision: ein Notizzettel trägt optional eine Denk-Rolle. */
export const NOTE_KINDS = ['notiz', 'frage', 'these', 'angriffspunkt', 'risiko'] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

export interface Note {
  id: string;
  kind: NoteKind;
  text: string;
  position: Vec2;    // Weltkoordinaten, linke obere Ecke
  zIndex: number;
}

export const NOTE_W = 170;
export const NOTE_H = 130;

function maxZ(s: DesktopState): number {
  return Math.max(
    0,
    ...s.docs.map((d) => d.zIndex),
    ...s.stacks.map((st) => st.zIndex),
    ...(s.notes ?? []).map((n) => n.zIndex),
    ...(s.cutouts ?? []).map((c) => c.zIndex),
  );
}

function mapNote(s: DesktopState, id: string, fn: (n: Note) => Note): DesktopState {
  const notes = s.notes ?? [];
  if (!notes.some((n) => n.id === id)) throw new Error(`Notizzettel "${id}" nicht gefunden`);
  return { ...s, notes: notes.map((n) => (n.id === id ? fn(n) : n)) };
}

export function addNote(
  s: DesktopState,
  kind: NoteKind,
  text: string,
  position: Vec2,
  id: string = uid(),
): DesktopState {
  if (!NOTE_KINDS.includes(kind)) throw new Error(`Unbekannter Zettel-Typ: ${String(kind)}`);
  const note: Note = { id, kind, text, position, zIndex: maxZ(s) + 1 };
  return { ...s, notes: [...(s.notes ?? []), note] };
}

export function editNote(s: DesktopState, id: string, text: string): DesktopState {
  return mapNote(s, id, (n) => ({ ...n, text }));
}

export function moveNote(s: DesktopState, id: string, position: Vec2): DesktopState {
  return mapNote(s, id, (n) => ({ ...n, position }));
}

export function removeNote(s: DesktopState, id: string): DesktopState {
  const notes = s.notes ?? [];
  if (!notes.some((n) => n.id === id)) throw new Error(`Notizzettel "${id}" nicht gefunden`);
  const next = removeLinksFor(s, id);
  return { ...next, notes: notes.filter((n) => n.id !== id) };
}

export function findNote(s: DesktopState, id: string): Note | undefined {
  return (s.notes ?? []).find((n) => n.id === id);
}

export function noteBox(n: Note): Box {
  return { x: n.position.x, y: n.position.y, w: NOTE_W, h: NOTE_H };
}
