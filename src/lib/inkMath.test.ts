import { describe, it, expect } from 'vitest';
import {
  toBase, toScreen, clientToBase, pagePointIn, distPointToSegment, hitStroke,
  druckMultiplikator, strichbreiteMitDruck, DRUCK_MIN, DRUCK_MAX,
} from './inkMath';
import type { Stroke } from '@j-desk/core';

const base = { w: 300, h: 400 };

describe('Koordinaten-Mapping', () => {
  it('rechnet Screen → Basis und zurück (Rundreise)', () => {
    const p = { x: 150, y: 100 };
    const b = toBase(p, 600, base); // Seite doppelt so groß gerendert
    expect(b).toEqual({ x: 75, y: 50 });
    expect(toScreen(b, 600, base)).toEqual(p);
  });

  it('ist bei renderedWidth == baseWidth die Identität', () => {
    expect(toBase({ x: 10, y: 20 }, 300, base)).toEqual({ x: 10, y: 20 });
  });
});

describe('clientToBase (UAT-Befund: Strich neben dem Cursor bei Tisch-Zoom ≠ 1)', () => {
  it('nutzt die tatsächlich gerenderte Rect-Breite, nicht die nominelle', () => {
    // Seite nominell 600px breit gerendert, aber die Welt ist auf 0.8 gezoomt:
    // auf dem Bildschirm ist die Seite nur 480px breit.
    const rect = { left: 100, top: 50, width: 480 };
    // Klick exakt in die Seitenmitte auf dem Bildschirm:
    const b = clientToBase({ x: 100 + 240, y: 50 + 320 }, rect, base);
    expect(b.x).toBeCloseTo(150, 6); // Mitte im Basisraum
    expect(b.y).toBeCloseTo(200, 6);
  });

  it('stimmt bei Zoom 1 mit toBase überein', () => {
    const rect = { left: 10, top: 20, width: 600 };
    const client = { x: 10 + 150, y: 20 + 100 };
    expect(clientToBase(client, rect, base)).toEqual(toBase({ x: 150, y: 100 }, 600, base));
  });
});

describe('pagePointIn (gemeinsamer Zeiger→Seite-Umrechner beider Viewer)', () => {
  it('rechnet über die gemessene Rect-Breite, nicht über die nominelle', () => {
    // Seite nominell 600px, Welt auf 0.8 gezoomt -> auf dem Bildschirm 480px breit.
    const p = pagePointIn({ x: 100 + 240, y: 50 + 320 }, { left: 100, top: 50, width: 480 }, base);
    expect(p).not.toBeNull();
    expect(p!.x).toBeCloseTo(150, 6);
    expect(p!.y).toBeCloseTo(200, 6);
  });

  it('liefert null, wenn die Seite noch nicht gelayoutet ist (Breite 0)', () => {
    expect(pagePointIn({ x: 10, y: 20 }, { left: 0, top: 0, width: 0 }, base)).toBeNull();
  });

  it('liefert null ohne bekannte Basisgröße', () => {
    expect(pagePointIn({ x: 10, y: 20 }, { left: 0, top: 0, width: 600 }, null)).toBeNull();
  });
});

describe('distPointToSegment', () => {
  it('misst den Lotabstand innerhalb des Segments', () => {
    expect(distPointToSegment({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(3);
  });

  it('misst zum nächstgelegenen Endpunkt außerhalb des Segments', () => {
    expect(distPointToSegment({ x: -4, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(5);
  });

  it('behandelt entartete Segmente (Punkt)', () => {
    expect(distPointToSegment({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toBe(5);
  });
});

describe('hitStroke', () => {
  const stroke: Stroke = {
    id: 's', docId: 'd', page: 1, tool: 'pen', color: '#000', width: 2,
    points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }],
  };

  it('trifft nahe der Linie, nicht in der Ferne', () => {
    expect(hitStroke(stroke, { x: 5, y: 1 }, 3)).toBe(true);
    expect(hitStroke(stroke, { x: 10.5, y: 5 }, 3)).toBe(true); // zweites Segment
    expect(hitStroke(stroke, { x: 5, y: 8 }, 3)).toBe(false);
  });
});

describe('druckMultiplikator (Pencil-Druckstärke, MOBILE-01)', () => {
  it('gibt den Druckwert unverändert zurück, solange er im Klemmbereich liegt', () => {
    expect(druckMultiplikator(1)).toBe(1);
    expect(druckMultiplikator(0.4)).toBe(0.4);
    expect(druckMultiplikator(1.4)).toBe(1.4);
  });

  it('fällt bei einem nicht meldenden Eingabegerät auf den festen mittleren Faktor 0.5 zurück', () => {
    expect(druckMultiplikator(0)).toBe(0.5);
    expect(druckMultiplikator(undefined)).toBe(0.5);
  });

  it('klemmt untere und obere Ausreißer auf DRUCK_MIN/DRUCK_MAX', () => {
    expect(druckMultiplikator(0.1)).toBe(DRUCK_MIN);
    expect(druckMultiplikator(9)).toBe(DRUCK_MAX);
  });

  it('liefert für NaN und Infinity ebenfalls 0.5 — das Ergebnis ist in allen Fällen endlich', () => {
    expect(druckMultiplikator(NaN)).toBe(0.5);
    expect(druckMultiplikator(Infinity)).toBe(0.5);
    expect(Number.isFinite(druckMultiplikator(NaN))).toBe(true);
    expect(Number.isFinite(druckMultiplikator(Infinity))).toBe(true);
  });
});

describe('strichbreiteMitDruck (MOBILE-01, iPad-Profil-Anpassungen)', () => {
  it('moduliert Kugelschreiber bei Stifteingabe', () => {
    expect(strichbreiteMitDruck(1.5, 'pen', 'pen', 1.2)).toBeCloseTo(1.5 * 1.2, 10);
  });

  it('moduliert Bleistift bei Stifteingabe', () => {
    expect(strichbreiteMitDruck(1.2, 'pencil', 'pen', 0.4)).toBeCloseTo(1.2 * 0.4, 10);
  });

  it('lässt den Textmarker unverändert — ein Textmarker läuft nicht spitz zu', () => {
    expect(strichbreiteMitDruck(9, 'marker', 'pen', 1.4)).toBe(9);
  });

  it('lässt Maus- und Fingereingabe unverändert', () => {
    expect(strichbreiteMitDruck(1.5, 'pen', 'mouse', 1.4)).toBe(1.5);
    expect(strichbreiteMitDruck(1.5, 'pen', 'touch', 1.4)).toBe(1.5);
  });

  it('liefert für alle geprüften Eingaben ein endliches, positives Ergebnis', () => {
    const faelle: [number, 'pen' | 'pencil' | 'marker', string, number | undefined][] = [
      [1.5, 'pen', 'pen', 1.2],
      [1.2, 'pencil', 'pen', 0.4],
      [9, 'marker', 'pen', 1.4],
      [1.5, 'pen', 'mouse', 1.4],
      [1.5, 'pen', 'touch', 1.4],
      [1.5, 'pen', 'pen', undefined],
      [1.5, 'pen', 'pen', NaN],
      [1.5, 'pen', 'pen', Infinity],
    ];
    for (const [basisBreite, tool, pointerType, pressure] of faelle) {
      const ergebnis = strichbreiteMitDruck(basisBreite, tool, pointerType, pressure);
      expect(Number.isFinite(ergebnis)).toBe(true);
      expect(ergebnis).toBeGreaterThan(0);
    }
  });
});
