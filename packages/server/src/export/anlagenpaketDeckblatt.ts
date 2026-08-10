import { PDFDocument, StandardFonts, degrees, type PDFPage } from 'pdf-lib';
import { SEITE_H, erstelleLayout, winansiSanitize } from './layout';

/**
 * Deckblatt, Inhaltsverzeichnis und durchgehende Seitenfüße für das Anlagenpaket (KONV-02,
 * 10-02): Vorspann und Seitenfüße benutzen ausschließlich den Bestandshelfer aus `./layout`
 * (Zeichensatzbereinigung, Wortumbruch, Seitenumbruch) — kein eigener Zeichensatz-Code hier.
 * Verzeichnis, Seitenfüße und Lesezeichen (outline.ts) leiten sich alle aus derselben einen
 * Liste von `VerzeichnisEintrag` ab, die `anlagenpaket.ts` aus der `seiten`-Landkarte baut —
 * zwei getrennte Herleitungen der Reihenfolge wären zwei Wahrheiten.
 */

/** Eine Zeile im Inhaltsverzeichnis. `startSeite` ist die 1-basierte Anlagenseite, auf der die
 *  Unterlage beginnt (Vorspann nicht mitgezählt — Festlegung F-06). */
export interface VerzeichnisEintrag {
  nummer: number;
  bezeichnung: string;
  startSeite: number;
  seiten: number;
}

/**
 * Erzeugt Deckblatt + Inhaltsverzeichnis als eigenes `PDFDocument`. Ein einziger Layout-Cursor
 * über den ganzen Vorspann, damit dessen eigene Fußzeile (aus `erstelleLayout`) durchgehend
 * zählt. Der Aufrufer liest die Seitenzahl über `getPageCount()` und kopiert die Seiten an den
 * Anfang des zusammengefügten Pakets.
 */
export async function erzeugeVorspann(
  deckblattTitel: string,
  eintraege: VerzeichnisEintrag[],
  inhaltSeitenGesamt: number,
  ausgelassen: number
): Promise<PDFDocument> {
  const vorspann = await PDFDocument.create();
  const layout = await erstelleLayout(vorspann, deckblattTitel);

  layout.zeile(deckblattTitel, { groesse: 18, fett: true });
  layout.absatz(`Erstellt am ${new Date().toLocaleDateString('de-DE')}`);
  layout.absatz(`${eintraege.length} Anlage(n), ${inhaltSeitenGesamt} Seite(n)`);
  layout.absatz(
    'Die Seitenzahlen beziehen sich auf die Anlagenseiten; das Deckblatt und dieses Verzeichnis sind nicht mitgezählt.'
  );
  if (ausgelassen > 0) {
    layout.absatz(
      `${ausgelassen} ausgewählte Unterlage(n) waren beim Erzeugen nicht verfügbar und sind in diesem Paket nicht enthalten.`
    );
  }

  // Erzwungener Seitenumbruch vor dem Verzeichnis: die Bedingung `cursorY - SEITE_H < RAND`
  // trifft immer zu (SEITE_H ist größer als jede verbleibende Cursor-Höhe), dadurch beginnt
  // unbedingt eine neue Seite. Ohne diesen Kommentar sieht der Aufruf wie ein Versehen aus.
  layout.ensureSpace(SEITE_H);

  layout.zeile('Inhaltsverzeichnis', { groesse: 15, fett: true });
  layout.zeile('');
  layout.tabelle(
    ['K-Nr.', 'Bezeichnung', 'Seite'],
    eintraege.map((e) => [`K${e.nummer}`, e.bezeichnung, String(e.startSeite)]),
    [60, 400, 60]
  );

  return vorspann;
}

/** Ankerpunkte für den Fußtext einer Anlagenseite. */
export interface FussPosition {
  links: { x: number; y: number };
  rechts: { x: number; y: number };
  drehung: number;
}

/**
 * Rechnet die Ankerpunkte für den linken/rechten Fußtext von der *dargestellten* Unterkante
 * der Seite in den (unrotierten) Nutzerraum um, in dem `drawText` zeichnet. Quellseiten aus
 * Scans tragen häufig einen Drehwert; ohne diese Umrechnung stünde die Seitenzahl auf
 * gedrehten Seiten quer. Ein anderer als die vier bekannten Drehwerte (0/90/180/270) wird auf
 * 0 zurückgeführt.
 */
export function fussPosition(seite: PDFPage, textBreite: number, seitenRand: number): FussPosition {
  const { width: w, height: h } = seite.getSize();
  let drehung = seite.getRotation().angle % 360;
  if (drehung < 0) drehung += 360;
  if (drehung !== 0 && drehung !== 90 && drehung !== 180 && drehung !== 270) drehung = 0;

  let darstellungsBreite: number;
  let umrechnen: (x: number, y: number) => { x: number; y: number };
  switch (drehung) {
    case 90:
      darstellungsBreite = h;
      umrechnen = (x, y) => ({ x: w - y, y: x });
      break;
    case 180:
      darstellungsBreite = w;
      umrechnen = (x, y) => ({ x: w - x, y: h - y });
      break;
    case 270:
      darstellungsBreite = h;
      umrechnen = (x, y) => ({ x: y, y: h - x });
      break;
    default:
      darstellungsBreite = w;
      umrechnen = (x, y) => ({ x, y });
  }

  return {
    links: umrechnen(seitenRand, seitenRand),
    rechts: umrechnen(darstellungsBreite - seitenRand - textBreite, seitenRand),
    drehung,
  };
}

const SEITENFUSS_RAND = 24;

/**
 * Zeichnet auf jeder Anlagenseite (nach dem Vorspann) rechts die durchgehende Seitenzahl
 * (`Seite n von N`) und links die Anlagennummer (`Kx`). Fußtexte sind Seiteninhalt und kein
 * Anmerkungsobjekt — sie überleben deshalb jede Bereinigung, anders als Lesezeichen
 * (outline.ts), die strikt NACH jedem Bereinigungslauf entstehen müssen.
 */
export async function zeichneInhaltsfuesse(
  paket: PDFDocument,
  vorspannSeiten: number,
  kNummerJeSeite: number[]
): Promise<void> {
  const font = await paket.embedFont(StandardFonts.Helvetica);
  const groesse = 8;
  const anlagenseiten = paket.getPages().slice(vorspannSeiten);

  anlagenseiten.forEach((seite, i) => {
    const rechtsText = winansiSanitize(`Seite ${i + 1} von ${kNummerJeSeite.length}`);
    const linksText = winansiSanitize(`K${kNummerJeSeite[i]}`);

    const rechtsPos = fussPosition(seite, font.widthOfTextAtSize(rechtsText, groesse), SEITENFUSS_RAND);
    seite.drawText(rechtsText, { x: rechtsPos.rechts.x, y: rechtsPos.rechts.y, size: groesse, font, rotate: degrees(rechtsPos.drehung) });

    const linksPos = fussPosition(seite, font.widthOfTextAtSize(linksText, groesse), SEITENFUSS_RAND);
    seite.drawText(linksText, { x: linksPos.links.x, y: linksPos.links.y, size: groesse, font, rotate: degrees(linksPos.drehung) });
  });
}
