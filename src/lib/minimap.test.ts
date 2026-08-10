import { describe, it, expect } from 'vitest';
import { MINIMAP_W, MINIMAP_H, fitFuerMinikarte, viewportRectFuer, punktZuViewport, type MinikarteFit } from './minimap';
import type { Box, Viewport } from '@j-desk/core';

describe('fitFuerMinikarte (UX-03, 13-05 Task 2: Minikarten-Fit-Rechnung)', () => {
  it('bildet die Welt-Bounding-Box eines einzelnen Rechtecks zentriert in die Minikarte ab', () => {
    const boxes: Box[] = [{ x: 0, y: 0, w: 100, h: 100 }];
    const fit = fitFuerMinikarte(boxes, MINIMAP_W, MINIMAP_H);
    // scale = min(192/100, 128/100) = min(1.92, 1.28) = 1.28
    expect(fit.scale).toBeCloseTo(1.28, 5);
    // offsetX = W/2 - centerX*scale = 96 - 50*1.28 = 32; offsetY = H/2 - centerY*scale = 64 - 64 = 0
    expect(fit.offsetX).toBeCloseTo(32, 5);
    expect(fit.offsetY).toBeCloseTo(0, 5);
  });

  it('bildet zwei entfernte Rechtecke über ihre gemeinsame Bounding-Box ab', () => {
    const boxes: Box[] = [
      { x: 0, y: 0, w: 100, h: 100 },
      { x: 900, y: 600, w: 100, h: 100 },
    ];
    // Weltbounding: 0..1000 x 0..700 -> worldW=1000, worldH=700
    const fit = fitFuerMinikarte(boxes, MINIMAP_W, MINIMAP_H);
    // scale = min(192/1000, 128/700) = min(0.192, 0.182857...) = 0.182857...
    expect(fit.scale).toBeCloseTo(128 / 700, 5);
    // offsetX = 96 - 500*scale; offsetY = 64 - 350*scale = 64 - 64 = 0
    expect(fit.offsetX).toBeCloseTo(96 - 500 * (128 / 700), 5);
    expect(fit.offsetY).toBeCloseTo(0, 5);
  });

  it('leerer Tisch liefert einen definierten Neutral-Fit statt eines Absturzes (E3/empty-Fallback)', () => {
    const fit = fitFuerMinikarte([], MINIMAP_W, MINIMAP_H);
    expect(Number.isFinite(fit.scale)).toBe(true);
    expect(fit.scale).toBeGreaterThan(0);
    expect(Number.isFinite(fit.offsetX)).toBe(true);
    expect(Number.isFinite(fit.offsetY)).toBe(true);
  });
});

describe('viewportRectFuer (UX-03, 13-05 Task 2: Viewport-Rechteck in Minikarten-Koordinaten)', () => {
  const fit: MinikarteFit = { scale: 0.1, offsetX: 0, offsetY: 0 };

  it('projiziert den sichtbaren Weltausschnitt in Minikarten-Koordinaten', () => {
    // vp: screen = world*scale + (x,y) -> world sichtbarer Bereich bei vp={x:0,y:0,scale:1}, view 800x600
    const vp: Viewport = { x: 0, y: 0, scale: 1 };
    const rect = viewportRectFuer(vp, 800, 600, fit);
    // Weltausschnitt: [0,800]x[0,600] -> Minikarte: scale 0.1 -> [0,80]x[0,60]
    expect(rect.x).toBeCloseTo(0, 5);
    expect(rect.y).toBeCloseTo(0, 5);
    expect(rect.w).toBeCloseTo(80, 5);
    expect(rect.h).toBeCloseTo(60, 5);
  });

  it('klemmt das Rechteck innerhalb der Kartenfläche, wenn der Weltausschnitt weit außerhalb liegt', () => {
    const weitDraussen: Viewport = { x: -100000, y: -100000, scale: 1 };
    const rect = viewportRectFuer(weitDraussen, 800, 600, fit);
    expect(rect.x).toBeGreaterThanOrEqual(0);
    expect(rect.y).toBeGreaterThanOrEqual(0);
    expect(rect.x + rect.w).toBeLessThanOrEqual(MINIMAP_W + 0.001);
    expect(rect.y + rect.h).toBeLessThanOrEqual(MINIMAP_H + 0.001);
  });
});

describe('punktZuViewport (UX-03, 13-05 Task 2: Rundreise-Test der Projektion)', () => {
  it('liefert den Welt-Mittelpunkt eines Minikarten-Klicks (Umkehrung der Projektion)', () => {
    const fit: MinikarteFit = { scale: 0.2, offsetX: 10, offsetY: 5 };
    const weltpunkt = { x: 340, y: 210 };
    // Vorwärts-Projektion (wie fitFuerMinikarte/viewportRectFuer sie nutzen würden)
    const minikartenPunkt = { x: weltpunkt.x * fit.scale + fit.offsetX, y: weltpunkt.y * fit.scale + fit.offsetY };
    const zurueck = punktZuViewport(minikartenPunkt.x, minikartenPunkt.y, fit);
    expect(zurueck.x).toBeCloseTo(weltpunkt.x, 5);
    expect(zurueck.y).toBeCloseTo(weltpunkt.y, 5);
  });
});
