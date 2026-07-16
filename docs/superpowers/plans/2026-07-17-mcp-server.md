# MCP-Server mit anymize-Anonymisierung (Teilprojekt 4) — Implementierungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Streamable-HTTP-MCP-Server (`packages/mcp`), über den KI-Clients Schreibtische lesen und organisieren — alle Inhalte Richtung KI via anymize.ai anonymisiert, Schreibaktionen serverseitig de-anonymisiert.

**Architecture:** Neues Workspace-Paket mit fünf Modulen: `config` (ENV), `deskApi` (Desk-Server-Client mit Token-Durchreiche), `anymize` (async Job-Client mit injizierbarem fetch), `mapping` (In-Memory-Mapping + Credit-sparende Caches), `server` (MCP-Tools; pro HTTP-Request eine McpServer-Instanz mit dem Bearer-Token im Closure — Caches/Mappings sind prozessweite Singletons). Tests: Integrationstests mit echtem Desk-Server in-memory (`buildApp`), MCP-SDK-Client über HTTP, anymize per Fake-fetch.

**Tech Stack:** TypeScript (ESM, tsx), `@modelcontextprotocol/sdk` + `zod`, `express`, Vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-16-mcp-server-design.md`; anymize-Referenz: `docs/anymize-api.md` — bei Widerspruch gilt die Spec.
- Alle Fehlermeldungen deutsch. MCP-Tool-Fehler als `isError`-Ergebnis mit verständlichem Text, nie rohe Stacktraces.
- **Fail-closed:** anymize down/Fehler → betroffene Tools liefern Fehler („Anonymisierung nicht verfügbar…"), NIE Klartext. Layout-Tools ohne Textbezug funktionieren weiter.
- ENV: `MCP_PORT` (4820), `DESK_SERVER_URL` (`http://localhost:4810`), `ANYMIZE_API_KEY`, `ANYMIZE_API_URL` (`https://app.anymize.ai`), `MCP_ALLOW_DEANONYMIZE` (`true`; `false` versteckt das deanonymize-Tool).
- Platzhalter-Erkennung tolerant für BEIDE dokumentierte Formate: `[[Type-HASH]]` und `[PREFIX-N]`.
- Limits: PDFs > 25 MB ablehnen; extrahierter Text bei 100.000 Zeichen abschneiden (mit Hinweis).
- Kein Löschen von Inhalten, keine Uploads, kein Teilen (Tool-Liste exakt laut Spec).
- Gates: `npm test` alle grün (Sollzahlen je Task; Basis 123 auf Branch `feature/benutzer-teilen`); Arbeitsbranch bleibt `feature/benutzer-teilen`? NEIN — neuer Branch `feature/mcp-server`, abgezweigt vom aktuellen Stand von `feature/benutzer-teilen` (TP3 pending UAT; TP4 baut darauf).
- Jeder Commit endet mit `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- MCP-SDK-Importpfade in diesem Plan entsprechen SDK ^1.x; Task 1 verifiziert sie gegen die installierte SDK-README und passt bei Abweichung an (dokumentiert im Report).

---

### Task 1: Paket-Grundgerüst, Config & Desk-API-Client

**Files:**
- Create: `packages/mcp/package.json`, `packages/mcp/src/config.ts`, `packages/mcp/src/deskApi.ts`, `packages/mcp/src/config.test.ts`, `packages/mcp/src/deskApi.test.ts`
- Modify: `package.json` (Root: Scripts `mcp`, `mcp:token`)

**Interfaces:**
- Produces: `loadConfig(env: Record<string, string | undefined>): McpConfig` mit `McpConfig { port: number; deskServerUrl: string; anymizeApiKey: string; anymizeApiUrl: string; allowDeanonymize: boolean }` (wirft `Error('ANYMIZE_API_KEY fehlt')` wenn leer; Trailing-Slash der URLs wird entfernt).
- Produces: `DeskApiError extends Error { status: number }`; Funktionen (alle nehmen `baseUrl: string, token: string` als erste Argumente): `listDesks → Promise<{id,name,ownerId,ownerName,isOwner}[]>`, `getState(deskId) → Promise<{rev, state: {docs:{id,fileId,name,position,rotation,zIndex}[], links:{id,fromId,toId,note}[], stacks:{id,name,docIds,position,zIndex}[]}}>`, `sendCommand(deskId, cmd: {type: string, payload: unknown}) → Promise<{rev,state}>`, `createDesk(name)`, `renameDesk(deskId, name)`, `getFile(fileId) → Promise<Uint8Array>`.

- [ ] **Step 0: Branch anlegen**

```bash
git checkout feature/benutzer-teilen && git checkout -b feature/mcp-server
```

- [ ] **Step 1: Paket anlegen und Dependencies installieren**

`packages/mcp/package.json`:

```json
{
  "name": "@digital-desktop/mcp",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/main.ts",
    "start": "tsx src/main.ts",
    "token": "tsx src/token.ts"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0",
    "express": "^4.21.0",
    "tsx": "^4.19.0",
    "zod": "^3.25.0"
  },
  "devDependencies": {
    "@types/express": "^4.17.21"
  }
}
```

Root-`package.json`, im `scripts`-Block ergänzen:

```json
    "mcp": "npm run dev -w @digital-desktop/mcp",
    "mcp:token": "npm run token -w @digital-desktop/mcp"
```

Dann `npm install` (Workspace-Link). **SDK-Verifikation:** `node_modules/@modelcontextprotocol/sdk/README.md` lesen und bestätigen, dass es `McpServer` (`.../server/mcp.js`), `StreamableHTTPServerTransport` (`.../server/streamableHttp.js`), `Client` (`.../client/index.js`) und `StreamableHTTPClientTransport` (`.../client/streamableHttp.js`) mit den in Task 4 verwendeten Signaturen gibt. Bei Abweichung: Task-4/5-Code entsprechend anpassen und im Report dokumentieren.

- [ ] **Step 2: Failing Tests schreiben**

`packages/mcp/src/config.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { loadConfig } from './config';

const basis = { ANYMIZE_API_KEY: 'key-123' };

describe('loadConfig', () => {
  it('liefert Defaults und liest ENV', () => {
    expect(loadConfig(basis)).toEqual({
      port: 4820,
      deskServerUrl: 'http://localhost:4810',
      anymizeApiKey: 'key-123',
      anymizeApiUrl: 'https://app.anymize.ai',
      allowDeanonymize: true,
    });
    expect(loadConfig({ ...basis, MCP_PORT: '5000', MCP_ALLOW_DEANONYMIZE: 'false' })).toMatchObject({
      port: 5000,
      allowDeanonymize: false,
    });
  });

  it('entfernt Trailing-Slashes und verlangt den anymize-Key', () => {
    expect(loadConfig({ ...basis, DESK_SERVER_URL: 'http://x:1/', ANYMIZE_API_URL: 'https://y/' }))
      .toMatchObject({ deskServerUrl: 'http://x:1', anymizeApiUrl: 'https://y' });
    expect(() => loadConfig({})).toThrow('ANYMIZE_API_KEY fehlt');
  });
});
```

`packages/mcp/src/deskApi.test.ts` (echter Desk-Server in-memory; Muster aus `packages/server/src/testUtils.ts`):

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createTestApp } from '../../server/src/testUtils';
import { listDesks, getState, sendCommand, createDesk, renameDesk, getFile, DeskApiError } from './deskApi';

let app: FastifyInstance;
let baseUrl: string;
let token: string;

beforeAll(async () => {
  const ctx = await createTestApp();
  app = ctx.app;
  token = ctx.token;
  await app.listen({ port: 0 });
  const addr = app.server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
});
afterAll(async () => {
  await app.close();
});

describe('deskApi', () => {
  it('createDesk, listDesks, getState, sendCommand, renameDesk', async () => {
    const desk = await createDesk(baseUrl, token, 'MCP-Test');
    const desks = await listDesks(baseUrl, token);
    expect(desks.some((d) => d.id === desk.id && d.isOwner)).toBe(true);
    const s0 = await getState(baseUrl, token, desk.id);
    expect(s0.state.docs).toEqual([]);
    const s1 = await sendCommand(baseUrl, token, desk.id, { type: 'bringToFront', payload: { id: 'x' } });
    expect(s1.rev).toBe(1);
    await renameDesk(baseUrl, token, desk.id, 'Umbenannt');
    expect((await listDesks(baseUrl, token)).find((d) => d.id === desk.id)?.name).toBe('Umbenannt');
  });

  it('wirft DeskApiError mit Status und deutscher Meldung', async () => {
    await expect(listDesks(baseUrl, 'falsches-token')).rejects.toMatchObject({ status: 401 });
    await expect(getFile(baseUrl, token, 'gibtsnicht')).rejects.toBeInstanceOf(DeskApiError);
  });
});
```

