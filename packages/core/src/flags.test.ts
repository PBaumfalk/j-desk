import { describe, expect, it } from 'vitest';
import { emptyState } from './model';
import { addDoc } from './documents';
import { addFlag, removeFlag, flagsFor, FLAG_COLORS } from './flags';
import { removeDoc } from './removal';
import { applyCommand } from './commands';

function mitDoc() {
  return addDoc(emptyState(), 'f1', 'a.pdf', { x: 0, y: 0 }, 'd1');
}

describe('flags', () => {
  it('setzt eine Fahne; flagsFor liefert alle Fahnen des Dokuments über alle Seiten', () => {
    let s = addFlag(mitDoc(), { docId: 'd1', page: 3, offset: 0.25, color: FLAG_COLORS[0], id: 'fl1' });
    s = addFlag(s, { docId: 'd1', page: 7, offset: 0.5, color: FLAG_COLORS[1], id: 'fl2' });
    expect(flagsFor(s, 'd1')).toHaveLength(2);
    expect(flagsFor(s, 'anders')).toHaveLength(0);
  });

  it('validiert Dokument, Seite, Offset und Farbe', () => {
    expect(() => addFlag(mitDoc(), { docId: 'nix', page: 1, offset: 0.5, color: FLAG_COLORS[0] })).toThrow('nicht gefunden');
    expect(() => addFlag(mitDoc(), { docId: 'd1', page: 0, offset: 0.5, color: FLAG_COLORS[0] })).toThrow('Seite');
    expect(() => addFlag(mitDoc(), { docId: 'd1', page: 1, offset: 1.5, color: FLAG_COLORS[0] })).toThrow('Offset');
    expect(() => addFlag(mitDoc(), { docId: 'd1', page: 1, offset: 0.5, color: '#000000' })).toThrow('Farbe');
  });

  it('entfernt Fahnen; removeDoc räumt mit ab', () => {
    const s = addFlag(mitDoc(), { docId: 'd1', page: 1, offset: 0.1, color: FLAG_COLORS[2], id: 'fl1' });
    expect(removeFlag(s, 'fl1').flags).toHaveLength(0);
    expect(() => removeFlag(s, 'nix')).toThrow('nicht gefunden');
    expect(removeDoc(s, 'd1').flags).toHaveLength(0);
  });

  it('Commands addFlag/removeFlag über applyCommand', () => {
    const s = applyCommand(mitDoc(), { type: 'addFlag', payload: { flag: { docId: 'd1', page: 2, offset: 0.4, color: FLAG_COLORS[3], id: 'fl1' } } });
    expect(s.flags).toHaveLength(1);
    expect(applyCommand(s, { type: 'removeFlag', payload: { flagId: 'fl1' } }).flags).toHaveLength(0);
  });
});
