import { describe, expect, it } from 'vitest';
import { emptyState } from './model';
import { addDoc } from './documents';
import { pruefeErwartung } from './konflikt';

function tisch() {
  let s = addDoc(emptyState(), 'f1', 'Akte.pdf', { x: 0, y: 0 }, 'd1');
  s = { ...s, docs: s.docs.map((d) => ({ ...d, updatedRev: 5, updatedBy: 'Frau Meier', updatedAt: '2026-07-20T09:00:00.000Z' })) };
  return s;
}

describe('pruefeErwartung', () => {
  it('nimmt an, wenn die Version passt', () => {
    expect(pruefeErwartung(tisch(), { d1: 5 })).toBeNull();
  });

  it('nimmt an, wenn gar keine Erwartung mitkommt (alter Client)', () => {
    expect(pruefeErwartung(tisch(), undefined)).toBeNull();
  });

  it('meldet "geaendert" mit Person und Zeitpunkt', () => {
    expect(pruefeErwartung(tisch(), { d1: 4 })).toEqual({
      objektId: 'd1', typ: 'docs', art: 'geaendert',
      von: 'Frau Meier', am: '2026-07-20T09:00:00.000Z',
    });
  });

  it('meldet "geloescht", wenn das Objekt fehlt', () => {
    expect(pruefeErwartung(tisch(), { weg: 3 })).toEqual({
      objektId: 'weg', typ: 'unbekannt', art: 'geloescht', von: null, am: null,
    });
  });

  it('nimmt an, wenn das Objekt noch keine Version traegt (Alt-Zustand)', () => {
    const s = addDoc(emptyState(), 'f9', 'Alt.pdf', { x: 0, y: 0 }, 'd9');
    expect(pruefeErwartung(s, { d9: 3 })).toBeNull();
  });

  it('meldet den ersten Konflikt, wenn mehrere Objekte erwartet werden', () => {
    const s = tisch();
    const k = pruefeErwartung(s, { d1: 5, weg: 1 });
    expect(k?.objektId).toBe('weg');
  });
});
