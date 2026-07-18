import { describe, it, expect } from 'vitest';
import { toBase, toScreen, distPointToSegment, hitStroke } from './inkMath';
import type { Stroke } from '@digital-desktop/core';

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
