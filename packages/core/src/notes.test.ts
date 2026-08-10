import { describe, it, expect } from 'vitest';
import { emptyState } from './model';
import { CARD_W } from './model';
import { addNote, editNote, moveNote, removeNote, NOTE_KINDS, noteBox, setNoteDone, NOTE_BADGE_MAX, NOTE_W, NOTE_H, TAFEL_W, TAFEL_H, type NoteKind, findNote, naechsteSitzungsnotizPosition, naechsteKaskadenPosition } from './notes';
import { addDoc } from './documents';
import { addTable } from './tables';
import { addZeitleiste } from './zeitleiste';
import { addLegalObject } from './legalObjects';
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

  it('vergibt einen zIndex über allen Kartenarten (WR-02: legalObjects/tables/zeitleisten mitgezählt)', () => {
    let s = emptyState();
    s = addTable(s, { x: 0, y: 0 }, 't1');
    s = addZeitleiste(s, { x: 100, y: 0 }, 'z1');
    s = addLegalObject(s, 'tatsache', 'Sachverhalt', { x: 200, y: 0 }, 'o1');
    const maxVorhanden = Math.max(
      s.tables![0].zIndex,
      s.zeitleisten![0].zIndex,
      s.legalObjects![0].zIndex,
    );
    s = addNote(s, 'notiz', 'neu', { x: 0, y: 0 }, 'n-1');
    expect(s.notes![0].zIndex).toBeGreaterThan(maxVorhanden);
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

describe('Sitzungsnotiz-Kennzeichen (SESS-03)', () => {
  it('addNote ohne Optionsobjekt erzeugt eine Notiz OHNE das Feld sitzungsnotiz', () => {
    const s = addNote(emptyState(), 'notiz', 'x', { x: 0, y: 0 }, 'n-1');
    expect('sitzungsnotiz' in s.notes![0]).toBe(false);
  });

  it('addNote mit gesetztem Optionsobjekt erzeugt eine Sitzungsnotiz mit unveränderter Art', () => {
    const s = addNote(emptyState(), 'notiz', 'Sitzungspunkt', { x: 0, y: 0 }, 'n-1', undefined, undefined, { sitzungsnotiz: true });
    expect(s.notes![0].sitzungsnotiz).toBe(true);
    expect(s.notes![0].kind).toBe('notiz');
  });

  it('das Kennzeichen ist orthogonal zur Art: eine Sitzungsnotiz-Frage bleibt eine Frage', () => {
    const s = addNote(emptyState(), 'frage', 'Zeugenfrage?', { x: 0, y: 0 }, 'n-1', undefined, undefined, { sitzungsnotiz: true });
    expect(s.notes![0].kind).toBe('frage');
    expect(s.notes![0].sitzungsnotiz).toBe(true);
  });

  it('die Zettelart-Aufzählung enthält keinen Eintrag für Sitzungsnotizen', () => {
    expect(NOTE_KINDS).toHaveLength(13);
    expect(NOTE_KINDS).toEqual([
      'notiz', 'frage', 'these', 'angriffspunkt', 'risiko',
      'behauptung', 'beweisziel', 'idee', 'todo', 'argument', 'rechtsfrage', 'eigen',
      'tafel',
    ]);
    expect(NOTE_KINDS).not.toContain('sitzungsnotiz');
  });

  it('speichert den Notiztext unverändert, auch mit Zeilenumbrüchen, Emoji und kombinierenden Zeichen', () => {
    const text = 'Zeile 1\nZeile 2\n\n🎙 Aktenkundig: é (e + ́) und ü (u + ̈)\tSonderzeichen § „Anführung"';
    const s = addNote(emptyState(), 'notiz', text, { x: 0, y: 0 }, 'n-1', undefined, undefined, { sitzungsnotiz: true });
    expect(s.notes![0].text).toBe(text);
  });

  it('naechsteSitzungsnotizPosition liefert den Ursprung ohne Sitzungsnotizen und Kaskadenversatz für n vorhandene', () => {
    let s = emptyState();
    expect(naechsteSitzungsnotizPosition(s)).toEqual({ x: 0, y: 0 });
    // Gewöhnliche Notizen zählen nicht mit
    s = addNote(s, 'notiz', 'gewöhnlich', { x: 500, y: 500 }, 'n-0');
    expect(naechsteSitzungsnotizPosition(s)).toEqual({ x: 0, y: 0 });
    for (let i = 1; i <= 3; i++) {
      const pos = naechsteSitzungsnotizPosition(s);
      expect(pos).toEqual({ x: (i - 1) * (CARD_W + 24), y: (i - 1) * 8 });
      s = addNote(s, 'notiz', `Sitzung ${i}`, pos, `n-${i}`, undefined, undefined, { sitzungsnotiz: true });
    }
    expect(naechsteSitzungsnotizPosition(s)).toEqual({ x: 3 * (CARD_W + 24), y: 3 * 8 });
  });

  it('naechsteSitzungsnotizPosition ist rein und verändert den State nicht', () => {
    const s = addNote(emptyState(), 'notiz', 'x', { x: 0, y: 0 }, 'n-1', undefined, undefined, { sitzungsnotiz: true });
    const vorher = JSON.stringify(s);
    naechsteSitzungsnotizPosition(s);
    expect(JSON.stringify(s)).toBe(vorher);
  });

  it('naechsteKaskadenPosition zählt auch Docs auf Kaskaden-Slots mit (WR-01: Telefon-Foto-Uploads)', () => {
    let s = emptyState();
    expect(naechsteKaskadenPosition(s)).toEqual({ x: 0, y: 0 });
    // Telefon-Foto landet als Doc auf Slot 0 — ohne Mit-Zählung läge das nächste Foto deckungsgleich darauf
    s = addDoc(s, 'f1', 'Foto.jpg', { x: 0, y: 0 }, 'd1');
    expect(naechsteKaskadenPosition(s)).toEqual({ x: CARD_W + 24, y: 8 });
    // Docs außerhalb der Kaskade verändern nichts
    s = addDoc(s, 'f2', 'Akte.pdf', { x: 500, y: 500 }, 'd2');
    expect(naechsteKaskadenPosition(s)).toEqual({ x: CARD_W + 24, y: 8 });
    // Gekennzeichnete Sitzungsnotiz auf dem freien Slot schiebt die Kaskade weiter fort
    s = addNote(s, 'notiz', 'Sitzung', { x: CARD_W + 24, y: 8 }, 'n-1', undefined, undefined, { sitzungsnotiz: true });
    expect(naechsteKaskadenPosition(s)).toEqual({ x: 2 * (CARD_W + 24), y: 16 });
  });

  it('naechsteKaskadenPosition behält die Notiz-Anzahl als Untergrenze (wegbewegte Sitzungsnotiz schiebt fort)', () => {
    let s = emptyState();
    for (let i = 0; i < 2; i++) {
      s = addNote(s, 'notiz', `Sitzung ${i}`, naechsteKaskadenPosition(s), `n-${i}`, undefined, undefined, { sitzungsnotiz: true });
    }
    // Erste Sitzungsnotiz wird vom Slot wegbewegt — die Kaskade fällt nicht auf den freien Slot zurück
    s = moveNote(s, 'n-0', { x: 900, y: 900 });
    expect(naechsteKaskadenPosition(s)).toEqual({ x: 2 * (CARD_W + 24), y: 16 });
  });

  it('naechsteKaskadenPosition ist rein und verändert den State nicht', () => {
    const s = addDoc(emptyState(), 'f1', 'Foto.jpg', { x: 0, y: 0 }, 'd1');
    const vorher = JSON.stringify(s);
    naechsteKaskadenPosition(s);
    expect(JSON.stringify(s)).toBe(vorher);
  });

  it('Commands: addNote setzt das Kennzeichen, verlangt einen echten Boolean, bleibt ohne Feld rückwärtskompatibel', () => {
    const s = applyCommand(emptyState(), {
      type: 'addNote',
      payload: { kind: 'notiz', text: 'Sitzung', position: { x: 0, y: 0 }, id: 'n1', sitzungsnotiz: true },
    });
    expect(findNote(s, 'n1')?.sitzungsnotiz).toBe(true);
    expect(() => applyCommand(emptyState(), {
      type: 'addNote',
      payload: { kind: 'notiz', text: 'x', position: { x: 0, y: 0 }, id: 'n2', sitzungsnotiz: 'ja' },
    })).toThrow('sitzungsnotiz');
    // Ohne das Feld: kein Kennzeichen (alle bestehenden Aufrufer bleiben unverändert)
    const t = applyCommand(emptyState(), {
      type: 'addNote',
      payload: { kind: 'notiz', text: 'x', position: { x: 0, y: 0 }, id: 'n3' },
    });
    expect('sitzungsnotiz' in findNote(t, 'n3')!).toBe(false);
  });

  it('ein alter State mit Notizen ohne das Feld bleibt gültig und wird nicht verändert', () => {
    const alt = addNote(emptyState(), 'notiz', 'alt', { x: 1, y: 2 }, 'n-1');
    const vorher = JSON.stringify(alt);
    // Bearbeiten einer Alt-Notiz erzeugt kein Kennzeichen und verändert nichts Weiteres
    const bearbeitet = editNote(alt, 'n-1', 'alt bearbeitet');
    expect('sitzungsnotiz' in findNote(bearbeitet, 'n-1')!).toBe(false);
    expect(findNote(bearbeitet, 'n-1')?.text).toBe('alt bearbeitet');
    expect(JSON.stringify(alt)).toBe(vorher);
  });
});
