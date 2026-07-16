import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openDb } from './db';

describe('openDb', () => {
  it('legt alle Tabellen an', () => {
    const db = openDb(':memory:');
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    for (const t of ['users', 'sessions', 'desks', 'desk_members', 'files']) {
      expect(names).toContain(t);
    }
  });

  it('erzwingt eindeutige Benutzernamen', () => {
    const db = openDb(':memory:');
    const ins = db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)');
    ins.run('u1', 'patrick', 'h', 0);
    expect(() => ins.run('u2', 'patrick', 'h', 0)).toThrow();
  });
});

describe('Migration v1', () => {
  it('frische DB steht auf user_version 1 und hat die invites-Tabelle mit FKs', () => {
    const db = openDb(':memory:');
    expect(db.pragma('user_version', { simple: true })).toBe(1);
    db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)').run('u1', 'p', 'h', 0);
    db.prepare('INSERT INTO invites (token, created_by, desk_id, created_at, expires_at) VALUES (?, ?, NULL, 0, 9)').run('t1', 'u1');
    db.prepare('DELETE FROM users WHERE id = ?').run('u1');
    expect(db.prepare('SELECT 1 FROM invites').get()).toBeUndefined(); // created_by CASCADE
  });

  it('migriert eine echte v0-Datei-DB beim Öffnen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dd-mig-'));
    const path = join(dir, 'alt.sqlite');
    const alt = new Database(path);
    alt.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL);
      CREATE TABLE desks (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES users(id), state TEXT NOT NULL, rev INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
      CREATE TABLE desk_members (desk_id TEXT NOT NULL REFERENCES desks(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, PRIMARY KEY (desk_id, user_id));
      CREATE TABLE files (id TEXT PRIMARY KEY, sha256 TEXT NOT NULL UNIQUE, original_name TEXT NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL);
      INSERT INTO users VALUES ('u1', 'patrick', 'h', 0);
      INSERT INTO files VALUES ('f1', 's', 'a.pdf', 1, 0);
    `);
    alt.close();
    const db = openDb(path);
    expect(db.pragma('user_version', { simple: true })).toBe(1);
    expect((db.prepare('SELECT is_admin AS a FROM users').get() as { a: number }).a).toBe(1);
    expect((db.prepare('SELECT uploader_id AS u FROM files').get() as { u: string }).u).toBe('u1');
    db.close();
  });
});
