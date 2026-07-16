import type { FastifyInstance } from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createTestApp } from '../../server/src/testUtils';
import { storeFile } from '../../server/src/files';
import { AnymizeClient, AnymizeError, type HashPair } from './anymize';
import { AnonCache, MappingStore } from './mapping';
import { Anonymizer } from './anonymizer';
import { startHttpServer, type Shared } from './main';
import { loadConfig } from './config';
import { sendCommand, createDesk as apiCreateDesk } from './deskApi';

export interface TestSetup {
  mcpClient: Client;
  token: string;
  mappings: MappingStore;
  createDesk(name: string): Promise<string>;
  addDoc(deskId: string, name: string): Promise<string>;
  anymizeCalls(): number;
  setAnymizeDown(down: boolean): void;
  clientMitToken(token: string): Promise<Client>;
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

export async function startTestSetup(): Promise<TestSetup> {
  const ctx = await createTestApp();
  const app: FastifyInstance = ctx.app;
  await app.listen({ port: 0 });
  const deskUrl = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;

  const config = { ...loadConfig({ ANYMIZE_API_KEY: 'fake' }), deskServerUrl: deskUrl, port: 0 };
  const fake = new FakeAnymize();
  const mappings = new MappingStore();
  const shared: Shared = { anonymizer: new Anonymizer(fake, mappings, new AnonCache()), mappings };
  const httpServer = await startHttpServer(config, shared);
  const mcpUrl = `http://127.0.0.1:${(httpServer.address() as { port: number }).port}/mcp`;

  async function clientMitToken(token: string): Promise<Client> {
    const client = new Client({ name: 'test', version: '0.0.1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }));
    return client;
  }
  const mcpClient = await clientMitToken(ctx.token);

  // addDoc-Gate aus TP3 verlangt eine für den Benutzer LESBARE fileId → Uploader = Test-User
  const meId = (ctx.db.prepare("SELECT id FROM users WHERE username = 'test'").get() as { id: string }).id;

  let docNr = 0;
  return {
    mcpClient,
    token: ctx.token,
    mappings,
    deskUrl,
    async createDesk(name) {
      return (await apiCreateDesk(deskUrl, ctx.token, name)).id;
    },
    async addDoc(deskId, name) {
      const meta = storeFile(ctx.db, ctx.dataDir, Buffer.from(`%PDF-1.4\n${name}`), name, meId);
      const id = `doc-${++docNr}`;
      await sendCommand(deskUrl, ctx.token, deskId, {
        type: 'addDoc',
        payload: { fileId: meta.id, name, position: { x: 0, y: 0 }, id },
      });
      return id;
    },
    anymizeCalls: () => fake.calls,
    setAnymizeDown: (d) => {
      fake.down = d;
    },
    clientMitToken,
    stop: async () => {
      await mcpClient.close().catch(() => {});
      httpServer.close();
      await app.close();
    },
  };
}
