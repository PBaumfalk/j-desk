import { afterEach, describe, expect, it, vi } from 'vitest';

// menus.ts importiert transitiv thumbnails.ts (pdfjs-dist) — dieselben Mocks wie
// pageCounts.test.ts/pdfText.test.ts, sonst scheitert der Modul-Import in Node (kein DOMMatrix).
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: vi.fn(() => ({ promise: Promise.resolve({ numPages: 1, destroy: vi.fn() }) })),
}));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }));

import {
  emptyState, type Cutout, type DesktopState, type Doc, type LegalObject, type Note, type Rolle, type Stack, type TableCard,
  type ZeitleisteCard,
} from '@j-desk/core';
import {
  buildEbenenMenu, chipFuerEbene, chipFuerExtern, chipFuerFreigabe, darfEbeneBearbeitenClient, freigabeEintrag, showCutoutMenuAt,
  showDocMenuAt, showLegalObjectMenuAt, showNoteMenuAt, showStackMenuAt, showTableMenuAt, showViewerMenuAt,
  showZeitleisteMenuAt,
  parseDatumEingabe,
} from './menus';
import { desktop } from './store.svelte';
import { ui } from './ui.svelte';
import type { ApiClient } from './api';

const stateMitCustom: DesktopState = {
  ...emptyState(),
  layers: [
    { id: 'x1', typ: 'custom', name: 'Anlagenkonvolut', createdBy: 'Anwalt A', createdAt: '2026-07-20T10:00:00.000Z' },
  ],
};

/** 02-11: State mit materialisierter Pro-Nutzer-Privat-Instanz (ensurePrivateLayer aus 02-09). */
const stateMitPrivatInstanz: DesktopState = {
  ...emptyState(),
  layers: [
    { id: 'privat-u1', typ: 'privat', name: 'Privat', ownerUserId: 'u1' },
    { id: 'x1', typ: 'custom', name: 'Anlagenkonvolut', createdBy: 'Anwalt A', createdAt: '2026-07-20T10:00:00.000Z' },
  ],
};

describe('buildEbenenMenu (Task 3: Kontextmenü "Ebene ändern")', () => {
  it('liefert einen Eintrag pro verfügbarer Ebene (vier feste + custom)', () => {
    const items = buildEbenenMenu(stateMitCustom, 'kanzlei', () => {});
    expect(items).toHaveLength(5); // kanzlei, privat, ki-vorschlaege, exportierbar, x1
  });

  it('der aktuelle Eintrag trägt das \'✓ \'-Präfix, alle anderen nicht', () => {
    const items = buildEbenenMenu(stateMitCustom, 'privat', () => {});
    expect(items.filter((i) => i.label.startsWith('✓ '))).toHaveLength(1);
    expect(items.find((i) => i.label.startsWith('✓ '))?.label).toContain('privat'.replace('privat', 'Privat')); // "Privat" Name aus SYSTEM_EBENEN
  });

  it('fehlende aktuelleLayerId gilt implizit als kanzlei (Bestandsverhalten)', () => {
    const items = buildEbenenMenu(stateMitCustom, undefined, () => {});
    expect(items.find((i) => i.label.startsWith('✓ '))?.label).toContain('Kanzlei');
  });

  it('Klick auf einen Eintrag löst onSelect mit der jeweiligen layerId aus', () => {
    const ausgewaehlt: string[] = [];
    const items = buildEbenenMenu(stateMitCustom, 'kanzlei', (layerId) => ausgewaehlt.push(layerId));
    items.find((i) => i.label.includes('Anlagenkonvolut'))!.action();
    expect(ausgewaehlt).toEqual(['x1']);
  });
});

describe('darfEbeneBearbeitenClient (Task 3: Sichtbarkeit "Ebene ändern"-Eintrag)', () => {
  it('KI-Vorschläge sind nie direkt bearbeitbar (unabhängig von der Rolle)', () => {
    expect(darfEbeneBearbeitenClient('ki-vorschlaege', 'Eigentümer')).toBe(false);
    expect(darfEbeneBearbeitenClient('ki-vorschlaege', 'Bearbeiter')).toBe(false);
  });

  it('private Ebene ist bearbeitbar, sobald das Objekt überhaupt sichtbar ist (Server hat schon projiziert)', () => {
    expect(darfEbeneBearbeitenClient('privat', 'Kommentator')).toBe(true);
    expect(darfEbeneBearbeitenClient('privat', 'Nur-Lesen')).toBe(true);
  });

  it('kanzlei/exportierbar/custom: nur Eigentümer/Bearbeiter — der Eintrag fehlt sonst vollständig', () => {
    expect(darfEbeneBearbeitenClient('kanzlei', 'Eigentümer')).toBe(true);
    expect(darfEbeneBearbeitenClient('kanzlei', 'Bearbeiter')).toBe(true);
    expect(darfEbeneBearbeitenClient('kanzlei', 'Kommentator')).toBe(false);
    expect(darfEbeneBearbeitenClient('kanzlei', 'Nur-Lesen')).toBe(false);
    expect(darfEbeneBearbeitenClient('kanzlei', 'externer Gast')).toBe(false);
    expect(darfEbeneBearbeitenClient('custom', 'Kommentator')).toBe(false);
    expect(darfEbeneBearbeitenClient('exportierbar', 'Kommentator')).toBe(false);
  });

  it('rolle=null (j-lawyer-Modus, noch keine Rollenvergabe) bleibt erlaubt — Bestandsverhalten', () => {
    expect(darfEbeneBearbeitenClient('kanzlei', null)).toBe(true);
  });
});

describe('chipFuerEbene (Task 3: dezente Ebenen-Kennzeichnung am Objekt)', () => {
  it('liefert für \'kanzlei\' und fehlende layerId keinen Chip (Normalfall)', () => {
    expect(chipFuerEbene('kanzlei', stateMitCustom)).toBeNull();
    expect(chipFuerEbene(undefined, stateMitCustom)).toBeNull();
  });

  it('liefert für privat/ki-vorschlaege/exportierbar/custom genau einen Chip (Icon + Name)', () => {
    expect(chipFuerEbene('privat', stateMitCustom)).toEqual({ icon: '🔒', label: 'Privat' });
    expect(chipFuerEbene('ki-vorschlaege', stateMitCustom)).toEqual({ icon: '🤖', label: 'KI-Vorschläge' });
    expect(chipFuerEbene('exportierbar', stateMitCustom)).toEqual({ icon: '📤', label: 'Exportierbar' });
    expect(chipFuerEbene('x1', stateMitCustom)).toEqual({ icon: '🏷', label: 'Anlagenkonvolut' });
  });

  it('unbekannte/veraltete layerId (partial-Migration) zeigt keinen Chip — reguläres Kanzlei-Verhalten', () => {
    expect(chipFuerEbene('laengst-geloeschte-ebene', stateMitCustom)).toBeNull();
  });
});

describe('chipFuerEbene mit Pro-Nutzer-Privat-Instanz (02-11, PERM-01)', () => {
  it('zeigt für ein Objekt mit eigener Privat-Instanz-layerId den 🔒-Chip mit Label \'Privat\'', () => {
    expect(chipFuerEbene('privat-u1', stateMitPrivatInstanz)).toEqual({ icon: '🔒', label: 'Privat' });
  });

  it('weiterhin kein Chip bei kanzlei/fehlender/unbekannter layerId — auch wenn eine Instanz existiert', () => {
    expect(chipFuerEbene('kanzlei', stateMitPrivatInstanz)).toBeNull();
    expect(chipFuerEbene(undefined, stateMitPrivatInstanz)).toBeNull();
    expect(chipFuerEbene('laengst-geloeschte-ebene', stateMitPrivatInstanz)).toBeNull();
  });

  it('custom-Ebenen-Chip bleibt unverändert (Instanz-Auflösung ändert nur den privat-Pfad)', () => {
    expect(chipFuerEbene('x1', stateMitPrivatInstanz)).toEqual({ icon: '🏷', label: 'Anlagenkonvolut' });
  });
});

