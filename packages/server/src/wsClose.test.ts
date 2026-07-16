import { describe, it, expect } from 'vitest';
import WsClient from 'ws';
import { createTestApp, addUser } from './testUtils';

async function verbinde(port: number, deskId: string, token: string): Promise<{ ws: WsClient; closed: Promise<number> }> {
  const ws = new WsClient(`ws://127.0.0.1:${port}/api/v1/desks/${deskId}/ws?token=${token}`);
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
  return { ws, closed };
}

describe('WS-Close-Codes', () => {
  it('DELETE eines Desks schließt alle Sockets mit 4001', async () => {
    const { app, db, token, authHeaders } = await createTestApp();
    const bob = await addUser(db, 'bob');
    await app.listen({ port: 0 });
    const { port } = app.server.address() as { port: number };
    const desk = (await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'D' } })).json();
    db.prepare('INSERT INTO desk_members (desk_id, user_id) VALUES (?, ?)').run(desk.id, bob.userId);
    const a = await verbinde(port, desk.id, token);
    const b = await verbinde(port, desk.id, bob.token);

    await app.inject({ method: 'DELETE', url: `/api/v1/desks/${desk.id}`, headers: authHeaders });
    expect(await a.closed).toBe(4001);
    expect(await b.closed).toBe(4001);
    await app.close();
  });

  it('Mitglied entfernen schließt nur dessen Socket mit 4003', async () => {
    const { app, db, token, authHeaders } = await createTestApp();
    const bob = await addUser(db, 'bob');
    await app.listen({ port: 0 });
    const { port } = app.server.address() as { port: number };
    const desk = (await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'D' } })).json();
    db.prepare('INSERT INTO desk_members (desk_id, user_id) VALUES (?, ?)').run(desk.id, bob.userId);
    const besitzer = await verbinde(port, desk.id, token);
    const mitglied = await verbinde(port, desk.id, bob.token);

    await app.inject({ method: 'DELETE', url: `/api/v1/desks/${desk.id}/members/${bob.userId}`, headers: authHeaders });
    expect(await mitglied.closed).toBe(4003);

    // Besitzer-Socket lebt weiter und empfängt Broadcasts
    const nachricht = new Promise<boolean>((resolve) => besitzer.ws.on('message', () => resolve(true)));
    await app.inject({ method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders, payload: { type: 'bringToFront', payload: { id: 'x' } } });
    expect(await nachricht).toBe(true);
    besitzer.ws.close();
    await app.close();
  });

  it('Konto-Löschung: eigene Desks 4001 für Mitglieder, eigene Sockets 4003', async () => {
    const { app, db, token, authHeaders } = await createTestApp();
    const bob = await addUser(db, 'bob');
    await app.listen({ port: 0 });
    const { port } = app.server.address() as { port: number };
    const me = (await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: authHeaders })).json();
    const bobsDesk = (await app.inject({ method: 'POST', url: '/api/v1/desks', headers: bob.authHeaders, payload: { name: 'Bobs' } })).json();
    const meinDesk = (await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'Meiner' } })).json();
    db.prepare('INSERT INTO desk_members (desk_id, user_id) VALUES (?, ?)').run(bobsDesk.id, me.id);
    db.prepare('INSERT INTO desk_members (desk_id, user_id) VALUES (?, ?)').run(meinDesk.id, bob.userId);
    const adminAufBobs = await verbinde(port, bobsDesk.id, token);
    const bobAufMeinem = await verbinde(port, meinDesk.id, bob.token);

    await app.inject({ method: 'DELETE', url: `/api/v1/users/${bob.userId}`, headers: authHeaders });
    expect(await adminAufBobs.closed).toBe(4001); // Bobs Desk wurde mitgelöscht
    expect(await bobAufMeinem.closed).toBe(4003); // Bobs Mitgliedschaft/Konto ist weg
    await app.close();
  });
});
