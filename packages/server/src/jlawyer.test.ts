import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  validateLogin, listCases, listDocuments, getDocumentMeta, getDocumentContent, createDocument, JLawyerError,
} from './jlawyer';
import { startFakeJLawyer, type FakeJLawyer } from './testJLawyer';
import { buildApp } from './app';
import { openDb } from './db';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let fake: FakeJLawyer;
beforeAll(async () => { fake = await startFakeJLawyer(); });
afterAll(() => fake.stop());

describe('jlawyer-Adapter', () => {
  it('validateLogin: richtige Zugangsdaten ja, falsche nein', async () => {
    expect(await validateLogin(fake.url, 'anwalt', 'kanzlei123')).toBe(true);
    expect(await validateLogin(fake.url, 'anwalt', 'falsch')).toBe(false);
  });

  it('listCases liefert id, Aktenzeichen, Rubrum und „wegen"', async () => {
    const cases = await listCases(fake.url, 'anwalt', 'kanzlei123');
    expect(cases[0]).toEqual({ id: 'akte-1', fileNumber: '00001/26', name: 'Müller ./. Schmidt', reason: 'Kaufpreisklage' });
    expect(cases).toHaveLength(2);
  });

  it('listDocuments liefert die Dokumentliste einer Akte (changeDate als Millis)', async () => {
    const docs = await listDocuments(fake.url, 'anwalt', 'kanzlei123', 'akte-1');
    expect(docs).toHaveLength(2);
    expect(docs[0]).toEqual({ id: 'jdoc-1', name: 'Klageschrift.pdf', changeDate: 1750000000000, size: expect.any(Number) });
  });

  it('getDocumentMeta liefert caseId und changeDate (Berechtigungsprüfung)', async () => {
    const meta = await getDocumentMeta(fake.url, 'anwalt', 'kanzlei123', 'jdoc-1');
    expect(meta).toMatchObject({ id: 'jdoc-1', caseId: 'akte-1', name: 'Klageschrift.pdf' });
  });

  it('getDocumentContent dekodiert Base64 zu PDF-Bytes', async () => {
    const bytes = await getDocumentContent(fake.url, 'anwalt', 'kanzlei123', 'jdoc-1');
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('createDocument legt ein Dokument an und liefert die neue ID', async () => {
    const { id } = await createDocument(fake.url, 'anwalt', 'kanzlei123', 'akte-2', 'Neu.pdf', Buffer.from('%PDF-1.4 neu'));
    expect(id).toMatch(/^jdoc-/);
    const docs = await listDocuments(fake.url, 'anwalt', 'kanzlei123', 'akte-2');
    expect(docs.some((d) => d.id === id && d.name === 'Neu.pdf')).toBe(true);
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
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/status' })).json()).toEqual({ needsSetup: false, mode: 'jlawyer' });
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
    expect(res.json()[0]).toEqual({ id: 'akte-1', fileNumber: '00001/26', name: 'Müller ./. Schmidt', reason: 'Kaufpreisklage' });
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

  it('auth/status nennt den Modus', async () => {
    const { app } = await jlApp();
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/status' })).json()).toEqual({ needsSetup: false, mode: 'jlawyer' });
    await app.close();
  });

  it('GET /cases/:id/desk legt den Akten-Desk an und synchronisiert Eingangskarten', async () => {
    const { app } = await jlApp();
    const { token } = (
      await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'anwalt', password: 'kanzlei123' } })
    ).json();
    const h = { authorization: `Bearer ${token}` };
    const r1 = await app.inject({ method: 'GET', url: '/api/v1/cases/akte-1/desk', headers: h });
    expect(r1.statusCode).toBe(200);
    const s1 = r1.json();
    expect(s1.state.docs).toHaveLength(2);
    expect(s1.state.docs.map((d: { fileId: string }) => d.fileId).sort()).toEqual(['jdoc-1', 'jdoc-2']);
    // zweiter Abruf: keine Duplikate, rev unverändert (nichts zu tun)
    const r2 = await app.inject({ method: 'GET', url: '/api/v1/cases/akte-1/desk', headers: h });
    expect(r2.json().state.docs).toHaveLength(2);
    expect(r2.json().rev).toBe(s1.rev);
    await app.close();
  });

  it('extern gelöschte Dokumente verlieren ihre Karte beim nächsten Abgleich', async () => {
    const { app } = await jlApp();
    const { token } = (
      await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'anwalt', password: 'kanzlei123' } })
    ).json();
    const h = { authorization: `Bearer ${token}` };
    await app.inject({ method: 'GET', url: '/api/v1/cases/akte-1/desk', headers: h });
    const docs = fake.documents.get('akte-1')!;
    const entfernt = docs.pop()!; // Dokument in j-lawyer „gelöscht"
    const r = await app.inject({ method: 'GET', url: '/api/v1/cases/akte-1/desk', headers: h });
    expect(r.json().state.docs).toHaveLength(1);
    docs.push(entfernt); // Zustand für andere Tests wiederherstellen
    await app.close();
  });

  it('GET /files/:id liefert im j-lawyer-Modus den Dokumentinhalt und cached ihn', async () => {
    const { app } = await jlApp();
    const { token } = (
      await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'anwalt', password: 'kanzlei123' } })
    ).json();
    const h = { authorization: `Bearer ${token}` };
    const r1 = await app.inject({ method: 'GET', url: '/api/v1/files/jdoc-1', headers: h });
    expect(r1.statusCode).toBe(200);
    expect(r1.headers['content-type']).toContain('application/pdf');
    expect(r1.body.startsWith('%PDF-')).toBe(true);
    const contentAbrufe = () => fake.requests.filter((r) => r.includes('/document/jdoc-1/content')).length;
    const vorher = contentAbrufe();
    await app.inject({ method: 'GET', url: '/api/v1/files/jdoc-1', headers: h });
    expect(contentAbrufe()).toBe(vorher); // zweiter Abruf kommt aus dem Platten-Cache
    await app.close();
  });

  it('POST /cases/:id/documents lädt in die Akte hoch und legt die Karte erst nach Bestätigung an', async () => {
    const { app } = await jlApp();
    const { token } = (
      await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'anwalt', password: 'kanzlei123' } })
    ).json();
    const h = { authorization: `Bearer ${token}` };
    const vorher = (await app.inject({ method: 'GET', url: '/api/v1/cases/akte-2/desk', headers: h })).json().state.docs.length;
    const boundary = 'X-TEST-BOUNDARY';
    const pdf = '%PDF-1.4 hochgeladen';
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="Schriftsatz.pdf"',
      'Content-Type: application/pdf',
      '',
      pdf,
      `--${boundary}--`,
      '',
    ].join('\r\n');
    const r = await app.inject({
      method: 'POST', url: '/api/v1/cases/akte-2/documents',
      headers: { ...h, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(r.statusCode).toBe(201);
    const state = r.json().state;
    expect(state.docs).toHaveLength(vorher + 1);
    expect(state.docs.some((d: { name: string }) => d.name === 'Schriftsatz.pdf')).toBe(true);
    // Dokument liegt wirklich in j-lawyer
    expect(fake.documents.get('akte-2')!.some((d) => d.name === 'Schriftsatz.pdf')).toBe(true);
    await app.close();
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
