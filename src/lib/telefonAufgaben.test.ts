import { describe, expect, it } from 'vitest';
import {
  addCutout, addDoc, addLegalObject, emptyState, setTaskAssignee, setTaskDocRef, setTaskDueDate,
  setTaskPriority, setTaskStatus, type DesktopState, type LegalObject, type TaskStatus,
} from '@j-desk/core';
import { aufgabenHerkunft, darfAbhaken, statusLesetext, telefonAufgaben } from './telefonAufgaben';

/**
 * Telefon-Aufgabenlogik (MOBILE-02, 11-09 Task 1): reine, DOM-freie Funktionen — Testform
 * nach anlagenpaketAuswahl.test.ts. Keine Store-Anbindung, kein Svelte-Kontext.
 */

const POS = { x: 0, y: 0 };

/** Aufgabe mit den für den jeweiligen Test relevanten Feldern. */
function aufgabe(
  s: DesktopState,
  id: string,
  text: string,
  felder: {
    status?: TaskStatus;
    assignee?: string;
    dueDate?: string;
    priority?: 'hoch' | 'mittel' | 'niedrig';
  } = {},
): DesktopState {
  let n = addLegalObject(s, 'aufgabe', text, POS, id);
  if (felder.status) n = setTaskStatus(n, id, felder.status);
  if (felder.assignee) n = setTaskAssignee(n, id, felder.assignee);
  if (felder.dueDate) n = setTaskDueDate(n, id, felder.dueDate);
  if (felder.priority) n = setTaskPriority(n, id, felder.priority);
  return n;
}

function ids(liste: LegalObject[]): string[] {
  return liste.map((o) => o.id);
}

describe('telefonAufgaben — Filter', () => {
  it('liefert aus einem Zustand ohne Aufgaben eine leere Liste', () => {
    expect(telefonAufgaben(emptyState(), 'Ada')).toEqual([]);
  });

  it('lässt Objekte anderer Art als Aufgabe nie in der Liste erscheinen', () => {
    let s = addLegalObject(emptyState(), 'frist', 'Frist beachten', POS, 'f1');
    s = aufgabe(s, 'a1', 'Klage entwerfen');
    expect(ids(telefonAufgaben(s, 'Ada'))).toEqual(['a1']);
  });

  it('zeigt Aufgaben ohne Verantwortlichen und mit dem eigenen Namen, aber keine fremden', () => {
    let s = aufgabe(emptyState(), 'a1', 'Ohne Verantwortlichen');
    s = aufgabe(s, 'a2', 'Meine Aufgabe', { assignee: 'Ada' });
    s = aufgabe(s, 'a3', 'Fremde Aufgabe', { assignee: 'Berta' });
    // a3 entfällt; a1 und a2 bleiben — Reihenfolge nach der Sortierregel (hier: Text).
    expect(ids(telefonAufgaben(s, 'Ada'))).toEqual(['a2', 'a1']);
  });
});