Run: `npx vitest run packages/mcp` → Expected: FAIL (Module fehlen).

- [ ] **Step 3: Implementieren**

`packages/mcp/src/config.ts`:

```ts
export interface McpConfig {
  port: number;
  deskServerUrl: string;
  anymizeApiKey: string;
  anymizeApiUrl: string;
  allowDeanonymize: boolean;
}

const ohneSlash = (u: string) => u.replace(/\/+$/, '');

export function loadConfig(env: Record<string, string | undefined>): McpConfig {
  const key = env.ANYMIZE_API_KEY ?? '';
  if (key === '') throw new Error('ANYMIZE_API_KEY fehlt');
  return {
    port: Number(env.MCP_PORT ?? 4820),
    deskServerUrl: ohneSlash(env.DESK_SERVER_URL ?? 'http://localhost:4810'),
    anymizeApiKey: key,
    anymizeApiUrl: ohneSlash(env.ANYMIZE_API_URL ?? 'https://app.anymize.ai'),
    allowDeanonymize: (env.MCP_ALLOW_DEANONYMIZE ?? 'true') !== 'false',
  };
}
```

`packages/mcp/src/deskApi.ts` (Fehlertexte der Desk-API durchreichen):

```ts
export class DeskApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function request<T>(baseUrl: string, token: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${baseUrl}/api/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let message = `Desk-Server-Fehler (HTTP ${res.status})`;
    try {
      message = ((await res.json()) as { error?: string }).error ?? message;
    } catch {
      // kein JSON-Body
    }
    throw new DeskApiError(message, res.status);
  }
  return (await res.json()) as T;
}

export interface DeskInfo { id: string; name: string; ownerId: string; ownerName: string; isOwner: boolean }
export interface Doc { id: string; fileId: string; name: string; position: { x: number; y: number }; rotation: number; zIndex: number }
export interface Link { id: string; fromId: string; toId: string; note: string }
export interface Stack { id: string; name: string; docIds: string[]; position: { x: number; y: number }; zIndex: number }
export interface DeskState { rev: number; state: { docs: Doc[]; links: Link[]; stacks: Stack[] } }

export const listDesks = (b: string, t: string) => request<DeskInfo[]>(b, t, 'GET', '/desks');
export const getState = (b: string, t: string, deskId: string) => request<DeskState>(b, t, 'GET', `/desks/${deskId}/state`);
export const sendCommand = (b: string, t: string, deskId: string, cmd: { type: string; payload: unknown }) =>
  request<DeskState>(b, t, 'POST', `/desks/${deskId}/commands`, cmd);
export const createDesk = (b: string, t: string, name: string) => request<DeskInfo>(b, t, 'POST', '/desks', { name });
export const renameDesk = (b: string, t: string, deskId: string, name: string) =>
  request<{ ok: boolean }>(b, t, 'PATCH', `/desks/${deskId}`, { name });

export async function getFile(baseUrl: string, token: string, fileId: string): Promise<Uint8Array> {
  const res = await fetch(`${baseUrl}/api/v1/files/${fileId}`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new DeskApiError(`Datei nicht ladbar (HTTP ${res.status})`, res.status);
  return new Uint8Array(await res.arrayBuffer());
}
```

- [ ] **Step 4: Verifizieren & committen**

Run: `npm test` → PASS (127 erwartet: 123 + 4).

```bash
git add packages/mcp package.json package-lock.json
git commit -m "feat(mcp): Paket-Grundgerüst — Config und Desk-API-Client mit Token-Durchreiche" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: anymize-Client (async Jobs, injizierbares fetch)

**Files:**
- Create: `packages/mcp/src/anymize.ts`, `packages/mcp/src/anymize.test.ts`

**Interfaces:**
- Produces: `AnymizeError extends Error { kind: 'unavailable' | 'failed' | 'timeout' | 'zdr' }`; `HashPair { original: string; placeholder: string }`; `class AnymizeClient` mit Konstruktor `(cfg: { apiUrl: string; apiKey: string; pollIntervalMs?: number; timeoutMs?: number }, fetchFn: typeof fetch = fetch)` und Methoden `anonymizeText(text: string): Promise<{ text: string; pairs: HashPair[] }>` und `anonymizeFile(bytes: Uint8Array, filename: string): Promise<{ text: string; pairs: HashPair[] }>`.
- Ablauf laut `docs/anymize-api.md`: `POST {apiUrl}/api/anonymize` (JSON `{text, language: 'de'}`) bzw. `POST {apiUrl}/api/ocr` (multipart `file`, `language`) → `job_id` → Polling `GET {apiUrl}/api/status/{jobId}` bis `completed`/`failed` → Text aus `result.text` → Mapping via `GET {apiUrl}/api/status/{jobId}/strings` → `hash_pairs` (Felder `original`, `hash`); `pairs.placeholder` = Wert aus `hash`.
- Fehlerabbildung: Netzwerkfehler/5xx/401 → `kind: 'unavailable'`; Job `failed` → `'failed'`; Timeout überschritten → `'timeout'`; strings-Abruf 4xx oder leere hash_pairs bei `entities_found > 0` → `'zdr'` (Meldung: „De-Anonymisierung nicht verfügbar — vermutlich ist Zero Data Retention im anymize-Account aktiv").

- [ ] **Step 1: Failing Tests schreiben**

`packages/mcp/src/anymize.test.ts` — Fake-fetch, das die anymize-Antworten der Referenzdoku nachstellt:

```ts
import { describe, it, expect } from 'vitest';
import { AnymizeClient, AnymizeError } from './anymize';

type Route = (url: string, init?: RequestInit) => Response | undefined;
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function fakeFetch(route: Route): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const res = route(url, init);
    if (!res) throw new Error(`Unerwarteter Aufruf: ${url}`);
    return res;
  }) as typeof fetch;
}

const cfg = { apiUrl: 'https://anymize.test', apiKey: 'k', pollIntervalMs: 1, timeoutMs: 500 };

