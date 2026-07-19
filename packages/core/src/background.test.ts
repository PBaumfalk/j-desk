import { describe, expect, it } from 'vitest';
import { emptyState, isValidState } from './model';
import {
  deskBackground, setBackground, DEFAULT_BACKGROUND, DESK_THEME_IDS, DESK_MATERIALS,
  type DeskBackground,
} from './background';
import { applyCommand } from './commands';

describe('background', () => {
  it('liefert den Standard, wenn kein Erscheinungsbild gespeichert ist (Alt-States)', () => {
    expect(deskBackground(emptyState())).toEqual(DEFAULT_BACKGROUND);
    expect(DEFAULT_BACKGROUND).toEqual({
      themeId: 'dark_green', material: 'felt', brightness: 1, textureIntensity: 0.25, vignette: true,
    });
  });

  it('füllt Teil-Zustände (nur Farbe/Material) mit den Standards auf', () => {
    const s = {
      ...emptyState(),
      background: { themeId: 'bordeaux', material: 'leather' } as DeskBackground,
    };
    expect(deskBackground(s)).toEqual({
      themeId: 'bordeaux', material: 'leather', brightness: 1, textureIntensity: 0.25, vignette: true,
    });
  });

  it('setzt Erscheinungsbild; alle Thema/Material-Kombinationen sind gültig', () => {
    for (const themeId of DESK_THEME_IDS) {
      for (const material of DESK_MATERIALS) {
        const bg = { ...DEFAULT_BACKGROUND, themeId, material, brightness: 1.1, textureIntensity: 0.5, vignette: false };
        const s = setBackground(emptyState(), bg);
        expect(deskBackground(s)).toEqual(bg);
        expect(isValidState(s)).toBe(true);
      }
    }
  });

  it('lehnt unbekannte Themen und Materialien ab', () => {
    expect(() => setBackground(emptyState(), { ...DEFAULT_BACKGROUND, themeId: 'neon_pink' as never })).toThrow('Farbthema');
    expect(() => setBackground(emptyState(), { ...DEFAULT_BACKGROUND, material: 'beton' as never })).toThrow('Material');
  });

  it('lehnt Werte außerhalb der Bereiche ab', () => {
    expect(() => setBackground(emptyState(), { ...DEFAULT_BACKGROUND, brightness: 0.5 })).toThrow('Helligkeit');
    expect(() => setBackground(emptyState(), { ...DEFAULT_BACKGROUND, brightness: 1.3 })).toThrow('Helligkeit');
    expect(() => setBackground(emptyState(), { ...DEFAULT_BACKGROUND, brightness: Number.NaN })).toThrow('Helligkeit');
    expect(() => setBackground(emptyState(), { ...DEFAULT_BACKGROUND, textureIntensity: -0.1 })).toThrow('Struktur');
    expect(() => setBackground(emptyState(), { ...DEFAULT_BACKGROUND, textureIntensity: 1.1 })).toThrow('Struktur');
    expect(() => setBackground(emptyState(), { ...DEFAULT_BACKGROUND, vignette: 'ja' as never })).toThrow('vignette');
  });

  it('Command setBackground über applyCommand; fehlende Felder werden abgewiesen', () => {
    const bg = { themeId: 'bordeaux', material: 'leather', brightness: 0.9, textureIntensity: 0.4, vignette: false };
    const s = applyCommand(emptyState(), { type: 'setBackground', payload: { background: bg } });
    expect(s.background).toEqual(bg);
    expect(() => applyCommand(emptyState(), { type: 'setBackground', payload: {} })).toThrow('background');
    expect(() => applyCommand(emptyState(), { type: 'setBackground', payload: { background: { themeId: 'ivory' } } })).toThrow('material');
    expect(() => applyCommand(emptyState(), {
      type: 'setBackground',
      payload: { background: { themeId: 'ivory', material: 'felt' } },
    })).toThrow('brightness');
    expect(() => applyCommand(emptyState(), {
      type: 'setBackground',
      payload: { background: { themeId: 'ivory', material: 'felt', brightness: 1, textureIntensity: 0.25 } },
    })).toThrow('vignette');
  });

  it('isValidState toleriert fehlendes/teilweises background, weist kaputte Werte ab', () => {
    expect(isValidState({ docs: [], links: [], stacks: [] })).toBe(true);
    expect(isValidState({ docs: [], links: [], stacks: [], background: { themeId: 'navy_blue', material: 'wood' } })).toBe(true);
    expect(isValidState({
      docs: [], links: [], stacks: [],
      background: { themeId: 'navy_blue', material: 'wood', brightness: 1.2, textureIntensity: 0.8, vignette: false },
    })).toBe(true);
    expect(isValidState({ docs: [], links: [], stacks: [], background: 'grün' })).toBe(false);
    expect(isValidState({ docs: [], links: [], stacks: [], background: { themeId: 7 } })).toBe(false);
    expect(isValidState({
      docs: [], links: [], stacks: [],
      background: { themeId: 'navy_blue', material: 'wood', brightness: 'hell' },
    })).toBe(false);
  });
});
