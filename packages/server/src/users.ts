import argon2 from 'argon2';
import type { Db } from './db';
import { AuthError } from './auth';

export class UserNotFoundError extends Error {}

export interface UserInfo {
  id: string;
  username: string;
  isAdmin: boolean;
}

export function listUsers(db: Db): UserInfo[] {
  const rows = db.prepare('SELECT id, username, is_admin AS isAdmin FROM users ORDER BY created_at').all() as
    { id: string; username: string; isAdmin: number }[];
  return rows.map((r) => ({ ...r, isAdmin: r.isAdmin === 1 }));
}

export function renameUser(db: Db, userId: string, username: string): void {
  const name = username.trim();
  if (name === '') throw new AuthError('Benutzername darf nicht leer sein');
  const belegt = db.prepare('SELECT id FROM users WHERE username = ?').get(name) as { id: string } | undefined;
  if (belegt && belegt.id !== userId) throw new AuthError('Benutzername bereits vergeben');
  const result = db.prepare('UPDATE users SET username = ? WHERE id = ?').run(name, userId);
  if (result.changes === 0) throw new UserNotFoundError('Benutzer nicht gefunden');
}

/** Admin-Reset: neues Passwort setzen und alle Sitzungen des Betroffenen beenden. */
export async function resetPassword(db: Db, userId: string, password: string): Promise<void> {
  if (password.length < 8) throw new AuthError('Passwort muss mindestens 8 Zeichen haben');
  const hash = await argon2.hash(password, { type: argon2.argon2id });
  const result = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, userId);
  if (result.changes === 0) throw new UserNotFoundError('Benutzer nicht gefunden');
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

/** Eigenes Passwort wechseln; bestehende Sitzungen bleiben gültig. */
export async function changeOwnPassword(db: Db, userId: string, oldPassword: string, newPassword: string): Promise<void> {
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId) as
    | { password_hash: string }
    | undefined;
  if (!row) throw new UserNotFoundError('Benutzer nicht gefunden');
  if (!(await argon2.verify(row.password_hash, oldPassword))) throw new AuthError('Aktuelles Passwort ist falsch');
  if (newPassword.length < 8) throw new AuthError('Passwort muss mindestens 8 Zeichen haben');
  const hash = await argon2.hash(newPassword, { type: argon2.argon2id });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, userId);
}

export function getUserDesks(db: Db, userId: string): { id: string; name: string }[] {
  return db.prepare('SELECT id, name FROM desks WHERE owner_id = ? ORDER BY created_at').all(userId) as
    { id: string; name: string }[];
}

/** Löscht das Konto samt eigener Schreibtische; gibt deren IDs zurück (für WS-Closes). */
export function deleteUserCascade(db: Db, userId: string): string[] {
  const txn = db.transaction((): string[] => {
    if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId)) {
      throw new UserNotFoundError('Benutzer nicht gefunden');
    }
    const eigene = (db.prepare('SELECT id FROM desks WHERE owner_id = ?').all(userId) as { id: string }[]).map((r) => r.id);
    db.prepare('DELETE FROM desks WHERE owner_id = ?').run(userId);
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    return eigene;
  });
  return txn();
}
