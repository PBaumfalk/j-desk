import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyCommand, emptyState, type Command, type DesktopState } from '@j-desk/core';
import { desktop, LAYER_FALLBACK } from './store.svelte';
import { ApiError, type ApiClient } from './api';
import { ui } from './ui.svelte';
import { ladeDateiHoch } from './upload';

/**
 * Gemeinsamer Upload-Pfad (MOBILE-02, 11-09 Task 1): die aus Desktop.svelte extrahierte
 * Funktion ist der EINZIGE Upload-Weg — Tisch und Telefon-Schnellzugriff teilen ihn, damit
 * es strukturell keinen zweiten, laxeren Pfad geben kann (T-11-02). Testform nach
 * store.403.test.ts: echter Store + Fake-ApiClient, kein Netzwerk.
 */

/** Minimaler Fake-Socket (Muster store.403.test.ts); kein echtes Netzwerk. */
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

/** Mehrere Event-Loop-Runden abwarten (WS-Connect ist eine async-Kette). */
async function flush(ticks = 20): Promise<void> {
  for (let i = 0; i < ticks; i++) await new Promise((r) => setTimeout(r, 0));
}

interface GesendetesKommando {
  type: string;
  payload: Record<string, unknown>;
}

interface UploadAufruf {
  bytes: Uint8Array;
  name: string;
  mime?: string;
}

/** Eigenständiger Betrieb: Upload über /files, danach addDoc- und ggf. changeLayerId-Kommando. */
function standaloneClient(opts: { uploadFehler?: unknown } = {}) {
  let rev = 1;
  let st: DesktopState = emptyState();
  const kommandos: GesendetesKommando[] = [];
  const uploads: UploadAufruf[] = [];
  const client = {
    status: async () => ({ needsSetup: false, needsModeChoice: false, mode: 'standalone' as const }),
    listDesks: async () => [{ id: 'd1', name: 'Schreibtisch 1', ownerId: 'u1' }],
    getState: async () => ({ rev, state: st, rolle: 'Eigentümer' }),
    wsTicket: async () => ({ ticket: 't' }),
    wsUrl: () => 'ws://test',
    uploadFile: async (bytes: Uint8Array, name: string, mime?: string) => {
      if (opts.uploadFehler) throw opts.uploadFehler;
      uploads.push({ bytes, name, mime });
      return { fileId: 'f-hochgeladen', kind: 'pdf' as const };
    },
    sendCommand: async (_deskId: string, cmd: Command) => {
      kommandos.push({ type: cmd.type, payload: cmd.payload ?? {} });
      st = applyCommand(st, cmd);
      rev += 1;
      return { rev, state: st };
    },
  } as unknown as ApiClient;
  return { client, kommandos, uploads };
}

/** Aktenbetrieb: Upload über die Akten-Schnittstelle; die Karte legt der Server an. */
function jlawyerClient(opts: { uploadFehler?: unknown } = {}) {
  let rev = 7;
  let st: DesktopState = emptyState();
  const kommandos: GesendetesKommando[] = [];
  const aktenUploads: { caseId: string; bytes: Uint8Array; name: string }[] = [];
  const client = {
    status: async () => ({ needsSetup: false, needsModeChoice: false, mode: 'jlawyer' as const }),
    getCases: async () => [{ id: 'c1', fileNumber: '123/26', name: 'Akte A', reason: '' }],
    getCaseDesk: async () => ({ rev, state: st, rolle: 'Eigentümer' }),
    wsTicket: async () => ({ ticket: 't' }),
    wsUrl: () => 'ws://test',
    uploadToCase: async (caseId: string, bytes: Uint8Array, name: string) => {
      if (opts.uploadFehler) throw opts.uploadFehler;
      aktenUploads.push({ caseId, bytes, name });
      rev += 1;
      return { rev, state: st };
    },
    sendCommand: async (_deskId: string, cmd: Command) => {
      kommandos.push({ type: cmd.type, payload: cmd.payload ?? {} });
      st = applyCommand(st, cmd);
      rev += 1;
      return { rev, state: st };
    },
  } as unknown as ApiClient;
  return { client, kommandos, aktenUploads };
}

function testDatei(name = 'beleg.pdf', type = 'application/pdf'): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type });
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
  desktop.setActiveLayer(LAYER_FALLBACK);
  await desktop.stop(); // räumt ggf. eingeplante Reconnect-Timer ab
  ui.toast = null;
  vi.unstubAllGlobals();
});

