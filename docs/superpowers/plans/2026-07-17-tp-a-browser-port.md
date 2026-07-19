# TP-A Browser-Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Digital Desktop läuft vollständig im Browser: Tauri wird entfernt, der Node-Server liefert die Web-App aus, alle Plattform-APIs bekommen Browser-Äquivalente.

**Architecture:** Der SvelteKit-Client (adapter-static, SPA) wird vom Fastify-Server unter `/` ausgeliefert; alle API-Aufrufe gehen relativ an `/api/v1` (gleicher Origin). Tauri-Plugins werden ersetzt: HTTP → natives `fetch`, WebSocket → nativer `WebSocket`, Dateisystem-Caches → IndexedDB, Datei-Dialoge → `<input type="file">`/HTML5-Drag-and-drop. Die bestehende Token-Authentifizierung mit eigener Kontenverwaltung bleibt in TP-A unverändert (Ablösung durch j-lawyer-Login ist TP-B).

**Tech Stack:** SvelteKit 2 + Svelte 5 (Runes), Fastify 5 + `@fastify/static`, better-sqlite3, pdfjs-dist, Vitest (+ `fake-indexeddb` für IndexedDB-Tests).

**Spec:** `docs/superpowers/specs/2026-07-17-browser-jlawyer-rework-design.md`

## Global Constraints

- Node ≥ 20; Repo ist ein npm-Workspace-Monorepo (`packages/core`, `packages/server`, `packages/mcp` + Wurzel-Client).
- UI-Texte, Code-Kommentare und Commit-Messages auf Deutsch (bestehender Stil: `feat: …`, `fix: …`, `docs: …`).
- Alle API-Pfade des Clients relativ: `/api/v1/...` — nirgends eine konfigurierbare Server-URL im Client.
- `ssr = false` bleibt (SPA mit `adapter-static`, Fallback `index.html`).
- Tests: `npm test` (Vitest, environment `node`) muss nach jedem Task grün sein. Typprüfung `npm run check`: Während des Umbaus (Tasks 4–7) dürfen ausschließlich die noch nicht umgebauten Dateien mit Tauri-Importen Fehler melden; ab Task 8 muss `npm run check` vollständig grün sein.
- `packages/mcp` wird in TP-A NICHT angefasst.
- Keine neuen Laufzeit-Abhängigkeiten außer `@fastify/static`; `fake-indexeddb` nur als devDependency.

---

### Task 1: Server liefert die Web-App aus

**Files:**
- Modify: `packages/server/src/app.ts` (Auth-Hook Zeilen 36–44, Registrierungen Zeilen 31–34)
- Modify: `packages/server/src/main.ts`
- Modify: `packages/server/package.json` (Dependency)
- Modify: `packages/server/Dockerfile`
- Test: `packages/server/src/static.test.ts` (neu)

**Interfaces:**
- Consumes: `buildApp({ db, dataDir })` aus `app.ts` (bestehend).
- Produces: `buildApp({ db, dataDir, webDir? })` — `webDir?: string`; wenn gesetzt, wird dieses Verzeichnis unter `/` ausgeliefert, unbekannte Nicht-`/api/`-GET-Pfade liefern `index.html` (SPA-Fallback). Der Auth-Hook gilt nur noch für Pfade, die mit `/api/` beginnen.

- [ ] **Step 1: Dependency installieren**

```bash
npm install -w @digital-desktop/server @fastify/static
```

- [ ] **Step 2: Failing Test schreiben** — `packages/server/src/static.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { openDb, type Db } from './db';
import { buildApp } from './app';

describe('statische Auslieferung der Web-App', () => {
  let dir: string;
  let db: Db;
  let app: FastifyInstance;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'dd-static-'));
    const webDir = join(dir, 'web');
    mkdirSync(webDir);
    writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>DD</title>');
    db = openDb(join(dir, 'test.sqlite'));
    app = await buildApp({ db, dataDir: dir, webDir });
  });

  afterEach(async () => {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('liefert index.html unter / ohne Anmeldung', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<title>DD</title>');
  });

  it('liefert index.html als SPA-Fallback für unbekannte Pfade', async () => {
    const res = await app.inject({ method: 'GET', url: '/irgendwas/tiefes' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<title>DD</title>');
  });

  it('schützt /api/ weiterhin: ohne Token 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/desks' });
    expect(res.statusCode).toBe(401);
  });

  it('liefert für unbekannte /api/-Pfade 404 statt index.html', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/gibtsnicht', headers: {} });
    expect([401, 404]).toContain(res.statusCode); // Auth-Hook greift vor dem Routing
  });

  it('funktioniert ohne webDir wie bisher (kein Fallback)', async () => {
    const bare = await buildApp({ db, dataDir: dir });
    const res = await bare.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(404);
    await bare.close();
  });
});
```

(`openDb(path: string): Db` und `Db = Database.Database` mit `.close()` sind in `packages/server/src/db.ts` so definiert — verifiziert.)

- [ ] **Step 3: Test laufen lassen — muss fehlschlagen**

Run: `npx vitest run packages/server/src/static.test.ts`
Expected: FAIL (`webDir` unbekannt / `/` liefert 404 statt index.html)

- [ ] **Step 4: Implementierung in `app.ts`**

`AppOptions` erweitern und den Auth-Hook auf `/api/` begrenzen:

```ts
import fastifyStatic from '@fastify/static';

export interface AppOptions {
  db: Db;
  dataDir: string;
  webDir?: string;
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
  // ... Rest unverändert
```

- [ ] **Step 5: `main.ts` erweitern**

