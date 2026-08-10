import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openDb } from '../../server/src/db';
import { createUser, login } from '../../server/src/auth';
import { buildApp } from '../../server/src/app';
import { reservePort, addUser } from '../../server/src/testUtils';
import { storeFile } from '../../server/src/files';
import { getDeskState, putDeskState } from '../../server/src/deskStore';
import { startFakeConvertServer, type FakeConvertServer } from '../../server/src/testConvertServer';
import { AnymizeClient, AnymizeError, type HashPair } from './anymize';
import { MappingStore } from './mapping';
import { createShared, startHttpServer } from './main';
import { loadConfig } from './config';
import { sendCommand, createDesk as apiCreateDesk } from './deskApi';

export interface TestSetup {
  mcpClient: Client;
  token: string;
  mappings: MappingStore;
  createDesk(name: string): Promise<string>;
  /**
   * bytes optional: Default ist eine Mini-PDF (kind 'pdf'); für andere Datei-Arten Bytes/Namen
   * passend wählen. convertOpts (nur relevant für kind 'convertible'): steuert den Fake-
   * DocumentServer für diese Datei (z. B. { pollsUntilDone: 1 } für einen echten 202->200-Rundlauf).
   */
  addDoc(
    deskId: string,
    name: string,
    bytes?: Buffer,
    convertOpts?: { pollsUntilDone?: number; errorCode?: string; errorWithoutEndConvert?: boolean },
  ): Promise<string>;
  anymizeCalls(): number;
  setAnymizeDown(down: boolean): void;
  /** Test-only: schreibt Zusatzfelder direkt in den Doc-Zustand (z. B. sourceGone/sourceReplacedAt
   *  aus dem j-lawyer-Abgleich) — ohne den vollen jlawyer-Sync-Stack aufzuziehen. */
  patchDoc(deskId: string, docId: string, patch: Record<string, unknown>): Promise<void>;
  clientMitToken(token: string): Promise<Client>;
  /** Legt einen zweiten Benutzer an (für Mandantengrenz-Tests) und liefert Token + userId. */
  zweitBenutzer(): Promise<{ token: string; userId: string }>;
  /** Test-only (02-04): weist einem Nutzer direkt eine Rolle an einem Desk zu — die REST-Guards
   *  aus 02-04 verlangen jetzt für JEDEN Lesezugriff (auch über MCP, das dieselben REST-Routen
   *  nutzt) eine desk_roles-Zeile; ohne diese Zuweisung bekäme ein zweiter Nutzer 403 statt der
   *  erwarteten (anonymisierten) Antwort. */
  gewaehreRolle(deskId: string, userId: string, rolle: string): void;
  /** Test-only (02-09): materialisiert die private Ebenen-Instanz des Standard-Testnutzers
   *  (Owner von `createDesk`) über den echten Command-Weg — addNote + changeLayerId auf die
   *  Platzhalter-id 'privat' (denselben Weg nimmt die UI) — und liefert die deterministische
   *  Ebenen-Id `privat-<userId>`, die die Aufrufer-Fixtures erwarten. Fundament für den
   *  MCP-Projektionstest (mcp-projektion.test.ts). */
  setzePrivateEbene(deskId: string): Promise<string>;
  /** Test-only (12-05): legt file_pages-Zeilen für das Dokument direkt an — dieselbe Datenform
   *  wie im echten Extraktionslauf, ohne OCR (Muster aus server/proposals.test.ts legeSeitenAn).
   *  Die Quellen-Verifikation (quelleServer) und die file-text-Route lesen den Seitentext aus
   *  der DB; die propose-Suite braucht namenstragende Klartext-Fixtures. */
  legeSeitenAnFuerDoc(deskId: string, docId: string, seiten: { page: number; pdfText?: string; ocrText?: string }[]): void;
  stop(): Promise<void>;
  deskUrl: string;
}

/** Fake-anymize: ersetzt "Max Mustermann" deterministisch, zählt Aufrufe, abschaltbar. */
class FakeAnymize extends AnymizeClient {
  calls = 0;
  down = false;
  constructor() {
    super({ apiUrl: 'http://fake', apiKey: 'fake' });
  }
  private anon(text: string): { text: string; pairs: HashPair[] } {
    this.calls += 1;
    if (this.down) throw new AnymizeError('Anonymisierung nicht verfügbar — anymize ist nicht erreichbar', 'unavailable');
    const pairs: HashPair[] = text.includes('Max Mustermann')
      ? [{ original: 'Max Mustermann', placeholder: '[[Person-TEST1]]' }]
      : [];
    return { text: text.replaceAll('Max Mustermann', '[[Person-TEST1]]'), pairs };
  }
  override anonymizeText(text: string) {
    return Promise.resolve(this.anon(text));
  }
  override anonymizeFile(bytes: Uint8Array) {
    return Promise.resolve(this.anon(`PDF-Inhalt von Max Mustermann (${bytes.length} Bytes)`));
  }
}

