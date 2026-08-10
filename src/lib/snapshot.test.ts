import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { emptyState, type DesktopState, type Note } from '@j-desk/core';
import { readSnapshot, writeSnapshot } from './snapshot';
import { desktop } from './store.svelte';
import { ApiError, type ApiClient } from './api';

function stateMitNotizen(n: number): DesktopState {
  const notes: Note[] = Array.from({ length: n }, (_, i) => ({
    id: `n${i}`,
    kind: 'notiz',
    text: `Notiz ${i}`,
    position: { x: i * 10, y: 0 },
    zIndex: i,
  }));
  return { ...emptyState(), notes };
}

describe('snapshot: Round-Trip (Task 1)', () => {
  it('writeSnapshot + readSnapshot liefern denselben rev und dieselbe Objektanzahl zurück', async () => {
    const state = stateMitNotizen(3);
    await writeSnapshot('d1', 7, state);
    const gelesen = await readSnapshot('d1');
    expect(gelesen).not.toBeNull();
    expect(gelesen!.rev).toBe(7);
    expect(gelesen!.state.notes).toHaveLength(3);
  });

  it('readSnapshot einer unbekannten deskId liefert null', async () => {
    expect(await readSnapshot('gibtsnicht')).toBeNull();
  });
});

describe('hydrateFromCache: sofortiges Rendern des gecachten Stands (Task 1, SAFE-01/D-04)', () => {
  it('setzt state/rev auf den gecachten Stand und status auf \'connecting\' (nicht \'online\')', () => {
    const cached = stateMitNotizen(1);
    desktop.hydrateFromCache('d-cache', 4, cached);
    expect(desktop.deskId).toBe('d-cache');
    expect(desktop.state.notes).toHaveLength(1);
    expect(desktop.status).toBe('connecting');
  });
});

describe('CR-03-Regression: Cache-First-Boot erholt sich von einem Netzfehler auf dem ersten Roundtrip (SAFE-01)', () => {
  class FakeWebSocket {
    static instances: FakeWebSocket[] = [];
    onopen: (() => void) | null = null;
    onclose: ((ev: CloseEvent) => void) | null = null;
    onmessage: ((ev: MessageEvent) => void) | null = null;
    constructor() {
      FakeWebSocket.instances.push(this);
      queueMicrotask(() => this.onopen?.());
    }
    close(): void {}
  }

  async function flush(ticks = 5): Promise<void> {
    for (let i = 0; i < ticks; i++) await Promise.resolve();
  }

  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await desktop.stop();
    vi.unstubAllGlobals();
  });

  // Hinweis zur Reihenfolge: store.svelte.ts's modulinternes `deskId` wird von stop() nicht
  // zurückgesetzt (Bestandsverhalten, ausserhalb dieses Fixes) — durch den vorangehenden
  // "hydrateFromCache"-Block ist zum Start dieses Blocks bereits IMMER ein Cache aktiv. Beide
  // folgenden Testfälle setzen ihren eigenen deskId ohnehin explizit über hydrateFromCache().

  it('ein gecachter Schreibtisch bleibt sichtbar, status verlässt \'connecting\' statt für immer hängenzubleiben, und ein Reconnect wird eingeplant', async () => {
    const cached = stateMitNotizen(1);
    desktop.hydrateFromCache('d-cache', 4, cached);
    expect(desktop.status).toBe('connecting'); // Ausgangslage: Cache gerendert, noch keine Verbindung.

    // Der allererste Netzwerk-Roundtrip (client.status()) wirft einen ECHTEN Netzfehler (kein
    // ApiError) — genau der Fall aus CR-03: vor dem Fix blieb `status` hier für immer
    // 'connecting', ohne jeden geplanten Reconnect-Versuch.
    const getState = vi.fn(async () => ({ rev: 4, state: cached, rolle: 'Eigentümer' as const }));
    const client: ApiClient = {
      status: vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
      listDesks: async () => [{ id: 'd-cache', name: 'Schreibtisch', ownerId: 'u1' }],
      getState,
      wsTicket: async () => ({ ticket: 't' }),
      wsUrl: () => 'ws://test',
    } as unknown as ApiClient;

    await desktop.start(client, 'd-cache');

    // start() wirft NICHT — der Fehler wurde in den Reconnect-Kreislauf umgeleitet, nicht an den
    // Aufrufer durchgereicht (der gecachte Schreibtisch bleibt so sichtbar).
    expect(desktop.status).not.toBe('connecting');
    expect(desktop.state.notes).toHaveLength(1); // Cache-Inhalt bleibt sichtbar
    expect(client.status).toHaveBeenCalledTimes(1); // genau der eine fehlgeschlagene Versuch in start()

    // Der eingeplante Reconnect-Timer läuft an: onDisconnected() -> refresh() (getState(), NICHT
    // status()) -> connectWs() — und meldet den Client dieses Mal erfolgreich an.
    await vi.advanceTimersByTimeAsync(1100);
    await flush();

    expect(desktop.status).toBe('online');
    expect(getState).toHaveBeenCalled(); // der Reconnect-Kreislauf lief tatsächlich an
  });

  it('ein ApiError (401, abgelaufener Token) wird trotz gecachtem Schreibtisch unverändert weitergereicht statt in den Reconnect-Kreislauf umgeleitet zu werden', async () => {
    const cached = stateMitNotizen(1);
    desktop.hydrateFromCache('d-cache-401', 4, cached);

    const client: ApiClient = {
      status: vi.fn(async () => {
        throw new ApiError('Sitzung abgelaufen.', 401);
      }),
      listDesks: async () => [],
      wsTicket: async () => ({ ticket: 't' }),
      wsUrl: () => 'ws://test',
    } as unknown as ApiClient;

    await expect(desktop.start(client, 'd-cache-401')).rejects.toBeInstanceOf(ApiError);
  });
});

