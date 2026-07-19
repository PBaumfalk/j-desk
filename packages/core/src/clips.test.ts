import { describe, expect, it } from 'vitest';
import { emptyState } from './model';
import { addDoc } from './documents';
import { addNote } from './notes';
import { addClip, removeClip, clipOf, clipMembersOf, removeFromClips } from './clips';
import { removeDoc } from './removal';
import { removeNote } from './notes';
import { applyCommand } from './commands';

function basis() {
  let s = addDoc(emptyState(), 'f1', 'a.pdf', { x: 0, y: 0 }, 'd1');
  s = addDoc(s, 'f2', 'b.pdf', { x: 300, y: 0 }, 'd2');
  return addNote(s, 'notiz', 'Hallo', { x: 600, y: 0 }, 'n1');
}

describe('clips', () => {
  it('klammert zwei Objekte; clipOf und clipMembersOf finden die Gruppe', () => {
    const s = addClip(basis(), 'd1', 'n1', 'c1');
    expect(clipOf(s, 'd1')?.id).toBe('c1');
    expect(clipMembersOf(s, 'n1')).toEqual(['d1', 'n1']);
    expect(clipMembersOf(s, 'd2')).toEqual(['d2']);
  });

  it('erweitert eine bestehende Gruppe statt eine zweite zu bilden', () => {
    let s = addClip(basis(), 'd1', 'n1', 'c1');
    s = addClip(s, 'd2', 'd1');
    expect(s.clips).toHaveLength(1);
    expect(clipMembersOf(s, 'd2').sort()).toEqual(['d1', 'd2', 'n1']);
  });

  it('verschmilzt zwei Gruppen, wenn beide Partner geklammert sind', () => {
    let s = addDoc(basis(), 'f3', 'c.pdf', { x: 0, y: 300 }, 'd3');
    s = addClip(s, 'd1', 'n1', 'c1');
    s = addClip(s, 'd2', 'd3', 'c2');
    s = addClip(s, 'd1', 'd2');
    expect(s.clips).toHaveLength(1);
    expect(clipMembersOf(s, 'd3').sort()).toEqual(['d1', 'd2', 'd3', 'n1']);
  });

  it('lehnt Selbst-Klammerung und unbekannte Objekte ab; doppelte Klammerung ist idempotent', () => {
    expect(() => addClip(basis(), 'd1', 'd1')).toThrow('sich selbst');
    expect(() => addClip(basis(), 'd1', 'nix')).toThrow('nicht gefunden');
    let s = addClip(basis(), 'd1', 'n1', 'c1');
    s = addClip(s, 'd1', 'n1');
    expect(s.clips).toHaveLength(1);
    expect(clipMembersOf(s, 'd1')).toHaveLength(2);
  });

  it('removeClip löst die Gruppe; removeFromClips lässt Gruppen unter 2 Mitgliedern verschwinden', () => {
    const s = addClip(basis(), 'd1', 'n1', 'c1');
    expect(removeClip(s, 'c1').clips).toHaveLength(0);
    expect(removeFromClips(s, 'd1').clips).toHaveLength(0);
  });

  it('removeDoc und removeNote nehmen das Objekt aus seiner Gruppe', () => {
    let s = addDoc(basis(), 'f3', 'c.pdf', { x: 0, y: 300 }, 'd3');
    s = addClip(s, 'd1', 'n1', 'c1');
    s = addClip(s, 'd3', 'd1');
    expect(clipMembersOf(removeDoc(s, 'd1'), 'n1').sort()).toEqual(['d3', 'n1']);
    expect(removeNote(removeDoc(s, 'd1'), 'n1').clips).toHaveLength(0);
  });

  it('Commands addClip/removeClip über applyCommand', () => {
    const s = applyCommand(basis(), { type: 'addClip', payload: { aId: 'd1', bId: 'n1', id: 'c1' } });
    expect(s.clips).toHaveLength(1);
    expect(applyCommand(s, { type: 'removeClip', payload: { clipId: 'c1' } }).clips).toHaveLength(0);
  });
});
