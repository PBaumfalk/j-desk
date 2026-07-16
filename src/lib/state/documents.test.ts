import { describe, it, expect } from 'vitest';
import { emptyState } from './model';
import { addDoc, moveDoc, bringToFront, setDocPath, setMissing, rotationFor } from './documents';

const pos = { x: 10, y: 20 };

describe('addDoc', () => {
  it('legt ein Dokument mit Position, Rotation und zIndex 1 an', () => {
    const s = addDoc(emptyState(), '/tmp/a.pdf', pos, 'id-a');
    expect(s.docs).toHaveLength(1);
    expect(s.docs[0]).toMatchObject({ id: 'id-a', path: '/tmp/a.pdf', position: pos, missing: false });
    expect(s.docs[0].zIndex).toBe(1);
  });

  it('vergibt aufsteigende zIndex-Werte', () => {
    let s = addDoc(emptyState(), '/tmp/a.pdf', pos, 'id-a');
    s = addDoc(s, '/tmp/b.pdf', pos, 'id-b');
    expect(s.docs[1].zIndex).toBe(2);
  });

  it('ignoriert eine Datei, die schon auf dem Tisch liegt', () => {
    let s = addDoc(emptyState(), '/tmp/a.pdf', pos, 'id-a');
    s = addDoc(s, '/tmp/a.pdf', { x: 0, y: 0 }, 'id-b');
    expect(s.docs).toHaveLength(1);
  });
});

describe('rotationFor', () => {
  it('ist deterministisch und liegt in [-3, 3] Grad', () => {
    expect(rotationFor('id-a')).toBe(rotationFor('id-a'));
    for (const id of ['a', 'b', 'c', 'id-xyz']) {
      expect(Math.abs(rotationFor(id))).toBeLessThanOrEqual(3);
    }
  });
});

describe('moveDoc / bringToFront', () => {
  it('verschiebt ein Dokument', () => {
    let s = addDoc(emptyState(), '/tmp/a.pdf', pos, 'id-a');
    s = moveDoc(s, 'id-a', { x: 99, y: 7 });
    expect(s.docs[0].position).toEqual({ x: 99, y: 7 });
  });

  it('hebt ein Dokument über alle anderen (auch Stapel)', () => {
    let s = addDoc(emptyState(), '/tmp/a.pdf', pos, 'id-a');
    s = addDoc(s, '/tmp/b.pdf', pos, 'id-b');
    s = { ...s, stacks: [{ id: 'st-1', name: '', docIds: [], position: pos, zIndex: 5 }] };
    s = bringToFront(s, 'id-a');
    expect(s.docs[0].zIndex).toBe(6);
  });

  it('hebt auch einen Stapel nach vorn', () => {
    let s = addDoc(emptyState(), '/tmp/a.pdf', pos, 'id-a');
    s = { ...s, stacks: [{ id: 'st-1', name: '', docIds: [], position: pos, zIndex: 0 }] };
    s = bringToFront(s, 'st-1');
    expect(s.stacks[0].zIndex).toBe(2);
  });
});

describe('setDocPath / setMissing', () => {
  it('setzt neuen Pfad und löscht die missing-Markierung', () => {
    let s = addDoc(emptyState(), '/tmp/a.pdf', pos, 'id-a');
    s = setMissing(s, 'id-a', true);
    expect(s.docs[0].missing).toBe(true);
    s = setDocPath(s, 'id-a', '/tmp/neu.pdf');
    expect(s.docs[0]).toMatchObject({ path: '/tmp/neu.pdf', missing: false });
  });
});
