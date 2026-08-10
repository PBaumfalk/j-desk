import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { erstelleLayout, winansiSanitize, wrapText } from './layout';
import { extrahiereSeiten } from './verify';

/**
 * Layout-Helfer (EXP-05, 03-RESEARCH Pattern 4): Cursor-Fluss ohne Layout-Engine —
 * Wrap an Wortgrenzen, Seitenumbruch mit Kopf-/Fußzeile, WinAnsi-Sanitize (Pitfall 7),
 * Tabellen mit festen Spalten und zeilenhohem Wrap.
 */

describe('wrapText', () => {
  it('bricht einen langen deutschen Text an Wortgrenzen auf maxBreite, kein Wort wird zerrissen', async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const text =
      'Die Beklagte hat die vertragliche Nebenpflicht zur rechtzeitigen Lieferung sämtlicher ' +
      'Bauunterlagen schuldhaft verletzt und ist deshalb zum Schadensersatz verpflichtet.';
    const maxBreite = 200;

    const zeilen = wrapText(text, font, 11, maxBreite);

    expect(zeilen.length).toBeGreaterThan(1);
    for (const z of zeilen) {
      expect(font.widthOfTextAtSize(z, 11)).toBeLessThanOrEqual(maxBreite);
    }
    // Kein Wort zerrissen: jede Zeile ist eine Folge ganzer Worte des Originals.
    expect(zeilen.join(' ')).toBe(text);
  });
});

describe('ensureSpace / Seitenumbruch', () => {
  it('bricht bei unzureichendem Restplatz um; Kopfzeile (Titel) und Fußzeile („Seite n") auf jeder Seite', async () => {
    const pdf = await PDFDocument.create();
    const layout = await erstelleLayout(pdf, 'Übersichtstitel-MARKER');
    for (let i = 0; i < 120; i++) layout.zeile(`Fließtext-Zeile Nummer ${i + 1} mit etwas Inhalt.`);

    const seiten = await extrahiereSeiten(await pdf.save());
    expect(seiten.length).toBeGreaterThan(1);
    seiten.forEach((text, i) => {
      expect(text).toContain('Übersichtstitel-MARKER');
      expect(text).toContain(`Seite ${i + 1}`);
    });
  });
});

describe('winansiSanitize', () => {
  it('ersetzt Nicht-WinAnsi-Zeichen (Emoji, Pfeile, kyrillisch), drawText wirft nicht', async () => {
    const roh = 'Beweis 👍 Richtung → kyrillisch Д ж § € ä ö ü ß „Anführung“';
    const sauber = winansiSanitize(roh);

    expect(sauber).not.toContain('👍');
    expect(sauber).not.toContain('→');
    expect(sauber).not.toContain('Д');
    expect(sauber).toContain('?');
    // Deutsch inkl. Sonderzeichen bleibt (Helvetica/WinAnsi deckt es ab).
    expect(sauber).toContain('§ € ä ö ü ß „Anführung“');

    const pdf = await PDFDocument.create();
    const layout = await erstelleLayout(pdf, 't');
    expect(() => layout.zeile(sauber)).not.toThrow();
  });
});

describe('tabelle', () => {
  it('rendert feste Spalten mit zeilenhohem Wrap (lange Zelle umbricht, nichts überlappt)', async () => {
    const pdf = await PDFDocument.create();
    const layout = await erstelleLayout(pdf, 't');
    const langeZelle =
      'Ein sehr langer Zellentext, der in einer schmalen Spalte umbrechen muss, damit die Nachbarspalte lesbar bleibt';

    const yVorher = layout.y;
    layout.tabelle(
      ['Name', 'Fundstelle'],
      [[langeZelle, 'Seite 3']],
      [300, 195],
    );
    const verbraucht = yVorher - layout.y;

    // Zeilenhoher Wrap: die Zeile ist deutlich höher als eine einzelne Textzeile (16pt).
    expect(verbraucht).toBeGreaterThan(32);

    const seiten = await extrahiereSeiten(await pdf.save());
    expect(seiten).toHaveLength(1);
    expect(seiten[0]).toContain('Seite 3');
    // Umbruch statt Abschneiden: Anfang UND Ende der langen Zelle sind im extrahierten Text.
    expect(seiten[0]).toContain('Ein sehr langer Zellentext');
    expect(seiten[0]).toContain('lesbar bleibt');
  });
});
