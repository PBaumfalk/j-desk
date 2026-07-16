import Database from 'better-sqlite3';

export type Db = Database.Database;

export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS desks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      owner_id TEXT NOT NULL REFERENCES users(id),
      state TEXT NOT NULL,
      rev INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS desk_members (
      desk_id TEXT NOT NULL REFERENCES desks(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (desk_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      sha256 TEXT NOT NULL UNIQUE,
      original_name TEXT NOT NULL,
      size INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  migrate(db);
  return db;
}

/** Hebt das Schema schrittweise an; user_version markiert den Stand. */
function migrate(db: Db): void {
  const version = db.pragma('user_version', { simple: true }) as number;
  if (version < 1) {
    db.transaction(() => {
      db.exec(`
        ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE files ADD COLUMN uploader_id TEXT REFERENCES users(id) ON DELETE SET NULL;
        CREATE TABLE invites (
          token TEXT PRIMARY KEY,
          created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          desk_id TEXT REFERENCES desks(id) ON DELETE CASCADE,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );
        UPDATE users SET is_admin = 1;
        UPDATE files SET uploader_id = (SELECT id FROM users ORDER BY created_at LIMIT 1);
      `);
      db.pragma('user_version = 1');
    })();
  }
}
