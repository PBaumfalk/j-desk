import type { Vec2 } from './model';

/** screen = world * scale + (x, y) */
export interface Viewport { x: number; y: number; scale: number }

export interface Box { x: number; y: number; w: number; h: number }

export function screenToWorld(vp: Viewport, p: Vec2): Vec2 {
  return { x: (p.x - vp.x) / vp.scale, y: (p.y - vp.y) / vp.scale };
}

export function zoomAt(vp: Viewport, screenPt: Vec2, factor: number, min = 0.15, max = 3): Viewport {
  const scale = Math.min(max, Math.max(min, vp.scale * factor));
  const w = screenToWorld(vp, screenPt);
  return { scale, x: screenPt.x - w.x * scale, y: screenPt.y - w.y * scale };
}

export function zoomToFit(boxes: Box[], view: { w: number; h: number }, padding = 80): Viewport {
  if (boxes.length === 0) return { x: 0, y: 0, scale: 1 };
  const minX = Math.min(...boxes.map((b) => b.x));
  const minY = Math.min(...boxes.map((b) => b.y));
  const maxX = Math.max(...boxes.map((b) => b.x + b.w));
  const maxY = Math.max(...boxes.map((b) => b.y + b.h));
  const scale = Math.min(
    3,
    Math.max(0.15, Math.min((view.w - 2 * padding) / (maxX - minX || 1), (view.h - 2 * padding) / (maxY - minY || 1))),
  );
  return {
    scale,
    x: view.w / 2 - ((minX + maxX) / 2) * scale,
    y: view.h / 2 - ((minY + maxY) / 2) * scale,
  };
}
