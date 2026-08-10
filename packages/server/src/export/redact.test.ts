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

/**
 * Trefferregel: Lage des Rects GEGENÜBER der Startposition des Textoperators.
 *
 * Regressionsschutz für den Fehler „Schwärzung mitten in der Zeile wirkt nicht": geprüft
 * wurde früher nur, ob die START-Position des Operators im Rect liegt. Textverarbeitungen
 * schreiben eine Zeile als EINEN Tj mit Start am linken Zeilenrand — jede Schwärzung, die
 * nicht exakt dort ansetzte (Anschrift, IBAN, Name mitten im Satz: der Normalfall), traf ihn
 * nie. Der Text überlebte und das Verifikationsgate brach den Export ab.
 *
 * Die Äquivalenzklasse ist der x-Versatz des Rects gegenüber dem Operator-Start; die Fälle
 * unten laufen sie ab (Zeilenanfang → Mitte → letztes Wort → rechts daneben) und sichern das
 * Zeilenband gegen die Gegenrichtung ab (Nachbarzeilen dürfen nicht mitgelöscht werden).
 */
describe('redactiereSeite — Trefferregel gegenüber der Operator-Startposition', () => {
  const ZEILE = 'Die Zeugin Renate Meier, wohnhaft Lindenstrasse 14 in 48143 Muenster,';
  const ZEILE_DARUEBER = 'ZEILEDARUEBER-03-05';
  const ZEILE_DARUNTER = 'ZEILEDARUNTER-03-05';
  const LINKS = 'LINKERLAUF-03-05';
  const RECHTS = 'RECHTERLAUF-03-05';

  /** Seite mit je einem drawText pro Zeile (= ein Tj je Zeile, Start am linken Zeilenrand). */
  async function seiteMitZeilen(zeilen: Array<{ text: string; x: number; y: number }>) {
    const doc = await PDFDocument.create();
    const seite = doc.addPage([595, 842]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (const z of zeilen) seite.drawText(z.text, { x: z.x, y: z.y, size: 12, font });
    return { doc, seite, breiteVon: (t: string) => font.widthOfTextAtSize(t, 12) };
  }

  /** Basis-Rect über einem Textstück derselben Zeile (Grundlinie y im User-Space, Größe 12). */
  function rectUeber(x: number, breite: number, y: number) {
    return { x, y: 842 - y - 12, w: breite, h: 12 };
  }

  it('Rect deckt nur den hinteren Teil der Zeile ⇒ der Operator wird trotzdem gelöscht', async () => {
    const { doc, seite, breiteVon } = await seiteMitZeilen([{ text: ZEILE, x: 60, y: 760 }]);
    const geo = seitenGeometrieVon(seite);
    const vorlauf = breiteVon('Die Zeugin Renate Meier, wohnhaft ');
    const rect = rectUeber(60 + vorlauf, breiteVon('Lindenstrasse 14 in 48143 Muenster,'), 760);

    const erg = redactiereSeite(doc, seite, [basisNachUserSpace(rect, geo)], geo);

    expect(erg.geaendert).toBe(true);
    expect(await extrahiereText(await doc.save())).not.toContain('Lindenstrasse');
  });

  it('Rect deckt nur das letzte Wort der Zeile ⇒ gelöscht (äußerster Punkt der Klasse)', async () => {
    const { doc, seite, breiteVon } = await seiteMitZeilen([{ text: ZEILE, x: 60, y: 760 }]);
    const geo = seitenGeometrieVon(seite);
    const vorlauf = breiteVon(ZEILE.slice(0, ZEILE.length - 'Muenster,'.length));
    const rect = rectUeber(60 + vorlauf, breiteVon('Muenster,'), 760);

    const erg = redactiereSeite(doc, seite, [basisNachUserSpace(rect, geo)], geo);

    expect(erg.geaendert).toBe(true);
    expect(await extrahiereText(await doc.save())).not.toContain('Muenster');
  });

  it('Nachbarzeilen (22 pt Abstand) bleiben erhalten — das Zeilenband greift nicht über', async () => {
    const { doc, seite, breiteVon } = await seiteMitZeilen([
      { text: ZEILE_DARUEBER, x: 60, y: 782 },
      { text: ZEILE, x: 60, y: 760 },
      { text: ZEILE_DARUNTER, x: 60, y: 738 },
    ]);
    const geo = seitenGeometrieVon(seite);
    const vorlauf = breiteVon('Die Zeugin Renate Meier, wohnhaft ');
    const rect = rectUeber(60 + vorlauf, breiteVon('Lindenstrasse 14 in 48143 Muenster,'), 760);

    redactiereSeite(doc, seite, [basisNachUserSpace(rect, geo)], geo);

    const text = await extrahiereText(await doc.save());
    expect(text).not.toContain('Lindenstrasse');
    expect(text).toContain(ZEILE_DARUEBER);
    expect(text).toContain(ZEILE_DARUNTER);
  });

  it('Textlauf RECHTS der Fläche bleibt, Textlauf LINKS davon fällt weg (bewusste Über-Löschung)', async () => {
    // Ohne Glyphenbreiten ist nicht entscheidbar, wie weit ein links beginnender Lauf reicht —
    // er wird deshalb gelöscht (fail-closed-Richtung, sichtbar und unkritisch). Ein Lauf, der
    // erst RECHTS der Fläche ansetzt, kann sie nicht erreichen und bleibt.
    const { doc, seite } = await seiteMitZeilen([
      { text: LINKS, x: 60, y: 760 },
      { text: RECHTS, x: 400, y: 760 },
    ]);
    const geo = seitenGeometrieVon(seite);
    const rect = rectUeber(200, 100, 760); // Fläche zwischen beiden Läufen

    redactiereSeite(doc, seite, [basisNachUserSpace(rect, geo)], geo);

    const text = await extrahiereText(await doc.save());
    expect(text).not.toContain(LINKS);
    expect(text).toContain(RECHTS);
  });

  it('Schriftgröße in der Textmatrix statt im Tf ⇒ das Zeilenband skaliert trotzdem mit', async () => {
    // Verbreitetes Muster "/F1 1 Tf 12 0 0 12 x y Tm": die Tf-Größe ist 1, die tatsächliche
    // Schriftgröße steckt in der Matrix. Wird sie nicht mitskaliert, ist das Zeilenband nur
    // 1 pt hoch — eine Fläche, die bloß die Oberlängen abdeckt (typisch zu hoch gezogener
    // Balken), verfehlte die Grundlinie und der Text überlebte.
    const doc = await PDFDocument.create();
    const seite = doc.addPage([595, 842]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    seite.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { F1: font.ref } }));
    seite.node.set(
      PDFName.of('Contents'),
      doc.context.register(doc.context.stream(`BT /F1 1 Tf 12 0 0 12 60 760 Tm (${GEHEIM}) Tj ET`))
    );
    const geo = seitenGeometrieVon(seite);
    // Fläche NUR über den Oberlängen (Grundlinie 760 liegt darunter, nicht im Rect):
    const rect = basisNachUserSpace(rectUeber(60, 200, 766), geo);

    const erg = redactiereSeite(doc, seite, [rect], geo);

    expect(erg.geaendert).toBe(true);
    expect(await extrahiereText(await doc.save())).not.toContain(GEHEIM);
  });
});
