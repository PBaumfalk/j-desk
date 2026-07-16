import { describe, it, expect } from 'vitest';
import { emptyState } from './model';
import { addDoc } from './documents';
import { applyCommand, CommandError } from './commands';

const base = () => addDoc(emptyState(), 'file-a', 'a.pdf', { x: 0, y: 0 }, 'id-a');

describe('applyCommand', () => {
  it('führt addDoc mit optionaler id aus', () => {
    const s = applyCommand(emptyState(), {
      type: 'addDoc',
      payload: { fileId: 'file-a', name: 'a.pdf', position: { x: 1, y: 2 }, id: 'id-a' },
    });
    expect(s.docs[0]).toMatchObject({ id: 'id-a', fileId: 'file-a', name: 'a.pdf' });
  });

  it('führt moveDoc aus', () => {
    const s = applyCommand(base(), { type: 'moveDoc', payload: { id: 'id-a', position: { x: 9, y: 9 } } });
    expect(s.docs[0].position).toEqual({ x: 9, y: 9 });
  });

  it('führt die Verknüpfungs- und Stapel-Kommandos aus', () => {
    let s = addDoc(base(), 'file-b', 'b.pdf', { x: 0, y: 0 }, 'id-b');
    s = applyCommand(s, { type: 'addLink', payload: { fromId: 'id-a', toId: 'id-b', id: 'l-1' } });
    s = applyCommand(s, { type: 'setLinkNote', payload: { linkId: 'l-1', note: 'gehört zusammen' } });
    expect(s.links[0].note).toBe('gehört zusammen');
    s = applyCommand(s, { type: 'stackDocs', payload: { draggedId: 'id-b', targetId: 'id-a', id: 'st-1' } });
    expect(s.stacks[0].docIds).toEqual(['id-a', 'id-b']);
    s = applyCommand(s, { type: 'renameStack', payload: { stackId: 'st-1', name: 'Projekt' } });
    expect(s.stacks[0].name).toBe('Projekt');
    s = applyCommand(s, { type: 'removeStack', payload: { stackId: 'st-1' } });
    expect(s.stacks).toHaveLength(0);
    expect(s.docs).toHaveLength(0);
  });

  it('wirft CommandError bei unbekanntem Typ', () => {
    expect(() => applyCommand(base(), { type: 'kaputt', payload: {} })).toThrow(CommandError);
  });

  it('wirft CommandError bei fehlenden oder falschen Feldern', () => {
    expect(() => applyCommand(base(), { type: 'moveDoc', payload: { id: 'id-a' } })).toThrow(CommandError);
    expect(() =>
      applyCommand(base(), { type: 'moveDoc', payload: { id: 'id-a', position: { x: 'nein', y: 0 } } }),
    ).toThrow(CommandError);
    expect(() => applyCommand(base(), { type: 'addLink', payload: { fromId: 'id-a' } })).toThrow(CommandError);
  });

  it('leere Strings sind für Notiz und Stapelname erlaubt, nicht aber für ids', () => {
    let s = addDoc(base(), 'file-b', 'b.pdf', { x: 0, y: 0 }, 'id-b');
    s = applyCommand(s, { type: 'addLink', payload: { fromId: 'id-a', toId: 'id-b', id: 'l-1' } });
    s = applyCommand(s, { type: 'setLinkNote', payload: { linkId: 'l-1', note: '' } });
    expect(s.links[0].note).toBe('');
    expect(() => applyCommand(s, { type: 'removeLink', payload: { linkId: '' } })).toThrow(CommandError);
  });

  it('führt auch die übrigen Handler erfolgreich aus', () => {
    let s = addDoc(base(), 'file-b', 'b.pdf', { x: 0, y: 0 }, 'id-b');
    s = applyCommand(s, { type: 'bringToFront', payload: { id: 'id-a' } });
    expect(s.docs.find((d) => d.id === 'id-a')!.zIndex).toBe(3);
    s = applyCommand(s, { type: 'addLink', payload: { fromId: 'id-a', toId: 'id-b', id: 'l-1' } });
    s = applyCommand(s, { type: 'removeLink', payload: { linkId: 'l-1' } });
    expect(s.links).toHaveLength(0);
    s = applyCommand(s, { type: 'stackDocs', payload: { draggedId: 'id-b', targetId: 'id-a', id: 'st-1' } });
    s = applyCommand(s, { type: 'moveStack', payload: { stackId: 'st-1', position: { x: 7, y: 8 } } });
    expect(s.stacks[0].position).toEqual({ x: 7, y: 8 });
    s = applyCommand(s, { type: 'removeFromStack', payload: { docId: 'id-b', position: { x: 50, y: 60 } } });
    expect(s.stacks).toHaveLength(0); // 1 Rest-Dokument → Stapel aufgelöst
    expect(s.docs.find((d) => d.id === 'id-b')!.position).toEqual({ x: 50, y: 60 });
    s = applyCommand(s, { type: 'stackDocs', payload: { draggedId: 'id-b', targetId: 'id-a', id: 'st-2' } });
    s = applyCommand(s, { type: 'dissolveStack', payload: { stackId: 'st-2' } });
    expect(s.stacks).toHaveLength(0);
    expect(s.docs).toHaveLength(2);
    s = applyCommand(s, { type: 'removeDoc', payload: { id: 'id-b' } });
    expect(s.docs.map((d) => d.id)).toEqual(['id-a']);
  });
});
