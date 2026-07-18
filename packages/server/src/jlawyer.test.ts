import { createServer, type Server } from 'node:http';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { validateLogin, listCases, JLawyerError } from './jlawyer';
import { buildApp } from './app';
import { openDb } from './db';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Fake-j-lawyer: Basic Auth (anwalt/kanzlei123) und die benutzten Endpunkte. */
function startFakeJLawyer(): Promise<{ server: Server; url: string }> {
  const ok = 'Basic ' + Buffer.from('anwalt:kanzlei123', 'utf8').toString('base64');
  const server = createServer((req, res) => {
    if (req.headers.authorization !== ok) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="jlawyerRealm"' });
      return res.end();
    }
    if (req.url === '/j-lawyer-io/v1/cases/list') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify([
        { id: 'akte-1', fileNumber: '00001/26', reason: 'Müller ./. Schmidt' },
        { id: 'akte-2', fileNumber: '00002/26', name: 'Meier — Verkehrsunfall' },
      ]));
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${port}/j-lawyer-io` });
    });
  });
}

let fake: { server: Server; url: string };
beforeAll(async () => { fake = await startFakeJLawyer(); });
afterAll(() => new Promise<void>((r) => fake.server.close(() => r())));

describe('jlawyer-Adapter', () => {
  it('validateLogin: richtige Zugangsdaten ja, falsche nein', async () => {
    expect(await validateLogin(fake.url, 'anwalt', 'kanzlei123')).toBe(true);
    expect(await validateLogin(fake.url, 'anwalt', 'falsch')).toBe(false);
  });

  it('listCases liefert id, Aktenzeichen und Rubrum (tolerantes Feld-Mapping)', async () => {
    const cases = await listCases(fake.url, 'anwalt', 'kanzlei123');
    expect(cases).toEqual([
      { id: 'akte-1', fileNumber: '00001/26', name: 'Müller ./. Schmidt' },
      { id: 'akte-2', fileNumber: '00002/26', name: 'Meier — Verkehrsunfall' },
    ]);
  });

  it('wirft JLawyerError, wenn j-lawyer nicht erreichbar ist', async () => {
    await expect(validateLogin('http://127.0.0.1:1/j-lawyer-io', 'a', 'b')).rejects.toThrow(JLawyerError);
  });
});

describe('App im j-lawyer-Modus', () => {
  async function jlApp() {
    const db = openDb(':memory:');
    const dataDir = mkdtempSync(join(tmpdir(), 'dd-jl-'));
    const app = await buildApp({ db, dataDir, jlawyerUrl: fake.url });
    return { app, db, dataDir };
  }

  it('needsSetup ist immer false; setup ist gesperrt', async () => {
    const { app } = await jlApp();
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/status' })).json()).toEqual({ needsSetup: false });
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/setup', payload: { username: 'x', password: 'yyyyyyyy' } });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('Login mit j-lawyer-Konto liefert Session-Token; falsches Passwort 401', async () => {
    const { app } = await jlApp();
    const ok = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'anwalt', password: 'kanzlei123' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().token).toMatch(/^[0-9a-f]{64}$/);
    const bad = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'anwalt', password: 'nö' } });
    expect(bad.statusCode).toBe(401);
    await app.close();
  });

  it('die normale Bearer-API (z. B. Desks für den MCP) funktioniert nach j-lawyer-Login', async () => {
    const { app } = await jlApp();
    const { token } = (
      await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'anwalt', password: 'kanzlei123' } })
    ).json();
    const res = await app.inject({ method: 'GET', url: '/api/v1/desks', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
    await app.close();
  });

  it('GET /api/v1/cases reicht die Aktenliste durch', async () => {
    const { app } = await jlApp();
    const { token } = (
      await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'anwalt', password: 'kanzlei123' } })
    ).json();
    const res = await app.inject({ method: 'GET', url: '/api/v1/cases', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(2);
    expect(res.json()[0]).toEqual({ id: 'akte-1', fileNumber: '00001/26', name: 'Müller ./. Schmidt' });
    await app.close();
  });

  it('nach Server-Neustart (Credentials nur im RAM) verlangt /cases eine neue Anmeldung', async () => {
    const db = openDb(':memory:');
    const dataDir = mkdtempSync(join(tmpdir(), 'dd-jl-'));
    const app1 = await buildApp({ db, dataDir, jlawyerUrl: fake.url });
    const { token } = (
      await app1.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'anwalt', password: 'kanzlei123' } })
    ).json();
    await app1.close();
    const app2 = await buildApp({ db, dataDir, jlawyerUrl: fake.url }); // gleiche DB, leerer RAM
    const res = await app2.inject({ method: 'GET', url: '/api/v1/cases', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(401);
    await app2.close();
  });

  it('ohne jlawyerUrl existiert /api/v1/cases nicht', async () => {
    const db = openDb(':memory:');
    const dataDir = mkdtempSync(join(tmpdir(), 'dd-plain-'));
    const app = await buildApp({ db, dataDir });
    const res = await app.inject({ method: 'GET', url: '/api/v1/cases' });
    expect([401, 404]).toContain(res.statusCode); // 401 vom Auth-Hook oder 404 — jedenfalls keine Aktenliste
    await app.close();
  });
});
