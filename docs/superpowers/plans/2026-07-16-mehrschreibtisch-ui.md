# Mehrschreibtisch-UI (Teilprojekt 2) — Implementierungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dropdown links in der Toolbar zum Wechseln, Anlegen, Umbenennen und Löschen von Schreibtischen; zuletzt aktiver Schreibtisch wird pro Gerät gemerkt.

**Architecture:** Client-only — die Server-API `/desks` (CRUD) existiert und ist getestet. Drei Schichten: api/session-Erweiterung, Store-Operationen (mit WS-Generationszähler gegen veraltete Listener beim Wechsel), neue `DeskSwitcher.svelte`-Komponente.

**Tech Stack:** Svelte 5 (Runes), Tauri-Plugins dialog/fs, Vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-16-mehrschreibtisch-ui-design.md` — bei Widerspruch gilt die Spec.
- Alle UI-Texte deutsch; Fehler als Toasts (`showToast`); Offline-Guard: Desk-Operationen nur bei `status === 'online'`, sonst Toast „Offline — Aktion nicht möglich".
- Kein `window.prompt`/`window.confirm` (blockiert die Webview) — Namenseingabe im Menü, Löschen via `ask()` aus plugin-dialog.
- `switchDesk` setzt den internen `rev`-Zähler auf den geladenen Stand des NEUEN Schreibtischs (nicht vergleichen).
- Gates: `npm test` (grün, 84 erwartet nach Task 1), `npx svelte-check` (0 Errors außer bekanntem pre-existing vite.config.js-Error), App-Start gegen laufenden Server.
- Jeder Commit endet mit `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: API-Client & Session erweitern

**Files:**
- Modify: `src/lib/api.ts` (zwei Methoden ergänzen), `src/lib/session.ts`, `src/lib/session.test.ts`

**Interfaces:**
- Produces: `ApiClient.renameDesk(deskId, name): Promise<{ok: boolean}>`; `ApiClient.deleteDesk(deskId): Promise<{ok: boolean}>`; `Session { serverUrl, token, lastDeskId?: string }`; `saveLastDeskId(deskId: string): Promise<void>`.

- [ ] **Step 1: Failing Tests ergänzen**

In `src/lib/session.test.ts` im bestehenden `describe('parseSession', …)` zwei Tests ergänzen:

```ts
  it('liest lastDeskId, wenn vorhanden und korrekt typisiert', () => {
    expect(parseSession('{"serverUrl":"http://x:4810","token":"abc","lastDeskId":"d1"}')).toEqual({
      serverUrl: 'http://x:4810',
      token: 'abc',
      lastDeskId: 'd1',
    });
  });

  it('verwirft ein falsch typisiertes lastDeskId, nicht die ganze Session', () => {
    expect(parseSession('{"serverUrl":"http://x:4810","token":"abc","lastDeskId":5}')).toEqual({
      serverUrl: 'http://x:4810',
      token: 'abc',
    });
  });
```

Run: `npm test` → Expected: FAIL (erster neuer Test: `lastDeskId` fehlt im Ergebnis).

- [ ] **Step 2: Implementieren**

`src/lib/session.ts` — Interface und `parseSession` ersetzen, Helfer ergänzen:

```ts
export interface Session {
  serverUrl: string;
  token: string;
  lastDeskId?: string;
}
```

```ts
export function parseSession(json: string): Session | null {
  try {
    const v = JSON.parse(json) as Session | null;
    if (!v || typeof v.serverUrl !== 'string' || typeof v.token !== 'string') return null;
    return {
      serverUrl: v.serverUrl,
      token: v.token,
      ...(typeof v.lastDeskId === 'string' ? { lastDeskId: v.lastDeskId } : {}),
    };
  } catch {
    return null;
  }
}
```

Am Dateiende ergänzen:

```ts
/** Merkt sich den zuletzt aktiven Schreibtisch (pro Gerät). */
export async function saveLastDeskId(deskId: string): Promise<void> {
  const session = await loadSession();
  if (session) await saveSession({ ...session, lastDeskId: deskId });
}
```

`src/lib/api.ts` — nach `createDesk` ergänzen:

