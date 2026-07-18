import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestApp, reservePort } from './testUtils';
import { openDb } from './db';
import { createUser, login } from './auth';
import { buildApp } from './app';
import { storeFile } from './files';
import { startFakeConvertServer, type FakeConvertServer } from './testConvertServer';

const pdf = Buffer.from('%PDF-1.4\ninhalt');

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Baut eine Standalone-App mit echtem HTTP-Listener + konfiguriertem Konverter (für Konverter-Rundläufe). */
async function convertingApp(fake: FakeConvertServer) {
  const port = await reservePort();
  const publicUrl = `http://127.0.0.1:${port}`;
  const db = openDb(':memory:');
  const dataDir = mkdtempSync(join(tmpdir(), 'dd-prev-'));
  await createUser(db, 'test', 'test-passwort');
  const token = (await login(db, 'test', 'test-passwort'))!;
  const app = await buildApp({ db, dataDir, publicUrl, convert: { url: fake.url, jwtSecret: fake.secret } });
  await app.listen({ port });
  return { app, db, dataDir, authHeaders: { authorization: `Bearer ${token}` } };
}

describe('Auth-Routen', () => {
  it('status/setup/login-Ablauf', async () => {
    const { app: freshApp } = await (async () => {
      const { openDb } = await import('./db');
      const { buildApp } = await import('./app');
      const { mkdtempSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      return { app: await buildApp({ db: openDb(':memory:'), dataDir: mkdtempSync(join(tmpdir(), 'dd-')) }) };
    })();

    let res = await freshApp.inject({ method: 'GET', url: '/api/v1/auth/status' });
    expect(res.json()).toEqual({ needsSetup: true, mode: 'standalone' });

    res = await freshApp.inject({
      method: 'POST', url: '/api/v1/auth/setup',
      payload: { username: 'patrick', password: 'geheim-genug' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().token).toMatch(/^[0-9a-f]{64}$/);

    res = await freshApp.inject({
      method: 'POST', url: '/api/v1/auth/setup',
      payload: { username: 'zweiter', password: 'geheim-genug' },
    });
    expect(res.statusCode).toBe(403);

    res = await freshApp.inject({
      method: 'POST', url: '/api/v1/auth/login',
      payload: { username: 'patrick', password: 'falsch-falsch' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('ohne Token: 401 auf geschützten Routen', async () => {
    const { app } = await createTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/desks' });
    expect(res.statusCode).toBe(401);
  });

  it('logout macht das Token ungültig', async () => {
    const { app, authHeaders } = await createTestApp();
    await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: authHeaders });
    const res = await app.inject({ method: 'GET', url: '/api/v1/desks', headers: authHeaders });
    expect(res.statusCode).toBe(401);
  });
});

describe('Desk-Routen', () => {
  it('CRUD und Zustand', async () => {
    const { app, authHeaders } = await createTestApp();
    let res = await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'Projekte' } });
    expect(res.statusCode).toBe(201);
    const desk = res.json();

    res = await app.inject({ method: 'GET', url: '/api/v1/desks', headers: authHeaders });
    expect(res.json()).toHaveLength(1);

    res = await app.inject({ method: 'PATCH', url: `/api/v1/desks/${desk.id}`, headers: authHeaders, payload: { name: 'Neu' } });
    expect(res.statusCode).toBe(200);

    res = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/state`, headers: authHeaders });
    expect(res.json()).toEqual({ rev: 0, state: { docs: [], links: [], stacks: [], strokes: [], notes: [], cutouts: [], marks: [], stamps: [], flags: [], clips: [], trash: [] } });

    res = await app.inject({ method: 'DELETE', url: `/api/v1/desks/${desk.id}`, headers: authHeaders });
    expect(res.statusCode).toBe(200);
    res = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/state`, headers: authHeaders });
    expect(res.statusCode).toBe(404);
  });
});

describe('Kommandos', () => {
  it('führt gültige Kommandos aus, weist ungültige mit 400 ab', async () => {
    const { app, db, dataDir, authHeaders } = await createTestApp();
    const { storeFile } = await import('./files');
    const meta = storeFile(db, dataDir, pdf, 'a.pdf');
    const desk = (await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'D' } })).json();

    let res = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'addDoc', payload: { fileId: meta.id, name: 'a.pdf', position: { x: 1, y: 2 }, id: 'id-a' } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().rev).toBe(1);

    res = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'addDoc', payload: { fileId: 'gibtsnicht', name: 'x.pdf', position: { x: 0, y: 0 } } },
    });
    expect(res.statusCode).toBe(400); // unbekannte fileId

    res = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'kaputt', payload: {} },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('Unbekanntes Kommando');

    res = await app.inject({
      method: 'POST', url: '/api/v1/desks/gibtsnicht/commands', headers: authHeaders,
      payload: { type: 'moveDoc', payload: { id: 'id-a', position: { x: 0, y: 0 } } },
    });
    expect(res.statusCode).toBe(404);
  });

  it('PUT /state ersetzt den Zustand, validiert die Struktur', async () => {
    const { app, authHeaders } = await createTestApp();
    const desk = (await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'D' } })).json();
    let res = await app.inject({
      method: 'PUT', url: `/api/v1/desks/${desk.id}/state`, headers: authHeaders,
      payload: { docs: [], links: [], stacks: [] },
    });
    expect(res.json().rev).toBe(1);
    res = await app.inject({
      method: 'PUT', url: `/api/v1/desks/${desk.id}/state`, headers: authHeaders,
      payload: { docs: 5 },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('Konverter-Ticket-Quelle', () => {
  it('convert-source: Einmal-Ticket liefert Originalbytes genau einmal, ohne Auth-Header', async () => {
    const { app, db, dataDir } = await createTestApp();
    const { storeFile } = await import('./files');
    const meta = storeFile(db, dataDir, pdf, 'a.pdf');
    const ticket = app.fileTickets.issue({ fileId: meta.id });

    const res1 = await app.inject({ method: 'GET', url: `/api/v1/convert-source/${ticket}` });
    expect(res1.statusCode).toBe(200);
    expect(res1.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');

    const res2 = await app.inject({ method: 'GET', url: `/api/v1/convert-source/${ticket}` });
    expect(res2.statusCode).toBe(404); // verbraucht

    const res3 = await app.inject({ method: 'GET', url: '/api/v1/convert-source/quatsch' });
    expect(res3.statusCode).toBe(404);
  });
});

describe('Vorschau-Route (Standalone, ohne Konverter)', () => {
  it('kind pdf: liefert die Originalbytes wie /files/:id', async () => {
    const { app, db, dataDir, authHeaders } = await createTestApp();
    const meta = storeFile(db, dataDir, pdf, 'a.pdf');
    const res = await app.inject({ method: 'GET', url: `/api/v1/files/${meta.id}/preview`, headers: authHeaders });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.rawPayload.equals(pdf)).toBe(true);
  });

  it('kind image/other: 404 mit Meldung', async () => {
    const { app, db, dataDir, authHeaders } = await createTestApp();
    const img = storeFile(db, dataDir, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]), 'foto.jpg');
    const other = storeFile(db, dataDir, Buffer.from('zufaelliger inhalt'), 'irgendwas.exe');
    for (const id of [img.id, other.id]) {
      const res = await app.inject({ method: 'GET', url: `/api/v1/files/${id}/preview`, headers: authHeaders });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Keine Vorschau für diese Datei-Art' });
    }
  });

  it('unbekannte fileId: 404', async () => {
    const { app, authHeaders } = await createTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/files/gibtsnicht/preview', headers: authHeaders });
    expect(res.statusCode).toBe(404);
  });

  it('kind convertible ohne konfigurierten Konverter: 409 disabled', async () => {
    const { app, db, dataDir, authHeaders } = await createTestApp();
    const meta = storeFile(db, dataDir, Buffer.from('bericht-inhalt'), 'Bericht.odt');
    const res = await app.inject({ method: 'GET', url: `/api/v1/files/${meta.id}/preview`, headers: authHeaders });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'Vorschau-Dienst nicht konfiguriert', reason: 'disabled' });
  });

  it('ohne Login: 401', async () => {
    const { app } = await createTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/files/irgendwas/preview' });
    expect(res.statusCode).toBe(401);
  });
});

