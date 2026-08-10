import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('tessdata.ts — ausschließlich lokale Pfade (T-07-32)', () => {
  it('TESSERACT_OPTIONEN enthält keinen Wert, der mit http beginnt', async () => {
    const { TESSERACT_OPTIONEN } = await import('./tessdata');
    for (const wert of Object.values(TESSERACT_OPTIONEN)) {
      if (typeof wert === 'string') {
        expect(wert.startsWith('http')).toBe(false);
      }
    }
  });

  it('TESSERACT_OPTIONEN setzt langPath/cachePath/corePath/workerPath und gzip: false', async () => {
    const { TESSERACT_OPTIONEN, TESSDATA_DIR } = await import('./tessdata');
    expect(TESSERACT_OPTIONEN.langPath).toBe(TESSDATA_DIR);
    expect(TESSERACT_OPTIONEN.cachePath).toBe(TESSDATA_DIR);
    expect(typeof TESSERACT_OPTIONEN.corePath).toBe('string');
    expect(typeof TESSERACT_OPTIONEN.workerPath).toBe('string');
    expect(TESSERACT_OPTIONEN.gzip).toBe(false);
  });
});

describe('TESSDATA_DIR — Umgebungsvariable überschreibt den Standardpfad', () => {
  const ueberschreibenderPfad = '/tmp/ein-anderer-tessdata-pfad';
  let vorherigerWert: string | undefined;

  beforeEach(() => {
    vorherigerWert = process.env.TESSDATA_DIR;
    vi.resetModules();
  });

  afterEach(() => {
    if (vorherigerWert === undefined) delete process.env.TESSDATA_DIR;
    else process.env.TESSDATA_DIR = vorherigerWert;
    vi.resetModules();
  });

  it('TESSDATA_DIR entspricht process.env.TESSDATA_DIR, wenn gesetzt', async () => {
    process.env.TESSDATA_DIR = ueberschreibenderPfad;
    const { TESSDATA_DIR } = await import('./tessdata');
    expect(TESSDATA_DIR).toBe(ueberschreibenderPfad);
  });
});

describe('sprachdatenVorhanden()', () => {
  it('liefert false in einem leeren Verzeichnis', async () => {
    const leeresVerzeichnis = mkdtempSync(join(tmpdir(), 'dd-tessdata-leer-'));
    const vorher = process.env.TESSDATA_DIR;
    process.env.TESSDATA_DIR = leeresVerzeichnis;
    vi.resetModules();
    try {
      const { sprachdatenVorhanden } = await import('./tessdata');
      expect(sprachdatenVorhanden()).toBe(false);
    } finally {
      if (vorher === undefined) delete process.env.TESSDATA_DIR;
      else process.env.TESSDATA_DIR = vorher;
      vi.resetModules();
      rmSync(leeresVerzeichnis, { recursive: true, force: true });
    }
  });

  it('liefert true, sobald deu.traineddata im Verzeichnis liegt', async () => {
    const verzeichnisMitDatei = mkdtempSync(join(tmpdir(), 'dd-tessdata-voll-'));
    writeFileSync(join(verzeichnisMitDatei, 'deu.traineddata'), 'fixture');
    const vorher = process.env.TESSDATA_DIR;
    process.env.TESSDATA_DIR = verzeichnisMitDatei;
    vi.resetModules();
    try {
      const { sprachdatenVorhanden } = await import('./tessdata');
      expect(sprachdatenVorhanden()).toBe(true);
    } finally {
      if (vorher === undefined) delete process.env.TESSDATA_DIR;
      else process.env.TESSDATA_DIR = vorher;
      vi.resetModules();
      rmSync(verzeichnisMitDatei, { recursive: true, force: true });
    }
  });
});
