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

export async function createUser(db: Db, username: string, password: string, isAdmin = false): Promise<string> {
  const name = username.trim();
  if (name === '') throw new AuthError('Benutzername darf nicht leer sein');
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(name)) {
    throw new AuthError('Benutzername bereits vergeben');
  }
  if (password.length < 8) throw new AuthError('Passwort muss mindestens 8 Zeichen haben');
  const hash = await argon2.hash(password, { type: argon2.argon2id });
  const userId = randomUUID();
  db.prepare('INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)').run(
    userId, name, hash, isAdmin ? 1 : 0, Date.now(),
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
  if (!(await argon2.verify(user.password_hash, password))) return null;
  return createSession(db, user.id);
}

/** Legt eine Sitzung an und gibt das Token zurück (Login und Einladungs-Einlösung). */
export function createSession(db: Db, userId: string): string {
  const token = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, created_at, last_used_at) VALUES (?, ?, ?, ?)').run(
    token, userId, Date.now(), Date.now(),
  );
  return token;
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
