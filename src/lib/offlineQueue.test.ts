import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyState, type Command, type DesktopState, type Konflikt, type Note } from '@j-desk/core';
import { enqueueCommand, MAX_QUEUE, readQueue, type QueueEintrag } from './offlineQueue';
import { desktop } from './store.svelte';
import { ApiError, type ApiClient } from './api';
import { KonfliktAntwort } from './konflikt';
import { ui } from './ui.svelte';
import { QUEUE_STORE, tx } from './idb';

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

describe('offlineQueue: Dauerhaftigkeit und Reihenfolge (Task 1, SAFE-02)', () => {
  it('enqueueCommand dreimal, readQueue liefert drei Einträge in Einfügereihenfolge mit aufsteigendem seq', async () => {
    await enqueueCommand('d-order', { type: 'addNote', payload: { text: 'a' } } as unknown as Command);
    await enqueueCommand('d-order', { type: 'addNote', payload: { text: 'b' } } as unknown as Command);
    await enqueueCommand('d-order', { type: 'addNote', payload: { text: 'c' } } as unknown as Command);

    const eintraege = await readQueue('d-order');
    expect(eintraege).toHaveLength(3);
    expect(eintraege.map((e) => (e.cmd.payload as { text: string }).text)).toEqual(['a', 'b', 'c']);
    expect(eintraege[0].seq).toBeLessThan(eintraege[1].seq as number);
    expect(eintraege[1].seq).toBeLessThan(eintraege[2].seq as number);
  });

  it("readQueue('anderer-desk') liefert nichts", async () => {
    await enqueueCommand('d-order', { type: 'addNote', payload: { text: 'x' } } as unknown as Command);
    expect(await readQueue('ein-anderer-desk')).toEqual([]);
  });

  it('WR-03-Regression: gleichzeitige enqueueCommand()-Aufrufe nahe der Obergrenze überschreiten MAX_QUEUE nie', async () => {
    const deskId = 'd-race';
    // Bis auf 3 freie Plätze vorbefüllen (direkter Roh-Zugriff, s. Muster "volle Warteschlange"
    // weiter unten — 500 sequentielle enqueueCommand()-Aufrufe wären für den Testaufbau selbst
    // unnötig langsam).
    const vorfuellen = MAX_QUEUE - 3;
    await Promise.all(
      Array.from({ length: vorfuellen }, (_, i) => {
        const eintrag: QueueEintrag = {
          deskId,
          cmd: { type: 'addNote', payload: { kind: 'notiz', text: `vorab-${i}`, position: { x: 0, y: 0 } } } as unknown as Command,
          queuedAt: Date.now(),
        };
        return tx(QUEUE_STORE, 'readwrite', (s) => s.add(eintrag));
      }),
    );
    expect(await readQueue(deskId)).toHaveLength(vorfuellen);

    // 10 GLEICHZEITIGE enqueueCommand()-Aufrufe auf nur noch 3 freie Plätze — vor der
    // WR-03-Korrektur konnte ein check-then-act über zwei getrennte Transaktionen hier mehr als
    // 3 zusätzliche Einträge durchlassen, weil queueLength() für mehrere Aufrufe gleichzeitig
    // noch denselben (veralteten) Zählerstand sah.
    const versuche = Array.from({ length: 10 }, (_, i) =>
      enqueueCommand(deskId, { type: 'addNote', payload: { kind: 'notiz', text: `gleichzeitig-${i}`, position: { x: 0, y: 0 } } } as unknown as Command),
    );
    const ergebnisse = await Promise.allSettled(versuche);

    const erfuellt = ergebnisse.filter((r) => r.status === 'fulfilled');
    const abgelehnt = ergebnisse.filter((r) => r.status === 'rejected');
    expect(erfuellt).toHaveLength(3); // genau die verbliebenen 3 freien Plätze
    expect(abgelehnt).toHaveLength(7);

    const nachher = await readQueue(deskId);
    expect(nachher).toHaveLength(MAX_QUEUE); // niemals mehr als die harte Obergrenze
  });
});