```ts
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db';
import { rotateBackup } from './backup';
import { buildApp } from './app';

const port = Number(process.env.PORT ?? 4810);
const dataDir = process.env.DATA_DIR ?? join(process.cwd(), 'data');
const webDir =
  process.env.WEB_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'build');

mkdirSync(dataDir, { recursive: true });
rotateBackup(dataDir); // vor dem Öffnen der DB — kein WAL-Zwischenstand im Backup
const db = openDb(join(dataDir, 'desktop.sqlite'));

const app = await buildApp({ db, dataDir, ...(existsSync(webDir) ? { webDir } : {}) });
await app.listen({ port, host: '0.0.0.0' });
console.log(
  `Digital-Desktop-Server läuft auf Port ${port} (Daten: ${dataDir}${existsSync(webDir) ? `, Web-App: ${webDir}` : ', ohne Web-App'})`,
);
```

- [ ] **Step 6: Tests laufen lassen — müssen bestehen**

Run: `npx vitest run packages/server/src/static.test.ts && npm test`
Expected: PASS (alle)

- [ ] **Step 7: Dockerfile auf zweistufigen Build umstellen** — `packages/server/Dockerfile`:

```dockerfile
FROM node:22-slim AS webbuild
WORKDIR /app
COPY package.json package-lock.json svelte.config.js vite.config.js tsconfig.json ./
COPY packages ./packages
COPY src ./src
COPY static ./static
RUN npm ci && npm run build

FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages ./packages
RUN npm ci --omit=dev --workspace @digital-desktop/server --include-workspace-root=false
COPY --from=webbuild /app/build ./build
ENV PORT=4810 DATA_DIR=/data WEB_DIR=/app/build
VOLUME /data
EXPOSE 4810
CMD ["npx", "tsx", "packages/server/src/main.ts"]
```

(Der Docker-Build wird in Task 10 verifiziert; hier nur die Datei ändern.)

- [ ] **Step 8: Commit**

```bash
git add packages/server package.json package-lock.json
git commit -m "feat(server): Web-App statisch ausliefern mit SPA-Fallback"
```

---

### Task 2: v1-Import entfernen

Der v1-Import las lokale Tauri-Dateien vom Mac — im Browser gegenstandslos, und laut Spec gibt es keine Altdaten-Migration.

**Files:**
- Delete: `src/lib/importV1.ts`, `src/lib/importV1.test.ts`
- Modify: `src/routes/+page.svelte` (Import Zeile 10, Aufruf Zeile 19)

**Interfaces:**
- Consumes: nichts.
- Produces: nichts — `maybeOfferV1Import` existiert danach nicht mehr; kein anderer Code außer `+page.svelte` referenziert das Modul.

- [ ] **Step 1: Dateien löschen und Aufruf entfernen**

```bash
git rm src/lib/importV1.ts src/lib/importV1.test.ts
```

In `src/routes/+page.svelte` die Zeile `import { maybeOfferV1Import } from '../lib/importV1';` und die Zeile `void maybeOfferV1Import(api);` entfernen.

- [ ] **Step 2: Verifizieren**

Run: `npm test && grep -rn "importV1" src packages && echo LEER`
Expected: Tests PASS; grep liefert keine Treffer (Ausgabe endet mit `LEER`; grep-Exit ≠ 0 ist hier gewollt — bei Treffern erscheint kein `LEER`).

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: v1-Import entfernt (Browser-Betrieb, keine Altdaten-Migration)"
```

---

### Task 3: api.ts auf natives fetch und relative URLs

**Files:**
- Modify: `src/lib/api.ts`
- Test: `src/lib/api.test.ts` (neu)

**Interfaces:**
- Consumes: nichts Neues.
- Produces: `class ApiClient { constructor(public baseUrl = '', public token: string | null = null) }` — alle bisherigen Methoden signaturgleich. `wsUrl(deskId: string): string` liefert bei leerem `baseUrl` eine absolute `ws(s)://`-URL auf Basis von `location.origin`. Spätere Tasks erzeugen den Client als `new ApiClient('', token)`.

- [ ] **Step 1: Failing Test schreiben** — `src/lib/api.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ApiClient } from './api';

afterEach(() => vi.unstubAllGlobals());

describe('ApiClient.wsUrl', () => {
  it('baut aus expliziter http-Basis eine ws-URL mit Token', () => {
    expect(new ApiClient('http://x:4810', 'tok').wsUrl('d1')).toBe(
      'ws://x:4810/api/v1/desks/d1/ws?token=tok',
    );
  });

  it('baut aus https-Basis eine wss-URL', () => {
    expect(new ApiClient('https://kanzlei.example', 'tok').wsUrl('d1')).toBe(
      'wss://kanzlei.example/api/v1/desks/d1/ws?token=tok',
    );
  });

  it('nutzt bei leerer Basis den Origin der Seite', () => {
    vi.stubGlobal('location', { origin: 'https://kanzlei.example' });
    expect(new ApiClient('', 'tok').wsUrl('d1')).toBe(
      'wss://kanzlei.example/api/v1/desks/d1/ws?token=tok',
    );
  });
});
```

- [ ] **Step 2: Test laufen lassen — muss fehlschlagen**

Run: `npx vitest run src/lib/api.test.ts`
Expected: FAIL — der Import von `@tauri-apps/plugin-http` schlägt in Node fehl bzw. `wsUrl` liefert `/api/...` ohne Origin.

- [ ] **Step 3: Implementierung**

In `src/lib/api.ts`:
1. Zeile 1 (`import { fetch } from '@tauri-apps/plugin-http';`) ersatzlos löschen — natives `fetch` ist global.
2. Konstruktor ändern zu `constructor(public baseUrl = '', public token: string | null = null) {}`.
3. `wsUrl` ersetzen durch:

