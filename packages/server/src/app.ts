import { readFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { CommandError, addDoc, removeDoc, trashedFileIds, type Command, type DesktopState } from '@digital-desktop/core';
import type { Db } from './db';
import {
  needsSetup, createUser, login, logout, validateToken, createWsTickets, createFileTickets,
  createSession, ensureExternalUser, AuthError, type FileTickets,
} from './auth';
import {
  validateLogin, listCases, listDocuments, getDocumentMeta, getDocumentContent,
  createDocument, JLawyerError,
} from './jlawyer';
import {
  createDesk, listDesks, renameDesk, deleteDesk, getDeskState, ensureDesk,
  applyDeskCommand, putDeskState, DeskNotFoundError, InvalidStateError,
} from './deskStore';
import { storeFile, getFilePath, fileExists, classify, classifyName, getFileMeta, FileError } from './files';
import { createConverter, ConvertError, previewCachePath, type ConvertConfig } from './convert';
import { register, unregister, broadcast } from './broadcast';

export interface AppOptions {
  db: Db;
  dataDir: string;
  webDir?: string;
  /** Basis-URL der j-lawyer-REST-API (inkl. /j-lawyer-io). Gesetzt = j-lawyer-Login-Modus. */
  jlawyerUrl?: string;
  /** Euro-Office-DocumentServer für die Vorschau-Konvertierung; null/fehlend = deaktiviert. */
  convert?: ConvertConfig | null;
  /** Eigene, vom DocumentServer erreichbare Basis-URL (für /convert-source-Tickets). */
  publicUrl?: string;
}

const PUBLIC_PATHS = new Set(['/api/v1/auth/status', '/api/v1/auth/login', '/api/v1/auth/setup']);
const CONVERT_SOURCE_PREFIX = '/api/v1/convert-source/';

declare module 'fastify' {
  interface FastifyInstance {
    fileTickets: FileTickets;
  }
}

function bearerToken(req: FastifyRequest): string | null {
  // Nur der Authorization-Header — Tokens in Query-Strings landen in Logs und Proxies.
  const header = req.headers.authorization;
  return header?.startsWith('Bearer ') ? header.slice(7) : null;
}

const WS_PATH = /^\/api\/v1\/desks\/[^/]+\/ws$/;

export async function buildApp({ db, dataDir, webDir, jlawyerUrl, convert, publicUrl }: AppOptions): Promise<FastifyInstance> {
  const app = Fastify();
  const wsTickets = createWsTickets();
  const fileTickets = createFileTickets();
  app.decorate('fileTickets', fileTickets);
  // j-lawyer-Modus: Basic-Credentials der Sitzungen leben ausschließlich im RAM
  // (nie persistiert; nach Server-Neustart melden sich alle neu an — Spec-Entscheidung).
  const jlCreds = new Map<string, { username: string; password: string }>();
  const basisUrl = (publicUrl ?? 'http://localhost:4810').replace(/\/+$/, '');
  // j-lawyer-Modus: Zugangsdaten des zuletzt anfordernden Nutzers je Dokument-ID, ausschließlich
  // damit die sourceUrl-Funktion unten (die selbst nur die fileId/docId bekommt) ein
  // Konverter-Ticket mit jl-Payload bauen kann. RAM-only, gleicher Kompromiss wie jlCreds.
  const previewJlCreds = new Map<string, { username: string; password: string }>();
  // Letzter Konvertierungsfehler je cacheKey — wird beim NÄCHSTEN preview-Aufruf als 409
  // ausgeliefert und dabei zurückgesetzt (Retry-Semantik statt dauerhaftem Fehlerzustand).
  const previewErrors = new Map<string, ConvertError>();
  const converter = createConverter({
    config: convert ?? null,
    dataDir,
    sourceUrl: (fileId) => {
      const jl = previewJlCreds.get(fileId);
      const payload = jl ? { fileId, jl: { docId: fileId, ...jl } } : { fileId };
      return `${basisUrl}/api/v1/convert-source/${fileTickets.issue(payload)}`;
    },
  });

  /** Vorschau-Antwort für kind 'convertible': Cache -> Hintergrund-Anstoß (202) -> Fehler-Merker (409) -> disabled (409). */
  async function respondConvertiblePreview(
    reply: FastifyReply,
    cacheKey: string,
    fileIdForConvert: string,
    sourceName: string,
  ) {
    if (!converter.enabled()) {
      return reply.code(409).send({ error: 'Vorschau-Dienst nicht konfiguriert', reason: 'disabled' });
    }
    const priorError = previewErrors.get(cacheKey);
    if (priorError) {
      previewErrors.delete(cacheKey); // nächster Versuch bekommt eine echte Chance
      return reply.code(409).send({ error: priorError.message, reason: priorError.reason });
    }
    const cachePath = previewCachePath(dataDir, cacheKey);
    if (existsSync(cachePath)) {
      reply.header('content-type', 'application/pdf');
      return readFileSync(cachePath);
    }
    void converter.ensurePreview(fileIdForConvert, cacheKey, sourceName).catch((e) => {
      previewErrors.set(cacheKey, e instanceof ConvertError ? e : new ConvertError(String(e), 'failed'));
    });
    reply.code(202);
    return { status: 'converting' };
  }
  await app.register(cors, { origin: true });
  await app.register(multipart, { limits: { fileSize: 100 * 1024 * 1024 } });
  await app.register(websocket);
  if (webDir) {
    // wildcard:true löst Dateien zur ANFRAGEZEIT auf (fehlende rufen callNotFound → SPA-Fallback).
    // wildcard:false globbte die Dateiliste einmalig beim Boot — ein Rebuild bei laufendem
    // Server machte alle neuen Assets zu 404/HTML (UAT-Befund „weißer Bildschirm").
    await app.register(fastifyStatic, { root: webDir, wildcard: true });
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
    // Konverter-Quelle: das Einmal-Ticket in der URL ersetzt die Auth (einmalig + kurzlebig, s. Route unten).
    if (path.startsWith(CONVERT_SOURCE_PREFIX)) return;
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
      // Karten im Papierkorb gelten als vorhanden — sonst käme die Karte beim Abgleich zurück.
      const vorhanden = new Set([...state.docs.map((d) => d.fileId), ...trashedFileIds(state)]);
      let n = state.docs.length;
      for (const d of jlDocs) {
        if (!vorhanden.has(d.id)) {
          // Magic-Bytes gibt's beim Abgleich nicht (Inhalt wird erst bei Bedarf abgerufen) —
          // die Endung reicht hier gut genug (classifyName statt classify).
          state = addDoc(state, d.id, d.name, eingang(n), undefined, classifyName(d.name));
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
        const kind = classify(bytes, part.filename);
        const result = applyDeskCommand(db, caseId, {
          type: 'addDoc',
          payload: { fileId: docId, name: part.filename, position: eingang(anzahl), kind },
        });
        broadcast(caseId, result);
        reply.code(201);
        return result;
      } catch (e) {
        return jlFehler(e, ctx.token, reply);
      }
    });

    /** Lädt (und cacht auf Platte, Schlüssel Dokument-ID + Änderungsdatum) den Dokumentinhalt.
        Wird sowohl von GET /files/:id als auch von der pdf-Fassung der Vorschau-Route genutzt. */
    async function cachedDocBytes(creds: { username: string; password: string }, meta: { id: string; changeDate: number }): Promise<Buffer> {
      const safe = meta.id.replace(/[^a-zA-Z0-9_-]/g, '_');
      const cacheFile = join(cacheDir, `${safe}-${meta.changeDate}.pdf`);
      if (!existsSync(cacheFile)) {
        const bytes = await getDocumentContent(jlBase, creds.username, creds.password, meta.id);
        for (const alt of readdirSync(cacheDir).filter((f) => f.startsWith(`${safe}-`))) {
          rmSync(join(cacheDir, alt), { force: true }); // veraltete Fassungen desselben Dokuments
        }
        writeFileSync(cacheFile, bytes);
      }
      return readFileSync(cacheFile);
    }

    /** Dokumentinhalt unter dem files-Pfad — fileCache/PageRenderer im Client bleiben
        unverändert; fileId ist im j-lawyer-Modus die j-lawyer-Dokument-ID. */
    app.get('/api/v1/files/:id', async (req, reply) => {
      const ctx = credsOder401(req, reply);
      if (!ctx) return;
      const { id } = req.params as { id: string };
      try {
        // Metadatenabruf mit den Sitzungs-Credentials = Berechtigungsprüfung
        const meta = await getDocumentMeta(jlBase, ctx.creds.username, ctx.creds.password, id);
        reply.header('content-type', 'application/pdf');
        return await cachedDocBytes(ctx.creds, meta);
      } catch (e) {
        return jlFehler(e, ctx.token, reply);
      }
    });

    /** Vorschau: gleiche Berechtigungsprüfung wie /files/:id (Metadatenabruf mit Sitzungs-Credentials).
        kind aus dem Dateinamen (classifyName) — Magic-Bytes gibt's ohne Herunterladen nicht. */
    app.get('/api/v1/files/:id/preview', async (req, reply) => {
      const ctx = credsOder401(req, reply);
      if (!ctx) return;
      const { id: docId } = req.params as { id: string };
      try {
        const meta = await getDocumentMeta(jlBase, ctx.creds.username, ctx.creds.password, docId);
        const kind = classifyName(meta.name);
        if (kind === 'image' || kind === 'other') {
          return reply.code(404).send({ error: 'Keine Vorschau für diese Datei-Art' });
        }
        if (kind === 'pdf') {
          reply.header('content-type', 'application/pdf');
          return await cachedDocBytes(ctx.creds, meta);
        }
        // convertible: Ticket-Konverter braucht die Sitzungs-Credentials, um die Quelle
        // (den Akteninhalt) selbst abzurufen — siehe previewJlCreds/sourceUrl oben.
        previewJlCreds.set(docId, ctx.creds);
        const cacheKey = `${docId}-${meta.changeDate}`;
        return await respondConvertiblePreview(reply, cacheKey, docId, meta.name);
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
        return { fileId: meta.id, kind: meta.kind };
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

    /** Vorschau: gleiche (fehlende) Berechtigungsprüfung wie /files/:id — nur der globale Auth-Hook.
        cacheKey = fileId: eigene Ablage ist inhaltsadressiert/unveränderlich, keine Versionierung nötig. */
    app.get('/api/v1/files/:id/preview', async (req, reply) => {
      const { id } = req.params as { id: string };
      const meta = getFileMeta(db, id);
      if (!meta) return reply.code(404).send({ error: 'Datei nicht gefunden' });
      if (meta.kind === 'image' || meta.kind === 'other') {
        return reply.code(404).send({ error: 'Keine Vorschau für diese Datei-Art' });
      }
      if (meta.kind === 'pdf') {
        const path = getFilePath(db, dataDir, id)!;
        reply.header('content-type', 'application/pdf');
        return readFileSync(path);
      }
      return respondConvertiblePreview(reply, id, id, meta.originalName);
    });
  } else {
    app.post('/api/v1/files', async (_req, reply) =>
      reply.code(400).send({ error: 'Uploads erfolgen in die Akte (POST /api/v1/cases/:id/documents)' }));
  }

  // ---- Konverter-Quelle (Einmal-Ticket statt Auth, s. Hook-Ausnahme oben) ----
  app.get('/api/v1/convert-source/:ticket', async (req, reply) => {
    const { ticket } = req.params as { ticket: string };
    const payload = fileTickets.consume(ticket);
    if (!payload) return reply.code(404).send({ error: 'Ticket ungültig oder abgelaufen' });
    // Kein content-type-Rätselraten hier — der DocumentServer sniffed selbst.
    reply.header('content-type', 'application/octet-stream');
    if (payload.jl) {
      // j-lawyer-Modus: die Quelle ist der Akteninhalt, nicht eine lokal abgelegte Datei.
      const { docId, username, password } = payload.jl;
      try {
        return await getDocumentContent(jlawyerUrl!, username, password, docId);
      } catch (e) {
        if (e instanceof JLawyerError) return reply.code(e.status).send({ error: e.message });
        throw e;
      }
    }
    const path = getFilePath(db, dataDir, payload.fileId);
    if (!path) return reply.code(404).send({ error: 'Datei nicht gefunden' });
    return readFileSync(path);
  });

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