describe('„Ebene ändern"-Sichtbarkeit auf eigener Privat-Instanz (02-11, PERM-01)', () => {
  /** Minimaler Fake-Socket — feuert `onopen` einen Tick nach der Zuweisung (gleiches Muster
   *  wie der FakeWebSocket in store.layers.test.ts); kein echtes Netzwerk beteiligt. */
  class FakeWebSocket {
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onmessage: ((ev: MessageEvent) => void) | null = null;
    constructor() {
      queueMicrotask(() => this.onopen?.());
    }
    close(): void {}
  }

  function fakeClient(state: DesktopState, rolle: Rolle): ApiClient {
    return {
      status: async () => ({ needsSetup: false, needsModeChoice: false, mode: 'standalone' as const }),
      listDesks: async () => [{ id: 'd1', name: 'Schreibtisch 1', ownerId: 'u1' }],
      getState: async () => ({ rev: 1, state, rolle }),
      wsTicket: async () => ({ ticket: 't' }),
      wsUrl: () => 'ws://test',
    } as unknown as ApiClient;
  }

  function notiz(layerId: string | undefined): Note {
    return { id: 'n1', kind: 'notiz', text: 'x', position: { x: 0, y: 0 }, zIndex: 1, layerId, createdById: 'u1' };
  }

  function hatEbeneAendernEintrag(): boolean {
    return ui.menu?.items.some((i) => i.label === 'Ebene ändern') ?? false;
  }

  afterEach(() => vi.unstubAllGlobals());

  it('Eigentümer/Bearbeiter sehen den Eintrag auf einem Objekt der eigenen Privat-Instanz', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const note = notiz('privat-u1');
    const state: DesktopState = { ...stateMitPrivatInstanz, notes: [note] };
    for (const rolle of ['Eigentümer', 'Bearbeiter'] as Rolle[]) {
      await desktop.start(fakeClient(state, rolle));
      showNoteMenuAt(10, 10, note);
      expect(hatEbeneAendernEintrag()).toBe(true);
      await desktop.stop();
    }
  });

  it('auch der Kommentator sieht den Eintrag auf seinen eigenen Notizen der eigenen Privat-Instanz (Server-Regel 02-09: Ebenenpaar kanzlei ↔ eigene Instanz)', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const note = notiz('privat-u1');
    await desktop.start(fakeClient({ ...stateMitPrivatInstanz, notes: [note] }, 'Kommentator'));
    showNoteMenuAt(10, 10, note);
    expect(hatEbeneAendernEintrag()).toBe(true);
    await desktop.stop();
  });

  it('KI-Vorschläge bleiben unverändert ohne Eintrag (typ ki-vorschlaege nie direkt bearbeitbar)', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const note = notiz('ki-vorschlaege');
    await desktop.start(fakeClient({ ...emptyState(), notes: [note] }, 'Eigentümer'));
    showNoteMenuAt(10, 10, note);
    expect(hatEbeneAendernEintrag()).toBe(false);
    await desktop.stop();
  });
});

describe('02-REVIEW IN-01: „Ebene ändern"-Untermenü markiert die eigene Privat-Instanz mit ✓', () => {
  class FakeWebSocket {
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onmessage: ((ev: MessageEvent) => void) | null = null;
    constructor() {
      queueMicrotask(() => this.onopen?.());
    }
    close(): void {}
  }

  function fakeClient(state: DesktopState, rolle: Rolle): ApiClient {
    return {
      status: async () => ({ needsSetup: false, needsModeChoice: false, mode: 'standalone' as const }),
      listDesks: async () => [{ id: 'd1', name: 'Schreibtisch 1', ownerId: 'u1' }],
      getState: async () => ({ rev: 1, state, rolle }),
      wsTicket: async () => ({ ticket: 't' }),
      wsUrl: () => 'ws://test',
    } as unknown as ApiClient;
  }

  afterEach(() => vi.unstubAllGlobals());

  /** Öffnet das Kontextmenü der Notiz und klickt „Ebene ändern" — ui.menu zeigt danach das Untermenü. */
  function ebenenUntermenuOeffnen(note: Note): void {
    showNoteMenuAt(10, 10, note);
    ui.menu!.items.find((i) => i.label === 'Ebene ändern')!.action();
  }

  it('Objekt auf der eigenen Privat-Instanz (privat-u1): der ✓-Haken steht auf der Panel-Zeile „Privat"', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const note: Note = { id: 'n1', kind: 'notiz', text: 'x', position: { x: 0, y: 0 }, zIndex: 1, layerId: 'privat-u1', createdById: 'u1' };
    await desktop.start(fakeClient({ ...stateMitPrivatInstanz, notes: [note] }, 'Bearbeiter'));
    ebenenUntermenuOeffnen(note);
    const haken = ui.menu!.items.filter((i) => i.label.startsWith('✓ '));
    expect(haken).toHaveLength(1);
    expect(haken[0].label).toContain('Privat');
    await desktop.stop();
  });

  it('Objekt ohne layerId: der ✓-Haken steht weiterhin auf „Kanzlei" (Bestandsverhalten)', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const note: Note = { id: 'n1', kind: 'notiz', text: 'x', position: { x: 0, y: 0 }, zIndex: 1, createdById: 'u1' };
    await desktop.start(fakeClient({ ...stateMitPrivatInstanz, notes: [note] }, 'Bearbeiter'));
    ebenenUntermenuOeffnen(note);
    const haken = ui.menu!.items.filter((i) => i.label.startsWith('✓ '));
    expect(haken).toHaveLength(1);
    expect(haken[0].label).toContain('Kanzlei');
    await desktop.stop();
  });
});

describe('02-REVIEW IN-02: Kommentator-Untermenü „Ebene ändern" bietet nur serverseitig erlaubte Ziele', () => {
  class FakeWebSocket {
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onmessage: ((ev: MessageEvent) => void) | null = null;
    constructor() {
      queueMicrotask(() => this.onopen?.());
    }
    close(): void {}
  }

  function fakeClient(state: DesktopState, rolle: Rolle): ApiClient {
    return {
      status: async () => ({ needsSetup: false, needsModeChoice: false, mode: 'standalone' as const }),
      listDesks: async () => [{ id: 'd1', name: 'Schreibtisch 1', ownerId: 'u1' }],
      getState: async () => ({ rev: 1, state, rolle }),
      wsTicket: async () => ({ ticket: 't' }),
      wsUrl: () => 'ws://test',
    } as unknown as ApiClient;
  }

  afterEach(() => vi.unstubAllGlobals());

  it('buildEbenenMenu mit Rolle „Kommentator" listet nur Kanzlei + Privat (Ebenenpaar-Regel 02-09)', () => {
    const items = buildEbenenMenu(stateMitCustom, 'kanzlei', () => {}, 'Kommentator');
    expect(items).toHaveLength(2);
    expect(items.some((i) => i.label.includes('Kanzlei'))).toBe(true);
    expect(items.some((i) => i.label.includes('Privat'))).toBe(true);
  });

  it('buildEbenenMenu ohne Rollen-Argument bleibt ungefiltert (Bestandsverhalten für Bearbeiter-aufwärts)', () => {
    const items = buildEbenenMenu(stateMitCustom, 'kanzlei', () => {});
    expect(items).toHaveLength(5);
  });

  it('Kommentator auf eigener Privat-Notiz: das geöffnete Untermenü enthält nur Kanzlei + Privat (keine garantierten 403-Ziele)', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const note: Note = { id: 'n1', kind: 'notiz', text: 'x', position: { x: 0, y: 0 }, zIndex: 1, layerId: 'privat-u1', createdById: 'u1' };
    await desktop.start(fakeClient({ ...stateMitPrivatInstanz, notes: [note] }, 'Kommentator'));
    showNoteMenuAt(10, 10, note);
    ui.menu!.items.find((i) => i.label === 'Ebene ändern')!.action();
    const labels = ui.menu!.items.map((i) => i.label);
    expect(labels).toHaveLength(2);
    expect(labels.some((l) => l.includes('Kanzlei'))).toBe(true);
    expect(labels.some((l) => l.includes('Privat'))).toBe(true);
    expect(labels.some((l) => l.includes('KI-Vorschläge'))).toBe(false);
    expect(labels.some((l) => l.includes('Anlagenkonvolut'))).toBe(false);
    await desktop.stop();
  });
});

