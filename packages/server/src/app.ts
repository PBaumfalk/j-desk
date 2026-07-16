import { readFileSync } from 'node:fs';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import { CommandError, type Command } from '@digital-desktop/core';
import type { Db } from './db';
import { needsSetup, createUser, login, logout, validateToken, AuthError } from './auth';
import {
  createDesk, listDesks, renameDesk, deleteDesk, getDeskState,
  applyDeskCommand, putDeskState, DeskNotFoundError, InvalidStateError,
  listMembers, addMember, removeMember, MemberError,
} from './deskStore';
import { storeFile, getFilePath, fileExists, FileError } from './files';
import { ForbiddenError, requireDeskAccess, requireDeskOwner, requireAdmin, canReadFile, isAdminUser } from './guards';
import { listUsers, renameUser, resetPassword, changeOwnPassword, getUserDesks, deleteUserCascade, UserNotFoundError } from './users';
import { register, unregister, broadcast, closeDesk, closeUserOnDesk, closeUserEverywhere } from './broadcast';
import { createInvite, listInvites, getInvite, revokeInvite, redeemInvite, InviteError } from './invites';

export interface AppOptions {
  db: Db;
  dataDir: string;
}

const PUBLIC_PATHS = new Set(['/api/v1/auth/status', '/api/v1/auth/login', '/api/v1/auth/setup', '/api/v1/auth/redeem']);

function bearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  const query = req.query as { token?: string };
  return query?.token ?? null;
}

function userIdOf(req: FastifyRequest): string {
  return (req as FastifyRequest & { userId: string }).userId;
}

