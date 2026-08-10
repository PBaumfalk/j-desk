import { describe, it, expect } from 'vitest';
import { screenToWorld, zoomAt, zoomToFit, panBy, type Viewport } from './viewport';

describe('screenToWorld', () => {
  it('rechnet Bildschirm- in Weltkoordinaten um', () => {
    const vp: Viewport = { x: 100, y: 50, scale: 2 };
    expect(screenToWorld(vp, { x: 300, y: 250 })).toEqual({ x: 100, y: 100 });
  });
});

describe('zoomAt', () => {
  it('hält den Punkt unter dem Cursor fix', () => {
    const vp: Viewport = { x: 10, y: 20, scale: 1 };
    const cursor = { x: 400, y: 300 };
    const before = screenToWorld(vp, cursor);
    const after = screenToWorld(zoomAt(vp, cursor, 1.5), cursor);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it('klemmt den Zoomfaktor auf [0.15, 3]', () => {
    const vp: Viewport = { x: 0, y: 0, scale: 1 };
    expect(zoomAt(vp, { x: 0, y: 0 }, 100).scale).toBe(3);
    expect(zoomAt(vp, { x: 0, y: 0 }, 0.0001).scale).toBe(0.15);
  });
});

describe('zoomToFit', () => {
  it('liefert Standard-Viewport bei leerer Fläche', () => {
    expect(zoomToFit([], { w: 800, h: 600 })).toEqual({ x: 0, y: 0, scale: 1 });
  });

  it('zentriert den Inhalt und hält das Padding ein', () => {
    const vp = zoomToFit([{ x: 0, y: 0, w: 100, h: 100 }, { x: 900, y: 400, w: 100, h: 100 }], { w: 1000, h: 700 });
    // Bounding-Box-Zentrum (500, 250) landet in der Viewmitte (500, 350)
    expect(500 * vp.scale + vp.x).toBeCloseTo(500);
    expect(250 * vp.scale + vp.y).toBeCloseTo(350);
    // Inhalt (1000 breit) passt in 1000 - 2*80 → scale = 840/1000
    expect(vp.scale).toBeCloseTo(0.84);
  });
});

describe('panBy', () => {
  it('addiert das Delta auf x/y, lässt die Skala unverändert', () => {
    expect(panBy({ x: 10, y: 20, scale: 2 }, 5, -7)).toEqual({ x: 15, y: 13, scale: 2 });
  });
  it('ist bei Delta 0 identisch', () => {
    expect(panBy({ x: 3, y: 4, scale: 1.5 }, 0, 0)).toEqual({ x: 3, y: 4, scale: 1.5 });
  });
});
