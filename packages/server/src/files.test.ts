import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from './db';
import { storeFile, getFilePath, fileExists, FileError } from './files';

const pdfBytes = (inhalt: string) => Buffer.from(`%PDF-1.4\n${inhalt}`);

let db: Db;
let dataDir: string;
beforeEach(() => {
  db = openDb(':memory:');
  dataDir = mkdtempSync(join(tmpdir(), 'dd-files-'));
});

describe('storeFile', () => {
  it('speichert eine PDF unter files/<sha256>.pdf und registriert sie', () => {
    const meta = storeFile(db, dataDir, pdfBytes('eins'), 'Rechnung.pdf');
    expect(meta.originalName).toBe('Rechnung.pdf');
    const stored = join(dataDir, 'files', `${meta.sha256}.pdf`);
    expect(existsSync(stored)).toBe(true);
    expect(readFileSync(stored).equals(pdfBytes('eins'))).toBe(true);
    expect(readdirSync(join(dataDir, 'files')).some((f) => f.startsWith('.tmp-'))).toBe(false);
  });

  it('dedupliziert inhaltsgleiche Uploads', () => {
    const a = storeFile(db, dataDir, pdfBytes('eins'), 'a.pdf');
    const b = storeFile(db, dataDir, pdfBytes('eins'), 'kopie.pdf');
    expect(b.id).toBe(a.id);
    expect(readdirSync(join(dataDir, 'files'))).toHaveLength(1);
  });

  it('lehnt falsche Endung, fehlende PDF-Signatur und leere Dateien ab', () => {
    expect(() => storeFile(db, dataDir, pdfBytes('x'), 'notiz.txt')).toThrow(FileError);
    expect(() => storeFile(db, dataDir, Buffer.from('kein pdf'), 'a.pdf')).toThrow(FileError);
    expect(() => storeFile(db, dataDir, Buffer.alloc(0), 'a.pdf')).toThrow(FileError);
  });
});

describe('getFilePath / fileExists', () => {
  it('liefert den Pfad einer gespeicherten Datei und null für Unbekanntes', () => {
    const meta = storeFile(db, dataDir, pdfBytes('eins'), 'a.pdf');
    expect(getFilePath(db, dataDir, meta.id)).toBe(join(dataDir, 'files', `${meta.sha256}.pdf`));
    expect(getFilePath(db, dataDir, 'gibtsnicht')).toBeNull();
    expect(fileExists(db, meta.id)).toBe(true);
    expect(fileExists(db, 'gibtsnicht')).toBe(false);
  });
});