describe('freigabeEintrag (03-06 Task 1: Kontextmenü „Freigabe", EXP-03/D-05)', () => {
  class FakeWebSocket {
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onmessage: ((ev: MessageEvent) => void) | null = null;
    constructor() {
      queueMicrotask(() => this.onopen?.());
    }
    close(): void {}
  }

  function fakeClient(state: DesktopState, rolle: Rolle): ApiClient {
    return {
      status: async () => ({ needsSetup: false, needsModeChoice: false, mode: 'standalone' as const }),
      listDesks: async () => [{ id: 'd1', name: 'Schreibtisch 1', ownerId: 'u1' }],
      getState: async () => ({ rev: 1, state, rolle }),
      wsTicket: async () => ({ ticket: 't' }),
      wsUrl: () => 'ws://test',
    } as unknown as ApiClient;
  }

  function notiz(extra: Partial<Note>): Note {
    return { id: 'n1', kind: 'notiz', text: 'x', position: { x: 0, y: 0 }, zIndex: 1, createdById: 'u1', ...extra };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('liefert einen Eintrag „Freigabe"; Klick ersetzt ui.menu durch die drei Stufen in exakter UI-SPEC-Copy', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const note = notiz({});
    await desktop.start(fakeClient({ ...emptyState(), notes: [note] }, 'Eigentümer'));
    const eintrag = freigabeEintrag(10, 10, note.id, note);
    expect(eintrag).toHaveLength(1);
    expect(eintrag[0].label).toBe('Freigabe');
    eintrag[0].action();
    // Objekt ohne Override auf der Kanzlei-Ebene: effektiv 'intern' ⇒ ✓ bei 'Intern'.
    expect(ui.menu!.items.map((i) => i.label)).toEqual([
      '✓ Intern',
      'Mandantensichtbar (sichtbar für externe Gäste, nicht im Export)',
      'Exportierbar',
    ]);
    await desktop.stop();
  });

  it('der effektive Wert trägt das ✓-Präfix — Override „mandant" markiert Mandantensichtbar', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const note = notiz({ freigabe: 'mandant' });
    await desktop.start(fakeClient({ ...emptyState(), notes: [note] }, 'Eigentümer'));
    freigabeEintrag(10, 10, note.id, note)[0].action();
    const haken = ui.menu!.items.filter((i) => i.label.startsWith('✓ '));
    expect(haken).toHaveLength(1);
    expect(haken[0].label).toBe('✓ Mandantensichtbar (sichtbar für externe Gäste, nicht im Export)');
    await desktop.stop();
  });

  it('ohne Override auf exportierbarer Ebene steht der ✓ bei „Exportierbar" (Ebenen-Default)', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const note = notiz({ layerId: 'exportierbar' });
    await desktop.start(fakeClient({ ...emptyState(), notes: [note] }, 'Eigentümer'));
    freigabeEintrag(10, 10, note.id, note)[0].action();
    const haken = ui.menu!.items.filter((i) => i.label.startsWith('✓ '));
    expect(haken).toHaveLength(1);
    expect(haken[0].label).toBe('✓ Exportierbar');
    await desktop.stop();
  });

  it('Klick auf eine Stufe dispatcht den setFreigabe-Command mit objectId und gewählter Stufe', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const note = notiz({});
    await desktop.start(fakeClient({ ...emptyState(), notes: [note] }, 'Eigentümer'));
    const spion = vi.spyOn(desktop, 'command').mockResolvedValue({ ok: true });
    freigabeEintrag(10, 10, note.id, note)[0].action();
    ui.menu!.items.find((i) => i.label === 'Exportierbar')!.action();
    expect(spion).toHaveBeenCalledWith('setFreigabe', { objectId: 'n1', freigabe: 'export' });
    await desktop.stop();
  });

  it('ohne Bearbeitungsrecht (Komfort-Guard wie „Ebene ändern") liefert der Builder ein leeres Array', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const note = notiz({});
    await desktop.start(fakeClient({ ...emptyState(), notes: [note] }, 'Kommentator'));
    expect(freigabeEintrag(10, 10, note.id, note)).toEqual([]);
    await desktop.stop();
  });

  it('steht im Notiz-Kontextmenü direkt nach „Ebene ändern"', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const note = notiz({});
    await desktop.start(fakeClient({ ...emptyState(), notes: [note] }, 'Eigentümer'));
    showNoteMenuAt(10, 10, note);
    const labels = ui.menu!.items.map((i) => i.label);
    expect(labels.indexOf('Freigabe')).toBe(labels.indexOf('Ebene ändern') + 1);
    await desktop.stop();
  });
});

describe('chipFuerFreigabe (03-06 Task 1: Freigabe-Chip nur bei explizitem Override)', () => {
  it('liefert null ohne Override — Ebenen-Default ist der Normalfall (auch auf exportierbarer Ebene)', () => {
    expect(chipFuerFreigabe({}, stateMitCustom)).toBeNull();
    expect(chipFuerFreigabe({ layerId: 'exportierbar' }, stateMitCustom)).toBeNull();
  });

  it('liefert genau einen Chip je Override-Stufe (🔒 intern / 👤 mandant / 📤 export)', () => {
    expect(chipFuerFreigabe({ freigabe: 'intern' }, stateMitCustom)).toEqual({ icon: '🔒', label: 'Intern' });
    expect(chipFuerFreigabe({ freigabe: 'mandant' }, stateMitCustom)).toEqual({ icon: '👤', label: 'Mandantensichtbar' });
    expect(chipFuerFreigabe({ freigabe: 'export' }, stateMitCustom)).toEqual({ icon: '📤', label: 'Exportierbar' });
  });
});

describe('chipFuerExtern (13-06 Task 2: permanenter 🌐-Chip, EXT-01)', () => {
  it('liefert null ohne extern-Feld (auch bei explizitem undefined) — kein Chip im Default-Fall', () => {
    expect(chipFuerExtern({})).toBeNull();
    expect(chipFuerExtern({ extern: undefined })).toBeNull();
  });

  it('liefert den 🌐-Chip bei gesetztem extern-Feld, unabhängig von der art', () => {
    expect(chipFuerExtern({ extern: { art: 'weblink', url: 'https://x' } })).toEqual({ icon: '🌐', label: 'Externe Referenz' });
    expect(chipFuerExtern({ extern: { art: 'urteil' } })).toEqual({ icon: '🌐', label: 'Externe Referenz' });
  });

  it('ist eine reine Ableitung (keine Mutation, keine Seiteneffekte) — Formsymmetrie zu chipFuerFreigabe', () => {
    const objekt = { extern: { art: 'foto' as const } };
    const kopie = JSON.parse(JSON.stringify(objekt));
    chipFuerExtern(objekt);
    expect(objekt).toEqual(kopie);
  });
});

