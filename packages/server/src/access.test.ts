import { describe, it, expect } from 'vitest';
import WsClient from 'ws';
import { createTestApp, addUser } from './testUtils';
import { storeFile } from './files';

const pdf = (inhalt: string) => Buffer.from(`%PDF-1.4\n${inhalt}`);

describe('Rechteprüfung pro Schreibtisch', () => {
  it('GET /desks zeigt nur eigene und geteilte Schreibtische mit ownerName/isOwner', async () => {
    const { app, db, authHeaders } = await createTestApp();
    const bob = await addUser(db, 'bob');
    const eigener = (await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'Meiner' } })).json();
    const fremd = (await app.inject({ method: 'POST', url: '/api/v1/desks', headers: bob.authHeaders, payload: { name: 'Bobs' } })).json();
    const geteilt = (await app.inject({ method: 'POST', url: '/api/v1/desks', headers: bob.authHeaders, payload: { name: 'Geteilt' } })).json();
    const me = (await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: authHeaders })).json();
    db.prepare('INSERT INTO desk_members (desk_id, user_id) VALUES (?, ?)').run(geteilt.id, me.id);

    const liste = (await app.inject({ method: 'GET', url: '/api/v1/desks', headers: authHeaders })).json();
    expect(liste.map((d: { id: string }) => d.id).sort()).toEqual([eigener.id, geteilt.id].sort());
    const eintragGeteilt = liste.find((d: { id: string }) => d.id === geteilt.id);
    expect(eintragGeteilt).toMatchObject({ ownerName: 'bob', isOwner: false });
    expect(liste.find((d: { id: string }) => d.id === eigener.id)).toMatchObject({ ownerName: 'test', isOwner: true });
    expect(liste.some((d: { id: string }) => d.id === fremd.id)).toBe(false);
  });

  it('Fremde erhalten 403 auf state/commands/put/rename/delete', async () => {
    const { app, db, authHeaders } = await createTestApp();
    const bob = await addUser(db, 'bob');
    const desk = (await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'D' } })).json();
    const leer = { docs: [], links: [], stacks: [] };
    expect((await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/state`, headers: bob.authHeaders })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: bob.authHeaders, payload: { type: 'bringToFront', payload: { id: 'x' } } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PUT', url: `/api/v1/desks/${desk.id}/state`, headers: bob.authHeaders, payload: leer })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PATCH', url: `/api/v1/desks/${desk.id}`, headers: bob.authHeaders, payload: { name: 'X' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/desks/${desk.id}`, headers: bob.authHeaders })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/v1/desks/gibtsnicht/state', headers: bob.authHeaders })).statusCode).toBe(404);
  });

  it('Mitglied darf lesen und Kommandos senden, aber nicht umbenennen/löschen', async () => {
    const { app, db, authHeaders } = await createTestApp();
    const bob = await addUser(db, 'bob');
    const desk = (await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'D' } })).json();
    db.prepare('INSERT INTO desk_members (desk_id, user_id) VALUES (?, ?)').run(desk.id, bob.userId);
    expect((await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/state`, headers: bob.authHeaders })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: bob.authHeaders, payload: { type: 'bringToFront', payload: { id: 'x' } } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'PATCH', url: `/api/v1/desks/${desk.id}`, headers: bob.authHeaders, payload: { name: 'X' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/desks/${desk.id}`, headers: bob.authHeaders })).statusCode).toBe(403);
  });

  it('GET /auth/me liefert Identität und Admin-Flag', async () => {
    const { app, db, authHeaders } = await createTestApp();
    const bob = await addUser(db, 'bob');
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: authHeaders })).json()).toMatchObject({ username: 'test', isAdmin: true });
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: bob.authHeaders })).json()).toMatchObject({ username: 'bob', isAdmin: false });
  });
});

describe('Datei-Zugriff', () => {
  it('Uploader ja, Desk-Mitglied ja, Fremder 403', async () => {
    const { app, db, dataDir, authHeaders } = await createTestApp();
    const bob = await addUser(db, 'bob');
    const carol = await addUser(db, 'carol');
    const me = (await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: authHeaders })).json();
    const meta = storeFile(db, dataDir, pdf('eins'), 'a.pdf', me.id);
    const desk = (await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'D' } })).json();
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'addDoc', payload: { fileId: meta.id, name: 'a.pdf', position: { x: 0, y: 0 }, id: 'doc-1' } },
    });
    db.prepare('INSERT INTO desk_members (desk_id, user_id) VALUES (?, ?)').run(desk.id, bob.userId);

    expect((await app.inject({ method: 'GET', url: `/api/v1/files/${meta.id}`, headers: authHeaders })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/v1/files/${meta.id}`, headers: bob.authHeaders })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/v1/files/${meta.id}`, headers: carol.authHeaders })).statusCode).toBe(403);
  });

  it('Dedup-Upload überschreibt den Uploader nicht', async () => {
    const { app, db, dataDir, authHeaders } = await createTestApp();
    const bob = await addUser(db, 'bob');
    const me = (await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: authHeaders })).json();
    const a = storeFile(db, dataDir, pdf('gleich'), 'a.pdf', me.id);
    const b = storeFile(db, dataDir, pdf('gleich'), 'b.pdf', bob.userId);
    expect(b.id).toBe(a.id);
    expect((db.prepare('SELECT uploader_id AS u FROM files WHERE id = ?').get(a.id) as { u: string }).u).toBe(me.id);
  });

  it('addDoc mit fileId ohne Leserecht → 400, auch im eigenen Desk', async () => {
    const { app, db, dataDir, authHeaders } = await createTestApp();
    const carol = await addUser(db, 'carol');
    const me = (await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: authHeaders })).json();
    const meta = storeFile(db, dataDir, pdf('geheim'), 'geheim.pdf', me.id);
    const eigenerDesk = (await app.inject({ method: 'POST', url: '/api/v1/desks', headers: carol.authHeaders, payload: { name: 'Carols' } })).json();

    const res = await app.inject({
      method: 'POST', url: `/api/v1/desks/${eigenerDesk.id}/commands`, headers: carol.authHeaders,
      payload: { type: 'addDoc', payload: { fileId: meta.id, name: 'geheim.pdf', position: { x: 0, y: 0 }, id: 'doc-2' } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'Unbekannte oder nicht zugängliche fileId' });
  });
});

describe('WS-Zugriff', () => {
  it('Fremder wird beim Verbinden mit Code 4003 geschlossen', async () => {
    const { app, db, authHeaders } = await createTestApp();
    const bob = await addUser(db, 'bob');
    await app.listen({ port: 0 });
    const { port } = app.server.address() as { port: number };
    const desk = (await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'D' } })).json();
    const ws = new WsClient(`ws://127.0.0.1:${port}/api/v1/desks/${desk.id}/ws?token=${bob.token}`);
    const code = await new Promise<number>((resolve) => {
      ws.on('close', (c) => resolve(c));
      ws.on('error', () => resolve(-1));
    });
    expect(code).toBe(4003);
    await app.close();
  });
});
