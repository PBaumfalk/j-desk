import WebSocket from '@tauri-apps/plugin-websocket';
import { applyCommand, emptyState, type Command, type DesktopState } from '@digital-desktop/core';
import type { ApiClient } from './api';
import { showToast } from './ui.svelte';

let state = $state<DesktopState>(emptyState());
let status = $state<'connecting' | 'online' | 'offline' | 'loggedOut'>('loggedOut');
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

  /** Nach erfolgreichem Login: ersten Schreibtisch laden (oder anlegen) und WS verbinden. */
  async start(client: ApiClient): Promise<void> {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    api = client;
    stopped = false;
    status = 'connecting';
    const desks = await client.listDesks();
    deskId = desks[0]?.id ?? (await client.createDesk('Schreibtisch 1')).id;
    const result = await client.getState(deskId);
    rev = result.rev;
    state = result.state;
    await connectWs();
  },

  /** Nur lokal anwenden (Drag-Zwischenschritte) — der Server erfährt nichts. */
  applyLocal(fn: (s: DesktopState) => DesktopState): void {
    state = fn(state);
  },

  /** Optimistisch lokal anwenden, dann ans Backend; die Server-Antwort ist maßgeblich. */
  async command(type: string, payload: Command['payload']): Promise<void> {
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

  async stop(): Promise<void> {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    stopped = true;
    status = 'loggedOut';
    await ws?.disconnect().catch(() => {});
    ws = null;
  },
};

async function connectWs(): Promise<void> {
  if (!api || !deskId || stopped) return;
  try {
    ws = await WebSocket.connect(api.wsUrl(deskId));
    reconnectDelay = 1000;
    status = 'online';
    ws.addListener((msg) => {
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
    onDisconnected();
  }
}

function onDisconnected(): void {
  if (stopped) return;
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
