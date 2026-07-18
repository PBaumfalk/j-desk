import { describe, it, expect } from 'vitest';
import { emptyState, type DesktopState } from './model';
import { addDoc } from './documents';
import { addStroke, removeStroke, strokesFor, type Stroke } from './ink';

function base(): DesktopState {
  return addDoc(emptyState(), 'file-a', 'a.pdf', { x: 0, y: 0 }, 'doc-a');
}

const stroke = (over: Partial<Stroke> = {}): Omit<Stroke, 'id'> & { id?: string } => ({
  docId: 'doc-a',
  page: 1,
  tool: 'pen',
  color: '#1d3557',
  width: 1.5,
  points: [
    { x: 10, y: 10 },
    { x: 20, y: 25 },
  ],
  ...over,
});

describe('addStroke', () => {
  it('fügt einen Strich hinzu und vergibt eine id, wenn keine mitkommt', () => {
    const s = addStroke(base(), stroke());
    expect(s.strokes).toHaveLength(1);
    expect(s.strokes![0].id).toBeTruthy();
    expect(s.strokes![0].points).toHaveLength(2);
  });

  it('übernimmt eine mitgegebene id', () => {
    const s = addStroke(base(), stroke({ id: 'st-1' }));
    expect(s.strokes![0].id).toBe('st-1');
  });

  it('funktioniert auf alten States ohne strokes-Feld', () => {
    const alt = { ...base() } as DesktopState;
    delete (alt as { strokes?: unknown }).strokes;
    const s = addStroke(alt, stroke());
    expect(s.strokes).toHaveLength(1);
  });

  it('wirft bei unbekanntem Dokument', () => {
    expect(() => addStroke(base(), stroke({ docId: 'nix' }))).toThrow(/nicht gefunden/);
  });

  it('wirft bei ungültiger Seite, zu wenig Punkten, unendlichen Koordinaten und width <= 0', () => {
    expect(() => addStroke(base(), stroke({ page: 0 }))).toThrow();
    expect(() => addStroke(base(), stroke({ page: 1.5 }))).toThrow();
    expect(() => addStroke(base(), stroke({ points: [{ x: 1, y: 1 }] }))).toThrow();
    expect(() => addStroke(base(), stroke({ points: [{ x: 1, y: 1 }, { x: Infinity, y: 2 }] }))).toThrow();
    expect(() => addStroke(base(), stroke({ width: 0 }))).toThrow();
  });
});

describe('removeStroke', () => {
  it('entfernt genau den Strich mit der id', () => {
    let s = addStroke(base(), stroke({ id: 'st-1' }));
    s = addStroke(s, stroke({ id: 'st-2', page: 2 }));
    s = removeStroke(s, 'st-1');
    expect(s.strokes!.map((x) => x.id)).toEqual(['st-2']);
  });

  it('wirft bei unbekannter id', () => {
    expect(() => removeStroke(base(), 'nix')).toThrow(/nicht gefunden/);
  });
});

describe('strokesFor', () => {
  it('liefert nur die Striche der angefragten Seite des Dokuments', () => {
    let s = addStroke(base(), stroke({ id: 'p1' }));
    s = addStroke(s, stroke({ id: 'p2', page: 2 }));
    expect(strokesFor(s, 'doc-a', 1).map((x) => x.id)).toEqual(['p1']);
    expect(strokesFor(s, 'doc-a', 2).map((x) => x.id)).toEqual(['p2']);
    expect(strokesFor(s, 'doc-b', 1)).toEqual([]);
  });

  it('liefert [] auf alten States ohne strokes-Feld', () => {
    const alt = { ...base() } as DesktopState;
    delete (alt as { strokes?: unknown }).strokes;
    expect(strokesFor(alt, 'doc-a', 1)).toEqual([]);
  });
});

describe('Entfernen von Dokumenten', () => {
  it('removeDoc räumt auch dessen Striche ab', async () => {
    const { removeDoc } = await import('./removal');
    let s = addStroke(base(), stroke({ id: 'st-1' }));
    s = removeDoc(s, 'doc-a');
    expect(s.strokes ?? []).toEqual([]);
  });
});