export async function startTestSetup(opts?: { allowDeanonymize?: boolean }): Promise<TestSetup> {
  // Konverter (Fake-DocumentServer) von Anfang an mit konfiguriert — Task 9 braucht einen
  // echten 202->200-Rundlauf über /files/:id/preview für kind 'convertible'. publicUrl muss
  // VOR buildApp feststehen (Ticket-Rückweg), daher reservePort statt port:0 (s. server/testUtils).
  const fakeConvert: FakeConvertServer = await startFakeConvertServer();
  const port = await reservePort();
  const deskUrl = `http://127.0.0.1:${port}`;
  const db = openDb(':memory:');
  const dataDir = mkdtempSync(join(tmpdir(), 'dd-mcp-'));
  await createUser(db, 'test', 'test-passwort');
  const token = (await login(db, 'test', 'test-passwort'))!;
  const app: FastifyInstance = await buildApp({
    db, dataDir, publicUrl: deskUrl,
    convert: { url: fakeConvert.url, jwtSecret: fakeConvert.secret },
  });
  await app.listen({ port });

  const config = { ...loadConfig({ ANYMIZE_API_KEY: 'fake' }), deskServerUrl: deskUrl, port: 0, allowDeanonymize: opts?.allowDeanonymize ?? true };
  const fake = new FakeAnymize();
  const shared = createShared(fake);
  const httpServer = await startHttpServer(config, shared);
  const mcpUrl = `http://127.0.0.1:${(httpServer.address() as { port: number }).port}/mcp`;

  async function clientMitToken(clientToken: string): Promise<Client> {
    const client = new Client({ name: 'test', version: '0.0.1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers: { authorization: `Bearer ${clientToken}` } },
    }));
    return client;
  }
  const mcpClient = await clientMitToken(token);
  const mappings = shared.getSession(token).mappings;

  // addDoc-Gate aus TP3 verlangt eine für den Benutzer LESBARE fileId → Uploader = Test-User
  const meId = (db.prepare("SELECT id FROM users WHERE username = 'test'").get() as { id: string }).id;

  let docNr = 0;
  let zweitNr = 0;
  return {
    mcpClient,
    token,
    mappings,
    deskUrl,
    async createDesk(name) {
      return (await apiCreateDesk(deskUrl, token, name)).id;
    },
    async addDoc(deskId, name, bytes, convertOpts) {
      const meta = storeFile(db, dataDir, bytes ?? Buffer.from(`%PDF-1.4\n${name}`), name, meId);
      if (convertOpts) fakeConvert.configure(meta.id, convertOpts); // cacheKey = fileId (Standalone-Modus)
      const id = `doc-${++docNr}`;
      await sendCommand(deskUrl, token, deskId, {
        type: 'addDoc',
        payload: { fileId: meta.id, name, position: { x: 0, y: 0 }, id, kind: meta.kind },
      });
      return id;
    },
    anymizeCalls: () => fake.calls,
    setAnymizeDown: (d) => {
      fake.down = d;
    },
    async patchDoc(deskId, docId, patch) {
      const current = getDeskState(db, deskId);
      if (!current) throw new Error('Schreibtisch nicht gefunden (patchDoc)');
      const docs = current.state.docs.map((d) => (d.id === docId ? { ...d, ...patch } : d));
      putDeskState(db, deskId, { ...current.state, docs });
    },
    clientMitToken,
    async zweitBenutzer() {
      const u = await addUser(db, `zweitbenutzer-${++zweitNr}`);
      return { token: u.token, userId: u.userId };
    },
    gewaehreRolle(deskId, userId, rolle) {
      db.prepare(
        'INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?) '
        + 'ON CONFLICT (desk_id, user_id) DO UPDATE SET rolle = excluded.rolle',
      ).run(deskId, userId, rolle);
    },
    async setzePrivateEbene(deskId) {
      // 02-09: die Instanz entsteht produktiv über den Command-Weg (Platzhalter 'privat' wird
      // serverseitig auf die Pro-Nutzer-Instanz des Auslösers aufgelöst) — kein Direkt-State-
      // Zugriff mehr. Das zurückgegebene id-Schema bleibt deterministisch `privat-<userId>`.
      const notizId = `n-privat-anlage-${deskId}`;
      await sendCommand(deskUrl, token, deskId, {
        type: 'addNote',
        payload: { id: notizId, kind: 'notiz', text: 'Anlage der privaten Ebene', position: { x: 0, y: 0 } },
      });
      await sendCommand(deskUrl, token, deskId, {
        type: 'changeLayerId',
        payload: { objectId: notizId, layerId: 'privat' },
      });
      return `privat-${meId}`;
    },
    legeSeitenAnFuerDoc(deskId, docId, seiten) {
      const current = getDeskState(db, deskId);
      const doc = current?.state.docs.find((d) => d.id === docId);
      if (!doc) throw new Error('Dokument nicht gefunden (legeSeitenAnFuerDoc)');
      db.prepare('DELETE FROM file_pages WHERE file_id = ?').run(doc.fileId);
      for (const s of seiten) {
        db.prepare(
          'INSERT INTO file_pages (file_id, page, pdf_text, ocr_text, ocr_confidence) VALUES (?, ?, ?, ?, NULL)',
        ).run(doc.fileId, s.page, s.pdfText ?? null, s.ocrText ?? null);
      }
    },
    stop: async () => {
      await mcpClient.close().catch(() => {});
      httpServer.close();
      await app.close();
      await fakeConvert.stop();
    },
  };
}