describe('Vorschau-Route (Standalone, mit Konverter)', () => {
  it('kind convertible: 202 -> Poll -> 200 mit PDF-Bytes, danach aus dem Cache', async () => {
    const fake = await startFakeConvertServer();
    try {
      const { app, db, dataDir, authHeaders } = await convertingApp(fake);
      const meta = storeFile(db, dataDir, Buffer.from('bericht-inhalt'), 'Bericht.odt');
      fake.configure(meta.id, { pollsUntilDone: 1 });
      const url = `/api/v1/files/${meta.id}/preview`;

      let res = await app.inject({ method: 'GET', url, headers: authHeaders });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ status: 'converting' });

      let tries = 0;
      while (tries++ < 100 && res.statusCode !== 200) {
        await sleep(20);
        res = await app.inject({ method: 'GET', url, headers: authHeaders });
        expect([202, 200]).toContain(res.statusCode);
      }
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('application/pdf');
      expect(res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');

      // aus dem Plattencache: kein weiterer DS-Kontakt
      const callsVorher = fake.convertCalls.filter((k) => k === meta.id).length;
      res = await app.inject({ method: 'GET', url, headers: authHeaders });
      expect(res.statusCode).toBe(200);
      expect(fake.convertCalls.filter((k) => k === meta.id).length).toBe(callsVorher);

      await app.close();
    } finally {
      await fake.stop();
    }
  });

  it('DS-Fehler: 409 mit Meldung + reason; nächster Aufruf versucht erneut', async () => {
    const fake = await startFakeConvertServer();
    try {
      const { app, db, dataDir, authHeaders } = await convertingApp(fake);
      const meta = storeFile(db, dataDir, Buffer.from('fehler-inhalt'), 'Fehler.docx');
      fake.configure(meta.id, { errorCode: '-3', errorWithoutEndConvert: true });
      const url = `/api/v1/files/${meta.id}/preview`;

      let res = await app.inject({ method: 'GET', url, headers: authHeaders });
      expect(res.statusCode).toBe(202); // Anstoß

      let tries = 0;
      while (tries++ < 100 && res.statusCode !== 409) {
        await sleep(20);
        res = await app.inject({ method: 'GET', url, headers: authHeaders });
      }
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ reason: 'failed' });
      expect(res.json().error).toContain('-3');

      // Fehler-Merker wurde zurückgesetzt -> nächster Aufruf stößt erneut an
      res = await app.inject({ method: 'GET', url, headers: authHeaders });
      expect(res.statusCode).toBe(202);

      await app.close();
    } finally {
      await fake.stop();
    }
  });
});

