import { describe, expect, it } from 'vitest';
import { PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, StandardFonts } from 'pdf-lib';
import { fuegeLesezeichenEin, LESEZEICHEN_TITEL_MAX, type Lesezeichen } from './outline';

/**
 * outline.ts (KONV-02, 10-02): Der Lesezeichenbaum wird von Hand aus den pdf-lib-
 * Grundbausteinen gebaut (kein High-Level-API vorhanden — Rohtextprüfung auf Kettenlänge,
 * Wurzelidentität und Titelkodierung nach dem Muster von scrub.test.ts.
 */

async function dreiseitigesPdf(): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 3; i++) {
    const seite = doc.addPage([595, 842]);
    seite.drawText(`Seite ${i}`, { x: 100, y: 700, size: 12, font });
  }
  return doc;
}

/** Läuft die Next-Kette ab der ersten Eintrags-Referenz ab; gibt die Dicts in Reihenfolge zurück. */
function lauf(context: PDFDocument['context'], erste: unknown): PDFDict[] {
  const kette: PDFDict[] = [];
  let aktuell = erste;
  const gesehen = new Set<string>();
  while (aktuell !== undefined) {
    const dict = context.lookup(aktuell as never, PDFDict);
    kette.push(dict);
    const tag = String(aktuell);
    if (gesehen.has(tag)) break; // Zyklenschutz für einen fehlerhaften Baum
    gesehen.add(tag);
    aktuell = dict.get(PDFName.of('Next'));
  }
  return kette;
}

