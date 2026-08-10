/**
 * Content-Stream-Rewriter — der EXP-04-Kern und der einzige unvermeidbare Hand-Roll der
 * Phase (pdf-lib hat keine Redaktions-API, 03-RESEARCH Pattern 1). Textzeige-Operatoren
 * (Tj, TJ, ', "), deren Startposition in einem Schwärzungs-Rect liegt, werden aus dem Stream
 * GELÖSCHT — nicht übermalt. Übermalen ließe den Text per Copy/Paste/Extraktion lesbar und
 * wäre genau der Verstoß (T-03-05-01), den der Pflichttest sucht (D-01).
 *
 * Entscheidende Vereinfachung (03-RESEARCH): KEIN Font-Metrik-/Glyphen-Breiten-Nachbau —
 * gelöscht wird, sobald die Startposition im um die aktuelle Font-Size erweiterten Rect liegt,
 * im Zweifel wird gelöscht (fail-closed-Richtung). Fehlgriffe nach außen (zu viel gelöscht)
 * sind sicherheitsunkritisch und visuell sichtbar; Rest-Text fängt das pdfjs-
 * Verifikationsgate in 03-07 fail-closed ab.
 *
 * KEINE Rekursion in Form-XObjects (Open Question 1): Do-Verweise auf Form-XObjects mit
 * Font-Ressourcen werden nur gezählt (xobjectTextVerdacht) — die Pipeline entscheidet über
 * den Raster-Fallback. Rotierte Seiten lehnt der Rewriter ab (rotationsAbgelehnt, Pitfall 2,
 * Entscheidung A7), statt heimlich falsch zu positionieren.
 *
 * Parse-Fehler (kaputte Streams, unbekannte Filter) propagieren als Exception — 03-07
 * normalisiert sie zu ExportFehler/422 (T-03-05-05). Der Operator-Tokenizer liegt in
 * contentStreamTokenizer.ts (Fortschritts-Garantie siehe dort).
 */
import { PDFArray, PDFDict, PDFName, PDFRawStream, PDFStream, decodePDFRawStream } from 'pdf-lib';
import type { PDFDocument, PDFPage } from 'pdf-lib';
import { zlibSync } from 'fflate';
import type { SeitenGeometrie, UserSpaceRect } from './coordinates';
import { seiteBrauchtFallback } from './coordinates';
import { tokenisiere } from './contentStreamTokenizer';

/** Ergebnis-Signale an die Pipeline (03-07) — sie entscheidet über Raster-Fallback/Abbruch. */
export interface RedaktionsErgebnis {
  /** true, wenn mindestens ein Textoperator gelöscht und der Stream neu geschrieben wurde. */
  geaendert: boolean;
  /** Anzahl Do-Verweise auf Form-XObjects MIT Font-Ressourcen (Textverdacht — NICHT geöffnet). */
  xobjectTextVerdacht: number;
  /** true, wenn die Seite rotiert ist und der Rewrite fail-closed abgelehnt wurde. */
  rotationsAbgelehnt: boolean;
}

interface Matrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

const IDENTITAET: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

function translate(tx: number, ty: number): Matrix {
  return { a: 1, b: 0, c: 0, d: 1, e: tx, f: ty };
}

/** PDF-Matrizenprodukt m1 × m2 (m2 wird zuerst angewendet). */
function multiply(m1: Matrix, m2: Matrix): Matrix {
  return {
    a: m1.a * m2.a + m1.b * m2.c,
    b: m1.a * m2.b + m1.b * m2.d,
    c: m1.c * m2.a + m1.d * m2.c,
    d: m1.c * m2.b + m1.d * m2.d,
    e: m1.e * m2.a + m1.f * m2.c + m2.e,
    f: m1.e * m2.b + m1.f * m2.d + m2.f
  };
}

