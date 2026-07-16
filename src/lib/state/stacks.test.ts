import { describe, it, expect } from 'vitest';
import { emptyState, findStack, stackOf, type DesktopState } from './model';
import { addDoc } from './documents';
import { addLink } from './links';
import { stackDocs, removeFromStack, dissolveStack, renameStack, moveStack } from './stacks';

function docs(n: number): DesktopState {
  let s = emptyState();
  for (let i = 0; i < n; i++) s = addDoc(s, `/tmp/${i}.pdf`, { x: i * 10, y: i * 10 }, `id-${i}`);
  return s;
}

describe('stackDocs', () => {
  it('erzeugt aus zwei freien Dokumenten einen Stapel an der Zielposition', () => {
    const s = stackDocs(docs(2), 'id-1', 'id-0', 'st-1');
    expect(s.stacks).toHaveLength(1);
    expect(s.stacks[0]).toMatchObject({ id: 'st-1', docIds: ['id-0', 'id-1'], position: { x: 0, y: 0 } });
  });

  it('legt ein Dokument oben auf einen bestehenden Stapel (Ziel = Stack-id)', () => {
    let s = stackDocs(docs(3), 'id-1', 'id-0', 'st-1');
    s = stackDocs(s, 'id-2', 'st-1');
    expect(findStack(s, 'st-1')!.docIds).toEqual(['id-0', 'id-1', 'id-2']);
  });

  it('legt ein Dokument auf den Stapel, wenn das Ziel-Dokument gestapelt ist', () => {
    let s = stackDocs(docs(3), 'id-1', 'id-0', 'st-1');
    s = stackDocs(s, 'id-2', 'id-0');
    expect(findStack(s, 'st-1')!.docIds).toEqual(['id-0', 'id-1', 'id-2']);
  });

  it('ändert nichts, wenn das gezogene Dokument selbst gestapelt ist oder Ziel = Quelle', () => {
    let s = stackDocs(docs(3), 'id-1', 'id-0', 'st-1');
    expect(stackDocs(s, 'id-1', 'id-2')).toBe(s);
    expect(stackDocs(s, 'id-2', 'id-2')).toBe(s);
  });
});

describe('removeFromStack', () => {
  it('nimmt ein Dokument heraus und setzt es an die neue Position', () => {
    let s = stackDocs(docs(3), 'id-1', 'id-0', 'st-1');
    s = stackDocs(s, 'id-2', 'st-1');
    s = removeFromStack(s, 'id-1', { x: 500, y: 500 });
    expect(stackOf(s, 'id-1')).toBeUndefined();
    expect(s.docs.find((d) => d.id === 'id-1')!.position).toEqual({ x: 500, y: 500 });
    expect(findStack(s, 'st-1')!.docIds).toEqual(['id-0', 'id-2']);
  });

  it('löst den Stapel auf, wenn nur ein Dokument übrig bleibt', () => {
    let s = stackDocs(docs(2), 'id-1', 'id-0', 'st-1');
    s = addLink(s, 'st-1', 'id-1', 'l-1'); // hängt am Stapel
    s = removeFromStack(s, 'id-1', { x: 500, y: 500 });
    expect(s.stacks).toHaveLength(0);
    expect(s.links).toHaveLength(0); // Stapel-Verknüpfung mit entfernt
    expect(stackOf(s, 'id-0')).toBeUndefined();
  });
});

describe('dissolveStack', () => {
  it('legt die Dokumente versetzt nebeneinander und entfernt Stapel samt Stapel-Verknüpfungen', () => {
    let s = stackDocs(docs(3), 'id-1', 'id-0', 'st-1');
    s = stackDocs(s, 'id-2', 'st-1');
    s = addLink(s, 'st-1', 'id-2', 'l-1');
    s = dissolveStack(s, 'st-1');
    expect(s.stacks).toHaveLength(0);
    expect(s.links).toHaveLength(0);
    const ps = ['id-0', 'id-1', 'id-2'].map((id) => s.docs.find((d) => d.id === id)!.position);
    expect(ps[0]).toEqual({ x: 0, y: 0 });
    expect(ps[1]).toEqual({ x: 40, y: 24 });
    expect(ps[2]).toEqual({ x: 80, y: 48 });
  });
});

describe('renameStack / moveStack', () => {
  it('benennt und verschiebt einen Stapel', () => {
    let s = stackDocs(docs(2), 'id-1', 'id-0', 'st-1');
    s = renameStack(s, 'st-1', 'Projekt X');
    s = moveStack(s, 'st-1', { x: 7, y: 8 });
    expect(findStack(s, 'st-1')).toMatchObject({ name: 'Projekt X', position: { x: 7, y: 8 } });
  });
});
