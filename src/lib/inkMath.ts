import type { Size, Stroke, Vec2 } from '@j-desk/core';

/** Overlay-Koordinate (CSS-Pixel relativ zur Seite) → Basisraum der PDF-Seite (scale = 1). */
export function toBase(p: Vec2, renderedWidth: number, base: Size): Vec2 {
  const f = base.w / renderedWidth;
  return { x: p.x * f, y: p.y * f };
}

/** Basisraum → Overlay-Koordinate (CSS-Pixel). */
export function toScreen(p: Vec2, renderedWidth: number, base: Size): Vec2 {
  const f = renderedWidth / base.w;
  return { x: p.x * f, y: p.y * f };
}

/** Bildschirm-Koordinate (clientX/Y) → Basisraum, über die TATSÄCHLICH gerenderte
    Rect-Breite. Wichtig: Der Viewer liegt in der gezoomten Welt-Ebene — bei Zoom ≠ 1
    ist die Bildschirmbreite nicht die nominelle CSS-Breite; wer mit der nominellen
    rechnet, zeichnet neben dem Cursor (UAT-Befund A6/A8/A9). */
export function clientToBase(
  client: Vec2,
  rect: { left: number; top: number; width: number },
  base: Size,
): Vec2 {
  const f = base.w / rect.width;
  return { x: (client.x - rect.left) * f, y: (client.y - rect.top) * f };
}

/** Kürzester Abstand eines Punkts zum Segment a–b. */
export function distPointToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2));
  const cx = a.x + t * abx;
  const cy = a.y + t * aby;
  return Math.hypot(p.x - cx, p.y - cy);
}

/** Liegt der Punkt (Basisraum) näher als `tolerance` an irgendeinem Segment des Strichs? */
export function hitStroke(stroke: Stroke, p: Vec2, tolerance: number): boolean {
  const pts = stroke.points;
  for (let i = 0; i < pts.length - 1; i++) {
    if (distPointToSegment(p, pts[i], pts[i + 1]) <= tolerance) return true;
  }
  return false;
}
