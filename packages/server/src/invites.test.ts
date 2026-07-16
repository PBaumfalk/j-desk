import { describe, it, expect } from 'vitest';
import { createTestApp, addUser } from './testUtils';

describe('Einladungen', () => {
  it('Admin erstellt Konto-Einladung; Normalnutzer 403', async () => {
    const { app, db, authHeaders } = await createTestApp();
    const bob = await addUser(db, 'bob');
    const res = await app.inject({ method: 'POST', url: '/api/v1/invites', headers: authHeaders, payload: {} });
    expect(res.statusCode).toBe(201);
    expect(res.json().token).toHaveLength(64);
    expect((await app.inject({ method: 'POST', url: '/api/v1/invites', headers: bob.authHeaders, payload: {} })).statusCode).toBe(403);
  });

  it('Desk-Einladung nur durch den Besitzer', async () => {
    const { app, db, authHeaders } = await createTestApp();
    const bob = await addUser(db, 'bob');
    const desk = (await app.inject({ method: 'POST', url: '/api/v1/desks', headers: bob.authHeaders, payload: { name: 'Bobs' } })).json();
    expect((await app.inject({ method: 'POST', url: '/api/v1/invites', headers: bob.authHeaders, payload: { deskId: desk.id } })).statusCode).toBe(201);
    // selbst der Admin darf nicht für fremde Desks einladen
    expect((await app.inject({ method: 'POST', url: '/api/v1/invites', headers: authHeaders, payload: { deskId: desk.id } })).statusCode).toBe(403);
  });

  it('GET /auth/invite/:token ist öffentlich und liefert deskName; unbekannt → 404', async () => {
    const { app, db, authHeaders } = await createTestApp();
    const bob = await addUser(db, 'bob');
    const desk = (await app.inject({ method: 'POST', url: '/api/v1/desks', headers: bob.authHeaders, payload: { name: 'Projekt X' } })).json();
    const inv = (await app.inject({ method: 'POST', url: '/api/v1/invites', headers: bob.authHeaders, payload: { deskId: desk.id } })).json();
    const res = await app.inject({ method: 'GET', url: `/api/v1/auth/invite/${inv.token}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deskName: 'Projekt X' });
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/invite/unbekannt' })).statusCode).toBe(404);
  });

  it('redeem legt Konto samt Mitgliedschaft an, liefert Session-Token, Einladung verbraucht', async () => {
    const { app, db, authHeaders } = await createTestApp();
    const bob = await addUser(db, 'bob');
    const desk = (await app.inject({ method: 'POST', url: '/api/v1/desks', headers: bob.authHeaders, payload: { name: 'Bobs' } })).json();
    const inv = (await app.inject({ method: 'POST', url: '/api/v1/invites', headers: bob.authHeaders, payload: { deskId: desk.id } })).json();

    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/redeem', payload: { token: inv.token, username: 'carol', password: 'geheim-genug' } });
    expect(res.statusCode).toBe(200);
    const session = res.json().token as string;
    expect((await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/state`, headers: { authorization: `Bearer ${session}` } })).statusCode).toBe(200);
    // verbraucht:
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/redeem', payload: { token: inv.token, username: 'dan', password: 'geheim-genug' } })).statusCode).toBe(400);
  });

  it('redeem mit vergebenem Benutzernamen → 400, Einladung bleibt einlösbar', async () => {
    const { app, authHeaders } = await createTestApp();
    const inv = (await app.inject({ method: 'POST', url: '/api/v1/invites', headers: authHeaders, payload: {} })).json();
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/redeem', payload: { token: inv.token, username: 'test', password: 'geheim-genug' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/redeem', payload: { token: inv.token, username: 'neu', password: 'geheim-genug' } })).statusCode).toBe(200);
  });

  it('abgelaufene Einladung: invite 404, redeem 400, nicht in der Liste', async () => {
    const { app, db, authHeaders } = await createTestApp();
    const me = (await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: authHeaders })).json();
    db.prepare('INSERT INTO invites (token, created_by, desk_id, created_at, expires_at) VALUES (?, ?, NULL, 0, 1)').run('alt-token', me.id);
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/invite/alt-token' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/redeem', payload: { token: 'alt-token', username: 'x', password: 'geheim-genug' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/v1/invites', headers: authHeaders })).json()).toEqual([]);
  });

  it('GET /invites zeigt eigene (Admin: alle) mit deskName; Widerruf durch Ersteller oder Admin', async () => {
    const { app, db, authHeaders } = await createTestApp();
    const bob = await addUser(db, 'bob');
    const carol = await addUser(db, 'carol');
    const desk = (await app.inject({ method: 'POST', url: '/api/v1/desks', headers: bob.authHeaders, payload: { name: 'Bobs' } })).json();
    const inv = (await app.inject({ method: 'POST', url: '/api/v1/invites', headers: bob.authHeaders, payload: { deskId: desk.id } })).json();

    expect((await app.inject({ method: 'GET', url: '/api/v1/invites', headers: bob.authHeaders })).json()).toEqual([
      expect.objectContaining({ token: inv.token, deskName: 'Bobs' }),
    ]);
    expect((await app.inject({ method: 'GET', url: '/api/v1/invites', headers: authHeaders })).json()).toHaveLength(1); // Admin sieht alle
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/invites/${inv.token}`, headers: carol.authHeaders })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/invites/${inv.token}`, headers: authHeaders })).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/invites/${inv.token}`, headers: bob.authHeaders })).statusCode).toBe(400);
  });

  it('Desk-Löschung lässt zugehörige Einladungen verfallen (CASCADE)', async () => {
    const { app, db, authHeaders } = await createTestApp();
    const desk = (await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'D' } })).json();
    const inv = (await app.inject({ method: 'POST', url: '/api/v1/invites', headers: authHeaders, payload: { deskId: desk.id } })).json();
    await app.inject({ method: 'DELETE', url: `/api/v1/desks/${desk.id}`, headers: authHeaders });
    expect((await app.inject({ method: 'GET', url: `/api/v1/auth/invite/${inv.token}` })).statusCode).toBe(404);
  });
});
