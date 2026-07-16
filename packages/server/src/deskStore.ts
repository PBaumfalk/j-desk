import { randomUUID } from 'node:crypto';
import {
  applyCommand, emptyState, isValidState, type Command, type DesktopState,
} from '@digital-desktop/core';
import type { Db } from './db';

export class DeskNotFoundError extends Error {}
export class InvalidStateError extends Error {}

export interface DeskInfo {
  id: string;
  name: string;
  ownerId: string;
  ownerName: string;
  isOwner: boolean;
}

export interface DeskState {
  rev: number;
  state: DesktopState;
}

export function createDesk(db: Db, ownerId: string, name: string): DeskInfo {
  const id = randomUUID();
  db.prepare('INSERT INTO desks (id, name, owner_id, state, rev, created_at) VALUES (?, ?, ?, ?, 0, ?)').run(
    id, name, ownerId, JSON.stringify(emptyState()), Date.now(),
  );
  const ownerName = (db.prepare('SELECT username FROM users WHERE id = ?').get(ownerId) as { username: string }).username;
  return { id, name, ownerId, ownerName, isOwner: true };
}

/** Nur Schreibtische, die userId besitzt oder als Mitglied teilt. */
export function listDesks(db: Db, userId: string): DeskInfo[] {
  const rows = db.prepare(
    `SELECT d.id, d.name, d.owner_id AS ownerId, u.username AS ownerName, (d.owner_id = ?) AS isOwner
     FROM desks d JOIN users u ON u.id = d.owner_id
     WHERE d.owner_id = ? OR d.id IN (SELECT desk_id FROM desk_members WHERE user_id = ?)
     ORDER BY d.created_at`,
  ).all(userId, userId, userId) as (Omit<DeskInfo, 'isOwner'> & { isOwner: 0 | 1 })[];
  return rows.map((r) => ({ ...r, isOwner: r.isOwner === 1 }));
}

export function renameDesk(db: Db, deskId: string, name: string): void {
  const result = db.prepare('UPDATE desks SET name = ? WHERE id = ?').run(name, deskId);
  if (result.changes === 0) throw new DeskNotFoundError('Schreibtisch nicht gefunden');
}

export function deleteDesk(db: Db, deskId: string): void {
  const result = db.prepare('DELETE FROM desks WHERE id = ?').run(deskId);
  if (result.changes === 0) throw new DeskNotFoundError('Schreibtisch nicht gefunden');
}

export function getDeskState(db: Db, deskId: string): DeskState | null {
  const row = db.prepare('SELECT state, rev FROM desks WHERE id = ?').get(deskId) as
    | { state: string; rev: number }
    | undefined;
  return row ? { rev: row.rev, state: JSON.parse(row.state) as DesktopState } : null;
}

export function applyDeskCommand(db: Db, deskId: string, cmd: Command): DeskState {
  const txn = db.transaction((): DeskState => {
    const row = db.prepare('SELECT state, rev FROM desks WHERE id = ?').get(deskId) as
      | { state: string; rev: number }
      | undefined;
    if (!row) throw new DeskNotFoundError('Schreibtisch nicht gefunden');
    const next = applyCommand(JSON.parse(row.state) as DesktopState, cmd);
    const rev = row.rev + 1;
    db.prepare('UPDATE desks SET state = ?, rev = ? WHERE id = ?').run(JSON.stringify(next), rev, deskId);
    return { rev, state: next };
  });
  return txn();
}

export function putDeskState(db: Db, deskId: string, state: unknown): DeskState {
  if (!isValidState(state)) throw new InvalidStateError('Ungültiger Schreibtisch-Zustand');
  const txn = db.transaction((): DeskState => {
    const row = db.prepare('SELECT rev FROM desks WHERE id = ?').get(deskId) as { rev: number } | undefined;
    if (!row) throw new DeskNotFoundError('Schreibtisch nicht gefunden');
    const rev = row.rev + 1;
    db.prepare('UPDATE desks SET state = ?, rev = ? WHERE id = ?').run(JSON.stringify(state), rev, deskId);
    return { rev, state };
  });
  return txn();
}
