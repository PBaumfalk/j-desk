import type { DesktopState, Size } from './model';
import { rotationFor } from './documents';
import { uid } from './uid';

export const DEFAULT_OPEN_SIZE: Size = { w: 560, h: 720 };

function mapDoc(s: DesktopState, id: string, fn: (d: DesktopState['docs'][number]) => DesktopState['docs'][number]): DesktopState {
  let found = false;
  const docs = s.docs.map((d) => (d.id === id ? ((found = true), fn(d)) : d));
  if (!found) throw new Error(`Dokument "${id}" nicht gefunden`);
  return { ...s, docs };
}

export function expandDoc(s: DesktopState, id: string): DesktopState {
  return mapDoc(s, id, (d) => ({
    ...d,
    open: true,
    openSize: d.openSize ?? DEFAULT_OPEN_SIZE,
    page: d.page ?? 1,
  }));
}

export function collapseDoc(s: DesktopState, id: string): DesktopState {
  return mapDoc(s, id, (d) => ({ ...d, open: false }));
}

export function setDocPage(s: DesktopState, id: string, page: number): DesktopState {
  if (!Number.isInteger(page) || page < 1) throw new Error(`Ungültige Seite: ${page}`);
  return mapDoc(s, id, (d) => ({ ...d, page }));
}

export function resizeDoc(s: DesktopState, id: string, size: Size): DesktopState {
  if (!(size.w > 0) || !(size.h > 0)) throw new Error(`Ungültige Größe: ${size.w}×${size.h}`);
  return mapDoc(s, id, (d) => ({ ...d, openSize: { w: size.w, h: size.h } }));
}

/**
 * Enthefterzange: löst eine Seite als eigene Karte heraus — nicht destruktiv,
 * das Originaldokument bleibt unverändert liegen.
 */
export function extractPage(
  s: DesktopState,
  docId: string,
  page: number,
  position: { x: number; y: number },
  id?: string,
): DesktopState {
  const quelle = s.docs.find((d) => d.id === docId);
  if (!quelle) throw new Error(`Dokument "${docId}" nicht gefunden`);
  if (!Number.isInteger(page) || page < 1) throw new Error(`Ungültige Seite: ${page}`);
  const neueId = id ?? uid();
  const doc = {
    id: neueId,
    fileId: quelle.fileId,
    name: `${quelle.name} – S. ${page}`,
    position,
    rotation: rotationFor(neueId),
    zIndex: Math.max(0, ...s.docs.map((d) => d.zIndex), ...s.stacks.map((st) => st.zIndex)) + 1,
    pageOnly: page,
    ...(quelle.kind !== undefined ? { kind: quelle.kind } : {}),
  };
  return { ...s, docs: [...s.docs, doc] };
}
