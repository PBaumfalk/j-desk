import WebSocket from '@tauri-apps/plugin-websocket';
import { applyCommand, emptyState, type Command, type DesktopState } from '@digital-desktop/core';
import { ApiError, type ApiClient, type DeskInfo, type UserInfo } from './api';
import { saveLastDeskId } from './session';
import { showToast } from './ui.svelte';
import { accessLossMessage } from './wsCodes';

let state = $state<DesktopState>(emptyState());
let status = $state<'connecting' | 'online' | 'offline' | 'loggedOut'>('loggedOut');
let desks = $state<DeskInfo[]>([]);
let me = $state<UserInfo | null>(null);
let wsGeneration = 0;
let rev = 0;
let api: ApiClient | null = null;
let deskId: string | null = null;
let ws: Awaited<ReturnType<typeof WebSocket.connect>> | null = null;
let reconnectDelay = 1000;
let stopped = false;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

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
  get me(): UserInfo | null {
    return me;
  },

  /** Nach erfolgreichem Login: Schreibtische laden, letzten (oder ersten) öffnen. */
  async start(client: ApiClient, lastDeskId?: string): Promise<void> {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    api = client;
    stopped = false;
    status = 'connecting';
    me = await client.me();
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
      showToast('Offline — Aktion nicht möglich');
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
      if (handleAuthLoss(e)) return;
      if (e instanceof ApiError && e.status === 403) {
        void recoverAccess('Zugriff wurde entzogen');
        return;
      }
      await this.refresh().catch(() => {});
      showToast(e instanceof Error ? e.message : 'Aktion fehlgeschlagen');
    }
  },

  /** Kompletten Zustand vom Server holen (nach Reconnect oder Fehler). */
  async refresh(): Promise<void> {
    if (stopped) return;
    if (!api || !deskId) return;
    try {
      const result = await api.getState(deskId);
      if (result.rev >= rev) {
        rev = result.rev;
        state = result.state;
      }
    } catch (e) {
      if (!handleAuthLoss(e)) throw e;
    }
  },

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
    const wechselt = id === deskId;
    try {
      if (wechselt) {
        status = 'connecting';
        await closeWs();
      }
      await api.deleteDesk(id);
      desks = await api.listDesks();
      if (wechselt) {
        if (desks.length === 0) desks = [await api.createDesk('Schreibtisch 1')];
        try {
          await loadDesk(desks[0].id);
        } catch (e) {
          showToast(e instanceof Error ? e.message : 'Wechsel fehlgeschlagen');
          onDisconnected();
        }
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Löschen fehlgeschlagen');
      if (wechselt) onDisconnected();
    }
  },

  async leaveDesk(id: string): Promise<void> {
    if (!api || !me) return;
    if (status !== 'online') {
      showToast('Offline — Aktion nicht möglich');
      return;
    }
    const wechselt = id === deskId;
    try {
      if (wechselt) {
        status = 'connecting';
        await closeWs();
      }
      await api.removeMember(id, me.id);
      desks = await api.listDesks();
      if (wechselt) {
        if (desks.length === 0) desks = [await api.createDesk('Schreibtisch 1')];
        try {
          await loadDesk(desks[0].id);
        } catch (e) {
          showToast(e instanceof Error ? e.message : 'Wechsel fehlgeschlagen');
          onDisconnected();
        }
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Verlassen fehlgeschlagen');
      if (wechselt) onDisconnected();
    }
  },

  async stop(): Promise<void> {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    stopped = true;
    me = null;
    status = 'loggedOut';
    await ws?.disconnect().catch(() => {});
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

async function connectWs(): Promise<void> {
  if (!api || !deskId || stopped) return;
  const generation = ++wsGeneration;
  try {
    const socket = await WebSocket.connect(api.wsUrl(deskId));
    if (generation !== wsGeneration) {
      // Während des Verbindens wurde gewechselt/geschlossen — diesen Socket verwerfen.
      await socket.disconnect().catch(() => {});
      return;
    }
    ws = socket;
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
        const meldung = msg.data ? accessLossMessage(msg.data.code) : null;
        if (meldung) void recoverAccess(meldung);
        else onDisconnected();
      }
    });
  } catch {
    if (generation === wsGeneration) onDisconnected();
  }
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

/** 401: Sitzung ist weg (z. B. Admin-Passwort-Reset) — abmelden, +page zeigt die Login-Maske. */
function handleAuthLoss(e: unknown): boolean {
  if (e instanceof ApiError && e.status === 401) {
    void desktop.stop();
    return true;
  }
  return false;
}

/** Zugriff verloren (Close 4001/4003 oder HTTP 403): melden, Liste neu laden, ausweichen. */
async function recoverAccess(meldung: string): Promise<void> {
  if (stopped || !api) return;
  showToast(meldung);
  wsGeneration++; // alte Listener invalidieren; der Socket ist server-seitig bereits zu
  ws = null;
  status = 'connecting';
  try {
    desks = await api.listDesks();
    if (desks.length === 0) desks = [await api.createDesk('Schreibtisch 1')];
    await loadDesk(desks[0].id);
  } catch (e) {
    if (!handleAuthLoss(e)) onDisconnected();
  }
}