describe('ladeDateiHoch ohne Verbindung', () => {
  it('tut nichts und wirft nicht, wenn weder Verbindung noch Schreibtisch geladen sind', async () => {
    // Frischer Modulzustand: desktop.api und desktop.deskId sind null.
    expect(desktop.api).toBeNull();
    expect(desktop.deskId).toBeNull();
    await expect(ladeDateiHoch(testDatei(), { x: 1, y: 2 })).resolves.toBeUndefined();
    expect(ui.toast).toBeNull();
  });
});

describe('ladeDateiHoch im eigenständigen Betrieb', () => {
  it('lädt die Datei hoch und sendet genau ein Karten-Anlege-Kommando', async () => {
    const { client, kommandos, uploads } = standaloneClient();
    await desktop.start(client);
    await flush();
    expect(desktop.status).toBe('online');

    await ladeDateiHoch(testDatei(), { x: 10, y: 20 });

    expect(uploads).toHaveLength(1);
    expect(uploads[0].name).toBe('beleg.pdf');
    expect(uploads[0].mime).toBe('application/pdf');
    const anlagen = kommandos.filter((k) => k.type === 'addDoc');
    expect(anlagen).toHaveLength(1);
    expect(anlagen[0].payload).toMatchObject({
      fileId: 'f-hochgeladen',
      name: 'beleg.pdf',
      kind: 'pdf',
      position: { x: 10, y: 20 },
    });
  });

  it('sendet bei der Standard-Ebene KEIN Ebenen-Zuweisungs-Kommando', async () => {
    const { client, kommandos } = standaloneClient();
    await desktop.start(client);
    await flush();

    await ladeDateiHoch(testDatei(), { x: 0, y: 0 });

    expect(kommandos.filter((k) => k.type === 'changeLayerId')).toHaveLength(0);
  });

  it('weist die neue Karte bei aktiver Nicht-Standard-Ebene genau einmal zu', async () => {
    const { client, kommandos } = standaloneClient();
    await desktop.start(client);
    await flush();

    desktop.setActiveLayer('e-privat');
    await ladeDateiHoch(testDatei(), { x: 0, y: 0 });

    const anlagen = kommandos.filter((k) => k.type === 'addDoc');
    const zuweisungen = kommandos.filter((k) => k.type === 'changeLayerId');
    expect(anlagen).toHaveLength(1);
    expect(zuweisungen).toHaveLength(1);
    expect(zuweisungen[0].payload).toMatchObject({ layerId: 'e-privat' });
    expect(zuweisungen[0].payload.objectId).toBe(anlagen[0].payload.id);
  });
});

describe('ladeDateiHoch im Aktenbetrieb', () => {
  it('lädt über die Akten-Schnittstelle hoch, übernimmt den Serverzustand und sendet KEIN Karten-Kommando', async () => {
    const { client, kommandos, aktenUploads } = jlawyerClient();
    await desktop.start(client);
    await flush();
    expect(desktop.mode).toBe('jlawyer');

    await ladeDateiHoch(testDatei('foto.jpg', 'image/jpeg'), { x: 0, y: 0 });

    expect(aktenUploads).toHaveLength(1);
    expect(aktenUploads[0].caseId).toBe('c1');
    expect(aktenUploads[0].name).toBe('foto.jpg');
    expect(kommandos.filter((k) => k.type === 'addDoc')).toHaveLength(0);
  });
});

describe('ladeDateiHoch Fehlerbehandlung', () => {
  it('zeigt bei einem Berechtigungsfehler exakt den Bestands-Berechtigungs-Toast', async () => {
    const { client } = standaloneClient({ uploadFehler: new ApiError('Forbidden', 403) });
    await desktop.start(client);
    await flush();

    await ladeDateiHoch(testDatei(), { x: 0, y: 0 });

    // Derselbe Wortlaut wie der bisherige addFile-Pfad (TOAST_403_TEXT.upload) —
    // keine laxere oder andere Berechtigungsschicht fürs Telefon (T-11-02).
    expect(ui.toast).toBe('Hochladen ist mit Ihrer Rolle nicht möglich.');
  });

  it('zeigt bei jedem anderen Fehler die Fehlermeldung', async () => {
    const { client } = standaloneClient({ uploadFehler: new Error('Speicher voll') });
    await desktop.start(client);
    await flush();

    await ladeDateiHoch(testDatei(), { x: 0, y: 0 });

    expect(ui.toast).toBe('Speicher voll');
  });

  it('zeigt bei einem Nicht-Error-Wurf den Ersatztext mit dem Dateinamen', async () => {
    const { client } = standaloneClient({ uploadFehler: 'kaputt' });
    await desktop.start(client);
    await flush();

    await ladeDateiHoch(testDatei(), { x: 0, y: 0 });

    expect(ui.toast).toBe('Upload fehlgeschlagen: beleg.pdf');
  });
});
