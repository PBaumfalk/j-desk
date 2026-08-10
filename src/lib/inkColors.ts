/** Farbpaletten für Zeichenwerkzeuge (Spec 2026-07-19 Radial-Werkzeuge). */

/** Stabilo-Boss-Klassiker: Gelb, Grün, Orange, Pink, Türkis, Lila. */
export const STABILO_COLORS: readonly string[] = ['#F7E948', '#7ED321', '#FF9838', '#F857A6', '#2EC4B6', '#B07FE0'];
/** Schreibfarben für Kugelschreiber/Lineal: Blau, Schwarz, Rot, Grün. */
export const PEN_COLORS: readonly string[] = ['#1d3557', '#1b1b1b', '#c1121f', '#2d6a4f'];

export type ColorableTool = 'pen' | 'marker';

const DEFAULTS: Record<ColorableTool, string> = { pen: '#1d3557', marker: '#F7E948' };
const paletteFor = (t: ColorableTool) => (t === 'marker' ? STABILO_COLORS : PEN_COLORS);
const key = (t: ColorableTool) => `jdesk.inkcolor.${t}`;

/** Zuletzt gewählte Farbe des Werkzeugs; unbekannte/fremde Werte fallen auf den Default zurück. */
export function loadInkColor(t: ColorableTool): string {
  try {
    const v = localStorage.getItem(key(t));
    if (v && paletteFor(t).includes(v)) return v;
  } catch { /* localStorage gesperrt — Default reicht */ }
  return DEFAULTS[t];
}

export function saveInkColor(t: ColorableTool, color: string): void {
  try { localStorage.setItem(key(t), color); } catch { /* s. o. */ }
}
