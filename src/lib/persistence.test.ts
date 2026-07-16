import { describe, it, expect } from 'vitest';
import { emptyState } from './state/model';
import { addDoc } from './state/documents';
import { deserialize } from './persistence';

describe('deserialize', () => {
  it('liest einen gültigen Zustand', () => {
    const s = addDoc(emptyState(), '/tmp/a.pdf', { x: 1, y: 2 }, 'id-a');
    expect(deserialize(JSON.stringify(s))).toEqual(s);
  });

  it('liefert null bei kaputtem JSON', () => {
    expect(deserialize('{ kaputt')).toBeNull();
  });

  it('liefert null bei falscher Struktur', () => {
    expect(deserialize('{"docs": 5}')).toBeNull();
    expect(deserialize('null')).toBeNull();
    expect(deserialize('{"docs": [], "links": []}')).toBeNull();
  });
});
