import { describe, expect, it } from 'vitest';
import { emptyState } from './model';
import { addDoc } from './documents';
import { addNote } from './notes';
import { setTaped, isTaped } from './tape';
import { applyCommand } from './commands';

describe('tape', () => {
  it('klebt Karte und Zettel fest und löst wieder', () => {
    let s = addDoc(emptyState(), 'f1', 'a.pdf', { x: 0, y: 0 }, 'd1');
    s = addNote(s, 'notiz', 'x', { x: 100, y: 0 }, 'n1');
    s = setTaped(s, 'd1', true);
    s = setTaped(s, 'n1', true);
    expect(isTaped(s, 'd1')).toBe(true);
    expect(isTaped(s, 'n1')).toBe(true);
    s = setTaped(s, 'd1', false);
    expect(isTaped(s, 'd1')).toBe(false);
  });

  it('wirft bei unbekanntem Objekt', () => {
    expect(() => setTaped(emptyState(), 'nix', true)).toThrow('nicht gefunden');
  });

  it('Commands tapeObject/untapeObject über applyCommand', () => {
    let s = addDoc(emptyState(), 'f1', 'a.pdf', { x: 0, y: 0 }, 'd1');
    s = applyCommand(s, { type: 'tapeObject', payload: { id: 'd1' } });
    expect(isTaped(s, 'd1')).toBe(true);
    s = applyCommand(s, { type: 'untapeObject', payload: { id: 'd1' } });
    expect(isTaped(s, 'd1')).toBe(false);
  });
});
