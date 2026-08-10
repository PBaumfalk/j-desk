import { describe, expect, it } from 'vitest';
import type { Doc } from '@j-desk/core';
import { openDb, type Db } from '../db';
import {
  bestimmeSeitenBefunde,
  findeDubletten,
  findeLeerseiten,
  findeUnbeurteilbare,
  seitenHash,
  textAusIndex,
  type SeitenBefund,
} from './seitentexte';

/**
 * Textquellenregel und Dubletten-/Leerseitenerkennung (KONV-03, 10-04): das Erkennungsergebnis
 * gescannter Seiten steht ausschließlich in `file_pages` (nie in den PDF-Bytes), und der dort
 * hinterlegte Text ist der UNGESCHWÄRZTE Original — für eine Seite mit Schwärzung ist deshalb
 * ausschließlich die Extraktion aus dem bereits geschwärzten Ergebnis maßgeblich. Die dritte
 * Kategorie `unbeurteilbar` darf nie in "leer" oder "nicht leer" kollabieren.
 */

function neueDb(): Db {
  return openDb(':memory:');
}

function legeIndexZeileAn(
  db: Db,
  fileId: string,
  page: number,
  spalten: { pdfText?: string | null; ocrText?: string | null },
): void {
  db.prepare(
    'INSERT INTO file_pages (file_id, page, pdf_text, ocr_text, ocr_confidence) VALUES (?, ?, ?, ?, NULL)',
  ).run(fileId, page, spalten.pdfText ?? null, spalten.ocrText ?? null);
}

function doc(overrides: Partial<Doc> & { id: string; fileId: string }): Doc {
  return {
    name: `${overrides.id}.pdf`,
    position: { x: 0, y: 0 },
    rotation: 0,
    zIndex: 1,
    ...overrides,
  };
}

describe('textAusIndex', () => {
  it('ohne Zeile ergibt null', () => {
    const db = neueDb();
    expect(textAusIndex(db, 'f-1', 1)).toBeNull();
  });

  it('mit Zeile und gesetztem pdf_text liefert dessen Wert', () => {
    const db = neueDb();
    legeIndexZeileAn(db, 'f-1', 1, { pdfText: 'Eingebetteter Text' });
    expect(textAusIndex(db, 'f-1', 1)).toBe('Eingebetteter Text');
  });

  it('mit Zeile ohne pdf_text, aber mit ocr_text liefert dessen Wert', () => {
    const db = neueDb();
    legeIndexZeileAn(db, 'f-1', 1, { ocrText: 'Erkannter Text' });
    expect(textAusIndex(db, 'f-1', 1)).toBe('Erkannter Text');
  });

  it('mit Zeile und beiden Spalten leer liefert die leere Zeichenkette', () => {
    const db = neueDb();
    legeIndexZeileAn(db, 'f-1', 1, {});
    expect(textAusIndex(db, 'f-1', 1)).toBe('');
  });
});

describe('seitenHash', () => {
  it('leerer und nur-Weißraum-Text ergeben beide die leere Zeichenkette', () => {
    expect(seitenHash('')).toBe('');
    expect(seitenHash('   ')).toBe('');
  });

  it('zwei Texte, die sich nur in Zeilenumbrüchen und Mehrfachleerzeichen unterscheiden, gelten als gleich', () => {
    const a = seitenHash('Erster  Satz.\nZweiter Satz.');
    const b = seitenHash('Erster Satz. Zweiter Satz.');
    expect(a).toBe(b);
    expect(a).not.toBe('');
  });
});

