import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyState, type DesktopState, type Doc, type Rolle } from '@j-desk/core';
import { desktop, anzeigeEbeneId, darfAktionClient, filterByVisibleLayers, resetVisibleLayers, sortierteEbenenFuerPanel } from './store.svelte';
import type { ApiClient } from './api';

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('Ebenen-Umschalter: currentLayerId (PERM-01, Task 1)', () => {
  beforeEach(() => {
    localStorage.clear();
    desktop.wechsleWerkzeug('standard'); // definierter Ausgangszustand vor jedem Test
  });

  it('hat Default \'kanzlei\'', () => {
    desktop.wechsleWerkzeug('frisches-werkzeug');
    expect(desktop.currentLayerId).toBe('kanzlei');
  });

  it('setActiveLayer persistiert und liefert die zuletzt gewählte Ebene pro Werkzeug beim Werkzeugwechsel zurück (kein Reset)', () => {
    desktop.wechsleWerkzeug('stift');
    desktop.setActiveLayer('privat');
    expect(desktop.currentLayerId).toBe('privat');

    // Anderes Werkzeug, noch nie gewählt -> Default, KEIN Übertrag von 'stift'.
    desktop.wechsleWerkzeug('schere');
    expect(desktop.currentLayerId).toBe('kanzlei');

    // Zurück zum ersten Werkzeug: die Wahl von vorhin ist noch da (kein Reset).
    desktop.wechsleWerkzeug('stift');
    expect(desktop.currentLayerId).toBe('privat');
  });

  it('unbekannte/veraltete gespeicherte Ebene fällt auf \'kanzlei\' zurück', () => {
    localStorage.setItem('jdesk.layer.stift', 'laengst-geloeschte-ebene');
    desktop.wechsleWerkzeug('stift');
    expect(desktop.currentLayerId).toBe('kanzlei');
  });
});

describe('Sichtbarkeits-Panel: visibleLayers (PERM-01/PERM-02, Task 2)', () => {
  beforeEach(() => resetVisibleLayers());

  it('filtert die angezeigten Objekte rein clientseitig über bereits projizierte Daten — Ausblenden entfernt Objekte aus der Anzeige, ohne den Server zu fragen', () => {
    const docs: Pick<Doc, 'id' | 'layerId'>[] = [
      { id: 'a', layerId: 'privat' },
      { id: 'b', layerId: 'kanzlei' },
      { id: 'c', layerId: undefined }, // fehlende layerId = implizit Kanzlei (Bestandsverhalten)
    ];

    // Vor dem Ausblenden: alles sichtbar.
    expect(filterByVisibleLayers(docs, desktop.visibleLayers, desktop.state).map((d) => d.id)).toEqual(['a', 'b', 'c']);

    desktop.toggleLayerVisibility('privat');
    expect(filterByVisibleLayers(docs, desktop.visibleLayers, desktop.state).map((d) => d.id)).toEqual(['b', 'c']);

    // Erneutes Umschalten macht es wieder sichtbar (Toggle, kein Einweg-Ausblenden).
    desktop.toggleLayerVisibility('privat');
    expect(filterByVisibleLayers(docs, desktop.visibleLayers, desktop.state).map((d) => d.id)).toEqual(['a', 'b', 'c']);
  });

  it('wird bei Desk-Wechsel zurückgesetzt (kein Weiterzeigen des Vorgänger-Desks) — backstop', () => {
    desktop.toggleLayerVisibility('privat');
    expect(desktop.visibleLayers.has('privat')).toBe(false);

    resetVisibleLayers(); // wird von loadDesk() bei jedem Desk-Wechsel aufgerufen

    expect(desktop.visibleLayers.has('privat')).toBe(true);
  });
});

