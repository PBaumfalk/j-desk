import { randomBytes, randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import type { Db } from './db';

export class AuthError extends Error {}

const SESSION_MAX_IDLE_MS = 30 * 24 * 60 * 60 * 1000;

// Vergleichs-Hash für unbekannte Benutzernamen — hält die Login-Dauer konstant (kein Benutzer-Enumerieren per Timing)
const DUMMY_HASH = argon2.hash('dummy-passwort-gegen-timing', { type: argon2.argon2id });

export function needsSetup(db: Db): boolean {
  const row = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
  return row.n === 0;
}

export async function createUser(db: Db, username: string, password: string): Promise<string> {
  if (username.trim() === '') throw new AuthError('Benutzername darf nicht leer sein');
  if (password.length < 8) throw new AuthError('Passwort muss mindestens 8 Zeichen haben');
  const hash = await argon2.hash(password, { type: argon2.argon2id });
  const userId = randomUUID();
  db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)').run(
    userId, username.trim(), hash, Date.now(),
  );
  return userId;
}

export async function login(db: Db, username: string, password: string): Promise<string | null> {
  const user = db
    .prepare('SELECT id, password_hash FROM users WHERE username = ?')
    .get(username.trim()) as { id: string; password_hash: string } | undefined;
  if (!user) {
    await argon2.verify(await DUMMY_HASH, password).catch(() => false);
    return null;
  }
  // verify wirft bei Nicht-argon2-Hashes (z. B. dem extern:jlawyer-Platzhalter) — zählt als falsch
  const passt = await argon2.verify(user.password_hash, password).catch(() => false);
  if (!passt) return null;
  return createSession(db, user.id);
}

/** Stellt ein Session-Token für einen bereits verifizierten Benutzer aus. */
export function createSession(db: Db, userId: string): string {
  const token = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, created_at, last_used_at) VALUES (?, ?, ?, ?)').run(
    token, userId, Date.now(), Date.now(),
  );
  return token;
}

/**
 * Konto für einen extern (j-lawyer) verifizierten Benutzer — wird beim ersten
 * Login angelegt. Der Passwort-Hash-Platzhalter kann nie ein argon2-Verify
 * bestehen; lokale Anmeldung mit diesem Konto ist damit ausgeschlossen.
 */
export function ensureExternalUser(db: Db, username: string): string {
  const row = db.prepare('SELECT id FROM users WHERE username = ?').get(username.trim()) as
    | { id: string }
    | undefined;
  if (row) return row.id;
  const userId = randomUUID();
  db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)').run(
    userId, username.trim(), 'extern:jlawyer', Date.now(),
  );
  return userId;
}

export function validateToken(db: Db, token: string): { userId: string } | null {
  const row = db
    .prepare('SELECT user_id, last_used_at FROM sessions WHERE token = ?')
    .get(token) as { user_id: string; last_used_at: number } | undefined;
  if (!row) return null;
  if (Date.now() - row.last_used_at > SESSION_MAX_IDLE_MS) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  db.prepare('UPDATE sessions SET last_used_at = ? WHERE token = ?').run(Date.now(), token);
  return { userId: row.user_id };
}

export function logout(db: Db, token: string): void {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export interface WsTickets {
  issue(userId: string): string;
  consume(ticket: string): { userId: string } | null;
}

/**
 * Kurzlebige Einmal-Tickets für den WebSocket-Verbindungsaufbau: Browser-WebSockets
 * können keine Header setzen, und das Session-Token soll nicht in Query-Strings
 * (Logs, Proxies) landen. Tickets leben nur im Speicher — nach einem Neustart
 * holen sich die Clients beim Reconnect ohnehin ein frisches.
 */
export function createWsTickets(ttlMs = 30_000): WsTickets {
  const tickets = new Map<string, { userId: string; expires: number }>();
  return {
    issue(userId) {
      for (const [t, v] of tickets) if (v.expires < Date.now()) tickets.delete(t);
      const ticket = randomBytes(32).toString('hex');
      tickets.set(ticket, { userId, expires: Date.now() + ttlMs });
      return ticket;
    },
    consume(ticket) {
      const entry = tickets.get(ticket);
      if (!entry) return null;
      tickets.delete(ticket); // Einmal-Nutzung
      return entry.expires < Date.now() ? null : { userId: entry.userId };
    },
  };
}
