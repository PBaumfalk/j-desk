import { describe, expect, it } from 'vitest';
import { commandTypen, emptyState, pruefeErwartung, type Erwartet } from '@j-desk/core';
import { erwartungAus, reaktionFuer } from './konflikt';

function tisch() {
  return {
    ...emptyState(),
    docs: [
      { id: 'd1', fileId: 'f1', name: 'A.pdf', position: { x: 0, y: 0 }, rotation: 0, zIndex: 1, updatedRev: 4 },
      { id: 'd2', fileId: 'f2', name: 'B.pdf', position: { x: 1, y: 1 }, rotation: 0, zIndex: 2, updatedRev: 6 },
    ],
  };
}

describe('erwartungAus', () => {
  it('leitet die Erwartung aus einer einfachen id ab', () => {
    expect(erwartungAus(tisch(), { id: 'd1', position: { x: 5, y: 5 } })).toEqual({ d1: 4 });
  });

  it('erfasst mehrere Objekte aus einem Array', () => {
    expect(erwartungAus(tisch(), { docIds: ['d1', 'd2'] })).toEqual({ d1: 4, d2: 6 });
  });

  it('ignoriert Werte, die kein bekanntes Objekt bezeichnen', () => {
    expect(erwartungAus(tisch(), { id: 'd1', text: 'irgendein Text' })).toEqual({ d1: 4 });
  });

  it('ignoriert Objekte ohne Version', () => {
    const s = { ...tisch(), docs: [{ id: 'd3', fileId: 'f3', name: 'C.pdf', position: { x: 0, y: 0 }, rotation: 0, zIndex: 1 }] };
    expect(erwartungAus(s as never, { id: 'd3' })).toBeUndefined();
  });

  it('liefert undefined, wenn nichts zu erwarten ist', () => {
    expect(erwartungAus(tisch(), { kind: 'notiz', text: 'Neue Notiz', position: { x: 0, y: 0 } })).toBeUndefined();
  });

  it('findet ids auch in verschachtelten Nutzlasten', () => {
    expect(erwartungAus(tisch(), { mark: { docId: 'd1', page: 1 } })).toEqual({ d1: 4 });
  });
});

describe('reaktionFuer', () => {
  it('setzt ortsgebundene Commands auf wiederholen', () => {
    expect(reaktionFuer('moveDoc')).toBe('wiederholen');
    expect(reaktionFuer('moveStack')).toBe('wiederholen');
    expect(reaktionFuer('bringToFront')).toBe('wiederholen');
  });

  it('setzt inhaltliche Commands auf fragen', () => {
    expect(reaktionFuer('editNote')).toBe('fragen');
    expect(reaktionFuer('removeDoc')).toBe('fragen');
  });

  it('setzt UNBEKANNTE Commands auf fragen', () => {
    // K4: der unbequeme Standardwert. Ein vergessener Eintrag nervt,
    // statt still Daten zu verlieren.
    expect(reaktionFuer('irgendwasNeues')).toBe('fragen');
  });
});

/**
 * COLLAB-04: der sichere Vorgabefall von `reaktionFuer()` eingefroren. Das stille Wiederholen
 * ist eine ausdrücklich aufgezählte Ausnahme für rein räumliche Änderungen (Position, Größe,
 * Reihenfolge, Hintergrund) — sobald in einer späteren Phase fachlich verbindliche Objektarten
 * wie Fristen oder Status entstehen, dürfen deren Kommandotypen NICHT in diese Liste
 * aufgenommen werden. Der sichere Vorgabefall bleibt die Rückfrage.
 */
