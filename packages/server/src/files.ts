import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from './db';

export class FileError extends Error {}

export interface FileMeta {
  id: string;
  sha256: string;
  originalName: string;
  size: number;
}

const MAX_SIZE = 100 * 1024 * 1024;
const PDF_MAGIC = Buffer.from('%PDF-');

export function storeFile(db: Db, dataDir: string, bytes: Buffer, originalName: string, uploaderId: string | null): FileMeta {
  if (!originalName.toLowerCase().endsWith('.pdf')) throw new FileError('Nur PDF-Dateien (.pdf) werden akzeptiert');
  if (bytes.length === 0) throw new FileError('Datei ist leer');
  if (bytes.length > MAX_SIZE) throw new FileError('Datei ist größer als 100 MB');
  if (!bytes.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) throw new FileError('Datei ist keine gültige PDF');

  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const existing = db
    .prepare('SELECT id, sha256, original_name AS originalName, size FROM files WHERE sha256 = ?')
    .get(sha256) as FileMeta | undefined;
  if (existing) return existing;

  const filesDir = join(dataDir, 'files');
  mkdirSync(filesDir, { recursive: true });
  const tmp = join(filesDir, `.tmp-${randomUUID()}`);
  try {
    writeFileSync(tmp, bytes);
    renameSync(tmp, join(filesDir, `${sha256}.pdf`));
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }

  const id = randomUUID();
  db.prepare('INSERT INTO files (id, sha256, original_name, size, uploader_id, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    id, sha256, originalName, bytes.length, uploaderId, Date.now(),
  );
  return { id, sha256, originalName, size: bytes.length };
}

export function getFilePath(db: Db, dataDir: string, fileId: string): string | null {
  const row = db.prepare('SELECT sha256 FROM files WHERE id = ?').get(fileId) as { sha256: string } | undefined;
  if (!row) return null;
  const path = join(dataDir, 'files', `${row.sha256}.pdf`);
  return existsSync(path) ? path : null;
}

export function fileExists(db: Db, fileId: string): boolean {
  return db.prepare('SELECT 1 FROM files WHERE id = ?').get(fileId) !== undefined;
}