describe('filterByVisibleLayers mit Pro-Nutzer-Privat-Instanz (02-11, PERM-01)', () => {
  const stateMitInstanz: DesktopState = {
    ...emptyState(),
    layers: [
      // Pro-Nutzer-Privat-Instanz, wie sie 02-09 (ensurePrivateLayer) lazy materialisiert.
      { id: 'privat-u1', typ: 'privat', name: 'Privat', ownerUserId: 'u1' },
      { id: 'x1', typ: 'custom', name: 'Anlagenkonvolut' },
    ],
  };
  const objektAufInstanz = { id: 'p1', layerId: 'privat-u1' };

  it('Panel-Zeile \'privat\' steuert Sichtbarkeit eigener Privat-Objekte (ein/aus) — die Instanz-id im sichtbaren Set allein hält das Objekt NICHT sichtbar', () => {
    const ohnePrivat = new Set(['kanzlei', 'ki-vorschlaege', 'exportierbar', 'x1', 'privat-u1']);
    const mitPrivat = new Set([...ohnePrivat, 'privat']);
    expect(filterByVisibleLayers([objektAufInstanz], ohnePrivat, stateMitInstanz)).toEqual([]);
    expect(filterByVisibleLayers([objektAufInstanz], mitPrivat, stateMitInstanz).map((o) => o.id)).toEqual(['p1']);
  });

  it('ein Objekt derselben Instanz bleibt unberührt, wenn eine ANDERE Ebene ausgeblendet wird', () => {
    const ohneKanzlei = new Set(['privat', 'ki-vorschlaege', 'exportierbar', 'x1']);
    expect(filterByVisibleLayers([objektAufInstanz], ohneKanzlei, stateMitInstanz).map((o) => o.id)).toEqual(['p1']);
    const ohneCustom = new Set(['kanzlei', 'privat', 'ki-vorschlaege', 'exportierbar']);
    expect(filterByVisibleLayers([objektAufInstanz], ohneCustom, stateMitInstanz).map((o) => o.id)).toEqual(['p1']);
  });

  it('Bestandsverhalten bleibt: Objekte ohne layerId gelten als kanzlei, custom-/System-Objekte filtern wie bisher', () => {
    const objs = [
      { id: 'a', layerId: undefined as string | undefined },
      { id: 'b', layerId: 'kanzlei' },
      { id: 'c', layerId: 'x1' },
      { id: 'd', layerId: 'exportierbar' },
    ];
    const alles = new Set(['kanzlei', 'privat', 'ki-vorschlaege', 'exportierbar', 'x1']);
    expect(filterByVisibleLayers(objs, alles, stateMitInstanz).map((o) => o.id)).toEqual(['a', 'b', 'c', 'd']);
    const ohneKanzlei = new Set(['privat', 'ki-vorschlaege', 'exportierbar', 'x1']);
    expect(filterByVisibleLayers(objs, ohneKanzlei, stateMitInstanz).map((o) => o.id)).toEqual(['c', 'd']);
    const ohneCustom = new Set(['kanzlei', 'privat', 'ki-vorschlaege', 'exportierbar']);
    expect(filterByVisibleLayers(objs, ohneCustom, stateMitInstanz).map((o) => o.id)).toEqual(['a', 'b', 'd']);
  });

  it('UAT-nah: ein geladenes Instanz-Objekt folgt desktop.visibleLayers + toggleLayerVisibility(\'privat\') ein/aus', async () => {
    /** Gleiches Fake-Socket-Muster wie im currentRolle-Block unten — kein echtes Netzwerk. */
    class FakeWebSocket {
      onopen: (() => void) | null = null;
      onclose: (() => void) | null = null;
      onmessage: ((ev: MessageEvent) => void) | null = null;
      constructor() {
        queueMicrotask(() => this.onopen?.());
      }
      close(): void {}
    }
    const client = {
      status: async () => ({ needsSetup: false, needsModeChoice: false, mode: 'standalone' as const }),
      listDesks: async () => [{ id: 'd1', name: 'Schreibtisch 1', ownerId: 'u1' }],
      getState: async () => ({ rev: 1, state: stateMitInstanz, rolle: 'Eigentümer' as Rolle }),
      wsTicket: async () => ({ ticket: 't' }),
      wsUrl: () => 'ws://test',
    } as unknown as ApiClient;

    vi.stubGlobal('WebSocket', FakeWebSocket);
    resetVisibleLayers();
    await desktop.start(client);
    try {
      const docs = [objektAufInstanz];
      // geladener Desk, nichts ausgeblendet: Instanz-Objekt sichtbar (über Zeile 'privat').
      expect(filterByVisibleLayers(docs, desktop.visibleLayers, desktop.state).map((d) => d.id)).toEqual(['p1']);

      desktop.toggleLayerVisibility('privat');
      expect(filterByVisibleLayers(docs, desktop.visibleLayers, desktop.state)).toEqual([]);

      desktop.toggleLayerVisibility('privat');
      expect(filterByVisibleLayers(docs, desktop.visibleLayers, desktop.state).map((d) => d.id)).toEqual(['p1']);
    } finally {
      await desktop.stop();
      resetVisibleLayers();
    }
  });
});

describe('Sichtbarkeits-Panel: Zeilenreihenfolge (Task 2)', () => {
  it('ist fest: Kanzlei -> privat -> KI-Vorschläge -> exportierbar -> custom alphabetisch, egal in welcher Reihenfolge state.layers sie enthält', () => {
    const s: DesktopState = {
      ...emptyState(),
      layers: [
        { id: 'x2', typ: 'custom', name: 'Zeugenbefragung' },
        { id: 'x1', typ: 'custom', name: 'Anlagenkonvolut' },
      ],
    };
    expect(sortierteEbenenFuerPanel(s).map((e) => e.id)).toEqual([
      'kanzlei', 'privat', 'ki-vorschlaege', 'exportierbar', 'x1', 'x2',
    ]);
  });

  it('bleibt bei null/leeren custom-Ebenen bei genau den vier Systemebenen (zero-one-many)', () => {
    expect(sortierteEbenenFuerPanel(emptyState()).map((e) => e.id)).toEqual([
      'kanzlei', 'privat', 'ki-vorschlaege', 'exportierbar',
    ]);
  });
});

