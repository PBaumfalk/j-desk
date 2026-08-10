import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName } from 'pdf-lib';
import { extrahiereText } from './verify';
import {
  erzeugeMetadatenPdf,
  erzeugeRotiertesPdf,
  erzeugeTextPdf,
  erzeugeXObjectTextPdf
} from './pdfTestFixtures';

const GEHEIM = 'GEHEIM-TOKEN-4711';

describe('pdfjs-Verifikationspfad im node-env (EXP-04, Research A6)', () => {
  it('Hallo-Welt: extrahiert Text aus pdf-lib-erzeugtem PDF ohne Worker/Canvas', async () => {
    const fixture = await erzeugeTextPdf('HALLO-WELT-03-03', 100, 700);
    const text = await extrahiereText(fixture.bytes);
    expect(text).toContain('HALLO-WELT-03-03');
  });

  it('rotierte Seite (/Rotate 90): Rotation sichtbar, Text trotzdem extrahierbar', async () => {
    const fixture = await erzeugeRotiertesPdf();
    const doc = await PDFDocument.load(fixture.bytes);
    expect(doc.getPage(0).getRotation().angle).toBe(90);
    // pdfjs wendet die Seitenrotation an und liefert den Text trotzdem — die Verifikation
    // funktioniert damit auch für rotierte Seiten (Pitfall 2, Basis des Raster-Fallbacks).
    const text = await extrahiereText(fixture.bytes);
    expect(text).toContain(fixture.text);
  });
});

describe('Metadaten-Fixture (Verstecke für die Scrub-Tests in 03-05)', () => {
  it('stellt XMP, Outline, Annot und AcroForm mit dem Geheim-String bereit', async () => {
    const bytes = await erzeugeMetadatenPdf(GEHEIM);
    const doc = await PDFDocument.load(bytes);

    // XMP-Metadatenstrom am Catalog
    const xmpRef = doc.catalog.get(PDFName.of('Metadata'));
    expect(xmpRef).toBeDefined();
    const xmpStream = doc.context.lookup(xmpRef!);
    expect(xmpStream?.toString()).toContain(GEHEIM);

    // Outline/Lesezeichen mit Titel = Geheim-String
    const outlines = doc.catalog.lookup(PDFName.of('Outlines'), PDFDict);
    const eintrag = doc.context.lookup(outlines.get(PDFName.of('First')), PDFDict);
    expect(eintrag.get(PDFName.of('Title'))?.toString()).toContain(GEHEIM);

    // Text-Annotation mit Contents = Geheim-String
    const annots = doc.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
    const annotGefunden = annots
      .asArray()
      .map((ref) => doc.context.lookup(ref, PDFDict))
      .some((a) => a.get(PDFName.of('Contents'))?.toString().includes(GEHEIM));
    expect(annotGefunden).toBe(true);

    // AcroForm-Textfeld mit Wert = Geheim-String
    expect(doc.getForm().getTextField('geheimFeld').getText()).toBe(GEHEIM);
  });

  it('Verstecke sind einzeln schaltbar (gezielte Scrub-Prüfung pro Versteck)', async () => {
    const bytes = await erzeugeMetadatenPdf(GEHEIM, { xmp: true, outline: false, annot: false, acroForm: false });
    const doc = await PDFDocument.load(bytes);
    expect(doc.catalog.has(PDFName.of('Metadata'))).toBe(true);
    expect(doc.catalog.has(PDFName.of('Outlines'))).toBe(false);
    expect(doc.catalog.has(PDFName.of('AcroForm'))).toBe(false);
    // pdf-lib normalisiert jede Seite auf /Annots [] — der Schlüssel existiert immer,
    // entscheidend ist, dass das Array LEER ist (kein Annot-Versteck aufgebaut).
    const annots = doc.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
    expect(annots.size()).toBe(0);
  });
});

describe('XObject-Fixture (Pitfall 4: Text in Form-XObject)', () => {
  it('Text im Form-XObject ist per pdfjs auffindbar — das Versteck ist real', async () => {
    const bytes = await erzeugeXObjectTextPdf(GEHEIM);
    // Der Seiten-Content-Stream selbst enthält den Text NICHT (nur den Do-Verweis) —
    // pdfjs steigt in das XObject hinab. Genau deshalb reicht ein flacher Rewrite nicht.
    const text = await extrahiereText(bytes);
    expect(text).toContain(GEHEIM);
  });
});
