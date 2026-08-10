import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Scheduler } from 'tesseract.js';
import { openDb, type Db } from '../db';
import { storeFile } from '../files';

vi.mock('./extract', () => ({
  extrahiereSeitentexte: vi.fn(),
}));
vi.mock('../export/raster', () => ({
  rasterisiereSeite: vi.fn(),
}));
vi.mock('./tessdata', () => ({
  sprachdatenVorhanden: vi.fn(() => true),
  TESSERACT_OPTIONEN: { langPath: '/lokal', cachePath: '/lokal', corePath: '/lokal', workerPath: '/lokal', gzip: false },
}));
vi.mock('tesseract.js', () => ({
  createScheduler: vi.fn(),
  createWorker: vi.fn(),
}));

import { extrahiereSeitentexte } from './extract';
import { rasterisiereSeite } from '../export/raster';
import { sprachdatenVorhanden } from './tessdata';
import { createScheduler, createWorker } from 'tesseract.js';
import {
  enqueueExtraction,
  warteAufLeerlauf,
  KONFIDENZ_SCHWELLE,
  OCR_POOL_GROESSE,
  SEITEN_PRO_WORKER_LEBEN,
  type ExtraktStand,
} from './ocrQueue';

const mockExtrahiere = vi.mocked(extrahiereSeitentexte);
const mockRasterisiere = vi.mocked(rasterisiereSeite);
const mockSprachdatenVorhanden = vi.mocked(sprachdatenVorhanden);
const mockCreateScheduler = vi.mocked(createScheduler);
const mockCreateWorker = vi.mocked(createWorker);

function neueDb(): Db {
  return openDb(':memory:');
}

function standZeile(
  db: Db,
  fileId: string,
): { stand: ExtraktStand; seiten: number | null; fehler: string | null } | undefined {
  return db.prepare('SELECT stand, seiten, fehler FROM file_extract WHERE file_id = ?').get(fileId) as
    | { stand: ExtraktStand; seiten: number | null; fehler: string | null }
    | undefined;
}

function seitenZeilen(db: Db, fileId: string) {
  return db
    .prepare('SELECT page, pdf_text AS pdfText, ocr_text AS ocrText, ocr_confidence AS ocrConfidence FROM file_pages WHERE file_id = ? ORDER BY page')
    .all(fileId) as { page: number; pdfText: string | null; ocrText: string | null; ocrConfidence: number | null }[];
}

/**
 * Steuerbare tesseract.js-Attrappe nach dem in 07-RESEARCH.md vorgegebenen Muster
 * (Scheduler mit addWorker/addJob/terminate). `ergebnisFuer` liefert je Erkennungsaufruf Text +
 * Konfidenz oder wirft, um eine fehlschlagende Seite zu simulieren. Zählt Erzeugungen,
 * Worker-Hinzufügungen und Beendigungen, damit die Worker-Lebenszyklus-Fälle geprüft werden
 * können.
 */
function baueTesseractMock(ergebnisFuer: (bild: Uint8Array, aufrufIndex: number) => { text: string; confidence: number }) {
  const zustand = { erzeugungen: 0, terminierungen: 0, addWorkerAufrufe: 0, erkannteBilder: [] as Uint8Array[] };
  let aufrufIndex = 0;
  mockCreateWorker.mockImplementation(async () => ({}) as never);
  mockCreateScheduler.mockImplementation(() => {
    zustand.erzeugungen += 1;
    return {
      addWorker: () => {
        zustand.addWorkerAufrufe += 1;
        return `worker-${zustand.addWorkerAufrufe}`;
      },
      addJob: (async (_action: string, bild: Uint8Array) => {
        zustand.erkannteBilder.push(bild);
        const idx = aufrufIndex;
        aufrufIndex += 1;
        const ergebnis = ergebnisFuer(bild, idx);
        return { jobId: `job-${idx}`, data: { text: ergebnis.text, confidence: ergebnis.confidence } };
      }) as Scheduler['addJob'],
      terminate: async () => {
        zustand.terminierungen += 1;
      },
      getQueueLen: () => 0,
      getNumWorkers: () => OCR_POOL_GROESSE,
    } as Scheduler;
  });
  return zustand;
}

