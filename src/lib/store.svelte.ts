import { applyCommand, emptyState, type Command, type DesktopState } from '@digital-desktop/core';
import type { ApiClient, DeskInfo } from './api';
import { saveLastDeskId } from './session';
import { showToast } from './ui.svelte';

let state = $state<DesktopState>(emptyState());
let status = $state<'connecting' | 'online' | 'offline' | 'loggedOut'>('loggedOut');
let desks = $state<DeskInfo[]>([]);
let wsGeneration = 0;
let rev = 0;
let api: ApiClient | null = null;
let deskId: string | null = null;
let ws: WebSocket | null = null;
let reconnectDelay = 1000;
let stopped = false;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

/** Passende Meldung, wenn eine Aktion mangels Verbindung nicht ausgeführt wird. */
function offlineMeldung(): string {
  return status === 'connecting'
    ? 'Verbindung wird aufgebaut — gleich erneut versuchen'
    : 'Offline — Aktion nicht möglich';
}

export const desktop = {
  get state(): DesktopState {
    return state;
  },
  get status() {
    return status;
  },
  get api(): ApiClient | null {
    return api;
  },
  get deskId(): string | null {
    return deskId;
  },
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

  /** Nur lokal anwenden (Drag-Zwischenschritte) — der Server erfährt nichts. */
  applyLocal(fn: (s: DesktopState) => DesktopState): void {
    state = fn(state);
  },

  /** Optimistisch lokal anwenden, dann ans Backend; die Server-Antwort ist maßgeblich. */
  async command(type: string, payload: Command['payload']): Promise<void> {
    if (status !== 'online') {
      showToast(offlineMeldung());
      return;
    }
    if (!api || !deskId) return;
    const cmd: Command = { type, payload };
    try {
      state = applyCommand(state, cmd);
    } catch {
      // Server validiert maßgeblich
    }
    try {
      const result = await api.sendCommand(deskId, cmd);
      if (result.rev >= rev) {
        rev = result.rev;
        state = result.state;
      }
    } catch (e) {
      await this.refresh().catch(() => {});
      showToast(e instanceof Error ? e.message : 'Aktion fehlgeschlagen');
    }
  },

  /** Kompletten Zustand vom Server holen (nach Reconnect oder Fehler). */
  async refresh(): Promise<void> {
    if (stopped) return;
    if (!api || !deskId) return;
    const result = await api.getState(deskId);
    if (result.rev >= rev) {
      rev = result.rev;
      state = result.state;
    }
  },

  async switchDesk(id: string): Promise<void> {
    if (!api || id === deskId) return;
    if (status !== 'online') {
      showToast(offlineMeldung());
      return;
    }
    status = 'connecting';
    closeWs();
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
      showToast(offlineMeldung());
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
      showToast(offlineMeldung());
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
      showToast(offlineMeldung());
      return;
    }
    try {
      await api.deleteDesk(id);
      desks = await api.listDesks();
      if (id === deskId) {
        if (desks.length === 0) desks = [await api.createDesk('Schreibtisch 1')];
        status = 'connecting';
        closeWs();
        try {
          await loadDesk(desks[0].id);
        } catch (e) {
          showToast(e instanceof Error ? e.message : 'Wechsel fehlgeschlagen');
          onDisconnected();
        }
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Löschen fehlgeschlagen');
    }
  },

  async stop(): Promise<void> {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    stopped = true;
    status = 'loggedOut';
    ws?.close();
    ws = null;
  },
};

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
  void (async () => {
    let ticket: string;
    try {
      ticket = (await api!.wsTicket()).ticket;
    } catch {
      if (generation === wsGeneration) onDisconnected();
      return;
    }
    if (generation !== wsGeneration || stopped || !api || !deskId) return;
    openSocket(generation, api.wsUrl(deskId, ticket));
  })();
}

function openSocket(generation: number, url: string): void {
  let socket: WebSocket;
  try {
    socket = new WebSocket(url);
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
    let data: { rev: number; state: DesktopState };
    try {
      data = JSON.parse(ev.data as string) as { rev: number; state: DesktopState };
    } catch {
      return; // fehlerhafte Nachricht verwerfen — der nächste Broadcast bringt den vollen Zustand
    }
    if (typeof data?.rev !== 'number' || !data.state) return;
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

function onDisconnected(): void {
  // Doppel-Feuer (Fehler-String + Close) nicht doppelt einplanen; ein
  // bereits laufender Reconnect-Timer bleibt maßgeblich.
  if (stopped || reconnectTimer !== undefined) return;
  status = 'offline';
  ws = null;
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, 15000);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    void (async () => {
      await desktop.refresh().catch(() => {});
      await connectWs();
    })();
  }, delay);
}
