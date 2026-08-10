/**
 * Zentrale Koordinaten-Umrechnung Basiskoordinaten ↔ PDF-User-Space (EXP-01, Threat T-03-03-01/02).
 * EINZIGE Stelle, die diese Umrechnung kennt — overlays.ts (03-07), redact.ts (03-05) und
 * uebersichten.ts (03-08) benutzen ausschließlich dieses Modul, damit sich ein Fehler nicht
 * durch jedes Artefakt zieht.
 *
 * Basiskoordinaten = pdfjs-Viewport bei scale 1 (Ursprung LINKS-OBEN, y-down, relativ zur
 * CropBox) — das Modell speichert alle seitenverankerten Objekte so (MarkLayer.svelte:
 * left/top = rect.x/y * f). PDF-User-Space = Ursprung LINKS-UNTEN, y-up, absolut.
 * Fallen (03-RESEARCH Pitfall 1/2): y-Spiegelung, Seitenrotation, CropBox ≠ MediaBox.
 */
import type { PDFPage } from 'pdf-lib';
import type { BasisRect } from './pdfTestFixtures';

/** Rechteck im PDF-User-Space (Ursprung links-unten, y-up) — Ziel der Umrechnung. */
export interface UserSpaceRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Geometrie einer Seite, wie sie für die Umrechnung gebraucht wird. */
export interface SeitenGeometrie {
  /** Viewport-Breite bei scale 1 (= CropBox-Breite — pdfjs: page.view = CropBox). */
  breite: number;
  /** Viewport-Höhe bei scale 1 (= CropBox-Höhe). */
  hoehe: number;
  /** /Rotate-Winkel in Grad (0/90/180/270). */
  rotation: number;
  /** CropBox im User-Space; Ursprung ≠ (0,0) verschiebt die Basis-Bezugspunkte. */
  cropBox: { x: number; y: number; width: number; height: number };
}

/** Liest Größe/Rotation/CropBox einer Seite (pdf-lib fällt ohne CropBox auf die MediaBox zurück). */
export function seitenGeometrieVon(page: PDFPage): SeitenGeometrie {
  const cropBox = page.getCropBox();
  const rotation = page.getRotation().angle;
  return { breite: cropBox.width, hoehe: cropBox.height, rotation, cropBox };
}

/**
 * Basis-Rect → User-Space (Pitfall 1): x_pdf = cropBox.x + rect.x,
 * y_pdf = cropBox.y + hoehe - rect.y - rect.h. Durch Positions-Fixture belegt
 * (coordinates.test.ts) — bei Änderungen an dieser Formel muss der Fixture-Test mitwandern.
 */
export function basisNachUserSpace(rect: BasisRect, geo: SeitenGeometrie): UserSpaceRect {
  return {
    x: geo.cropBox.x + rect.x,
    y: geo.cropBox.y + geo.hoehe - rect.y - rect.h,
    w: rect.w,
    h: rect.h
  };
}

/** Punkt-Umrechnung für Stamp-Mitten und Stroke-Punkte (Punkt = Rect mit h = 0). */
export function punktNachUserSpace(x: number, y: number, geo: SeitenGeometrie): { x: number; y: number } {
  return { x: geo.cropBox.x + x, y: geo.cropBox.y + geo.hoehe - y };
}

/**
 * Fail-closed bei Rotation (Pitfall 2, Entscheidung A7, Threat T-03-03-02): KEINE
 * Rotations-Rückrechnung in dieser Phase — rotierte Seiten gehen in den Raster-Fallback
 * bzw. Abbruch-Pfad (03-07), statt heimlich falsch positioniert zu werden.
 */
export function seiteBrauchtFallback(geo: SeitenGeometrie): boolean {
  return geo.rotation % 360 !== 0;
}

/** Rotations-Info einer Seite: Winkel in Grad + ob der Fallback-Pfad nötig ist. */
export function rotationsInfo(geo: SeitenGeometrie): { winkel: number; rotiert: boolean } {
  return { winkel: geo.rotation, rotiert: seiteBrauchtFallback(geo) };
}
