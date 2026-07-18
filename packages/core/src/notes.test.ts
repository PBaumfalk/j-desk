import { describe, it, expect } from 'vitest';
import { emptyState } from './model';
import { addNote, editNote, moveNote, removeNote, NOTE_KINDS, noteBox, type NoteKind } from './notes';
import { addLink } from './links';
import { removeLinksFor } from './links';

describe('addNote', () => {
  it('legt einen Notizzettel mit Typ, Position und id an', () => {
    const s = addNote(emptyState(), 'frage', 'Verjährung geprüft?', { x: 10, y: 20 }, 'n-1');
    expect(s.notes).toHaveLength(1);
    expect(s.notes![0]).toMatchObject({ id: 'n-1', kind: 'frage', text: 'Verjährung geprüft?', position: { x: 10, y: 20 } });
    expect(s.notes![0].zIndex).toBeGreaterThan(0);
  });

  it('vergibt eine id, wenn keine mitkommt, und kennt alle Gedanken-Typen', () => {
    for (const kind of NOTE_KINDS) {
      const s = addNote(emptyState(), kind, 'x', { x: 0, y: 0 });
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
