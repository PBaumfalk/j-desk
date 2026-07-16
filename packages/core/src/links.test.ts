import { describe, it, expect } from 'vitest';
import { emptyState, type DesktopState } from './model';
import { addDoc } from './documents';
import {
  addLink, setLinkNote, removeLink, removeLinksFor, linkedEntityIds, collectLinkedDocs,
} from './links';

function docs(n: number): DesktopState {
  let s = emptyState();
  for (let i = 0; i < n; i++) s = addDoc(s, `file-${i}`, `${i}.pdf`, { x: 0, y: 0 }, `id-${i}`);
  return s;
}

describe('addLink', () => {
  it('legt eine Verknüpfung mit leerer Notiz an', () => {
    const s = addLink(docs(2), 'id-0', 'id-1', 'l-1');
    expect(s.links).toEqual([{ id: 'l-1', fromId: 'id-0', toId: 'id-1', note: '' }]);
  });

  it('lehnt Selbstverknüpfung ab', () => {
    const s = addLink(docs(2), 'id-0', 'id-0', 'l-1');
    expect(s.links).toHaveLength(0);
  });

  it('lehnt Duplikate in beiden Richtungen ab', () => {
    let s = addLink(docs(2), 'id-0', 'id-1', 'l-1');
    s = addLink(s, 'id-0', 'id-1', 'l-2');
    s = addLink(s, 'id-1', 'id-0', 'l-3');
    expect(s.links).toHaveLength(1);
  });
});

describe('Notiz und Entfernen', () => {
  it('setzt eine Notiz', () => {
    let s = addLink(docs(2), 'id-0', 'id-1', 'l-1');
    s = setLinkNote(s, 'l-1', 'Rechnung zu Vertrag X');
    expect(s.links[0].note).toBe('Rechnung zu Vertrag X');
  });

  it('entfernt eine Verknüpfung per id', () => {
    let s = addLink(docs(2), 'id-0', 'id-1', 'l-1');
    s = removeLink(s, 'l-1');
    expect(s.links).toHaveLength(0);
  });

  it('entfernt alle Verknüpfungen einer Entität', () => {
    let s = docs(3);
    s = addLink(s, 'id-0', 'id-1', 'l-1');
    s = addLink(s, 'id-2', 'id-0', 'l-2');
    s = addLink(s, 'id-1', 'id-2', 'l-3');
    s = removeLinksFor(s, 'id-0');
    expect(s.links.map((l) => l.id)).toEqual(['l-3']);
  });
});

describe('linkedEntityIds / collectLinkedDocs', () => {
  it('liefert die Gegenseiten aller Verknüpfungen', () => {
    let s = docs(3);
    s = addLink(s, 'id-0', 'id-1', 'l-1');
    s = addLink(s, 'id-2', 'id-0', 'l-2');
    expect(linkedEntityIds(s, 'id-0').sort()).toEqual(['id-1', 'id-2']);
  });

  it('sammelt das Dokument selbst plus Verknüpfte, Stapel expandiert, dedupliziert', () => {
    let s = docs(4);
    s = {
      ...s,
      stacks: [{ id: 'st-1', name: '', docIds: ['id-2', 'id-3'], position: { x: 0, y: 0 }, zIndex: 0 }],
    };
    s = addLink(s, 'id-0', 'st-1', 'l-1');
    s = addLink(s, 'id-0', 'id-2', 'l-2'); // id-2 steckt im Stapel → darf nicht doppelt erscheinen
    expect(collectLinkedDocs(s, 'id-0').map((d) => d.id).sort()).toEqual(['id-0', 'id-2', 'id-3']);
  });
});
