import { describe, it, expect } from 'vitest';
import { createTestApp, addUser } from './testUtils';

async function deskMit(app: Awaited<ReturnType<typeof createTestApp>>['app'], headers: { authorization: string }, name = 'D') {
  return (await app.inject({ method: 'POST', url: '/api/v1/desks', headers, payload: { name } })).json() as { id: string };
}

describe('Mitglieder', () => {
  it('Besitzer fügt hinzu, alle Beteiligten sehen die Liste, Besitzer entfernt', async () => {
    const { app, db, authHeaders } = await createTestApp();
    const bob = await addUser(db, 'bob');
    const desk = await deskMit(app, authHeaders);
    const res = await app.inject({ method: 'POST', url: `/api/v1/desks/${desk.id}/members`, headers: authHeaders, payload: { username: 'bob' } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ username: 'bob' });
    expect((await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/members`, headers: bob.authHeaders })).json()).toEqual([
      expect.objectContaining({ username: 'bob' }),
    ]);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/desks/${desk.id}/members/${bob.userId}`, headers: authHeaders })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/state`, headers: bob.authHeaders })).statusCode).toBe(403);
  });

  it('addMember validiert: unbekannt, Besitzer, Duplikat → 400', async () => {
    const { app, db, authHeaders } = await createTestApp();
    await addUser(db, 'bob');
    const desk = await deskMit(app, authHeaders);
    expect((await app.inject({ method: 'POST', url: `/api/v1/desks/${desk.id}/members`, headers: authHeaders, payload: { username: 'niemand' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `/api/v1/desks/${desk.id}/members`, headers: authHeaders, payload: { username: 'test' } })).statusCode).toBe(400);
    await app.inject({ method: 'POST', url: `/api/v1/desks/${desk.id}/members`, headers: authHeaders, payload: { username: 'bob' } });
    expect((await app.inject({ method: 'POST', url: `/api/v1/desks/${desk.id}/members`, headers: authHeaders, payload: { username: 'bob' } })).statusCode).toBe(400);
  });

  it('nur der Besitzer fügt hinzu; Mitglieder und Fremde nicht', async () => {
    const { app, db, authHeaders } = await createTestApp();
    const bob = await addUser(db, 'bob');
    const carol = await addUser(db, 'carol');
    const desk = await deskMit(app, authHeaders);
    db.prepare('INSERT INTO desk_members (desk_id, user_id) VALUES (?, ?)').run(desk.id, bob.userId);
    expect((await app.inject({ method: 'POST', url: `/api/v1/desks/${desk.id}/members`, headers: bob.authHeaders, payload: { username: 'carol' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/api/v1/desks/${desk.id}/members`, headers: carol.authHeaders, payload: { username: 'carol' } })).statusCode).toBe(403);
  });

  it('Mitglied darf sich selbst entfernen (verlassen), aber keinen anderen', async () => {
    const { app, db, authHeaders } = await createTestApp();
    const bob = await addUser(db, 'bob');
    const carol = await addUser(db, 'carol');
    const desk = await deskMit(app, authHeaders);
    db.prepare('INSERT INTO desk_members (desk_id, user_id) VALUES (?, ?)').run(desk.id, bob.userId);
    db.prepare('INSERT INTO desk_members (desk_id, user_id) VALUES (?, ?)').run(desk.id, carol.userId);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/desks/${desk.id}/members/${carol.userId}`, headers: bob.authHeaders })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/desks/${desk.id}/members/${bob.userId}`, headers: bob.authHeaders })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/state`, headers: bob.authHeaders })).statusCode).toBe(403);
  });

  it('Fremde sehen die Mitgliederliste nicht; Entfernen eines Nicht-Mitglieds → 400', async () => {
    const { app, db, authHeaders } = await createTestApp();
    const bob = await addUser(db, 'bob');
    const desk = await deskMit(app, authHeaders);
    expect((await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/members`, headers: bob.authHeaders })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/desks/${desk.id}/members/${bob.userId}`, headers: authHeaders })).statusCode).toBe(400);
  });
});
