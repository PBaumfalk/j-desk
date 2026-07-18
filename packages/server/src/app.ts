import { readFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { CommandError, addDoc, removeDoc, type Command, type DesktopState } from '@digital-desktop/core';
import type { Db } from './db';
import {
  needsSetup, createUser, login, logout, validateToken, createWsTickets,
  createSession, ensureExternalUser, AuthError,
} from './auth';
import {
  validateLogin, listCases, listDocuments, getDocumentMeta, getDocumentContent,
  createDocument, JLawyerError,
} from './jlawyer';
import {
  createDesk, listDesks, renameDesk, deleteDesk, getDeskState, ensureDesk,
  applyDeskCommand, putDeskState, DeskNotFoundError, InvalidStateError,
} from './deskStore';
import { storeFile, getFilePath, fileExists, FileError } from './files';
import { register, unregister, broadcast } from './broadcast';

export interface AppOptions {
  db: Db;
  dataDir: string;
  webDir?: string;
  /** Basis-URL der j-lawyer-REST-API (inkl. /j-lawyer-io). Gesetzt = j-lawyer-Login-Modus. */
  jlawyerUrl?: string;
}

const PUBLIC_PATHS = new Set(['/api/v1/auth/status', '/api/v1/auth/login', '/api/v1/auth/setup']);

function bearerToken(req: FastifyRequest): string | null {
  // Nur der Authorization-Header — Tokens in Query-Strings landen in Logs und Proxies.
  const header = req.headers.authorization;
  return header?.startsWith('Bearer ') ? header.slice(7) : null;
}

const WS_PATH = /^\/api\/v1\/desks\/[^/]+\/ws$/;

export async function buildApp({ db, dataDir, webDir, jlawyerUrl }: AppOptions): Promise<FastifyInstance> {
  const app = Fastify();
  const wsTickets = createWsTickets();
  // j-lawyer-Modus: Basic-Credentials der Sitzungen leben ausschließlich im RAM
  // (nie persistiert; nach Server-Neustart melden sich alle neu an — Spec-Entscheidung).
  const jlCreds = new Map<string, { username: string; password: string }>();
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
    let path = req.url.split('?')[0];
    try {
      path = decodeURIComponent(path);
    } catch {
      return reply.code(400).send({ error: 'Ungültiger Pfad' });
    }
    if (!path.startsWith('/api/')) return; // statische Auslieferung ist öffentlich
    if (PUBLIC_PATHS.has(path)) return;
    if (WS_PATH.test(path)) {
      // Browser-WebSockets können keine Header setzen — hier gilt ausschließlich das Einmal-Ticket.
      const ticket = (req.query as { ticket?: string })?.ticket;
      const session = ticket ? wsTickets.consume(ticket) : null;
      if (!session) return reply.code(401).send({ error: 'Nicht angemeldet' });
      (req as FastifyRequest & { userId: string }).userId = session.userId;
      return;
    }
    const token = bearerToken(req);
    const session = token ? validateToken(db, token) : null;
    if (!session) return reply.code(401).send({ error: 'Nicht angemeldet' });
    (req as FastifyRequest & { userId: string }).userId = session.userId;
  });

  // ---- Auth ----
  app.get('/api/v1/auth/status', async () => ({
    needsSetup: jlawyerUrl ? false : needsSetup(db),
    mode: jlawyerUrl ? 'jlawyer' : 'standalone',
  }));

  app.post('/api/v1/auth/setup', async (req, reply) => {
    if (jlawyerUrl) return reply.code(403).send({ error: 'Anmeldung erfolgt mit dem j-lawyer-Konto' });
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
    if (jlawyerUrl) {
      const name = String(username ?? '').trim();
      const pass = String(password ?? '');
      let gueltig: boolean;
      try {
        gueltig = name !== '' && (await validateLogin(jlawyerUrl, name, pass));
      } catch (e) {
        if (e instanceof JLawyerError) return reply.code(e.status).send({ error: e.message });
        throw e;
      }
      if (!gueltig) return reply.code(401).send({ error: 'Benutzername oder Passwort falsch' });
      const token = createSession(db, ensureExternalUser(db, name));
      jlCreds.set(token, { username: name, password: pass });
      return { token };
    }
    const token = await login(db, String(username ?? ''), String(password ?? ''));
    if (!token) return reply.code(401).send({ error: 'Benutzername oder Passwort falsch' });
    return { token };
  });

  app.post('/api/v1/auth/logout', async (req) => {
    const token = bearerToken(req);
    if (token) {
      logout(db, token);
      jlCreds.delete(token);
    }
    return { ok: true };
  });

  // ---- j-lawyer (nur im j-lawyer-Modus) ----
  if (jlawyerUrl) {
    const jlBase = jlawyerUrl;
    const cacheDir = join(dataDir, 'jlcache');
    mkdirSync(cacheDir, { recursive: true });

    /** Sitzungs-Credentials oder 401 (Session vor Server-Neustart / in j-lawyer abgelaufen). */
    const credsOder401 = (req: FastifyRequest, reply: Parameters<Parameters<typeof app.get>[1]>[1]) => {
      const token = bearerToken(req)!;
      const creds = jlCreds.get(token);
      if (!creds) {
        logout(db, token);
        void reply.code(401).send({ error: 'Bitte neu anmelden' });
        return null;
      }
      return { token, creds };
    };
    const jlFehler = (e: unknown, token: string, reply: Parameters<Parameters<typeof app.get>[1]>[1]) => {
      if (e instanceof JLawyerError) {
        if (e.status === 401) {
          logout(db, token);
          jlCreds.delete(token);
        }
        return reply.code(e.status).send({ error: e.message });
      }
      throw e;
    };

    /** Position neuer Karten im „Eingang" (links oben, leicht gestaffelt). */
    const eingang = (n: number) => ({ x: 24 + (n % 3) * 36, y: 24 + n * 30 });

    /** Abgleich: j-lawyer ist führend — neue Dokumente bekommen Karten, gelöschte verlieren sie. */
    async function syncCaseDesk(creds: { username: string; password: string }, userId: string, caseId: string) {
      const jlDocs = await listDocuments(jlBase, creds.username, creds.password, caseId);
      ensureDesk(db, caseId, userId, caseId);
      let { state } = getDeskState(db, caseId)!;
      let changed = false;
      const jlIds = new Set(jlDocs.map((d) => d.id));
      for (const doc of [...state.docs]) {
        if (!jlIds.has(doc.fileId)) {
          state = removeDoc(state, doc.id);
          changed = true;
        }
      }
      const vorhanden = new Set(state.docs.map((d) => d.fileId));
      let n = state.docs.length;
      for (const d of jlDocs) {
        if (!vorhanden.has(d.id)) {
          state = addDoc(state, d.id, d.name, eingang(n));
          changed = true;
          n++;
        }
      }
      if (!changed) return getDeskState(db, caseId)!;
      const result = putDeskState(db, caseId, state);
      broadcast(caseId, result);
      return result;
    }

    app.get('/api/v1/cases', async (req, reply) => {
      const ctx = credsOder401(req, reply);
      if (!ctx) return;
      try {
        return await listCases(jlBase, ctx.creds.username, ctx.creds.password);
      } catch (e) {
        return jlFehler(e, ctx.token, reply);
      }
    });

    app.get('/api/v1/cases/:id/desk', async (req, reply) => {
      const ctx = credsOder401(req, reply);
      if (!ctx) return;
      const { id } = req.params as { id: string };
      const userId = (req as FastifyRequest & { userId: string }).userId;
      try {
        return await syncCaseDesk(ctx.creds, userId, id);
      } catch (e) {
        return jlFehler(e, ctx.token, reply);
      }
    });

    app.post('/api/v1/cases/:id/documents', async (req, reply) => {
      const ctx = credsOder401(req, reply);
      if (!ctx) return;
      const { id: caseId } = req.params as { id: string };
      const part = await req.file();
      if (!part) return reply.code(400).send({ error: 'Keine Datei im Request' });
      const bytes = await part.toBuffer();
      try {
        // Erst j-lawyer bestätigen lassen, dann die Karte anlegen (Spec: kein Optimismus).
        const { id: docId } = await createDocument(jlBase, ctx.creds.username, ctx.creds.password, caseId, part.filename, bytes);
        const userId = (req as FastifyRequest & { userId: string }).userId;
        ensureDesk(db, caseId, userId, caseId);
        const anzahl = getDeskState(db, caseId)!.state.docs.length;
        const result = applyDeskCommand(db, caseId, {
          type: 'addDoc',
          payload: { fileId: docId, name: part.filename, position: eingang(anzahl) },
        });
        broadcast(caseId, result);
        reply.code(201);
        return result;
      } catch (e) {
        return jlFehler(e, ctx.token, reply);
      }
    });

    /** Dokumentinhalt unter dem files-Pfad — fileCache/PageRenderer im Client bleiben
        unverändert; fileId ist im j-lawyer-Modus die j-lawyer-Dokument-ID.
        Platten-Cache mit Schlüssel Dokument-ID + Änderungsdatum. */
    app.get('/api/v1/files/:id', async (req, reply) => {
      const ctx = credsOder401(req, reply);
      if (!ctx) return;
      const { id } = req.params as { id: string };
      try {
        // Metadatenabruf mit den Sitzungs-Credentials = Berechtigungsprüfung
        const meta = await getDocumentMeta(jlBase, ctx.creds.username, ctx.creds.password, id);
        const safe = id.replace(/[^a-zA-Z0-9_-]/g, '_');
        const cacheFile = join(cacheDir, `${safe}-${meta.changeDate}.pdf`);
        if (!existsSync(cacheFile)) {
          const bytes = await getDocumentContent(jlBase, ctx.creds.username, ctx.creds.password, id);
          for (const alt of readdirSync(cacheDir).filter((f) => f.startsWith(`${safe}-`))) {
            rmSync(join(cacheDir, alt), { force: true }); // veraltete Fassungen desselben Dokuments
          }
          writeFileSync(cacheFile, bytes);
        }
        reply.header('content-type', 'application/pdf');
        return readFileSync(cacheFile);
      } catch (e) {
        return jlFehler(e, ctx.token, reply);
      }
    });
  }

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

  // ---- Dateien (eigene Ablage nur im Standalone-Modus; im j-lawyer-Modus liefert
  //      /files/:id den Akteninhalt — Route oben — und Uploads gehen in die Akte) ----
  if (!jlawyerUrl) {
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
  } else {
    app.post('/api/v1/files', async (_req, reply) =>
      reply.code(400).send({ error: 'Uploads erfolgen in die Akte (POST /api/v1/cases/:id/documents)' }));
  }

  // ---- WebSocket ----
  app.post('/api/v1/ws-ticket', async (req) => ({
    ticket: wsTickets.issue((req as FastifyRequest & { userId: string }).userId),
  }));

  app.get('/api/v1/desks/:id/ws', { websocket: true }, (socket, req) => {
    const { id } = req.params as { id: string };
    register(id, socket);
    socket.on('close', () => unregister(id, socket));
  });

  return app;
}