```ts
  wsUrl(deskId: string): string {
    const base = this.baseUrl || location.origin;
    return `${base.replace(/^http/, 'ws')}/api/v1/desks/${deskId}/ws?token=${this.token ?? ''}`;
  }
```

Alles andere (request, uploadFile, fetchFile, …) bleibt unverändert — die Aufrufe nutzen bereits das Standard-`fetch`-Interface.

- [ ] **Step 4: Tests laufen lassen — müssen bestehen**

Run: `npx vitest run src/lib/api.test.ts && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/api.ts src/lib/api.test.ts
git commit -m "feat: ApiClient auf natives fetch und Same-Origin-Standard umgestellt"
```

---

### Task 4: Sitzung in localStorage, Anmeldung ohne Server-URL

**Files:**
- Modify: `src/lib/session.ts` (komplett neu, siehe unten)
- Modify: `src/lib/session.test.ts`
- Modify: `src/lib/components/LoginScreen.svelte`
- Modify: `src/routes/+page.svelte`

**Interfaces:**
- Consumes: `ApiClient` mit `baseUrl`-Default `''` (Task 3).
- Produces: `interface Session { token: string; lastDeskId?: string }` (ohne `serverUrl`!) und synchrone Funktionen `parseSession(json: string): Session | null`, `loadSession(): Session | null`, `saveSession(s: Session): void`, `clearSession(): void`, `saveLastDeskId(deskId: string): void`. Task 5 ruft `saveLastDeskId` synchron auf.

- [ ] **Step 1: Failing Tests schreiben** — `src/lib/session.test.ts` komplett ersetzen:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseSession, loadSession, saveSession, clearSession, saveLastDeskId } from './session';

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('parseSession', () => {
  it('liest eine gültige Sitzung', () => {
    expect(parseSession('{"token":"abc"}')).toEqual({ token: 'abc' });
  });

  it('liefert null bei kaputtem JSON oder falscher Struktur', () => {
    expect(parseSession('{ kaputt')).toBeNull();
    expect(parseSession('null')).toBeNull();
    expect(parseSession('{"token":5}')).toBeNull();
  });

  it('liest lastDeskId, verwirft falsch typisiertes lastDeskId', () => {
    expect(parseSession('{"token":"abc","lastDeskId":"d1"}')).toEqual({ token: 'abc', lastDeskId: 'd1' });
    expect(parseSession('{"token":"abc","lastDeskId":5}')).toEqual({ token: 'abc' });
  });
});

describe('load/save/clear', () => {
  it('speichert und lädt über localStorage', () => {
    saveSession({ token: 'abc' });
    expect(loadSession()).toEqual({ token: 'abc' });
    clearSession();
    expect(loadSession()).toBeNull();
  });

  it('saveLastDeskId ergänzt die bestehende Sitzung und tut ohne Sitzung nichts', () => {
    saveLastDeskId('d9'); // keine Sitzung — kein Fehler
    expect(loadSession()).toBeNull();
    saveSession({ token: 'abc' });
    saveLastDeskId('d9');
    expect(loadSession()).toEqual({ token: 'abc', lastDeskId: 'd9' });
  });
});
```

- [ ] **Step 2: Test laufen lassen — muss fehlschlagen**

Run: `npx vitest run src/lib/session.test.ts`
Expected: FAIL (Import von `@tauri-apps/plugin-fs` bzw. altes `Session`-Format mit `serverUrl`)

- [ ] **Step 3: `src/lib/session.ts` komplett ersetzen**

```ts
export interface Session {
  token: string;
  lastDeskId?: string;
}

const KEY = 'digital-desktop.session';

export function parseSession(json: string): Session | null {
  try {
    const v = JSON.parse(json) as Session | null;
    if (!v || typeof v.token !== 'string') return null;
    return {
      token: v.token,
      ...(typeof v.lastDeskId === 'string' ? { lastDeskId: v.lastDeskId } : {}),
    };
  } catch {
    return null;
  }
}

export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? parseSession(raw) : null;
  } catch {
    return null; // z. B. localStorage gesperrt — wie nicht vorhanden behandeln
  }
}

export function saveSession(session: Session): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(session));
  } catch {
    // Speichern ist Komfort — Anmeldung funktioniert auch ohne
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // bereits weg
  }
}

/** Merkt sich den zuletzt aktiven Schreibtisch (pro Browser). */
export function saveLastDeskId(deskId: string): void {
  const session = loadSession();
  if (session) saveSession({ ...session, lastDeskId: deskId });
}
```

- [ ] **Step 4: Tests laufen lassen — müssen bestehen**

Run: `npx vitest run src/lib/session.test.ts`
Expected: PASS

- [ ] **Step 5: `LoginScreen.svelte` anpassen** — Server-URL-Feld entfällt; Script-Block ersetzen:

```svelte
<script lang="ts">
  import { onMount } from 'svelte';
  import { ApiClient, ApiError } from '../api';
  import { saveSession, type Session } from '../session';

  let { onConnected }: { onConnected: (s: Session) => Promise<void> } = $props();

  let username = $state('');
  let password = $state('');
  let needsSetup = $state<boolean | null>(null);
  let error = $state('');
  let busy = $state(false);

  onMount(() => void checkServer());

  async function checkServer(): Promise<void> {
    error = '';
    try {
      needsSetup = (await new ApiClient().status()).needsSetup;
    } catch {
      error = 'Server nicht erreichbar — später erneut versuchen';
    }
  }

  async function submit(): Promise<void> {
    busy = true;
    error = '';
    try {
      if (needsSetup === null) await checkServer();
      const api = new ApiClient();
      if (needsSetup) await api.setup(username, password);
      else await api.login(username, password);
      const session = { token: api.token! };
      saveSession(session);
      await onConnected(session);
    } catch (e) {
      error = e instanceof ApiError ? e.message : 'Verbindung fehlgeschlagen';
    } finally {
      busy = false;
    }
  }