describe('enqueueExtraction (ocrQueue) — Zustands-/Idempotenz-/Fehlerfälle (gemocktes extract-Modul)', () => {
  beforeEach(() => {
    mockExtrahiere.mockReset();
    mockRasterisiere.mockReset();
    mockSprachdatenVorhanden.mockReset();
    mockSprachdatenVorhanden.mockReturnValue(true);
    mockCreateScheduler.mockReset();
    mockCreateWorker.mockReset();
    baueTesseractMock(() => ({ text: 'Fixture-OCR-Text', confidence: 91 }));
  });

  it('kehrt synchron zurück, bevor die Extraktion abgeschlossen ist', async () => {
    const db = neueDb();
    let aufgeloest = false;
    mockExtrahiere.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            aufgeloest = true;
            resolve([{ page: 1, text: 'Ausreichend langer Seitentext fuer den Test.', brauchtOcr: false }]);
          }, 10);
        }),
    );
    enqueueExtraction(db, 'file-sync', 'pdf', async () => new Uint8Array());
    expect(aufgeloest).toBe(false); // enqueueExtraction ist synchron zurückgekehrt, BEVOR die Extraktion fertig ist
    await warteAufLeerlauf();
    expect(aufgeloest).toBe(true);
  });

  it('legt nach warteAufLeerlauf() je Seite eine file_pages-/file_pages_fts-Zeile an, stand=pdf-text wenn alle Seiten Text hatten', async () => {
    const db = neueDb();
    mockExtrahiere.mockResolvedValue([
      { page: 1, text: 'Erster Seitentext mit ausreichend Zeichen fuer den Test.', brauchtOcr: false },
      { page: 2, text: 'Zweiter Seitentext mit ausreichend Zeichen fuer den Test.', brauchtOcr: false },
    ]);
    enqueueExtraction(db, 'file-a', 'pdf', async () => new Uint8Array([1, 2, 3]));
    await warteAufLeerlauf();

    const seiten = seitenZeilen(db, 'file-a');
    expect(seiten).toHaveLength(2);
    expect(seiten[0].pdfText).toContain('Erster Seitentext');
    expect(seiten[1].pdfText).toContain('Zweiter Seitentext');
    expect(seiten[0].ocrText).toBeNull();

    const fts = db.prepare('SELECT page FROM file_pages_fts WHERE file_id = ? ORDER BY page').all('file-a');
    expect(fts).toHaveLength(2);

    expect(standZeile(db, 'file-a')?.stand).toBe('pdf-text');
    expect(mockCreateScheduler).not.toHaveBeenCalled(); // kein OCR nötig -> kein Worker-Verbund erzeugt
  });

  it('ruft den Bytes-Zulieferer bei einem zweiten Aufruf für dieselbe fileId (bereits vorhandene file_extract-Zeile) NICHT erneut auf', async () => {
    const db = neueDb();
    mockExtrahiere.mockResolvedValue([{ page: 1, text: 'Genug Text fuer diesen Testfall hier drin.', brauchtOcr: false }]);
    const ersterZulieferer = vi.fn(async () => new Uint8Array([1]));
    enqueueExtraction(db, 'file-c', 'pdf', ersterZulieferer);
    await warteAufLeerlauf();
    expect(ersterZulieferer).toHaveBeenCalledTimes(1);

    const zweiterZulieferer = vi.fn(async () => new Uint8Array([1]));
    enqueueExtraction(db, 'file-c', 'pdf', zweiterZulieferer);
    await warteAufLeerlauf();
    expect(zweiterZulieferer).not.toHaveBeenCalled();
    expect(mockExtrahiere).toHaveBeenCalledTimes(1);
  });

  it('setzt stand=nicht-anwendbar für eine Dateiart ohne extrahierbaren Inhalt (convertible), ohne die Bytes zu lesen', () => {
    const db = neueDb();
    const zulieferer = vi.fn(async () => new Uint8Array());
    enqueueExtraction(db, 'file-convertible', 'convertible', zulieferer);
    expect(zulieferer).not.toHaveBeenCalled();
    expect(mockExtrahiere).not.toHaveBeenCalled();
    expect(standZeile(db, 'file-convertible')?.stand).toBe('nicht-anwendbar');
  });

  it('setzt stand=nicht-anwendbar für die Dateiart "other", ohne die Bytes zu lesen', () => {
    const db = neueDb();
    const zulieferer = vi.fn(async () => new Uint8Array());
    enqueueExtraction(db, 'file-other', 'other', zulieferer);
    expect(zulieferer).not.toHaveBeenCalled();
    expect(standZeile(db, 'file-other')?.stand).toBe('nicht-anwendbar');
  });

  it('setzt stand=fehler mit Meldung, wenn die Extraktion selbst wirft — enqueueExtraction wirft nicht', async () => {
    const db = neueDb();
    mockExtrahiere.mockRejectedValue(new Error('kaputtes PDF'));
    expect(() => enqueueExtraction(db, 'file-fehler', 'pdf', async () => new Uint8Array([1]))).not.toThrow();
    await warteAufLeerlauf();
    const stand = standZeile(db, 'file-fehler');
    expect(stand?.stand).toBe('fehler');
    expect(stand?.fehler).toContain('kaputtes PDF');
  });
});