describe('telefonAufgaben — Sortierung', () => {
  it('stellt unerledigte Aufgaben vor erledigte und übergebene', () => {
    let s = aufgabe(emptyState(), 'a-erledigt', 'Erledigt', { status: 'erledigt' });
    s = aufgabe(s, 'a-uebergeben', 'Übergeben', { status: 'uebergeben' });
    s = aufgabe(s, 'a-offen', 'Offen');
    s = aufgabe(s, 'a-in-arbeit', 'In Arbeit', { status: 'in-arbeit' });
    // Gruppen: unerledigt (offen, in-arbeit) vor abgeschlossen; innerhalb der Gruppen
    // hier ohne Fälligkeit/Prioritätsunterschied nach Text bzw. Kennung.
    expect(ids(telefonAufgaben(s, 'Ada'))).toEqual(['a-in-arbeit', 'a-offen', 'a-erledigt', 'a-uebergeben']);
  });

  it('sortiert innerhalb einer Gruppe nach Fälligkeit aufsteigend, ohne Fälligkeit zuletzt', () => {
    let s = aufgabe(emptyState(), 'a-ohne', 'Ohne Fälligkeit');
    s = aufgabe(s, 'a-spaet', 'Spät fällig', { dueDate: '2026-09-01' });
    s = aufgabe(s, 'a-frueh', 'Früh fällig', { dueDate: '2026-08-10' });
    expect(ids(telefonAufgaben(s, 'Ada'))).toEqual(['a-frueh', 'a-spaet', 'a-ohne']);
  });

  it('entscheidet bei gleicher Fälligkeit nach Priorität (hoch, mittel, niedrig), dann Text, dann Kennung', () => {
    let s = aufgabe(emptyState(), 'a-niedrig', 'Alpha', { dueDate: '2026-08-10', priority: 'niedrig' });
    s = aufgabe(s, 'a-hoch', 'Zulu', { dueDate: '2026-08-10', priority: 'hoch' });
    s = aufgabe(s, 'a-mittel', 'Mittel', { dueDate: '2026-08-10', priority: 'mittel' });
    expect(ids(telefonAufgaben(s, 'Ada'))).toEqual(['a-hoch', 'a-mittel', 'a-niedrig']);

    // Gleiche Fälligkeit UND Priorität → Text entscheidet.
    let t = aufgabe(emptyState(), 't-b', 'Beta', { dueDate: '2026-08-10', priority: 'hoch' });
    t = aufgabe(t, 't-a', 'Alpha', { dueDate: '2026-08-10', priority: 'hoch' });
    expect(ids(telefonAufgaben(t, 'Ada'))).toEqual(['t-a', 't-b']);

    // Gleiche Fälligkeit, Priorität UND Text → Kennung entscheidet.
    let u = aufgabe(emptyState(), 'u-b', 'Gleich', { dueDate: '2026-08-10', priority: 'hoch' });
    u = aufgabe(u, 'u-a', 'Gleich', { dueDate: '2026-08-10', priority: 'hoch' });
    expect(ids(telefonAufgaben(u, 'Ada'))).toEqual(['u-a', 'u-b']);
  });

  it('ist stabil und deterministisch: zweimaliges Sortieren derselben Eingabe ergibt dieselbe Reihenfolge', () => {
    let s = aufgabe(emptyState(), 'x-2', 'Gleich', { dueDate: '2026-08-10', priority: 'mittel' });
    s = aufgabe(s, 'x-1', 'Gleich', { dueDate: '2026-08-10', priority: 'mittel' });
    const erstes = ids(telefonAufgaben(s, 'Ada'));
    const zweites = ids(telefonAufgaben(s, 'Ada'));
    expect(erstes).toEqual(['x-1', 'x-2']);
    expect(zweites).toEqual(erstes);
  });

  it('verändert den Zustand nicht', () => {
    let s = aufgabe(emptyState(), 'a-b', 'B');
    s = aufgabe(s, 'a-a', 'A');
    const vorher = s.legalObjects;
    const liste = telefonAufgaben(s, 'Ada');
    expect(s.legalObjects).toBe(vorher); // Referenz unverändert
    expect(s.legalObjects?.map((o) => o.id)).toEqual(['a-b', 'a-a']); // Reihenfolge unverändert
    expect(liste).not.toBe(vorher); // Sortierung auf einer Kopie
  });
});

describe('darfAbhaken', () => {
  it('ist wahr für offen und erledigt, falsch für in Arbeit und übergeben', () => {
    expect(darfAbhaken('offen')).toBe(true);
    expect(darfAbhaken('erledigt')).toBe(true);
    expect(darfAbhaken('in-arbeit')).toBe(false);
    expect(darfAbhaken('uebergeben')).toBe(false);
  });
});

describe('statusLesetext', () => {
  it('liefert für die nicht abhakbaren Status je einen eigenen Text', () => {
    expect(statusLesetext('in-arbeit')).toBe('in Arbeit');
    expect(statusLesetext('uebergeben')).toBe('an j-lawyer übergeben');
  });

  it('liefert für die abhakbaren Status keinen Text', () => {
    expect(statusLesetext('offen')).toBeNull();
    expect(statusLesetext('erledigt')).toBeNull();
  });
});

