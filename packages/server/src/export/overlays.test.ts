/**
 * Pflichttests für die Vektor-Overlays (EXP-01, D-04): marks/strokes/stamps müssen an der
 * per coordinates.ts umgerechneten Position als Vektoren im Content-Stream landen —
 * nicht gespiegelt, nicht versetzt (Pitfall 1), Stempel zentriert auf ihrer Mitte.
 * Orakel zweigleisig: Operator-Ebene (contentStreamTokenizer auf dem dekodierten Stream)
 * für Geometrie/Farbe, pdfjs-Extraktion (verify.ts) für den Stempeltext.
 */
import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import type { Mark, Stamp, Stroke } from '@j-desk/core';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { erzeugeTextPdf } from './pdfTestFixtures';
import { seitenGeometrieVon } from './coordinates';
import { tokenisiere, type Element } from './contentStreamTokenizer';
import { extrahiereText } from './verify';
import { brenneOverlaysEin } from './overlays';

/** Dekodiert alle Contents-Streams einer Seite aus den GESPEICHERTEN Bytes und tokenisiert sie. */
async function streamOperatoren(bytes: Uint8Array, seitenIndex = 0): Promise<Element[]> {
  const doc = await PDFDocument.load(bytes);
  const seite = doc.getPage(seitenIndex);
  const contents = seite.node.get(PDFName.of('Contents'));
  const eintraege = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];
  const teile: Uint8Array[] = [];
  for (const eintrag of eintraege) {
    const obj = doc.context.lookup(eintrag);
    if (obj instanceof PDFRawStream) teile.push(decodePDFRawStream(obj).decode());
  }
  const gesamt = teile.reduce((s, t) => s + t.length, 0);
  const roh = new Uint8Array(gesamt);
  let o = 0;
  for (const t of teile) {
    roh.set(t, o);
    o += t.length;
  }
  return tokenisiere(roh);
}

/**
 * Findet ein gefülltes Rechteck an der Zielposition samt letzter Füllfarbe (`rg`).
 * pdf-lib zeichnet drawRectangle NICHT als `re`-Operator, sondern als Pfad (m/l/h/f) unter
 * einer `cm`-Translation — deshalb: cm mit Ziel-Ursprung finden, dann die Pfad-Ausdehnung
 * bis zum Füll-Operator messen.
 */
function findeRechteck(
  elemente: Element[],
  ziel: { x: number; y: number; w: number; h: number }
): { farbe: number[]; gefuellt: boolean } | undefined {
  let rg: number[] = [];
  for (let i = 0; i < elemente.length; i++) {
    const el = elemente[i];
    if (el.op === 'rg') rg = el.operande.map((o) => Number(o.wert));
    if (el.op === 'cm') {
      const v = el.operande.map((o) => Number(o.wert));
      const istTranslation =
        Math.abs(v[0] - 1) < 0.01 && Math.abs(v[1]) < 0.01 && Math.abs(v[2]) < 0.01 && Math.abs(v[3] - 1) < 0.01 &&
        Math.abs(v[4] - ziel.x) < 0.5 && Math.abs(v[5] - ziel.y) < 0.5;
      if (!istTranslation) continue;
      const punkte: Array<[number, number]> = [];
      let gefuellt = false;
      for (const f of elemente.slice(i + 1, i + 12)) {
        if (f.op === 'm' || f.op === 'l') punkte.push([Number(f.operande[0].wert), Number(f.operande[1].wert)]);
        if (f.op === 'f') {
          gefuellt = true;
          break;
        }
      }
      if (punkte.length < 4) continue;
      const xs = punkte.map((p) => p[0]);
      const ys = punkte.map((p) => p[1]);
      const w = Math.max(...xs) - Math.min(...xs);
      const h = Math.max(...ys) - Math.min(...ys);
      if (Math.abs(w - ziel.w) < 0.5 && Math.abs(h - ziel.h) < 0.5) return { farbe: rg, gefuellt };
    }
  }
  return undefined;
}

/** Sucht einen Pfad-Operator (m/l) an einer Zielposition. */
function hatPfadPunkt(elemente: Element[], op: 'm' | 'l', x: number, y: number): boolean {
  return elemente.some(
    (el) =>
      el.op === op &&
      Math.abs(Number(el.operande[0]?.wert) - x) < 0.5 &&
      Math.abs(Number(el.operande[1]?.wert) - y) < 0.5
  );
}

