import { CARD_W, CARD_H, freeDocs, type DesktopState, type Doc, type Stack, type Vec2 } from './model';
import { DEFAULT_OPEN_SIZE } from './viewer';
import { noteBox } from './notes';
import type { Box } from './viewport';

export function docBox(d: Doc): Box {
  if (d.open) {
    const size = d.openSize ?? DEFAULT_OPEN_SIZE;
    return { x: d.position.x, y: d.position.y, w: size.w, h: size.h };
  }
  return { x: d.position.x, y: d.position.y, w: CARD_W, h: CARD_H };
}

export function stackBox(st: Stack): Box {
  return { x: st.position.x, y: st.position.y, w: CARD_W + 24, h: CARD_H + 24 };
}

export function allBoxes(s: DesktopState): Box[] {
  return [...freeDocs(s).map(docBox), ...s.stacks.map(stackBox), ...(s.notes ?? []).map(noteBox)];
}

export function hitTest(
  s: DesktopState,
  p: Vec2,
  excludeId: string,
): { kind: 'doc' | 'stack'; id: string } | null {
  const inside = (b: Box) => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
  const candidates = [
    ...s.stacks
      .filter((st) => st.id !== excludeId && inside(stackBox(st)))
      .map((st) => ({ kind: 'stack' as const, id: st.id, z: st.zIndex })),
    // Aufgeschlagene Dokumente sind kein Stapelziel — auf ein offenes Papier stapelt man nicht.
    ...freeDocs(s)
      .filter((d) => d.id !== excludeId && !d.open && inside(docBox(d)))
      .map((d) => ({ kind: 'doc' as const, id: d.id, z: d.zIndex })),
  ];
  candidates.sort((a, b) => b.z - a.z);
  return candidates[0] ? { kind: candidates[0].kind, id: candidates[0].id } : null;
}