/** Alle Contents-Streams der Seite (Einzel-Ref ODER Array, Pitfall 4) — in Reihenfolge konkateniert. */
function seitenBytes(pdfDoc: PDFDocument, page: PDFPage): Uint8Array {
  const contents = page.node.get(PDFName.of('Contents'));
  const teile: Uint8Array[] = [];
  const einsammeln = (eintrag: Parameters<PDFDocument['context']['lookup']>[0]): void => {
    const obj = pdfDoc.context.lookup(eintrag);
    if (obj instanceof PDFRawStream) {
      teile.push(decodePDFRawStream(obj).decode());
    } else if (obj instanceof PDFStream) {
      // In-Session-Streams (PDFContentStream aus drawText derselben Sitzung) sind keine
      // RawStreams — Operatoren unkomprimiert lesen (Pipeline-Realität: 03-07 redigiert
      // VOR dem Einbrennen, also normalerweise reine RawStreams; dieser Zweig fängt den Rest).
      teile.push((obj as unknown as { getUnencodedContents(): Uint8Array }).getUnencodedContents());
    }
  };
  if (contents instanceof PDFArray) {
    for (let idx = 0; idx < contents.size(); idx++) einsammeln(contents.get(idx));
  } else if (contents) {
    einsammeln(contents);
  }
  // Zeilenumbruch als Trenner — sonst könnten Stream-Grenzen Tokens verschmelzen
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

/** Do-Verweis auf ein Form-XObject MIT Font-Ressourcen = Textverdacht (T-03-05-03). KEIN Öffnen des Streams. */
function xobjectMitTextverdacht(pdfDoc: PDFDocument, page: PDFPage, name: string): boolean {
  const resources = page.node.Resources();
  if (!resources) return false;
  const xobjects = resources.lookupMaybe(PDFName.of('XObject'), PDFDict);
  if (!xobjects) return false;
  const eintrag = pdfDoc.context.lookup(xobjects.get(PDFName.of(name)));
  if (!(eintrag instanceof PDFRawStream)) return false;
  const subtype = eintrag.dict.lookupMaybe(PDFName.of('Subtype'), PDFName);
  if (subtype !== PDFName.of('Form')) return false;
  const xres = eintrag.dict.lookupMaybe(PDFName.of('Resources'), PDFDict);
  return xres?.has(PDFName.of('Font')) ?? false;
}

/** Startposition des Textes im User-Space: Text-Ursprung durch Textmatrix × CTM. */
function textPosition(tm: Matrix, ctm: Matrix): { x: number; y: number } {
  const kombiniert = multiply(tm, ctm);
  return { x: kombiniert.e, y: kombiniert.f };
}

/** Positions-Check gegen die um die Font-Size erweiterten Rects (Sicherheitsmarge, fail-closed). */
function trifft(pos: { x: number; y: number }, rects: UserSpaceRect[], marge: number): boolean {
  return rects.some(
    (r) => pos.x >= r.x - marge && pos.x <= r.x + r.w + marge && pos.y >= r.y - marge && pos.y <= r.y + r.h + marge
  );
}

/** Entfernt die Byte-Bereiche (aufsteigend, überlappungsfrei) und setzt Zeilenumbrüche als Token-Trenner. */
function entferneBereiche(bytes: Uint8Array, bereiche: Array<[number, number]>): Uint8Array {
  const teile: Uint8Array[] = [];
  let cursor = 0;
  for (const [start, end] of bereiche) {
    teile.push(bytes.subarray(cursor, start));
    teile.push(new Uint8Array([0x0a]));
    cursor = end;
  }
  teile.push(bytes.subarray(cursor));
  const gesamt = teile.reduce((s, t) => s + t.length, 0);
  const out = new Uint8Array(gesamt);
  let o = 0;
  for (const t of teile) {
    out.set(t, o);
    o += t.length;
  }
  return out;
}

/**
 * Löscht alle Textzeige-Operatoren, deren Startposition in einem der Schwärzungs-Rects
 * (User-Space, via coordinates.ts umgerechnet) liegt, aus dem Content-Stream der Seite.
 * Rects werden um die jeweils aktuelle Font-Size erweitert — im Zweifel wird gelöscht.
 */
export function redactiereSeite(
  pdfDoc: PDFDocument,
  page: PDFPage,
  rectsUserSpace: UserSpaceRect[],
  geo: SeitenGeometrie
): RedaktionsErgebnis {
  // Fail-closed bei Rotation (Pitfall 2, A7): Pipeline rasterisiert/bricht ab, statt falsch zu positionieren.
  if (seiteBrauchtFallback(geo)) {
    return { geaendert: false, xobjectTextVerdacht: 0, rotationsAbgelehnt: true };
  }
  // Seiten ohne Schwärzungs-Rects bleiben unangetastet.
  if (rectsUserSpace.length === 0) {
    return { geaendert: false, xobjectTextVerdacht: 0, rotationsAbgelehnt: false };
  }

  const roh = seitenBytes(pdfDoc, page);
  const elemente = tokenisiere(roh);

  // Grafik-/Text-State nur so weit nötig: CTM-Stack, Textmatrix, Zeilenabstand, Font-Size
  let ctm = IDENTITAET;
  const stapel: Matrix[] = [];
  let tm = IDENTITAET;
  let tlm = IDENTITAET;
  let zeilenabstand = 0;
  let fontSize = 0;

  const loeschBereiche: Array<[number, number]> = [];
  let xobjectTextVerdacht = 0;
  const naechsteZeile = (): void => {
    tlm = multiply(translate(0, -zeilenabstand), tlm);
    tm = tlm;
  };

  for (const el of elemente) {
    const zahl = (idx: number): number => Number(el.operande[idx]?.wert ?? 0);
    switch (el.op) {
      case 'q':
        stapel.push(ctm);
        break;
      case 'Q':
        ctm = stapel.pop() ?? ctm; // unausgeglichenes Q: Stand behalten, weiter (Gate prüft nach)
        break;
      case 'cm':
        ctm = multiply({ a: zahl(0), b: zahl(1), c: zahl(2), d: zahl(3), e: zahl(4), f: zahl(5) }, ctm);
        break;
      case 'BT':
        tm = IDENTITAET;
        tlm = IDENTITAET;
        break;
      case 'Tm':
        tm = { a: zahl(0), b: zahl(1), c: zahl(2), d: zahl(3), e: zahl(4), f: zahl(5) };
        tlm = tm;
        break;
      case 'Td':
        tlm = multiply(translate(zahl(0), zahl(1)), tlm);
        tm = tlm;
        break;
      case 'TD':
        zeilenabstand = -zahl(1);
        tlm = multiply(translate(zahl(0), zahl(1)), tlm);
        tm = tlm;
        break;
      case 'TL':
        zeilenabstand = zahl(0);
        break;
      case 'T*':
        naechsteZeile();
        break;
      case 'Tf':
        fontSize = zahl(1);
        break;
      case 'Tj':
      case 'TJ':
        if (trifft(textPosition(tm, ctm), rectsUserSpace, fontSize)) loeschBereiche.push([el.start, el.end]);
        break;
      case "'":
      case '"':
        // ' und " wechseln vor dem Zeigen in die nächste Zeile (wie T*)
        naechsteZeile();
        if (trifft(textPosition(tm, ctm), rectsUserSpace, fontSize)) loeschBereiche.push([el.start, el.end]);
        break;
      case 'Do': {
        // KEINE Rekursion (Open Question 1): Form-XObject mit Fonts = Fallback-Signal
        const name = el.operande[el.operande.length - 1]?.wert;
        if (name && xobjectMitTextverdacht(pdfDoc, page, name)) xobjectTextVerdacht++;
        break;
      }
      default:
        break;
    }
  }

  if (loeschBereiche.length === 0) {
    return { geaendert: false, xobjectTextVerdacht, rotationsAbgelehnt: false };
  }

  const neu = entferneBereiche(roh, loeschBereiche);
  // zlibSync (RFC 1950 mit Header) — FlateDecode erwartet zlib, NICHT rohes deflate
  // (fflate deflateSync würde einen „Unknown compression method"-Fehler beim Dekodieren erzeugen)
  const stream = pdfDoc.context.stream(zlibSync(neu), { Filter: 'FlateDecode' });
  const ref = pdfDoc.context.register(stream);
  page.node.set(PDFName.of('Contents'), ref);
  return { geaendert: true, xobjectTextVerdacht, rotationsAbgelehnt: false };
}