</script>
```

Im Markup: das `<label>Server-URL …</label>` entfernen; der `disabled`-Ausdruck des Buttons wird `disabled={busy || !username || !password}`. Styles unverändert.

- [ ] **Step 6: `+page.svelte` von Tauri befreien** — Script-Block ersetzen (Markup und Styles bleiben):

```svelte
<script lang="ts">
  import { onMount } from 'svelte';
  import Desktop from '../lib/components/Desktop.svelte';
  import LoginScreen from '../lib/components/LoginScreen.svelte';
  import { desktop } from '../lib/store.svelte';
  import { ApiClient, ApiError } from '../lib/api';
  import { loadSession, clearSession, type Session } from '../lib/session';

  let phase = $state<'loading' | 'login' | 'desk'>('loading');

  async function connect(session: Session): Promise<void> {
    const api = new ApiClient('', session.token);
    await desktop.start(api, session.lastDeskId);
    phase = 'desk';
  }

  onMount(async () => {
    window.addEventListener('contextmenu', (e) => e.preventDefault());
    const session = loadSession();
    if (!session) {
      phase = 'login';
      return;
    }
    try {
      await connect(session);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) clearSession();
      phase = 'login';
    }
  });
</script>

{#if phase === 'login'}
  <LoginScreen onConnected={connect} />
{:else if phase === 'desk'}
  <Desktop />
{/if}

<style>
  :global(html, body) { margin: 0; height: 100%; overflow: hidden; }
</style>
```

(Damit entfallen: Tauri-Menü, `getCurrentWindow`, `initialServerUrl`, `lastServerUrl`.)

- [ ] **Step 7: Typprüfung und Tests**

Run: `npm run check && npm test`
Expected: `svelte-check` meldet Fehler nur noch in `store.svelte.ts`, `fileCache.ts`, `thumbnails.ts`, `menus.ts`, `Desktop.svelte`, `DeskSwitcher.svelte` (Tauri-Importe — kommen in Tasks 5–8 dran); `session.ts`/`LoginScreen`/`+page` fehlerfrei. Vitest: PASS. Falls `npm run check` wegen der noch nicht umgebauten Dateien insgesamt fehlschlägt, ist das hier akzeptiert — die verbleibenden Fehler müssen ausschließlich Tauri-Importe der späteren Tasks betreffen.

- [ ] **Step 8: Commit**

```bash
git add src/lib/session.ts src/lib/session.test.ts src/lib/components/LoginScreen.svelte src/routes/+page.svelte
git commit -m "feat: Sitzung in localStorage, Anmeldung ohne Server-URL (Same-Origin)"
```

---

### Task 5: store.svelte.ts auf nativen WebSocket

**Files:**
- Modify: `src/lib/store.svelte.ts`

**Interfaces:**
- Consumes: `api.wsUrl(deskId)` (Task 3), `saveLastDeskId` synchron (Task 4).
- Produces: `desktop`-Objekt mit unveränderter öffentlicher API (`state`, `status`, `api`, `deskId`, `desks`, `start`, `applyLocal`, `command`, `refresh`, `switchDesk`, `createDesk`, `renameDesk`, `deleteDesk`, `stop`). Nur die interne Transportschicht ändert sich.

- [ ] **Step 1: Umbau**

In `src/lib/store.svelte.ts`:

1. Zeile 1 löschen: `import WebSocket from '@tauri-apps/plugin-websocket';` (der native `WebSocket` ist global).
2. Deklaration ändern: `let ws: WebSocket | null = null;`
3. `stop()` ändern — `disconnect` gibt es nicht:

```ts
  async stop(): Promise<void> {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    stopped = true;
    status = 'loggedOut';
    ws?.close();
    ws = null;
  },
```

4. `loadDesk` — `saveLastDeskId` ist jetzt synchron, `connectWs` auch:

```ts
/** Lädt Zustand + rev des Schreibtischs und verbindet den WebSocket. */
async function loadDesk(id: string): Promise<void> {
  if (!api) return;
  deskId = id;
  const result = await api.getState(id);
  rev = result.rev; // Zähler gehört zum neuen Schreibtisch — nicht vergleichen
  state = result.state;
  saveLastDeskId(id);
  connectWs();
}
```

5. `closeWs` und `connectWs` komplett ersetzen:

```ts
/** Trennt den aktuellen Socket und invalidiert dessen Listener (Generationswechsel). */
function closeWs(): void {
  wsGeneration++;
  clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  const socket = ws;
  ws = null;
  socket?.close();
}

function connectWs(): void {
  if (!api || !deskId || stopped) return;
  const generation = ++wsGeneration;
  let socket: WebSocket;
  try {
    socket = new WebSocket(api.wsUrl(deskId));
  } catch {
    onDisconnected();
    return;
  }
  socket.onopen = () => {
    if (generation !== wsGeneration) {
      // Während des Verbindens wurde gewechselt/geschlossen — diesen Socket verwerfen.
      socket.close();
      return;
    }
    ws = socket;
    reconnectDelay = 1000;
    status = 'online';
  };
  socket.onmessage = (ev) => {
    if (generation !== wsGeneration) return;
    const data = JSON.parse(ev.data as string) as { rev: number; state: DesktopState };
    if (data.rev >= rev) {
      rev = data.rev;
      state = data.state;
    }
  };
  socket.onclose = () => {
    // Der native WebSocket feuert onclose auch nach onerror und nach fehlgeschlagenem
    // Verbindungsaufbau — ein einziger Einstiegspunkt für die Reconnect-Logik.
    if (generation === wsGeneration) onDisconnected();
  };
}
```

6. Alle `await closeWs();`-Aufrufe (in `switchDesk` und `deleteDesk`) durch `closeWs();` ersetzen; `await connectWs();` gibt es nach dem Umbau von `loadDesk` nicht mehr. `onDisconnected` bleibt unverändert (der Guard `reconnectTimer !== undefined` fängt Doppel-Feuer ab, z. B. `onclose` nach explizitem `closeWs`).

- [ ] **Step 2: Verifizieren**

Run: `npm test && grep -n "tauri" src/lib/store.svelte.ts && echo TREFFER || echo SAUBER`
Expected: Tests PASS; Ausgabe endet mit `SAUBER`.

- [ ] **Step 3: Commit**

```bash
git add src/lib/store.svelte.ts
git commit -m "feat: Live-Sync über nativen WebSocket statt Tauri-Plugin"
```

---

### Task 6: IndexedDB-Cache für PDFs und Miniaturen

**Files:**
- Create: `src/lib/idb.ts`
- Test: `src/lib/idb.test.ts` (neu)
- Modify: `src/lib/fileCache.ts` (komplett neu)
- Test: `src/lib/fileCache.test.ts` (neu)
- Modify: `src/lib/thumbnails.ts`

**Interfaces:**
- Consumes: `ApiClient.fetchFile(fileId): Promise<Uint8Array>` (bestehend).
- Produces:
  - `idb.ts`: `FILE_STORE: string`, `THUMB_STORE: string`, `idbGet(store: string, key: string): Promise<Uint8Array | null>`, `idbPut(store: string, key: string, bytes: Uint8Array): Promise<void>`, `trimStore(store: string, max: number): Promise<void>`.
  - `fileCache.ts`: `getFileUrl(api: ApiClient, fileId: string): Promise<string>` — Objekt-URL der PDF (ersetzt das bisherige `ensureCached`, das einen Dateipfad lieferte). Task 7 nutzt genau diese Funktion.
  - `thumbnails.ts`: `getThumbnail(api: ApiClient, doc: Doc): Promise<string | null>` (Signatur unverändert).

- [ ] **Step 1: Dev-Dependency installieren**

```bash
npm install -D fake-indexeddb
```

- [ ] **Step 2: Failing Test schreiben** — `src/lib/idb.test.ts`:

```ts
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { idbGet, idbPut, trimStore, FILE_STORE } from './idb';

describe('idb', () => {
  it('liefert null für unbekannte Schlüssel', async () => {
    expect(await idbGet(FILE_STORE, 'gibtsnicht')).toBeNull();
  });

  it('speichert und liest Bytes', async () => {
    await idbPut(FILE_STORE, 'a', new Uint8Array([1, 2, 3]));
    expect(await idbGet(FILE_STORE, 'a')).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('verdrängt beim Trimmen die ältesten Einträge', async () => {
    await idbPut(FILE_STORE, 'alt', new Uint8Array([1]));
    await new Promise((r) => setTimeout(r, 5)); // ts-Auflösung
    await idbPut(FILE_STORE, 'neu', new Uint8Array([2]));
    await trimStore(FILE_STORE, 1);
    expect(await idbGet(FILE_STORE, 'alt')).toBeNull();
    expect(await idbGet(FILE_STORE, 'neu')).toEqual(new Uint8Array([2]));
  });
});
```

- [ ] **Step 3: Test laufen lassen — muss fehlschlagen**

Run: `npx vitest run src/lib/idb.test.ts`
Expected: FAIL (`./idb` existiert nicht)

- [ ] **Step 4: `src/lib/idb.ts` anlegen**

```ts
const DB_NAME = 'digital-desktop';
const DB_VERSION = 1;
export const FILE_STORE = 'files';
export const THUMB_STORE = 'thumbnails';
/** Obergrenze pro Store; ältester Eintrag fliegt zuerst. */
const MAX_ENTRIES = 200;

interface Entry {
  bytes: Uint8Array;
  ts: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      for (const store of [FILE_STORE, THUMB_STORE]) {
        if (!req.result.objectStoreNames.contains(store)) req.result.createObjectStore(store);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB nicht verfügbar'));
  });
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const request = fn(db.transaction(store, mode).objectStore(store));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB-Zugriff fehlgeschlagen'));
      }),
  );
}

