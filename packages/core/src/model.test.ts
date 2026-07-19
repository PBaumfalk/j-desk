import { describe, it, expect } from 'vitest';
import { emptyState, isValidState } from './model';
import { addDoc } from './documents';

describe('isValidState', () => {
  it('akzeptiert einen gültigen Zustand', () => {
    const s = addDoc(emptyState(), 'file-a', 'a.pdf', { x: 1, y: 2 }, 'id-a');
    expect(isValidState(JSON.parse(JSON.stringify(s)))).toBe(true);
    // emptyState soll marks, stamps, flags, clips und trash enthalten
    expect(emptyState()).toMatchObject({ marks: [], stamps: [], flags: [], clips: [], trash: [] });
  });

  it('lehnt Nicht-Objekte und falsche Strukturen ab', () => {
    expect(isValidState(null)).toBe(false);
    expect(isValidState({ docs: 5 })).toBe(false);
    expect(isValidState({ docs: [], links: [] })).toBe(false);
    expect(isValidState({ docs: [{ id: 'x' }], links: [], stacks: [] })).toBe(false);
  });

  it('akzeptiert fehlendes strokes-Feld, lehnt Nicht-Array ab', () => {
    expect(isValidState({ docs: [], links: [], stacks: [] })).toBe(true);
    expect(isValidState({ docs: [], links: [], stacks: [], strokes: [] })).toBe(true);
    expect(isValidState({ docs: [], links: [], stacks: [], strokes: 'kritzel' })).toBe(false);
  });
});

describe('Doc-Viewer-Felder (Abwärtskompatibilität)', () => {
  it('akzeptiert einen Zustand OHNE die neuen Viewer-Felder', () => {
    const s = { docs: [{ id: 'a', fileId: 'f', name: 'a.pdf', position: { x: 0, y: 0 }, rotation: 0, zIndex: 1 }], links: [], stacks: [] };
    expect(isValidState(s)).toBe(true);
  });

  it('akzeptiert einen Zustand MIT open/openSize/page', () => {
    const s = { docs: [{ id: 'a', fileId: 'f', name: 'a.pdf', position: { x: 0, y: 0 }, rotation: 0, zIndex: 1, open: true, openSize: { w: 560, h: 720 }, page: 3 }], links: [], stacks: [] };
    expect(isValidState(s)).toBe(true);
  });
});
