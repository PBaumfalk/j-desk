/**
 * Vektor-Overlays für die annotierte PDF-Kopie (EXP-01, D-04): freigegebene marks/strokes/
 * stamps werden als echte PDF-Vektor-Operatoren an ihrer gespeicherten Geometrie eingebrannt
 * — der Dokumentinhalt bleibt vollständig und textwählbar (kein Raster-Abzug, Research
 * Locked Decision „Vektor-Overlays an gespeicherter Geometrie").
 *
 * SÄMTLICHE Koordinaten-Umrechnung läuft über coordinates.ts (Pitfall 1: Basiskoordinaten
 * y-down → User-Space y-up) — hier gibt es keinen eigenen Umrechnungs-Code. Seitenrotation
 * wird hier NICHT behandelt: die Pipeline (pdfExport.ts) schiebt rotierte Seiten vorher über
 * seiteBrauchtFallback in den Abbruch-/Raster-Pfad, Overlays kommen nur auf unrotierten
 * Seiten zum Zug.
 *
 * Farben: Schwärzungs-Overlays folgen der Client-Farbkonvention (MarkLayer.svelte:
 * .mark.redact #111, .mark.tippex #fff), Stempel dem StampLayer (rot #b3261e, blau #1d4ed8,
 * Rahmen + Konturschrift, halbtransparent .82), Strichfarben/-breiten kommen aus dem Modell
 * (Stroke.color/width), Werkzeug-Deckkraft aus der Client-Konvention (InkOverlay TOOL_STYLE:
 * Textmarker .35, Bleistift .9, Kugelschreiber 1). Keine neu erfundenen Farbwerte.
 *
 * Signatur-Hinweis: async statt void — Stempeltext braucht einen eingebetteten Font und
 * pdf-libs embedFont ist asynchron (pdf-lib cached pro Dokument, wiederholte Aufrufe sind
 * billig). Der Abweichung vom Plan-Entwurf (sync void) liegt kein Scope-Zuwachs zugrunde.
 */
import { LineCapStyle, StandardFonts, degrees, rgb } from 'pdf-lib';
import type { PDFPage, RGB } from 'pdf-lib';
import type { Mark, Stamp, Stroke, StrokeTool } from '@j-desk/core';
import type { SeitenGeometrie } from './coordinates';
import { basisNachUserSpace, punktNachUserSpace } from './coordinates';
import { winansiSanitize } from './layout';

/** Freigegebene, seitenverankerte Objekte einer einzelnen Seite. */
export interface SeitenObjekte {
  marks: Mark[];
  strokes: Stroke[];
  stamps: Stamp[];
}

// Schwärzungs-Flächen: Client-Farbkonvention MarkLayer.svelte (.mark.redact / .mark.tippex)
const REDACT_FARBE = rgb(0x11 / 255, 0x11 / 255, 0x11 / 255);
const TIPPEX_FARBE = rgb(1, 1, 1);

// Stempel: Client-Konvention StampLayer.svelte (Rahmen 3pt, opacity .82, Text 20pt, Datum 11pt)
const STEMPEL_FARBEN: Record<Stamp['color'], RGB> = {
  red: rgb(0xb3 / 255, 0x26 / 255, 0x1e / 255),
  blue: rgb(0x1d / 255, 0x4e / 255, 0xd8 / 255)
};
const STEMPEL_OPACITY = 0.82;
const STEMPEL_TEXT_GROESSE = 20;
const STEMPEL_DATUM_GROESSE = 11;
const STEMPEL_PAD_X = 10;

// Werkzeug-Deckkraft: Client-Konvention InkOverlay.svelte TOOL_STYLE (Textmarker legt sich
// halbtransparent über den Text, Kugelschreiber deckt voll)
const WERKZEUG_ALPHA: Record<StrokeTool, number> = { pen: 1, marker: 0.35, pencil: 0.9 };

