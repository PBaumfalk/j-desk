import { describe, expect, it } from 'vitest';
import { emptyState } from './model';
import { addDoc } from './documents';
import { addStamp, removeStamp, stampsFor, STAMP_PRESETS } from './stamps';
import { removeDoc } from './removal';
import { applyCommand } from './commands';

const basis = { angle: -3, baseW: 595, baseH: 842 };
function mitDoc() {
  return addDoc(emptyState(), 'f1', 'a.pdf', { x: 0, y: 0 }, 'd1');
}

describe('stamps', () => {
  it('setzt einen Stempel mit Datum und findet ihn seitenweise', () => {
    const s = addStamp(mitDoc(), { docId: 'd1', page: 1, x: 100, y: 50, text: 'EINGANG', color: 'blue', date: '2026-07-18', ...basis, id: 'st1' });
    expect(stampsFor(s, 'd1', 1)).toHaveLength(1);
    expect(stampsFor(s, 'd1', 2)).toHaveLength(0);
    expect(s.stamps?.[0]).toMatchObject({ text: 'EINGANG', date: '2026-07-18', baseW: 595 });
  });

  it('validiert Dokument, Seite, Text, Farbe und Winkel', () => {
    expect(() => addStamp(mitDoc(), { docId: 'nix', page: 1, x: 0, y: 0, text: 'X', color: 'red', ...basis })).toThrow('nicht gefunden');
    expect(() => addStamp(mitDoc(), { docId: 'd1', page: 1, x: 0, y: 0, text: '', color: 'red', ...basis })).toThrow('Text');
    expect(() => addStamp(mitDoc(), { docId: 'd1', page: 1, x: 0, y: 0, text: 'A'.repeat(41), color: 'red', ...basis })).toThrow('Text');
    expect(() => addStamp(mitDoc(), { docId: 'd1', page: 1, x: 0, y: 0, text: 'X', color: 'green' as never, ...basis })).toThrow('Farbe');
    expect(() => addStamp(mitDoc(), { docId: 'd1', page: 1, x: 0, y: 0, text: 'X', color: 'red', angle: Number.NaN, baseW: 595, baseH: 842 })).toThrow('Winkel');
  });

  it('entfernt Stempel; removeDoc räumt mit ab', () => {
    const s = addStamp(mitDoc(), { docId: 'd1', page: 1, x: 0, y: 0, text: 'ERLEDIGT', color: 'red', ...basis, id: 'st1' });
    expect(removeStamp(s, 'st1').stamps).toHaveLength(0);
    expect(() => removeStamp(s, 'nix')).toThrow('nicht gefunden');
    expect(removeDoc(s, 'd1').stamps).toHaveLength(0);
  });

  it('Preset-Liste enthält die sieben Kanzlei-Stempel', () => {
    expect(STAMP_PRESETS.map((p) => p.text)).toEqual(['ERLEDIGT', 'WICHTIG', 'FRIST!', 'GEPRÜFT', 'EINGANG', 'ENTWURF', 'KOPIE']);
    expect(STAMP_PRESETS.find((p) => p.text === 'EINGANG')?.withDate).toBe(true);
  });

  it('Commands addStamp/removeStamp laufen durch applyCommand', () => {
    const s = applyCommand(mitDoc(), { type: 'addStamp', payload: { stamp: { docId: 'd1', page: 1, x: 1, y: 2, text: 'KOPIE', color: 'blue', ...basis, id: 'st1' } } });
    expect(s.stamps).toHaveLength(1);
    expect(applyCommand(s, { type: 'removeStamp', payload: { stampId: 'st1' } }).stamps).toHaveLength(0);
  });
});
