import { describe, it, expect } from 'vitest';
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
