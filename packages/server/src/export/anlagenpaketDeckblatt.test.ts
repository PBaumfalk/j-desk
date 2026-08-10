import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName } from 'pdf-lib';
import { erzeugeRotiertesPdf } from './pdfTestFixtures';
import { extrahiereSeiten, extrahiereText } from './verify';
import { erzeugeVorspann, fussPosition, zeichneInhaltsfuesse, type VerzeichnisEintrag } from './anlagenpaketDeckblatt';

/**
 * anlagenpaketDeckblatt.ts (KONV-02, 10-02): Vorspann (Deckblatt + Inhaltsverzeichnis) und
 * durchgehende Seitenfüße. Die Tests belegen Deckblattinhalt, mehrseitiges Verzeichnis,
 * durchgehende Seitenzählung, die vier Rotationsfälle von fussPosition und Robustheit bei
 * Sonderzeichen.
 */

describe('erzeugeVorspann', () => {
  it('Deckblatt: Titel und Erstellungsdatum stehen im Vorspann; Auslassungshinweis nur bei ausgelassen > 0', async () => {
    const heute = new Date().toLocaleDateString('de-DE');
    const eintraege: VerzeichnisEintrag[] = [{ nummer: 1, bezeichnung: 'Anlage A', startSeite: 1, seiten: 1 }];

    const mitAuslassung = await erzeugeVorspann('Anlagen zur Klageschrift', eintraege, 1, 2);
    const textMit = await extrahiereText(await mitAuslassung.save());
    expect(textMit).toContain('Anlagen zur Klageschrift');
    expect(textMit).toContain(heute);
    expect(textMit).toContain('2 ausgewählte Unterlage(n)');

    const ohneAuslassung = await erzeugeVorspann('Anlagen zur Klageschrift', eintraege, 1, 0);
    const textOhne = await extrahiereText(await ohneAuslassung.save());
    expect(textOhne).not.toContain('ausgewählte Unterlage(n)');
  });

  it('Verzeichnis: eine Zeile je Eintrag mit K-Nummer, Bezeichnung und Startseite; läuft bei vielen Einträgen über mehrere Seiten', async () => {
    const eintraege: VerzeichnisEintrag[] = Array.from({ length: 60 }, (_, i) => ({
      nummer: i + 1,
      bezeichnung: `Unterlage ${i + 1}`,
      startSeite: i * 3 + 1,
      seiten: 3,
    }));
    const vorspann = await erzeugeVorspann('Großes Paket', eintraege, 180, 0);
    expect(vorspann.getPageCount()).toBeGreaterThan(2); // Deckblatt + mehrseitiges Verzeichnis
    const text = await extrahiereText(await vorspann.save());
    for (const e of eintraege) {
      expect(text).toContain(`K${e.nummer}`);
      expect(text).toContain(`Unterlage ${e.nummer}`);
      expect(text).toContain(String(e.startSeite));
    }
  });

  it('Sonderzeichen: ein Titel mit einem Zeichen außerhalb des darstellbaren Zeichensatzes bricht die Erzeugung nicht ab', async () => {
    const eintraege: VerzeichnisEintrag[] = [{ nummer: 1, bezeichnung: 'Anlage', startSeite: 1, seiten: 1 }];
    const titel = 'Anlagen 中文字符 zur Akte';
    await expect(erzeugeVorspann(titel, eintraege, 1, 0)).resolves.toBeInstanceOf(PDFDocument);
  });

  it('eine Anlage: ein Paket aus genau einer Unterlage hat Deckblatt und eine Verzeichniszeile', async () => {
    const eintraege: VerzeichnisEintrag[] = [{ nummer: 1, bezeichnung: 'Einzige Anlage', startSeite: 1, seiten: 1 }];
    const vorspann = await erzeugeVorspann('Ein Paket', eintraege, 1, 0);
    const text = await extrahiereText(await vorspann.save());
    expect(text).toContain('K1');
    expect(text).toContain('Einzige Anlage');
  });
});

describe('fussPosition', () => {
  async function seiteMitRotation(rotation: number, gueltig: boolean) {
    const doc = await PDFDocument.create();
    const seite = doc.addPage([595, 842]);
    if (gueltig) {
      const { degrees } = await import('pdf-lib');
      seite.setRotation(degrees(rotation));
    } else {
      // pdf-lib erzwingt in setRotation ein Vielfaches von 90 — ein unbekannter Drehwert wird
      // hier direkt in den Katalog-Knoten geschrieben, um den Fallback-Pfad zu erreichen.
      seite.node.set(PDFName.of('Rotate'), doc.context.obj(rotation));
    }
    return seite;
  }

  it('Drehung 0: linker/rechter Anker an der Unterkante, keine Textdrehung', async () => {
    const seite = await seiteMitRotation(0, true);
    const pos = fussPosition(seite, 100, 24);
    expect(pos).toEqual({ links: { x: 24, y: 24 }, rechts: { x: 471, y: 24 }, drehung: 0 });
  });

  it('Drehung 90: linker Anker { x: 571, y: 24 }', async () => {
    const seite = await seiteMitRotation(90, true);
    const pos = fussPosition(seite, 100, 24);
    expect(pos).toEqual({ links: { x: 571, y: 24 }, rechts: { x: 571, y: 718 }, drehung: 90 });
  });

  it('Drehung 180', async () => {
    const seite = await seiteMitRotation(180, true);
    const pos = fussPosition(seite, 100, 24);
    expect(pos).toEqual({ links: { x: 571, y: 818 }, rechts: { x: 124, y: 818 }, drehung: 180 });
  });

  it('Drehung 270', async () => {
    const seite = await seiteMitRotation(270, true);
    const pos = fussPosition(seite, 100, 24);
    expect(pos).toEqual({ links: { x: 24, y: 818 }, rechts: { x: 24, y: 124 }, drehung: 270 });
  });

  it('unbekannter Drehwert fällt auf 0 zurück', async () => {
    const seite = await seiteMitRotation(45, false);
    const pos = fussPosition(seite, 100, 24);
    expect(pos).toEqual({ links: { x: 24, y: 24 }, rechts: { x: 471, y: 24 }, drehung: 0 });
  });
});

describe('zeichneInhaltsfuesse', () => {
  it('Seitenzahl: durchgehende Zählung über Dokumentgrenzen hinweg, keine Wiederholung bei 1', async () => {
    const paket = await PDFDocument.create();
    for (let i = 0; i < 5; i++) paket.addPage([595, 842]);
    await zeichneInhaltsfuesse(paket, 0, [1, 1, 2, 2, 2]);
    const seiten = await extrahiereSeiten(await paket.save());
    expect(seiten[0]).toContain('Seite 1 von 5');
    expect(seiten[0]).toContain('K1');
    expect(seiten[2]).toContain('Seite 3 von 5');
    expect(seiten[2]).toContain('K2');
    expect(seiten[2]).not.toContain('Seite 1 von 5');
    expect(seiten[4]).toContain('Seite 5 von 5');
  });

  it('gedreht: eine über erzeugeRotiertesPdf erzeugte Seite erhält ihren Fußtext', async () => {
    const fixture = await erzeugeRotiertesPdf();
    const paket = await PDFDocument.load(fixture.bytes);
    await zeichneInhaltsfuesse(paket, 0, [1]);
    const seiten = await extrahiereSeiten(await paket.save());
    expect(seiten[0]).toContain('Seite 1 von 1');
  });
});