describe('parseDatumEingabe (Task 3: TT.MM.JJJJ -> ISO-Kalendertag)', () => {
  it('parst ein gültiges Datum (auch ohne führende Nullen)', () => {
    expect(parseDatumEingabe('01.09.2026')).toBe('2026-09-01');
    expect(parseDatumEingabe('1.9.2026')).toBe('2026-09-01');
  });

  it('lehnt ein rechnerisch überlaufendes Datum ab (31.02. gibt es nicht)', () => {
    expect(parseDatumEingabe('31.02.2026')).toBeUndefined();
  });

  it('lehnt nicht parsbaren oder falsch formatierten Text ab', () => {
    expect(parseDatumEingabe('gestern')).toBeUndefined();
    expect(parseDatumEingabe('')).toBeUndefined();
    expect(parseDatumEingabe('2026-09-01')).toBeUndefined();
  });
});

describe('aufgabeEintraege / showLegalObjectMenuAt (Task 3: Aufgaben-Kontextmenüblock, TASK-01)', () => {
  class FakeWebSocket {
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onmessage: ((ev: MessageEvent) => void) | null = null;
    constructor() {
      queueMicrotask(() => this.onopen?.());
    }
    close(): void {}
  }

  function fakeClient(state: DesktopState, rolle: Rolle): ApiClient {
    return {
      status: async () => ({ needsSetup: false, needsModeChoice: false, mode: 'standalone' as const }),
      listDesks: async () => [{ id: 'd1', name: 'Schreibtisch 1', ownerId: 'u1' }],
      getState: async () => ({ rev: 1, state, rolle }),
      wsTicket: async () => ({ ticket: 't' }),
      wsUrl: () => 'ws://test',
    } as unknown as ApiClient;
  }

  function aufgabe(extra: Partial<LegalObject> = {}): LegalObject {
    return {
      id: 'a1', kind: 'aufgabe', text: 'x', position: { x: 0, y: 0 }, zIndex: 1, createdById: 'u1',
      priority: 'mittel', status: 'offen', ...extra,
    };
  }

  function tatsache(): LegalObject {
    return { id: 't1', kind: 'tatsache', text: 'x', position: { x: 0, y: 0 }, zIndex: 1, createdById: 'u1' };
  }

  /** TASK-02 (08-08): j-lawyer-Modus-Variante des Fake-Clients — status() liefert mode
   *  'jlawyer', desktop.start() lädt darüber Akten statt eigener Schreibtische (getCases/
   *  getCaseDesk statt listDesks/getState, s. store.svelte.ts start()). */
  function fakeJlClient(
    state: DesktopState,
    rolle: Rolle,
    uebergebeAufgabe = vi.fn().mockResolvedValue({ rev: 2, state, jlDueDateId: 'dd-1' }),
  ): ApiClient {
    return {
      status: async () => ({ needsSetup: false, needsModeChoice: false, mode: 'jlawyer' as const }),
      getCases: async () => [{ id: 'akte-1', fileNumber: '1/26', name: 'Fall', reason: 'x' }],
      getCaseDesk: async () => ({ rev: 1, state, rolle }),
      wsTicket: async () => ({ ticket: 't' }),
      wsUrl: () => 'ws://test',
      uebergebeAufgabe,
    } as unknown as ApiClient;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    ui.taskRefFromId = null;
  });

  it('der Aufgabenblock erscheint NICHT im Kontextmenü der übrigen zwölf Objekttypen', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const obj = tatsache();
    await desktop.start(fakeClient({ ...emptyState(), legalObjects: [obj] }, 'Eigentümer'));
    showLegalObjectMenuAt(10, 10, obj);
    const labels = ui.menu!.items.map((i) => i.label);
    expect(labels).not.toContain('Status');
    expect(labels).not.toContain('Priorität');
    expect(labels).not.toContain('Verantwortliche/r…');
    expect(labels).not.toContain('Fällig am…');
    expect(labels).not.toContain('Bezug zu Dokument…');
    await desktop.stop();
  });

  it('enthält Einträge für alle fünf Felder bei kind aufgabe', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const obj = aufgabe();
    await desktop.start(fakeClient({ ...emptyState(), legalObjects: [obj] }, 'Eigentümer'));
    showLegalObjectMenuAt(10, 10, obj);
    const labels = ui.menu!.items.map((i) => i.label);
    expect(labels).toContain('Status');
    expect(labels).toContain('Priorität');
    expect(labels).toContain('Verantwortliche/r…');
    expect(labels).toContain('Fällig am…');
    expect(labels).toContain('Bezug zu Dokument…');
    await desktop.stop();
  });

  it('Zum Bezug springen / Bezug entfernen erscheinen ausschließlich bei gesetztem docRef', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const ohneDocRef = aufgabe();
    await desktop.start(fakeClient({ ...emptyState(), legalObjects: [ohneDocRef] }, 'Eigentümer'));
    showLegalObjectMenuAt(10, 10, ohneDocRef);
    let labels = ui.menu!.items.map((i) => i.label);
    expect(labels).not.toContain('Zum Bezug springen');
    expect(labels).not.toContain('Bezug entfernen');
    await desktop.stop();

    const mitDocRef = aufgabe({ docRef: { docId: 'd1' } });
    await desktop.start(fakeClient({ ...emptyState(), legalObjects: [mitDocRef] }, 'Eigentümer'));
    showLegalObjectMenuAt(10, 10, mitDocRef);
    labels = ui.menu!.items.map((i) => i.label);
    expect(labels).toContain('Zum Bezug springen');
    expect(labels).toContain('Bezug entfernen');
    await desktop.stop();
  });

  it('Status: Zweischritt-Menü mit ✓-Präfix beim aktuellen Wert, Klick dispatcht setTaskStatus', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const obj = aufgabe({ status: 'in-arbeit' });
    await desktop.start(fakeClient({ ...emptyState(), legalObjects: [obj] }, 'Eigentümer'));
    const spion = vi.spyOn(desktop, 'command').mockResolvedValue({ ok: true });
    showLegalObjectMenuAt(10, 10, obj);
    ui.menu!.items.find((i) => i.label === 'Status')!.action();
    expect(ui.menu!.items.map((i) => i.label)).toEqual(['Offen', '✓ In Arbeit', 'Erledigt', 'An j-lawyer übergeben']);
    ui.menu!.items.find((i) => i.label === 'Erledigt')!.action();
    expect(spion).toHaveBeenCalledWith('setTaskStatus', { id: 'a1', status: 'erledigt' });
    await desktop.stop();
  });

  it('Priorität: Zweischritt-Menü mit ✓-Präfix beim aktuellen Wert, Klick dispatcht setTaskPriority', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const obj = aufgabe({ priority: 'hoch' });
    await desktop.start(fakeClient({ ...emptyState(), legalObjects: [obj] }, 'Eigentümer'));
    const spion = vi.spyOn(desktop, 'command').mockResolvedValue({ ok: true });
    showLegalObjectMenuAt(10, 10, obj);
    ui.menu!.items.find((i) => i.label === 'Priorität')!.action();
    expect(ui.menu!.items.map((i) => i.label)).toEqual(['✓ Hoch', 'Mittel', 'Niedrig']);
    ui.menu!.items.find((i) => i.label === 'Niedrig')!.action();
    expect(spion).toHaveBeenCalledWith('setTaskPriority', { id: 'a1', priority: 'niedrig' });
    await desktop.stop();
  });

  it('Verantwortliche/r…: öffnet ui.menu.input, Eingabe dispatcht setTaskAssignee', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const obj = aufgabe();
    await desktop.start(fakeClient({ ...emptyState(), legalObjects: [obj] }, 'Eigentümer'));
    showLegalObjectMenuAt(10, 10, obj);
    ui.menu!.items.find((i) => i.label === 'Verantwortliche/r…')!.action();
    await Promise.resolve(); // queueMicrotask-Verzögerung (ContextMenu.svelte setzt ui.menu sonst zurück)
    expect(ui.menu!.input?.placeholder).toBe('Name');
    const spion = vi.spyOn(desktop, 'command').mockResolvedValue({ ok: true });
    ui.menu!.input!.onSubmit('Frau Meier');
    expect(spion).toHaveBeenCalledWith('setTaskAssignee', { id: 'a1', assignee: 'Frau Meier' });
    await desktop.stop();
  });

  it('Fällig am…: gültige Eingabe dispatcht setTaskDueDate mit ISO-Kalendertag', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const obj = aufgabe();
    await desktop.start(fakeClient({ ...emptyState(), legalObjects: [obj] }, 'Eigentümer'));
    showLegalObjectMenuAt(10, 10, obj);
    ui.menu!.items.find((i) => i.label === 'Fällig am…')!.action();
    await Promise.resolve();
    expect(ui.menu!.input?.placeholder).toBe('TT.MM.JJJJ');
    const spion = vi.spyOn(desktop, 'command').mockResolvedValue({ ok: true });
    ui.menu!.input!.onSubmit('01.09.2026');
    expect(spion).toHaveBeenCalledWith('setTaskDueDate', { id: 'a1', dueDate: '2026-09-01' });
    await desktop.stop();
  });

  it('Fällig am…: nicht parsbare Eingabe zeigt einen Toast und dispatcht keinen Command', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const obj = aufgabe();
    await desktop.start(fakeClient({ ...emptyState(), legalObjects: [obj] }, 'Eigentümer'));
    showLegalObjectMenuAt(10, 10, obj);
    ui.menu!.items.find((i) => i.label === 'Fällig am…')!.action();
    await Promise.resolve();
    const spion = vi.spyOn(desktop, 'command').mockResolvedValue({ ok: true });
    ui.menu!.input!.onSubmit('nicht ein datum');
    expect(spion).not.toHaveBeenCalled();
    expect(ui.toast).toContain('TT.MM.JJJJ');
    await desktop.stop();
  });

  it('Bezug zu Dokument…: setzt ui.taskRefFromId auf die Aufgaben-id', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const obj = aufgabe();
    await desktop.start(fakeClient({ ...emptyState(), legalObjects: [obj] }, 'Eigentümer'));
    showLegalObjectMenuAt(10, 10, obj);
    ui.menu!.items.find((i) => i.label === 'Bezug zu Dokument…')!.action();
    expect(ui.taskRefFromId).toBe('a1');
    await desktop.stop();
  });

  it('Bezug entfernen: dispatcht removeTaskDocRef mit der Aufgaben-id', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const obj = aufgabe({ docRef: { docId: 'd1' } });
    await desktop.start(fakeClient({ ...emptyState(), legalObjects: [obj] }, 'Eigentümer'));
    const spion = vi.spyOn(desktop, 'command').mockResolvedValue({ ok: true });
    showLegalObjectMenuAt(10, 10, obj);
    ui.menu!.items.find((i) => i.label === 'Bezug entfernen')!.action();
    expect(spion).toHaveBeenCalledWith('removeTaskDocRef', { id: 'a1' });
    await desktop.stop();
  });

  it('Zum Bezug springen: löst desktop.jumpTo mit der aus docRef gebauten Fundstelle aus', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const obj = aufgabe({ docRef: { docId: 'd1', page: 3 } });
    await desktop.start(fakeClient({ ...emptyState(), legalObjects: [obj] }, 'Eigentümer'));
    const spion = vi.spyOn(desktop, 'jumpTo').mockResolvedValue(undefined);
    showLegalObjectMenuAt(10, 10, obj);
    ui.menu!.items.find((i) => i.label === 'Zum Bezug springen')!.action();
    expect(spion).toHaveBeenCalledWith({ docId: 'd1', page: 3 });
    await desktop.stop();
  });

  // ---- TASK-02 (08-08): "An j-lawyer übergeben" ----

  it('"An j-lawyer übergeben" fehlt vollständig außerhalb des j-lawyer-Modus', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const obj = aufgabe();
    await desktop.start(fakeClient({ ...emptyState(), legalObjects: [obj] }, 'Eigentümer'));
    showLegalObjectMenuAt(10, 10, obj);
    expect(ui.menu!.items.map((i) => i.label)).not.toContain('An j-lawyer übergeben');
    await desktop.stop();
  });

  it('"An j-lawyer übergeben" fehlt im j-lawyer-Modus ohne das Recht für gefährliche Aktionen (Kommentator)', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const obj = aufgabe();
    await desktop.start(fakeJlClient({ ...emptyState(), legalObjects: [obj] }, 'Kommentator'));
    showLegalObjectMenuAt(10, 10, obj);
    expect(ui.menu!.items.map((i) => i.label)).not.toContain('An j-lawyer übergeben');
    await desktop.stop();
  });

  it('"An j-lawyer übergeben" erscheint im j-lawyer-Modus mit dem Recht für gefährliche Aktionen (Eigentümer)', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const obj = aufgabe();
    await desktop.start(fakeJlClient({ ...emptyState(), legalObjects: [obj] }, 'Eigentümer'));
    showLegalObjectMenuAt(10, 10, obj);
    expect(ui.menu!.items.map((i) => i.label)).toContain('An j-lawyer übergeben');
    await desktop.stop();
  });

  it('Klick bestätigt mit dem wörtlichen Copywriting-Contract-Text und ruft api.uebergebeAufgabe bei Bestätigung auf', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const obj = aufgabe();
    const uebergebeAufgabe = vi.fn().mockResolvedValue({ rev: 2, state: emptyState(), jlDueDateId: 'dd-1' });
    await desktop.start(fakeJlClient({ ...emptyState(), legalObjects: [obj] }, 'Eigentümer', uebergebeAufgabe));
    // Node-Testumgebung kennt kein globales confirm() (kein Browser) — vi.stubGlobal statt
    // vi.spyOn, das eine bereits existierende Eigenschaft voraussetzt.
    const confirmSpion = vi.fn().mockReturnValue(true);
    vi.stubGlobal('confirm', confirmSpion);
    showLegalObjectMenuAt(10, 10, obj);
    await ui.menu!.items.find((i) => i.label === 'An j-lawyer übergeben')!.action();
    expect(confirmSpion).toHaveBeenCalledWith(
      'Aufgabe an j-lawyer übergeben? Verantwortliche/r, Fälligkeit und Bezug zu Dokument/Fundstelle werden dorthin übertragen.',
    );
    expect(uebergebeAufgabe).toHaveBeenCalledWith('akte-1', 'a1');
    await desktop.stop();
  });

  it('Klick ohne Bestätigung (confirm liefert false) ruft api.uebergebeAufgabe NICHT auf', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const obj = aufgabe();
    const uebergebeAufgabe = vi.fn();
    await desktop.start(fakeJlClient({ ...emptyState(), legalObjects: [obj] }, 'Eigentümer', uebergebeAufgabe));
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(false));
    showLegalObjectMenuAt(10, 10, obj);
    await ui.menu!.items.find((i) => i.label === 'An j-lawyer übergeben')!.action();
    expect(uebergebeAufgabe).not.toHaveBeenCalled();
    await desktop.stop();
  });

  it('bereits übergebene Aufgabe: der Bestätigungstext trägt einen vorangestellten Hinweis auf die frühere Übergabe', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const obj = aufgabe({ status: 'uebergeben', handedOverToJLawyer: { at: '2026-08-01T00:00:00.000Z', jlDueDateId: 'dd-alt' } });
    const uebergebeAufgabe = vi.fn().mockResolvedValue({ rev: 2, state: emptyState(), jlDueDateId: 'dd-neu' });
    await desktop.start(fakeJlClient({ ...emptyState(), legalObjects: [obj] }, 'Eigentümer', uebergebeAufgabe));
    const confirmSpion = vi.fn().mockReturnValue(true);
    vi.stubGlobal('confirm', confirmSpion);
    showLegalObjectMenuAt(10, 10, obj);
    await ui.menu!.items.find((i) => i.label === 'An j-lawyer übergeben')!.action();
    expect(confirmSpion.mock.calls[0][0]).toMatch(/^Diese Aufgabe wurde bereits an j-lawyer übergeben\. Aufgabe an j-lawyer übergeben\?/);
    await desktop.stop();
  });

  it('Fehlschlag der Übergabe: die Server-Meldung erscheint als Toast, kein lokaler Statuswechsel', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const obj = aufgabe();
    const { ApiError } = await import('./api');
    const uebergebeAufgabe = vi.fn().mockRejectedValue(new ApiError('Berechtigung verweigert für diese Aktion: upload', 403));
    await desktop.start(fakeJlClient({ ...emptyState(), legalObjects: [obj] }, 'Eigentümer', uebergebeAufgabe));
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
    showLegalObjectMenuAt(10, 10, obj);
    await ui.menu!.items.find((i) => i.label === 'An j-lawyer übergeben')!.action();
    expect(ui.toast).toBe('Berechtigung verweigert für diese Aktion: upload');
    expect(desktop.state.legalObjects![0].status).toBe('offen'); // kein optimistischer Wechsel
    await desktop.stop();
  });
});

