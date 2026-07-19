import { describe, it, expect } from 'vitest';
import { emptyState } from './model';
import { addNote, editNote, moveNote, removeNote, NOTE_KINDS, noteBox, setNoteDone, NOTE_BADGE_MAX, NOTE_W, NOTE_H, TAFEL_W, TAFEL_H, type NoteKind, findNote } from './notes';
import { addLink } from './links';
import { removeLinksFor } from './links';
import { applyCommand } from './commands';

describe('addNote', () => {
  it('legt einen Notizzettel mit Typ, Position und id an', () => {
    const s = addNote(emptyState(), 'frage', 'Verjährung geprüft?', { x: 10, y: 20 }, 'n-1');
    expect(s.notes).toHaveLength(1);
    expect(s.notes![0]).toMatchObject({ id: 'n-1', kind: 'frage', text: 'Verjährung geprüft?', position: { x: 10, y: 20 } });
    expect(s.notes![0].zIndex).toBeGreaterThan(0);
  });

  it('vergibt eine id, wenn keine mitkommt, und kennt alle Gedanken-Typen', () => {
    for (const kind of NOTE_KINDS) {
      const s = addNote(emptyState(), kind, 'x', { x: 0, y: 0 }, undefined, kind === 'eigen' ? 'Badge' : undefined);
      expect(s.notes![0].id).toBeTruthy();
      expect(s.notes![0].kind).toBe(kind);
    }
  });

  it('lehnt unbekannte Typen ab', () => {
    expect(() => addNote(emptyState(), 'geistesblitz' as NoteKind, 'x', { x: 0, y: 0 })).toThrow();
  });

  it('funktioniert auf alten States ohne notes-Feld', () => {
    const alt = emptyState();
    delete (alt as { notes?: unknown }).notes;
    expect(addNote(alt, 'notiz', 'x', { x: 0, y: 0 }).notes).toHaveLength(1);
  });
});

describe('editNote / moveNote / removeNote', () => {
  const base = () => addNote(emptyState(), 'these', 'Alt', { x: 0, y: 0 }, 'n-1');

  it('editNote ersetzt den Text', () => {
    expect(editNote(base(), 'n-1', 'Neu').notes![0].text).toBe('Neu');
  });

  it('moveNote verschiebt', () => {
    expect(moveNote(base(), 'n-1', { x: 5, y: 6 }).notes![0].position).toEqual({ x: 5, y: 6 });
  });

  it('removeNote entfernt Zettel samt Verknüpfungen', () => {
    let s = addNote(base(), 'risiko', 'B', { x: 100, y: 0 }, 'n-2');
    s = addLink(s, 'n-1', 'n-2', 'l-1');
    s = removeNote(s, 'n-1');
    expect(s.notes!.map((n) => n.id)).toEqual(['n-2']);
    expect(s.links).toEqual([]);
  });

  it('werfen bei unbekannter id', () => {
    expect(() => editNote(emptyState(), 'nix', 'x')).toThrow(/nicht gefunden/);
    expect(() => moveNote(emptyState(), 'nix', { x: 0, y: 0 })).toThrow(/nicht gefunden/);
    expect(() => removeNote(emptyState(), 'nix')).toThrow(/nicht gefunden/);
  });
});

describe('noteBox', () => {
  it('liefert die Zettel-Box für Geometrie/Culling', () => {
    const s = addNote(emptyState(), 'notiz', 'x', { x: 7, y: 8 }, 'n-1');
    const b = noteBox(s.notes![0]);
    expect(b.x).toBe(7);
    expect(b.y).toBe(8);
    expect(b.w).toBeGreaterThan(0);
    expect(b.h).toBeGreaterThan(0);
  });
});

describe('neue Gedankenobjekt-Typen', () => {
  it('kennt alle 12 Typen inklusive eigen', () => {
    for (const kind of ['behauptung', 'beweisziel', 'idee', 'todo', 'argument', 'rechtsfrage', 'eigen'] as const) {
      const s = addNote(emptyState(), kind, 'x', { x: 0, y: 0 }, 'n1', kind === 'eigen' ? 'Zeugenfrage' : undefined);
      expect(findNote(s, 'n1')?.kind).toBe(kind);
    }
  });

  it('eigen verlangt ein Badge (max. 24 Zeichen), andere Typen verbieten es', () => {
    expect(() => addNote(emptyState(), 'eigen', 'x', { x: 0, y: 0 }, 'n1')).toThrow('Badge');
    expect(() => addNote(emptyState(), 'eigen', 'x', { x: 0, y: 0 }, 'n1', '  ')).toThrow('Badge');
    expect(() => addNote(emptyState(), 'eigen', 'x', { x: 0, y: 0 }, 'n1', 'a'.repeat(NOTE_BADGE_MAX + 1))).toThrow('Badge');
    expect(() => addNote(emptyState(), 'frage', 'x', { x: 0, y: 0 }, 'n1', 'Extra')).toThrow('eigen');
    const s = addNote(emptyState(), 'eigen', 'x', { x: 0, y: 0 }, 'n1', ' Mandanteninfo ');
    expect(findNote(s, 'n1')?.customLabel).toBe('Mandanteninfo');
  });

  it('setNoteDone hakt nur To-dos ab', () => {
    let s = addNote(emptyState(), 'todo', 'Frist prüfen', { x: 0, y: 0 }, 'n1');
    s = setNoteDone(s, 'n1', true);
    expect(findNote(s, 'n1')?.done).toBe(true);
    s = setNoteDone(s, 'n1', false);
    expect(findNote(s, 'n1')?.done).toBe(false);
    const frage = addNote(emptyState(), 'frage', 'x', { x: 0, y: 0 }, 'n2');
    expect(() => setNoteDone(frage, 'n2', true)).toThrow('To-do');
    expect(() => setNoteDone(s, 'nix', true)).toThrow('nicht gefunden');
  });

  it('Commands: addNote mit customLabel, setNoteDone verlangt boolean', () => {
    const s = applyCommand(emptyState(), {
      type: 'addNote',
      payload: { kind: 'eigen', text: '', position: { x: 1, y: 2 }, id: 'n1', customLabel: 'Zeugenfrage' },
    });
    expect(findNote(s, 'n1')?.customLabel).toBe('Zeugenfrage');
    const t = applyCommand(emptyState(), { type: 'addNote', payload: { kind: 'todo', text: '', position: { x: 0, y: 0 }, id: 'n2' } });
    const done = applyCommand(t, { type: 'setNoteDone', payload: { id: 'n2', done: true } });
    expect(findNote(done, 'n2')?.done).toBe(true);
    expect(() => applyCommand(t, { type: 'setNoteDone', payload: { id: 'n2', done: 'ja' } })).toThrow('done');
  });
});

describe('Tafel-Text', () => {
  it('kennt den Typ tafel; noteBox liefert die größere Tafel-Fläche', () => {
    const s = addNote(emptyState(), 'tafel', 'Beweiskette prüfen!', { x: 10, y: 20 }, 'n1');
    const n = findNote(s, 'n1')!;
    expect(n.kind).toBe('tafel');
    expect(noteBox(n)).toEqual({ x: 10, y: 20, w: TAFEL_W, h: TAFEL_H });
    const normal = addNote(emptyState(), 'notiz', 'x', { x: 0, y: 0 }, 'n2');
    expect(noteBox(findNote(normal, 'n2')!)).toEqual({ x: 0, y: 0, w: NOTE_W, h: NOTE_H });
  });
});