describe('storeFile → enqueueExtraction (Integration gegen eine temporäre DB)', () => {
  beforeEach(() => {
    mockExtrahiere.mockReset();
    mockRasterisiere.mockReset();
    mockSprachdatenVorhanden.mockReset();
    mockSprachdatenVorhanden.mockReturnValue(true);
    mockCreateScheduler.mockReset();
    mockCreateWorker.mockReset();
    baueTesseractMock(() => ({ text: 'Fixture-OCR-Text', confidence: 91 }));
  });

  it('storeFile mit denselben Bytes zweimal aufgerufen erzeugt genau einen Extraktionslauf', async () => {
    mockExtrahiere.mockResolvedValue([{ page: 1, text: 'Genug Text fuer diesen Integrationstest hier.', brauchtOcr: false }]);
    const db = neueDb();
    const dataDir = mkdtempSync(join(tmpdir(), 'dd-ocr-'));
    const bytes = Buffer.from('%PDF-1.4\ninhalt-ocr-integrationstest');

    const meta1 = storeFile(db, dataDir, bytes, 'a.pdf');
    await warteAufLeerlauf();
    const meta2 = storeFile(db, dataDir, bytes, 'a.pdf'); // dieselben Bytes -> Dedupe-Pfad (sha256-Treffer)
    await warteAufLeerlauf();

    expect(meta2.id).toBe(meta1.id);
    expect(mockExtrahiere).toHaveBeenCalledTimes(1);
    expect(standZeile(db, meta1.id)?.stand).toBe('pdf-text');
  });
});

/**
 * 07-07 Task 2 — OCR-Stufe: gerasterte PDF-Seiten und Bilder, mit Konfidenz und
 * Worker-Lebenszyklus. Kein echtes tesseract.js in dieser Testsuite (CONTEXT.md-Vorgabe) — die
 * Attrappe folgt dem in 07-RESEARCH.md vorgegebenen Scheduler-Muster.
 */