describe('COMP-01/COMP-03 (09-07 Task 1): „Vergleichen mit…" / „Ist neue Version von…" im Dokumentmenü', () => {
  function doc(id: string): Doc {
    return { id, fileId: `f-${id}`, name: `${id}.pdf`, position: { x: 0, y: 0 }, rotation: 0, zIndex: 1, createdById: 'u1' };
  }

  afterEach(() => {
    vi.restoreAllMocks();
    ui.menu = null;
    ui.compareFromId = null;
    ui.versionFromId = null;
  });

  it('showDocMenuAt und showViewerMenuAt enthalten beide Einträge direkt nach „Zur Sitzungsmappe hinzufügen" (11-01: unmittelbar nach „Verknüpfen…")', () => {
    // 11-01 (SESS-02): „Zur Sitzungsmappe hinzufügen" steht — wie „Zu Anlagenpaket hinzufügen"
    // davor — unbedingt zwischen „Verknüpfen…" und „Vergleichen mit…"; anders als das
    // Anlagenpaket-Pendant ist es NICHT freigabe-gegated und erscheint deshalb hier immer.
    const d = doc('d1');
    showDocMenuAt(10, 10, d);
    let labels = ui.menu!.items.map((i) => i.label);
    expect(labels.indexOf('Zur Sitzungsmappe hinzufügen')).toBe(labels.indexOf('Verknüpfen…') + 1);
    expect(labels.indexOf('Vergleichen mit…')).toBe(labels.indexOf('Zur Sitzungsmappe hinzufügen') + 1);
    expect(labels.indexOf('Ist neue Version von…')).toBe(labels.indexOf('Vergleichen mit…') + 1);

    showViewerMenuAt(10, 10, d);
    labels = ui.menu!.items.map((i) => i.label);
    expect(labels.indexOf('Zur Sitzungsmappe hinzufügen')).toBe(labels.indexOf('Verknüpfen…') + 1);
    expect(labels.indexOf('Vergleichen mit…')).toBe(labels.indexOf('Zur Sitzungsmappe hinzufügen') + 1);
    expect(labels.indexOf('Ist neue Version von…')).toBe(labels.indexOf('Vergleichen mit…') + 1);
  });

  it('fehlen im Kontextmenü von Notiz, Stapel, Ausschnitt und Tabelle', () => {
    const note: Note = { id: 'n1', kind: 'notiz', text: 'x', position: { x: 0, y: 0 }, zIndex: 1, createdById: 'u1' };
    showNoteMenuAt(10, 10, note);
    let labels = ui.menu!.items.map((i) => i.label);
    expect(labels).not.toContain('Vergleichen mit…');
    expect(labels).not.toContain('Ist neue Version von…');

    const stack: Stack = { id: 's1', name: 'Stapel', docIds: [], position: { x: 0, y: 0 }, zIndex: 1 };
    showStackMenuAt(10, 10, stack);
    labels = ui.menu!.items.map((i) => i.label);
    expect(labels).not.toContain('Vergleichen mit…');
    expect(labels).not.toContain('Ist neue Version von…');

    const cutout: Cutout = { id: 'c1', fileId: 'f1', page: 1, rect: { x: 0, y: 0, w: 1, h: 1 }, position: { x: 0, y: 0 }, zIndex: 1 };
    showCutoutMenuAt(10, 10, cutout);
    labels = ui.menu!.items.map((i) => i.label);
    expect(labels).not.toContain('Vergleichen mit…');
    expect(labels).not.toContain('Ist neue Version von…');

    const table: TableCard = { id: 't1', titel: '', spalten: [], rows: [], position: { x: 0, y: 0 }, zIndex: 1 };
    showTableMenuAt(10, 10, table);
    labels = ui.menu!.items.map((i) => i.label);
    expect(labels).not.toContain('Vergleichen mit…');
    expect(labels).not.toContain('Ist neue Version von…');
  });

  it('„Ist neue Version von…" setzt ui.versionFromId auf die Dokument-id und sendet keinen Command', () => {
    const spion = vi.spyOn(desktop, 'command').mockResolvedValue({ ok: true });
    const d = doc('d1');
    showDocMenuAt(10, 10, d);
    ui.menu!.items.find((i) => i.label === 'Ist neue Version von…')!.action();
    expect(ui.versionFromId).toBe('d1');
    expect(spion).not.toHaveBeenCalled();
  });

  it('„Vergleichen mit…" setzt ui.compareFromId auf die Dokument-id und sendet keinen Command', () => {
    const spion = vi.spyOn(desktop, 'command').mockResolvedValue({ ok: true });
    const d = doc('d1');
    showDocMenuAt(10, 10, d);
    ui.menu!.items.find((i) => i.label === 'Vergleichen mit…')!.action();
    expect(ui.compareFromId).toBe('d1');
    expect(spion).not.toHaveBeenCalled();
  });
});

