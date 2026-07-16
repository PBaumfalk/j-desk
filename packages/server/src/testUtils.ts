import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { openDb, type Db } from './db';
import { createUser, login } from './auth';
import { buildApp } from './app';

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
  await createUser(db, 'test', 'test-passwort', true);
  const token = (await login(db, 'test', 'test-passwort'))!;
  const app = await buildApp({ db, dataDir });
  return { app, db, dataDir, token, authHeaders: { authorization: `Bearer ${token}` } };
}

/** Legt einen weiteren (Nicht-Admin-)Benutzer an und loggt ihn ein. */
export async function addUser(db: Db, username: string): Promise<{ userId: string; token: string; authHeaders: { authorization: string } }> {
  const userId = await createUser(db, username, 'test-passwort');
  const token = (await login(db, username, 'test-passwort'))!;
  return { userId, token, authHeaders: { authorization: `Bearer ${token}` } };
}
