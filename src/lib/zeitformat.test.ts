import { describe, it, expect } from 'vitest';
import { tag, uhrzeit, zeitpunktLang } from './zeitformat';

describe('zeitformat', () => {
  it('zeitpunktLang für heute beginnt mit "Heute" und endet auf HH:MM', () => {
    const jetzt = Date.now();
    const s = zeitpunktLang(jetzt);
    expect(s.startsWith('Heute')).toBe(true);
    expect(s).toMatch(/\d{2}:\d{2}$/);
  });

  it('zeitpunktLang für gestern beginnt mit "Gestern"', () => {
    const gestern = Date.now() - 86_400_000;
    const s = zeitpunktLang(gestern);
    expect(s.startsWith('Gestern')).toBe(true);
  });

  it('zeitpunktLang für ein älteres Datum beginnt mit TT.MM.JJJJ', () => {
    // Fester Zeitpunkt weit in der Vergangenheit, damit der Test nicht am Kalender veraltet.
    const alt = new Date('2020-03-15T10:30:00.000Z').getTime();
    const s = zeitpunktLang(alt);
    expect(s).toMatch(/^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}$/);
  });

  it('tag() und uhrzeit() liefern die jeweiligen Teilstücke von zeitpunktLang()', () => {
    const alt = new Date('2020-03-15T10:30:00.000Z').getTime();
    expect(zeitpunktLang(alt)).toBe(`${tag(alt)} ${uhrzeit(alt)}`);
  });
});
