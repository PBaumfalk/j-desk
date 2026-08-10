import { describe, it, expect } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { extrahiereSeitentexte, TEXT_SCHWELLE_ZEICHEN } from './extract';

/** Mehrseitiges PDF mit definiertem Text pro Seite — direkt per pdf-lib erzeugt (dasselbe Muster
 *  wie overlays.test.ts/coordinates.test.ts, `pdfTestFixtures.ts` hat keinen Mehrseiten-Helfer). */
async function pdfMitSeiten(texte: string[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const text of texte) {
    const seite = doc.addPage([595, 842]);
    if (text) seite.drawText(text, { x: 50, y: 700, size: 12, font });
  }
  return doc.save();
}

describe('extrahiereSeitentexte', () => {
  it('liefert für ein PDF mit zwei Textseiten zwei Einträge mit page 1/2, nicht leerem Text und brauchtOcr=false', async () => {
    const bytes = await pdfMitSeiten([
      'Erste Seite mit ausreichend Text zum Testen der Extraktion.',
      'Zweite Seite mit ebenfalls ausreichend Text zum Testen.',
    ]);
    const seiten = await extrahiereSeitentexte(bytes);
    expect(seiten).toHaveLength(2);
    expect(seiten[0].page).toBe(1);
    expect(seiten[0].text).toContain('Erste Seite');
    expect(seiten[0].brauchtOcr).toBe(false);
    expect(seiten[1].page).toBe(2);
    expect(seiten[1].text).toContain('Zweite Seite');
    expect(seiten[1].brauchtOcr).toBe(false);
  });

  it(`liefert brauchtOcr=true für eine Seite mit weniger als ${TEXT_SCHWELLE_ZEICHEN} extrahierten Zeichen, Text unverändert`, async () => {
    const kurzerText = 'Hi'; // deutlich unter TEXT_SCHWELLE_ZEICHEN
    const bytes = await pdfMitSeiten([kurzerText]);
    const seiten = await extrahiereSeitentexte(bytes);
    expect(seiten).toHaveLength(1);
    expect(seiten[0].text.trim()).toBe(kurzerText);
    expect(seiten[0].brauchtOcr).toBe(true);
  });

  it('wirft bei unlesbaren Bytes, statt ein leeres Ergebnis zu liefern (Unterschied zu textInRect)', async () => {
    const kaputteBytes = new TextEncoder().encode('kein PDF, nur Text');
    await expect(extrahiereSeitentexte(kaputteBytes)).rejects.toThrow();
  });
});
