import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { openDb, type Db } from './db';
import { createUser, login } from './auth';
import { buildApp } from './app';

/**
 * Reserviert einen freien Port und gibt ihn sofort wieder frei — für Tests, die die
 * `publicUrl` (Konverter-Rückweg) schon VOR `app.listen()` kennen müssen, weil sie
 * damit `buildApp` aufrufen (im Gegensatz zu `port: 0`, dessen Port erst nach dem
 * Listen bekannt ist). Kleines, in Tests übliches Race-Risiko (Port könnte zwischen
 * Freigabe und Wiederverwendung belegt werden) — für diese Testsuite akzeptiert.
 */
export function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

export interface TestContext {
  app: FastifyInstance;
  db: Db;
  dataDir: string;
  token: string;
  authHeaders: { authorization: string };
}

export async function createTestApp(): Promise<TestContext> {
  const db = openDb(':memory:');
  const dataDir = mkdtempSync(join(tmpdir(), 'dd-server-'));
  await createUser(db, 'test', 'test-passwort');
  const token = (await login(db, 'test', 'test-passwort'))!;
  const app = await buildApp({ db, dataDir });
  return { app, db, dataDir, token, authHeaders: { authorization: `Bearer ${token}` } };
}

/** Weiteres Konto samt Session-Token (z. B. für Mehrbenutzer-Tests des MCP). */
export async function addUser(db: Db, username: string): Promise<{ token: string }> {
  await createUser(db, username, 'test-passwort');
  return { token: (await login(db, username, 'test-passwort'))! };
}
