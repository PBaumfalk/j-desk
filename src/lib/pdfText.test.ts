import { describe, expect, it, vi } from 'vitest';

// pdfjs-dist' Browser-Build braucht DOMMatrix & Co., die es unter Node/vitest nicht gibt
// (bekannte Stolperfalle: "Please use the `legacy` build in Node.js environments" -> ReferenceError).
// Der Legacy-Build funktioniert im Node-Kontext und liefert echte getTextContent()-Ergebnisse —
// nur im Test wird 'pdfjs-dist' darauf umgeleitet; der Produktionscode importiert unverändert
// wie PageRenderer.svelte (Browser-Build, echter Worker).
vi.mock('pdfjs-dist', () => vi.importActual('pdfjs-dist/legacy/build/pdf.mjs'));
// Der Legacy-Build braucht im Node-Kontext einen echten (Fake-)Worker-Pfad — ein leerer String
// überschreibt sonst den automatischen Node-Fallback und lässt "kein workerSrc angegeben" werfen.
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: 'pdfjs-dist/legacy/build/pdf.worker.mjs' }));

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  itemsImRect,
  textInRect,
  alleWoerterMitPosition,
  seitenWoerter,
  type TextItemLike,
  type ViewportLike,
} from './pdfText';

// Fixture: eine Seite (612x792), zwei echte Textobjekte an bekannten Positionen —
// „ProbeTextEins" bei PDF-Koordinate (100,700), „ZweiterBlockText" bei (100,400).
// Erzeugt mit handgeschriebenem, korrektem xref (siehe Kommentar unten) und einmalig
// gegen pdfjs verifiziert (numPages, transform-Werte der Items geprüft).
const fixturePath = fileURLToPath(new URL('./__fixtures__/textprobe.pdf', import.meta.url));

describe('itemsImRect (pdfjs-frei, reine Filter-/Sortierlogik)', () => {
  const viewport: ViewportLike = {
    // Vereinfachter Viewport für den Test: PDF-Space (y-up) -> Basisraum (y-down) bei einer
    // Seitenhöhe von 792 — deckt sich mit der echten Umrechnung bei scale = 1.
    convertToViewportPoint: (x, y) => [x, 792 - y],
  };

  it('behält nur Items, deren Box-Mittelpunkt im Rect liegt', () => {
    const items: TextItemLike[] = [
      { str: 'Oben', transform: [12, 0, 0, 12, 100, 700], width: 40, height: 12 },
      { str: 'Unten', transform: [12, 0, 0, 12, 100, 400], width: 40, height: 12 },
    ];
    expect(itemsImRect(items, viewport, { x: 90, y: 70, w: 100, h: 40 })).toBe('Oben');
    expect(itemsImRect(items, viewport, { x: 90, y: 370, w: 100, h: 40 })).toBe('Unten');
    expect(itemsImRect(items, viewport, { x: 900, y: 900, w: 10, h: 10 })).toBe('');
  });

  it('sortiert nach Zeilen (y, Toleranz 2px) dann x, joint Zeilen mit Leerzeichen/Zeilenumbruch', () => {
    const items: TextItemLike[] = [
      { str: 'B', transform: [12, 0, 0, 12, 150, 700], width: 10, height: 12 }, // rechts oben
      { str: 'A', transform: [12, 0, 0, 12, 100, 701], width: 10, height: 12 }, // links oben, 1px Y-Unterschied -> gleiche Zeile
      { str: 'C', transform: [12, 0, 0, 12, 100, 400], width: 10, height: 12 }, // eigene Zeile darunter
    ];
    expect(itemsImRect(items, viewport, { x: 0, y: 0, w: 400, h: 792 })).toBe('A B\nC');
  });

  it('ignoriert Items ohne str (z. B. TextMarkedContent)', () => {
    const items = [{ transform: [12, 0, 0, 12, 100, 700], width: 10, height: 12 }] as unknown as TextItemLike[];
    expect(itemsImRect(items, viewport, { x: 0, y: 0, w: 792, h: 792 })).toBe('');
  });
});

