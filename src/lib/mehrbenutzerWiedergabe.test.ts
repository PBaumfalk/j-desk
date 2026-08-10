/**
 * COLLAB-03: Mehrbenutzer-Nachweis der Wiedergabe-Entscheidungskette nach der Wiederverbindung.
 *
 * Grenze (06-05-PLAN.md <objective>, ausdrücklich festgehalten statt stillschweigend
 * übernommen): ein beim Nachspielen auftretender Konflikt wird verworfen und
 * zusammenfassend gemeldet (`drainQueue()` in store.svelte.ts), NICHT in die interaktive
 * Rückfrage geleitet. Diese Grenze gilt, solange keine fachlich verbindlichen Objektarten
 * existieren — mit deren Einführung in Phase 8 ist sie erneut zu prüfen, weil dann auch zu
 * klären ist, was eine interaktive Rückfrage bedeutet, wenn beim Wiederverbinden niemand am
 * Bildschirm sitzt.
 *
 * Dieser Test ruft NICHT die (modul-private, nicht exportierte) Wiedergabe-Schleife selbst
 * auf — ihre Verzweigungslogik ist bereits aus Phase 5 abgedeckt (offlineQueue.test.ts). Er
 * bildet stattdessen die Entscheidungskette nach, die diese Schleife tatsächlich durchläuft,
 * ausschließlich über die exportierten, reinen Bausteine: `istBereitsAngewendet` (Dubletten-
 * Schutz erzeugender Commands), `erwartungAus` (Versionserwartung aus der payload) und
 * `pruefeErwartung` (Konflikterkennung gegen den frischen Zustand).
 */
import { describe, expect, it } from 'vitest';
import { emptyState, pruefeErwartung, type Command, type DesktopState, type Doc, type Erwartet, type Konflikt, type Note } from '@j-desk/core';
import { erwartungAus } from './konflikt';
import { istBereitsAngewendet } from './offlineQueue';

function doc(overrides: Partial<Doc> & { id: string }): Doc {
  return {
    fileId: `f-${overrides.id}`,
    name: `${overrides.id}.pdf`,
    position: { x: 0, y: 0 },
    rotation: 0,
    zIndex: 1,
    ...overrides,
  };
}

function note(overrides: Partial<Note> & { id: string }): Note {
  return {
    kind: 'notiz',
    text: 'x',
    position: { x: 0, y: 0 },
    zIndex: 1,
    ...overrides,
  } as Note;
}

/**
 * Entscheidung EINES gepufferten Kommandos gegen den frischen Serverzustand, nachgebildet aus
 * denselben exportierten Bausteinen, die `drainQueue()` (store.svelte.ts) tatsächlich nutzt:
 * zuerst der Dubletten-Schutz für erzeugende Commands, dann die Versionsprüfung. Kein
 * Netzwerkaufruf, keine Mutation — reine Auswertung, deshalb beliebig oft wiederholbar
 * (Grundlage des Idempotenz-Nachweises unten).
 */
type Entscheidung = { art: 'ueberspringen' } | { art: 'senden' } | { art: 'konflikt'; konflikt: Konflikt };

function wiedergabeEntscheidung(freshState: DesktopState, cmd: Command & { erwartet?: Erwartet }): Entscheidung {
  if (istBereitsAngewendet(freshState, cmd)) return { art: 'ueberspringen' };
  const konflikt = pruefeErwartung(freshState, cmd.erwartet);
  if (konflikt) return { art: 'konflikt', konflikt };
  return { art: 'senden' };
}