export async function idbGet(store: string, key: string): Promise<Uint8Array | null> {
  const entry = await tx<Entry | undefined>(store, 'readonly', (s) => s.get(key) as IDBRequest<Entry | undefined>);
  return entry?.bytes ?? null;
}

export async function idbPut(store: string, key: string, bytes: Uint8Array): Promise<void> {
  await tx(store, 'readwrite', (s) => s.put({ bytes, ts: Date.now() } satisfies Entry, key));
  await trimStore(store, MAX_ENTRIES);
}

/** Verdrängung nach Alter: behält höchstens `max` Einträge, löscht die ältesten. */
export async function trimStore(store: string, max: number): Promise<void> {
  const [keys, entries] = await Promise.all([
    tx<IDBValidKey[]>(store, 'readonly', (s) => s.getAllKeys()),
    tx<Entry[]>(store, 'readonly', (s) => s.getAll() as IDBRequest<Entry[]>),
  ]);
  if (keys.length <= max) return;
  const byAge = keys.map((key, i) => ({ key, ts: entries[i]?.ts ?? 0 })).sort((a, b) => a.ts - b.ts);
  for (const { key } of byAge.slice(0, keys.length - max)) {
    await tx(store, 'readwrite', (s) => s.delete(key));
  }
}
```

- [ ] **Step 5: idb-Tests laufen lassen — müssen bestehen**

Run: `npx vitest run src/lib/idb.test.ts`
Expected: PASS

- [ ] **Step 6: Failing Test für fileCache** — `src/lib/fileCache.test.ts`:

```ts
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getFileUrl } from './fileCache';
import type { ApiClient } from './api';