```ts
  renameDesk(deskId: string, name: string): Promise<{ ok: boolean }> {
    return this.request('PATCH', `/desks/${deskId}`, { name });
  }

  deleteDesk(deskId: string): Promise<{ ok: boolean }> {
    return this.request('DELETE', `/desks/${deskId}`);
  }
```

- [ ] **Step 3: Verifizieren & committen**

Run: `npm test` → PASS (84 Tests).

```bash
git add src/lib
git commit -m "feat: renameDesk/deleteDesk im API-Client, lastDeskId in der Session" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Store — Desk-Liste, Wechsel mit WS-Generation, CRUD-Operationen

**Files:**
- Modify: `src/lib/store.svelte.ts`, `src/routes/+page.svelte` (eine Zeile)

**Interfaces:**
- Consumes: Task 1 (`renameDesk`/`deleteDesk`/`saveLastDeskId`, `DeskInfo` aus api.ts).
- Produces am `desktop`-Singleton: `get desks(): DeskInfo[]`; `start(client, lastDeskId?)`; `switchDesk(id)`; `createDesk(name)` (anlegen + hinwechseln); `renameDesk(id, name)`; `deleteDesk(id)` (aktiver Desk → zum ersten verbleibenden wechseln, letzter → „Schreibtisch 1" neu anlegen). Interner `wsGeneration`-Zähler invalidiert Listener alter Sockets.

- [ ] **Step 1: store.svelte.ts umbauen**

Imports ergänzen/ändern:

```ts
import type { ApiClient, DeskInfo } from './api';
import { saveLastDeskId } from './session';
```

Neue Zustandsvariablen (bei den bestehenden):

```ts
let desks = $state<DeskInfo[]>([]);
let wsGeneration = 0;
```

Am `desktop`-Objekt: Getter ergänzen und `start` ersetzen:

```ts
  get desks(): DeskInfo[] {
    return desks;
  },

  /** Nach erfolgreichem Login: Schreibtische laden, letzten (oder ersten) öffnen. */
  async start(client: ApiClient, lastDeskId?: string): Promise<void> {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    api = client;
    stopped = false;
    status = 'connecting';
    desks = await client.listDesks();
    if (desks.length === 0) desks = [await client.createDesk('Schreibtisch 1')];
    const target = desks.find((d) => d.id === lastDeskId) ?? desks[0];
    await loadDesk(target.id);
  },