describe('Schreibseite: writeSnapshotDebounced an jedem bestätigten Zustandswechsel (Task 2, SAFE-01)', () => {
  /** Muster aus store.layers.test.ts / store.403.test.ts — kein echtes Netzwerk. */
  class FakeWebSocket {
    static instances: FakeWebSocket[] = [];
    onopen: (() => void) | null = null;
    onclose: ((ev: CloseEvent) => void) | null = null;
    onmessage: ((ev: MessageEvent) => void) | null = null;
    constructor() {
      FakeWebSocket.instances.push(this);
      queueMicrotask(() => this.onopen?.());
    }
    close(): void {}
  }

  async function flush(ticks = 5): Promise<void> {
    for (let i = 0; i < ticks; i++) await new Promise((r) => setTimeout(r, 0));
  }

  /** Über die 400-ms-Debounce-Frist von writeSnapshotDebounced hinaus warten. */
  async function waitDebounce(): Promise<void> {
    await new Promise((r) => setTimeout(r, 450));
  }

  function fakeClient(sendCommandResult?: { rev: number; state: DesktopState }): ApiClient {
    return {
      status: async () => ({ needsSetup: false, needsModeChoice: false, mode: 'standalone' as const }),
      listDesks: async () => [{ id: 'd2', name: 'Schreibtisch 2', ownerId: 'u1' }],
      getState: async () => ({ rev: 1, state: stateMitNotizen(0), rolle: 'Eigentümer' as const }),
      sendCommand: async () => sendCommandResult ?? { rev: 9, state: stateMitNotizen(2) },
      wsTicket: async () => ({ ticket: 't' }),
      wsUrl: () => 'ws://test',
    } as unknown as ApiClient;
  }

  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });
  afterEach(async () => {
    await desktop.stop();
    vi.unstubAllGlobals();
  });

  it('acceptServerState mit übernommenem rev landet im Snapshot', async () => {
    await desktop.start(fakeClient());
    await flush();
    desktop.acceptServerState({ rev: 5, state: stateMitNotizen(4) });
    await waitDebounce();
    const gecacht = await readSnapshot('d2');
    expect(gecacht?.rev).toBe(5);
    expect(gecacht?.state.notes).toHaveLength(4);
  });

  it('ein KLEINERER rev (3 < 5) verändert weder state noch Snapshot', async () => {
    await desktop.start(fakeClient());
    await flush();
    desktop.acceptServerState({ rev: 5, state: stateMitNotizen(4) });
    await waitDebounce();

    desktop.acceptServerState({ rev: 3, state: stateMitNotizen(99) });
    await waitDebounce();

    expect(desktop.state.notes).toHaveLength(4); // unverändert — rev 3 wurde abgelehnt
    const gecacht = await readSnapshot('d2');
    expect(gecacht?.rev).toBe(5); // Snapshot blieb ebenfalls unverändert
  });

  it('ein erfolgreiches command() trägt den vom Fake zurückgegebenen Server-rev in den Snapshot', async () => {
    await desktop.start(fakeClient({ rev: 9, state: stateMitNotizen(2) }));
    await flush();
    await desktop.command('addNote', { kind: 'notiz', text: 'x', position: { x: 0, y: 0 } });
    await waitDebounce();
    const gecacht = await readSnapshot('d2');
    expect(gecacht?.rev).toBe(9);
    expect(gecacht?.state.notes).toHaveLength(2);
  });

  it('ein WebSocket-Broadcast mit rev 9 landet im Snapshot', async () => {
    await desktop.start(fakeClient());
    await flush();
    const broadcastState = stateMitNotizen(7);
    FakeWebSocket.instances[0].onmessage?.({
      data: JSON.stringify({ rev: 9, state: broadcastState }),
    } as MessageEvent);
    await waitDebounce();
    const gecacht = await readSnapshot('d2');
    expect(gecacht?.rev).toBe(9);
    expect(gecacht?.state.notes).toHaveLength(7);
  });
});

describe('Vertraulichkeit: clearAllSnapshots bei Abmeldung (Task 3, D-18, T-05-01)', () => {
  it('nach stop() ist für mehrere zuvor gecachte Schreibtische kein Snapshot mehr lesbar', async () => {
    await writeSnapshot('d-a', 1, stateMitNotizen(1));
    await writeSnapshot('d-b', 1, stateMitNotizen(1));
    expect(await readSnapshot('d-a')).not.toBeNull();
    expect(await readSnapshot('d-b')).not.toBeNull();

    await desktop.stop();

    expect(await readSnapshot('d-a')).toBeNull();
    expect(await readSnapshot('d-b')).toBeNull();
  });
});

describe('Ausfallverhalten ohne IndexedDB (Task 3, Bestandsverhalten vor dieser Phase)', () => {
  it('readSnapshot liefert null und writeSnapshot wirft nicht, wenn IndexedDB nicht verfügbar ist', async () => {
    // Eigene Modulinstanz (frisches dbPromise-Caching) — die statisch importierten
    // readSnapshot/writeSnapshot oben haben ihr idb.ts-dbPromise bereits erfolgreich
    // aufgelöst; ein Stub danach würde daran nichts mehr ändern.
    vi.resetModules();
    vi.stubGlobal('indexedDB', {
      open: () => {
        throw new Error('IndexedDB gesperrt');
      },
    } as unknown as IDBFactory);
    try {
      const frisch = await import('./snapshot');
      await expect(frisch.writeSnapshot('d-x', 1, stateMitNotizen(1))).resolves.toBeUndefined();
      expect(await frisch.readSnapshot('d-x')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });
});