let objectUrlCounter = 0;
beforeEach(() => {
  objectUrlCounter = 0;
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: () => `blob:test-${objectUrlCounter++}`,
  });
});

describe('getFileUrl', () => {
  it('lädt einmal vom Server und beantwortet Folgeaufrufe aus dem Cache', async () => {
    const fetchFile = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));
    const api = { fetchFile } as unknown as ApiClient;
    const url1 = await getFileUrl(api, 'file-cache-test-1');
    const url2 = await getFileUrl(api, 'file-cache-test-1');
    expect(url1).toBe(url2);
    expect(fetchFile).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 7: Test laufen lassen — muss fehlschlagen**

Run: `npx vitest run src/lib/fileCache.test.ts`
Expected: FAIL (`getFileUrl` existiert nicht / Tauri-Import bricht)

- [ ] **Step 8: `src/lib/fileCache.ts` komplett ersetzen**

```ts
import { FILE_STORE, idbGet, idbPut } from './idb';
import type { ApiClient } from './api';

const urls = new Map<string, string>();

/** Objekt-URL der PDF; lädt einmalig vom Server und hält die Bytes in IndexedDB. */
export async function getFileUrl(api: ApiClient, fileId: string): Promise<string> {
  const known = urls.get(fileId);
  if (known) return known;
  let bytes = await idbGet(FILE_STORE, fileId).catch(() => null);
  if (!bytes) {
    bytes = await api.fetchFile(fileId);
    await idbPut(FILE_STORE, fileId, bytes).catch(() => {}); // Cache ist Komfort
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  urls.set(fileId, url);
  return url;
}
```

- [ ] **Step 9: `src/lib/thumbnails.ts` auf IndexedDB umstellen** — komplett ersetzen:

```ts
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { Doc } from '@digital-desktop/core';
import type { ApiClient } from './api';
import { THUMB_STORE, idbGet, idbPut } from './idb';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const urls = new Map<string, string>();

function remember(fileId: string, bytes: Uint8Array): string {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
  urls.set(fileId, url);
  return url;
}

/** Object-URL der Miniatur der ersten Seite (PNG-Cache pro fileId); null, wenn nicht renderbar. */
export async function getThumbnail(api: ApiClient, doc: Doc): Promise<string | null> {
  const cached = urls.get(doc.fileId);
  if (cached) return cached;
  try {
    const stored = await idbGet(THUMB_STORE, doc.fileId).catch(() => null);
    if (stored) return remember(doc.fileId, stored);
    const data = await api.fetchFile(doc.fileId);
    const pdf = await pdfjs.getDocument({ data }).promise;
    const page = await pdf.getPage(1);
    const scale = 360 / page.getViewport({ scale: 1 }).width;
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport }).promise;
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob fehlgeschlagen'))), 'image/png'),
    );
    const bytes = new Uint8Array(await blob.arrayBuffer());
    await idbPut(THUMB_STORE, doc.fileId, bytes).catch(() => {});
    return remember(doc.fileId, bytes);
  } catch {
    return null; // defekt oder (noch) nicht ladbar → generisches Symbol
  }
}
```

- [ ] **Step 10: Tests laufen lassen — müssen bestehen**

Run: `npm test`
Expected: PASS (inkl. idb- und fileCache-Tests)

- [ ] **Step 11: Commit**

```bash
git add src/lib/idb.ts src/lib/idb.test.ts src/lib/fileCache.ts src/lib/fileCache.test.ts src/lib/thumbnails.ts package.json package-lock.json
git commit -m "feat: PDF- und Miniatur-Cache in IndexedDB statt Tauri-Dateisystem"
```

---

### Task 7: Öffnen und Herunterladen im Browser (menus.ts)

**Files:**
- Modify: `src/lib/menus.ts`

**Interfaces:**
- Consumes: `getFileUrl(api, fileId)` aus Task 6.
- Produces: `openDoc`, `openWithLinked`, `downloadDoc`, `showDocMenu`, `showStackMenu` — Signaturen unverändert (werden von `DocCard.svelte`/`StackCard.svelte` aufgerufen).

- [ ] **Step 1: Umbau** — in `src/lib/menus.ts` die Zeilen 1–3 (Tauri-Importe) und den `ensureCached`-Import ersetzen durch:

```ts
import { collectLinkedDocs, type Doc, type Stack } from '@digital-desktop/core';
import { desktop } from './store.svelte';
import { ui, showToast } from './ui.svelte';
import { getFileUrl } from './fileCache';
```

`openDoc` und `downloadDoc` ersetzen:

```ts
export async function openDoc(doc: Doc): Promise<void> {
  if (!desktop.api) return;
  // Fenster synchron zur Nutzergeste öffnen, sonst greift der Popup-Blocker.
  const win = window.open('', '_blank');
  try {
    const url = await getFileUrl(desktop.api, doc.fileId);
    if (win) win.location.href = url;
    else window.open(url, '_blank');
  } catch (e) {
    win?.close();
    showToast(e instanceof Error ? e.message : 'Öffnen fehlgeschlagen');
  }
}

export async function downloadDoc(doc: Doc): Promise<void> {
  if (!desktop.api) return;
  try {
    const a = document.createElement('a');
    a.href = await getFileUrl(desktop.api, doc.fileId);
    a.download = doc.name;
    a.click();
    showToast(`Heruntergeladen: ${doc.name}`);
  } catch (e) {
    showToast(e instanceof Error ? e.message : 'Herunterladen fehlgeschlagen');
  }
}
```

`openWithLinked`, `showDocMenu`, `showStackMenu` bleiben unverändert. Bekannte, akzeptierte Einschränkung: Bei „Mit allen Verknüpften öffnen" blockieren Browser ggf. alle Tabs außer dem ersten (Popup-Blocker) — kein Workaround in TP-A.

- [ ] **Step 2: Verifizieren**

Run: `npm test && grep -n "tauri" src/lib/menus.ts && echo TREFFER || echo SAUBER`
Expected: PASS; `SAUBER`.

- [ ] **Step 3: Commit**

```bash
git add src/lib/menus.ts
git commit -m "feat: PDFs im Browser-Tab öffnen und per Anker-Download speichern"
```

---

### Task 8: Upload per Dateiauswahl und Drag-and-drop (Desktop.svelte, DeskSwitcher.svelte)

**Files:**
- Modify: `src/lib/components/Desktop.svelte`
- Modify: `src/lib/components/DeskSwitcher.svelte`

**Interfaces:**
- Consumes: `desktop.api.uploadFile(bytes, name)`, `desktop.command('addDoc', …)` (bestehend).
- Produces: nichts Neues nach außen.

- [ ] **Step 1: `Desktop.svelte` umbauen**

Importe: `open as openDialog` (plugin-dialog), `readFile` (plugin-fs), `getCurrentWebview` (api/webview) entfernen. `addPdfFromPath` und `addViaDialog` ersetzen durch:

```ts
  let fileInput: HTMLInputElement;

  async function addPdfFile(file: File, position: Vec2): Promise<void> {
    if (!desktop.api) return;
    try {
      const fileId = await desktop.api.uploadFile(new Uint8Array(await file.arrayBuffer()), file.name);
      await desktop.command('addDoc', { fileId, name: file.name, position, id: crypto.randomUUID() });
    } catch (e) {
      showToast(e instanceof Error ? e.message : `Upload fehlgeschlagen: ${file.name}`);
    }
  }

  function onFilesPicked(): void {
    const files = Array.from(fileInput.files ?? []);
    fileInput.value = '';
    const center = screenToWorld(vp, { x: el.clientWidth / 2, y: el.clientHeight / 2 });
    files.forEach((f, i) => void addPdfFile(f, { x: center.x + i * 28, y: center.y + i * 20 }));
  }

  function onDragOver(e: DragEvent): void {
    e.preventDefault();
  }

  function onDrop(e: DragEvent): void {
    e.preventDefault();
    const files = Array.from(e.dataTransfer?.files ?? []).filter(
      (f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'),
    );
    const world = screenToWorld(vp, { x: e.clientX, y: e.clientY });
    files.forEach((f, i) => void addPdfFile(f, { x: world.x + i * 28, y: world.y + i * 20 }));
  }
```

Im `onMount` den kompletten `getCurrentWebview().onDragDropEvent(...)`-Block samt `unlisten`-Variable und deren Cleanup entfernen (die Tastatur-Listener bleiben).

Im Markup: am `.desk`-Div `ondragover={onDragOver} ondrop={onDrop}` ergänzen; in der Toolbar den Button ersetzen und das versteckte Input ergänzen:

```svelte
  <div class="toolbar">
    <input
      bind:this={fileInput}
      type="file"
      accept="application/pdf,.pdf"
      multiple
      hidden
      onchange={onFilesPicked}
    />
    <button onclick={() => fileInput.click()} title="PDF hinzufügen">＋ PDF</button>
    <button onclick={fitAll}>Übersicht</button>
  </div>
```

- [ ] **Step 2: `DeskSwitcher.svelte`** — Zeile 2 (`import { ask } …`) löschen; in `loeschen()`:

```ts
  async function loeschen() {
    if (!desktop.deskId || !aktiv) return;
    const ja = confirm(
      `„${aktiv.name}" löschen? Karten und Verknüpfungen dieses Schreibtischs werden entfernt. Die PDF-Dateien bleiben in der Server-Ablage erhalten.`,
    );
    if (ja) {
      await desktop.deleteDesk(desktop.deskId);
      open = false;
    }
  }