describe('bestimmeSeitenBefunde — Rangfolge der Textquellen (F-13)', () => {
  it('OCR nicht leer: leeres Extraktionsergebnis mit gesetztem Erkennungstext in der Indexzeile ist weder leer noch unbeurteilbar', () => {
    const db = neueDb();
    legeIndexZeileAn(db, 'f-ocr', 1, { ocrText: 'Erkannter Scan-Text' });
    const d = doc({ id: 'd-ocr', fileId: 'f-ocr', kind: 'pdf' });

    const befunde = bestimmeSeitenBefunde(db, d, [1], [''], new Set());
    expect(befunde[0].autoritaet).toBe('index');
    expect(befunde[0].text).toBe('Erkannter Scan-Text');
    expect(findeLeerseiten(befunde)).toEqual([]);
    expect(findeUnbeurteilbare(befunde)).toEqual([]);
  });

  it('Schwärzung: benutzt das Extraktionsergebnis, auch wenn eine Indexzeile mit anderem Text existiert', () => {
    const db = neueDb();
    legeIndexZeileAn(db, 'f-schw', 1, { pdfText: 'UNGESCHWÄRZTER ORIGINALTEXT' });
    const d = doc({ id: 'd-schw', fileId: 'f-schw', kind: 'pdf' });

    const befunde = bestimmeSeitenBefunde(db, d, [1], ['Geschwärzter Rest'], new Set([1]));
    expect(befunde[0].autoritaet).toBe('extraktion');
    expect(befunde[0].text).toBe('Geschwärzter Rest');
    expect(befunde[0].text).not.toContain('ORIGINALTEXT');
  });

  it('Schwärzung mit leerem Extraktionsergebnis ist unbeurteilbar, nicht leer', () => {
    const db = neueDb();
    legeIndexZeileAn(db, 'f-schw2', 1, { pdfText: 'UNGESCHWÄRZTER ORIGINALTEXT' });
    const d = doc({ id: 'd-schw2', fileId: 'f-schw2', kind: 'pdf' });

    const befunde = bestimmeSeitenBefunde(db, d, [1], [''], new Set([1]));
    expect(befunde[0].autoritaet).toBe('unbeurteilbar');
    expect(findeLeerseiten(befunde)).toEqual([]);
    expect(findeUnbeurteilbare(befunde)).toEqual([{ docId: 'd-schw2', lokaleSeite: 1 }]);
  });

  it('Bild: eine Seite eines Dokuments der Dateiart Bild ist immer unbeurteilbar', () => {
    const db = neueDb();
    legeIndexZeileAn(db, 'f-bild', 1, { pdfText: 'sollte nie gelesen werden' });
    const d = doc({ id: 'd-bild', fileId: 'f-bild', kind: 'image' });

    const befunde = bestimmeSeitenBefunde(db, d, [1], ['auch egal'], new Set());
    expect(befunde[0].autoritaet).toBe('unbeurteilbar');
    expect(befunde[0].text).toBeNull();
    expect(befunde[0].hash).toBeNull();
  });

  it('Umwandlung: eine Seite ohne Indexzeile mit leerem Extraktionsergebnis gilt als leer, nicht als unbeurteilbar', () => {
    const db = neueDb();
    const d = doc({ id: 'd-conv', fileId: 'f-conv', kind: 'convertible' });

    const befunde = bestimmeSeitenBefunde(db, d, [1], [''], new Set());
    expect(befunde[0].autoritaet).toBe('extraktion');
    expect(findeLeerseiten(befunde)).toEqual([{ docId: 'd-conv', lokaleSeite: 1 }]);
    expect(findeUnbeurteilbare(befunde)).toEqual([]);
  });

  it('PDF ohne Index: eine Seite ohne Indexzeile und mit leerem Extraktionsergebnis ist unbeurteilbar', () => {
    const db = neueDb();
    const d = doc({ id: 'd-noindex', fileId: 'f-noindex', kind: 'pdf' });

    const befunde = bestimmeSeitenBefunde(db, d, [1], [''], new Set());
    expect(befunde[0].autoritaet).toBe('unbeurteilbar');
    expect(findeLeerseiten(befunde)).toEqual([]);
    expect(findeUnbeurteilbare(befunde)).toEqual([{ docId: 'd-noindex', lokaleSeite: 1 }]);
  });
});

describe('findeDubletten', () => {
  it('zwei Seiten mit gleichem Text nach Weißraumnormalisierung ergeben genau einen Dubletteneintrag, der auf die erste Fundstelle verweist', () => {
    const befunde: SeitenBefund[] = [
      { docId: 'd-1', lokaleSeite: 1, text: 'Gleicher Text', autoritaet: 'index', hash: seitenHash('Gleicher Text') },
      { docId: 'd-2', lokaleSeite: 1, text: 'Gleicher  Text', autoritaet: 'index', hash: seitenHash('Gleicher  Text') },
    ];
    const dubletten = findeDubletten(befunde);
    expect(dubletten).toEqual([{ docId: 'd-2', lokaleSeite: 1, gleichWieDocId: 'd-1', gleichWieLokaleSeite: 1 }]);
  });

  it('drei gleiche Seiten ergeben zwei Einträge', () => {
    const hash = seitenHash('Dreifach gleich');
    const befunde: SeitenBefund[] = [
      { docId: 'd-1', lokaleSeite: 1, text: 'Dreifach gleich', autoritaet: 'index', hash },
      { docId: 'd-2', lokaleSeite: 1, text: 'Dreifach gleich', autoritaet: 'index', hash },
      { docId: 'd-3', lokaleSeite: 1, text: 'Dreifach gleich', autoritaet: 'index', hash },
    ];
    expect(findeDubletten(befunde).length).toBe(2);
  });

  it('leere sind keine Dubletten: zwei leere Seiten ergeben keinen Dubletteneintrag', () => {
    const befunde: SeitenBefund[] = [
      { docId: 'd-1', lokaleSeite: 1, text: '', autoritaet: 'index', hash: null },
      { docId: 'd-2', lokaleSeite: 1, text: '', autoritaet: 'index', hash: null },
    ];
    expect(findeDubletten(befunde)).toEqual([]);
  });

  it('gruppiert keine Befunde mit hash === null', () => {
    const befunde: SeitenBefund[] = [
      { docId: 'd-1', lokaleSeite: 1, text: null, autoritaet: 'unbeurteilbar', hash: null },
      { docId: 'd-2', lokaleSeite: 1, text: null, autoritaet: 'unbeurteilbar', hash: null },
      { docId: 'd-3', lokaleSeite: 1, text: null, autoritaet: 'unbeurteilbar', hash: null },
    ];
    expect(findeDubletten(befunde)).toEqual([]);
  });
});

describe('findeLeerseiten / findeUnbeurteilbare', () => {
  it('eine Auswahl ohne Dubletten und ohne Leerseiten liefert leere Listen und keinen Fehler', () => {
    const befunde: SeitenBefund[] = [
      { docId: 'd-1', lokaleSeite: 1, text: 'Text A', autoritaet: 'index', hash: seitenHash('Text A') },
      { docId: 'd-2', lokaleSeite: 1, text: 'Text B', autoritaet: 'extraktion', hash: seitenHash('Text B') },
    ];
    expect(findeDubletten(befunde)).toEqual([]);
    expect(findeLeerseiten(befunde)).toEqual([]);
    expect(findeUnbeurteilbare(befunde)).toEqual([]);
  });
});
