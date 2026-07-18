import { findStack, type DesktopState, type Size, type Stack } from './model';
import { DEFAULT_OPEN_SIZE } from './viewer';

/** Eine Konvolut-Seite: welches Mitglied liefert welche lokale Seite. */
export interface KonvolutPage {
  docId: string;
  fileId: string;
  page: number;   // lokale Seite im Mitglieds-Dokument, 1-basiert
}

/**
 * Verkettete Seiten des Konvoluts in Stapelreihenfolge (unten → oben).
 * pageCounts: fileId → Seitenzahl. Fehlt eine benötigte Zahl, kommt null zurück
 * (der Client lädt nach und ruft erneut). Seitenkarten (pageOnly) zählen als 1 Seite.
 */
export function konvolutPages(
  s: DesktopState,
  stack: Stack,
  pageCounts: Record<string, number>,
): KonvolutPage[] | null {
  const pages: KonvolutPage[] = [];
  for (const docId of stack.docIds) {
    const d = s.docs.find((x) => x.id === docId);
    if (!d) continue; // defensive: verwaiste id überspringen
    if (d.pageOnly !== undefined) {
      pages.push({ docId: d.id, fileId: d.fileId, page: d.pageOnly });
      continue;
    }
    const count = pageCounts[d.fileId];
    if (!Number.isInteger(count) || count < 1) return null;
    for (let p = 1; p <= count; p++) pages.push({ docId: d.id, fileId: d.fileId, page: p });
  }
  return pages;
}

function mapStack(s: DesktopState, id: string, fn: (st: Stack) => Stack): DesktopState {
  const st = findStack(s, id);
  if (!st) throw new Error(`Stapel "${id}" nicht gefunden`);
  return { ...s, stacks: s.stacks.map((x) => (x.id === id ? fn(x) : x)) };
}

export function expandStack(s: DesktopState, id: string): DesktopState {
  const st = findStack(s, id);
  if (!st) throw new Error(`Stapel "${id}" nicht gefunden`);
  if (!st.stapled) throw new Error('Nur ein geheftetes Konvolut lässt sich als Ganzes aufschlagen');
  return mapStack(s, id, (x) => ({ ...x, open: true, openSize: x.openSize ?? DEFAULT_OPEN_SIZE, page: x.page ?? 1 }));
}

export function collapseStack(s: DesktopState, id: string): DesktopState {
  return mapStack(s, id, (x) => ({ ...x, open: false }));
}

export function setStackPage(s: DesktopState, id: string, page: number): DesktopState {
  if (!Number.isInteger(page) || page < 1) throw new Error(`Ungültige Seite: ${page}`);
  return mapStack(s, id, (x) => ({ ...x, page }));
}

export function resizeStack(s: DesktopState, id: string, size: Size): DesktopState {
  if (!(size.w > 0) || !(size.h > 0)) throw new Error(`Ungültige Größe: ${size.w}×${size.h}`);
  return mapStack(s, id, (x) => ({ ...x, openSize: { w: size.w, h: size.h } }));
}