describe('textInRect (echtes Fixture-PDF über pdfjs)', () => {
  it('liefert nur den Text von Block 1, wenn das Rect um Block 1 liegt', async () => {
    const bytes = new Uint8Array(readFileSync(fixturePath));
    const text = await textInRect(bytes, 1, { x: 90, y: 70, w: 110, h: 40 });
    expect(text).toBe('ProbeTextEins');
  });

  it('liefert nur den Text von Block 2, wenn das Rect um Block 2 liegt', async () => {
    const bytes = new Uint8Array(readFileSync(fixturePath));
    const text = await textInRect(bytes, 1, { x: 90, y: 370, w: 120, h: 40 });
    expect(text).toBe('ZweiterBlockText');
  });

  it('liefert einen leeren String, wenn das Rect neben beiden Textblöcken liegt', async () => {
    const bytes = new Uint8Array(readFileSync(fixturePath));
    const text = await textInRect(bytes, 1, { x: 400, y: 70, w: 50, h: 40 });
    expect(text).toBe('');
  });

  it('liefert einen leeren String bei kaputten Bytes, statt zu werfen', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    await expect(textInRect(bytes, 1, { x: 0, y: 0, w: 100, h: 100 })).resolves.toBe('');
  });

  it('liefert einen leeren String bei nicht existierender Seite, statt zu werfen', async () => {
    const bytes = new Uint8Array(readFileSync(fixturePath));
    const text = await textInRect(bytes, 99, { x: 0, y: 0, w: 1000, h: 1000 });
    // Seite wird auf die letzte vorhandene geklemmt (wie PageRenderer) — liefert also
    // regulär den Text der einzigen Seite, wirft aber in keinem Fall.
    expect(text).toContain('ProbeTextEins');
  });
});

describe('alleWoerterMitPosition (pdfjs-frei, reine Filter-/Sortierlogik)', () => {
  const viewport: ViewportLike = {
    // Gleicher vereinfachter Viewport wie im itemsImRect-Testblock oben.
    convertToViewportPoint: (x, y) => [x, 792 - y],
  };

  it('liefert für jedes TextItem mit nichtleerem Text ein Wort mit Rechteck in Basiskoordinaten', () => {
    const items: TextItemLike[] = [{ str: 'Eins', transform: [12, 0, 0, 12, 100, 700], width: 40, height: 12 }];
    expect(alleWoerterMitPosition(items, viewport)).toEqual([{ text: 'Eins', rect: { x: 100, y: 80, w: 40, h: 12 } }]);
  });

  it('überspringt ein TextItem ohne str (z. B. TextMarkedContent)', () => {
    const items = [{ transform: [12, 0, 0, 12, 100, 700], width: 10, height: 12 }] as unknown as TextItemLike[];
    expect(alleWoerterMitPosition(items, viewport)).toEqual([]);
  });

  it('liefert die Wörter in Lesereihenfolge: nach Zeile, innerhalb der Zeile nach x', () => {
    const items: TextItemLike[] = [
      { str: 'B', transform: [12, 0, 0, 12, 150, 700], width: 10, height: 12 }, // rechts oben
      { str: 'A', transform: [12, 0, 0, 12, 100, 701], width: 10, height: 12 }, // links oben, 1px Y-Unterschied -> gleiche Zeile
      { str: 'C', transform: [12, 0, 0, 12, 100, 400], width: 10, height: 12 }, // eigene Zeile darunter
    ];
    expect(alleWoerterMitPosition(items, viewport).map((w) => w.text)).toEqual(['A', 'B', 'C']);
  });

  it('lässt ein Wort aus, dessen Rechteckmittelpunkt in einer echten Schwärzung derselben Seite liegt; die Nachbarwörter bleiben erhalten', () => {
    const items: TextItemLike[] = [
      { str: 'Sichtbar', transform: [12, 0, 0, 12, 100, 700], width: 40, height: 12 },
      { str: 'Geschwaerzt', transform: [12, 0, 0, 12, 200, 700], width: 40, height: 12 },
    ];
    const ueberdeckung = { x: 190, y: 70, w: 60, h: 30 };
    const woerter = alleWoerterMitPosition(items, viewport, [ueberdeckung]);
    expect(woerter.map((w) => w.text)).toEqual(['Sichtbar']);
  });

  it('lässt ein Wort unter einer Tippex-Fläche ebenfalls aus, weil auch sie den Text überdeckt', () => {
    // alleWoerterMitPosition unterscheidet nicht nach Markierungsart — die Aufrufseite (Plan 09-09)
    // filtert desktop.state.marks bereits auf echte Schwärzungen (redact/tippex, istEchteSchwaerzung)
    // BEVOR die Rechtecke hier ankommen; für diese Funktion sind es austauschbare Überdeckungen.
    const items: TextItemLike[] = [
      { str: 'Sichtbar', transform: [12, 0, 0, 12, 100, 700], width: 40, height: 12 },
      { str: 'Tippex', transform: [12, 0, 0, 12, 200, 700], width: 40, height: 12 },
    ];
    const tippexFlaeche = { x: 190, y: 70, w: 60, h: 30 };
    expect(alleWoerterMitPosition(items, viewport, [tippexFlaeche]).map((w) => w.text)).toEqual(['Sichtbar']);
  });

  it('lässt ohne übergebene Markierungsliste nichts aus', () => {
    const items: TextItemLike[] = [
      { str: 'Eins', transform: [12, 0, 0, 12, 100, 700], width: 40, height: 12 },
      { str: 'Zwei', transform: [12, 0, 0, 12, 200, 700], width: 40, height: 12 },
    ];
    expect(alleWoerterMitPosition(items, viewport).map((w) => w.text)).toEqual(['Eins', 'Zwei']);
  });
});

