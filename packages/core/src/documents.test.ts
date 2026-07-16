import { describe, it, expect } from 'vitest';
import { emptyState } from './model';
import { addDoc, moveDoc, bringToFront, rotationFor } from './documents';

const pos = { x: 10, y: 20 };

describe('addDoc', () => {
  it('legt ein Dokument mit fileId, Name, Position, Rotation und zIndex 1 an', () => {
    const s = addDoc(emptyState(), 'file-a', 'a.pdf', pos, 'id-a');
    expect(s.docs).toHaveLength(1);
    expect(s.docs[0]).toMatchObject({ id: 'id-a', fileId: 'file-a', name: 'a.pdf', position: pos });
    expect(s.docs[0].zIndex).toBe(1);
  });

  it('vergibt aufsteigende zIndex-Werte', () => {
    let s = addDoc(emptyState(), 'file-a', 'a.pdf', pos, 'id-a');
    s = addDoc(s, 'file-b', 'b.pdf', pos, 'id-b');
    expect(s.docs[1].zIndex).toBe(2);
  });

  it('ignoriert eine Server-Datei, die schon auf dem Tisch liegt', () => {
    let s = addDoc(emptyState(), 'file-a', 'a.pdf', pos, 'id-a');
    s = addDoc(s, 'file-a', 'nochmal.pdf', { x: 0, y: 0 }, 'id-b');
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
    let s = addDoc(emptyState(), 'file-a', 'a.pdf', pos, 'id-a');
    s = moveDoc(s, 'id-a', { x: 99, y: 7 });
    expect(s.docs[0].position).toEqual({ x: 99, y: 7 });
  });

  it('hebt ein Dokument über alle anderen (auch Stapel)', () => {
    let s = addDoc(emptyState(), 'file-a', 'a.pdf', pos, 'id-a');
    s = addDoc(s, 'file-b', 'b.pdf', pos, 'id-b');
    s = { ...s, stacks: [{ id: 'st-1', name: '', docIds: [], position: pos, zIndex: 5 }] };
    s = bringToFront(s, 'id-a');
    expect(s.docs[0].zIndex).toBe(6);
  });

  it('hebt auch einen Stapel nach vorn', () => {
    let s = addDoc(emptyState(), 'file-a', 'a.pdf', pos, 'id-a');
    s = { ...s, stacks: [{ id: 'st-1', name: '', docIds: [], position: pos, zIndex: 0 }] };
    s = bringToFront(s, 'st-1');
    expect(s.stacks[0].zIndex).toBe(2);
  });
});
