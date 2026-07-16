import { describe, it, expect } from 'vitest';
import { emptyState, findStack, type DesktopState } from './model';
import { addDoc } from './documents';
import { addLink } from './links';
import { stackDocs } from './stacks';
import { removeDoc, removeStack } from './removal';

function base(): DesktopState {
  let s = emptyState();
  for (let i = 0; i < 4; i++) s = addDoc(s, `/tmp/${i}.pdf`, { x: 0, y: 0 }, `id-${i}`);
  return s;
}

describe('removeDoc', () => {
  it('entfernt Dokument und alle daran hängenden Verknüpfungen', () => {
    let s = addLink(base(), 'id-0', 'id-1', 'l-1');
    s = addLink(s, 'id-2', 'id-0', 'l-2');
    s = addLink(s, 'id-1', 'id-2', 'l-3');
    s = removeDoc(s, 'id-0');
    expect(s.docs.map((d) => d.id)).toEqual(['id-1', 'id-2', 'id-3']);
    expect(s.links.map((l) => l.id)).toEqual(['l-3']);
  });

  it('nimmt das Dokument aus einem 3er-Stapel, Stapel bleibt bestehen', () => {
    let s = stackDocs(base(), 'id-1', 'id-0', 'st-1');
    s = stackDocs(s, 'id-2', 'st-1');
    s = removeDoc(s, 'id-1');
    expect(findStack(s, 'st-1')!.docIds).toEqual(['id-0', 'id-2']);
  });

  it('löst einen 2er-Stapel auf, wenn ein Dokument entfernt wird', () => {
    let s = stackDocs(base(), 'id-1', 'id-0', 'st-1');
    s = removeDoc(s, 'id-1');
    expect(s.stacks).toHaveLength(0);
    expect(s.docs.some((d) => d.id === 'id-0')).toBe(true);
  });
});

describe('removeStack', () => {
  it('entfernt Stapel, enthaltene Dokumente und alle betroffenen Verknüpfungen', () => {
    let s = stackDocs(base(), 'id-1', 'id-0', 'st-1');
    s = addLink(s, 'st-1', 'id-2', 'l-1');   // am Stapel
    s = addLink(s, 'id-0', 'id-3', 'l-2');   // an enthaltenem Dokument
    s = addLink(s, 'id-2', 'id-3', 'l-3');   // unbeteiligt
    s = removeStack(s, 'st-1');
    expect(s.stacks).toHaveLength(0);
    expect(s.docs.map((d) => d.id)).toEqual(['id-2', 'id-3']);
    expect(s.links.map((l) => l.id)).toEqual(['l-3']);
  });
});
