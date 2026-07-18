import { describe, it, expect } from 'vitest';
import { emptyState } from './model';
import { addDoc } from './documents';
import { addLink } from './links';
import { addCutout, moveCutout, removeCutout, cutoutBox } from './cutouts';

const base = () => addDoc(emptyState(), 'file-a', 'a.pdf', { x: 0, y: 0 }, 'doc-a');
const bild = () => addDoc(emptyState(), 'file-b', 'foto.jpg', { x: 0, y: 0 }, 'doc-b', 'image');

describe('cutouts', () => {
  it('addCutout übernimmt fileId der Quelle und legt in Originalgröße ab', () => {
    const s = addCutout(base(), 'doc-a', 2, { x: 10, y: 20, w: 120, h: 60 }, { x: 400, y: 50 }, 'cut-1');
    expect(s.cutouts![0]).toMatchObject({ id: 'cut-1', fileId: 'file-a', page: 2 });
    expect(cutoutBox(s.cutouts![0])).toEqual({ x: 400, y: 50, w: 120, h: 60 });
  });

  it('addCutout von einem Bild-Doc übernimmt kind und sourceName', () => {
    const s = addCutout(bild(), 'doc-b', 1, { x: 0, y: 0, w: 50, h: 50 }, { x: 0, y: 0 }, 'cut-img');
    expect(s.cutouts![0]).toMatchObject({ kind: 'image', sourceName: 'foto.jpg' });
  });

  it('addCutout von einem kind-losen Doc trägt weder kind noch sourceName (Alt-Semantik)', () => {
    const s = addCutout(base(), 'doc-a', 1, { x: 0, y: 0, w: 50, h: 50 }, { x: 0, y: 0 }, 'cut-alt');
    expect(s.cutouts![0]).not.toHaveProperty('kind');
    expect(s.cutouts![0]).not.toHaveProperty('sourceName');
  });

  it('validiert Quelle, Seite und Rechteck', () => {
    expect(() => addCutout(base(), 'nix', 1, { x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 0 })).toThrow(/nicht gefunden/);
    expect(() => addCutout(base(), 'doc-a', 0, { x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 0 })).toThrow();
    expect(() => addCutout(base(), 'doc-a', 1, { x: 0, y: 0, w: 0, h: 10 }, { x: 0, y: 0 })).toThrow(/Ausschnitt/);
  });

  it('moveCutout verschiebt, removeCutout entfernt samt Schnüren', () => {
    let s = addCutout(base(), 'doc-a', 1, { x: 0, y: 0, w: 50, h: 50 }, { x: 0, y: 0 }, 'cut-1');
    s = moveCutout(s, 'cut-1', { x: 9, y: 9 });
    expect(s.cutouts![0].position).toEqual({ x: 9, y: 9 });
    s = addLink(s, 'cut-1', 'doc-a', 'l-1');
    s = removeCutout(s, 'cut-1');
    expect(s.cutouts).toEqual([]);
    expect(s.links).toEqual([]);
  });
});
