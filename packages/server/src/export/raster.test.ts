/**
 * Tests für den Raster-Fallback (07-06): zwei getrennte Aussagen, weil dieselbe Datei
 * zwei unterschiedliche Aufgaben bedient (07-05-Entscheidung „Option A"):
 *   1. `rasterisiereSeite` — echter Rasterer für die OCR-Pipeline (07-07).
 *   2. `rasteriereSeiteFailClosed` — das Export-Redaktions-Gate, das UNABHÄNGIG von (1)
 *      fail-closed bleiben muss (T-07-28).
 *
 * Testkonvention (siehe overlays.test.ts, redact.test.ts u. a. in diesem Ordner): keine
 * Modul-Attrappen (`vi.mock`) — Verhalten wird ausschließlich über beobachtbare Ein-/
 * Ausgaben geprüft. Für „ruft rasterisiereSeite NICHT auf" wählen wir daher NICHT die vom
 * Plan angebotene Variante „Wurf ohne gültige PDF-Bytes" (das würde vor UND nach Task 2
 * gleich aussehen und bewiese nichts über das Verhalten von rasteriereSeiteFailClosed
 * selbst), sondern die stärkere Beobachtung: rasteriereSeiteFailClosed wirft AUCH DANN,
 * wenn die übergebenen Bytes ein Dokument sind, das `rasterisiereSeite` (nach Task 2)
 * erfolgreich rastern KÖNNTE. Das ist exakt die Eigenschaft, die T-07-28 verlangt, und sie
 * bleibt über beide Tasks hinweg grün (in Task 1, weil rasterisiereSeite ohnehin immer
 * wirft; in Task 2, weil rasteriereSeiteFailClosed den echten Rasterer gar nicht mehr
 * aufruft) — ein Regressionsnetz, das eine künftige "vereinfachende" Rückkehr zum alten
 * `await rasterisiereSeite(...)`-Aufruf sofort rot werfen lässt.
 */
import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { ExportFehler } from './pdfExport';
import { erzeugeTextPdf } from './pdfTestFixtures';
import { RASTER_DPI, RASTER_MAX_KANTE_PX, rasteriereSeiteFailClosed, rasterisiereSeite } from './raster';

/**
 * Liest Breite/Höhe direkt aus dem PNG-IHDR-Block (Signatur 8 Byte, dann Länge+Typ 8 Byte,
 * dann Breite/Höhe je 4 Byte big-endian) — keine Bildbibliothek nötig für diese Assertion.
 */
function pngBreiteHoehe(png: Uint8Array): { breite: number; hoehe: number } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { breite: view.getUint32(16), hoehe: view.getUint32(20) };
}

const PNG_SIGNATUR = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function hatPngSignatur(bytes: Uint8Array): boolean {
  return PNG_SIGNATUR.every((b, i) => bytes[i] === b);
}

describe('rasteriereSeiteFailClosed (Export-Redaktions-Gate, T-07-28)', () => {
  it('wirft ExportFehler mit reason verifikation-fehlgeschlagen, auch für eine Seite, die rasterisiereSeite erfolgreich rastern könnte', async () => {
    // Bewusst ein valides, einseitiges PDF — genau die Sorte Eingabe, mit der der echte
    // Rasterer (Task 2) ein PNG zurückliefern würde. Der Gate-Test bleibt trotzdem rot,
    // wenn rasteriereSeiteFailClosed ihn an rasterisiereSeite durchreicht, weil ein Erfolg
    // dort (kein Wurf) diese Funktion sonst kommentarlos zurückkehren ließe.
    const { bytes } = await erzeugeTextPdf('unauffälliger Text', 50, 700);

    let erfasst: unknown;
    try {
      await rasteriereSeiteFailClosed(bytes, 0);
    } catch (e) {
      erfasst = e;
    }

    expect(erfasst).toBeInstanceOf(ExportFehler);
    expect((erfasst as ExportFehler).reason).toBe('verifikation-fehlgeschlagen');
  });

  it('Meldungstext bleibt wortgleich der bisherige (Nutzer sieht dieselbe 422-Erklärung wie vor 07-06)', async () => {
    await expect(rasteriereSeiteFailClosed(new Uint8Array(), 0)).rejects.toThrow(
      'Diese Seite kann nicht sicher redigiert werden (rotierte Seite oder verschachtelter Text); ' +
        'der Export wurde abgebrochen, damit kein ungeprüftes Dokument entsteht.'
    );
  });

  it('wirft auch bei einem außerhalb des Dokuments liegenden seitenIndex weiterhin fail-closed', async () => {
    const { bytes } = await erzeugeTextPdf('Text', 10, 10);
    await expect(rasteriereSeiteFailClosed(bytes, 99)).rejects.toMatchObject({ reason: 'verifikation-fehlgeschlagen' });
  });
});

