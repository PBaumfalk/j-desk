import type { Db } from './db';
import { DeskNotFoundError } from './deskStore';

export class ForbiddenError extends Error {}

function deskOwnerId(db: Db, deskId: string): string {
  const row = db.prepare('SELECT owner_id AS ownerId FROM desks WHERE id = ?').get(deskId) as
    | { ownerId: string }
    | undefined;
  if (!row) throw new DeskNotFoundError('Schreibtisch nicht gefunden');
  return row.ownerId;
}

function isMember(db: Db, deskId: string, userId: string): boolean {
  return db.prepare('SELECT 1 FROM desk_members WHERE desk_id = ? AND user_id = ?').get(deskId, userId) !== undefined;
}

/** Besitzer oder Mitglied — sonst ForbiddenError (bzw. DeskNotFoundError, wenn der Desk fehlt). */
export function requireDeskAccess(db: Db, deskId: string, userId: string): void {
  if (deskOwnerId(db, deskId) !== userId && !isMember(db, deskId, userId)) {
    throw new ForbiddenError('Kein Zugriff auf diesen Schreibtisch');
  }
}

export function requireDeskOwner(db: Db, deskId: string, userId: string): void {
  if (deskOwnerId(db, deskId) !== userId) throw new ForbiddenError('Nur der Besitzer darf das');
}

export function isAdminUser(db: Db, userId: string): boolean {
  const row = db.prepare('SELECT is_admin AS isAdmin FROM users WHERE id = ?').get(userId) as
    | { isAdmin: number }
    | undefined;
  return row?.isAdmin === 1;
}

export function requireAdmin(db: Db, userId: string): void {
  if (!isAdminUser(db, userId)) throw new ForbiddenError('Nur der Admin darf das');
}

/** Datei lesbar, wenn selbst hochgeladen oder in einem zugänglichen Schreibtisch referenziert. */
export function canReadFile(db: Db, userId: string, fileId: string): boolean {
  const row = db.prepare('SELECT uploader_id AS uploaderId FROM files WHERE id = ?').get(fileId) as
    | { uploaderId: string | null }
    | undefined;
  if (!row) return false;
  if (row.uploaderId === userId) return true;
  // LIKE als Vorfilter (fileId ist eine UUID), JSON-Parse als Beweis
  const kandidaten = db.prepare(
    `SELECT state FROM desks
     WHERE (owner_id = ? OR id IN (SELECT desk_id FROM desk_members WHERE user_id = ?)) AND state LIKE ?`,
  ).all(userId, userId, `%${fileId}%`) as { state: string }[];
  return kandidaten.some((k) =>
    (JSON.parse(k.state) as { docs: { fileId: string }[] }).docs.some((d) => d.fileId === fileId),
  );
}
