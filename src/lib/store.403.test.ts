import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyState, type DesktopState, type Rolle } from '@j-desk/core';
import { desktop } from './store.svelte';
import { ApiError, type ApiClient } from './api';
import { ui } from './ui.svelte';

/**
 * WR-03: Client-Verhalten nach WS-Close 4003 (Zugriff entzogen, Server: trenneNutzer/
 * Connect-Guard in broadcast.ts/app.ts) — vor dem Fix endete das in einer endlosen
 * Reconnect-Schleife (Ticket läuft, Session gültig, Guard schließt erneut mit 4003)
 * mit dem irreführenden Banner „Verbindung getrennt" und ohne jede Erklärung.
 */

/** Minimaler Fake-Socket (Muster store.layers.test.ts) mit Instanz-Registry, damit der
 *  Test das close-Event mit konkretem Code auslösen kann; kein echtes Netzwerk. */
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

/** Mehrere Event-Loop-Runden abwarten (die 4003-Behandlung ist eine async-Kette aus
 *  refresh → Desk-Liste → loadDesk → connectWs → onopen). */
async function flush(ticks = 20): Promise<void> {
  for (let i = 0; i < ticks; i++) await new Promise((r) => setTimeout(r, 0));
}

function closeEvent(code: number): CloseEvent {
  return { code } as CloseEvent;
}

interface FakeDeskAntwort {
  rev: number;
  state: DesktopState;
  rolle?: Rolle;
}

/**
 * Zwei-Desk-Client (Standalone): `entzogen` kippt das Verhalten von Desk d1 — danach
 * wirft getState(d1) 403 (Rollen-Guard) und listDesks liefert nur noch d2 (GET /desks
 * filtert rollenbasiert, app.ts).
 */
function fakeClientMitEntzug(flags: { entzogen: boolean }): ApiClient {
  const antwort = (rolle: Rolle, rev: number): FakeDeskAntwort => ({ rev, state: emptyState(), rolle });
  return {
    status: async () => ({ needsSetup: false, needsModeChoice: false, mode: 'standalone' as const }),
    listDesks: async () =>
      flags.entzogen
        ? [{ id: 'd2', name: 'Schreibtisch 2', ownerId: 'u1' }]
        : [
            { id: 'd1', name: 'Schreibtisch 1', ownerId: 'u1' },
            { id: 'd2', name: 'Schreibtisch 2', ownerId: 'u1' },
          ],
    getState: async (id: string) => {
      if (id === 'd1') {
        if (flags.entzogen) throw new ApiError('Kein Zugriff auf diesen Schreibtisch.', 403);
        return antwort('Eigentümer', 1);
      }
      return antwort('Bearbeiter', 5);
    },
    wsTicket: async () => ({ ticket: 't' }),
    wsUrl: () => 'ws://test',
  } as unknown as ApiClient;
}

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  });
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
});

afterEach(async () => {
  await desktop.stop(); // räumt ggf. eingeplante Reconnect-Timer ab
  ui.toast = null;
  vi.unstubAllGlobals();
});

