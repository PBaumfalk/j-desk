import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PDFArray, PDFDocument, PDFName, PDFRawStream, StandardFonts, decodePDFRawStream } from 'pdf-lib';
import type { PDFPage } from 'pdf-lib';
import { createTestAppMitZweiNutzern, type EinNutzer } from '../testUtils';
import { storeFile } from '../files';
import { erzeugeMetadatenPdf, erzeugeTextPdf } from './pdfTestFixtures';
import { extrahiereText } from './verify';
import { tokenisiere } from './contentStreamTokenizer';

/**
 * EXP-04-Robustheit end-to-end (D-03): dieselbe Route wie pdfExport.test.ts (annotierte
 * Kopie), diesmal mit dem Fokus auf die Schwärzungs-/Scrub-GARANTIE selbst statt auf die
 * Pipeline-Mechanik. Normatives Orakel bleibt IMMER extrahiereText (pdfjs) — Rohtext-Suche auf
 * den Roh-Bytes ist hier bewusst nur ein ERGÄNZENDER Smoke-Test (03-RESEARCH Anti-Pattern
 * „Rohtext-Suche als Verifikation": UTF-16/Hex/CID-Kodierung macht sie als alleiniges Orakel
 * unzuverlässig — Test 5 unten zeigt das konkret an einem hex-kodierten Textoperator).
 */

const GEHEIM_TOKEN = 'GEHEIM-TOKEN-4711';
const OFFEN_TEXT = 'OFFENTEXT-03-09-BLEIBT';
const GEHEIM_META = 'GEHEIM-METADATEN-03-09';
const GEHEIM_HEX = 'GEHEIMHEXCODIERT0309';

/**
 * Ergänzender Smoke-Test (03-RESEARCH: „einfache Byte-Suche auf dem Roh-PDF", NICHT die
 * fragilere Flate-Dekompression) — findet Rest-Text nur, wenn er als Roh-ASCII in den Bytes
 * steht. NIE alleiniges Orakel: hex-/UTF-16-kodierte Strings entgehen ihm (Test 5).
 */
function rohtextSmoke(bytes: Uint8Array, needle: string): boolean {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s.includes(needle);
}

/** Alle Contents-Streams einer bereits final gespeicherten Seite dekodiert und konkateniert.
 *  Anders als redact.ts (das In-Session-Streams mitverarbeiten muss) sind die Contents hier
 *  IMMER PDFRawStreams — die Bytes kommen frisch von der Route (geladen + neu gespeichert). */
function seitenBytesFinal(pdfDoc: PDFDocument, page: PDFPage): Uint8Array {
  const contents = page.node.get(PDFName.of('Contents'));
  const teile: Uint8Array[] = [];
  const einsammeln = (eintrag: Parameters<PDFDocument['context']['lookup']>[0]): void => {
    const obj = pdfDoc.context.lookup(eintrag);
    if (obj instanceof PDFRawStream) teile.push(decodePDFRawStream(obj).decode());
  };
  if (contents instanceof PDFArray) {
    for (let idx = 0; idx < contents.size(); idx++) einsammeln(contents.get(idx));
  } else if (contents) {
    einsammeln(contents);
  }
  const gesamt = teile.reduce((s, t) => s + t.length + 1, 1);
  const out = new Uint8Array(gesamt);
  let o = 0;
  for (const t of teile) {
    out.set(t, o);
    o += t.length;
    out[o++] = 0x0a;
  }
  return out.subarray(0, o);
}

async function befehl(ctx: { app: FastifyInstance; a: EinNutzer }, deskId: string, type: string, payload: unknown): Promise<void> {
  const res = await ctx.app.inject({
    method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers: ctx.a.authHeaders,
    payload: { type, payload },
  });
  expect(res.statusCode).toBe(200);
}

/** Desk + echtes PDF als freigegebene Karte (Doc-Gate, exportierbare Ebene). */
async function deskMitPdfDoc(bytes: Uint8Array, dateiName = 'dokument.pdf') {
  const ctx = await createTestAppMitZweiNutzern();
  const { app, a } = ctx;
  const desk = (
    await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte Robustheit' } })
  ).json() as { id: string };
  const meta = storeFile(ctx.db, ctx.dataDir, Buffer.from(bytes), dateiName);
  await befehl(ctx, desk.id, 'addDoc', { fileId: meta.id, name: dateiName, position: { x: 0, y: 0 }, id: 'doc-1' });
  await befehl(ctx, desk.id, 'changeLayerId', { objectId: 'doc-1', layerId: 'exportierbar' });
  return { ...ctx, deskId: desk.id, docId: 'doc-1' };
}

