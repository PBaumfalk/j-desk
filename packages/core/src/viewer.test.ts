import { describe, it, expect } from 'vitest';
import { emptyState } from './model';
import { addDoc } from './documents';
import { expandDoc, collapseDoc, setDocPage, resizeDoc, extractPage, DEFAULT_OPEN_SIZE } from './viewer';

const pos = { x: 0, y: 0 };
function withDoc() { return addDoc(emptyState(), 'file-a', 'a.pdf', pos, 'id-a'); }

describe('expandDoc', () => {
  it('schlägt ein Dokument auf und setzt Standardgröße + Seite 1', () => {
    const s = expandDoc(withDoc(), 'id-a');
    expect(s.docs[0].open).toBe(true);
    expect(s.docs[0].openSize).toEqual(DEFAULT_OPEN_SIZE);
    expect(s.docs[0].page).toBe(1);
  });

  it('behält vorhandene Größe und Seite beim erneuten Aufschlagen', () => {
    let s = expandDoc(withDoc(), 'id-a');
    s = resizeDoc(s, 'id-a', { w: 800, h: 600 });
    s = setDocPage(s, 'id-a', 4);
    s = collapseDoc(s, 'id-a');
    s = expandDoc(s, 'id-a');
    expect(s.docs[0].openSize).toEqual({ w: 800, h: 600 });
    expect(s.docs[0].page).toBe(4);
    expect(s.docs[0].open).toBe(true);
  });

  it('wirft bei unbekanntem Dokument', () => {
    expect(() => expandDoc(emptyState(), 'fehlt')).toThrow();
  });
});

describe('collapseDoc', () => {
  it('klappt zu, ohne Größe/Seite zu verlieren', () => {
    let s = setDocPage(expandDoc(withDoc(), 'id-a'), 'id-a', 2);
    s = collapseDoc(s, 'id-a');
    expect(s.docs[0].open).toBe(false);
    expect(s.docs[0].page).toBe(2);
  });
  it('wirft bei unbekanntem Dokument', () => {
    expect(() => collapseDoc(emptyState(), 'fehlt')).toThrow();
  });
});

describe('setDocPage', () => {
  it('setzt die Seite', () => {
    const s = setDocPage(expandDoc(withDoc(), 'id-a'), 'id-a', 7);
    expect(s.docs[0].page).toBe(7);
  });
  it('lehnt page < 1 und nicht-ganzzahlige Seiten ab', () => {
    const s = expandDoc(withDoc(), 'id-a');
    expect(() => setDocPage(s, 'id-a', 0)).toThrow();
    expect(() => setDocPage(s, 'id-a', -3)).toThrow();
    expect(() => setDocPage(s, 'id-a', 1.5)).toThrow();
  });
  it('wirft bei unbekanntem Dokument', () => {
    expect(() => setDocPage(emptyState(), 'fehlt', 1)).toThrow();
  });
});

describe('resizeDoc', () => {
  it('setzt die Größe', () => {
    const s = resizeDoc(expandDoc(withDoc(), 'id-a'), 'id-a', { w: 640, h: 480 });
    expect(s.docs[0].openSize).toEqual({ w: 640, h: 480 });
  });
  it('lehnt nicht-positive Maße ab', () => {
    const s = expandDoc(withDoc(), 'id-a');
    expect(() => resizeDoc(s, 'id-a', { w: 0, h: 480 })).toThrow();
    expect(() => resizeDoc(s, 'id-a', { w: 640, h: -1 })).toThrow();
  });
  it('wirft bei unbekanntem Dokument', () => {
    expect(() => resizeDoc(emptyState(), 'fehlt', { w: 640, h: 480 })).toThrow(/nicht gefunden/);
  });
});

describe('extractPage (Enthefterzange)', () => {
  it('löst eine Seite als eigene Karte heraus, Original bleibt', () => {
    const s0 = expandDoc(withDoc(), 'id-a');
    const s = extractPage(s0, 'id-a', 3, { x: 500, y: 100 }, 'seite-3');
    expect(s.docs).toHaveLength(2);
    const seite = s.docs.find((d) => d.id === 'seite-3')!;
    expect(seite).toMatchObject({ fileId: s0.docs[0].fileId, pageOnly: 3, position: { x: 500, y: 100 } });
    expect(seite.name).toContain('S. 3');
    expect(s.docs[0].pageOnly).toBeUndefined();
    expect(seite.zIndex).toBeGreaterThan(s.docs[0].zIndex);
  });

  it('wirft bei unbekanntem Dokument und ungültiger Seite', () => {
    expect(() => extractPage(emptyState(), 'nix', 1, { x: 0, y: 0 })).toThrow(/nicht gefunden/);
    expect(() => extractPage(withDoc(), 'id-a', 0, { x: 0, y: 0 })).toThrow(/Ungültige Seite/);
  });
});