```

Neue Methoden am `desktop`-Objekt (nach `refresh`):

```ts
  async switchDesk(id: string): Promise<void> {
    if (!api || id === deskId) return;
    if (status !== 'online') {
      showToast('Offline — Aktion nicht möglich');
      return;
    }
    status = 'connecting';
    await closeWs();
    try {
      await loadDesk(id);
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Wechsel fehlgeschlagen');
      onDisconnected();
    }
  },

  async createDesk(name: string): Promise<void> {
    if (!api) return;
    if (status !== 'online') {
      showToast('Offline — Aktion nicht möglich');
      return;
    }
    try {
      const desk = await api.createDesk(name);
      desks = await api.listDesks();
      await this.switchDesk(desk.id);
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Anlegen fehlgeschlagen');
    }
  },

  async renameDesk(id: string, name: string): Promise<void> {
    if (!api) return;
    if (status !== 'online') {
      showToast('Offline — Aktion nicht möglich');
      return;
    }
    try {
      await api.renameDesk(id, name);
      desks = await api.listDesks();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Umbenennen fehlgeschlagen');
    }
  },

  async deleteDesk(id: string): Promise<void> {
    if (!api) return;
    if (status !== 'online') {
      showToast('Offline — Aktion nicht möglich');
      return;
    }
    try {
      await api.deleteDesk(id);
      desks = await api.listDesks();
      if (id === deskId) {
        if (desks.length === 0) desks = [await api.createDesk('Schreibtisch 1')];
        status = 'connecting';
        await closeWs();
        await loadDesk(desks[0].id);
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Löschen fehlgeschlagen');
    }
  },
```

Neue Modul-Helfer (vor `connectWs`):

```ts
/** Lädt Zustand + rev des Schreibtischs und verbindet den WebSocket. */
async function loadDesk(id: string): Promise<void> {
  if (!api) return;
  deskId = id;
  const result = await api.getState(id);
  rev = result.rev; // Zähler gehört zum neuen Schreibtisch — nicht vergleichen
  state = result.state;
  await saveLastDeskId(id).catch(() => {});
  await connectWs();
}

/** Trennt den aktuellen Socket und invalidiert dessen Listener (Generationswechsel). */
async function closeWs(): Promise<void> {
  wsGeneration++;
  clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  const socket = ws;
  ws = null;
  await socket?.disconnect().catch(() => {});
}
```

`connectWs` komplett ersetzen durch (Generation-Guard):

```ts
async function connectWs(): Promise<void> {
  if (!api || !deskId || stopped) return;
  const generation = ++wsGeneration;
  try {
    ws = await WebSocket.connect(api.wsUrl(deskId));
    if (generation !== wsGeneration) {
      // Während des Verbindens wurde gewechselt/geschlossen — diesen Socket verwerfen.
      await ws?.disconnect().catch(() => {});
      return;
    }
    reconnectDelay = 1000;
    status = 'online';
    ws.addListener((msg) => {
      if (generation !== wsGeneration) return;
      // Bei abruptem Abriss liefert das Plugin statt eines Close-Frames einen Fehler-String.
      if (typeof msg === 'string') {
        onDisconnected();
        return;
      }
      if (msg.type === 'Text') {
        const data = JSON.parse(msg.data as string) as { rev: number; state: DesktopState };
        if (data.rev >= rev) {
          rev = data.rev;
          state = data.state;
        }
      } else if (msg.type === 'Close') {
        onDisconnected();
      }
    });
  } catch {
    if (generation === wsGeneration) onDisconnected();
  }
}
```

(`onDisconnected` bleibt unverändert — die Guards `stopped`/`reconnectTimer` aus Teilprojekt 1 bestehen weiter.)

- [ ] **Step 2: +page.svelte — lastDeskId durchreichen**

In `src/routes/+page.svelte`, Funktion `connect`: `await desktop.start(api);` ersetzen durch

```ts
    await desktop.start(api, session.lastDeskId);
```

- [ ] **Step 3: Verifizieren & committen**

Run: `npm test` (84 grün) und `npx svelte-check 2>&1 | tail -3` (0 neue Errors).

```bash
git add src
git commit -m "feat: Desk-Liste, Schreibtisch-Wechsel mit WS-Generationszähler und Desk-CRUD im Store" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: DeskSwitcher-Komponente & Einbindung

**Files:**
- Create: `src/lib/components/DeskSwitcher.svelte`
- Modify: `src/lib/components/Desktop.svelte` (Import + Einbindung)

**Interfaces:**
- Consumes: `desktop.desks/deskId/switchDesk/createDesk/renameDesk/deleteDesk` (Task 2), `ask` aus plugin-dialog.

- [ ] **Step 1: DeskSwitcher.svelte anlegen**

```svelte
<script lang="ts">
  import { ask } from '@tauri-apps/plugin-dialog';
  import { desktop } from '../store.svelte';

  let open = $state(false);
  let mode = $state<'liste' | 'neu' | 'umbenennen'>('liste');
  let nameEntwurf = $state('');

  const aktiv = $derived(desktop.desks.find((d) => d.id === desktop.deskId));

  function toggle() {
    open = !open;
    mode = 'liste';
  }

  function startNeu() {
    mode = 'neu';
    nameEntwurf = '';
  }

  function startUmbenennen() {
    mode = 'umbenennen';
    nameEntwurf = aktiv?.name ?? '';
  }

  async function bestaetigen() {
    const name = nameEntwurf.trim();
    if (!name) return;
    if (mode === 'neu') await desktop.createDesk(name);
    else if (mode === 'umbenennen' && desktop.deskId) await desktop.renameDesk(desktop.deskId, name);
    open = false;
  }

  async function loeschen() {
    if (!desktop.deskId || !aktiv) return;
    const ja = await ask(
      `„${aktiv.name}" löschen? Karten und Verknüpfungen dieses Schreibtischs werden entfernt. Die PDF-Dateien bleiben in der Server-Ablage erhalten.`,
      { title: 'Digital Desktop', kind: 'warning' },
    );
    if (ja) {
      await desktop.deleteDesk(desktop.deskId);
      open = false;
    }
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') open = false;
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="switcher">
  <button class="current" onclick={toggle}>{aktiv?.name ?? '…'} ▾</button>
  {#if open}
    <div class="backdrop" onpointerdown={(e) => { e.stopPropagation(); open = false; }}></div>
    <div class="menu" onpointerdown={(e) => e.stopPropagation()}>
      {#if mode === 'liste'}
        {#each desktop.desks as desk (desk.id)}
          <button class="item" onclick={() => { void desktop.switchDesk(desk.id); open = false; }}>
            {desk.id === desktop.deskId ? '✓ ' : ''}{desk.name}
          </button>
        {/each}
        <hr />
        <button class="item" onclick={startNeu}>Neuer Schreibtisch…</button>
        <button class="item" onclick={startUmbenennen}>Umbenennen…</button>
        <button class="item gefahr" onclick={() => void loeschen()}>Löschen…</button>
      {:else}
        <!-- svelte-ignore a11y_autofocus -->
        <input
          autofocus
          placeholder={mode === 'neu' ? 'Name des neuen Schreibtischs' : 'Neuer Name'}
          bind:value={nameEntwurf}
          onkeydown={(e) => {
            if (e.key === 'Enter') void bestaetigen();
            if (e.key === 'Escape') {
              e.stopPropagation();
              mode = 'liste';
            }
          }}
        />
        <div class="row">
          <button class="item" onclick={() => (mode = 'liste')}>Abbrechen</button>
          <button class="item" onclick={() => void bestaetigen()}>OK</button>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .switcher { position: fixed; top: 12px; left: 12px; z-index: 9000; }
  .current { font-size: 13px; padding: 6px 12px; border-radius: 8px; border: none;
             background: rgba(255, 255, 255, .92); cursor: pointer; box-shadow: 0 2px 8px rgba(0, 0, 0, .25); }
  .backdrop { position: fixed; inset: 0; z-index: 9001; }
  .menu { position: absolute; top: 36px; left: 0; z-index: 9002; min-width: 230px; padding: 4px;
          border-radius: 10px; background: rgba(255, 255, 255, .97); box-shadow: 0 8px 30px rgba(0, 0, 0, .35);
          display: flex; flex-direction: column; gap: 2px; }
  .item { text-align: left; padding: 7px 10px; border: none; background: none; border-radius: 6px;
          font-size: 13px; cursor: pointer; }
  .item:hover { background: #e8eefc; }
  .item.gefahr { color: #b02a2a; }
  hr { border: none; border-top: 1px solid #e5e5e5; margin: 4px 0; }
  input { margin: 6px; padding: 6px 8px; border: 1px solid #ccc; border-radius: 6px; font: inherit; font-size: 13px; }
  .row { display: flex; justify-content: flex-end; gap: 4px; padding: 0 6px 6px; }
</style>
```

- [ ] **Step 2: In Desktop.svelte einbinden**

Import ergänzen: `import DeskSwitcher from './DeskSwitcher.svelte';`
Im Markup direkt vor `<div class="toolbar">` einfügen: `<DeskSwitcher />` (positioniert sich selbst fixed oben links).

- [ ] **Step 3: Verifizieren & committen**

Run: `npm test` (84 grün), `npx svelte-check 2>&1 | tail -3` (0 neue Errors), dann `npm run server` + `npm run tauri dev`:

Prüfliste (nicht Interaktives im Report als „pending user verification"):
1. Dropdown oben links zeigt den aktuellen Namen; Menü öffnet/schließt (Klick außerhalb, Escape).
2. „Neuer Schreibtisch…" → Name eingeben → Enter → leerer Schreibtisch aktiv, Dropdown zeigt neuen Namen.
3. Wechsel zurück → alter Inhalt vollständig da, Live-Updates funktionieren weiter (WS folgt dem Wechsel).
4. „Umbenennen…" wirkt sofort; „Löschen…" fragt nach und wechselt zum verbleibenden Schreibtisch; letzten löschen → „Schreibtisch 1" entsteht automatisch.
5. App-Neustart → zuletzt aktiver Schreibtisch öffnet sich.

```bash
git add src
git commit -m "feat: DeskSwitcher-Dropdown zum Wechseln, Anlegen, Umbenennen und Löschen von Schreibtischen" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