describe('anzeigeEbeneId (02-11, PERM-01): Auflösung Roh-layerId → Panel-/Anzeige-id', () => {
  const stateMitInstanz: DesktopState = {
    ...emptyState(),
    layers: [
      // Pro-Nutzer-Privat-Instanz, wie sie 02-09 (ensurePrivateLayer) lazy materialisiert.
      { id: 'privat-u1', typ: 'privat', name: 'Privat', ownerUserId: 'u1' },
      { id: 'x1', typ: 'custom', name: 'Anlagenkonvolut' },
    ],
  };

  it('bildet fehlende layerId auf den LAYER_FALLBACK (kanzlei) ab', () => {
    expect(anzeigeEbeneId(stateMitInstanz, undefined)).toBe('kanzlei');
  });

  it('System-ids bleiben sich selbst', () => {
    for (const id of ['kanzlei', 'privat', 'ki-vorschlaege', 'exportierbar']) {
      expect(anzeigeEbeneId(stateMitInstanz, id)).toBe(id);
    }
  });

  it('eigene Privat-Instanz (typ privat in state.layers) löst auf die Panel-Zeile privat auf', () => {
    expect(anzeigeEbeneId(stateMitInstanz, 'privat-u1')).toBe('privat');
  });

  it('custom-ids bleiben sich selbst', () => {
    expect(anzeigeEbeneId(stateMitInstanz, 'x1')).toBe('x1');
  });

  it('unbekannte id bleibt unverändert (fail-visible-Konvention, kein Versteck-Pfad)', () => {
    expect(anzeigeEbeneId(stateMitInstanz, 'laengst-geloeschte-ebene')).toBe('laengst-geloeschte-ebene');
  });
});

describe('darfAktionClient (PERM-04, 02-08 Task 2): rollengebundenes Ausblenden gefährlicher Aktionen', () => {
  it('spiegelt darfAktion() (@j-desk/core) für bekannte Rollen', () => {
    expect(darfAktionClient('Eigentümer', 'shred')).toBe(true);
    expect(darfAktionClient('Bearbeiter', 'shred')).toBe(false);
    expect(darfAktionClient('Bearbeiter', 'upload')).toBe(true);
    expect(darfAktionClient('Kommentator', 'upload')).toBe(false);
    expect(darfAktionClient('Nur-Lesen', 'manage')).toBe(false);
    expect(darfAktionClient('externer Gast', 'export')).toBe(false);
  });

  it('behandelt `null` (j-lawyer-Modus, noch keine Rollenvergabe) als erlaubt — Bestandsverhalten', () => {
    expect(darfAktionClient(null, 'shred')).toBe(true);
    expect(darfAktionClient(null, 'upload')).toBe(true);
    expect(darfAktionClient(null, 'manage')).toBe(true);
  });
});

describe('currentRolle: gesetzt aus dem Server-Zustand, folgt dem Desk-Wechsel, Reset beim Logout (PERM-04, 02-08 Task 2)', () => {
  /** Minimaler Fake-Socket — feuert `onopen` einen Tick nach der Zuweisung (openSocket() setzt
   *  die Handler synchron direkt nach dem Konstruktor), damit desktop.status auf 'online' kippt
   *  und switchDesk() dessen Online-Gate passiert; kein echtes Netzwerk beteiligt. */
  class FakeWebSocket {
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onmessage: ((ev: MessageEvent) => void) | null = null;
    constructor() {
      queueMicrotask(() => this.onopen?.());
    }
    close(): void {}
  }

  function fakeClient(rolleA: Rolle, rolleB: Rolle): ApiClient {
    return {
      status: async () => ({ needsSetup: false, needsModeChoice: false, mode: 'standalone' as const }),
      listDesks: async () => [
        { id: 'd1', name: 'Schreibtisch 1', ownerId: 'u1' },
        { id: 'd2', name: 'Schreibtisch 2', ownerId: 'u1' },
      ],
      getState: async (id: string) => ({ rev: 1, state: emptyState(), rolle: id === 'd1' ? rolleA : rolleB }),
      wsTicket: async () => ({ ticket: 't' }),
      wsUrl: () => 'ws://test',
    } as unknown as ApiClient;
  }

  it('wird nach dem Laden aus GET /state gesetzt, wechselt mit dem Desk und wird beim Logout zurückgesetzt', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const client = fakeClient('Bearbeiter', 'Kommentator');

    await desktop.start(client);
    expect(desktop.currentRolle).toBe('Bearbeiter');

    // Fake-WS-Handshake durchlaufen lassen, damit status='online' wird (switchDesk()-Gate).
    await new Promise((r) => setTimeout(r, 0));
    expect(desktop.status).toBe('online');

    await desktop.switchDesk('d2');
    expect(desktop.currentRolle).toBe('Kommentator');

    await desktop.stop();
    expect(desktop.currentRolle).toBeNull();
  });
});
