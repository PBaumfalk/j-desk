import { randomBytes } from 'node:crypto';
import type { Db } from './db';
import { createUser, createSession } from './auth';
import { ForbiddenError } from './guards';

export class InviteError extends Error {}

const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export interface InviteInfo {
  token: string;
  deskId: string | null;
  deskName: string | null;
  createdBy: string;
  expiresAt: number;
}

function pruneExpired(db: Db): void {
  db.prepare('DELETE FROM invites WHERE expires_at < ?').run(Date.now());
}

export function createInvite(db: Db, creatorId: string, deskId: string | null): { token: string; expiresAt: number } {
  const token = randomBytes(32).toString('hex');
  const expiresAt = Date.now() + INVITE_TTL_MS;
  db.prepare('INSERT INTO invites (token, created_by, desk_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').run(
    token, creatorId, deskId, Date.now(), expiresAt,
  );
  return { token, expiresAt };
}

export function listInvites(db: Db, userId: string, all: boolean): InviteInfo[] {
  pruneExpired(db);
  const sql = `SELECT i.token, i.desk_id AS deskId, d.name AS deskName, i.created_by AS createdBy, i.expires_at AS expiresAt
               FROM invites i LEFT JOIN desks d ON d.id = i.desk_id
               ${all ? '' : 'WHERE i.created_by = ?'} ORDER BY i.created_at`;
  const stmt = db.prepare(sql);
  return (all ? stmt.all() : stmt.all(userId)) as InviteInfo[];
}

export function getInvite(db: Db, token: string): { deskId: string | null; deskName: string | null } | null {
  pruneExpired(db);
  const row = db.prepare(
    'SELECT i.desk_id AS deskId, d.name AS deskName FROM invites i LEFT JOIN desks d ON d.id = i.desk_id WHERE i.token = ?',
  ).get(token) as { deskId: string | null; deskName: string | null } | undefined;
  return row ?? null;
}

export function revokeInvite(db: Db, token: string, userId: string, admin: boolean): void {
  const row = db.prepare('SELECT created_by AS createdBy FROM invites WHERE token = ?').get(token) as
    | { createdBy: string }
    | undefined;
  if (!row) throw new InviteError('Einladung nicht gefunden');
  if (!admin && row.createdBy !== userId) throw new ForbiddenError('Nur der Ersteller oder der Admin darf widerrufen');
  db.prepare('DELETE FROM invites WHERE token = ?').run(token);
}

/** Konto anlegen, ggf. Mitgliedschaft eintragen, Einladung verbrauchen → Session-Token. */
export async function redeemInvite(db: Db, token: string, username: string, password: string): Promise<string> {
  const invite = getInvite(db, token);
  if (!invite) throw new InviteError('Einladung ist ungültig oder abgelaufen');
  const userId = await createUser(db, username, password); // validiert Name, Passwort, Duplikat
  const txn = db.transaction(() => {
    if (db.prepare('DELETE FROM invites WHERE token = ?').run(token).changes === 0) {
      throw new InviteError('Einladung ist ungültig oder abgelaufen');
    }
    if (invite.deskId) db.prepare('INSERT INTO desk_members (desk_id, user_id) VALUES (?, ?)').run(invite.deskId, userId);
  });
  try {
    txn();
  } catch (e) {
    db.prepare('DELETE FROM users WHERE id = ?').run(userId); // Konto zurücknehmen
    throw e;
  }
  return createSession(db, userId);
}
