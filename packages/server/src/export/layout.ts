import { PDFDocument, StandardFonts, type PDFFont, type PDFPage } from 'pdf-lib';

/**
 * Cursor-Flow-Layout-Helfer für die Übersichts-PDFs (EXP-05, 03-RESEARCH Pattern 4):
 * bewusst KEINE Layout-Engine — y läuft von oben nach unten, ensureSpace bricht die
 * Seite um und zeichnet Kopfzeile (Titel links) und Fußzeile („Seite n" rechts) auf
 * jeder Seite neu. Grundlage aller Übersichten inkl. Fundstellen-PDF (03-08).
 */

/** Seitengeometrie A4 — exportiert, damit Übersichten Freiflächen konsistent berechnen. */
export const SEITE_W = 595; // A4 in PDF-Punkten
export const SEITE_H = 842;
export const RAND = 50;
const ZEILEN_H = 16;
const KOPF_GROESSE = 9;
const ZELLEN_PAD = 8;

/**
 * WinAnsi-Sanitize (Pitfall 7, 03-RESEARCH): StandardFonts.Helvetica ist WinAnsi-kodiert
 * und wirft bei drawText auf Zeichen außerhalb von Latin-1 + der WinAnsi-Sonderzeichen
 * (€ „ … “ ” – —). Alles andere wird durch '?' ersetzt, damit die Erzeugung nie an einem
 * einzelnen Zeichen scheitert. Helvetica/WinAnsi deckt Deutsch inkl. äöüß§€ ab — kein
 * fontkit in dieser Phase. (Das naheliegende U+FFFD ist selbst nicht WinAnsi-kodierbar —
 * es würde denselben Fehler erneut auslösen.)
 */
const WINANSI_SONDERZEICHEN = new Set([...'€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ']);

export function winansiSanitize(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    out += (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || WINANSI_SONDERZEICHEN.has(ch) ? ch : '?';
  }
  return out;
}

/** Zeilenumbruch an Wortgrenzen; misst am bereits sanitisierten Text (Glyph-Breiten). */
export function wrapText(text: string, font: PDFFont, groesse: number, maxBreite: number): string[] {
  const worte = text.split(/\s+/).filter(Boolean);
  const zeilen: string[] = [];
  let aktuell = '';
  for (const wort of worte) {
    const kandidat = aktuell === '' ? wort : `${aktuell} ${wort}`;
    if (font.widthOfTextAtSize(winansiSanitize(kandidat), groesse) <= maxBreite) {
      aktuell = kandidat;
    } else {
      if (aktuell !== '') zeilen.push(aktuell);
      aktuell = wort;
    }
  }
  if (aktuell !== '') zeilen.push(aktuell);
  return zeilen.length > 0 ? zeilen : [''];
}

export interface ZeilenOpts {
  groesse?: number;
  fett?: boolean;
  einzug?: number;
}

/** Öffentliche Cursor-Sicht: y ist die Oberkante der nächsten Zeile (läuft abwärts). */
export interface Layout {
  readonly y: number;
  seite(): PDFPage;
  ensureSpace(hoehe: number): void;
  reserviere(hoehe: number): void;
  zeile(text: string, opts?: ZeilenOpts): void;
  absatz(text: string, opts?: ZeilenOpts & { abstand?: number }): void;
  tabelle(kopf: string[], zeilen: string[][], spalten: number[]): void;
}

class CursorLayout implements Layout {
  private aktuelle: PDFPage;
  private cursorY: number;
  private seitenNr = 0;

  constructor(
    private pdf: PDFDocument,
    private font: PDFFont,
    private fett: PDFFont,
    private titel: string,
  ) {
    this.aktuelle = this.neueSeite();
  }

  get y(): number {
    return this.cursorY;
  }

  seite(): PDFPage {
    return this.aktuelle;
  }