describe('Mehrbenutzerfall der Wiedergabe nach Wiederverbindung (COLLAB-03)', () => {
  it('erzeugendes Kommando für ein von Nutzer B bereits angelegtes Objekt X wird übersprungen (keine Dublette)', () => {
    // A puffert offline ein addNote-Kommando für X ...
    const cmdA: Command = { type: 'addNote', payload: { id: 'x', kind: 'notiz', text: 'A schreibt', position: { x: 0, y: 0 } } };
    // ... B hat X in der Zwischenzeit bereits angelegt — der frische Serverzustand enthält X schon.
    const freshState: DesktopState = { ...emptyState(), notes: [note({ id: 'x', text: 'B schreibt', updatedRev: 3, updatedBy: 'B' })] };

    expect(istBereitsAngewendet(freshState, cmdA)).toBe(true);
    expect(wiedergabeEntscheidung(freshState, cmdA)).toEqual({ art: 'ueberspringen' });
    // Keine Dublette: weiterhin genau ein Eintrag mit der Id X, und zwar B's Fassung.
    expect(freshState.notes).toHaveLength(1);
    expect(freshState.notes?.[0]).toMatchObject({ id: 'x', text: 'B schreibt', updatedBy: 'B' });
  });

  it('erzeugendes Kommando für ein noch nicht existierendes Objekt Y wird gesendet', () => {
    const cmdA: Command = { type: 'addNote', payload: { id: 'y', kind: 'notiz', text: 'A schreibt', position: { x: 0, y: 0 } } };
    const freshState: DesktopState = { ...emptyState(), notes: [] };

    expect(istBereitsAngewendet(freshState, cmdA)).toBe(false);
    expect(wiedergabeEntscheidung(freshState, cmdA)).toEqual({ art: 'senden' });
  });

  it('änderndes Kommando auf ein von Nutzer B zwischenzeitlich geändertes Objekt Z meldet einen Konflikt mit Einstufung "geändert" — B\'s Fassung wird NICHT überschrieben', () => {
    // Zustand, den A beim Offlinegehen sah: Z in Version 5.
    const stateBeimOfflinegehen: DesktopState = { ...emptyState(), docs: [doc({ id: 'z', updatedRev: 5 })] };
    const payload = { id: 'z', position: { x: 42, y: 42 } };
    const erwartet = erwartungAus(stateBeimOfflinegehen, payload);
    expect(erwartet).toEqual({ z: 5 });
    const cmdA: Command & { erwartet?: Erwartet } = { type: 'moveDoc', payload, erwartet };

    // B hat Z inzwischen bewegt — der Server vergibt eine neue Version und trägt B als Urheber ein.
    const freshState: DesktopState = {
      ...emptyState(),
      docs: [doc({ id: 'z', position: { x: 7, y: 7 }, updatedRev: 6, updatedBy: 'B', updatedAt: '2026-07-26T10:00:00Z' })],
    };

    const entscheidung = wiedergabeEntscheidung(freshState, cmdA);
    expect(entscheidung).toEqual({
      art: 'konflikt',
      konflikt: { objektId: 'z', typ: 'docs', art: 'geaendert', von: 'B', am: '2026-07-26T10:00:00Z' },
    });
    // Der Beweis, dass NICHT still überschrieben wurde: B's Fassung steht unverändert im frischen
    // Zustand, und die Entscheidung für A's Eintrag lautet „Konflikt", nicht „senden".
    expect(freshState.docs[0]).toMatchObject({ position: { x: 7, y: 7 }, updatedRev: 6, updatedBy: 'B' });
    expect(entscheidung.art).not.toBe('senden');
  });

  it('B hat Z gelöscht → Konflikt mit Einstufung "gelöscht"', () => {
    const stateBeimOfflinegehen: DesktopState = { ...emptyState(), docs: [doc({ id: 'z', updatedRev: 5 })] };
    const payload = { id: 'z', position: { x: 42, y: 42 } };
    const erwartet = erwartungAus(stateBeimOfflinegehen, payload);
    const cmdA: Command & { erwartet?: Erwartet } = { type: 'moveDoc', payload, erwartet };

    // B hat Z gelöscht — der frische Zustand enthält Z gar nicht mehr.
    const freshState: DesktopState = { ...emptyState(), docs: [] };

    expect(wiedergabeEntscheidung(freshState, cmdA)).toEqual({
      art: 'konflikt',
      konflikt: { objektId: 'z', typ: 'unbekannt', art: 'geloescht', von: null, am: null },
    });
  });

  it('dieselbe Auswertung zweimal hintereinander liefert dieselbe Entscheidung (Idempotenz)', () => {
    const stateBeimOfflinegehen: DesktopState = { ...emptyState(), docs: [doc({ id: 'z', updatedRev: 5 })] };
    const payload = { id: 'z', position: { x: 42, y: 42 } };
    const erwartet = erwartungAus(stateBeimOfflinegehen, payload);
    const cmdA: Command & { erwartet?: Erwartet } = { type: 'moveDoc', payload, erwartet };
    const freshState: DesktopState = {
      ...emptyState(),
      docs: [doc({ id: 'z', updatedRev: 6, updatedBy: 'B', updatedAt: '2026-07-26T10:00:00Z' })],
    };

    const erstesMal = wiedergabeEntscheidung(freshState, cmdA);
    const zweitesMal = wiedergabeEntscheidung(freshState, cmdA);
    expect(zweitesMal).toEqual(erstesMal);

    // Idempotenz gilt auch für den Dublettenschutz erzeugender Commands.
    const cmdErzeugend: Command = { type: 'addNote', payload: { id: 'x', kind: 'notiz', text: 'A', position: { x: 0, y: 0 } } };
    const freshMitX: DesktopState = { ...emptyState(), notes: [note({ id: 'x', updatedRev: 1 })] };
    expect(istBereitsAngewendet(freshMitX, cmdErzeugend)).toBe(istBereitsAngewendet(freshMitX, cmdErzeugend));
  });

  it('leere Warteschlange: keine Auswertung, keine Ausnahme', () => {
    const freshState: DesktopState = emptyState();
    const warteschlange: (Command & { erwartet?: Erwartet })[] = [];

    const ergebnisse = warteschlange.map((cmd) => wiedergabeEntscheidung(freshState, cmd));

    expect(ergebnisse).toEqual([]);
  });

  it('Warteschlange mit genau einem Eintrag: das eine Ergebnis wird korrekt bestimmt', () => {
    const freshState: DesktopState = { ...emptyState(), notes: [note({ id: 'x', updatedRev: 2, updatedBy: 'B' })] };
    const warteschlange: (Command & { erwartet?: Erwartet })[] = [
      { type: 'addNote', payload: { id: 'x', kind: 'notiz', text: 'A', position: { x: 0, y: 0 } } },
    ];

    const ergebnisse = warteschlange.map((cmd) => wiedergabeEntscheidung(freshState, cmd));

    expect(ergebnisse).toHaveLength(1);
    expect(ergebnisse[0]).toEqual({ art: 'ueberspringen' });
  });
});
