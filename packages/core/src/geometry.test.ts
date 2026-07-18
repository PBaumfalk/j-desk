import { describe, it, expect } from 'vitest';
import { emptyState, CARD_W, CARD_H, type DesktopState } from './model';
import { addDoc } from './documents';
import { stackDocs } from './stacks';
import { expandDoc, resizeDoc, DEFAULT_OPEN_SIZE } from './viewer';
import { docBox, stackBox, allBoxes, hitTest } from './geometry';

function base(): DesktopState {
  let s = addDoc(emptyState(), 'file-a', 'a.pdf', { x: 0, y: 0 }, 'id-a');
  s = addDoc(s, 'file-b', 'b.pdf', { x: 50, y: 50 }, 'id-b');
  return addDoc(s, 'file-c', 'c.pdf', { x: 1000, y: 1000 }, 'id-c');
}

describe('Boxen', () => {
  it('docBox nutzt Kartenmaße, stackBox hat 24 px Versatzrand', () => {
    const s = base();
    expect(docBox(s.docs[0])).toEqual({ x: 0, y: 0, w: CARD_W, h: CARD_H });
    const st = { id: 'st', name: '', docIds: [], position: { x: 5, y: 6 }, zIndex: 0 };
    expect(stackBox(st)).toEqual({ x: 5, y: 6, w: CARD_W + 24, h: CARD_H + 24 });
  });

  it('allBoxes enthält freie Dokumente und Stapel, keine gestapelten Dokumente', () => {
    const s = stackDocs(base(), 'id-b', 'id-a', 'st-1');
    expect(allBoxes(s)).toHaveLength(2); // id-c frei + st-1
  });

  it('docBox nutzt bei aufgeschlagenen Dokumenten die Viewer-Größe', () => {
    let s = expandDoc(base(), 'id-a');
    expect(docBox(s.docs[0])).toEqual({ x: 0, y: 0, w: DEFAULT_OPEN_SIZE.w, h: DEFAULT_OPEN_SIZE.h });
    s = resizeDoc(s, 'id-a', { w: 300, h: 400 });
    expect(docBox(s.docs[0])).toEqual({ x: 0, y: 0, w: 300, h: 400 });
  });

  it('zugeklappte Dokumente behalten die Miniatur-Box trotz gemerkter openSize', () => {
    let s = expandDoc(base(), 'id-a');
    s = { ...s, docs: s.docs.map((d) => (d.id === 'id-a' ? { ...d, open: false } : d)) };
    expect(docBox(s.docs[0])).toEqual({ x: 0, y: 0, w: CARD_W, h: CARD_H });
  });
});

describe('hitTest', () => {
  it('trifft das oberste Element (höchster zIndex) und ignoriert excludeId', () => {
    const s = base(); // id-b (z=2) überlappt id-a (z=1) bei (60, 60)
    expect(hitTest(s, { x: 60, y: 60 }, 'id-x')).toEqual({ kind: 'doc', id: 'id-b' });
    expect(hitTest(s, { x: 60, y: 60 }, 'id-b')).toEqual({ kind: 'doc', id: 'id-a' });
  });

  it('trifft Stapel statt der enthaltenen Dokumente und null bei Leerraum', () => {
    const s = stackDocs(base(), 'id-b', 'id-a', 'st-1');
    expect(hitTest(s, { x: 10, y: 10 }, 'id-x')).toEqual({ kind: 'stack', id: 'st-1' });
    expect(hitTest(s, { x: 5000, y: 5000 }, 'id-x')).toBeNull();
  });

  it('aufgeschlagene Dokumente sind kein Stapelziel', () => {
    const s = expandDoc(base(), 'id-c'); // liegt frei bei (1000, 1000)
    expect(hitTest(s, { x: 1010, y: 1010 }, 'id-x')).toBeNull();
  });
});
