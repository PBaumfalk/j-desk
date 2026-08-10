import type { Box, Viewport } from '@j-desk/core';

/**
 * Minikarten-Geometrie (UX-03, 13-05 Task 2): reine, DOM-freie Skalierungs-/Projektionsrechnung
 * nach dem Muster `views.ts`/`jump.ts` — testbar ohne Runen-Kontext (Vitest `environment: 'node'`).
 * Das eigentliche Canvas-Rendering (Kartenpunkte/Zonen/Viewport-Rechteck) liegt in
 * `Minimap.svelte`; diese Datei liefert ausschließlich die Zahlen.
 *
 * Fit-Rechnung bewusst NICHT eigenständig: dieselbe Bounding-Box-/Zentrier-Formel wie
 * `zoomToFit` (packages/core/src/viewport.ts), nur auf die feste Minikarten-Fläche statt die
 * aktuelle Bildschirmgröße abgebildet (P8-Kommentar: „keine eigene Fit-Rechnung").
 */

/** MINIMAP_W/H (13-UI-SPEC.md Spacing Exceptions) — feste Ecke links unten, 16px Abstand
 *  (Minimap.svelte), Spiegelung des Papierkorbs rechts unten (TrashCan.svelte-Muster). */
export const MINIMAP_W = 192;
export const MINIMAP_H = 128;

export interface MinikarteFit {
  scale: number;
  offsetX: number;
  offsetY: number;
}

/** Obergrenze der Fit-Skalierung — dieselbe Zahl wie VP_SCALE_MAX (views.ts/zoomToFit): ein
 *  einzelnes winziges Objekt (oder eine entartete Nullflächen-Box) soll die Minikarte nicht
 *  absurd hineinzoomen. Bewusst OHNE die entsprechende Untergrenze (VP_SCALE_MIN = 0.15): ein
 *  dichter, großflächiger Tisch MUSS auf 192×128 passen (E3/populated-Backstop „das Viewport-
 *  Rechteck ist sofort auffindbar" — eine harte Mindestskalierung würde fit-all bei realistisch
 *  großen Tischen genau dort brechen, wo die Minikarte am nötigsten ist). */
const FIT_SCALE_MAX = 3;

/**
 * Skalierung + Versatz, um die Welt-Bounding-Box aller Objekte zentriert in MINIMAP_W×MINIMAP_H
 * abzubilden — dieselbe Zentrier-Formel wie `zoomToFit`, nur ohne dessen Padding (die Minikarte
 * ist bereits klein, ein zusätzlicher Rand würde sichtbaren Platz verschenken).
 *
 * Leerfall (E3/empty): ohne Objekte gibt es keine Welt-Bounding-Box — der Fit bildet dann die
 * Einheits-Welt (scale 1) um den Weltursprung zentriert ab; `viewportRectFuer` klemmt das
 * daraus resultierende (ggf. weit außerhalb liegende) Viewport-Rechteck auf die Kartenfläche,
 * sodass die Minikarte trotzdem ein sinnvolles Rechteck zeigt statt eines Absturzes.
 */
export function fitFuerMinikarte(boxes: Box[], w: number, h: number): MinikarteFit {
  if (boxes.length === 0) {
    return { scale: 1, offsetX: w / 2, offsetY: h / 2 };
  }
  const minX = Math.min(...boxes.map((b) => b.x));
  const minY = Math.min(...boxes.map((b) => b.y));
  const maxX = Math.max(...boxes.map((b) => b.x + b.w));
  const maxY = Math.max(...boxes.map((b) => b.y + b.h));
  const worldW = maxX - minX || 1;
  const worldH = maxY - minY || 1;
  const scale = Math.min(FIT_SCALE_MAX, w / worldW, h / worldH);
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  return {
    scale,
    offsetX: w / 2 - centerX * scale,
    offsetY: h / 2 - centerY * scale,
  };
}

/**
 * Projiziert den aktuell sichtbaren Weltausschnitt (aus `vp` + Bildschirmgröße) in Minikarten-
 * Koordinaten. Geklemmt auf die Kartenfläche [0,MINIMAP_W]×[0,MINIMAP_H] — liegt der Weltausschnitt
 * (weit) außerhalb der Fit-Bounding-Box (Leerfall, extremes Auszoomen), bliebe sonst ein
 * unsichtbares oder abgeschnittenes Rechteck statt eines auffindbaren Accent-Rahmens
 * (E3/populated-Backstop).
 */
export function viewportRectFuer(
  vp: Viewport,
  viewW: number,
  viewH: number,
  fit: MinikarteFit,
): { x: number; y: number; w: number; h: number } {
  // Weltsichtbereich: screen = world*vp.scale + vp.xy  =>  world = (screen - vp.xy) / vp.scale
  const worldX = -vp.x / vp.scale;
  const worldY = -vp.y / vp.scale;
  const worldW = viewW / vp.scale;
  const worldH = viewH / vp.scale;

  const mx = worldX * fit.scale + fit.offsetX;
  const my = worldY * fit.scale + fit.offsetY;
  const mw = worldW * fit.scale;
  const mh = worldH * fit.scale;

  const w = Math.min(Math.max(mw, 0), MINIMAP_W);
  const h = Math.min(Math.max(mh, 0), MINIMAP_H);
  const x = Math.max(0, Math.min(mx, MINIMAP_W - w));
  const y = Math.max(0, Math.min(my, MINIMAP_H - h));
  return { x, y, w, h };
}

/** Umkehrung der Fit-Projektion: aus einem Minikarten-Klickpunkt den Weltpunkt (Zentrier-Ziel
 *  eines Minikarten-Sprungs). Rundreise-Eigenschaft: `punktZuViewport(...vorwärtsProjiziert(p))
 *  ≈ p` innerhalb üblicher Fließkomma-Rundung. */
export function punktZuViewport(klickX: number, klickY: number, fit: MinikarteFit): { x: number; y: number } {
  return {
    x: (klickX - fit.offsetX) / fit.scale,
    y: (klickY - fit.offsetY) / fit.scale,
  };
}
