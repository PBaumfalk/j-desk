import { describe, expect, it } from 'vitest';
import { hashString, identityColor, vorname } from './identityColor';

describe('hashString', () => {
  it('liefert bei jedem Aufruf denselben Wert (Determinismus)', () => {
    expect(hashString('u1')).toBe(hashString('u1'));
  });

  it('liefert für einen leeren String einen definierten Wert und wirft nicht', () => {
    expect(() => hashString('')).not.toThrow();
    expect(hashString('')).toBe(0);
  });
});

describe('identityColor', () => {
  it('liefert im hellen Theme eine Zeichenkette der Form hsl(<0..359>, 65%, 45%)', () => {
    const c = identityColor('u1', false);
    const match = /^hsl\((\d{1,3}), 65%, 45%\)$/.exec(c);
    expect(match).not.toBeNull();
    const hue = Number(match![1]);
    expect(hue).toBeGreaterThanOrEqual(0);
    expect(hue).toBeLessThan(360);
  });

  it('liefert im dunklen Theme denselben Farbwinkel mit hsl(<winkel>, 60%, 65%)', () => {
    const hellMatch = /^hsl\((\d{1,3}), 65%, 45%\)$/.exec(identityColor('u1', false));
    const dunkelMatch = /^hsl\((\d{1,3}), 60%, 65%\)$/.exec(identityColor('u1', true));
    expect(hellMatch).not.toBeNull();
    expect(dunkelMatch).not.toBeNull();
    expect(dunkelMatch![1]).toBe(hellMatch![1]);
  });

  it('ist deterministisch für dieselbe userId', () => {
    expect(identityColor('u1', false)).toBe(identityColor('u1', false));
  });

  it('liefert für ein konkretes Paar unterschiedlicher userId unterschiedliche Farben', () => {
    expect(identityColor('u1', false)).not.toBe(identityColor('u2', false));
  });
});

describe('vorname', () => {
  it('liefert das erste Wortsegment bei einem Namen mit Leerzeichen', () => {
    expect(vorname('Frau Meier')).toBe('Frau');
  });

  it('liefert den vollständigen Namen, wenn kein Leerzeichen vorhanden ist', () => {
    expect(vorname('Meier')).toBe('Meier');
  });

  it('liefert einen leeren String für einen leeren Namen', () => {
    expect(vorname('')).toBe('');
  });

  it('liefert ein nicht-leeres Wortsegment ohne führende Leerzeichen bei Rand-Whitespace', () => {
    const result = vorname('  Anna  Schmidt ');
    expect(result).not.toBe('');
    expect(result.startsWith(' ')).toBe(false);
  });
});