describe('fuegeLesezeichenEin', () => {
  it('setzt drei Lesezeichen; nach Speichern und Wiedereinlesen ist Count 3 und die Next-Kette hat genau drei Einträge in Reihenfolge', async () => {
    const doc = await dreiseitigesPdf();
    const eintraege: Lesezeichen[] = [
      { titel: 'Anlagenverzeichnis', seite: doc.getPage(0) },
      { titel: 'K1 — Erste', seite: doc.getPage(0) },
      { titel: 'K2 — Zweite', seite: doc.getPage(1) },
    ];
    fuegeLesezeichenEin(doc, eintraege);
    const bytes = await doc.save();

    const wieder = await PDFDocument.load(bytes);
    const outlinesRef = wieder.catalog.get(PDFName.of('Outlines'));
    expect(outlinesRef).toBeDefined();
    const wurzel = wieder.context.lookup(outlinesRef as never, PDFDict);
    expect(wurzel.lookup(PDFName.of('Count'))).toBeInstanceOf(PDFNumber);
    expect((wurzel.lookup(PDFName.of('Count')) as PDFNumber).asNumber()).toBe(3);

    const kette = lauf(wieder.context, wurzel.get(PDFName.of('First')));
    expect(kette.length).toBe(3);

    // First/Last lösen auf den ersten bzw. letzten Eintrag der Kette auf.
    const letzterRef = wurzel.get(PDFName.of('Last')) as { toString: () => string };
    const letztesInDerKette = wieder.context.getObjectRef(kette[kette.length - 1]);
    expect(letzterRef.toString()).toBe(letztesInDerKette?.toString());

    const titel = kette.map((d) => (d.lookup(PDFName.of('Title')) as PDFHexString).decodeText());
    expect(titel).toEqual(['Anlagenverzeichnis', 'K1 — Erste', 'K2 — Zweite']);
  });

  it('jedes Dest verweist auf die Referenz der erwarteten Seite', async () => {
    const doc = await dreiseitigesPdf();
    const eintraege: Lesezeichen[] = [
      { titel: 'Erste', seite: doc.getPage(0) },
      { titel: 'Zweite', seite: doc.getPage(1) },
      { titel: 'Dritte', seite: doc.getPage(2) },
    ];
    fuegeLesezeichenEin(doc, eintraege);
    const bytes = await doc.save();

    const wieder = await PDFDocument.load(bytes);
    const wurzel = wieder.context.lookup(wieder.catalog.get(PDFName.of('Outlines')) as never, PDFDict);
    const kette = lauf(wieder.context, wurzel.get(PDFName.of('First')));

    kette.forEach((dict, i) => {
      const dest = wieder.context.lookup(dict.get(PDFName.of('Dest')) as never);
      const zielRef = (dest as unknown as { get: (i: number) => unknown }).get(0);
      expect((zielRef as { toString: () => string }).toString()).toBe(wieder.getPage(i).ref.toString());
    });
  });

  it('ein Titel mit ä, ö, ü und ß wird nach dem Wiedereinlesen unverfälscht zurückgelesen', async () => {
    const doc = await dreiseitigesPdf();
    const titelMitUmlauten = 'Übergabeprotokoll äöüß';
    fuegeLesezeichenEin(doc, [{ titel: titelMitUmlauten, seite: doc.getPage(0) }]);
    const bytes = await doc.save();

    const wieder = await PDFDocument.load(bytes);
    const wurzel = wieder.context.lookup(wieder.catalog.get(PDFName.of('Outlines')) as never, PDFDict);
    const eintrag = wieder.context.lookup(wurzel.get(PDFName.of('First')) as never, PDFDict);
    const hex = eintrag.lookup(PDFName.of('Title')) as PDFHexString;
    expect(hex.decodeText()).toBe(titelMitUmlauten);
  });

  it('ein Titel über der Höchstlänge wird gekürzt gespeichert', async () => {
    const doc = await dreiseitigesPdf();
    const langerTitel = 'X'.repeat(LESEZEICHEN_TITEL_MAX + 50);
    fuegeLesezeichenEin(doc, [{ titel: langerTitel, seite: doc.getPage(0) }]);
    const bytes = await doc.save();

    const wieder = await PDFDocument.load(bytes);
    const wurzel = wieder.context.lookup(wieder.catalog.get(PDFName.of('Outlines')) as never, PDFDict);
    const eintrag = wieder.context.lookup(wurzel.get(PDFName.of('First')) as never, PDFDict);
    const hex = eintrag.lookup(PDFName.of('Title')) as PDFHexString;
    expect(hex.decodeText().length).toBe(LESEZEICHEN_TITEL_MAX);
    expect(hex.decodeText()).toBe(langerTitel.slice(0, LESEZEICHEN_TITEL_MAX));
  });

  it('eine leere Eintragsliste lässt den Katalog unverändert (kein Outlines-Schlüssel)', async () => {
    const doc = await dreiseitigesPdf();
    fuegeLesezeichenEin(doc, []);
    expect(doc.catalog.has(PDFName.of('Outlines'))).toBe(false);
    const bytes = await doc.save();
    const wieder = await PDFDocument.load(bytes);
    expect(wieder.catalog.has(PDFName.of('Outlines'))).toBe(false);
  });

  it('alle Elterneinträge zeigen auf dieselbe Wurzelreferenz', async () => {
    const doc = await dreiseitigesPdf();
    const eintraege: Lesezeichen[] = [
      { titel: 'A', seite: doc.getPage(0) },
      { titel: 'B', seite: doc.getPage(1) },
      { titel: 'C', seite: doc.getPage(2) },
    ];
    fuegeLesezeichenEin(doc, eintraege);
    const bytes = await doc.save();

    const wieder = await PDFDocument.load(bytes);
    const outlinesRef = wieder.catalog.get(PDFName.of('Outlines'));
    const wurzel = wieder.context.lookup(outlinesRef as never, PDFDict);
    const kette = lauf(wieder.context, wurzel.get(PDFName.of('First')));
    const parentRefs = kette.map((d) => (d.get(PDFName.of('Parent')) as { toString: () => string }).toString());
    expect(new Set(parentRefs).size).toBe(1);
    expect(parentRefs[0]).toBe((outlinesRef as { toString: () => string }).toString());
  });
});