describe('aufgabenHerkunft', () => {
  /** Zustand mit Dokument und Aufgabe mit Bezug. */
  function zustandMitBezug(opts: { mitAusschnitt?: boolean; ausschnittEntfernt?: boolean } = {}) {
    let s = addDoc(emptyState(), 'file-1', 'Schriftsatz.pdf', POS, 'doc-1');
    s = aufgabe(s, 'a1', 'Passage prüfen');
    let cutoutId: string | undefined;
    if (opts.mitAusschnitt) {
      cutoutId = 'cut-1';
      s = addCutout(s, 'doc-1', 3, { x: 0, y: 0, w: 10, h: 10 }, POS, cutoutId, undefined, {
        textSnapshot: '§ 91 Abs. 2 ZPO …',
      });
      if (opts.ausschnittEntfernt) {
        s = { ...s, cutouts: (s.cutouts ?? []).filter((c) => c.id !== cutoutId) };
      }
    }
    s = setTaskDocRef(s, 'a1', { docId: 'doc-1', page: 3, ...(cutoutId ? { cutoutId } : {}) });
    return s;
  }

  it('liefert für eine Aufgabe ohne Bezug null', () => {
    const s = aufgabe(emptyState(), 'a1', 'Ohne Bezug');
    const obj = s.legalObjects!.find((o) => o.id === 'a1')!;
    expect(aufgabenHerkunft(s, obj)).toBeNull();
  });

  it('liefert für einen Bezug ohne Ausschnittkennung Dokumentname und Seite, aber KEIN Zitat', () => {
    const s = zustandMitBezug();
    const obj = s.legalObjects!.find((o) => o.id === 'a1')!;
    const herkunft = aufgabenHerkunft(s, obj);
    expect(herkunft).toEqual({ dokumentName: 'Schriftsatz.pdf', seite: 3 });
    expect(herkunft?.zitat).toBeUndefined();
  });

  it('liefert für einen entfernten Ausschnitt ebenfalls Dokumentname und Seite ohne Zitat statt eines leeren Zitatbereichs', () => {
    const s = zustandMitBezug({ mitAusschnitt: true, ausschnittEntfernt: true });
    const obj = s.legalObjects!.find((o) => o.id === 'a1')!;
    const herkunft = aufgabenHerkunft(s, obj);
    expect(herkunft).toEqual({ dokumentName: 'Schriftsatz.pdf', seite: 3 });
    expect(herkunft?.zitat).toBeUndefined();
  });

  it('liefert für einen vorhandenen Ausschnitt dessen gespeicherten Textschnappschuss als Zitat', () => {
    const s = zustandMitBezug({ mitAusschnitt: true });
    const obj = s.legalObjects!.find((o) => o.id === 'a1')!;
    const herkunft = aufgabenHerkunft(s, obj);
    expect(herkunft).toEqual({ dokumentName: 'Schriftsatz.pdf', seite: 3, zitat: '§ 91 Abs. 2 ZPO …' });
  });

  it('liefert für ein nicht mehr vorhandenes Dokument null statt eines Platzhalternamens', () => {
    let s = zustandMitBezug({ mitAusschnitt: true });
    // Dokument entfernen (der Ausschnitt überlebt als eigenständige Karte — Bestandsverhalten).
    s = { ...s, docs: s.docs.filter((d) => d.id !== 'doc-1') };
    const obj = s.legalObjects!.find((o) => o.id === 'a1')!;
    expect(aufgabenHerkunft(s, obj)).toBeNull();
  });

  it('fällt ohne gespeicherte Seite auf die erste Seite zurück', () => {
    let s = addDoc(emptyState(), 'file-1', 'Schriftsatz.pdf', POS, 'doc-1');
    s = aufgabe(s, 'a1', 'Dokument prüfen');
    s = setTaskDocRef(s, 'a1', { docId: 'doc-1' });
    const obj = s.legalObjects!.find((o) => o.id === 'a1')!;
    expect(aufgabenHerkunft(s, obj)).toEqual({ dokumentName: 'Schriftsatz.pdf', seite: 1 });
  });
});