/** Hex '#rrggbb' → RGB; Fremdwerte fallen auf Kugelschreiber-Schwarz (PEN_COLORS) zurück. */
function hexFarbe(hex: string): RGB {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return rgb(0x1b / 255, 0x1b / 255, 0x1b / 255);
  const v = parseInt(m[1], 16);
  return rgb(((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255);
}

/** ISO-Tag 'jjjj-mm-tt' → 'tt.mm.jjjj' (Anzeigeformat des Clients, StampLayer.datum). */
function datumFormatieren(iso: string): string {
  const [j, m, t] = iso.split('-');
  return j && m && t ? `${t}.${m}.${j}` : iso;
}

/**
 * Brennt die freigegebenen Objekte einer Seite als Vektor-Overlays ein. Seiten ohne
 * Annotationen bleiben unangetastet; die Seitenzahl des Dokuments ändert sich nie.
 * Erwartet UNrotierte Seiten (Rotation prüft die Pipeline vorher via seiteBrauchtFallback).
 */
export async function brenneOverlaysEin(page: PDFPage, objekte: SeitenObjekte, geo: SeitenGeometrie): Promise<void> {
  const { marks, strokes, stamps } = objekte;
  if (marks.length === 0 && strokes.length === 0 && stamps.length === 0) return;

  // Schwärzungs-Flächen: opake Rechteckfüllung an der umgerechneten Position.
  // Hinweis: redact-Marks wurden in der Pipeline ZUVOR echt redigiert (redact.ts) — das
  // Rechteck hier ist die sichtbare Abdeckung, die Sicherheit trägt der Content-Stream-Rewrite.
  for (const m of marks) {
    const r = basisNachUserSpace(m.rect, geo);
    page.drawRectangle({
      x: r.x,
      y: r.y,
      width: r.w,
      height: r.h,
      color: m.kind === 'redact' ? REDACT_FARBE : TIPPEX_FARBE,
      opacity: 1
    });
  }

  // Freihand-Striche: Punktfolge als verbundener Pfad, Farbe/Breite aus dem Modell,
  // Deckkraft nach Werkzeug (Textmarker = Highlighting).
  for (const st of strokes) {
    const punkte = st.points.map((p) => punktNachUserSpace(p.x, p.y, geo));
    const pfad =
      punkte
        .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`)
        .join(' ');
    page.drawSvgPath(pfad, {
      borderColor: hexFarbe(st.color),
      borderWidth: st.width,
      borderOpacity: WERKZEUG_ALPHA[st.tool],
      borderLineCap: LineCapStyle.Round
    });
  }

  // Stempel: x/y ist die StempelMITTE (stamps.ts) — Rahmen + Text werden um den
  // umgerechneten Mittelpunkt zentriert, nicht ab der linken oberen Ecke gezeichnet.
  if (stamps.length > 0) {
    const font = await page.doc.embedFont(StandardFonts.HelveticaBold);
    for (const st of stamps) {
      const mitte = punktNachUserSpace(st.x, st.y, geo);
      const farbe = STEMPEL_FARBEN[st.color];
      const text = winansiSanitize(st.text);
      const textW = font.widthOfTextAtSize(text, STEMPEL_TEXT_GROESSE);
      const datum = st.date !== undefined ? winansiSanitize(datumFormatieren(st.date)) : undefined;
      const datumW = datum !== undefined ? font.widthOfTextAtSize(datum, STEMPEL_DATUM_GROESSE) : 0;

      // Rahmengröße: Textbreite + Padding (Client: padding 2px 10px), Höhe deckt Text + ggf. Datum
      const boxW = Math.max(textW, datumW) + 2 * STEMPEL_PAD_X;
      const boxH = STEMPEL_TEXT_GROESSE + 8 + (datum !== undefined ? STEMPEL_DATUM_GROESSE + 6 : 0);
      // CSS rotate() ist im Uhrzeigersinn positiv, PDF-Rotation gegen den Uhrzeigersinn —
      // darum das Vorzeichen (Stempel sind nur leicht gedreht, die Zentrierung bleibt erhalten).
      const winkel = degrees(-st.angle);

      page.drawRectangle({
        x: mitte.x - boxW / 2,
        y: mitte.y - boxH / 2,
        width: boxW,
        height: boxH,
        borderColor: farbe,
        borderWidth: 3,
        borderOpacity: STEMPEL_OPACITY,
        rotate: winkel
      });
      // Baseline ≈ Mitte - 0.35 × Schriftgröße (optische Vertikalzentrierung);
      // mit Datum rückt der Text eine halbe Datum-Zeile nach oben.
      const textBaseline =
        mitte.y - STEMPEL_TEXT_GROESSE * 0.35 + (datum !== undefined ? (STEMPEL_DATUM_GROESSE + 6) / 2 : 0);
      page.drawText(text, {
        x: mitte.x - textW / 2,
        y: textBaseline,
        size: STEMPEL_TEXT_GROESSE,
        font,
        color: farbe,
        opacity: STEMPEL_OPACITY,
        rotate: winkel
      });
      if (datum !== undefined) {
        page.drawText(datum, {
          x: mitte.x - datumW / 2,
          y: textBaseline - (STEMPEL_DATUM_GROESSE + 6),
          size: STEMPEL_DATUM_GROESSE,
          font,
          color: farbe,
          opacity: STEMPEL_OPACITY,
          rotate: winkel
        });
      }
    }
  }
}
