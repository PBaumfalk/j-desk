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
  userId: string;
  token: string;
  authHeaders: { authorization: string };
}

export async function createTestApp(): Promise<TestContext> {
  const db = openDb(':memory:');
  const dataDir = mkdtempSync(join(tmpdir(), 'dd-server-'));
  const userId = await createUser(db, 'test', 'test-passwort');
  const token = (await login(db, 'test', 'test-passwort'))!;
  const app = await buildApp({ db, dataDir });
  return { app, db, dataDir, userId, token, authHeaders: { authorization: `Bearer ${token}` } };
}

/** Weiteres Konto samt Session-Token + userId (z. B. für Mehrbenutzer-Tests des MCP/der Rollen). */
export async function addUser(db: Db, username: string): Promise<{ userId: string; token: string }> {
  const userId = await createUser(db, username, 'test-passwort');
  const token = (await login(db, username, 'test-passwort'))!;
  return { userId, token };
}

export interface EinNutzer {
  userId: string;
  token: string;
  authHeaders: { authorization: string };
}

export interface ZweiNutzerContext {
  app: FastifyInstance;
  db: Db;
  dataDir: string;
  a: EinNutzer;
  b: EinNutzer;
}

/**
 * Zwei unabhängige Konten gegen dieselbe App/DB — Fundament für Rollen-/Zugriffstests
 * (PERM-03/PERM-04/PERM-05, 02-04): Nutzer A legt üblicherweise den Desk an (wird automatisch
 * Eigentümer, s. createDesk), Nutzer B hat KEINE Rolle, bis eine Rolle explizit vergeben wird —
 * genau das Szenario, das der Netzwerk-Trace-Test (02-06) auf Basis dieses Harness braucht.
 */
export async function createTestAppMitZweiNutzern(): Promise<ZweiNutzerContext> {
  const db = openDb(':memory:');
  const dataDir = mkdtempSync(join(tmpdir(), 'dd-server-'));
  const aUserId = await createUser(db, 'nutzer-a', 'test-passwort');
  const aToken = (await login(db, 'nutzer-a', 'test-passwort'))!;
  const bUserId = await createUser(db, 'nutzer-b', 'test-passwort');
  const bToken = (await login(db, 'nutzer-b', 'test-passwort'))!;
  const app = await buildApp({ db, dataDir });
  return {
    app, db, dataDir,
    a: { userId: aUserId, token: aToken, authHeaders: { authorization: `Bearer ${aToken}` } },
    b: { userId: bUserId, token: bToken, authHeaders: { authorization: `Bearer ${bToken}` } },
  };
}