describe('WR-03: WS-Close 4003 (Zugriff entzogen)', () => {
  it('meldet den Entzug klar, wechselt auf einen verbleibenden Desk und plant KEINEN Reconnect', async () => {
    const flags = { entzogen: false };
    await desktop.start(fakeClientMitEntzug(flags));
    await flush();
    expect(desktop.status).toBe('online');
    expect(desktop.deskId).toBe('d1');
    expect(desktop.currentRolle).toBe('Eigentümer');
    expect(FakeWebSocket.instances).toHaveLength(1);

    // Der Eigentümer entfernt das Mitglied serverseitig → Socket schließt mit 4003.
    flags.entzogen = true;
    FakeWebSocket.instances[0].onclose?.(closeEvent(4003));
    await flush();

    // Klare Meldung statt „Verbindung getrennt"-Banner, und ein definierter Endzustand:
    // Desk-Liste neu geladen (d1 verschwunden), auf d2 gewechselt, Rolle übernommen.
    expect(ui.toast).toBe('Der Zugriff auf diesen Schreibtisch wurde entfernt.');
    expect(desktop.deskId).toBe('d2');
    expect(desktop.currentRolle).toBe('Bearbeiter');
    expect(desktop.status).toBe('online');

    // Kein Reconnect-Loop: genau EIN neuer Socket (der von loadDesk('d2')), danach Ruhe.
    expect(FakeWebSocket.instances).toHaveLength(2);
    await flush();
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(desktop.status).toBe('online');
  });

  it('besteht der Zugriff noch (refresh gelingt), läuft der normale Reconnect-Pfad', async () => {
    const flags = { entzogen: false }; // 4003, aber getState liefert weiterhin 200
    await desktop.start(fakeClientMitEntzug(flags));
    await flush();
    expect(desktop.status).toBe('online');

    FakeWebSocket.instances[0].onclose?.(closeEvent(4003));
    await flush(3);

    // Kein Entzug bestätigt → Behandlung wie Netzausfall: offline + Reconnect eingeplant,
    // kein „Zugriff entfernt"-Toast.
    expect(desktop.status).toBe('offline');
    expect(ui.toast).toBeNull();
    expect(desktop.deskId).toBe('d1');
  });

  it('anderer Close-Code (Netzausfall) bleibt unverändert im Reconnect-Pfad', async () => {
    const flags = { entzogen: false };
    await desktop.start(fakeClientMitEntzug(flags));
    await flush();

    FakeWebSocket.instances[0].onclose?.(closeEvent(1006));
    await flush(3);

    expect(desktop.status).toBe('offline');
    expect(ui.toast).toBeNull();
  });

  it('403 aus refresh() setzt die gecachte Rolle zurück (kein fail-open auf den Alt-Wert)', async () => {
    const flags = { entzogen: false };
    await desktop.start(fakeClientMitEntzug(flags));
    await flush();
    expect(desktop.currentRolle).toBe('Eigentümer');

    flags.entzogen = true; // getState(d1) wirft ab jetzt 403
    await expect(desktop.refresh()).rejects.toThrow(ApiError);
    expect(desktop.currentRolle).toBeNull();
  });
});

describe('WR-05: 403 aus dem Command-Pfad zeigt die präzise Server-Meldung', () => {
  it('Ebenen-Ablehnung (CR-04) wird als Server-Text gezeigt, nicht als irreführender Rollen-Toast', async () => {
    const SERVER_MELDUNG = 'Dieses Objekt liegt auf einer privaten Ebene einer anderen Person.';
    const client = {
      status: async () => ({ needsSetup: false, needsModeChoice: false, mode: 'standalone' as const }),
      listDesks: async () => [{ id: 'd1', name: 'Schreibtisch 1', ownerId: 'u1' }],
      getState: async () => ({ rev: 1, state: emptyState(), rolle: 'Bearbeiter' as Rolle }),
      sendCommand: async () => {
        throw new ApiError(SERVER_MELDUNG, 403);
      },
      wsTicket: async () => ({ ticket: 't' }),
      wsUrl: () => 'ws://test',
    } as unknown as ApiClient;
    await desktop.start(client);
    await flush();
    expect(desktop.status).toBe('online');

    // Race: das Objekt wurde gerade privat gestellt, während die UI es noch bearbeitbar
    // anzeigte — der Server lehnt mit der präzisen Ebenen-Meldung ab (CR-04).
    await desktop.command('moveNote', { id: 'n-x', position: { x: 5, y: 5 } });

    // Bis zum Fix fiel das auf 'allgemein' zurück: „Ihre Rolle „Bearbeiter" erlaubt das
    // nicht" — fachlich falsch (die Rolle IST ausreichend, das Objekt ist privat).
    expect(ui.toast).toBe(SERVER_MELDUNG);
  });

  it('Rollen-Ablehnung (Kommando-Recht) zeigt ebenfalls die Server-Meldung', async () => {
    const SERVER_MELDUNG = 'Endgültiges Löschen ist nur dem Eigentümer vorbehalten.';
    const client = {
      status: async () => ({ needsSetup: false, needsModeChoice: false, mode: 'standalone' as const }),
      listDesks: async () => [{ id: 'd1', name: 'Schreibtisch 1', ownerId: 'u1' }],
      getState: async () => ({ rev: 1, state: emptyState(), rolle: 'Bearbeiter' as Rolle }),
      sendCommand: async () => {
        throw new ApiError(SERVER_MELDUNG, 403);
      },
      wsTicket: async () => ({ ticket: 't' }),
      wsUrl: () => 'ws://test',
    } as unknown as ApiClient;
    await desktop.start(client);
    await flush();

    await desktop.command('shredTrashItem', { trashId: 't-1' });
    expect(ui.toast).toBe(SERVER_MELDUNG);
  });
});