describe('rasterisiereSeite (echter Rasterer, OCR-Pixelzulieferer)', () => {
  it('liefert für eine echte PDF-Seite Bytes mit PNG-Signatur und plausibler Länge', async () => {
    const { bytes } = await erzeugeTextPdf('OCR-Testtext', 50, 700);

    const png = await rasterisiereSeite(bytes, 0);

    expect(hatPngSignatur(png)).toBe(true);
    expect(png.length).toBeGreaterThan(300);
  });

  it('die Bildbreite/-höhe entspricht der Seitengröße bei RASTER_DPI, gerundet (aus dem PNG-IHDR gelesen)', async () => {
    // pdfTestFixtures.erzeugeTextPdf erzeugt Seiten mit 595×842 pt (SEITE_BREITE/SEITE_HOEHE,
    // siehe pdfTestFixtures.ts) — Erwartung direkt aus RASTER_DPI abgeleitet, kein Magic Number.
    const SEITE_BREITE_PT = 595;
    const SEITE_HOEHE_PT = 842;
    const { bytes } = await erzeugeTextPdf('Größenprobe', 20, 20);

    const png = await rasterisiereSeite(bytes, 0);
    const { breite, hoehe } = pngBreiteHoehe(png);

    expect(breite).toBe(Math.ceil((SEITE_BREITE_PT * RASTER_DPI) / 72));
    expect(hoehe).toBe(Math.ceil((SEITE_HOEHE_PT * RASTER_DPI) / 72));
  });

  it('eine sehr große Seite wird gedeckelt: keine PNG-Kante überschreitet RASTER_MAX_KANTE_PX', async () => {
    // Absichtlich weit über A4 hinaus (3000×4000 pt) — bei RASTER_DPI ohne Deckel würde die
    // längere Kante ~8333 px betragen, deutlich über RASTER_MAX_KANTE_PX (T-07-29).
    const doc = await PDFDocument.create();
    const seite = doc.addPage([3000, 4000]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    seite.drawText('Riesenseite', { x: 50, y: 50, size: 24, font });
    const bytes = await doc.save();

    const png = await rasterisiereSeite(bytes, 0);
    const { breite, hoehe } = pngBreiteHoehe(png);

    expect(Math.max(breite, hoehe)).toBeLessThanOrEqual(RASTER_MAX_KANTE_PX);
    // Seitenverhältnis bleibt erhalten (3000:4000 = 3:4), sonst wäre nur eine Kante gedeckelt worden.
    expect(breite / hoehe).toBeCloseTo(3000 / 4000, 2);
  });

  it('ein seitenIndex außerhalb des Dokuments wirft ExportFehler statt eines undefinierten Absturzes', async () => {
    const { bytes } = await erzeugeTextPdf('Einzelseite', 10, 10);
    await expect(rasterisiereSeite(bytes, 5)).rejects.toBeInstanceOf(ExportFehler);
    await expect(rasterisiereSeite(bytes, -1)).rejects.toBeInstanceOf(ExportFehler);
  });

  it('unlesbare/korrupte Bytes wirft ExportFehler statt einer rohen pdfjs-Meldung (T-07-31)', async () => {
    const korrupt = new Uint8Array([1, 2, 3, 4, 5]);
    let erfasst: unknown;
    try {
      await rasterisiereSeite(korrupt, 0);
    } catch (e) {
      erfasst = e;
    }
    expect(erfasst).toBeInstanceOf(ExportFehler);
    expect((erfasst as ExportFehler).reason).toBe('verifikation-fehlgeschlagen');
    expect((erfasst as Error).message).not.toContain('at '); // kein Stacktrace/rohe pdfjs-Meldung
  });

  it('zwei aufeinanderfolgende Aufrufe funktionieren beide (kein Zustandsleck zwischen Läufen)', async () => {
    const eins = await erzeugeTextPdf('Erster Lauf', 30, 750);
    const zwei = await erzeugeTextPdf('Zweiter Lauf', 30, 650);

    const pngEins = await rasterisiereSeite(eins.bytes, 0);
    const pngZwei = await rasterisiereSeite(zwei.bytes, 0);

    expect(hatPngSignatur(pngEins)).toBe(true);
    expect(hatPngSignatur(pngZwei)).toBe(true);
  });
});