describe('KONV-01 (10-03): „Zu Anlagenpaket hinzufügen" / „Anlagenpaket aus Stapel…" im Kontextmenü', () => {
  class FakeWebSocket {
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onmessage: ((ev: MessageEvent) => void) | null = null;
    constructor() {
      queueMicrotask(() => this.onopen?.());
    }
    close(): void {}
  }

  function fakeClient(state: DesktopState, rolle: Rolle): ApiClient {
    return {
      status: async () => ({ needsSetup: false, needsModeChoice: false, mode: 'standalone' as const }),
      listDesks: async () => [{ id: 'd1', name: 'Schreibtisch 1', ownerId: 'u1' }],
      getState: async () => ({ rev: 1, state, rolle }),
      wsTicket: async () => ({ ticket: 't' }),
      wsUrl: () => 'ws://test',
    } as unknown as ApiClient;
  }

  function doc(id: string, freigabe?: 'export' | 'intern'): Doc {
    return {
      id, fileId: `f-${id}`, name: `${id}.pdf`, position: { x: 0, y: 0 }, rotation: 0, zIndex: 1, createdById: 'u1',
      ...(freigabe ? { freigabe } : {}),
    };
  }

  afterEach(() => {
    ui.menu = null;
    ui.anlagenpaketAuswahl = [];
    ui.anlagenpaketOffen = false;
    ui.toast = null;
    vi.unstubAllGlobals();
  });

  it('showDocMenuAt enthält den Eintrag auf einem Dokument mit effektiver Freigabe export', () => {
    const d = doc('d1', 'export');
    showDocMenuAt(10, 10, d);
    const labels = ui.menu!.items.map((i) => i.label);
    expect(labels).toContain('Zu Anlagenpaket hinzufügen');
  });

  it('dasselbe Dokument ohne Export-Freigabe: der Eintrag fehlt vollständig', () => {
    const d = doc('d1', 'intern');
    showDocMenuAt(10, 10, d);
    const labels = ui.menu!.items.map((i) => i.label);
    expect(labels.some((l) => l.includes('Anlagenpaket'))).toBe(false);
  });

  it('Auslösen der Aktion hängt einen Eintrag an ui.anlagenpaketAuswahl an und setzt ui.anlagenpaketOffen', () => {
    const d = doc('d1', 'export');
    showDocMenuAt(10, 10, d);
    ui.menu!.items.find((i) => i.label === 'Zu Anlagenpaket hinzufügen')!.action();
    expect(ui.anlagenpaketAuswahl.map((e) => e.docId)).toEqual(['d1']);
    expect(ui.anlagenpaketOffen).toBe(true);
  });

  it('zweites Auslösen derselben Aktion lässt die Länge der Liste unverändert und zeigt einen Toast', () => {
    const d = doc('d1', 'export');
    showDocMenuAt(10, 10, d);
    ui.menu!.items.find((i) => i.label === 'Zu Anlagenpaket hinzufügen')!.action();
    showDocMenuAt(10, 10, d);
    ui.menu!.items.find((i) => i.label === 'Zu Anlagenpaket hinzufügen')!.action();
    expect(ui.anlagenpaketAuswahl.length).toBe(1);
    expect(ui.toast).toBe('„d1.pdf" ist bereits im Anlagenpaket.');
  });

  it('showViewerMenuAt enthält denselben Eintrag unter derselben Bedingung', () => {
    const d = doc('d1', 'export');
    showViewerMenuAt(10, 10, d);
    const labels = ui.menu!.items.map((i) => i.label);
    expect(labels).toContain('Zu Anlagenpaket hinzufügen');

    const dIntern = doc('d2', 'intern');
    showViewerMenuAt(10, 10, dIntern);
    const labels2 = ui.menu!.items.map((i) => i.label);
    expect(labels2.some((l) => l.includes('Anlagenpaket'))).toBe(false);
  });

  it('showStackMenuAt auf einem Stapel mit exportfreigegebenen Mitgliedern enthält den Eintrag; die Aktion ersetzt die Auswahl in Stapelreihenfolge', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const state: DesktopState = { ...emptyState(), docs: [doc('a', 'export'), doc('b', 'export')] };
    await desktop.start(fakeClient(state, 'Eigentümer'));
    const stack: Stack = { id: 's1', name: '', docIds: ['a', 'b'], position: { x: 0, y: 0 }, zIndex: 1, freigabe: 'export' };
    ui.anlagenpaketAuswahl = [{ docId: 'vorher', bezeichnung: 'Vorherige Auswahl' }];

    showStackMenuAt(10, 10, stack);
    const labels = ui.menu!.items.map((i) => i.label);
    expect(labels).toContain('Anlagenpaket aus Stapel…');
    ui.menu!.items.find((i) => i.label === 'Anlagenpaket aus Stapel…')!.action();
    expect(ui.anlagenpaketAuswahl.map((e) => e.docId)).toEqual(['a', 'b']);
    expect(ui.anlagenpaketOffen).toBe(true);

    await desktop.stop();
  });

  it('showStackMenuAt auf einem Stapel ohne Export-Freigabe bietet den Eintrag nicht an', () => {
    const stack: Stack = { id: 's1', name: '', docIds: [], position: { x: 0, y: 0 }, zIndex: 1, freigabe: 'intern' };
    showStackMenuAt(10, 10, stack);
    const labels = ui.menu!.items.map((i) => i.label);
    expect(labels.some((l) => l.includes('Anlagenpaket'))).toBe(false);
  });
});