describe('brenneOverlaysEin — Vektor-Overlays an gespeicherter Geometrie', () => {
  it('redact-Mark erzeugt opakes #111-Rechteck, tippex-Mark weißes — an umgerechneter Position', async () => {
    const fixture = await erzeugeTextPdf('MARKTEXT-03-07', 100, 700);
    const doc = await PDFDocument.load(fixture.bytes);
    const seite = doc.getPage(0);
    const geo = seitenGeometrieVon(seite);
    const marks: Mark[] = [
      { id: 'm1', docId: 'd1', page: 1, rect: fixture.basis, kind: 'redact' },
      { id: 'm2', docId: 'd1', page: 1, rect: { x: 50, y: 50, w: 80, h: 14 }, kind: 'tippex' },
    ];

    await brenneOverlaysEin(seite, { marks, strokes: [], stamps: [] }, geo);
    const elemente = await streamOperatoren(await doc.save());

    // Basis (100,130) → User-Space y = 842 - 130 - 12 = 700 (exakt die Textposition der Fixture)
    const redact = findeRechteck(elemente, { x: 100, y: 700, w: fixture.basis.w, h: 12 });
    expect(redact).toBeDefined();
    expect(redact!.farbe[0]).toBeCloseTo(0x11 / 255, 3); // #111 = Client-Konvention .mark.redact
    expect(redact!.farbe[1]).toBeCloseTo(0x11 / 255, 3);
    expect(redact!.farbe[2]).toBeCloseTo(0x11 / 255, 3);
    expect(redact!.gefuellt).toBe(true); // gefüllt + opacity 1 = opak

    // Basis (50,50) → User-Space y = 842 - 50 - 14 = 778
    const tippex = findeRechteck(elemente, { x: 50, y: 778, w: 80, h: 14 });
    expect(tippex).toBeDefined();
    expect(tippex!.farbe[0]).toBeCloseTo(1, 3); // #fff = Client-Konvention .mark.tippex
    expect(tippex!.farbe[1]).toBeCloseTo(1, 3);
    expect(tippex!.farbe[2]).toBeCloseTo(1, 3);
    expect(tippex!.gefuellt).toBe(true);
  });

  it('zeichnet Stroke-Punktfolge als Linienpfad mit Modell-Farbe/-Breite (Punkte einzeln umgerechnet)', async () => {
    const fixture = await erzeugeTextPdf('STROKE-03-07', 100, 700);
    const doc = await PDFDocument.load(fixture.bytes);
    const seite = doc.getPage(0);
    const geo = seitenGeometrieVon(seite);
    const strokes: Stroke[] = [
      {
        id: 's1', docId: 'd1', page: 1, tool: 'pen', color: '#1d3557', width: 1.5,
        points: [
          { x: 100, y: 100 },
          { x: 150, y: 130 },
          { x: 200, y: 110 },
        ],
      },
    ];

    await brenneOverlaysEin(seite, { marks: [], strokes, stamps: [] }, geo);
    const elemente = await streamOperatoren(await doc.save());

    // Jeder Punkt einzeln per punktNachUserSpace: (100,742), (150,712), (200,732)
    expect(hatPfadPunkt(elemente, 'm', 100, 742)).toBe(true);
    expect(hatPfadPunkt(elemente, 'l', 150, 712)).toBe(true);
    expect(hatPfadPunkt(elemente, 'l', 200, 732)).toBe(true);
    // Strichbreite aus dem Modell
    expect(
      elemente.some((el) => el.op === 'w' && Math.abs(Number(el.operande[0]?.wert) - 1.5) < 0.01)
    ).toBe(true);
    // Strichfarbe aus dem Modell (#1d3557, Kugelschreiber-Blau)
    expect(
      elemente.some(
        (el) =>
          el.op === 'RG' &&
          Math.abs(Number(el.operande[0]?.wert) - 0x1d / 255) < 0.01 &&
          Math.abs(Number(el.operande[1]?.wert) - 0x35 / 255) < 0.01 &&
          Math.abs(Number(el.operande[2]?.wert) - 0x57 / 255) < 0.01
      )
    ).toBe(true);
  });

  it('Stamp erscheint an seiner Mitte (nicht Ecke); Stempeltext ist extrahierbar', async () => {
    const fixture = await erzeugeTextPdf('STEMPEL-GRUNDLAGE-03-07', 100, 700);
    const doc = await PDFDocument.load(fixture.bytes);
    const seite = doc.getPage(0);
    const geo = seitenGeometrieVon(seite);
    const stamps: Stamp[] = [
      { id: 'st1', docId: 'd1', page: 1, x: 200, y: 300, angle: 0, text: 'GEPRUEFT-03-07', color: 'blue', baseW: 595, baseH: 842 },
    ];

    await brenneOverlaysEin(seite, { marks: [], strokes: [], stamps }, geo);
    const bytes = await doc.save();

    // Kopien: pdfjs detacht den übergebenen Buffer — dasselbe Array zweimal zu öffnen
    // würde mit "Unable to deserialize cloned data" scheitern.
    const text = await extrahiereText(new Uint8Array(bytes));
    expect(text).toContain('GEPRUEFT-03-07');

    // Positionsbeweis über die pdfjs-Text-Transform: x = transform[4], Baseline-y = transform[5]
    // (default user space). Mitte = x + width/2 muss bei 200 liegen, die Baseline nahe 542.
    const pdf = await getDocument({ data: new Uint8Array(bytes), useWorkerFetch: false, isEvalSupported: false }).promise;
    try {
      const p = await pdf.getPage(1);
      const tc = await p.getTextContent();
      const item = tc.items.find((it) => 'str' in it && it.str.includes('GEPRUEFT-03-07')) as
        | { transform: number[]; width: number }
        | undefined;
      expect(item).toBeDefined();
      const mitteX = item!.transform[4] + item!.width / 2;
      expect(Math.abs(mitteX - 200)).toBeLessThan(3); // Mitte, nicht linke Ecke
      expect(Math.abs(item!.transform[5] - (842 - 300))).toBeLessThan(12); // Baseline nahe Mitte, nicht Ecke
    } finally {
      await pdf.destroy();
    }
  });

  it('verändert die Seitenzahl nicht und toleriert Seiten ohne Annotationen', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([595, 842]);
    doc.addPage([595, 842]);
    const seite = doc.getPage(1);
    const geo = seitenGeometrieVon(seite);

    await expect(brenneOverlaysEin(seite, { marks: [], strokes: [], stamps: [] }, geo)).resolves.toBeUndefined();
    const bytes = await doc.save();
    const geprueft = await PDFDocument.load(bytes);
    expect(geprueft.getPageCount()).toBe(2);
  });
});
