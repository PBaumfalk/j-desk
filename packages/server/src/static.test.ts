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

  it('erkennt prozent-kodierte /api-Pfade im Auth-Hook (Bypass-Regression): /%61pi/v1/desks ohne Token 401', async () => {
    // "%61" ist das kodierte "a" — Fastifys Router dekodiert den Pfad und matcht ihn auf /api/v1/desks,
    // daher muss der Auth-Hook denselben dekodierten Pfad prüfen, sonst greift der Hook nicht (Bypass).
    const res = await app.inject({ method: 'GET', url: '/%61pi/v1/desks' });
    expect(res.statusCode).toBe(401);
  });

  it('erkennt prozent-kodierte /api-Pfade im Auth-Hook (Bypass-Regression): /%61pi/v1/files/xyz ohne Token 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/%61pi/v1/files/xyz' });
    expect(res.statusCode).toBe(401);
  });

  it('lehnt ungültig kodierte Pfade mit 400 ab', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/%E0%A4%A' });
    expect(res.statusCode).toBe(400);
  });

  it('liefert auch Dateien aus, die erst nach dem Serverstart entstehen (Rebuild bei laufendem Server)', async () => {
    // UAT-Befund „weißer Bildschirm": wildcard:false globbte die Dateiliste einmalig beim
    // Boot — neue Build-Assets bekamen keine Route, der SPA-Fallback lieferte HTML statt JS.
    mkdirSync(join(dir, 'web', '_app'), { recursive: true });
    writeFileSync(join(dir, 'web', '_app', 'neu.js'), 'console.log(1);');
    const res = await app.inject({ method: 'GET', url: '/_app/neu.js' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('javascript');
  });

  it('funktioniert ohne webDir wie bisher (kein Fallback)', async () => {
    const bare = await buildApp({ db, dataDir: dir });
    const res = await bare.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(404);
    await bare.close();
  });
});