type RobustCtx = Awaited<ReturnType<typeof deskMitPdfDoc>>;

function exportiere(ctx: RobustCtx) {
  return ctx.app.inject({
    method: 'GET', url: `/api/v1/desks/${ctx.deskId}/export/pdf/dokument/${ctx.docId}`, headers: ctx.a.authHeaders,
  });
}

describe('EXP-04: Schwärzungs- und Scrub-Robustheit end-to-end über die Dokument-Route', () => {
  it('freigegebene redact-Mark über GEHEIM-TOKEN-4711 ⇒ weder extrahiereText noch Rohtext-Smoke findet ihn; Rest der Seite bleibt lesbar', async () => {
    const fixture = await erzeugeTextPdf(GEHEIM_TOKEN, 100, 700);
    const doc = await PDFDocument.load(fixture.bytes);
    const seite = doc.getPage(0);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    seite.drawText(OFFEN_TEXT, { x: 100, y: 500, size: 12, font });
    const bytes = await doc.save();

    const ctx = await deskMitPdfDoc(bytes);
    await befehl(ctx, ctx.deskId, 'addMark', {
      mark: { id: 'm-1', docId: ctx.docId, page: 1, rect: fixture.basis, kind: 'redact', textSnapshot: GEHEIM_TOKEN },
    });
    await befehl(ctx, ctx.deskId, 'setFreigabe', { objectId: 'm-1', freigabe: 'export' });

    const res = await exportiere(ctx);
    expect(res.statusCode).toBe(200);
    const raw = new Uint8Array(res.rawPayload);
    const text = await extrahiereText(raw);
    expect(text).not.toContain(GEHEIM_TOKEN); // Pflicht: Copy/Paste-Äquivalent findet nichts
    expect(text).toContain(OFFEN_TEXT); // Rest der Seite bleibt lesbar (D-01/D-03)
    // Ergänzend, NICHT normativ (empirisch verifiziert): pdf-lib schreibt von drawText erzeugte
    // Tj-Operanden als Hex-String UND komprimiert den Content-Stream (FlateDecode) — GEHEIM_TOKEN
    // ist also so oder so nie als literales ASCII in den Roh-Bytes zu finden, unabhängig davon,
    // ob die Redaktion gegriffen hat (identische Kodierungsfalle wie Test 5 unten). Der Smoke-
    // Test bleibt hier bewusst stehen (Plan-Vorgabe „einfache Byte-Suche auf dem Roh-PDF"), sein
    // Aussagewert für DIESEN Fall ist gering — das normative Orakel bleibt extrahiereText oben.
    expect(rohtextSmoke(raw, GEHEIM_TOKEN)).toBe(false);
  });

  it('Overlay-Nachweis: die Schwärzung erscheint als opake Füll-Fläche im Content-Stream (kein Pixelvergleich)', async () => {
    const fixture = await erzeugeTextPdf(GEHEIM_TOKEN, 100, 700);
    const ctx = await deskMitPdfDoc(fixture.bytes);
    await befehl(ctx, ctx.deskId, 'addMark', {
      mark: { id: 'm-1', docId: ctx.docId, page: 1, rect: fixture.basis, kind: 'redact', textSnapshot: GEHEIM_TOKEN },
    });
    await befehl(ctx, ctx.deskId, 'setFreigabe', { objectId: 'm-1', freigabe: 'export' });

    const res = await exportiere(ctx);
    expect(res.statusCode).toBe(200);
    const ergebnis = await PDFDocument.load(res.rawPayload);
    const bytes = seitenBytesFinal(ergebnis, ergebnis.getPage(0));
    const elemente = tokenisiere(bytes);
    // pdf-lib zeichnet drawRectangle (nur color, kein borderColor) als cm+Pfad+f — KEIN
    // re-Operator (03-07-SUMMARY, empirisch verifiziert). Der Fill-Operator 'f' ist die
    // einfachste belastbare Content-Stream-Inspektion für eine opake Füll-Fläche.
    expect(elemente.some((e) => e.op === 'f')).toBe(true);
  });

  it('interne (nicht freigegebene) redact-Mark verändert den Export NICHT; erst die Freigabe der Mark entfernt den Text (A/B)', async () => {
    const fixture = await erzeugeTextPdf(GEHEIM_TOKEN, 100, 700);
    const ctx = await deskMitPdfDoc(fixture.bytes);
    await befehl(ctx, ctx.deskId, 'addMark', {
      mark: { id: 'm-1', docId: ctx.docId, page: 1, rect: fixture.basis, kind: 'redact', textSnapshot: GEHEIM_TOKEN },
    });
    // A: die Mark bleibt auf der Kanzlei-Default-Ebene (kein Override) — effektiv 'intern'.
    const resA = await exportiere(ctx);
    expect(resA.statusCode).toBe(200);
    const textA = await extrahiereText(new Uint8Array(resA.rawPayload));
    expect(textA).toContain(GEHEIM_TOKEN); // die interne Schwärzung wirkt NICHT im Export

    // B: dieselbe Mark wird freigegeben — jetzt greift die Redaktion.
    await befehl(ctx, ctx.deskId, 'setFreigabe', { objectId: 'm-1', freigabe: 'export' });
    const resB = await exportiere(ctx);
    expect(resB.statusCode).toBe(200);
    const textB = await extrahiereText(new Uint8Array(resB.rawPayload));
    expect(textB).not.toContain(GEHEIM_TOKEN); // Freigabe-Hoheit des Marks über seinem Effekt
  });

  it('Metadaten-Fixture (XMP/Outlines/Annots/AcroForm) ⇒ weder extrahiereText noch Rohtext-Smoke findet GEHEIM nach dem Export (Scrub end-to-end)', async () => {
    const bytes = await erzeugeMetadatenPdf(GEHEIM_META);
    // Positivkontrolle: anders als von drawText gezeichneter Text (Test 1/5, hex-kodiert +
    // Flate-komprimiert) steht der XMP-Metadatenstrom literal in den Roh-Bytes — der Smoke-
    // Test hat hier also echten Aussagewert, bevor die Pipeline überhaupt läuft.
    expect(rohtextSmoke(bytes, GEHEIM_META)).toBe(true);
    const ctx = await deskMitPdfDoc(bytes);

    const res = await exportiere(ctx);
    expect(res.statusCode).toBe(200);
    const raw = new Uint8Array(res.rawPayload);
    const text = await extrahiereText(raw);
    expect(text).not.toContain(GEHEIM_META);
    expect(text).toContain('Metadaten-Fixture'); // Seiteninhalt bleibt unberührt (Scrub räumt nur Verstecke)
    expect(rohtextSmoke(raw, GEHEIM_META)).toBe(false); // ergänzend — hier mit echtem Nachweiswert (s.o.)
  });

  it('Rohtext-Smoke ist nur ergänzend: ein hex-kodierter Textoperator zeigt, warum extrahiereText das normative Orakel bleibt', async () => {
    const doc = await PDFDocument.create();
    const seite = doc.addPage([595, 842]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const hex = Buffer.from(GEHEIM_HEX, 'latin1').toString('hex');
    const strom = doc.context.register(doc.context.stream(`BT /F1 12 Tf 100 700 Td <${hex}> Tj ET`));
    seite.node.set(PDFName.of('Contents'), strom);
    seite.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { F1: font.ref } }));
    const bytes = await doc.save();

    // Das normative Orakel dekodiert den Hex-String korrekt ...
    const text = await extrahiereText(bytes);
    expect(text).toContain(GEHEIM_HEX);
    // ... die einfache Byte-Suche auf dem Roh-PDF (ergänzender Smoke-Test) findet ihn NICHT —
    // genau die Kodierungsfalle (03-RESEARCH Anti-Pattern „Rohtext-Suche als Verifikation"),
    // die Rohtext-Suche als ALLEINIGES Orakel ungeeignet macht.
    expect(rohtextSmoke(bytes, GEHEIM_HEX)).toBe(false);
  });
});