describe('reaktionFuer: sicherer Vorgabefall eingefroren (COLLAB-04)', () => {
  // Genau die neun Kommandotypen der Positions-Allowlist (src/lib/konflikt.ts, WIEDERHOLEN) —
  // jeder beschreibt ausschließlich Position, Größe, Reihenfolge oder Hintergrund.
  const POSITIONS_ALLOWLIST = [
    'moveDoc', // Position einer Karte
    'moveStack', // Position eines Stapels
    'moveNote', // Position eines Notizzettels
    'moveCutout', // Position eines Ausschnitts
    'bringToFront', // Reihenfolge (z-Index)
    'resizeDoc', // Größe einer Karte
    'resizeStack', // Größe eines Stapels
    'setDocLandscape', // Format-Umschaltung (Querformat) — rein geometrisch, kein Inhalt
    'setBackground', // Hintergrund — kein versioniertes Objekt, unstrittig
  ] as const;
  const allowlist = new Set<string>(POSITIONS_ALLOWLIST);

  it('jeder Typ der Positionsliste liefert "wiederholen"', () => {
    for (const typ of POSITIONS_ALLOWLIST) {
      expect(reaktionFuer(typ), `"${typ}" sollte wiederholen liefern`).toBe('wiederholen');
    }
  });

  it('jeder Typ aus commandTypen(), der NICHT in der Positionsliste steht, liefert "fragen"', () => {
    // Voraussetzung der Regressionssperre unten: es muss "übrige" Typen geben, sonst wäre die
    // Mengengleichheitsprüfung trivial erfüllt.
    expect(commandTypen().length).toBeGreaterThan(allowlist.size);
    for (const typ of commandTypen()) {
      if (allowlist.has(typ)) continue;
      expect(reaktionFuer(typ), `"${typ}" sollte fragen liefern (sicherer Vorgabefall)`).toBe('fragen');
    }
  });

  it('Regressionssperre: die Positionsliste ist mengengleich mit der Menge aller Typen, für die reaktionFuer "wiederholen" liefert', () => {
    // Diese Prüfung ist die eigentliche Sperre: sie schlägt fehl, sobald jemand einen weiteren
    // Typ in WIEDERHOLEN aufnimmt, und zwingt damit zu einer bewussten Entscheidung statt zu
    // einem beiläufigen Aufweichen der Allowlist.
    const wiederholenTypen = new Set(commandTypen().filter((typ) => reaktionFuer(typ) === 'wiederholen'));
    expect(wiederholenTypen).toEqual(allowlist);
  });

  it('ein frei erfundener, dem System unbekannter Kommandotyp liefert "fragen"', () => {
    expect(reaktionFuer('einKommandoDasEsNieGebenWird')).toBe('fragen');
  });

  it('die leere Zeichenkette als Typ liefert "fragen"', () => {
    expect(reaktionFuer('')).toBe('fragen');
  });
});

describe('pruefeErwartung: Grenzfälle (COLLAB-04)', () => {
  it('meldet bei mehreren gleichzeitig veralteten Objekten deterministisch immer dasselbe Objekt zuerst', () => {
    // Die Meldereihenfolge folgt der Einfügereihenfolge der Erwartung (Object.entries), nicht
    // der Reihenfolge im Zustand — zwei Aufrufe mit gleicher Eingabe liefern dieselbe Kennung,
    // damit der Nutzer bei gleicher Ausgangslage stets dieselbe Rückfrage bekommt, nicht bei
    // jedem Versuch eine andere.
    const state = {
      ...emptyState(),
      docs: [
        { id: 'd1', fileId: 'f1', name: 'A.pdf', position: { x: 0, y: 0 }, rotation: 0, zIndex: 1, updatedRev: 9 },
        { id: 'd2', fileId: 'f2', name: 'B.pdf', position: { x: 1, y: 1 }, rotation: 0, zIndex: 2, updatedRev: 9 },
      ],
    };
    const erwartet: Erwartet = { d2: 1, d1: 1 }; // Einfügereihenfolge: d2 zuerst eingetragen

    const erstesMal = pruefeErwartung(state, erwartet);
    const zweitesMal = pruefeErwartung(state, erwartet);
    expect(erstesMal?.objektId).toBe('d2');
    expect(zweitesMal).toEqual(erstesMal);
  });

  it('liefert null bei einer leeren Erwartung', () => {
    expect(pruefeErwartung(emptyState(), {})).toBeNull();
  });

  it('liefert null, wenn die Erwartung über genau ein aktuelles Objekt zutrifft', () => {
    const state = {
      ...emptyState(),
      docs: [{ id: 'd1', fileId: 'f1', name: 'A.pdf', position: { x: 0, y: 0 }, rotation: 0, zIndex: 1, updatedRev: 4 }],
    };
    expect(pruefeErwartung(state, { d1: 4 })).toBeNull();
  });
});
