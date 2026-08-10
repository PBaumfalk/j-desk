/**
 * Pflichttests für die Scrub-Checkliste (EXP-04, T-03-05-02, 03-RESEARCH Pattern 2 + Pitfall 3).
 * Der Rohtext-Smoke (dekomprimierte Gesamtbytes, Latin1/UTF-8-Sicht) ist hier bewusst der
 * PRIMÄRE Check — die Verstecke (XMP, Outlines, AcroForm-Werte) sind kein Seiteninhalt und
 * von pdfjs nicht zuverlässig extrahierbar; extrahiereText bestätigt nur ergänzend.
 * ANTI-PATTERN-HINWEIS (03-RESEARCH): Rohtext-Suche ALLEIN ist als Verifikation unzuverlässig
 * (UTF-16/Hex/CID) — für den Content-Stream ist die pdfjs-Extraktion normativ (redact.test.ts);
 * hier geht es ausschließlich um die Nicht-Content-Stream-Verstecke.
 */
import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { gunzipSync, inflateSync, unzlibSync } from 'fflate';
import { erzeugeMetadatenPdf, erzeugeTextPdf } from './pdfTestFixtures';
import { extrahiereText } from './verify';
import { scrubbePdf } from './scrub';

const GEHEIM = 'GEHEIM-SCRUB-03-05';

/**
 * Latin1/UTF-8-Sicht auf die Gesamtbytes PLUS alle dekomprimierbaren Flate-Streams
 * (zlib/roh/gzip tolerant). Bewusst ein Smoke-Test, kein Parser: er soll Rest-Text finden,
 * der nach dem Scrub nicht mehr da sein darf — keine Vollständigkeitsgarantie nach innen.
 */
function rohtextSmoke(bytes: Uint8Array): string {
  const teile: string[] = [Buffer.from(bytes).toString('latin1'), Buffer.from(bytes).toString('utf8')];
  const latin = teile[0]; // Latin1 bildet Bytes 1:1 ab — Offsets stimmen mit dem Uint8Array überein
  let pos = 0;
  while (pos < latin.length) {
    const streamIdx = latin.indexOf('stream', pos);
    if (streamIdx < 0) break;
    let datenStart = streamIdx + 6;
    if (latin.startsWith('\r\n', datenStart)) datenStart += 2;
    else if (latin[datenStart] === '\n' || latin[datenStart] === '\r') datenStart += 1;
    const datenEnde = latin.indexOf('endstream', datenStart);
    if (datenEnde < 0) break;
    let ende = datenEnde;
    while (ende > datenStart && ' \t\r\n\f\0'.includes(latin[ende - 1])) ende--;
    const roh = bytes.subarray(datenStart, ende);
    for (const decode of [unzlibSync, inflateSync, gunzipSync]) {
      try {
        const dekodiert = decode(roh);
        teile.push(Buffer.from(dekodiert).toString('latin1'), Buffer.from(dekodiert).toString('utf8'));
        break;
      } catch {
        // kein (bekannter) Flate-Stream — nächsten Decoder versuchen
      }
    }
    pos = datenEnde + 9;
  }
  return teile.join('\n');
}

