import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FileKind } from '@j-desk/core';
import type { Db } from './db';

export class FileError extends Error {}

export interface FileMeta {
  id: string;
  sha256: string;
  originalName: string;
  size: number;
  kind: FileKind;
}

const MAX_SIZE = 100 * 1024 * 1024;
const PDF_MAGIC = Buffer.from('%PDF-');
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const GIF_MAGIC = Buffer.from('GIF8');
const ZIP_MAGIC = Buffer.from('PK\x03\x04');

/** Endungen, die per Euro-Office-Konvertierung eine PDF-Vorschau bekommen (Task 5 gleicht sie serverseitig ab). */
const CONVERTIBLE_EXTS = ['.odt', '.ods', '.odp', '.docx', '.xlsx', '.pptx', '.rtf', '.txt', '.csv', '.html', '.htm', '.eml'];
/** ZIP-basierte Office-Formate (per Endung von sonstigen ZIP-Dateien unterschieden). */
const ZIP_CONVERTIBLE_EXTS = ['.odt', '.ods', '.odp', '.docx', '.xlsx', '.pptx'];

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i === -1 ? '' : name.slice(i).toLowerCase();
}

function isWebp(bytes: Buffer): boolean {
  return bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP';
}

/** Klassifiziert eine Datei anhand ihrer Magic-Bytes (bevorzugt) und ihrer Endung (Fallback). */
export function classify(bytes: Buffer, name: string): FileKind {
  if (bytes.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) return 'pdf';
  if (bytes.subarray(0, JPEG_MAGIC.length).equals(JPEG_MAGIC)) return 'image';
  if (bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) return 'image';
  if (bytes.subarray(0, GIF_MAGIC.length).equals(GIF_MAGIC)) return 'image';
  if (isWebp(bytes)) return 'image';
  if (bytes.subarray(0, ZIP_MAGIC.length).equals(ZIP_MAGIC)) {
    return ZIP_CONVERTIBLE_EXTS.includes(extOf(name)) ? 'convertible' : 'other';
  }
  return CONVERTIBLE_EXTS.includes(extOf(name)) ? 'convertible' : 'other';
}

/** Klassifiziert allein anhand der Endung (keine Bytes verfügbar, z. B. beim j-lawyer-Abgleich). */
export function classifyName(name: string): FileKind {
  const ext = extOf(name);
  if (ext === '.pdf') return 'pdf';
  if (['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)) return 'image';
  if (CONVERTIBLE_EXTS.includes(ext)) return 'convertible';
  return 'other';
}

function suffixFor(kind: FileKind): 'pdf' | 'bin' {
  return kind === 'pdf' ? 'pdf' : 'bin';
}

export function storeFile(db: Db, dataDir: string, bytes: Buffer, originalName: string): FileMeta {
  if (bytes.length === 0) throw new FileError('Datei ist leer');
  if (bytes.length > MAX_SIZE) throw new FileError('Datei ist größer als 100 MB');

  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const existing = db
    .prepare('SELECT id, sha256, original_name AS originalName, size, kind FROM files WHERE sha256 = ?')
    .get(sha256) as FileMeta | undefined;
  if (existing) return existing;

  const kind = classify(bytes, originalName);
  const filesDir = join(dataDir, 'files');
  mkdirSync(filesDir, { recursive: true });
  const tmp = join(filesDir, `.tmp-${randomUUID()}`);
  try {
    writeFileSync(tmp, bytes);
    renameSync(tmp, join(filesDir, `${sha256}.${suffixFor(kind)}`));
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }

  const id = randomUUID();
  db.prepare('INSERT INTO files (id, sha256, original_name, size, created_at, kind) VALUES (?, ?, ?, ?, ?, ?)').run(
    id, sha256, originalName, bytes.length, Date.now(), kind,
  );
  return { id, sha256, originalName, size: bytes.length, kind };
}

export function getFilePath(db: Db, dataDir: string, fileId: string): string | null {
  const row = db.prepare('SELECT sha256, kind FROM files WHERE id = ?').get(fileId) as { sha256: string; kind: FileKind } | undefined;
  if (!row) return null;
  const primary = join(dataDir, 'files', `${row.sha256}.${suffixFor(row.kind)}`);
  if (existsSync(primary)) return primary;
  // Fallback für Bestandsfälle, in denen die kind-Spalte vom tatsächlich abgelegten Suffix abweicht.
  const otherSuffix = suffixFor(row.kind) === 'pdf' ? 'bin' : 'pdf';
  const fallback = join(dataDir, 'files', `${row.sha256}.${otherSuffix}`);
  return existsSync(fallback) ? fallback : null;
}

export function getFileMeta(db: Db, fileId: string): FileMeta | null {
  const row = db
    .prepare('SELECT id, sha256, original_name AS originalName, size, kind FROM files WHERE id = ?')
    .get(fileId) as FileMeta | undefined;
  return row ?? null;
}

export function fileExists(db: Db, fileId: string): boolean {
  return db.prepare('SELECT 1 FROM files WHERE id = ?').get(fileId) !== undefined;
}
