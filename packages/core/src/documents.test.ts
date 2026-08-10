import { describe, it, expect } from 'vitest';
import { emptyState } from './model';
import { addDoc, moveDoc, bringToFront, rotationFor, setDocLandscape } from './documents';
import { applyCommand } from './commands';
import { addLegalObject } from './legalObjects';
import { addTable } from './tables';

const pos = { x: 10, y: 20 };

describe('addDoc', () => {
  it('legt ein Dokument mit fileId, Name, Position, Rotation und zIndex 1 an', () => {
    const s = addDoc(emptyState(), 'file-a', 'a.pdf', pos, 'id-a');
    expect(s.docs).toHaveLength(1);
    expect(s.docs[0]).toMatchObject({ id: 'id-a', fileId: 'file-a', name: 'a.pdf', position: pos });
    expect(s.docs[0].zIndex).toBe(1);
  });

  it('vergibt aufsteigende zIndex-Werte', () => {
    let s = addDoc(emptyState(), 'file-a', 'a.pdf', pos, 'id-a');
    s = addDoc(s, 'file-b', 'b.pdf', pos, 'id-b');
    expect(s.docs[1].zIndex).toBe(2);
  });

  it('ignoriert eine Server-Datei, die schon auf dem Tisch liegt', () => {
    let s = addDoc(emptyState(), 'file-a', 'a.pdf', pos, 'id-a');
    s = addDoc(s, 'file-a', 'nochmal.pdf', { x: 0, y: 0 }, 'id-b');
    expect(s.docs).toHaveLength(1);
  });

  it('addDoc übernimmt die Datei-Art; ungültige Art wirft', () => {
    const s = addDoc(emptyState(), 'f1', 'foto.jpg', { x: 0, y: 0 }, 'd1', 'image');
    expect(s.docs[0].kind).toBe('image');
    const ohne = addDoc(emptyState(), 'f2', 'a.pdf', { x: 0, y: 0 }, 'd2');
    expect(ohne.docs[0].kind).toBeUndefined(); // fehlend = pdf (Alt-State-Semantik)
    expect(() => addDoc(emptyState(), 'f3', 'x', { x: 0, y: 0 }, 'd3', 'exe' as never)).toThrow('Datei-Art');
  });

  it('addDoc-Command reicht kind durch', () => {
    const s = applyCommand(emptyState(), { type: 'addDoc', payload: { fileId: 'f1', name: 'foto.jpg', position: { x: 0, y: 0 }, id: 'd1', kind: 'image' } });
    expect(s.docs[0].kind).toBe('image');
  });
});

describe('rotationFor', () => {
  it('ist deterministisch und liegt in [-3, 3] Grad', () => {
    expect(rotationFor('id-a')).toBe(rotationFor('id-a'));
    for (const id of ['a', 'b', 'c', 'id-xyz']) {
      expect(Math.abs(rotationFor(id))).toBeLessThanOrEqual(3);
    }
  });
});

describe('moveDoc / bringToFront', () => {
  it('verschiebt ein Dokument', () => {
    let s = addDoc(emptyState(), 'file-a', 'a.pdf', pos, 'id-a');
    s = moveDoc(s, 'id-a', { x: 99, y: 7 });
    expect(s.docs[0].position).toEqual({ x: 99, y: 7 });
  });

  it('hebt ein Dokument über alle anderen (auch Stapel)', () => {
    let s = addDoc(emptyState(), 'file-a', 'a.pdf', pos, 'id-a');
    s = addDoc(s, 'file-b', 'b.pdf', pos, 'id-b');
    s = { ...s, stacks: [{ id: 'st-1', name: '', docIds: [], position: pos, zIndex: 5 }] };
    s = bringToFront(s, 'id-a');
    expect(s.docs[0].zIndex).toBe(6);
  });

  it('hebt auch einen Stapel nach vorn', () => {
    let s = addDoc(emptyState(), 'file-a', 'a.pdf', pos, 'id-a');
    s = { ...s, stacks: [{ id: 'st-1', name: '', docIds: [], position: pos, zIndex: 0 }] };
    s = bringToFront(s, 'st-1');
    expect(s.stacks[0].zIndex).toBe(2);
  });

  // CR-02: bringToFront() nahm legalObjects nicht in die Objektarten auf, obwohl maxZ() sie
  // bereits berücksichtigte — ein juristisches Objekt blieb dauerhaft hinter überlappenden
  // Karten hängen (kein Effekt statt eines gehobenen zIndex). Regressionstest analog zum
  // Stapel-Fall oben: Doc liegt mit höherem zIndex "über" dem juristischen Objekt, danach
  // muss bringToFront das Objekt darüber heben.
  it('hebt auch ein juristisches Objekt nach vorn', () => {
    let s = addDoc(emptyState(), 'file-a', 'a.pdf', pos, 'id-a');
    s = addLegalObject(s, 'tatsache', 'Ein Objekt', pos, 'lo-1');
    s = { ...s, legalObjects: s.legalObjects!.map((o) => ({ ...o, zIndex: 0 })) };
    s = bringToFront(s, 'lo-1');
    expect(s.legalObjects![0].zIndex).toBeGreaterThan(s.docs[0].zIndex);
  });

  it('hebt auch eine Tabellenkarte nach vorn', () => {
    let s = addDoc(emptyState(), 'file-a', 'a.pdf', pos, 'id-a');
    s = addTable(s, pos, 'tb-1');
    s = { ...s, tables: s.tables!.map((t) => ({ ...t, zIndex: 0 })) };
    s = bringToFront(s, 'tb-1');
    expect(s.tables![0].zIndex).toBeGreaterThan(s.docs[0].zIndex);
  });
});

describe('setDocLandscape', () => {
  it('setzt landscape einmalig', () => {
    let s = applyCommand(emptyState(), { type: 'addDoc', payload: { fileId: 'f1', name: 'a.pdf', position: { x: 0, y: 0 }, id: 'd1' } });
    s = setDocLandscape(s, 'd1');
    expect(s.docs[0].landscape).toBe(true);
  });

  it('ist idempotent: bereits gesetzt oder Doc fehlt = unverändertes Objekt', () => {
    let s = applyCommand(emptyState(), { type: 'addDoc', payload: { fileId: 'f1', name: 'a.pdf', position: { x: 0, y: 0 }, id: 'd1' } });
    s = setDocLandscape(s, 'd1');
    expect(setDocLandscape(s, 'd1')).toBe(s);
    expect(setDocLandscape(s, 'unbekannt')).toBe(s);
  });
});