describe('OCR-Stufe (Task 2) — PDF-Seiten über rasterisiereSeite, Bilder direkt', () => {
  beforeEach(() => {
    mockExtrahiere.mockReset();
    mockRasterisiere.mockReset();
    mockSprachdatenVorhanden.mockReset();
    mockSprachdatenVorhanden.mockReturnValue(true);
    mockCreateScheduler.mockReset();
    mockCreateWorker.mockReset();
    mockRasterisiere.mockImplementation(async () => new Uint8Array([9, 9, 9]));
  });

  it('ein PDF, dessen Seiten alle brauchtOcr tragen, führt zu ocr_text/ocr_confidence je Seite und stand=ocr-fertig', async () => {
    baueTesseractMock(() => ({ text: 'Erkannter deutscher Text', confidence: 88 }));
    mockExtrahiere.mockResolvedValue([
      { page: 1, text: '', brauchtOcr: true },
      { page: 2, text: '', brauchtOcr: true },
    ]);
    const db = neueDb();
    enqueueExtraction(db, 'file-ocr-alle', 'pdf', async () => new Uint8Array([1]));
    await warteAufLeerlauf();

    const seiten = seitenZeilen(db, 'file-ocr-alle');
    expect(seiten).toHaveLength(2);
    expect(seiten[0].ocrText).toBe('Erkannter deutscher Text');
    expect(seiten[0].ocrConfidence).toBe(88);
    expect(seiten[1].ocrText).toBe('Erkannter deutscher Text');
    expect(standZeile(db, 'file-ocr-alle')?.stand).toBe('ocr-fertig');

    const ftsZeile = db
      .prepare('SELECT ocr_text AS ocrText FROM file_pages_fts WHERE file_id = ? AND page = ?')
      .get('file-ocr-alle', 1) as { ocrText: string } | undefined;
    expect(ftsZeile?.ocrText).toBe('Erkannter deutscher Text');
  });

  it('ein PDF mit gemischten Seiten erhält OCR nur für die textlose Seite; die Textseite behält ocr_text=NULL/ocr_confidence=NULL, stand bleibt ocr-fertig', async () => {
    baueTesseractMock(() => ({ text: 'Nur diese Seite wurde erkannt', confidence: 75 }));
    mockExtrahiere.mockResolvedValue([
      { page: 1, text: 'Ausreichend eingebetteter Text auf dieser Seite.', brauchtOcr: false },
      { page: 2, text: 'kurz', brauchtOcr: true },
    ]);
    const db = neueDb();
    enqueueExtraction(db, 'file-gemischt', 'pdf', async () => new Uint8Array([1]));
    await warteAufLeerlauf();

    const seiten = seitenZeilen(db, 'file-gemischt');
    expect(seiten[0].ocrText).toBeNull();
    expect(seiten[0].ocrConfidence).toBeNull();
    expect(seiten[0].pdfText).toContain('eingebetteter Text');
    expect(seiten[1].ocrText).toBe('Nur diese Seite wurde erkannt');
    expect(seiten[1].ocrConfidence).toBe(75);
    expect(standZeile(db, 'file-gemischt')?.stand).toBe('ocr-fertig');
    // Nur genau eine Seite (die textlose) wurde gerastert/erkannt.
    expect(mockRasterisiere).toHaveBeenCalledTimes(1);
    expect(mockRasterisiere).toHaveBeenCalledWith(expect.any(Uint8Array), 1); // seitenIndex 1 = Seite 2 (0-basiert)
  });

  it('eine Bilddatei läuft direkt durch die Erkennung, ohne dass rasterisiereSeite aufgerufen wird; Ergebnis steht als Seite 1, stand=ocr-fertig', async () => {
    baueTesseractMock(() => ({ text: 'Text aus dem Bild', confidence: 80 }));
    const db = neueDb();
    const bildBytes = new Uint8Array([0xff, 0xd8, 0xff]);
    enqueueExtraction(db, 'file-bild', 'image', async () => bildBytes);
    await warteAufLeerlauf();

    expect(mockExtrahiere).not.toHaveBeenCalled(); // Bilder laufen nicht über die PDF-Textextraktion
    expect(mockRasterisiere).not.toHaveBeenCalled(); // kein Rasterungsschritt für Bilder

    const seiten = seitenZeilen(db, 'file-bild');
    expect(seiten).toHaveLength(1);
    expect(seiten[0].page).toBe(1);
    expect(seiten[0].pdfText).toBeNull();
    expect(seiten[0].ocrText).toBe('Text aus dem Bild');
    expect(seiten[0].ocrConfidence).toBe(80);
    expect(standZeile(db, 'file-bild')?.stand).toBe('ocr-fertig');
  });

  it('fehlt die Sprachdatei, bleibt der Stand ocr-ausstehend, es werden keine ocr_text-Werte geschrieben, und nichts wirft', async () => {
    baueTesseractMock(() => ({ text: 'sollte nie aufgerufen werden', confidence: 100 }));
    mockSprachdatenVorhanden.mockReturnValue(false);
    mockExtrahiere.mockResolvedValue([{ page: 1, text: '', brauchtOcr: true }]);
    const db = neueDb();
    expect(() => enqueueExtraction(db, 'file-ohne-sprachdaten', 'pdf', async () => new Uint8Array([1]))).not.toThrow();
    await warteAufLeerlauf();

    expect(standZeile(db, 'file-ohne-sprachdaten')?.stand).toBe('ocr-ausstehend');
    const seiten = seitenZeilen(db, 'file-ohne-sprachdaten');
    expect(seiten[0].ocrText).toBeNull();
    expect(mockCreateScheduler).not.toHaveBeenCalled();
  });

  it('fehlt die Sprachdatei für eine Bilddatei, bleibt der Stand ebenfalls ocr-ausstehend, ohne file_pages-Zeile', async () => {
    mockSprachdatenVorhanden.mockReturnValue(false);
    const db = neueDb();
    enqueueExtraction(db, 'file-bild-ohne-sprachdaten', 'image', async () => new Uint8Array([1]));
    await warteAufLeerlauf();

    expect(standZeile(db, 'file-bild-ohne-sprachdaten')?.stand).toBe('ocr-ausstehend');
    expect(seitenZeilen(db, 'file-bild-ohne-sprachdaten')).toHaveLength(0);
  });

  it('wirft die Erkennung für eine Seite, wird der Lauf für die restlichen Seiten fortgesetzt, stand endet auf fehler, bereits erkannte Seiten bleiben gespeichert', async () => {
    baueTesseractMock((_bild, idx) => {
      if (idx === 0) throw new Error('Erkennung für Seite 1 fehlgeschlagen');
      return { text: 'Seite 2 erfolgreich erkannt', confidence: 70 };
    });
    mockExtrahiere.mockResolvedValue([
      { page: 1, text: '', brauchtOcr: true },
      { page: 2, text: '', brauchtOcr: true },
    ]);
    const db = neueDb();
    enqueueExtraction(db, 'file-teilfehler', 'pdf', async () => new Uint8Array([1]));
    await warteAufLeerlauf();

    const seiten = seitenZeilen(db, 'file-teilfehler');
    expect(seiten[0].ocrText).toBeNull(); // Seite 1 ist fehlgeschlagen, bleibt ohne OCR-Text
    expect(seiten[1].ocrText).toBe('Seite 2 erfolgreich erkannt'); // Seite 2 bleibt trotz Gesamtfehler erhalten
    const stand = standZeile(db, 'file-teilfehler');
    expect(stand?.stand).toBe('fehler');
    expect(stand?.fehler).toContain('Seite 1');
  });

  it('der Worker-Verbund wird nach Abschluss eines Auftrags beendet', async () => {
    const zustand = baueTesseractMock(() => ({ text: 'x', confidence: 90 }));
    mockExtrahiere.mockResolvedValue([{ page: 1, text: '', brauchtOcr: true }]);
    const db = neueDb();
    enqueueExtraction(db, 'file-verbund-ende', 'pdf', async () => new Uint8Array([1]));
    await warteAufLeerlauf();

    expect(zustand.erzeugungen).toBe(1);
    expect(zustand.terminierungen).toBe(1);
    expect(zustand.addWorkerAufrufe).toBe(OCR_POOL_GROESSE);
  });

  it('ein Fehler mitten im Auftrag beendet den Verbund ebenfalls', async () => {
    const zustand = baueTesseractMock(() => {
      throw new Error('Erkennung schlägt immer fehl');
    });
    mockExtrahiere.mockResolvedValue([{ page: 1, text: '', brauchtOcr: true }]);
    const db = neueDb();
    enqueueExtraction(db, 'file-verbund-fehler', 'pdf', async () => new Uint8Array([1]));
    await warteAufLeerlauf();

    expect(zustand.terminierungen).toBe(1);
    expect(standZeile(db, 'file-verbund-fehler')?.stand).toBe('fehler');
  });

  it(`nach mehr als ${SEITEN_PRO_WORKER_LEBEN} verarbeiteten Seiten wird der Verbund innerhalb EINES Auftrags neu erzeugt`, async () => {
    const anzahlSeiten = SEITEN_PRO_WORKER_LEBEN + 1;
    const zustand = baueTesseractMock(() => ({ text: 'x', confidence: 90 }));
    mockExtrahiere.mockResolvedValue(
      Array.from({ length: anzahlSeiten }, (_, i) => ({ page: i + 1, text: '', brauchtOcr: true })),
    );
    const db = neueDb();
    enqueueExtraction(db, 'file-viele-seiten', 'pdf', async () => new Uint8Array([1]));
    await warteAufLeerlauf();

    // Erzeugung 1 (Start) + Erzeugung 2 (Neuerzeugung nach SEITEN_PRO_WORKER_LEBEN Seiten).
    expect(zustand.erzeugungen).toBe(2);
    // Beendigung 1 (Neuerzeugung mitten im Auftrag) + Beendigung 2 (Abschluss im finally).
    expect(zustand.terminierungen).toBe(2);
    expect(standZeile(db, 'file-viele-seiten')?.stand).toBe('ocr-fertig');
    expect(seitenZeilen(db, 'file-viele-seiten')).toHaveLength(anzahlSeiten);
  });

  it(`KONFIDENZ_SCHWELLE ist 70`, () => {
    expect(KONFIDENZ_SCHWELLE).toBe(70);
  });
});
