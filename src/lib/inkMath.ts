import type { Size, Stroke, StrokeTool, Vec2 } from '@j-desk/core';

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

/** Zeiger-Ereignis → Seitenkoordinate im Basisraum, gemeinsam für alle Viewer.
    Bewusst EINE Stelle: die Umrechnung stand doppelt in DocViewer und KonvolutViewer,
    weshalb der Zoom-Fix (UAT A6/A8/A9) im Konvolut nie ankam. `null` heißt: noch nicht
    messbar (Seite ungelayoutet oder Basisgröße unbekannt) — Aufrufer verwerfen die Geste. */
export function pagePointIn(
  client: Vec2,
  rect: { left: number; top: number; width: number },
  base: Size | null | undefined,
): Vec2 | null {
  if (!base || rect.width === 0) return null;
  return clientToBase(client, rect, base);
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

// ---- Pencil-Druckmodulation (MOBILE-01, 11-UI-SPEC.md „iPad-Profil-Anpassungen") ----

/** Unterer/oberer Klemmwert des Pencil-Druckmultiplikators. */
export const DRUCK_MIN = 0.4;
export const DRUCK_MAX = 1.4;

/**
 * Wandelt einen `PointerEvent.pressure`-Wert in einen Multiplikator für die Strichbreite um.
 * Ein falsy oder nicht endlicher Druckwert (0, `undefined`, `NaN`, `Infinity` — ein nicht
 * meldendes Eingabegerät) fällt auf den festen Rückfallwert 0.5; jeder andere Wert wird auf den
 * Bereich [`DRUCK_MIN`, `DRUCK_MAX`] geklemmt.
 *
 * Die Behandlung nicht endlicher Werte geht bewusst über die wörtliche UI-SPEC-Formel
 * `clamp(pressure || 0.5, 0.4, 1.4)` hinaus: die daraus berechnete Strichbreite muss den
 * bestehenden `num()`-Validator in `strokePayload` (`packages/core/src/commands.ts`) passieren
 * — ein `NaN` würde dort erst serverseitig als Kommandofehler auffallen und den Strich
 * verlieren, statt clientseitig geräuschlos auf einen festen mittleren Faktor zu degradieren.
 */
export function druckMultiplikator(pressure: number | undefined): number {
  if (!pressure || !Number.isFinite(pressure)) return 0.5;
  return Math.min(DRUCK_MAX, Math.max(DRUCK_MIN, pressure));
}

/**
 * Wendet die Druckmodulation auf eine Basisbreite an. Nur Kugelschreiber (`pen`) und Bleistift
 * (`pencil`) bei Stifteingabe (`pointerType === 'pen'`) laufen spitz zu und werden moduliert —
 * der Textmarker (`marker`) bleibt bewusst bei fester Breite, weil ein Textmarker nicht spitz
 * zuläuft; Maus- und Fingereingabe behalten ebenfalls die bestehende feste Breite je Werkzeug
 * (`TOOL_STYLE`, `InkOverlay.svelte`, unverändert).
 *
 * Die Modulation wird VOR dem Absenden in `Stroke.width` eingerechnet — das `addStroke`-Kommando
 * selbst bleibt unverändert, es kommt kein neues Feld auf den Draht. Die Verdrahtung in
 * `InkOverlay.svelte` ist NICHT Teil dieser Funktion; sie erfolgt in Plan 11-07.
 */
export function strichbreiteMitDruck(
  basisBreite: number,
  tool: StrokeTool,
  pointerType: string,
  pressure: number | undefined,
): number {
  if (pointerType !== 'pen' || tool === 'marker') return basisBreite;
  return basisBreite * druckMultiplikator(pressure);
}