describe('Store-Integration: offline ausgelöstes Command überlebt und wird nachgespielt (Task 1, SAFE-02)', () => {
  /** Muster aus store.403.test.ts/snapshot.test.ts — kein echtes Netzwerk. */
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

  function fakeClient(deskId: string, sendCommand: ReturnType<typeof vi.fn>): ApiClient {
    return {
      status: async () => ({ needsSetup: false, needsModeChoice: false, mode: 'standalone' as const }),
      listDesks: async () => [{ id: deskId, name: 'Schreibtisch', ownerId: 'u1' }],
      getState: async () => ({ rev: 1, state: stateMitNotizen(0), rolle: 'Eigentümer' as const }),
      sendCommand,
      wsTicket: async () => ({ ticket: 't' }),
      wsUrl: () => 'ws://test',
    } as unknown as ApiClient;
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

  it('offline ausgelöstes Command liegt in der Warteschlange und wirkt lokal', async () => {
    const sendCommand = vi.fn(async () => ({ rev: 2, state: stateMitNotizen(1) }));
    await desktop.start(fakeClient('d-offline', sendCommand));
    await flush();
    expect(desktop.status).toBe('online');

    FakeWebSocket.instances[0].onclose?.({ code: 1006 } as CloseEvent);
    await flush();
    expect(desktop.status).toBe('offline');

    await desktop.command('addNote', { kind: 'notiz', text: 'Offline-Notiz', position: { x: 0, y: 0 } });

    expect(desktop.state.notes).toHaveLength(1); // wirkt sofort optimistisch
    const eingereiht = await readQueue('d-offline');
    expect(eingereiht).toHaveLength(1);
    expect(eingereiht[0].cmd.type).toBe('addNote');
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it('nach Wiederverbindung hat der Server das Command genau einmal erhalten und die Warteschlange ist leer', async () => {
    const sendCommand = vi.fn(async () => ({ rev: 2, state: stateMitNotizen(1) }));
    await desktop.start(fakeClient('d-reconnect', sendCommand));
    await flush();

    FakeWebSocket.instances[0].onclose?.({ code: 1006 } as CloseEvent);
    await flush();
    expect(desktop.status).toBe('offline');

    await desktop.command('addNote', { kind: 'notiz', text: 'Offline-Notiz', position: { x: 0, y: 0 } });
    expect(sendCommand).not.toHaveBeenCalled(); // noch nicht gesendet — nur eingereiht

    // Reconnect-Timer (reconnectDelay startet bei 1000ms): refresh() -> drainQueue() -> connectWs().
    await vi.advanceTimersByTimeAsync(1100);
    await flush();

    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(await readQueue('d-reconnect')).toHaveLength(0);
    expect(desktop.status).toBe('online');
  });
});

describe('drainQueue: Dubletten-Erkennung, Konflikt-Zusammenfassung, Obergrenze (Task 2, SAFE-02, D-15/D-16)', () => {
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

  function fakeClient(deskId: string, freshState: DesktopState, sendCommand: ReturnType<typeof vi.fn>): ApiClient {
    return {
      status: async () => ({ needsSetup: false, needsModeChoice: false, mode: 'standalone' as const }),
      listDesks: async () => [{ id: deskId, name: 'Schreibtisch', ownerId: 'u1' }],
      getState: async () => ({ rev: 2, state: freshState, rolle: 'Eigentümer' as const }),
      sendCommand,
      wsTicket: async () => ({ ticket: 't' }),
      wsUrl: () => 'ws://test',
    } as unknown as ApiClient;
  }

  /** Startet online, trennt sofort (offline), damit ein Command direkt in die Warteschlange
   *  geht statt online gesendet zu werden — Grundzustand für alle Tests dieses Blocks. */
  async function starteUndTrenne(client: ApiClient): Promise<void> {
    await desktop.start(client);
    await flush();
    FakeWebSocket.instances[0].onclose?.({ code: 1006 } as CloseEvent);
    await flush();
  }

  const notiz = (id: string): Note => ({ id, kind: 'notiz', text: 'x', position: { x: 0, y: 0 }, zIndex: 0 });

  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await desktop.stop();
    vi.unstubAllGlobals();
    ui.toast = null;
  });

  it('bereits angewendetes erzeugendes Command wird nicht erneut gesendet', async () => {
    const deskId = 'd-dup';
    const freshState = { ...emptyState(), notes: [notiz('n-dup')] };
    const sendCommand = vi.fn();
    await starteUndTrenne(fakeClient(deskId, freshState, sendCommand));
    expect(desktop.status).toBe('offline');

    await desktop.command('addNote', { kind: 'notiz', text: 'x', position: { x: 0, y: 0 }, id: 'n-dup' });
    ui.toast = null; // Offline-Meldung des Enqueue-Aufrufs selbst löschen — hier zählt nur der Drain.

    await vi.advanceTimersByTimeAsync(1100);
    await flush();

    expect(sendCommand).not.toHaveBeenCalled();
    expect(await readQueue(deskId)).toHaveLength(0);
    expect(ui.toast).toBeNull();
  });

  it('ein NICHT bereits angewendetes erzeugendes Command wird gesendet', async () => {
    const deskId = 'd-nodup';
    const freshState = { ...emptyState(), notes: [] as Note[] };
    const sendCommand = vi.fn(async () => ({ rev: 3, state: { ...emptyState(), notes: [notiz('n-neu')] } }));
    await starteUndTrenne(fakeClient(deskId, freshState, sendCommand));

    await desktop.command('addNote', { kind: 'notiz', text: 'x', position: { x: 0, y: 0 }, id: 'n-neu' });
    ui.toast = null; // Offline-Meldung des Enqueue-Aufrufs selbst löschen — hier zählt nur der Drain.

    await vi.advanceTimersByTimeAsync(1100);
    await flush();

    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(await readQueue(deskId)).toHaveLength(0);
    expect(ui.toast).toBeNull();
  });

  // SESS-03 (11-06): Dieser Fall belegt ausdrücklich die Behauptung „SESS-03 braucht KEINEN
  // neuen Offline-Mechanismus" — er prüft nicht nur eine weitere Notiz-Variante, sondern dass
  // eine im Sitzungsmodus erfasste Sitzungsnotiz denselben desktop.command()-Pfad, dieselbe
  // IndexedDB-Warteschlange und denselben Drain nutzt wie jede andere Änderung. Die Sitzungs-
  // notiz trägt clientseitig ihre id mit, damit die bestehende Dubletten-Erkennung greift.
  it('SESS-03: eine offline erfasste Sitzungsnotiz läuft über den Bestandspfad (kein neuer Mechanismus)', async () => {
    const deskId = 'd-sess03';
    const freshState = { ...emptyState(), notes: [] as Note[] };
    const sendCommand = vi.fn(async () => ({
      rev: 3,
      state: { ...emptyState(), notes: [{ ...notiz('n-sitzung'), sitzungsnotiz: true as const }] },
    }));
    await starteUndTrenne(fakeClient(deskId, freshState, sendCommand));
    expect(desktop.status).toBe('offline');
    const wartestandVorher = desktop.pendingCount;

    // Genau das Kommando, das die Sitzungsmodus-Chrome beim Speichern sendet.
    await desktop.command('addNote', {
      kind: 'notiz', text: 'Sitzungspunkt: Zeuge B laden', position: { x: 0, y: 0 },
      id: 'n-sitzung', sitzungsnotiz: true,
    });

    // Landet in der Warteschlange DIESES Schreibtischs und trägt das Kennzeichen im Nutzdatenteil.
    const queue = await readQueue(deskId);
    expect(queue).toHaveLength(1);
    expect(queue[0].cmd.type).toBe('addNote');
    expect(queue[0].cmd.payload).toMatchObject({ id: 'n-sitzung', sitzungsnotiz: true });
    // Der aggregierte Wartestandszähler steigt um genau eins (E3/partial: kein feinerer Zustand).
    expect(desktop.pendingCount).toBe(wartestandVorher + 1);

    // Wiederverbinden: genau dieses Kommando wird einmal gesendet, die Warteschlange ist leer.
    await vi.advanceTimersByTimeAsync(1100);
    await flush();

    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(sendCommand).toHaveBeenCalledWith(deskId, expect.objectContaining({
      type: 'addNote',
      payload: expect.objectContaining({ id: 'n-sitzung', sitzungsnotiz: true }),
    }));
    expect(await readQueue(deskId)).toHaveLength(0);
  });

  it('SESS-03/idempotency: ein bereits serverseitig vorhandene Sitzungsnotiz wird nicht erneut gesendet', async () => {
    const deskId = 'd-sess03-dup';
    // Serverseitiger Zustand enthält die Notiz bereits (gleiche id) — z. B. weil ein erster
    // Drain die Antwort verloren hatte und die Warteschlange erneut abgearbeitet wird.
    const freshState = { ...emptyState(), notes: [{ ...notiz('n-sitzung-dup'), sitzungsnotiz: true as const }] };
    const sendCommand = vi.fn();
    await starteUndTrenne(fakeClient(deskId, freshState, sendCommand));

    await desktop.command('addNote', {
      kind: 'notiz', text: 'x', position: { x: 0, y: 0 }, id: 'n-sitzung-dup', sitzungsnotiz: true,
    });
    ui.toast = null; // Offline-Meldung des Enqueue-Aufrufs selbst löschen — hier zählt nur der Drain.

    await vi.advanceTimersByTimeAsync(1100);
    await flush();

    // Dubletten-Erkennung: das bereits angewendete Erzeugungs-Kommando wird übersprungen —
    // ein zweifach abgearbeiteter Drain erzeugt KEINE zweite Sitzungsnotiz.
    expect(sendCommand).not.toHaveBeenCalled();
    expect(await readQueue(deskId)).toHaveLength(0);
  });

  it('409 beim Nachspielen: Eintrag entfernt, ein Sammel-Toast, kein Overlay', async () => {
    const deskId = 'd-409';
    const konflikt: Konflikt = { objektId: 'n-x', typ: 'notiz', art: 'geaendert', von: 'Kollegin', am: null };
    const freshState = { ...emptyState(), notes: [] as Note[] };
    const sendCommand = vi.fn(async () => {
      throw new KonfliktAntwort(konflikt);
    });
    await starteUndTrenne(fakeClient(deskId, freshState, sendCommand));

    await desktop.command('moveNote', { id: 'n-x', position: { x: 5, y: 5 } });

    await vi.advanceTimersByTimeAsync(1100);
    await flush();

    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(await readQueue(deskId)).toHaveLength(0);
    expect(ui.konflikt).toBeNull();
    expect(ui.toast).toBe('1 Änderung konnte nicht nachgetragen werden — der Schreibtisch wurde zwischenzeitlich geändert.');
  });

  it('403 beim Nachspielen: Eintrag entfernt und gezählt, WR-07: neutrale Meldung statt der (hier unzutreffenden) Konflikt-Formulierung', async () => {
    const deskId = 'd-403';
    const freshState = { ...emptyState(), notes: [] as Note[] };
    const sendCommand = vi.fn(async () => {
      throw new ApiError('Nur dem Eigentümer vorbehalten.', 403);
    });
    await starteUndTrenne(fakeClient(deskId, freshState, sendCommand));

    await desktop.command('moveNote', { id: 'n-x', position: { x: 5, y: 5 } });

    await vi.advanceTimersByTimeAsync(1100);
    await flush();

    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(await readQueue(deskId)).toHaveLength(0);
    expect(ui.konflikt).toBeNull();
    // WR-07: 403 hat nichts mit "der Schreibtisch wurde zwischenzeitlich geändert" zu tun —
    // diese Formulierung bleibt jetzt ausschliesslich echten 409-Konflikten vorbehalten.
    expect(ui.toast).toBe('1 Änderung konnte nicht nachgetragen werden.');
  });

  it('CR-02-Regression: 400 (CommandError) beim Nachspielen wird verworfen statt die Warteschlange zu wedgen — nachfolgende Einträge werden weiter verarbeitet', async () => {
    const deskId = 'd-400';
    const freshState = { ...emptyState(), notes: [] as Note[] };
    const sendCommand = vi
      .fn()
      // Erster Eintrag: deterministischer Client-/Serverfehler — würde bei jedem erneuten
      // Versuch identisch fehlschlagen (kein Netzfehler, s. CR-02).
      .mockRejectedValueOnce(new ApiError('Unbekannter Objektbezug.', 400))
      // Zweiter Eintrag: müsste trotzdem noch gesendet werden — vor dem CR-02-Fix hätte der
      // 400er-Fehlschlag des ersten Eintrags die gesamte FIFO-Schleife abgebrochen (break) und
      // diesen Eintrag nie erreicht.
      .mockResolvedValueOnce({ rev: 3, state: { ...emptyState(), notes: [notiz('n-nach-400')] } });
    await starteUndTrenne(fakeClient(deskId, freshState, sendCommand));

    await desktop.command('moveNote', { id: 'n-x', position: { x: 5, y: 5 } });
    await desktop.command('addNote', { kind: 'notiz', text: 'y', position: { x: 1, y: 1 }, id: 'n-nach-400' });
    ui.toast = null; // Offline-Meldung des Enqueue-Aufrufs selbst löschen — hier zählt nur der Drain.

    await vi.advanceTimersByTimeAsync(1100);
    await flush();

    expect(sendCommand).toHaveBeenCalledTimes(2); // NICHT nach dem ersten Fehlschlag abgebrochen
    expect(await readQueue(deskId)).toHaveLength(0); // beide Einträge sind weg — keiner wedgt
    expect(ui.konflikt).toBeNull();
    // WR-07: 400 ist kein Konflikt — die "Schreibtisch geändert"-Formulierung wäre hier irreführend.
    expect(ui.toast).toBe('1 Änderung konnte nicht nachgetragen werden.');
  });

  it('WR-06-Regression: ein 5xx beim Nachspielen bleibt zunächst wie ein Netzfehler stehen (kein sofortiges Verwerfen) und wird erst nach MAX_5XX_VERSUCHE endgültig verworfen', async () => {
    const deskId = 'd-5xx';
    const freshState = { ...emptyState(), notes: [] as Note[] };
    // Schlägt bei JEDEM Versuch mit einem transienten Serverfehler fehl — anders als 400/403/404
    // (CR-02) darf das den Eintrag NICHT beim ersten Fehlschlag wegwerfen (WR-06).
    const sendCommand = vi.fn(async () => {
      throw new ApiError('Interner Serverfehler.', 503);
    });
    await starteUndTrenne(fakeClient(deskId, freshState, sendCommand));

    await desktop.command('moveNote', { id: 'n-x', position: { x: 5, y: 5 } });
    ui.toast = null; // Offline-Meldung des Enqueue-Aufrufs selbst löschen — hier zählt nur der Drain.

    // Versuch 1: 503 -> wie ein Netzfehler behandelt, Eintrag bleibt stehen, KEINE Meldung.
    await vi.advanceTimersByTimeAsync(1100);
    await flush();
    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(await readQueue(deskId)).toHaveLength(1);
    expect(ui.toast).toBeNull();
    expect(desktop.status).toBe('online'); // Reconnect selbst gelingt trotzdem (WS öffnet erfolgreich)

    // Versuch 2: erneut 503 -> Eintrag bleibt IMMER NOCH stehen, weiterhin keine Meldung.
    FakeWebSocket.instances.at(-1)?.onclose?.({ code: 1006 } as CloseEvent);
    await flush();
    await vi.advanceTimersByTimeAsync(1100);
    await flush();
    expect(sendCommand).toHaveBeenCalledTimes(2);
    expect(await readQueue(deskId)).toHaveLength(1);
    expect(ui.toast).toBeNull();

    // Versuch 3 (= MAX_5XX_VERSUCHE): jetzt endgültig aufgeben — Eintrag weg, neutrale Meldung
    // (WR-07: kein "Schreibtisch geändert", das stimmt für einen Serverfehler nicht).
    FakeWebSocket.instances.at(-1)?.onclose?.({ code: 1006 } as CloseEvent);
    await flush();
    await vi.advanceTimersByTimeAsync(1100);
    await flush();
    expect(sendCommand).toHaveBeenCalledTimes(3);
    expect(await readQueue(deskId)).toHaveLength(0);
    expect(ui.toast).toBe('1 Änderung konnte nicht nachgetragen werden.');
  });

  it('ein Netzfehler beim Nachspielen bricht ab und lässt die restlichen Einträge stehen', async () => {
    const deskId = 'd-netzfehler';
    const freshState = { ...emptyState(), notes: [] as Note[] };
    const sendCommand = vi.fn(async () => {
      throw new Error('Netzwerk nicht erreichbar');
    });
    await starteUndTrenne(fakeClient(deskId, freshState, sendCommand));

    await desktop.command('addNote', { kind: 'notiz', text: 'a', position: { x: 0, y: 0 } });
    await desktop.command('addNote', { kind: 'notiz', text: 'b', position: { x: 0, y: 0 } });
    ui.toast = null; // Offline-Meldung des Enqueue-Aufrufs selbst löschen — hier zählt nur der Drain.

    await vi.advanceTimersByTimeAsync(1100);
    await flush();

    expect(sendCommand).toHaveBeenCalledTimes(1); // bricht beim ersten Fehlschlag ab
    expect(await readQueue(deskId)).toHaveLength(2); // beide bleiben stehen, keine Meldung
    expect(ui.toast).toBeNull();
  });

  it('ein Durchlauf ganz ohne Verwerfen erzeugt keine Meldung', async () => {
    const deskId = 'd-clean';
    const freshState = { ...emptyState(), notes: [] as Note[] };
    const sendCommand = vi.fn(async () => ({ rev: 3, state: { ...emptyState(), notes: [notiz('n-clean')] } }));
    await starteUndTrenne(fakeClient(deskId, freshState, sendCommand));

    await desktop.command('addNote', { kind: 'notiz', text: 'x', position: { x: 0, y: 0 }, id: 'n-clean' });
    ui.toast = null; // Offline-Meldung des Enqueue-Aufrufs selbst löschen — hier zählt nur der Drain.

    await vi.advanceTimersByTimeAsync(1100);
    await flush();

    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(ui.toast).toBeNull();
  });

  it(
    'volle Warteschlange lehnt das neue Command ab und verliert keinen Eintrag',
    async () => {
      const deskId = 'd-max';
      const freshState = { ...emptyState(), notes: [] as Note[] };
      const sendCommand = vi.fn();

      // Vorbefüllen VOR desktop.start()/dem Verbindungsabbruch UND parallel statt sequentiell:
      // direkte add()-Aufrufe über den Roh-Transaktionshelfer (ohne enqueueCommand()s eigenen
      // queueLength()-Scan je Aufruf) — 500 sequentiell await'ete IndexedDB-Transaktionen
      // würden real spürbare Zeit kosten; parallel bleibt der Testaufbau schnell.
      await Promise.all(
        Array.from({ length: MAX_QUEUE }, (_, i) => {
          const eintrag: QueueEintrag = {
            deskId,
            cmd: { type: 'addNote', payload: { kind: 'notiz', text: `n${i}`, position: { x: 0, y: 0 } } } as unknown as Command,
            queuedAt: Date.now(),
          };
          return tx(QUEUE_STORE, 'readwrite', (s) => s.add(eintrag));
        }),
      );
      const vorher = await readQueue(deskId);
      expect(vorher).toHaveLength(MAX_QUEUE);

      await starteUndTrenne(fakeClient(deskId, freshState, sendCommand));
      const notesVorher = (desktop.state.notes ?? []).length;

      await desktop.command('addNote', { kind: 'notiz', text: 'zu-viel', position: { x: 0, y: 0 } });

      const nachher = await readQueue(deskId);
      expect(nachher).toHaveLength(MAX_QUEUE); // kein Eintrag verdrängt, keiner zusätzlich eingereiht
      expect((desktop.state.notes ?? []).length).toBe(notesVorher); // optimistische Anwendung zurückgenommen
      expect(sendCommand).not.toHaveBeenCalled();
      expect(ui.toast).toBe('Zu viele nicht übertragene Änderungen — bitte erst die Verbindung wiederherstellen.');
    },
    20000,
  );
});

describe('pendingCount folgt der Warteschlange (Task 3, D-03)', () => {
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

  function fakeClient(deskId: string, sendCommand: ReturnType<typeof vi.fn>): ApiClient {
    return {
      status: async () => ({ needsSetup: false, needsModeChoice: false, mode: 'standalone' as const }),
      listDesks: async () => [{ id: deskId, name: 'Schreibtisch', ownerId: 'u1' }],
      getState: async () => ({ rev: 1, state: stateMitNotizen(0), rolle: 'Eigentümer' as const }),
      sendCommand,
      wsTicket: async () => ({ ticket: 't' }),
      wsUrl: () => 'ws://test',
    } as unknown as ApiClient;
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
    ui.toast = null;
  });

  it('steigt mit jedem Einreihen und fällt nach erfolgreichem Drain wieder auf 0', async () => {
    const deskId = 'd-pending';
    const sendCommand = vi.fn(async () => ({ rev: 2, state: stateMitNotizen(0) }));
    await desktop.start(fakeClient(deskId, sendCommand));
    await flush();

    FakeWebSocket.instances[0].onclose?.({ code: 1006 } as CloseEvent);
    await flush();
    expect(desktop.status).toBe('offline');

    await desktop.command('addNote', { kind: 'notiz', text: 'a', position: { x: 0, y: 0 } });
    await desktop.command('addNote', { kind: 'notiz', text: 'b', position: { x: 0, y: 0 } });
    expect(desktop.pendingCount).toBe(2);

    await vi.advanceTimersByTimeAsync(1100);
    await flush();

    expect(desktop.pendingCount).toBe(0);
    expect(sendCommand).toHaveBeenCalledTimes(2);
  });

  it('fällt nach desktop.stop() auf 0 zurück', async () => {
    const deskId = 'd-pending-stop';
    const sendCommand = vi.fn();
    await desktop.start(fakeClient(deskId, sendCommand));
    await flush();

    FakeWebSocket.instances[0].onclose?.({ code: 1006 } as CloseEvent);
    await flush();

    await desktop.command('addNote', { kind: 'notiz', text: 'a', position: { x: 0, y: 0 } });
    expect(desktop.pendingCount).toBe(1);

    await desktop.stop();
    expect(desktop.pendingCount).toBe(0);
  });
});
