import { describe, it, expect } from 'vitest';
import { createTestApp } from './testUtils';

const pdf = Buffer.from('%PDF-1.4\ninhalt');

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