describe('Dateien (echter HTTP-Server für multipart)', () => {
  it('Upload, Dedup, Ablehnung und Download', async () => {
    const { app, authHeaders } = await createTestApp();
    await app.listen({ port: 0 });
    const { port } = app.server.address() as { port: number };
    const base = `http://127.0.0.1:${port}/api/v1`;

    const upload = async (bytes: Buffer, name: string) => {
      const fd = new FormData();
      fd.append('file', new Blob([bytes], { type: 'application/pdf' }), name);
      return fetch(`${base}/files`, { method: 'POST', headers: authHeaders, body: fd });
    };

    let res = await upload(pdf, 'a.pdf');
    expect(res.status).toBe(201);
    const { fileId, kind } = (await res.json()) as { fileId: string; kind: string };
    expect(kind).toBe('pdf');

    res = await upload(pdf, 'kopie.pdf');
    expect(((await res.json()) as { fileId: string }).fileId).toBe(fileId); // Dedup

    // kein Endungs-/Magic-Zwang mehr: unbekannter Inhalt wird klassifiziert statt abgelehnt
    res = await upload(Buffer.from('kein pdf'), 'a.pdf');
    expect(res.status).toBe(201);
    expect(((await res.json()) as { kind: string }).kind).toBe('other');

    res = await upload(Buffer.alloc(0), 'leer.pdf');
    expect(res.status).toBe(400); // Größe/Leer-Ablehnung bleibt

    res = await fetch(`${base}/files/${fileId}`, { headers: authHeaders });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(Buffer.from(await res.arrayBuffer()).equals(pdf)).toBe(true);

    res = await fetch(`${base}/files/gibtsnicht`, { headers: authHeaders });
    expect(res.status).toBe(404);

    await app.close();
  });
});
