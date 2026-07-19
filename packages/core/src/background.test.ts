import { describe, expect, it } from 'vitest';
import { emptyState, isValidState } from './model';
import { deskBackground, setBackground, DEFAULT_BACKGROUND, DESK_THEME_IDS, DESK_MATERIALS } from './background';
import { applyCommand } from './commands';

describe('background', () => {
  it('liefert den Standard, wenn kein Erscheinungsbild gespeichert ist (Alt-States)', () => {
    expect(deskBackground(emptyState())).toEqual(DEFAULT_BACKGROUND);
  });

  it('setzt Farbthema und Material; alle Kombinationen sind gültig', () => {
    for (const themeId of DESK_THEME_IDS) {
      for (const material of DESK_MATERIALS) {
        const s = setBackground(emptyState(), { themeId, material });
        expect(deskBackground(s)).toEqual({ themeId, material });
        expect(isValidState(s)).toBe(true);
      }
    }
  });

  it('lehnt unbekannte Themen und Materialien ab', () => {
    expect(() => setBackground(emptyState(), { themeId: 'neon_pink' as never, material: 'felt' })).toThrow('Farbthema');
    expect(() => setBackground(emptyState(), { themeId: 'dark_green', material: 'beton' as never })).toThrow('Material');
  });

  it('Command setBackground über applyCommand; fehlende Felder werden abgewiesen', () => {
    const s = applyCommand(emptyState(), {
      type: 'setBackground',
      payload: { background: { themeId: 'bordeaux', material: 'leather' } },
    });
    expect(s.background).toEqual({ themeId: 'bordeaux', material: 'leather' });
    expect(() => applyCommand(emptyState(), { type: 'setBackground', payload: {} })).toThrow('background');
    expect(() => applyCommand(emptyState(), { type: 'setBackground', payload: { background: { themeId: 'ivory' } } })).toThrow('material');
  });

  it('isValidState toleriert fehlendes background, weist kaputte Werte ab', () => {
    expect(isValidState({ docs: [], links: [], stacks: [] })).toBe(true);
    expect(isValidState({ docs: [], links: [], stacks: [], background: { themeId: 'navy_blue', material: 'wood' } })).toBe(true);
    expect(isValidState({ docs: [], links: [], stacks: [], background: 'grün' })).toBe(false);
    expect(isValidState({ docs: [], links: [], stacks: [], background: { themeId: 7 } })).toBe(false);
  });
});
