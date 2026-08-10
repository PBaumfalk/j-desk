import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import { loadInkColor, saveInkColor, PEN_COLORS, STABILO_COLORS } from './inkColors';

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('inkColors', () => {
  beforeEach(() => localStorage.clear());

  it('liefert Defaults ohne gespeicherte Wahl (Kuli-Blau, Stabilo-Gelb)', () => {
    expect(loadInkColor('pen')).toBe('#1d3557');
    expect(loadInkColor('marker')).toBe('#F7E948');
  });

  it('merkt sich die Wahl pro Werkzeug', () => {
    saveInkColor('marker', STABILO_COLORS[3]);
    saveInkColor('pen', PEN_COLORS[2]);
    expect(loadInkColor('marker')).toBe(STABILO_COLORS[3]);
    expect(loadInkColor('pen')).toBe(PEN_COLORS[2]);
  });

  it('verwirft Werte außerhalb der Palette (defensiv gegen Alt-/Fremdwerte)', () => {
    localStorage.setItem('jdesk.inkcolor.marker', '#123456');
    expect(loadInkColor('marker')).toBe('#F7E948');
  });

  it('Paletten sind exakt die Spec-Farben', () => {
    expect(STABILO_COLORS).toEqual(['#F7E948', '#7ED321', '#FF9838', '#F857A6', '#2EC4B6', '#B07FE0']);
    expect(PEN_COLORS).toEqual(['#1d3557', '#1b1b1b', '#c1121f', '#2d6a4f']);
  });
});
