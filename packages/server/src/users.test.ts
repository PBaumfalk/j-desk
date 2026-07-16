import { describe, it, expect } from 'vitest';
import { createTestApp, addUser } from './testUtils';
import { login } from './auth';

describe('Benutzer-Routen', () => {
  it('GET /users listet alle Konten mit isAdmin', async () => {
    const { app, db, authHeaders } = await createTestApp();
    const bob = await addUser(db, 'bob');
    const liste = (await app.inject({ method: 'GET', url: '/api/v1/users', headers: bob.authHeaders })).json();
    expect(liste).toEqual([
      expect.objectContaining({ username: 'test', isAdmin: true }),
      expect.objectContaining({ username: 'bob', isAdmin: false }),
    ]);
  });

  it('POST /users legt Konten an — nur als Admin', async () => {
    const { app, db, authHeaders } = await createTestApp();
    const bob = await addUser(db, 'bob');
    const res = await app.inject({ method: 'POST', url: '/api/v1/users', headers: authHeaders, payload: { username: 'carol', password: 'geheim-genug' } });
    expect(res.statusCode).toBe(201);
    expect(await login(db, 'carol', 'geheim-genug')).toBeTruthy();
    expect((await app.inject({ method: 'POST', url: '/api/v1/users', headers: bob.authHeaders, payload: { username: 'dan', password: 'geheim-genug' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/v1/users', headers: authHeaders, payload: { username: 'bob', password: 'geheim-genug' } })).statusCode).toBe(400);
  });

  it('PATCH /users/:id benennt um; Duplikat 400, unbekannt 404, Nicht-Admin 403', async () => {
    const { app, db, authHeaders } = await createTestApp();
    const bob = await addUser(db, 'bob');
    expect((await app.inject({ method: 'PATCH', url: `/api/v1/users/${bob.userId}`, headers: authHeaders, payload: { username: 'bobby' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: bob.authHeaders })).json().username).toBe('bobby');
    expect((await app.inject({ method: 'PATCH', url: `/api/v1/users/${bob.userId}`, headers: authHeaders, payload: { username: 'test' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: '/api/v1/users/gibtsnicht', headers: authHeaders, payload: { username: 'x' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PATCH', url: `/api/v1/users/${bob.userId}`, headers: bob.authHeaders, payload: { username: 'b2' } })).statusCode).toBe(403);
  });

  it('POST /users/:id/password setzt neu und löscht die Sessions des Betroffenen', async () => {
    const { app, db, authHeaders } = await createTestApp();
    const bob = await addUser(db, 'bob');
    expect((await app.inject({ method: 'POST', url: `/api/v1/users/${bob.userId}/password`, headers: authHeaders, payload: { password: 'nagelneu-8' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: bob.authHeaders })).statusCode).toBe(401);
    expect(await login(db, 'bob', 'nagelneu-8')).toBeTruthy();
    expect((await app.inject({ method: 'POST', url: `/api/v1/users/${bob.userId}/password`, headers: authHeaders, payload: { password: 'kurz' } })).statusCode).toBe(400);
  });

  it('POST /auth/password wechselt das eigene Passwort; falsches altes → 400; Session bleibt', async () => {
    const { app, db } = await createTestApp();
    const bob = await addUser(db, 'bob');
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/password', headers: bob.authHeaders, payload: { oldPassword: 'falsch', newPassword: 'nagelneu-8' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/password', headers: bob.authHeaders, payload: { oldPassword: 'test-passwort', newPassword: 'nagelneu-8' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: bob.authHeaders })).statusCode).toBe(200);
    expect(await login(db, 'bob', 'nagelneu-8')).toBeTruthy();
  });

  it('GET /users/:id/desks liefert die eigenen Schreibtische des Benutzers — nur für Admin', async () => {
    const { app, db, authHeaders } = await createTestApp();
    const bob = await addUser(db, 'bob');
    await app.inject({ method: 'POST', url: '/api/v1/desks', headers: bob.authHeaders, payload: { name: 'Bobs' } });
    const res = await app.inject({ method: 'GET', url: `/api/v1/users/${bob.userId}/desks`, headers: authHeaders });
    expect(res.json()).toEqual([expect.objectContaining({ name: 'Bobs' })]);
    expect((await app.inject({ method: 'GET', url: `/api/v1/users/${bob.userId}/desks`, headers: bob.authHeaders })).statusCode).toBe(403);
  });

  it('DELETE /users/:id löscht Konto samt eigener Desks, Mitgliedschaften und Sessions; uploader wird NULL', async () => {
    const { app, db, dataDir, authHeaders } = await createTestApp();
    const bob = await addUser(db, 'bob');
    const bobsDesk = (await app.inject({ method: 'POST', url: '/api/v1/desks', headers: bob.authHeaders, payload: { name: 'Bobs' } })).json();
    const meinDesk = (await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'Meiner' } })).json();
    db.prepare('INSERT INTO desk_members (desk_id, user_id) VALUES (?, ?)').run(meinDesk.id, bob.userId);
    const { storeFile } = await import('./files');
    const meta = storeFile(db, dataDir, Buffer.from('%PDF-1.4\nbob'), 'b.pdf', bob.userId);

    expect((await app.inject({ method: 'DELETE', url: `/api/v1/users/${bob.userId}`, headers: authHeaders })).statusCode).toBe(200);
    expect(db.prepare('SELECT 1 FROM desks WHERE id = ?').get(bobsDesk.id)).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM desk_members WHERE user_id = ?').get(bob.userId)).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM sessions WHERE user_id = ?').get(bob.userId)).toBeUndefined();
    expect((db.prepare('SELECT uploader_id AS u FROM files WHERE id = ?').get(meta.id) as { u: string | null }).u).toBeNull();
    expect(db.prepare('SELECT 1 FROM desks WHERE id = ?').get(meinDesk.id)).toBeDefined();
  });

  it('DELETE des eigenen Kontos → 400; als Nicht-Admin → 403', async () => {
    const { app, db, authHeaders } = await createTestApp();
    const bob = await addUser(db, 'bob');
    const me = (await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: authHeaders })).json();
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/users/${me.id}`, headers: authHeaders })).statusCode).toBe(400);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/users/${me.id}`, headers: bob.authHeaders })).statusCode).toBe(403);
  });
});
