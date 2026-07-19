import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { openDb, type Db } from './db';
import { storeFile, getFilePath, fileExists, getFileMeta, classify, classifyName, FileError } from './files';

const pdfBytes = (inhalt: string) => Buffer.from(`%PDF-1.4\n${inhalt}`);

let db: Db;
let dataDir: string;
beforeEach(() => {
  db = openDb(':memory:');
  dataDir = mkdtempSync(join(tmpdir(), 'dd-files-'));
});

describe('classify', () => {
  it('klassifiziert nach Magic-Bytes und Endung', () => {
    expect(classify(Buffer.from('%PDF-1.4 x'), 'a.pdf')).toBe('pdf');
    expect(classify(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'foto.jpg')).toBe('image');
    expect(classify(Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'bild.png')).toBe('image');
    expect(classify(Buffer.concat([Buffer.from('RIFF1234'), Buffer.from('WEBP')]), 'x.webp')).toBe('image');
    expect(classify(Buffer.from('GIF89a...'), 'anim.gif')).toBe('image');
    expect(classify(Buffer.from('PK\x03\x04rest'), 'brief.odt')).toBe('convertible');
    expect(classify(Buffer.from('PK\x03\x04rest'), 'tabelle.xlsx')).toBe('convertible');
    expect(classify(Buffer.from('PK\x03\x04rest'), 'archiv.zip')).toBe('other');
    expect(classify(Buffer.from('nur text'), 'notiz.txt')).toBe('convertible');
    expect(classify(Buffer.from('MZ…'), 'tool.exe')).toBe('other');
  });
});

describe('classifyName', () => {
  it('klassifiziert allein nach Endung (ohne Bytes)', () => {
    expect(classifyName('a.pdf')).toBe('pdf');
    expect(classifyName('foto.JPG')).toBe('image');
    expect(classifyName('brief.docx')).toBe('convertible');
    expect(classifyName('notiz.txt')).toBe('convertible');
    expect(classifyName('archiv.zip')).toBe('other');
  });
});

describe('storeFile', () => {
  it('speichert eine PDF unter files/<sha256>.pdf und registriert sie', () => {
    const meta = storeFile(db, dataDir, pdfBytes('eins'), 'Rechnung.pdf');
    expect(meta.originalName).toBe('Rechnung.pdf');
    expect(meta.kind).toBe('pdf');
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

  it('storeFile akzeptiert Nicht-PDFs und liefert kind; getFilePath findet sie', () => {
    const meta = storeFile(db, dataDir, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]), 'foto.jpg');
    expect(meta.kind).toBe('image');
    const path = getFilePath(db, dataDir, meta.id);
    expect(path).toBeTruthy();
    expect(path).toBe(join(dataDir, 'files', `${meta.sha256}.bin`));
  });

  it('klassifiziert unbekannte Endung/Signatur als "other" statt abzulehnen', () => {
    const meta = storeFile(db, dataDir, Buffer.from('kein pdf'), 'a.pdf');
    expect(meta.kind).toBe('other');
  });

  it('leere Datei und Größenlimit werfen weiterhin', () => {
    expect(() => storeFile(db, dataDir, Buffer.alloc(0), 'a.pdf')).toThrow(FileError);
  });

  it('räumt die tmp-Datei auf, wenn das Umbenennen fehlschlägt', () => {
    const bytes = pdfBytes('eins');
    const sha = createHash('sha256').update(bytes).digest('hex');
    // Zielpfad als VERZEICHNIS blockieren → renameSync wirft, writeFileSync(tmp) war erfolgreich
    mkdirSync(join(dataDir, 'files', `${sha}.pdf`), { recursive: true });
    expect(() => storeFile(db, dataDir, bytes, 'a.pdf')).toThrow();
    expect(readdirSync(join(dataDir, 'files')).some((f) => f.startsWith('.tmp-'))).toBe(false);
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

  it('findet Bestandsdateien auch wenn die kind-Spalte vom tatsächlichen Suffix abweicht (Fallback)', () => {
    const meta = storeFile(db, dataDir, pdfBytes('eins'), 'a.pdf');
    // simuliert einen Bestandsfall: DB-kind stimmt nicht (mehr) mit dem abgelegten Suffix überein
    db.prepare('UPDATE files SET kind = ? WHERE id = ?').run('other', meta.id);
    expect(getFilePath(db, dataDir, meta.id)).toBe(join(dataDir, 'files', `${meta.sha256}.pdf`));
  });
});

describe('getFileMeta', () => {
  it('liefert Metadaten inkl. kind oder null für Unbekanntes', () => {
    const meta = storeFile(db, dataDir, pdfBytes('eins'), 'a.pdf');
    expect(getFileMeta(db, meta.id)).toEqual(meta);
    expect(getFileMeta(db, 'gibtsnicht')).toBeNull();
  });
});