describe('seitenWoerter (echtes Fixture-PDF über pdfjs)', () => {
  it('liefert alle Wörter der Fixture-Seite mit Rechteck und Basisgröße', async () => {
    const bytes = new Uint8Array(readFileSync(fixturePath));
    const { woerter, basis } = await seitenWoerter(bytes, 1);
    expect(woerter.map((w) => w.text)).toContain('ProbeTextEins');
    expect(woerter.map((w) => w.text)).toContain('ZweiterBlockText');
    for (const w of woerter) {
      expect(Number.isFinite(w.rect.x)).toBe(true);
      expect(Number.isFinite(w.rect.y)).toBe(true);
      expect(w.rect.w).toBeGreaterThan(0);
      expect(w.rect.h).toBeGreaterThan(0);
    }
    expect(basis).not.toBeNull();
    expect(basis).toEqual({ w: 612, h: 792 });
  });

  it('lässt über eine Überdeckung genau das darunterliegende Wort aus; Nachbarwörter bleiben', async () => {
    const bytes = new Uint8Array(readFileSync(fixturePath));
    // "ProbeTextEins" liegt bei PDF-Koordinate (100,700) — dasselbe Rect, das der erste
    // textInRect-Test oben für Block 1 verwendet, deckt hier gezielt nur dieses Wort ab.
    const ueberdeckungUeberBlock1 = { x: 90, y: 70, w: 110, h: 40 };
    const { woerter, hatteRohtext } = await seitenWoerter(bytes, 1, [ueberdeckungUeberBlock1]);
    expect(woerter.map((w) => w.text)).not.toContain('ProbeTextEins');
    expect(woerter.map((w) => w.text)).toContain('ZweiterBlockText');
    // Block 2 ist noch sichtbar — die Seite hatte also unabhängig davon eingebetteten Text.
    expect(hatteRohtext).toBe(true);
  });

  // CR-01 (Redaction-Leck): eine Seite, deren gesamter eingebetteter Text unter echten
  // Schwärzungen liegt, muss `woerter: []` UND `hatteRohtext: true` liefern — nur so kann die
  // Aufrufseite (VergleichsViewer.svelte) "vollständig geschwärzt" von "kein Text auf der Seite"
  // unterscheiden und darf im ersten Fall NICHT auf den unfilterten Server-Text zurückfallen.
  it('liefert bei vollständig geschwärzter Seite eine leere Wortliste, aber hatteRohtext: true (CR-01)', async () => {
    const bytes = new Uint8Array(readFileSync(fixturePath));
    // Beide Textblöcke der Fixture-Seite liegen unter je einer Überdeckung.
    const ueberdeckungUeberBeideBloecke = [
      { x: 90, y: 70, w: 110, h: 40 },
      { x: 90, y: 370, w: 120, h: 40 },
    ];
    const { woerter, hatteRohtext } = await seitenWoerter(bytes, 1, ueberdeckungUeberBeideBloecke);
    expect(woerter).toEqual([]);
    expect(hatteRohtext).toBe(true);
  });

  it('liefert bei kaputten Bytes eine leere Wortliste, basis: null und hatteRohtext: false, statt zu werfen', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    await expect(seitenWoerter(bytes, 1)).resolves.toEqual({ woerter: [], basis: null, hatteRohtext: false });
  });

  it('klemmt eine Seitennummer außerhalb des gültigen Bereichs auf den gültigen Bereich, wie beim Rendern', async () => {
    const bytes = new Uint8Array(readFileSync(fixturePath));
    const { woerter } = await seitenWoerter(bytes, 99);
    expect(woerter.map((w) => w.text)).toContain('ProbeTextEins');
  });
});
