import { describe, it, expect } from 'vitest';
import { emptyState, type DesktopState } from './model';
import { addDoc } from './documents';
import {
  addLink, setLinkNote, removeLink, removeLinksFor, linkedEntityIds, collectLinkedPaths,
} from './links';

function twoDocs(): DesktopState {
  let s = addDoc(emptyState(), '/tmp/a.pdf', { x: 0, y: 0 }, 'id-a');
  return addDoc(s, '/tmp/b.pdf', { x: 0, y: 0 }, 'id-b');
}

describe('addLink', () => {
  it('legt eine Verknüpfung mit leerer Notiz an', () => {
    const s = addLink(twoDocs(), 'id-a', 'id-b', 'l-1');
    expect(s.links).toEqual([{ id: 'l-1', fromId: 'id-a', toId: 'id-b', note: '' }]);
  });

  it('lehnt Selbstverknüpfung ab', () => {
    const s = addLink(twoDocs(), 'id-a', 'id-a', 'l-1');
    expect(s.links).toHaveLength(0);
  });

  it('lehnt Duplikate in beiden Richtungen ab', () => {
    let s = addLink(twoDocs(), 'id-a', 'id-b', 'l-1');
    s = addLink(s, 'id-a', 'id-b', 'l-2');
    s = addLink(s, 'id-b', 'id-a', 'l-3');
    expect(s.links).toHaveLength(1);
  });
});

describe('Notiz und Entfernen', () => {
  it('setzt eine Notiz', () => {
    let s = addLink(twoDocs(), 'id-a', 'id-b', 'l-1');
    s = setLinkNote(s, 'l-1', 'Rechnung zu Vertrag X');
    expect(s.links[0].note).toBe('Rechnung zu Vertrag X');
  });

  it('entfernt eine Verknüpfung per id', () => {
    let s = addLink(twoDocs(), 'id-a', 'id-b', 'l-1');
    s = removeLink(s, 'l-1');
    expect(s.links).toHaveLength(0);
  });

  it('entfernt alle Verknüpfungen einer Entität', () => {
    let s = addDoc(twoDocs(), '/tmp/c.pdf', { x: 0, y: 0 }, 'id-c');
    s = addLink(s, 'id-a', 'id-b', 'l-1');
    s = addLink(s, 'id-c', 'id-a', 'l-2');
    s = addLink(s, 'id-b', 'id-c', 'l-3');
    s = removeLinksFor(s, 'id-a');
    expect(s.links.map((l) => l.id)).toEqual(['l-3']);
  });
});

describe('linkedEntityIds / collectLinkedPaths', () => {
  it('liefert die Gegenseiten aller Verknüpfungen', () => {
    let s = addDoc(twoDocs(), '/tmp/c.pdf', { x: 0, y: 0 }, 'id-c');
    s = addLink(s, 'id-a', 'id-b', 'l-1');
    s = addLink(s, 'id-c', 'id-a', 'l-2');
    expect(linkedEntityIds(s, 'id-a').sort()).toEqual(['id-b', 'id-c']);
  });

  it('sammelt eigenen Pfad plus verknüpfte, Stapel aufgelöst, ohne fehlende Dateien', () => {
    let s = addDoc(twoDocs(), '/tmp/c.pdf', { x: 0, y: 0 }, 'id-c');
    s = addDoc(s, '/tmp/d.pdf', { x: 0, y: 0 }, 'id-d');
    s = {
      ...s,
      docs: s.docs.map((d) => (d.id === 'id-d' ? { ...d, missing: true } : d)),
      stacks: [{ id: 'st-1', name: '', docIds: ['id-c', 'id-d'], position: { x: 0, y: 0 }, zIndex: 0 }],
    };
    s = addLink(s, 'id-a', 'st-1', 'l-1');
    expect(collectLinkedPaths(s, 'id-a').sort()).toEqual(['/tmp/a.pdf', '/tmp/c.pdf']);
  });
});
