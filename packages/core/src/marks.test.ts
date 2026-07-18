import { describe, expect, it } from 'vitest';
import { emptyState } from './model';
import { addDoc } from './documents';
import { addMark, removeMark, marksFor, removeMarksForDocs } from './marks';
import { removeDoc } from './removal';
import { applyCommand } from './commands';

function mitDoc() {
  return addDoc(emptyState(), 'f1', 'a.pdf', { x: 0, y: 0 }, 'd1');
}

describe('marks', () => {
  it('fügt eine Schwärzung hinzu und findet sie über marksFor', () => {
    const s = addMark(mitDoc(), { docId: 'd1', page: 2, rect: { x: 10, y: 20, w: 100, h: 30 }, kind: 'redact', id: 'm1' });
    expect(marksFor(s, 'd1', 2)).toHaveLength(1);
    expect(marksFor(s, 'd1', 1)).toHaveLength(0);
    expect(s.marks?.[0]).toMatchObject({ id: 'm1', kind: 'redact' });
  });

  it('lehnt unbekanntes Dokument, ungültige Seite, ungültiges Rechteck und unbekannte Art ab', () => {
    expect(() => addMark(mitDoc(), { docId: 'nix', page: 1, rect: { x: 0, y: 0, w: 1, h: 1 }, kind: 'tippex' })).toThrow('nicht gefunden');
    expect(() => addMark(mitDoc(), { docId: 'd1', page: 0, rect: { x: 0, y: 0, w: 1, h: 1 }, kind: 'tippex' })).toThrow('Seite');
    expect(() => addMark(mitDoc(), { docId: 'd1', page: 1, rect: { x: 0, y: 0, w: 0, h: 1 }, kind: 'tippex' })).toThrow('Fläche');
    expect(() => addMark(mitDoc(), { docId: 'd1', page: 1, rect: { x: 0, y: 0, w: 1, h: 1 }, kind: 'x' as never })).toThrow('Art');
  });

  it('entfernt eine Fläche; unbekannte id wirft', () => {
    const s = addMark(mitDoc(), { docId: 'd1', page: 1, rect: { x: 0, y: 0, w: 5, h: 5 }, kind: 'tippex', id: 'm1' });
    expect(removeMark(s, 'm1').marks).toHaveLength(0);
    expect(() => removeMark(s, 'nix')).toThrow('nicht gefunden');
  });

  it('alte States ohne marks-Feld: marksFor liefert leer, addMark legt das Feld an', () => {
    const alt = { ...mitDoc(), marks: undefined };
    expect(marksFor(alt, 'd1', 1)).toEqual([]);
    expect(addMark(alt, { docId: 'd1', page: 1, rect: { x: 0, y: 0, w: 5, h: 5 }, kind: 'redact' }).marks).toHaveLength(1);
  });

  it('removeDoc räumt Marks des Dokuments mit ab', () => {
    const s = addMark(mitDoc(), { docId: 'd1', page: 1, rect: { x: 0, y: 0, w: 5, h: 5 }, kind: 'redact' });
    expect(removeDoc(s, 'd1').marks).toHaveLength(0);
    expect(removeMarksForDocs(s, ['d1']).marks).toHaveLength(0);
  });

  it('Commands addMark/removeMark laufen durch applyCommand inkl. Validierung', () => {
    const s = applyCommand(mitDoc(), { type: 'addMark', payload: { mark: { docId: 'd1', page: 1, rect: { x: 0, y: 0, w: 9, h: 9 }, kind: 'tippex', id: 'm1' } } });
    expect(s.marks).toHaveLength(1);
    expect(applyCommand(s, { type: 'removeMark', payload: { markId: 'm1' } }).marks).toHaveLength(0);
    expect(() => applyCommand(s, { type: 'addMark', payload: {} })).toThrow();
  });
});