  /** Kopf- und Fußzeile gehören zur Seite, nicht zum Inhalt — darum hier zentral. */
  private neueSeite(): PDFPage {
    const s = this.pdf.addPage([SEITE_W, SEITE_H]);
    this.seitenNr += 1;
    s.drawText(winansiSanitize(this.titel), { x: RAND, y: SEITE_H - RAND + 16, size: KOPF_GROESSE, font: this.fett });
    const fuss = `Seite ${this.seitenNr}`;
    s.drawText(fuss, {
      x: SEITE_W - RAND - this.font.widthOfTextAtSize(fuss, KOPF_GROESSE),
      y: RAND - 20,
      size: KOPF_GROESSE,
      font: this.font,
    });
    this.cursorY = SEITE_H - RAND;
    return s;
  }

  ensureSpace(hoehe: number): void {
    if (this.cursorY - hoehe < RAND) this.aktuelle = this.neueSeite();
  }

  /** Reserviert eine freiförmige Zeichenfläche (z. B. Snapshot-Miniaturen) im Fluss. */
  reserviere(hoehe: number): void {
    this.ensureSpace(hoehe);
    this.cursorY -= hoehe;
  }

  private textZeile(text: string, f: PDFFont, groesse: number, einzug: number): void {
    this.aktuelle.drawText(winansiSanitize(text), {
      x: RAND + einzug,
      y: this.cursorY - ZEILEN_H + 4,
      size: groesse,
      font: f,
    });
    this.cursorY -= ZEILEN_H;
  }

  /** Eine logische Zeile; langer Text läuft an Wortgrenzen in Folgezeilen um. */
  zeile(text: string, opts: ZeilenOpts = {}): void {
    const { groesse = 11, fett = false, einzug = 0 } = opts;
    const f = fett ? this.fett : this.font;
    for (const teil of wrapText(text, f, groesse, SEITE_W - 2 * RAND - einzug)) {
      this.ensureSpace(ZEILEN_H);
      if (teil !== '') this.textZeile(teil, f, groesse, einzug);
      else this.cursorY -= ZEILEN_H;
    }
  }

  /** Absatz = Zeile(n) plus Nachabstand (Default: eine halbe Zeile). */
  absatz(text: string, opts: ZeilenOpts & { abstand?: number } = {}): void {
    const { abstand = ZEILEN_H / 2, ...zeilenOpts } = opts;
    this.zeile(text, zeilenOpts);
    this.ensureSpace(abstand);
    this.cursorY -= abstand;
  }

  /**
   * Tabelle mit festen Spaltenbreiten (PDF-Punkte, ab linkem Rand): jede Zelle umbricht
   * in ihrer Spalte, die Zeilenhöhe richtet sich nach der höchsten Zelle — so kann nichts
   * überlappen. Der Kopf wird nach einem Seitenumbruch innerhalb der Tabelle wiederholt.
   */
  tabelle(kopf: string[], zeilen: string[][], spalten: number[]): void {
    const spaltenX = [0];
    for (let i = 0; i < spalten.length - 1; i++) spaltenX.push(spaltenX[i] + spalten[i]);

    const zeichneZeile = (zellen: string[], f: PDFFont): void => {
      const gewrapt = zellen.map((z, i) => wrapText(z, f, 10, spalten[i] - ZELLEN_PAD));
      const hoehe = Math.max(...gewrapt.map((g) => g.length)) * ZEILEN_H;
      if (this.cursorY - hoehe < RAND) {
        this.aktuelle = this.neueSeite();
        if (f === this.font) zeichneZeile(kopf, this.fett); // Kopf wiederholen
      }
      gewrapt.forEach((zellenZeilen, i) => {
        zellenZeilen.forEach((t, zeilenIdx) => {
          if (t === '') return;
          this.aktuelle.drawText(winansiSanitize(t), {
            x: RAND + spaltenX[i],
            y: this.cursorY - ZEILEN_H + 4 - zeilenIdx * ZEILEN_H,
            size: 10,
            font: f,
          });
        });
      });
      this.cursorY -= hoehe;
    };

    zeichneZeile(kopf, this.fett);
    this.cursorY -= 4;
    for (const z of zeilen) zeichneZeile(z, this.font);
  }
}

/** Erstellt den Layout-Cursor auf einem neuen PDF; die erste Seite trägt sofort Kopf-/Fußzeile. */
export async function erstelleLayout(pdf: PDFDocument, titel: string): Promise<Layout> {
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const fett = await pdf.embedFont(StandardFonts.HelveticaBold);
  return new CursorLayout(pdf, font, fett, titel);
}