describe('SESS-02 (11-05): Sitzungsmappe-Doppelweg „Zur Sitzungsmappe hinzufügen" / „Aus Sitzungsmappe entfernen"', () => {
  class FakeWebSocket {
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onmessage: ((ev: MessageEvent) => void) | null = null;
    constructor() {
      queueMicrotask(() => this.onopen?.());
    }
    close(): void {}
  }

  function fakeClient(state: DesktopState, rolle: Rolle): ApiClient {
    return {
      status: async () => ({ needsSetup: false, needsModeChoice: false, mode: 'standalone' as const }),
      listDesks: async () => [{ id: 'd1', name: 'Schreibtisch 1', ownerId: 'u1' }],
      getState: async () => ({ rev: 1, state, rolle }),
      wsTicket: async () => ({ ticket: 't' }),
      wsUrl: () => 'ws://test',
    } as unknown as ApiClient;
  }

  function doc(id: string): Doc {
    return { id, fileId: `f-${id}`, name: `${id}.pdf`, position: { x: 0, y: 0 }, rotation: 0, zIndex: 1, createdById: 'u1' };
  }

  const mappe = { id: 'sm1', titel: 'Termin', docIds: ['d1'], offeneFragen: [] };

  afterEach(() => {
    ui.menu = null;
    vi.unstubAllGlobals();
  });

  it('Dokument steht in der Agenda: der Eintrag heißt „Aus Sitzungsmappe entfernen" und sendet removeSitzungsmappeDoc', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const d = doc('d1');
    const state: DesktopState = { ...emptyState(), docs: [d], sitzungsmappen: [mappe] };
    await desktop.start(fakeClient(state, 'Eigentümer'));
    const spion = vi.spyOn(desktop, 'command').mockResolvedValue({ ok: true });
    showDocMenuAt(10, 10, d);
    const labels = ui.menu!.items.map((i) => i.label);
    expect(labels).toContain('Aus Sitzungsmappe entfernen');
    expect(labels).not.toContain('Zur Sitzungsmappe hinzufügen');
    ui.menu!.items.find((i) => i.label === 'Aus Sitzungsmappe entfernen')!.action();
    expect(spion).toHaveBeenCalledWith('removeSitzungsmappeDoc', { id: 'sm1', docId: 'd1' });
    await desktop.stop();
  });

  it('Dokument steht nicht in der Agenda (Mappe vorhanden): „Zur Sitzungsmappe hinzufügen" sendet nur addSitzungsmappeDoc, kein erneutes addSitzungsmappe', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const d1 = doc('d1');
    const d2 = doc('d2');
    const state: DesktopState = { ...emptyState(), docs: [d1, d2], sitzungsmappen: [mappe] };
    await desktop.start(fakeClient(state, 'Eigentümer'));
    const spion = vi.spyOn(desktop, 'command').mockResolvedValue({ ok: true });
    showDocMenuAt(10, 10, d2);
    const labels = ui.menu!.items.map((i) => i.label);
    expect(labels).toContain('Zur Sitzungsmappe hinzufügen');
    ui.menu!.items.find((i) => i.label === 'Zur Sitzungsmappe hinzufügen')!.action();
    expect(spion).toHaveBeenCalledWith('addSitzungsmappeDoc', { id: 'sm1', docId: 'd2' });
    expect(spion).not.toHaveBeenCalledWith('addSitzungsmappe', expect.anything());
    await desktop.stop();
  });

  it('noch keine Sitzungsmappe vorhanden: die Aktion legt sie an und hängt das Dokument an (Bestandsverhalten aus 11-01)', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const d = doc('d1');
    const state: DesktopState = { ...emptyState(), docs: [d] };
    await desktop.start(fakeClient(state, 'Eigentümer'));
    const spion = vi.spyOn(desktop, 'command').mockResolvedValue({ ok: true });
    showDocMenuAt(10, 10, d);
    ui.menu!.items.find((i) => i.label === 'Zur Sitzungsmappe hinzufügen')!.action();
    expect(spion).toHaveBeenCalledWith('addSitzungsmappe', { titel: 'Termin', id: expect.any(String) });
    expect(spion).toHaveBeenCalledWith('addSitzungsmappeDoc', { id: expect.any(String), docId: 'd1' });
    await desktop.stop();
  });

  it('showViewerMenuAt schaltet die Beschriftung am aufgeschlagenen Dokument ebenfalls um', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const d = doc('d1');
    const state: DesktopState = { ...emptyState(), docs: [d], sitzungsmappen: [mappe] };
    await desktop.start(fakeClient(state, 'Eigentümer'));
    showViewerMenuAt(10, 10, d);
    const labels = ui.menu!.items.map((i) => i.label);
    expect(labels).toContain('Aus Sitzungsmappe entfernen');
    expect(labels).not.toContain('Zur Sitzungsmappe hinzufügen');
    await desktop.stop();
  });

  it('Stapel-, Zettel- und Ausschnitt-Menüs enthalten keinen Sitzungsmappe-Eintrag (Agenda führt nur Dokumente)', () => {
    const note: Note = { id: 'n1', kind: 'notiz', text: 'x', position: { x: 0, y: 0 }, zIndex: 1, createdById: 'u1' };
    showNoteMenuAt(10, 10, note);
    let labels = ui.menu!.items.map((i) => i.label);
    expect(labels.some((l) => l.includes('Sitzungsmappe'))).toBe(false);

    const stack: Stack = { id: 's1', name: 'Stapel', docIds: [], position: { x: 0, y: 0 }, zIndex: 1 };
    showStackMenuAt(10, 10, stack);
    labels = ui.menu!.items.map((i) => i.label);
    expect(labels.some((l) => l.includes('Sitzungsmappe'))).toBe(false);

    const cutout: Cutout = { id: 'c1', fileId: 'f1', page: 1, rect: { x: 0, y: 0, w: 1, h: 1 }, position: { x: 0, y: 0 }, zIndex: 1 };
    showCutoutMenuAt(10, 10, cutout);
    labels = ui.menu!.items.map((i) => i.label);
    expect(labels.some((l) => l.includes('Sitzungsmappe'))).toBe(false);
  });
});

