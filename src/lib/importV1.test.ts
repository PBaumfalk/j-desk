import { describe, it, expect } from 'vitest';
import { parseV1, buildImportedState } from './importV1';

const v1 = {
  docs: [
    { id: 'id-a', path: '/tmp/a.pdf', position: { x: 1, y: 2 }, rotation: 1.5, zIndex: 1, missing: false },
    { id: 'id-b', path: '/tmp/b.pdf', position: { x: 3, y: 4 }, rotation: -1, zIndex: 2, missing: false },
    { id: 'id-c', path: '/tmp/fehlt.pdf', position: { x: 5, y: 6 }, rotation: 0, zIndex: 3, missing: true },
  ],
  links: [
    { id: 'l-1', fromId: 'id-a', toId: 'id-b', note: 'zusammen' },
    { id: 'l-2', fromId: 'id-a', toId: 'id-c', note: '' },
  ],
  stacks: [{ id: 'st-1', name: 'P', docIds: ['id-b', 'id-c'], position: { x: 0, y: 0 }, zIndex: 4 }],
};

describe('parseV1', () => {
  it('liest einen gültigen v1-Zustand und lehnt Müll ab', () => {
    expect(parseV1(JSON.stringify(v1))).not.toBeNull();
    expect(parseV1('{ kaputt')).toBeNull();
    expect(parseV1('{"docs":[{"id":5}],"links":[],"stacks":[]}')).toBeNull();
  });
});

describe('buildImportedState', () => {
  it('übernimmt hochgeladene Dokumente mit Position/Rotation/zIndex und Namen aus dem Pfad', () => {
    const map = new Map([['id-a', 'file-a'], ['id-b', 'file-b']]); // id-c fehlt lokal
    const s = buildImportedState(parseV1(JSON.stringify(v1))!, map);
    expect(s.docs).toHaveLength(2);
    expect(s.docs[0]).toMatchObject({ id: 'id-a', fileId: 'file-a', name: 'a.pdf', position: { x: 1, y: 2 } });
  });

  it('löst Stapel mit weniger als 2 überlebenden Mitgliedern auf und filtert Verknüpfungen', () => {
    const map = new Map([['id-a', 'file-a'], ['id-b', 'file-b']]);
    const s = buildImportedState(parseV1(JSON.stringify(v1))!, map);
    expect(s.stacks).toHaveLength(0); // st-1 hatte id-b + id-c, id-c fehlt → aufgelöst
    expect(s.links.map((l) => l.id)).toEqual(['l-1']); // l-2 zeigte auf id-c
  });

  it('behält Stapel mit 2+ überlebenden Mitgliedern samt Verknüpfung auf den Stapel', () => {
    const map = new Map([['id-a', 'file-a'], ['id-b', 'file-b'], ['id-c', 'file-c']]);
    const withStackLink = { ...v1, links: [...v1.links, { id: 'l-3', fromId: 'st-1', toId: 'id-a', note: '' }] };
    const s = buildImportedState(parseV1(JSON.stringify(withStackLink))!, map);
    expect(s.stacks).toHaveLength(1);
    expect(s.links.map((l) => l.id).sort()).toEqual(['l-1', 'l-2', 'l-3']);
  });
});
