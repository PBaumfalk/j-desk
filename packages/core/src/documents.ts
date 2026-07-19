import { uid } from './uid';
import type { DesktopState, Vec2, FileKind } from './model';
import { FILE_KINDS } from './model';

function maxZ(s: DesktopState): number {
  return Math.max(
    0,
    ...s.docs.map((d) => d.zIndex),
    ...s.stacks.map((st) => st.zIndex),
    ...(s.notes ?? []).map((n) => n.zIndex),
    ...(s.cutouts ?? []).map((c) => c.zIndex),
  );
}

/** Deterministische leichte Drehung aus der id, in [-3, 3] Grad. */
export function rotationFor(id: string): number {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) | 0;
  return ((Math.abs(h) % 61) - 30) / 10;
}

export function addDoc(
  s: DesktopState,
  fileId: string,
  name: string,
  position: Vec2,
  id: string = uid(),
  kind?: FileKind,
): DesktopState {
  if (kind !== undefined && !FILE_KINDS.includes(kind)) throw new Error(`Unbekannte Datei-Art: ${String(kind)}`);
  if (s.docs.some((d) => d.fileId === fileId)) return s; // liegt schon auf dem Tisch
  const doc = { id, fileId, name, position, rotation: rotationFor(id), zIndex: maxZ(s) + 1, ...(kind !== undefined ? { kind } : {}) };
  return { ...s, docs: [...s.docs, doc] };
}

export function moveDoc(s: DesktopState, id: string, position: Vec2): DesktopState {
  return { ...s, docs: s.docs.map((d) => (d.id === id ? { ...d, position } : d)) };
}

/** Hebt ein Dokument oder einen Stapel über alles andere. */
export function bringToFront(s: DesktopState, id: string): DesktopState {
  const z = maxZ(s) + 1;
  return {
    ...s,
    docs: s.docs.map((d) => (d.id === id ? { ...d, zIndex: z } : d)),
    stacks: s.stacks.map((st) => (st.id === id ? { ...st, zIndex: z } : st)),
    ...(s.notes ? { notes: s.notes.map((n) => (n.id === id ? { ...n, zIndex: z } : n)) } : {}),
    ...(s.cutouts ? { cutouts: s.cutouts.map((c) => (c.id === id ? { ...c, zIndex: z } : c)) } : {}),
  };
}

