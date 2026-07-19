import { type DesktopState, type Vec2 } from './model';
import { removeLinksFor } from './links';
import { removeFromClips } from './clips';
import type { Box } from './viewport';
import { uid } from './uid';

/** Gedankenobjekte der Vision: ein Notizzettel trägt optional eine Denk-Rolle. */
export const NOTE_KINDS = [
  'notiz', 'frage', 'these', 'angriffspunkt', 'risiko',
  'behauptung', 'beweisziel', 'idee', 'todo', 'argument', 'rechtsfrage', 'eigen',
] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

export const NOTE_BADGE_MAX = 24;

export interface Note {
  id: string;
  kind: NoteKind;
  text: string;
  position: Vec2;    // Weltkoordinaten, linke obere Ecke
  zIndex: number;
  taped?: boolean;   // Klebeband: am Tisch festgeklebt, Drag gesperrt
  customLabel?: string; // nur bei kind 'eigen': frei benanntes Badge
  done?: boolean;       // nur bei kind 'todo': abgehakt
}

export const NOTE_W = 170;
export const NOTE_H = 130;

export function maxZ(s: DesktopState): number {
  return Math.max(
    0,
    ...s.docs.map((d) => d.zIndex),
    ...s.stacks.map((st) => st.zIndex),
    ...(s.notes ?? []).map((n) => n.zIndex),
    ...(s.cutouts ?? []).map((c) => c.zIndex),
  );
}

export function mapNote(s: DesktopState, id: string, fn: (n: Note) => Note): DesktopState {
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
  customLabel?: string,
): DesktopState {
  if (!NOTE_KINDS.includes(kind)) throw new Error(`Unbekannter Zettel-Typ: ${String(kind)}`);
  if (kind === 'eigen') {
    if (typeof customLabel !== 'string' || customLabel.trim() === '' || customLabel.trim().length > NOTE_BADGE_MAX) {
      throw new Error(`Badge-Text fehlt oder ist länger als ${NOTE_BADGE_MAX} Zeichen`);
    }
  } else if (customLabel !== undefined) {
    throw new Error('Badge-Text ist nur beim Typ "eigen" erlaubt');
  }
  const note: Note = {
    id, kind, text, position, zIndex: maxZ(s) + 1,
    ...(kind === 'eigen' ? { customLabel: customLabel!.trim() } : {}),
  };
  return { ...s, notes: [...(s.notes ?? []), note] };
}

/** To-do abhaken/aufheben — nur für kind 'todo' erlaubt. */
export function setNoteDone(s: DesktopState, id: string, done: boolean): DesktopState {
  return mapNote(s, id, (n) => {
    if (n.kind !== 'todo') throw new Error('Nur To-do-Zettel können abgehakt werden');
    return { ...n, done };
  });
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
  const next = removeFromClips(removeLinksFor(s, id), id);
  return { ...next, notes: notes.filter((n) => n.id !== id) };
}

export function findNote(s: DesktopState, id: string): Note | undefined {
  return (s.notes ?? []).find((n) => n.id === id);
}

export function noteBox(n: Note): Box {
  return { x: n.position.x, y: n.position.y, w: NOTE_W, h: NOTE_H };
}