export async function buildApp({ db, dataDir }: AppOptions): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(cors, { origin: true });
  await app.register(multipart, { limits: { fileSize: 100 * 1024 * 1024 } });
  await app.register(websocket);

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ForbiddenError) return reply.code(403).send({ error: err.message });
    if (err instanceof DeskNotFoundError || err instanceof UserNotFoundError) return reply.code(404).send({ error: err.message });
    if (err instanceof AuthError || err instanceof CommandError || err instanceof InvalidStateError || err instanceof FileError || err instanceof MemberError || err instanceof InviteError) {
      return reply.code(400).send({ error: err.message });
    }
    return reply.send(err);
  });

  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0];
    if (path.startsWith('/api/v1/auth/invite/')) return;
    if (PUBLIC_PATHS.has(path)) return;
    const token = bearerToken(req);
    const session = token ? validateToken(db, token) : null;
    if (!session) return reply.code(401).send({ error: 'Nicht angemeldet' });
    (req as FastifyRequest & { userId: string }).userId = session.userId;
  });

  // ---- Auth ----
  app.get('/api/v1/auth/status', async () => ({ needsSetup: needsSetup(db) }));

  app.post('/api/v1/auth/setup', async (req, reply) => {
    if (!needsSetup(db)) return reply.code(403).send({ error: 'Es existiert bereits ein Konto' });
    const { username, password } = (req.body ?? {}) as { username?: string; password?: string };
    try {
      await createUser(db, String(username ?? ''), String(password ?? ''), true);
    } catch (e) {
      if (e instanceof AuthError) return reply.code(400).send({ error: e.message });
      throw e;
    }
    return { token: await login(db, String(username), String(password)) };
  });

  app.post('/api/v1/auth/login', async (req, reply) => {
    const { username, password } = (req.body ?? {}) as { username?: string; password?: string };
    const token = await login(db, String(username ?? ''), String(password ?? ''));
    if (!token) return reply.code(401).send({ error: 'Benutzername oder Passwort falsch' });
    return { token };
  });

  app.post('/api/v1/auth/logout', async (req) => {
    const token = bearerToken(req);
    if (token) logout(db, token);
    return { ok: true };
  });

  app.get('/api/v1/auth/me', async (req) => {
    const row = db.prepare('SELECT id, username, is_admin AS isAdmin FROM users WHERE id = ?').get(userIdOf(req)) as
      { id: string; username: string; isAdmin: number };
    return { id: row.id, username: row.username, isAdmin: row.isAdmin === 1 };
  });

  app.post('/api/v1/auth/password', async (req) => {
    const { oldPassword, newPassword } = (req.body ?? {}) as { oldPassword?: string; newPassword?: string };
    await changeOwnPassword(db, userIdOf(req), String(oldPassword ?? ''), String(newPassword ?? ''));
    return { ok: true };
  });

  // ---- Einladungen ----
  app.post('/api/v1/invites', async (req, reply) => {
    const userId = userIdOf(req);
    const { deskId } = (req.body ?? {}) as { deskId?: string };
    if (deskId) requireDeskOwner(db, deskId, userId);
    else requireAdmin(db, userId);
    reply.code(201);
    return createInvite(db, userId, deskId ?? null);
  });

  app.get('/api/v1/invites', async (req) => {
    const userId = userIdOf(req);
    return listInvites(db, userId, isAdminUser(db, userId));
  });

  app.delete('/api/v1/invites/:token', async (req) => {
    const userId = userIdOf(req);
    const { token } = req.params as { token: string };
    revokeInvite(db, token, userId, isAdminUser(db, userId));
    return { ok: true };
  });

  app.get('/api/v1/auth/invite/:token', async (req, reply) => {
    const { token } = req.params as { token: string };
    const invite = getInvite(db, token);
    if (!invite) return reply.code(404).send({ error: 'Einladung ist ungültig oder abgelaufen' });
    return { deskName: invite.deskName };
  });

  app.post('/api/v1/auth/redeem', async (req) => {
    const { token, username, password } = (req.body ?? {}) as { token?: string; username?: string; password?: string };
    return { token: await redeemInvite(db, String(token ?? ''), String(username ?? ''), String(password ?? '')) };
  });

  // ---- Benutzer ----
  app.get('/api/v1/users', async () => listUsers(db));

  app.post('/api/v1/users', async (req, reply) => {
    requireAdmin(db, userIdOf(req));
    const { username, password } = (req.body ?? {}) as { username?: string; password?: string };
    const id = await createUser(db, String(username ?? ''), String(password ?? ''));
    reply.code(201);
    return { id, username: String(username).trim(), isAdmin: false };
  });

  app.patch('/api/v1/users/:id', async (req) => {
    requireAdmin(db, userIdOf(req));
    const { id } = req.params as { id: string };
    const { username } = (req.body ?? {}) as { username?: string };
    renameUser(db, id, String(username ?? ''));
    return { ok: true };
  });

  app.post('/api/v1/users/:id/password', async (req) => {
    requireAdmin(db, userIdOf(req));
    const { id } = req.params as { id: string };
    const { password } = (req.body ?? {}) as { password?: string };
    await resetPassword(db, id, String(password ?? ''));
    return { ok: true };
  });

  app.get('/api/v1/users/:id/desks', async (req) => {
    requireAdmin(db, userIdOf(req));
    const { id } = req.params as { id: string };
    return getUserDesks(db, id);
  });

  app.delete('/api/v1/users/:id', async (req) => {
    requireAdmin(db, userIdOf(req));
    const { id } = req.params as { id: string };
    if (id === userIdOf(req)) throw new AuthError('Eigenes Konto kann nicht gelöscht werden');
    const eigeneDesks = deleteUserCascade(db, id);
    for (const deskId of eigeneDesks) closeDesk(deskId);
    closeUserEverywhere(id);
    return { ok: true };
  });

  // ---- Schreibtische ----
  app.get('/api/v1/desks', async (req) => listDesks(db, userIdOf(req)));

  app.post('/api/v1/desks', async (req, reply) => {
    const { name } = (req.body ?? {}) as { name?: string };
    if (typeof name !== 'string' || name.trim() === '') {
      return reply.code(400).send({ error: 'Feld "name" fehlt oder ist leer' });
    }
    reply.code(201);
    return createDesk(db, userIdOf(req), name.trim());
  });

  app.patch('/api/v1/desks/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    requireDeskOwner(db, id, userIdOf(req));
    const { name } = (req.body ?? {}) as { name?: string };
    if (typeof name !== 'string' || name.trim() === '') {
      return reply.code(400).send({ error: 'Feld "name" fehlt oder ist leer' });
    }
    renameDesk(db, id, name.trim());
    return { ok: true };
  });

  app.delete('/api/v1/desks/:id', async (req) => {
    const { id } = req.params as { id: string };
    requireDeskOwner(db, id, userIdOf(req));
    deleteDesk(db, id);
    closeDesk(id);
    return { ok: true };
  });

  app.get('/api/v1/desks/:id/state', async (req, reply) => {
    const { id } = req.params as { id: string };
    requireDeskAccess(db, id, userIdOf(req));
    const result = getDeskState(db, id);
    if (!result) return reply.code(404).send({ error: 'Schreibtisch nicht gefunden' });
    return result;
  });

  app.post('/api/v1/desks/:id/commands', async (req, reply) => {
    const { id } = req.params as { id: string };
    requireDeskAccess(db, id, userIdOf(req));
    const cmd = (req.body ?? {}) as Command;
    if (cmd.type === 'addDoc' && !fileExists(db, String((cmd.payload as { fileId?: unknown })?.fileId ?? ''))) {
      return reply.code(400).send({ error: 'Unbekannte fileId' });
    }
    const result = applyDeskCommand(db, id, cmd);
    broadcast(id, result);
    return result;
  });

  app.put('/api/v1/desks/:id/state', async (req) => {
    const { id } = req.params as { id: string };
    requireDeskAccess(db, id, userIdOf(req));
    const result = putDeskState(db, id, req.body);
    broadcast(id, result);
    return result;
  });

  // ---- Mitglieder ----
  app.get('/api/v1/desks/:id/members', async (req) => {
    const { id } = req.params as { id: string };
    requireDeskAccess(db, id, userIdOf(req));
    return listMembers(db, id);
  });

  app.post('/api/v1/desks/:id/members', async (req, reply) => {
    const { id } = req.params as { id: string };
    requireDeskOwner(db, id, userIdOf(req));
    const { username } = (req.body ?? {}) as { username?: string };
    const member = addMember(db, id, String(username ?? ''));
    reply.code(201);
    return member;
  });

  app.delete('/api/v1/desks/:id/members/:userId', async (req) => {
    const { id, userId } = req.params as { id: string; userId: string };
    if (userId !== userIdOf(req)) requireDeskOwner(db, id, userIdOf(req));
    else requireDeskAccess(db, id, userIdOf(req));
    removeMember(db, id, userId);
    closeUserOnDesk(id, userId);
    return { ok: true };
  });

  // ---- Dateien ----
  app.post('/api/v1/files', async (req, reply) => {
    const part = await req.file();
    if (!part) return reply.code(400).send({ error: 'Keine Datei im Request' });
    const bytes = await part.toBuffer();
    const meta = storeFile(db, dataDir, bytes, part.filename, userIdOf(req));
    reply.code(201);
    return { fileId: meta.id, name: meta.originalName };
  });

  app.get('/api/v1/files/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const path = getFilePath(db, dataDir, id);
    if (!path) return reply.code(404).send({ error: 'Datei nicht gefunden' });
    if (!canReadFile(db, userIdOf(req), id)) return reply.code(403).send({ error: 'Kein Zugriff auf diese Datei' });
    reply.header('content-type', 'application/pdf');
    return readFileSync(path);
  });

  // ---- WebSocket ----
  app.get('/api/v1/desks/:id/ws', { websocket: true }, (socket, req) => {
    const { id } = req.params as { id: string };
    try {
      requireDeskAccess(db, id, userIdOf(req));
    } catch (e) {
      socket.close(e instanceof ForbiddenError ? 4003 : 4001, e instanceof ForbiddenError ? 'access-revoked' : 'desk-deleted');
      return;
    }
    register(id, socket, userIdOf(req));
    socket.on('close', () => unregister(id, socket));
  });

  return app;
}