function happyRoutes(erwarteterPfad: string): Route {
  let polls = 0;
  return (url, init) => {
    if (url === `https://anymize.test${erwarteterPfad}` && init?.method === 'POST') {
      return json(202, { job_id: 'job_1', status: 'processing' });
    }
    if (url === 'https://anymize.test/api/status/job_1') {
      polls += 1;
      return polls < 2
        ? json(200, { job_id: 'job_1', status: 'processing', progress: 50 })
        : json(200, { job_id: 'job_1', status: 'completed', result: { text: 'Hallo [[Person-AB12]]', entities_found: 1 } });
    }
    if (url === 'https://anymize.test/api/status/job_1/strings') {
      return json(200, { job_id: 'job_1', hash_pairs: [{ original: 'Max Mustermann', hash: '[[Person-AB12]]', prefix_name: 'Person', placeholder: 'Person-AB12' }], total: 1 });
    }
    return undefined;
  };
}

describe('AnymizeClient', () => {
  it('anonymizeText: Job anlegen, pollen, Text + Mapping liefern', async () => {
    const client = new AnymizeClient(cfg, fakeFetch(happyRoutes('/api/anonymize')));
    const r = await client.anonymizeText('Hallo Max Mustermann');
    expect(r.text).toBe('Hallo [[Person-AB12]]');
    expect(r.pairs).toEqual([{ original: 'Max Mustermann', placeholder: '[[Person-AB12]]' }]);
  });

  it('anonymizeFile: multipart an /api/ocr, gleicher Ablauf', async () => {
    const client = new AnymizeClient(cfg, fakeFetch(happyRoutes('/api/ocr')));
    const r = await client.anonymizeFile(new Uint8Array([1, 2, 3]), 'a.pdf');
    expect(r.text).toContain('[[Person-AB12]]');
  });

  it('Netzwerkfehler → unavailable; Job failed → failed; Timeout → timeout', async () => {
    const kaputt = new AnymizeClient(cfg, (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch);
    await expect(kaputt.anonymizeText('x')).rejects.toMatchObject({ kind: 'unavailable' });

    const failed = new AnymizeClient(cfg, fakeFetch((url, init) =>
      init?.method === 'POST' ? json(202, { job_id: 'j', status: 'processing' })
      : url.endsWith('/api/status/j') ? json(200, { job_id: 'j', status: 'failed' }) : undefined));
    await expect(failed.anonymizeText('x')).rejects.toMatchObject({ kind: 'failed' });

    const ewig = new AnymizeClient({ ...cfg, timeoutMs: 5 }, fakeFetch((url, init) =>
      init?.method === 'POST' ? json(202, { job_id: 'j', status: 'processing' })
      : url.endsWith('/api/status/j') ? json(200, { job_id: 'j', status: 'processing' }) : undefined));
    await expect(ewig.anonymizeText('x')).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('strings 403 oder leer trotz Entities → zdr', async () => {
    const zdr = new AnymizeClient(cfg, fakeFetch((url, init) => {
      if (init?.method === 'POST') return json(202, { job_id: 'j', status: 'processing' });
      if (url.endsWith('/api/status/j')) return json(200, { job_id: 'j', status: 'completed', result: { text: '[[Person-X1]]', entities_found: 1 } });
      if (url.endsWith('/strings')) return json(403, { error: { message: 'ZDR enabled' } });
      return undefined;
    }));
    await expect(zdr.anonymizeText('x')).rejects.toMatchObject({ kind: 'zdr' });
  });
});
```

Run: `npx vitest run packages/mcp/src/anymize.test.ts` → Expected: FAIL (Modul fehlt).

- [ ] **Step 2: Implementieren**

`packages/mcp/src/anymize.ts`:

```ts
export class AnymizeError extends Error {
  constructor(message: string, readonly kind: 'unavailable' | 'failed' | 'timeout' | 'zdr') {
    super(message);
  }
}

export interface HashPair {
  original: string;
  placeholder: string;
}

interface AnymizeCfg {
  apiUrl: string;
  apiKey: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

const schlafe = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class AnymizeClient {
  private readonly poll: number;
  private readonly timeout: number;

  constructor(private readonly cfg: AnymizeCfg, private readonly fetchFn: typeof fetch = fetch) {
    this.poll = cfg.pollIntervalMs ?? 2000;
    this.timeout = cfg.timeoutMs ?? 120000;
  }

  private async call(path: string, init: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.cfg.apiUrl}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${this.cfg.apiKey}`, ...(init.headers ?? {}) },
      });
    } catch {
      throw new AnymizeError('Anonymisierung nicht verfügbar — anymize ist nicht erreichbar', 'unavailable');
    }
    return res;
  }

  private async job(path: string, init: RequestInit): Promise<{ text: string; pairs: HashPair[] }> {
    const start = await this.call(path, init);
    if (!start.ok) throw new AnymizeError(`Anonymisierung nicht verfügbar (anymize HTTP ${start.status})`, 'unavailable');
    const { job_id: jobId } = (await start.json()) as { job_id: string };

    const frist = Date.now() + this.timeout;
    let result: { text: string; entities_found?: number } | undefined;
    for (;;) {
      if (Date.now() > frist) throw new AnymizeError('Anonymisierung dauert zu lange (Timeout)', 'timeout');
      const res = await this.call(`/api/status/${jobId}`, { method: 'GET' });
      if (!res.ok) throw new AnymizeError(`Anonymisierung nicht verfügbar (anymize HTTP ${res.status})`, 'unavailable');
      const status = (await res.json()) as { status: string; result?: { text: string; entities_found?: number } };
      if (status.status === 'failed') throw new AnymizeError('Anonymisierung fehlgeschlagen (anymize-Job failed)', 'failed');
      if (status.status === 'completed' && status.result) {
        result = status.result;
        break;
      }
      await schlafe(this.poll);
    }

    const strings = await this.call(`/api/status/${jobId}/strings`, { method: 'GET' });
    if (!strings.ok) {
      throw new AnymizeError(
        'De-Anonymisierung nicht verfügbar — vermutlich ist Zero Data Retention im anymize-Account aktiv',
        'zdr',
      );
    }
    const body = (await strings.json()) as { hash_pairs: { original: string; hash: string }[] };
    const pairs: HashPair[] = (body.hash_pairs ?? []).map((p) => ({ original: p.original, placeholder: p.hash }));
    if (pairs.length === 0 && (result.entities_found ?? 0) > 0) {
      throw new AnymizeError(
        'De-Anonymisierung nicht verfügbar — vermutlich ist Zero Data Retention im anymize-Account aktiv',
        'zdr',
      );
    }
    return { text: result.text, pairs };
  }

  anonymizeText(text: string): Promise<{ text: string; pairs: HashPair[] }> {
    return this.job('/api/anonymize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, language: 'de' }),
    });
  }

  anonymizeFile(bytes: Uint8Array, filename: string): Promise<{ text: string; pairs: HashPair[] }> {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'application/pdf' }), filename);
    form.append('language', 'de');
    return this.job('/api/ocr', { method: 'POST', body: form });
  }
}
```

- [ ] **Step 3: Optionaler Live-Check des Platzhalterformats**

Wenn `.env.local` im Repo-Root existiert und `ANYMIZE_API_KEY` enthält: einmalig `curl -X POST https://app.anymize.ai/api/anonymize -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{"text":"Max Mustermann wohnt in Berlin","language":"de"}'`, dann Status + strings abrufen und das reale Platzhalterformat im Task-Report dokumentieren. Sonst: als „offen — bei UAT prüfen" in den Report schreiben. (Kostet ~5 Credits.)

- [ ] **Step 4: Verifizieren & committen**

Run: `npm test` → PASS (131 erwartet: 127 + 4).

```bash
git add packages/mcp
git commit -m "feat(mcp): anymize-Client — asynchrone Jobs, hash_pairs-Mapping, ZDR-/Timeout-/Ausfall-Erkennung" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Mapping-Store & Credit-sparende Caches

**Files:**
- Create: `packages/mcp/src/mapping.ts`, `packages/mcp/src/mapping.test.ts`

**Interfaces:**
- Consumes: `HashPair` aus Task 2.
- Produces: `PLACEHOLDER_RE: RegExp` (global, matcht `[[Type-HASH]]` UND `[PREFIX-N]`); `class MappingStore` mit `record(pairs: HashPair[]): void`, `deanonymize(text: string): { text: string; unknown: string[] }` (ersetzt alle bekannten Platzhalter, sammelt unbekannte), `size: number`; `class AnonCache` mit `getFileText(fileId: string): string | undefined`, `setFileText(fileId: string, text: string): void`, `getName(klartext: string): string | undefined`, `setName(klartext: string, anonymisiert: string): void`.
- Namens-Batching-Helfer: `batchLines(namen: string[]): string` (join mit `\n`) und `splitLines(anonymisiert: string, erwartet: number): string[] | null` (split; `null` wenn Zeilenzahl abweicht — Aufrufer fällt dann auf Einzel-Aufrufe zurück).

- [ ] **Step 1: Failing Tests schreiben**

`packages/mcp/src/mapping.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { MappingStore, AnonCache, PLACEHOLDER_RE, batchLines, splitLines } from './mapping';

describe('PLACEHOLDER_RE', () => {
  it('erkennt beide dokumentierten Formate', () => {
    const text = 'A [[Person-QSEZB6]] B [PERSON-1] C [[email-BE2966]] D [IBAN-12]';
    expect(text.match(PLACEHOLDER_RE)).toEqual(['[[Person-QSEZB6]]', '[PERSON-1]', '[[email-BE2966]]', '[IBAN-12]']);
    expect('kein Platzhalter [Hinweis] hier'.match(PLACEHOLDER_RE)).toBeNull();
  });
});

describe('MappingStore', () => {
  it('ersetzt bekannte Platzhalter und meldet unbekannte', () => {
    const store = new MappingStore();
    store.record([{ original: 'Max Mustermann', placeholder: '[[Person-AB12]]' }]);
    const r = store.deanonymize('Hallo [[Person-AB12]], kennst du [[Person-ZZ99]]?');
    expect(r.text).toBe('Hallo Max Mustermann, kennst du [[Person-ZZ99]]?');
    expect(r.unknown).toEqual(['[[Person-ZZ99]]']);
    expect(store.size).toBe(1);
  });
});

describe('AnonCache', () => {
  it('cached Dateitexte und Namen', () => {
    const cache = new AnonCache();
    expect(cache.getFileText('f1')).toBeUndefined();
    cache.setFileText('f1', 'anon');
    expect(cache.getFileText('f1')).toBe('anon');
    cache.setName('Arztbrief Meier', '[[Person-X1]]-Brief');
    expect(cache.getName('Arztbrief Meier')).toBe('[[Person-X1]]-Brief');
  });
});

describe('Batching', () => {
  it('joint und splittet zeilenweise; null bei abweichender Zeilenzahl', () => {
    expect(batchLines(['a', 'b'])).toBe('a\nb');
    expect(splitLines('x\ny', 2)).toEqual(['x', 'y']);
    expect(splitLines('nur-eine-zeile', 2)).toBeNull();
  });
});
```

Run: `npx vitest run packages/mcp/src/mapping.test.ts` → Expected: FAIL.

- [ ] **Step 2: Implementieren**

`packages/mcp/src/mapping.ts`:

```ts
import type { HashPair } from './anymize';

/** Beide dokumentierte Formate: [[Type-HASH]] und [PREFIX-N] (docs/anymize-api.md). */
export const PLACEHOLDER_RE = /\[\[[A-Za-z_]+-[A-Za-z0-9]+\]\]|\[[A-Z_]+-\d+\]/g;

export class MappingStore {
  private readonly map = new Map<string, string>();

  record(pairs: HashPair[]): void {
    for (const p of pairs) this.map.set(p.placeholder, p.original);
  }

  get size(): number {
    return this.map.size;
  }

  deanonymize(text: string): { text: string; unknown: string[] } {
    const unknown: string[] = [];
    const ersetzt = text.replace(PLACEHOLDER_RE, (m) => {
      const original = this.map.get(m);
      if (original === undefined) {
        unknown.push(m);
        return m;
      }
      return original;
    });
    return { text: ersetzt, unknown };
  }
}

export class AnonCache {
  private readonly fileTexts = new Map<string, string>();
  private readonly namen = new Map<string, string>();

  getFileText(fileId: string): string | undefined {
    return this.fileTexts.get(fileId);
  }
  setFileText(fileId: string, text: string): void {
    this.fileTexts.set(fileId, text);
  }
  getName(klartext: string): string | undefined {
    return this.namen.get(klartext);
  }
  setName(klartext: string, anonymisiert: string): void {
    this.namen.set(klartext, anonymisiert);
  }
}

export const batchLines = (namen: string[]): string => namen.join('\n');

export function splitLines(anonymisiert: string, erwartet: number): string[] | null {
  const zeilen = anonymisiert.split('\n');
  return zeilen.length === erwartet ? zeilen : null;
}
```

- [ ] **Step 3: Verifizieren & committen**

Run: `npm test` → PASS (136 erwartet: 131 + 5).

```bash
git add packages/mcp
git commit -m "feat(mcp): Mapping-Store und Anonymisierungs-Caches mit tolerantem Platzhalter-Regex" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: MCP-Server mit Lese-Tools + HTTP-Wiring

**Files:**
- Create: `packages/mcp/src/anonymizer.ts`, `packages/mcp/src/server.ts`, `packages/mcp/src/main.ts`, `packages/mcp/src/testServer.ts`, `packages/mcp/src/tools-read.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3 (`loadConfig`, deskApi-Funktionen, `AnymizeClient`, `MappingStore`, `AnonCache`, `batchLines`/`splitLines`).
- Produces: `class Anonymizer` (Konstruktor `(client: AnymizeClient, mappings: MappingStore, cache: AnonCache)`) mit `anonNames(namen: string[]): Promise<string[]>` (Cache-first; Uncached als EIN gebatchter anonymizeText-Aufruf, bei `splitLines === null` Fallback auf Einzelaufrufe; leere Strings bleiben leer und gehen nie an anymize) und `anonFileText(fileId: string, laden: () => Promise<Uint8Array>, filename: string): Promise<string>` (Cache-first; kürzt auf 100.000 Zeichen mit Suffix `\n\n[Hinweis: Text gekürzt]`); beide Methoden rufen `mappings.record(pairs)` auf.
- Produces: `buildMcpServer(deps: { config: McpConfig; anonymizer: Anonymizer; mappings: MappingStore; token: string }): McpServer` — registriert die Tools; `startHttpServer(config, shared): Promise<http.Server>` in `main.ts`-Struktur: Express-App, `POST /mcp` liest `Authorization: Bearer <token>` (fehlt → 401 JSON `{error: 'Authorization-Header mit Desk-Server-Token erforderlich'}`), erzeugt pro Request `buildMcpServer` + `StreamableHTTPServerTransport({ sessionIdGenerator: undefined })`, `server.connect(transport)`, `transport.handleRequest(req, res, req.body)`; `GET/DELETE /mcp` → 405. Prozessweit geteilt: `MappingStore`, `AnonCache`, `AnymizeClient`, `Anonymizer`.
- Produces (für Tests, `testServer.ts`): `startTestSetup(): Promise<{ deskUrl, token, mcpUrl, mcpClient, stop() }>` — startet Desk-Server (`createTestApp` + listen 0), MCP-HTTP-Server (Port 0) mit Fake-anymize (deterministisch: ersetzt jedes Vorkommen von `Max Mustermann` durch `[[Person-TEST1]]` und liefert das Paar; alles andere unverändert; zählt Aufrufe via `calls`-Zähler; schaltbar auf „down") und verbundenen MCP-SDK-Client (`Client` + `StreamableHTTPClientTransport` mit `requestInit: { headers: { authorization: 'Bearer ' + token } }`).
- Lese-Tools (Ausgaben als JSON-Text im Tool-Ergebnis):
  - `list_desks` (keine Args) → `[{id, name (anonymisiert), isOwner}]`
  - `get_desk` ({deskId: string}) → `{docs: [{id, name (anonymisiert), position, stackId?}], stacks: [{id, name (anonymisiert), docIds, position}], links: [{id, fromId, toId, note (anonymisiert)}]}`
  - `get_document_text` ({deskId: string, docId: string}) → anonymisierter Volltext; Doc nicht auf Desk → Fehler „Dokument nicht gefunden"; PDF > 25 MB → Fehler „PDF zu groß (max. 25 MB)".
- Fehlerbild: `DeskApiError` 401 → isError „Token ungültig — neues Token mit npm run mcp:token erzeugen"; 403/404 → Meldung der Desk-API; `AnymizeError` → deren Meldung. Alle Tool-Handler fangen Fehler und liefern `{ isError: true, content: [{type:'text', text: meldung}] }`.

- [ ] **Step 1: Failing Tests schreiben**

`packages/mcp/src/tools-read.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestSetup, type TestSetup } from './testServer';

let ts: TestSetup;
beforeAll(async () => {
  ts = await startTestSetup();
});
afterAll(async () => {
  await ts.stop();
});

async function callTool(name: string, args: Record<string, unknown> = {}) {
  return ts.mcpClient.callTool({ name, arguments: args });
}
const textOf = (r: Awaited<ReturnType<typeof callTool>>) =>
  (r.content as { type: string; text: string }[]).map((c) => c.text).join('');

describe('Lese-Tools', () => {
  it('list_desks liefert anonymisierte Namen', async () => {
    await ts.createDesk('Desk von Max Mustermann');
    const r = await callTool('list_desks');
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain('[[Person-TEST1]]');
    expect(textOf(r)).not.toContain('Max Mustermann');
  });

  it('get_desk liefert Karten mit anonymisierten Namen; Cache spart anymize-Aufrufe', async () => {
    const deskId = await ts.createDesk('Zweiter Desk');
    await ts.addDoc(deskId, 'Rechnung Max Mustermann.pdf');
    const vorher = ts.anymizeCalls();
    const r1 = await callTool('get_desk', { deskId });
    expect(textOf(r1)).toContain('[[Person-TEST1]]');
    await callTool('get_desk', { deskId });
    expect(ts.anymizeCalls()).toBe(vorher + 1); // zweiter Aufruf komplett aus dem Cache
  });

  it('get_document_text: PDF via Fake-anymize, gecacht pro fileId', async () => {
    const deskId = await ts.createDesk('Textdesk');
    const docId = await ts.addDoc(deskId, 'Brief.pdf');
    const vorher = ts.anymizeCalls();
    const r = await callTool('get_document_text', { deskId, docId });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain('[[Person-TEST1]]');
    await callTool('get_document_text', { deskId, docId });
    expect(ts.anymizeCalls()).toBe(vorher + 1);
  });

  it('fail-closed: anymize down → Fehler statt Klartext', async () => {
    ts.setAnymizeDown(true);
    const deskId = await ts.createDesk('Geheim Max Mustermann');
    const r = await callTool('get_desk', { deskId });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('Anonymisierung nicht verfügbar');
    expect(textOf(r)).not.toContain('Max Mustermann');
    ts.setAnymizeDown(false);
  });

  it('ungültiges Token → 401-Meldung', async () => {
    const fremd = await ts.clientMitToken('falsches-token');
    const r = await fremd.callTool({ name: 'list_desks', arguments: {} });
    expect(r.isError).toBe(true);
    expect((r.content as { text: string }[])[0].text).toContain('mcp:token');
  });
});
```

Run: `npx vitest run packages/mcp/src/tools-read.test.ts` → Expected: FAIL.

- [ ] **Step 2: Anonymizer implementieren** (`packages/mcp/src/anonymizer.ts`)

```ts
import { AnymizeClient } from './anymize';
import { AnonCache, MappingStore, batchLines, splitLines } from './mapping';

const MAX_TEXT = 100_000;

export class Anonymizer {
  constructor(
    private readonly client: AnymizeClient,
    private readonly mappings: MappingStore,
    private readonly cache: AnonCache,
  ) {}

  /** Cache-first; Uncached gebatcht in einem anymize-Aufruf (Fallback: einzeln). */
  async anonNames(namen: string[]): Promise<string[]> {
    const fehlend = [...new Set(namen.filter((n) => n !== '' && this.cache.getName(n) === undefined))];
    if (fehlend.length > 0) {
      const r = await this.client.anonymizeText(batchLines(fehlend));
      this.mappings.record(r.pairs);
      const zeilen = splitLines(r.text, fehlend.length);
      if (zeilen) {
        fehlend.forEach((n, i) => this.cache.setName(n, zeilen[i]));
      } else {
        for (const n of fehlend) {
          const einzel = await this.client.anonymizeText(n);
          this.mappings.record(einzel.pairs);
          this.cache.setName(n, einzel.text);
        }
      }
    }
    return namen.map((n) => (n === '' ? '' : this.cache.getName(n)!));
  }

  async anonFileText(fileId: string, laden: () => Promise<Uint8Array>, filename: string): Promise<string> {
    const cached = this.cache.getFileText(fileId);
    if (cached !== undefined) return cached;
    const bytes = await laden();
    if (bytes.length > 25 * 1024 * 1024) throw new Error('PDF zu groß (max. 25 MB)');
    const r = await this.client.anonymizeFile(bytes, filename);
    this.mappings.record(r.pairs);
    const text = r.text.length > MAX_TEXT ? `${r.text.slice(0, MAX_TEXT)}\n\n[Hinweis: Text gekürzt]` : r.text;
    this.cache.setFileText(fileId, text);
    return text;
  }
}
```

- [ ] **Step 3: server.ts mit Lese-Tools** (`packages/mcp/src/server.ts`)

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { McpConfig } from './config';
import { Anonymizer } from './anonymizer';
import { MappingStore } from './mapping';
import { AnymizeError } from './anymize';
import * as desk from './deskApi';
import { DeskApiError } from './deskApi';

export interface McpDeps {
  config: McpConfig;
  anonymizer: Anonymizer;
  mappings: MappingStore;
  token: string;
}

const ok = (data: unknown) => ({ content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] });
const fehler = (text: string) => ({ isError: true, content: [{ type: 'text' as const, text }] });

function meldung(e: unknown): string {
  if (e instanceof DeskApiError && e.status === 401) return 'Token ungültig — neues Token mit npm run mcp:token erzeugen';
  if (e instanceof DeskApiError || e instanceof AnymizeError) return e.message;
  return e instanceof Error ? e.message : 'Unbekannter Fehler';
}

/** Registriert einen Tool-Handler mit einheitlicher Fehlerbehandlung. */
function tool(server: McpServer, name: string, description: string, schema: z.ZodRawShape, handler: (args: Record<string, unknown>) => Promise<unknown>) {
  server.registerTool(name, { description, inputSchema: schema }, async (args: Record<string, unknown>) => {
    try {
      return ok(await handler(args));
    } catch (e) {
      return fehler(meldung(e));
    }
  });
}

export function buildMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer({ name: 'digital-desktop', version: '0.1.0' });
  const { config, anonymizer, token } = deps;
  const base = config.deskServerUrl;

  tool(server, 'list_desks', 'Listet alle Schreibtische des Benutzers (Namen anonymisiert).', {}, async () => {
    const desks = await desk.listDesks(base, token);
    const namen = await anonymizer.anonNames(desks.map((d) => d.name));
    return desks.map((d, i) => ({ id: d.id, name: namen[i], isOwner: d.isOwner }));
  });

  tool(server, 'get_desk', 'Liefert Karten, Stapel und Verknüpfungen eines Schreibtischs (Texte anonymisiert).', { deskId: z.string() }, async (a) => {
    const s = await desk.getState(base, token, String(a.deskId));
    const texte = [
      ...s.state.docs.map((d) => d.name),
      ...s.state.stacks.map((st) => st.name),
      ...s.state.links.map((l) => l.note),
    ];
    const anon = await anonymizer.anonNames(texte);
    let i = 0;
    const docs = s.state.docs.map((d) => ({ id: d.id, name: anon[i++], position: d.position }));
    const stacks = s.state.stacks.map((st) => ({ id: st.id, name: anon[i++], docIds: st.docIds, position: st.position }));
    const links = s.state.links.map((l) => ({ id: l.id, fromId: l.fromId, toId: l.toId, note: anon[i++] }));
    return { docs, stacks, links };
  });

  tool(server, 'get_document_text', 'Liefert den anonymisierten Volltext eines Dokuments (PDF via OCR).', { deskId: z.string(), docId: z.string() }, async (a) => {
    const s = await desk.getState(base, token, String(a.deskId));
    const doc = s.state.docs.find((d) => d.id === a.docId);
    if (!doc) throw new Error('Dokument nicht gefunden');
    return anonymizer.anonFileText(doc.fileId, () => desk.getFile(base, token, doc.fileId), doc.name);
  });

  return server;
}
```

- [ ] **Step 4: main.ts HTTP-Wiring** (`packages/mcp/src/main.ts`)

```ts
import express from 'express';
import type http from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadConfig, type McpConfig } from './config';
import { AnymizeClient } from './anymize';
import { AnonCache, MappingStore } from './mapping';
import { Anonymizer } from './anonymizer';
import { buildMcpServer } from './server';

export interface Shared {
  anonymizer: Anonymizer;
  mappings: MappingStore;
}

export function startHttpServer(config: McpConfig, shared: Shared): Promise<http.Server> {
  const app = express();
  app.use(express.json({ limit: '4mb' }));

  app.post('/mcp', async (req, res) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Authorization-Header mit Desk-Server-Token erforderlich' });
      return;
    }
    const token = header.slice(7);
    const server = buildMcpServer({ config, anonymizer: shared.anonymizer, mappings: shared.mappings, token });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.all('/mcp', (_req, res) => {
    res.status(405).json({ error: 'Nur POST wird unterstützt (stateless Streamable HTTP)' });
  });

  return new Promise((resolve) => {
    const s = app.listen(config.port, () => resolve(s));
  });
}

// Direktstart (nicht in Tests)
if (process.argv[1]?.endsWith('main.ts')) {
  const config = loadConfig(process.env);
  const mappings = new MappingStore();
  const anonymizer = new Anonymizer(new AnymizeClient({ apiUrl: config.anymizeApiUrl, apiKey: config.anymizeApiKey }), mappings, new AnonCache());
  void startHttpServer(config, { anonymizer, mappings }).then(() =>
    console.log(`Digital-Desktop-MCP-Server läuft auf Port ${config.port} (Desk-Server: ${config.deskServerUrl})`),
  );
}
```

- [ ] **Step 5: testServer.ts** (`packages/mcp/src/testServer.ts`)

```ts
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
```


- [ ] **Step 6: Verifizieren & committen**

Run: `npm test` → PASS (141 erwartet: 136 + 5).

```bash
git add packages/mcp
git commit -m "feat(mcp): MCP-Server mit Lese-Tools, Streamable-HTTP-Wiring, Token-Durchreiche und fail-closed-Anonymisierung" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Organisier-Tools, serverseitige De-Anonymisierung & deanonymize-Tool

**Files:**
- Modify: `packages/mcp/src/server.ts`
- Create: `packages/mcp/src/tools-write.test.ts`

**Interfaces:**
- Consumes: Task 4 (`tool`-Helfer, `McpDeps`, deskApi, `mappings.deanonymize`).
- Produces: Organisier-Tools (jedes de-anonymisiert Text-Argumente via `deanon(deps, wert)`-Helfer vor dem API-Aufruf; unbekannte Platzhalter → Fehler „Unbekannte Platzhalter: … — Dokument erneut lesen (Zuordnung ging z. B. durch Neustart verloren)"):
  - `move_document` {deskId, docId, x, y} → `moveDoc {id, position:{x,y}}`
  - `stack_documents` {deskId, draggedId, targetId, stackId?} → `stackDocs {draggedId, targetId, id: stackId ?? crypto.randomUUID()}`
  - `remove_from_stack` {deskId, docId, x, y} → `removeFromStack {docId, position:{x,y}}`
  - `dissolve_stack` {deskId, stackId} → `dissolveStack {stackId}`
  - `rename_stack` {deskId, stackId, name*} → `renameStack {stackId, name}`
  - `move_stack` {deskId, stackId, x, y} → `moveStack {stackId, position:{x,y}}`
  - `link_documents` {deskId, fromId, toId, linkId?} → `addLink {fromId, toId, id: linkId ?? crypto.randomUUID()}`
  - `set_link_note` {deskId, linkId, note*} → `setLinkNote {linkId, note}`
  - `remove_link` {deskId, linkId} → `removeLink {linkId}`
  - `create_desk` {name*} → `POST /desks`; `rename_desk` {deskId, name*} → `PATCH /desks/:id`
  - (* = Text-Argument, wird de-anonymisiert)
  - Rückgabe der Kommando-Tools: `{ ok: true, rev }` (bzw. bei create_desk `{ id, name (anonymisiert zurückgegeben wie eingegeben) }` — Name im Ergebnis = Eingabewert, NICHT der Klartext).
- Produces: `deanonymize`-Tool {text} → Klartext via `mappings.deanonymize` (unbekannte Platzhalter bleiben stehen und werden im Ergebnis unter dem Text als Hinweis gelistet); NUR registriert wenn `config.allowDeanonymize`.

- [ ] **Step 1: Failing Tests schreiben**

`packages/mcp/src/tools-write.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestSetup, type TestSetup } from './testServer';
import { getState } from './deskApi';

let ts: TestSetup;
beforeAll(async () => {
  ts = await startTestSetup();
});
afterAll(async () => {
  await ts.stop();
});
const textOf = (r: { content: unknown }) => (r.content as { text: string }[]).map((c) => c.text).join('');

describe('Organisier-Tools', () => {
  it('move_document, stack_documents, rename_stack mit De-Anonymisierung', async () => {
    const deskId = await ts.createDesk('Orga');
    const a = await ts.addDoc(deskId, 'Rechnung Max Mustermann.pdf');
    const b = await ts.addDoc(deskId, 'Brief.pdf');
    await ts.mcpClient.callTool({ name: 'get_desk', arguments: { deskId } }); // füllt Mapping ([[Person-TEST1]])

    const mv = await ts.mcpClient.callTool({ name: 'move_document', arguments: { deskId, docId: a, x: 100, y: 50 } });
    expect(mv.isError).toBeFalsy();

    const st = await ts.mcpClient.callTool({ name: 'stack_documents', arguments: { deskId, draggedId: a, targetId: b } });
    expect(st.isError).toBeFalsy();
    const s1 = await getState(ts.deskUrl, ts.token, deskId);
    expect(s1.state.stacks).toHaveLength(1);

    // Platzhalter im Namen → Klartext auf dem Schreibtisch
    const rn = await ts.mcpClient.callTool({
      name: 'rename_stack',
      arguments: { deskId, stackId: s1.state.stacks[0].id, name: 'Unterlagen [[Person-TEST1]]' },
    });
    expect(rn.isError).toBeFalsy();
    const s2 = await getState(ts.deskUrl, ts.token, deskId);
    expect(s2.state.stacks[0].name).toBe('Unterlagen Max Mustermann');
  });

  it('link_documents + set_link_note + remove_link; create_desk/rename_desk', async () => {
    const deskId = await ts.createDesk('Links');
    const a = await ts.addDoc(deskId, 'A.pdf');
    const b = await ts.addDoc(deskId, 'B.pdf');
    const link = await ts.mcpClient.callTool({ name: 'link_documents', arguments: { deskId, fromId: a, toId: b } });
    expect(link.isError).toBeFalsy();
    const linkId = (await getState(ts.deskUrl, ts.token, deskId)).state.links[0].id;
    await ts.mcpClient.callTool({ name: 'set_link_note', arguments: { deskId, linkId, note: 'gehört zusammen' } });
    expect((await getState(ts.deskUrl, ts.token, deskId)).state.links[0].note).toBe('gehört zusammen');
    await ts.mcpClient.callTool({ name: 'remove_link', arguments: { deskId, linkId } });
    expect((await getState(ts.deskUrl, ts.token, deskId)).state.links).toHaveLength(0);

    const neu = await ts.mcpClient.callTool({ name: 'create_desk', arguments: { name: 'KI-Desk' } });
    expect(neu.isError).toBeFalsy();
    const neuId = (JSON.parse(textOf(neu)) as { id: string }).id;
    const rn = await ts.mcpClient.callTool({ name: 'rename_desk', arguments: { deskId: neuId, name: 'KI-Desk 2' } });
    expect(rn.isError).toBeFalsy();
  });

  it('unbekannte Platzhalter → Fehler, nichts geschrieben', async () => {
    const deskId = await ts.createDesk('Fehlerfall');
    const r = await ts.mcpClient.callTool({ name: 'rename_desk', arguments: { deskId, name: 'Für [[Person-UNBEKANNT9]]' } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('Unbekannte Platzhalter');
  });

  it('destruktive Tools existieren nicht', async () => {
    const tools = await ts.mcpClient.listTools();
    const namen = tools.tools.map((t) => t.name);
    expect(namen).not.toContain('remove_document');
    expect(namen).not.toContain('delete_desk');
    expect(namen).toContain('deanonymize');
  });

  it('deanonymize-Tool übersetzt bekannte Platzhalter', async () => {
    const r = await ts.mcpClient.callTool({ name: 'deanonymize', arguments: { text: 'Hallo [[Person-TEST1]]' } });
    expect(textOf(r)).toContain('Hallo Max Mustermann');
  });

  it('Layout-Tools ohne Textbezug funktionieren auch bei anymize-Ausfall', async () => {
    const deskId = await ts.createDesk('Offline-Orga');
    const docId = await ts.addDoc(deskId, 'A.pdf');
    ts.setAnymizeDown(true);
    const r = await ts.mcpClient.callTool({ name: 'move_document', arguments: { deskId, docId, x: 5, y: 5 } });
    expect(r.isError).toBeFalsy();
    ts.setAnymizeDown(false);
  });
});
```

Zusatztest für den Konfigurationsschalter (eigene describe im selben File): zweites Setup ist teuer — stattdessen Unit-artig: `buildMcpServer` mit `config.allowDeanonymize = false` bauen und über einen frischen `clientMitToken`-Verbindungsaufbau prüfen? Einfacher: `startTestSetup` bekommt optionalen Parameter `allowDeanonymize = true`; ein zweiter kompletter Setup-Aufruf in einem eigenen Test:

```ts
describe('MCP_ALLOW_DEANONYMIZE=false', () => {
  it('versteckt das deanonymize-Tool', async () => {
    const strikt = await startTestSetup({ allowDeanonymize: false });
    const tools = await strikt.mcpClient.listTools();
    expect(tools.tools.map((t) => t.name)).not.toContain('deanonymize');
    await strikt.stop();
  });
});
```

(`startTestSetup(opts?: { allowDeanonymize?: boolean })` — in testServer.ts den Wert in `config` übernehmen.)

Run: `npx vitest run packages/mcp/src/tools-write.test.ts` → Expected: FAIL.

- [ ] **Step 2: Implementieren** — in `packages/mcp/src/server.ts` nach den Lese-Tools ergänzen (innerhalb `buildMcpServer`; `import { randomUUID } from 'node:crypto';` oben ergänzen):

```ts
  /** De-anonymisiert ein Text-Argument; unbekannte Platzhalter → Fehler. */
  const deanon = (wert: string): string => {
    const r = deps.mappings.deanonymize(wert);
    if (r.unknown.length > 0) {
      throw new Error(
        `Unbekannte Platzhalter: ${r.unknown.join(', ')} — Dokument erneut lesen (Zuordnung ging z. B. durch Neustart verloren)`,
      );
    }
    return r.text;
  };

  const cmd = (deskId: unknown, type: string, payload: unknown) =>
    desk.sendCommand(base, token, String(deskId), { type, payload }).then((r) => ({ ok: true, rev: r.rev }));

  tool(server, 'move_document', 'Verschiebt eine Karte an eine neue Position.', { deskId: z.string(), docId: z.string(), x: z.number(), y: z.number() },
    (a) => cmd(a.deskId, 'moveDoc', { id: a.docId, position: { x: a.x, y: a.y } }));

  tool(server, 'stack_documents', 'Legt eine Karte auf eine andere (bildet/erweitert einen Stapel).', { deskId: z.string(), draggedId: z.string(), targetId: z.string() },
    (a) => cmd(a.deskId, 'stackDocs', { draggedId: a.draggedId, targetId: a.targetId, id: randomUUID() }));

  tool(server, 'remove_from_stack', 'Nimmt eine Karte aus ihrem Stapel und legt sie an eine Position.', { deskId: z.string(), docId: z.string(), x: z.number(), y: z.number() },
    (a) => cmd(a.deskId, 'removeFromStack', { docId: a.docId, position: { x: a.x, y: a.y } }));

  tool(server, 'dissolve_stack', 'Löst einen Stapel auf — die Karten bleiben erhalten.', { deskId: z.string(), stackId: z.string() },
    (a) => cmd(a.deskId, 'dissolveStack', { stackId: a.stackId }));

  tool(server, 'rename_stack', 'Benennt einen Stapel um (Platzhalter werden in Klartext übersetzt).', { deskId: z.string(), stackId: z.string(), name: z.string() },
    (a) => cmd(a.deskId, 'renameStack', { stackId: a.stackId, name: deanon(String(a.name)) }));

  tool(server, 'move_stack', 'Verschiebt einen Stapel.', { deskId: z.string(), stackId: z.string(), x: z.number(), y: z.number() },
    (a) => cmd(a.deskId, 'moveStack', { stackId: a.stackId, position: { x: a.x, y: a.y } }));

  tool(server, 'link_documents', 'Verbindet zwei Karten mit einer Verknüpfungslinie.', { deskId: z.string(), fromId: z.string(), toId: z.string() },
    (a) => cmd(a.deskId, 'addLink', { fromId: a.fromId, toId: a.toId, id: randomUUID() }));

  tool(server, 'set_link_note', 'Setzt die Notiz einer Verknüpfung (Platzhalter werden übersetzt).', { deskId: z.string(), linkId: z.string(), note: z.string() },
    (a) => cmd(a.deskId, 'setLinkNote', { linkId: a.linkId, note: deanon(String(a.note)) }));

  tool(server, 'remove_link', 'Entfernt eine Verknüpfungslinie (die Karten bleiben).', { deskId: z.string(), linkId: z.string() },
    (a) => cmd(a.deskId, 'removeLink', { linkId: a.linkId }));

  tool(server, 'create_desk', 'Legt einen neuen Schreibtisch an.', { name: z.string() }, async (a) => {
    const d = await desk.createDesk(base, token, deanon(String(a.name)));
    return { id: d.id, name: String(a.name) };
  });

  tool(server, 'rename_desk', 'Benennt einen Schreibtisch um.', { deskId: z.string(), name: z.string() }, async (a) => {
    await desk.renameDesk(base, token, String(a.deskId), deanon(String(a.name)));
    return { ok: true };
  });

  if (config.allowDeanonymize) {
    tool(server, 'deanonymize', 'Übersetzt Platzhalter in Klartext (für lesbare Antworten an den Benutzer).', { text: z.string() }, async (a) => {
      const r = deps.mappings.deanonymize(String(a.text));
      return r.unknown.length > 0 ? `${r.text}\n\n[Unbekannte Platzhalter: ${r.unknown.join(', ')}]` : r.text;
    });
  }
```

In `testServer.ts`: Signatur `startTestSetup(opts?: { allowDeanonymize?: boolean })`, im config-Objekt `allowDeanonymize: opts?.allowDeanonymize ?? true`.

- [ ] **Step 3: Verifizieren & committen**

Run: `npm test` → PASS (148 erwartet: 141 + 7).

```bash
git add packages/mcp
git commit -m "feat(mcp): Organisier-Tools mit serverseitiger De-Anonymisierung, deanonymize-Tool mit Konfigurationsschalter" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Token-Helfer & Betriebsdoku

**Files:**
- Create: `packages/mcp/src/token.ts`, `packages/mcp/README.md`
- Modify: `.gitignore` (Zeile `.env.local`, falls nicht vorhanden)

**Interfaces:**
- Consumes: Task 1 (Root-Script `mcp:token` existiert bereits).
- Produces: `npm run mcp:token` — interaktiver Helfer: fragt Server-URL (Default `http://localhost:4810`), Benutzername, Passwort (Eingabe NICHT geechot), ruft `POST {url}/api/v1/auth/login` auf, druckt bei Erfolg NUR das Token auf stdout (Prompts auf stderr, damit `$(npm run -s mcp:token)` nutzbar ist), bei 401 „Benutzername oder Passwort falsch", bei Netzwerkfehler „Server nicht erreichbar".

- [ ] **Step 1: token.ts implementieren** (kein automatisierter Test — interaktives readline; die Login-Route selbst ist server-seitig getestet)

```ts
import { createInterface } from 'node:readline';

function frage(text: string, verdeckt = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    if (verdeckt) {
      process.stderr.write(text);
      const stdin = process.stdin as NodeJS.ReadStream & { setRawMode?: (m: boolean) => void };
      stdin.setRawMode?.(true);
      let wert = '';
      const onData = (chunk: Buffer) => {
        const c = chunk.toString();
        if (c === '\r' || c === '\n') {
          stdin.setRawMode?.(false);
          stdin.off('data', onData);
          process.stderr.write('\n');
          rl.close();
          resolve(wert);
        } else if (c === '\u0003') {
          process.exit(130);
        } else if (c === '\u007f') {
          wert = wert.slice(0, -1);
        } else {
          wert += c;
        }
      };
      stdin.on('data', onData);
    } else {
      rl.question(text, (antwort) => {
        rl.close();
        resolve(antwort);
      });
    }
  });
}

const url = ((await frage('Desk-Server-URL [http://localhost:4810]: ')) || 'http://localhost:4810').replace(/\/+$/, '');
const username = await frage('Benutzername: ');
const password = await frage('Passwort: ', true);

try {
  const res = await fetch(`${url}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (res.status === 401) {
    console.error('Benutzername oder Passwort falsch');
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`Login fehlgeschlagen (HTTP ${res.status})`);
    process.exit(1);
  }
  const { token } = (await res.json()) as { token: string };
  console.log(token);
} catch {
  console.error('Server nicht erreichbar — URL prüfen');
  process.exit(1);
}
```

- [ ] **Step 2: README schreiben** (`packages/mcp/README.md`) — Inhalt: Zweck (2 Sätze), Start (`ANYMIZE_API_KEY=… npm run mcp`), ENV-Tabelle (die 5 Variablen aus den Global Constraints mit Defaults), Token erzeugen (`npm run mcp:token`), Client-Anbindung (`claude mcp add --transport http desk http://<server>:4820/mcp --header "Authorization: Bearer <token>"`), Hinweis ZDR muss im anymize-Account AUS sein, Hinweis Credits (1 Wort = 1 Credit, Caching greift pro Prozesslaufzeit), Tool-Liste (eine Zeile pro Tool aus Tasks 4–5).

- [ ] **Step 3: .gitignore prüfen/ergänzen**

```bash
grep -qx '.env.local' .gitignore || echo '.env.local' >> .gitignore
```

- [ ] **Step 4: Verifizieren & committen**

Run: `npm test` (148 grün) und Smoke-Test: `ANYMIZE_API_KEY=dummy npx tsx packages/mcp/src/main.ts &` → Log „läuft auf Port 4820", `curl -s -X POST localhost:4820/mcp` → 401-JSON, Prozess beenden.

```bash
git add packages/mcp .gitignore
git commit -m "feat(mcp): Token-Helfer (npm run mcp:token) und Betriebs-README" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

Manuelle UAT-Checkliste (pending user verification, in den Report):
1. `npm run server` + `ANYMIZE_API_KEY=<echt> npm run mcp`; Token via `npm run mcp:token`.
2. `claude mcp add …` in Claude Code; „Welche Schreibtische habe ich?" → anonymisierte Namen.
3. „Lies das Dokument X und fasse es zusammen" → Zusammenfassung mit Platzhaltern; `deanonymize` liefert Klartext.
4. „Staple die Rechnungen zusammen und nenne den Stapel nach dem Absender" → Stapel entsteht, Name auf dem Desk in Klartext.
5. anymize-Key absichtlich falsch setzen → Lese-Tools verweigern (kein Klartext), move_document geht weiter.
6. Reales Platzhalterformat gegen `PLACEHOLDER_RE` prüfen (falls in Task 2 offen geblieben).
