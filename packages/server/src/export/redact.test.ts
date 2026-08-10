/**
 * Pflichttests für den Content-Stream-Rewriter (EXP-04-Kern, D-01/D-03, T-03-05-01/03/04).
 * Normatives Orakel ist die pdfjs-Extraktion (verify.ts) — Copy/Paste-Äquivalenz: was pdfjs
 * nicht mehr findet, kann auch Copy/Paste nicht mehr finden. Rohtext-Suche wäre unzuverlässig
 * (UTF-16/Hex/CID, 03-RESEARCH Anti-Pattern). Fixtures aus 03-03, keine Binär-Artefakte.
 */
import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
import { erzeugeRotiertesPdf, erzeugeTextPdf, erzeugeXObjectTextPdf } from './pdfTestFixtures';
import { basisNachUserSpace, seitenGeometrieVon } from './coordinates';
import { extrahiereText } from './verify';
import { redactiereSeite } from './redact';

const GEHEIM = 'GEHEIM-TOKEN-03-05';
const OFFEN = 'OFFENTLICH-TEXT-03-05';

describe('redactiereSeite — echte Schwärzung im Content-Stream', () => {
  it('löscht den Textoperator unter dem Rect echt; Nachbartext außerhalb bleibt erhalten', async () => {
    const fixture = await erzeugeTextPdf(GEHEIM, 100, 700);
    const doc = await PDFDocument.load(fixture.bytes);
    const seite = doc.getPage(0);
    // Zweiter Text außerhalb des Rects (pdf-lib hängt dabei einen zweiten Contents-Stream an —
    // deckt nebenbei die Array-Verarbeitung mit ab):
    const font = await doc.embedFont(StandardFonts.Helvetica);
    seite.drawText(OFFEN, { x: 100, y: 500, size: 12, font });

    const geo = seitenGeometrieVon(seite);
    const erg = redactiereSeite(doc, seite, [basisNachUserSpace(fixture.basis, geo)], geo);

    expect(erg.geaendert).toBe(true);
    expect(erg.rotationsAbgelehnt).toBe(false);
    const text = await extrahiereText(await doc.save());
    expect(text).not.toContain(GEHEIM); // Kern von EXP-04: echt gelöscht, nicht übermalt
    expect(text).toContain(OFFEN);
  });

  it('löscht im Zweifel: Startposition knapp außerhalb, aber innerhalb der Font-Size-Marge', async () => {
    const fixture = await erzeugeTextPdf(GEHEIM, 100, 700);
    const doc = await PDFDocument.load(fixture.bytes);
    const seite = doc.getPage(0);
    const geo = seitenGeometrieVon(seite);
    // Rect deckt den Text nur rechts — Startposition (x=100) liegt 6 < 12 (Font-Size) davor:
    const teilRect = basisNachUserSpace(
      { x: fixture.basis.x + 6, y: fixture.basis.y, w: fixture.basis.w - 6, h: fixture.basis.h },
      geo
    );
    const erg = redactiereSeite(doc, seite, [teilRect], geo);

    expect(erg.geaendert).toBe(true);
    const text = await extrahiereText(await doc.save());
    expect(text).not.toContain(GEHEIM); // fail-closed-Richtung: zu viel löschen ist unkritisch
  });

  it('verarbeitet Contents-Arrays vollständig und in Reihenfolge (Pitfall 4)', async () => {
    const doc = await PDFDocument.create();
    const seite = doc.addPage([595, 842]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const strom1 = doc.context.register(doc.context.stream(`BT /F1 12 Tf 100 700 Td (${OFFEN}) Tj ET`));
    const strom2 = doc.context.register(doc.context.stream(`BT /F1 12 Tf 100 500 Td (${GEHEIM}) Tj ET`));
    seite.node.set(PDFName.of('Contents'), doc.context.obj([strom1, strom2]));
    seite.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { F1: font.ref } }));

    const geo = seitenGeometrieVon(seite);
    // GEHEIM im zweiten Stream bei User-Space (100, 500) → Basis-Rect darüber:
    const rect = basisNachUserSpace({ x: 100, y: 842 - 500 - 12, w: 150, h: 12 }, geo);
    const erg = redactiereSeite(doc, seite, [rect], geo);

    expect(erg.geaendert).toBe(true);
    const text = await extrahiereText(await doc.save());
    expect(text).not.toContain(GEHEIM);
    expect(text).toContain(OFFEN);
  });

  it('meldet Form-XObject-Text als Fallback-Signal statt rekursiv zu öffnen (Open Question 1)', async () => {
    const doc = await PDFDocument.load(await erzeugeXObjectTextPdf(GEHEIM));
    const seite = doc.getPage(0);
    const geo = seitenGeometrieVon(seite);
    const erg = redactiereSeite(doc, seite, [basisNachUserSpace({ x: 50, y: 100, w: 300, h: 50 }, geo)], geo);

    expect(erg.xobjectTextVerdacht).toBeGreaterThan(0);
    expect(erg.rotationsAbgelehnt).toBe(false);
    // Bewusst KEINE Rekursion: der XObject-Text übersteht den Rewrite — die Pipeline (03-07)
    // rasterisiert die Seite anhand des Signals bzw. das Verifikationsgate fängt Rest-Text.
    const text = await extrahiereText(await doc.save());
    expect(text).toContain(GEHEIM);
  });

  it('lehnt rotierte Seiten fail-closed ab, statt falsch zu positionieren (Pitfall 2, A7)', async () => {
    const fixture = await erzeugeRotiertesPdf();
    const doc = await PDFDocument.load(fixture.bytes);
    const seite = doc.getPage(0);
    const geo = seitenGeometrieVon(seite);
    const erg = redactiereSeite(doc, seite, [{ x: 0, y: 0, w: 200, h: 200 }], geo);

    expect(erg.rotationsAbgelehnt).toBe(true);
    expect(erg.geaendert).toBe(false);
    // Stream unverändert — der Text ist weiter extrahierbar (Fallback-Pfad entscheidet):
    const text = await extrahiereText(await doc.save());
    expect(text).toContain(fixture.text);
  });

  it('lässt Seiten ohne Schwärzungs-Rects unangetastet (frühe Rückkehr)', async () => {
    const fixture = await erzeugeTextPdf(OFFEN, 100, 700);
    const doc = await PDFDocument.load(fixture.bytes);
    const seite = doc.getPage(0);
    const erg = redactiereSeite(doc, seite, [], seitenGeometrieVon(seite));

    expect(erg).toEqual({ geaendert: false, xobjectTextVerdacht: 0, rotationsAbgelehnt: false });
    const text = await extrahiereText(await doc.save());
    expect(text).toContain(OFFEN);
  });
});
