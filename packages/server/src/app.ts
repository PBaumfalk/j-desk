import { readFileSync } from 'node:fs';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { CommandError, type Command } from '@digital-desktop/core';
import type { Db } from './db';
import { needsSetup, createUser, login, logout, validateToken, AuthError } from './auth';
import {
  createDesk, listDesks, renameDesk, deleteDesk, getDeskState,
  applyDeskCommand, putDeskState, DeskNotFoundError, InvalidStateError,
} from './deskStore';
import { storeFile, getFilePath, fileExists, FileError } from './files';
import { register, unregister, broadcast } from './broadcast';

export interface AppOptions {
  db: Db;
  dataDir: string;
  webDir?: string;
}

const PUBLIC_PATHS = new Set(['/api/v1/auth/status', '/api/v1/auth/login', '/api/v1/auth/setup']);

function bearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  const query = req.query as { token?: string };
  return query?.token ?? null;
}

export async function buildApp({ db, dataDir, webDir }: AppOptions): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(cors, { origin: true });
  await app.register(multipart, { limits: { fileSize: 100 * 1024 * 1024 } });
  await app.register(websocket);
  if (webDir) {
    await app.register(fastifyStatic, { root: webDir, wildcard: false });
    // SPA-Fallback: unbekannte GET-Pfade außerhalb der API liefern die App.
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'Nicht gefunden' });
    });
  }

  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0];
    if (!path.startsWith('/api/')) return; // statische Auslieferung ist öffentlich
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
      await createUser(db, String(username ?? ''), String(password ?? ''));
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

  // ---- Schreibtische ----
  app.get('/api/v1/desks', async () => listDesks(db));

  app.post('/api/v1/desks', async (req, reply) => {
    const { name } = (req.body ?? {}) as { name?: string };
    if (typeof name !== 'string' || name.trim() === '') {
      return reply.code(400).send({ error: 'Feld "name" fehlt oder ist leer' });
    }
    const userId = (req as FastifyRequest & { userId: string }).userId;
    reply.code(201);
    return createDesk(db, userId, name.trim());
  });

  app.patch('/api/v1/desks/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { name } = (req.body ?? {}) as { name?: string };
    if (typeof name !== 'string' || name.trim() === '') {
      return reply.code(400).send({ error: 'Feld "name" fehlt oder ist leer' });
    }
    try {
      renameDesk(db, id, name.trim());
    } catch (e) {
      if (e instanceof DeskNotFoundError) return reply.code(404).send({ error: e.message });
      throw e;
    }
    return { ok: true };
  });

  app.delete('/api/v1/desks/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      deleteDesk(db, id);
    } catch (e) {
      if (e instanceof DeskNotFoundError) return reply.code(404).send({ error: e.message });
      throw e;
    }
    return { ok: true };
  });

  app.get('/api/v1/desks/:id/state', async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = getDeskState(db, id);
    if (!result) return reply.code(404).send({ error: 'Schreibtisch nicht gefunden' });
    return result;
  });

  app.post('/api/v1/desks/:id/commands', async (req, reply) => {
    const { id } = req.params as { id: string };
    const cmd = (req.body ?? {}) as Command;
    if (cmd.type === 'addDoc' && !fileExists(db, String((cmd.payload as { fileId?: unknown })?.fileId ?? ''))) {
      return reply.code(400).send({ error: 'Unbekannte fileId' });
    }
    try {
      const result = applyDeskCommand(db, id, cmd);
      broadcast(id, result);
      return result;
    } catch (e) {
      if (e instanceof CommandError) return reply.code(400).send({ error: e.message });
      if (e instanceof DeskNotFoundError) return reply.code(404).send({ error: e.message });
      throw e;
    }
  });

  app.put('/api/v1/desks/:id/state', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const result = putDeskState(db, id, req.body);
      broadcast(id, result);
      return result;
    } catch (e) {
      if (e instanceof InvalidStateError) return reply.code(400).send({ error: e.message });
      if (e instanceof DeskNotFoundError) return reply.code(404).send({ error: e.message });
      throw e;
    }
  });

  // ---- Dateien ----
  app.post('/api/v1/files', async (req, reply) => {
    const part = await req.file();
    if (!part) return reply.code(400).send({ error: 'Keine Datei im Request' });
    const bytes = await part.toBuffer();
    try {
      const meta = storeFile(db, dataDir, bytes, part.filename);
      reply.code(201);
      return { fileId: meta.id, name: meta.originalName };
    } catch (e) {
      if (e instanceof FileError) return reply.code(400).send({ error: e.message });
      throw e;
    }
  });

  app.get('/api/v1/files/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const path = getFilePath(db, dataDir, id);
    if (!path) return reply.code(404).send({ error: 'Datei nicht gefunden' });
    reply.header('content-type', 'application/pdf');
    return readFileSync(path);
  });

  // ---- WebSocket ----
  app.get('/api/v1/desks/:id/ws', { websocket: true }, (socket, req) => {
    const { id } = req.params as { id: string };
    register(id, socket);
    socket.on('close', () => unregister(id, socket));
  });

  return app;
}
