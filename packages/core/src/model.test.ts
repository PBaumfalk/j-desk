import { describe, it, expect } from 'vitest';
import { emptyState, isValidState } from './model';
import { addDoc } from './documents';

describe('isValidState', () => {
  it('akzeptiert einen gültigen Zustand', () => {
    const s = addDoc(emptyState(), 'file-a', 'a.pdf', { x: 1, y: 2 }, 'id-a');
    expect(isValidState(JSON.parse(JSON.stringify(s)))).toBe(true);
  });

  it('lehnt Nicht-Objekte und falsche Strukturen ab', () => {
    expect(isValidState(null)).toBe(false);
    expect(isValidState({ docs: 5 })).toBe(false);
    expect(isValidState({ docs: [], links: [] })).toBe(false);
    expect(isValidState({ docs: [{ id: 'x' }], links: [], stacks: [] })).toBe(false);
  });
});