```

- [ ] **Step 3: Verifizieren — jetzt muss ALLES Tauri-frei sein**

Run: `npm run check && npm test && grep -rn "@tauri-apps" src && echo TREFFER || echo SAUBER`
Expected: `svelte-check` 0 Fehler; Vitest PASS; `SAUBER`.

- [ ] **Step 4: Commit**

```bash
git add src/lib/components/Desktop.svelte src/lib/components/DeskSwitcher.svelte
git commit -m "feat: PDF-Upload per Dateiauswahl und HTML5-Drag-and-drop"
```

---

### Task 9: Tauri-Reste entfernen, Dev-Proxy einrichten, README

**Files:**
- Delete: `src-tauri/` (komplett)
- Modify: `package.json` (Wurzel: dependencies, devDependencies, scripts)
- Modify: `vite.config.js`
- Modify: `src/routes/+layout.ts` (nur Kommentar)
- Modify: `README.md`

**Interfaces:**
- Consumes: Task 1 (Server liefert `build/` aus).
- Produces: `npm run dev` (Vite mit Proxy auf `localhost:4810`) und `npm run build` (statisches `build/`) als einzige Client-Workflows.

- [ ] **Step 1: Tauri-Pakete und -Verzeichnis entfernen**

```bash
npm uninstall @tauri-apps/api @tauri-apps/plugin-dialog @tauri-apps/plugin-fs @tauri-apps/plugin-http @tauri-apps/plugin-opener @tauri-apps/plugin-websocket
npm uninstall -D @tauri-apps/cli
git rm -r src-tauri
```

In `package.json` (Wurzel) das Script `"tauri": "tauri"` löschen.

- [ ] **Step 2: `vite.config.js` ersetzen**

```js
import { defineConfig } from "vite";
import { sveltekit } from "@sveltejs/kit/vite";

