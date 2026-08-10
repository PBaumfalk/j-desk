/**
 * Test-Fixture-Generator für die Export-Pipeline (03-RESEARCH: „kein Binär-Fixture ins Repo"):
 * alle Test-PDFs werden zur Laufzeit per pdf-lib erzeugt — reproduzierbar, reviewbar, ohne
 * Binär-Artefakte im Git. Die Fixtures sind die gemeinsame Grundlage von verify.test.ts (03-03),
 * coordinates.test.ts (03-03), redact.test.ts (03-05) und dem Robustheitstest (03-09).
 * Marker-Tokens müssen ASCII- und XML-sicher sein (werden literal in Streams/Strings geschrieben).
 */
import { PDFDict, PDFDocument, PDFName, PDFString, StandardFonts, degrees } from 'pdf-lib';

/** Rechteck in Basiskoordinaten (pdfjs-Viewport scale 1, Ursprung links-oben, y-down) — Form wie Cutout/Mark.rect im Client. */
export interface BasisRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TextPdfFixture {
  bytes: Uint8Array;
  text: string;
  /** Erwartete Position des Textes in Basiskoordinaten (Umrechnung siehe erzeugeTextPdf). */
  basis: BasisRect;
}

export interface RotiertesPdfFixture {
  bytes: Uint8Array;
  text: string;
  rotation: number;
}

/** Jedes Versteck einzeln benannt schaltbar, damit scrub.test.ts (03-05) gezielt prüfen kann; Default: alle an. */
export interface MetadatenVerstecke {
  /** XMP-Metadatenstrom am Catalog (dc:title = Geheim-String). */
  xmp?: boolean;
  /** Outline/Lesezeichen mit Titel = Geheim-String. */
  outline?: boolean;
  /** Text-Annotation (Subtype /Text) mit Contents = Geheim-String. */
  annot?: boolean;
  /** AcroForm-Textfeld 'geheimFeld' mit Wert = Geheim-String. */
  acroForm?: boolean;
}

const SEITE_BREITE = 595;
const SEITE_HOEHE = 842;

/**
 * Einseitiges PDF (595×842) mit Text an definierter User-Space-Position (pdf-lib: Ursprung
 * links-unten, y-up). Liefert zusätzlich die erwartete Basiskoordinaten-Position — Umrechnung
 * (Pitfall 1): basis.y = seitenHoehe - y - groesse, basis.x = x; Breite aus der Font-Metrik,
 * Höhe ≈ Schriftgröße. coordinates.ts muss genau diese Umkehrung abbilden.
 */
export async function erzeugeTextPdf(text: string, x: number, y: number, groesse = 12): Promise<TextPdfFixture> {
  const doc = await PDFDocument.create();
  const seite = doc.addPage([SEITE_BREITE, SEITE_HOEHE]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  seite.drawText(text, { x, y, size: groesse, font });
  const bytes = await doc.save();
  const basis: BasisRect = { x, y: SEITE_HOEHE - y - groesse, w: font.widthOfTextAtSize(text, groesse), h: groesse };
  return { bytes, text, basis };
}

/**
 * Seite mit /Rotate 90 und bekanntem Text (Pitfall 2): pdfjs wendet die Rotation bei der
 * Extraktion an, pdf-lib zeichnet im UNrotierten User-Space — genau die Diskrepanz, die
 * seiteBrauchtFallback fail-closed signalisieren muss.
 */
export async function erzeugeRotiertesPdf(): Promise<RotiertesPdfFixture> {
  const doc = await PDFDocument.create();
  const seite = doc.addPage([SEITE_BREITE, SEITE_HOEHE]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const text = 'ROTATIONS-MARKER-03-03';
  seite.drawText(text, { x: 100, y: 400, size: 12, font });
  seite.setRotation(degrees(90));
  const bytes = await doc.save();
  return { bytes, text, rotation: 90 };
}

/**
 * PDF mit Text in allen Nicht-Content-Stream-Verstecken (Pitfall 3, Scrub-Checkliste):
 * XMP-Metadatenstrom, Outline-Titel, Annotations-Contents, AcroForm-Feldwert. Jedes Versteck
 * ist einzeln schaltbar, damit der Scrub-Test (03-05) pro gelöschtem Versteck prüfen kann,
 * ohne die anderen mitzuleeren.
 */
export async function erzeugeMetadatenPdf(geheimString: string, verstecke: MetadatenVerstecke = {}): Promise<Uint8Array> {
  const { xmp = true, outline = true, annot = true, acroForm = true } = verstecke;
  const doc = await PDFDocument.create();
  const seite = doc.addPage([SEITE_BREITE, SEITE_HOEHE]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  seite.drawText('Metadaten-Fixture', { x: 50, y: 800, size: 12, font });

  if (xmp) {
    const xmpXml = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/">
   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${geheimString}</rdf:li></rdf:Alt></dc:title>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
    const xmpRef = doc.context.register(doc.context.stream(xmpXml, { Type: 'Metadata', Subtype: 'XML' }));
    doc.catalog.set(PDFName.of('Metadata'), xmpRef);
  }

  if (outline) {
    const outlinesRef = doc.context.register(doc.context.obj({ Type: 'Outlines', Count: 1 }));
    const eintragRef = doc.context.register(
      doc.context.obj({ Title: PDFString.of(geheimString), Parent: outlinesRef, Dest: [seite.ref, 'Fit'] })
    );
    const outlinesDict = doc.context.lookup(outlinesRef, PDFDict);
    outlinesDict.set(PDFName.of('First'), eintragRef);
    outlinesDict.set(PDFName.of('Last'), eintragRef);
    doc.catalog.set(PDFName.of('Outlines'), outlinesRef);
  }

  if (annot) {
    const annotRef = doc.context.register(
      doc.context.obj({ Type: 'Annot', Subtype: 'Text', Rect: [100, 700, 120, 720], Contents: PDFString.of(geheimString) })
    );
    seite.node.set(PDFName.of('Annots'), doc.context.obj([annotRef]));
  }

  if (acroForm) {
    const feld = doc.getForm().createTextField('geheimFeld');
    feld.setText(geheimString);
    feld.addToPage(seite, { x: 50, y: 50, width: 200, height: 20 });
  }

  return doc.save();
}

/**
 * Form-XObject mit Text, per Do-Operator in die Seite eingebunden (Pitfall 4): der Geheim-
 * String steht NICHT im Seiten-Content-Stream — ein flacher Rewrite sieht ihn nicht; 03-05
 * muss den Do-Verweis erkennen und die Seite in den Raster-Fallback schieben.
 */
export async function erzeugeXObjectTextPdf(geheimString: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const seite = doc.addPage([SEITE_BREITE, SEITE_HOEHE]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const xobjektRef = doc.context.register(
    doc.context.stream(`BT /F1 12 Tf 20 20 Td (${geheimString}) Tj ET`, {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, SEITE_BREITE, SEITE_HOEHE],
      Resources: { Font: { F1: font.ref } }
    })
  );
  seite.node.set(PDFName.of('Resources'), doc.context.obj({ XObject: { Fm1: xobjektRef } }));
  const inhaltRef = doc.context.register(doc.context.stream('q 1 0 0 1 100 700 cm /Fm1 Do Q'));
  seite.node.set(PDFName.of('Contents'), inhaltRef);
  return doc.save();
}
