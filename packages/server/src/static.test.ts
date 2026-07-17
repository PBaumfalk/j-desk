import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { openDb, type Db } from './db';
import { buildApp } from './app';

describe('statische Auslieferung der Web-App', () => {
  let dir: string;
  let db: Db;
  let app: FastifyInstance;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'dd-static-'));
    const webDir = join(dir, 'web');
    mkdirSync(webDir);
    writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>DD</title>');
    db = openDb(join(dir, 'test.sqlite'));
    app = await buildApp({ db, dataDir: dir, webDir });
  });

  afterEach(async () => {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('liefert index.html unter / ohne Anmeldung', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<title>DD</title>');
  });

  it('liefert index.html als SPA-Fallback für unbekannte Pfade', async () => {
    const res = await app.inject({ method: 'GET', url: '/irgendwas/tiefes' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<title>DD</title>');
  });

  it('schützt /api/ weiterhin: ohne Token 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/desks' });
    expect(res.statusCode).toBe(401);
  });

  it('liefert für unbekannte /api/-Pfade 404 statt index.html', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/gibtsnicht', headers: {} });
    expect([401, 404]).toContain(res.statusCode); // Auth-Hook greift vor dem Routing
  });

  it('funktioniert ohne webDir wie bisher (kein Fallback)', async () => {
    const bare = await buildApp({ db, dataDir: dir });
    const res = await bare.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(404);
    await bare.close();
  });
});