export default defineConfig({
  plugins: [sveltekit()],
  server: {
    // Entwicklung: Vite unter :5173, API und WebSocket laufen auf dem Server unter :4810.
    proxy: {
      "/api": { target: "http://localhost:4810", ws: true },
    },
  },
});
```

- [ ] **Step 3: Kommentar in `src/routes/+layout.ts` anpassen**

```ts
// SPA-Modus: Der Server liefert index.html als Fallback aus (adapter-static),
// gerendert wird ausschließlich im Browser.
export const ssr = false;
```

- [ ] **Step 4: README aktualisieren** — Abschnitte „Struktur"/„Entwicklung"/„Server im Heimnetz" anpassen:

```markdown
# Digital Desktop

Ein grafischer Schreibtisch für PDF-Dateien: Karten frei anordnen, verknüpfen, stapeln —
als Web-App im Browser, ausgeliefert von einem Server im Netzwerk (Node + SQLite).

## Struktur

- `packages/core` — pure Zustandslogik (von Server und Client genutzt)
- `packages/server` — HTTP-API + WebSocket + SQLite + PDF-Ablage + Auslieferung der Web-App
- Wurzel — Web-Client (SvelteKit/Svelte, statisch gebaut)

## Entwicklung

    npm install
    npm run server        # Server auf http://localhost:4810 (Daten: packages/server/data/)
    npm run dev           # Client mit Proxy auf den Server (zweites Terminal)
    npm test              # alle Tests (core + server + Client-Module)

Beim ersten Start legt die App über die Ersteinrichtungs-Maske das erste Konto an.

## Betrieb

    npm run build         # Web-App nach build/
    PORT=4810 DATA_DIR=/pfad/zu/daten npm run server

Der Server liefert die gebaute Web-App unter http://<host>:4810 aus
(`WEB_DIR` überschreibt den Pfad zur Web-App).

Oder mit Docker (baut die Web-App mit ein):

    docker build -f packages/server/Dockerfile -t digital-desktop-server .
    docker run -d -p 4810:4810 -v dd-data:/data digital-desktop-server

**Zugriff übers Internet:** nur hinter einem HTTPS-Reverse-Proxy (z. B. Caddy:
`reverse_proxy localhost:4810` mit automatischem TLS).
```

Den Abschnitt „Bekannte Einschränkungen" beibehalten.

- [ ] **Step 5: Verifizieren**

Run: `npm test && npm run check && npm run build && ls build/index.html`
Expected: alles grün; `build/index.html` existiert.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: Tauri entfernt — Digital Desktop ist eine reine Web-App"
```

---

### Task 10: End-to-End-Verifikation im Browser

**Files:** keine Änderungen — reiner Verifikations-Task. Gefundene Fehler werden als eigene `fix:`-Commits behoben.

- [ ] **Step 1: Produktionsnah starten**

```bash
npm run build
npm run server
```

Expected: Log-Zeile enthält `Web-App: …/build`.

- [ ] **Step 2: Browser-Checkliste unter `http://localhost:4810` durchgehen** (frisches `DATA_DIR` verwenden, z. B. `DATA_DIR=/tmp/dd-e2e npm run server`):

1. Ersteinrichtung: Konto anlegen → Schreibtisch erscheint.
2. „＋ PDF": zwei PDFs wählen → Karten mit Miniaturen erscheinen.
3. PDF per Drag-and-drop aus dem Finder auf den Schreibtisch ziehen → Karte an der Maus-Position.
4. Karte doppelklicken/„Öffnen" → PDF öffnet in neuem Tab.
5. „Herunterladen…" → Datei landet im Download-Ordner.
6. Seite neu laden → Sitzung bleibt (localStorage), Schreibtisch wie zuvor; zweites Neuladen → Miniaturen kommen aus IndexedDB (Netzwerk-Tab: keine `files/`-Abrufe).
7. Zweites Browser-Fenster (gleiches Konto): Karte in Fenster A verschieben → Fenster B folgt live (WebSocket).
8. Server stoppen → Banner „Verbindung getrennt", Aktionen gesperrt; Server starten → verbindet sich selbst neu.
9. Abmelden/Schreibtisch anlegen, umbenennen, löschen (confirm-Dialog) funktionieren.
10. Docker: `docker build -f packages/server/Dockerfile -t dd-test . && docker run --rm -p 4811:4810 dd-test` → `http://localhost:4811` zeigt die App.

- [ ] **Step 3: Befund festhalten und committen**

Gefundene und behobene Punkte als einzelne `fix:`-Commits; abschließend:

```bash
npm test && npm run check
```

Expected: PASS — TP-A ist fertig für Review/UAT.