describe('VIEW-01 (11-08 Task 2): Hervorhebungs-Umschalter „In Ansicht hervorheben" im Kontextmenü', () => {
  function doc(id: string): Doc {
    return { id, fileId: `f-${id}`, name: `${id}.pdf`, position: { x: 0, y: 0 }, rotation: 0, zIndex: 1, createdById: 'u1' };
  }
  function notiz(id: string): Note {
    return { id, kind: 'notiz', text: 'x', position: { x: 0, y: 0 }, zIndex: 1, createdById: 'u1' };
  }
  function stapel(id: string): Stack {
    return { id, name: 'Stapel', docIds: [], position: { x: 0, y: 0 }, zIndex: 1 };
  }
  function jurObjekt(id: string): LegalObject {
    return { id, kind: 'tatsache', text: 'x', position: { x: 0, y: 0 }, zIndex: 1, createdById: 'u1' };
  }
  function tabelle(id: string): TableCard {
    return { id, titel: '', spalten: [], rows: [], position: { x: 0, y: 0 }, zIndex: 1 };
  }
  function zeitleiste(id: string): ZeitleisteCard {
    return { id, titel: 'Zeitleiste', eintraege: [], position: { x: 0, y: 0 }, zIndex: 1 };
  }
  function ausschnitt(id: string): Cutout {
    return { id, fileId: 'f1', page: 1, rect: { x: 0, y: 0, w: 1, h: 1 }, position: { x: 0, y: 0 }, zIndex: 1 };
  }

  const SECHS_ARTEN = ['doc', 'stack', 'note', 'legal', 'table', 'zeitleiste'] as const;

  /** Öffnet das Kontextmenü der Objektart und liefert die Beschriftungen der Einträge. */
  function menueLabels(art: (typeof SECHS_ARTEN)[number] | 'cutout', id: string): string[] {
    if (art === 'doc') showDocMenuAt(10, 10, doc(id));
    else if (art === 'stack') showStackMenuAt(10, 10, stapel(id));
    else if (art === 'note') showNoteMenuAt(10, 10, notiz(id));
    else if (art === 'legal') showLegalObjectMenuAt(10, 10, jurObjekt(id));
    else if (art === 'table') showTableMenuAt(10, 10, tabelle(id));
    else if (art === 'zeitleiste') showZeitleisteMenuAt(10, 10, zeitleiste(id));
    else showCutoutMenuAt(10, 10, ausschnitt(id));
    return ui.menu!.items.map((i) => i.label);
  }

  afterEach(() => {
    ui.menu = null;
    ui.highlightedIds = new Set();
    vi.restoreAllMocks();
  });

  it.each(SECHS_ARTEN)('erscheint im %s-Menü als „In Ansicht hervorheben", solange die Kennung nicht hervorgehoben ist', (art) => {
    expect(menueLabels(art, 'o1')).toContain('In Ansicht hervorheben');
  });

  it.each(SECHS_ARTEN)('schaltet im %s-Menü auf „Hervorhebung entfernen" um, sobald die Kennung hervorgehoben ist', (art) => {
    ui.highlightedIds = new Set(['o1']);
    const labels = menueLabels(art, 'o1');
    expect(labels).toContain('Hervorhebung entfernen');
    expect(labels).not.toContain('In Ansicht hervorheben');
  });

  it('Auslösen fügt die Kennung hinzu und ersetzt die Menge durch eine NEUE Instanz (keine Mutation — Reaktivität der Karten muss sicher auslösen)', () => {
    const vorher = new Set<string>();
    ui.highlightedIds = vorher;
    showNoteMenuAt(10, 10, notiz('n1'));
    ui.menu!.items.find((i) => i.label === 'In Ansicht hervorheben')!.action();
    expect(ui.highlightedIds).not.toBe(vorher);
    expect(vorher.has('n1')).toBe(false); // Ausgangsmenge unverändert
    expect(ui.highlightedIds.has('n1')).toBe(true);
  });

  it('Entfernen-Auslösen entfernt die Kennung und erhält die übrigen Einträge der Menge', () => {
    ui.highlightedIds = new Set(['n1', 'n2']);
    showNoteMenuAt(10, 10, notiz('n1'));
    ui.menu!.items.find((i) => i.label === 'Hervorhebung entfernen')!.action();
    expect([...ui.highlightedIds]).toEqual(['n2']);
  });

  it('zweimaliges Auslösen stellt den Ausgangszustand exakt wieder her', () => {
    ui.highlightedIds = new Set(['x']);
    showDocMenuAt(10, 10, doc('d1'));
    ui.menu!.items.find((i) => i.label === 'In Ansicht hervorheben')!.action();
    showDocMenuAt(10, 10, doc('d1'));
    ui.menu!.items.find((i) => i.label === 'Hervorhebung entfernen')!.action();
    expect([...ui.highlightedIds]).toEqual(['x']);
  });

  it('löst KEIN Kommando aus — die Hervorhebung ist reiner Client-Zustand und kann serverseitig nicht fehlschlagen (E6/error)', () => {
    const spion = vi.spyOn(desktop, 'command').mockResolvedValue({ ok: true });
    showDocMenuAt(10, 10, doc('d1'));
    ui.menu!.items.find((i) => i.label === 'In Ansicht hervorheben')!.action();
    expect(spion).not.toHaveBeenCalled();
  });

  it('erscheint NICHT im Ausschnitt-Menü (bewusste Abgrenzung, kein Versehen)', () => {
    const labels = menueLabels('cutout', 'c1');
    expect(labels.some((l) => l.includes('hervorheben') || l.includes('Hervorhebung'))).toBe(false);
  });
});
