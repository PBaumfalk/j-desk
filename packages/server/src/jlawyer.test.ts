import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  validateLogin, listCases, listDocuments, getDocumentMeta, getDocumentContent, createDocument, JLawyerError,
} from './jlawyer';
import { startFakeJLawyer, type FakeJLawyer } from './testJLawyer';
import { startFakeConvertServer, type FakeConvertServer } from './testConvertServer';
import { buildApp } from './app';
import { openDb } from './db';
import { reservePort } from './testUtils';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

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

  it('Abgleich legt für Dokumente im Papierkorb keine neue Karte an', async () => {
    const { app } = await jlApp();
    // eigene Akte mit genau einem Dokument, unabhängig von den anderen Tests
    fake.documents.set('akte-korb', [
      { id: 'jdoc-korb', caseId: 'akte-korb', name: 'Einzel.pdf', changeDate: 1750000200000, size: 10, bytes: Buffer.from('%PDF-x') },
    ]);
    const { token } = (
      await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'anwalt', password: 'kanzlei123' } })
    ).json();
    const h = { authorization: `Bearer ${token}` };
    // 1. Akte öffnen -> Karte für das j-lawyer-Dokument entsteht
    const r1 = await app.inject({ method: 'GET', url: '/api/v1/cases/akte-korb/desk', headers: h });
    const karte = r1.json().state.docs[0];
    // 2. Karte in den Papierkorb legen
    const trashRes = await app.inject({
      method: 'POST', url: '/api/v1/desks/akte-korb/commands', headers: h,
      payload: { type: 'trashObject', payload: { id: karte.id, trashedAt: '2026-07-18T12:00:00.000Z' } },
    });
    expect(trashRes.statusCode).toBe(200);
    // 3. Akte erneut öffnen -> Abgleich läuft, aber es entsteht KEINE neue Karte
    const r2 = await app.inject({ method: 'GET', url: '/api/v1/cases/akte-korb/desk', headers: h });
    expect(r2.json().state.docs).toHaveLength(0);
    expect(r2.json().state.trash).toHaveLength(1);
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
    expect(state.docs.find((d: { name: string }) => d.name === 'Schriftsatz.pdf').kind).toBe('pdf');
    // Dokument liegt wirklich in j-lawyer
    expect(fake.documents.get('akte-2')!.some((d) => d.name === 'Schriftsatz.pdf')).toBe(true);
    await app.close();
  });

  it('extern gelöschtes Dokument in einem gehefteten 2er-Konvolut: Abgleich enthäftet statt mit 500 zu scheitern', async () => {
    const { app } = await jlApp();
    // eigene Akte mit genau zwei Dokumenten, unabhängig von den anderen Tests
    fake.documents.set('akte-deadlock', [
      { id: 'jdoc-dl-1', caseId: 'akte-deadlock', name: 'Erste.pdf', changeDate: 1750000300000, size: 10, bytes: Buffer.from('%PDF-a') },
      { id: 'jdoc-dl-2', caseId: 'akte-deadlock', name: 'Zweite.pdf', changeDate: 1750000400000, size: 10, bytes: Buffer.from('%PDF-b') },
    ]);
    const { token } = (
      await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'anwalt', password: 'kanzlei123' } })
    ).json();
    const h = { authorization: `Bearer ${token}` };
    // 1. Akte öffnen -> zwei Karten entstehen
    const r1 = await app.inject({ method: 'GET', url: '/api/v1/cases/akte-deadlock/desk', headers: h });
    const [karte1, karte2] = r1.json().state.docs;
    // 2. zu einem Stapel zusammenführen und heften (Konvolut)
    const stackRes = await app.inject({
      method: 'POST', url: '/api/v1/desks/akte-deadlock/commands', headers: h,
      payload: { type: 'stackDocs', payload: { draggedId: karte2.id, targetId: karte1.id, id: 'st-deadlock' } },
    });
    expect(stackRes.statusCode).toBe(200);
    const stapelRes = await app.inject({
      method: 'POST', url: '/api/v1/desks/akte-deadlock/commands', headers: h,
      payload: { type: 'stapleStack', payload: { stackId: 'st-deadlock' } },
    });
    expect(stapelRes.statusCode).toBe(200);
    expect(stapelRes.json().state.stacks[0]).toMatchObject({ id: 'st-deadlock', stapled: true });
    // 3. eines der beiden Dokumente extern (in j-lawyer) löschen
    const docs = fake.documents.get('akte-deadlock')!;
    docs.pop();
    // 4. Akte erneut öffnen -> Abgleich entfernt die Karte; das Konvolut wird vorher automatisch enthäftet
    //    statt dass dissolveStack am gehefteten Rest-Stapel wirft (server 500 -> Akte dauerhaft unöffnbar)
    const r2 = await app.inject({ method: 'GET', url: '/api/v1/cases/akte-deadlock/desk', headers: h });
    expect(r2.statusCode).toBe(200);
    expect(r2.json().state.docs).toHaveLength(1);
    expect(r2.json().state.stacks).toHaveLength(0);
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

  it('Abgleich setzt kind aus dem Dateinamen (odt->convertible, jpg->image)', async () => {
    const { app } = await jlApp();
    fake.documents.set('akte-kind', [
      { id: 'jdoc-kind-odt', caseId: 'akte-kind', name: 'Bericht.odt', changeDate: 1750000500000, size: 5, bytes: Buffer.from('odt-inhalt') },
      { id: 'jdoc-kind-jpg', caseId: 'akte-kind', name: 'Foto.jpg', changeDate: 1750000600000, size: 5, bytes: Buffer.from([0xff, 0xd8, 0xff]) },
    ]);
    const { token } = (
      await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'anwalt', password: 'kanzlei123' } })
    ).json();
    const h = { authorization: `Bearer ${token}` };
    const r = await app.inject({ method: 'GET', url: '/api/v1/cases/akte-kind/desk', headers: h });
    const docs = r.json().state.docs as { fileId: string; kind: string }[];
    expect(docs.find((d) => d.fileId === 'jdoc-kind-odt')?.kind).toBe('convertible');
    expect(docs.find((d) => d.fileId === 'jdoc-kind-jpg')?.kind).toBe('image');
    await app.close();
  });

  it('Vorschau: kind pdf liefert Inhalt wie /files/:id, kind image 404', async () => {
    const { app } = await jlApp();
    const { token } = (
      await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'anwalt', password: 'kanzlei123' } })
    ).json();
    const h = { authorization: `Bearer ${token}` };

    let res = await app.inject({ method: 'GET', url: '/api/v1/files/jdoc-1/preview', headers: h });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.body.startsWith('%PDF-')).toBe(true);

    fake.documents.set('akte-img', [
      { id: 'jdoc-img-1', caseId: 'akte-img', name: 'Foto.jpg', changeDate: 1750000700000, size: 5, bytes: Buffer.from([0xff, 0xd8, 0xff]) },
    ]);
    res = await app.inject({ method: 'GET', url: '/api/v1/files/jdoc-img-1/preview', headers: h });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Keine Vorschau für diese Datei-Art' });
    await app.close();
  });

  it('Vorschau: kind convertible ohne Konverter -> 409 disabled', async () => {
    const { app } = await jlApp();
    fake.documents.set('akte-conv-disabled', [
      { id: 'jdoc-cd-1', caseId: 'akte-conv-disabled', name: 'Bericht.odt', changeDate: 1750000750000, size: 5, bytes: Buffer.from('odt-inhalt') },
    ]);
    const { token } = (
      await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'anwalt', password: 'kanzlei123' } })
    ).json();
    const h = { authorization: `Bearer ${token}` };
    const res = await app.inject({ method: 'GET', url: '/api/v1/files/jdoc-cd-1/preview', headers: h });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'Vorschau-Dienst nicht konfiguriert', reason: 'disabled' });
    await app.close();
  });

  it('Vorschau: kind convertible -> 202 -> Poll -> 200, konvertiert über Fake-DS mit jl-Ticket', async () => {
    let convertServer: FakeConvertServer | undefined;
    try {
      convertServer = await startFakeConvertServer();
      const port = await reservePort();
      const publicUrl = `http://127.0.0.1:${port}`;
      const db = openDb(':memory:');
      const dataDir = mkdtempSync(join(tmpdir(), 'dd-jl-conv-'));
      const app = await buildApp({
        db, dataDir, jlawyerUrl: fake.url,
        convert: { url: convertServer.url, jwtSecret: convertServer.secret },
        publicUrl,
      });
      await app.listen({ port });

      fake.documents.set('akte-conv', [
        { id: 'jdoc-conv-1', caseId: 'akte-conv', name: 'Bericht.odt', changeDate: 1750000800000, size: 9, bytes: Buffer.from('odt-inhalt') },
      ]);
      const cacheKey = 'jdoc-conv-1-1750000800000';
      convertServer.configure(cacheKey, { pollsUntilDone: 1 });

      const { token } = (
        await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'anwalt', password: 'kanzlei123' } })
      ).json();
      const h = { authorization: `Bearer ${token}` };
      const url = '/api/v1/files/jdoc-conv-1/preview';

      let res = await app.inject({ method: 'GET', url, headers: h });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ status: 'converting' });

      let tries = 0;
      while (tries++ < 100 && res.statusCode !== 200) {
        await sleep(20);
        res = await app.inject({ method: 'GET', url, headers: h });
        expect([202, 200]).toContain(res.statusCode);
      }
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('application/pdf');
      expect(res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
      // die Quelle wurde über ein Konverter-Ticket abgerufen (Fake-DS -> convert-source -> Fake-j-lawyer)
      expect(convertServer.fetchedSourceUrls.some((u) => u.includes('/convert-source/'))).toBe(true);

      await app.close();
    } finally {
      await convertServer?.stop();
    }
  });
});