describe('scrubbePdf — Metadaten-/Struktur-Scrub in fester Reihenfolge', () => {
  it('leert alle Nicht-Content-Stream-Verstecke (XMP, Outlines, Annots, AcroForm)', async () => {
    const bytes = await erzeugeMetadatenPdf(GEHEIM);
    expect(rohtextSmoke(bytes)).toContain(GEHEIM); // Verstecke sind wirklich besetzt

    const doc = await PDFDocument.load(bytes);
    scrubbePdf(doc);
    const out = await doc.save();

    expect(rohtextSmoke(out)).not.toContain(GEHEIM);
    // ergänzendes Orakel: pdfjs findet ebenfalls nichts mehr (Seiteninhalt unberührt)
    const text = await extrahiereText(out);
    expect(text).not.toContain(GEHEIM);
    expect(text).toContain('Metadaten-Fixture');
  });

  it('entfernt StructTreeRoot samt Struktur-Text (getaggte PDFs duplizieren Text — Pitfall 3)', async () => {
    const doc = await PDFDocument.load((await erzeugeTextPdf('Struktur-Seite')).bytes);
    const elemRef = doc.context.register(doc.context.obj({ Type: 'StructElem', S: 'P', Alt: PDFString.of(GEHEIM) }));
    const structRef = doc.context.register(doc.context.obj({ Type: 'StructTreeRoot', K: elemRef }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), structRef);
    const vorher = await doc.save();
    expect(rohtextSmoke(vorher)).toContain(GEHEIM);

    scrubbePdf(doc);

    expect(doc.catalog.has(PDFName.of('StructTreeRoot'))).toBe(false);
    const nachher = await doc.save();
    expect(rohtextSmoke(nachher)).not.toContain(GEHEIM);
    // Seiteninhalt bleibt erhalten — der Scrub räumt Verstecke, keine Inhalte (das ist redact.ts)
    expect(await extrahiereText(nachher)).toContain('Struktur-Seite');
  });

  it('neutralisiert das Info-Dict und setzt die J-DESK-Kennung frisch', async () => {
    const doc = await PDFDocument.load((await erzeugeTextPdf('Info-Seite')).bytes);
    doc.setTitle(GEHEIM);
    doc.setAuthor(GEHEIM);
    doc.setSubject(GEHEIM);
    doc.setKeywords([GEHEIM]);
    // Versteck ist wirklich besetzt (pdf-lib kodiert Info-Strings als UTF-16BE-Hex —
    // der Rohtext-Smoke kann sie nicht sehen, die Getter schon):
    expect(doc.getTitle()).toBe(GEHEIM);
    expect(doc.getAuthor()).toBe(GEHEIM);

    scrubbePdf(doc);
    const out = await doc.save();
    // updateMetadata: false — sonst überschreibt der pdf-lib-Konstruktor Producer/ModDate
    // beim Laden im Speicher (Default true), und die gespeicherten Werte wären nicht prüfbar
    const neu = await PDFDocument.load(out, { updateMetadata: false });

    expect(neu.getTitle()).toBeFalsy();
    expect(neu.getAuthor()).toBeFalsy();
    expect(neu.getSubject()).toBeFalsy();
    expect(neu.getKeywords()).toBeFalsy();
    expect(neu.getCreator()).toBe('J-DESK');
    expect(neu.getProducer()).toBe('J-DESK');
    expect(neu.getCreationDate()).toBeInstanceOf(Date);
    expect(neu.getModificationDate()).toBeInstanceOf(Date);
    expect(rohtextSmoke(out)).not.toContain(GEHEIM);
  });

  it('entfernt OpenAction/AA/Names am Katalog sowie Metadata/PieceInfo/AA pro Seite', async () => {
    const doc = await PDFDocument.load((await erzeugeTextPdf('Katalog-Seite')).bytes);
    const seite = doc.getPage(0);
    doc.catalog.set(PDFName.of('OpenAction'), doc.context.obj({ Type: 'Action', S: 'JavaScript', JS: PDFString.of(GEHEIM) }));
    doc.catalog.set(PDFName.of('AA'), doc.context.obj({ O: { S: 'JavaScript', JS: PDFString.of(GEHEIM) } }));
    const efStrom = doc.context.register(doc.context.stream(`anhang-inhalt: ${GEHEIM}`));
    doc.catalog.set(
      PDFName.of('Names'),
      doc.context.obj({
        EmbeddedFiles: {
          Names: [PDFString.of('anhang.txt'), { EF: { F: efStrom }, F: PDFString.of('anhang.txt'), UF: PDFString.of('anhang.txt') }]
        },
        JavaScript: { Names: [PDFString.of('start'), { S: 'JavaScript', JS: PDFString.of(GEHEIM) }] }
      })
    );
    seite.node.set(
      PDFName.of('Metadata'),
      doc.context.register(doc.context.stream(`<x>${GEHEIM}</x>`, { Type: 'Metadata', Subtype: 'XML' }))
    );
    seite.node.set(PDFName.of('PieceInfo'), doc.context.obj({ App: { Private: PDFString.of(GEHEIM) } }));
    seite.node.set(PDFName.of('AA'), doc.context.obj({ O: { S: 'JavaScript', JS: PDFString.of(GEHEIM) } }));

    scrubbePdf(doc);

    for (const k of ['OpenAction', 'AA', 'Names']) {
      expect(doc.catalog.has(PDFName.of(k))).toBe(false);
    }
    for (const k of ['Metadata', 'PieceInfo', 'AA']) {
      expect(seite.node.has(PDFName.of(k))).toBe(false);
    }
    const out = await doc.save();
    expect(rohtextSmoke(out)).not.toContain(GEHEIM);
    expect(rohtextSmoke(out)).not.toContain('anhang.txt');
  });
});
