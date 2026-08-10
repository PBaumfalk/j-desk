import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  basisNachUserSpace,
  punktNachUserSpace,
  rotationsInfo,
  seiteBrauchtFallback,
  seitenGeometrieVon
} from './coordinates';
import { erzeugeRotiertesPdf, erzeugeTextPdf } from './pdfTestFixtures';

async function pdfjsSeite(bytes: Uint8Array) {
  const pdf = await getDocument({ data: bytes, useWorkerFetch: false, isEvalSupported: false }).promise;
  try {
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    return { page, viewport, items: tc.items };
  } finally {
    await pdf.destroy();
  }
}

describe('basisNachUserSpace (Pitfall 1: Basiskoordinaten → PDF-User-Space)', () => {
  it('Positions-Fixture: umgerechnetes Rect deckt exakt die bekannte drawText-Position', async () => {
    // Normativer Beleg, keine Unit-Arithmetik: pdf-lib hat an User-Space (100,700) gezeichnet,
    // die Fixture meldet die Basiskoordinaten — die Formel muss exakt zurückführen.
    const fixture = await erzeugeTextPdf('POSITIONS-MARKER', 100, 700);
    const doc = await PDFDocument.load(fixture.bytes);
    const geo = seitenGeometrieVon(doc.getPage(0));
    expect(geo).toMatchObject({ breite: 595, hoehe: 842, rotation: 0 });
    expect(geo.cropBox).toEqual({ x: 0, y: 0, width: 595, height: 842 });
    const user = basisNachUserSpace(fixture.basis, geo);
    expect(user.x).toBe(100);
    expect(user.y).toBe(700);
    expect(user.w).toBe(fixture.basis.w);
    expect(user.h).toBe(fixture.basis.h);
  });

  it('pdfjs-Gegenprobe: der extrahierte Text steht an der gemeldeten Basis-Position', async () => {
    // End-to-end gegen das, was der Nutzer sah: pdfjs-Viewport scale 1 liefert die
    // Basiskoordinaten des Textes — sie müssen mit der Fixture-Position übereinstimmen.
    const fixture = await erzeugeTextPdf('POSITIONS-MARKER', 100, 700);
    const { viewport, items } = await pdfjsSeite(fixture.bytes);
    const item = items.find((it) => 'str' in it && it.str.includes('POSITIONS-MARKER'));
    expect(item).toBeDefined();
    const tx = (item as { transform: number[] }).transform;
    const [x0, y0] = viewport.convertToViewportPoint(tx[4], tx[5]);
    const oben = y0 - Math.abs(tx[3]); // Baseline-Punkt → Box-Oberkante (y-down)
    expect(Math.abs(x0 - fixture.basis.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(oben - fixture.basis.y)).toBeLessThanOrEqual(2);
  });

  it('CropBox mit Ursprung ≠ (0,0) wird in der Umrechnung berücksichtigt (Pitfall 2)', async () => {
    const doc = await PDFDocument.create();
    const seite = doc.addPage([595, 842]);
    seite.setCropBox(50, 100, 400, 600);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    seite.drawText('CROP-MARKER', { x: 150, y: 400, size: 12, font });
    const bytes = await doc.save();

    const geladen = await PDFDocument.load(bytes);
    const geo = seitenGeometrieVon(geladen.getPage(0));
    expect(geo.cropBox).toEqual({ x: 50, y: 100, width: 400, height: 600 });
    // Viewport bei scale 1 = CropBox-Fläche — Basiskoordinaten sind relativ dazu
    expect(geo.breite).toBe(400);
    expect(geo.hoehe).toBe(600);

    // Basis-Position des Textes: x relativ zum CropBox-Ursprung, y von der CropBox-Oberkante
    const basis = { x: 100, y: 288, w: font.widthOfTextAtSize('CROP-MARKER', 12), h: 12 };
    const user = basisNachUserSpace(basis, geo);
    expect(user.x).toBe(150);
    expect(user.y).toBe(400);

    // pdfjs-Gegenprobe auch hier: convertToViewportPoint honoriert die CropBox
    const { viewport, items } = await pdfjsSeite(bytes);
    const item = items.find((it) => 'str' in it && it.str.includes('CROP-MARKER'));
    expect(item).toBeDefined();
    const tx = (item as { transform: number[] }).transform;
    const [x0, y0] = viewport.convertToViewportPoint(tx[4], tx[5]);
    const oben = y0 - Math.abs(tx[3]);
    expect(Math.abs(x0 - basis.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(oben - basis.y)).toBeLessThanOrEqual(2);
  });
});

describe('punktNachUserSpace (Stamp-Mitten, Stroke-Punkte)', () => {
  it('rechnet Punkte mit derselben y-Formel um (Punkt = Rect mit h = 0)', async () => {
    const fixture = await erzeugeTextPdf('PUNKT', 10, 10);
    const doc = await PDFDocument.load(fixture.bytes);
    const geo = seitenGeometrieVon(doc.getPage(0));
    // Basis-Punkt (100,142) ↔ User-Space (100,700) auf einer 842er Seite
    expect(punktNachUserSpace(100, 142, geo)).toEqual({ x: 100, y: 700 });
    expect(punktNachUserSpace(0, 0, geo)).toEqual({ x: 0, y: 842 });
  });
});

describe('seiteBrauchtFallback / rotationsInfo (Pitfall 2, fail-closed)', () => {
  it('Seite mit /Rotate 90 signalisiert Fallback statt heimlich falscher Position', async () => {
    const fixture = await erzeugeRotiertesPdf();
    const doc = await PDFDocument.load(fixture.bytes);
    const geo = seitenGeometrieVon(doc.getPage(0));
    expect(geo.rotation).toBe(90);
    expect(seiteBrauchtFallback(geo)).toBe(true);
    expect(rotationsInfo(geo)).toEqual({ winkel: 90, rotiert: true });
  });

  it('unrotierte Seite braucht keinen Fallback; 360° gilt als unrotiert', async () => {
    const fixture = await erzeugeTextPdf('GERADE', 10, 10);
    const doc = await PDFDocument.load(fixture.bytes);
    const geo = seitenGeometrieVon(doc.getPage(0));
    expect(seiteBrauchtFallback(geo)).toBe(false);
    expect(rotationsInfo(geo)).toEqual({ winkel: 0, rotiert: false });
    expect(seiteBrauchtFallback({ ...geo, rotation: 360 })).toBe(false);
  });
});
