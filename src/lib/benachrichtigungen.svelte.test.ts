import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient, BenachrichtigungDto } from './api';
import { emptyState, type DesktopState } from '@j-desk/core';
import {
  benachrichtigungen, ladeBenachrichtigungen, markiereAlleGelesen, markiereGelesen,
  setzeBenachrichtigungenZurueck, signalEmpfangen, ungelesen, ungelesenText,
  zeilenMitSammelzeile, loeseZielAuf, klickZiel, istSammelzeile,
} from './benachrichtigungen.svelte';
import { freigaben } from './freigaben.svelte';
import { ui } from './ui.svelte';
import { enqueueCommand } from './offlineQueue';

/**
 * Client-Zustandsmodul der Inbox (NOTIF-01, 13-01 Task 2) — Struktur-Parallele zu
 * freigaben.svelte.ts (WR-04-Generationsschutz, inhaltsfreies Signal, Funktions-Exporte
 * statt Derived-Export). Zwei Abweichungen bewusst: „Alle als gelesen markieren" ist
 * online-only mit Toast-Fehler (zustandsbezogen, nicht historisch — Anti-Pattern
 * „Genehmigung durch die Offline-Queue", freigaben.svelte.ts:14-16), die einzelne
 * Zeilen-Markierung darf optimistisch wirken.
 */
vi.mock('./offlineQueue', () => ({ enqueueCommand: vi.fn() }));

function zeile(teil: Partial<BenachrichtigungDto> = {}): BenachrichtigungDto {
  return {
    id: 'z1',
    user_id: 'u1',
    desk_id: 'd1',
    art: 'erwaehnung',
    payload: { notizId: 'n1', notizTitel: 'Bitte prüfen', vonName: 'nutzer-a', textStand: 'Bitte prüfen @nutzer-b' },
    created_at: 1000,
    read_at: null,
    ...teil,
  };
}

function apiMit(antwort: () => Promise<{ benachrichtigungen: BenachrichtigungDto[] }>): ApiClient {
  return { listBenachrichtigungen: vi.fn(antwort) } as unknown as ApiClient;
}

beforeEach(() => {
  setzeBenachrichtigungenZurueck();
  ui.toast = null;
  vi.mocked(enqueueCommand).mockClear();
  freigaben.vorschlaege = []; // 13-04: zeilenMitSammelzeile() liest zaehler() — isolierte Tests
});

describe('ungelesen/ungelesenText', () => {
  it('zählt genau die Zeilen mit read_at === null', () => {
    benachrichtigungen.zeilen = [
      zeile({ id: 'a' }),
      zeile({ id: 'b', read_at: 2000 }),
      zeile({ id: 'c' }),
    ];
    expect(ungelesen()).toBe(2);
  });

  it('liefert die Zahl als String unter 100 und „99+" ab 100 (E10/zero-one-many)', () => {
    benachrichtigungen.zeilen = [zeile()];
    expect(ungelesenText()).toBe('1');
    benachrichtigungen.zeilen = Array.from({ length: 100 }, (_, i) => zeile({ id: `z${i}` }));
    expect(ungelesenText()).toBe('99+');
  });

  it('liefert 0 bei leerer Inbox (Badge unsichtbar)', () => {
    expect(ungelesen()).toBe(0);
  });
});

describe('ladeBenachrichtigungen', () => {
  it('übernimmt die Server-Liste in den Zustand und leert fehler', async () => {
    benachrichtigungen.fehler = 'alter Fehler';
    const liste = [zeile({ id: 'neu' })];
    const api = apiMit(async () => ({ benachrichtigungen: liste }));

    await ladeBenachrichtigungen(api);

    expect(benachrichtigungen.zeilen).toEqual(liste);
    expect(benachrichtigungen.fehler).toBeNull();
    expect(benachrichtigungen.laden).toBe(false);
    expect(api.listBenachrichtigungen).toHaveBeenCalledTimes(1);
  });

  it('behält bei Fehlschlag die alte Liste und trägt die Server-Meldung (letzter bekannter Stand, E10/error)', async () => {
    const alt = [zeile({ id: 'alt' })];
    benachrichtigungen.zeilen = alt;
    const api = apiMit(async () => { throw new Error('Netz weg'); });

    await ladeBenachrichtigungen(api);

    expect(benachrichtigungen.zeilen).toEqual(alt);
    expect(benachrichtigungen.fehler).toBe('Netz weg');
    expect(benachrichtigungen.laden).toBe(false);
    expect(benachrichtigungen.letzterModus).not.toBeNull();
  });

  it('verwirft eine stale Antwort eines älteren Ladevorgangs (WR-04-Generationsschutz)', async () => {
    let loeseAlt!: (v: { benachrichtigungen: BenachrichtigungDto[] }) => void;
    const listBenachrichtigungen = vi
      .fn<() => Promise<{ benachrichtigungen: BenachrichtigungDto[] }>>()
      .mockImplementationOnce(() => new Promise((resolve) => { loeseAlt = resolve; }))
      .mockResolvedValueOnce({ benachrichtigungen: [zeile({ id: 'frisch' })] });
    const api = { listBenachrichtigungen } as unknown as ApiClient;

    const ladungAlt = ladeBenachrichtigungen(api);
    await ladeBenachrichtigungen(api); // zweiter Ladevorgang gewinnt das Rennen
    loeseAlt({ benachrichtigungen: [zeile({ id: 'stale' })] });
    await ladungAlt;

    expect(benachrichtigungen.zeilen.map((z) => z.id)).toEqual(['frisch']);
    expect(benachrichtigungen.laden).toBe(false);
  });
});

describe('signalEmpfangen', () => {
  it('löst ausschließlich ein REST-Nachladen aus und dereferenziert das Event NIEMALS (Pitfall P2)', async () => {
    const api = apiMit(async () => ({ benachrichtigungen: [zeile()] }));
    // Das Event wird bewusst NICHT als Parameter entgegengenommen — wir reichen es hier
    // dennoch ein (als Proxy, der jeden Feldzugriff zählt), um zu beweisen, dass kein
    // Zugriff darauf stattfindet: das WS-Signal ist ein reiner Trigger (Inhaltsfreiheit).
    let zugriffe = 0;
    const event = new Proxy({}, { get: () => { zugriffe++; return undefined; } });

    await (signalEmpfangen as unknown as (a: ApiClient, e: unknown) => Promise<void>)(api, event);

    expect(api.listBenachrichtigungen).toHaveBeenCalledTimes(1);
    expect(zugriffe).toBe(0);
    expect(ungelesen()).toBe(1);
  });
});

describe('markiereGelesen', () => {
  it('wirkt optimistisch auf der Zeile und ruft die API', async () => {
    benachrichtigungen.zeilen = [zeile({ id: 'a' }), zeile({ id: 'b' })];
    const api = {
      markiereBenachrichtigungGelesen: vi.fn(async () => ({ ok: true })),
    } as unknown as ApiClient;

    await markiereGelesen(api, 'a');

    expect(benachrichtigungen.zeilen.find((z) => z.id === 'a')!.read_at).not.toBeNull();
    expect(benachrichtigungen.zeilen.find((z) => z.id === 'b')!.read_at).toBeNull();
    expect(ungelesen()).toBe(1);
    expect(api.markiereBenachrichtigungGelesen).toHaveBeenCalledWith('a');
  });

  it('wirft bei API-Fehler NICHT nach außen (Toast-Pfad); der nächste Ladevorgang korrigiert den Stand', async () => {
    benachrichtigungen.zeilen = [zeile({ id: 'a' })];
    const api = {
      markiereBenachrichtigungGelesen: vi.fn(async () => { throw new Error('Server sagt nein'); }),
      listBenachrichtigungen: vi.fn(async () => ({ benachrichtigungen: [zeile({ id: 'a' })] })),
    } as unknown as ApiClient;

    await markiereGelesen(api, 'a'); // darf nicht werfen

    expect(ui.toast).toBe('Server sagt nein');
    // Nachladen (z. B. durch das nächste WS-Signal) stellt den Serverstand wieder her.
    await ladeBenachrichtigungen(api);
    expect(benachrichtigungen.zeilen[0].read_at).toBeNull();
    expect(ungelesen()).toBe(1);
  });
});

describe('markiereAlleGelesen', () => {
  it('ruft die alle-gelesen-Route und leert den Ungelesen-Zähler', async () => {
    benachrichtigungen.zeilen = [zeile({ id: 'a' }), zeile({ id: 'b', read_at: 2000 }), zeile({ id: 'c' })];
    const api = {
      markiereAlleBenachrichtigungenGelesen: vi.fn(async () => ({ ok: true })),
    } as unknown as ApiClient;

    await markiereAlleGelesen(api);

    expect(api.markiereAlleBenachrichtigungenGelesen).toHaveBeenCalledTimes(1);
    expect(ungelesen()).toBe(0);
  });

  it('ist online-only: meldet den Verbindungsfehler per Toast und reiht NICHT in die Offline-Queue ein', async () => {
    benachrichtigungen.zeilen = [zeile({ id: 'a' })];
    const api = {
      markiereAlleBenachrichtigungenGelesen: vi.fn(async () => { throw new Error('Keine Verbindung'); }),
    } as unknown as ApiClient;

    await markiereAlleGelesen(api);

    expect(ui.toast).toBe('Keine Verbindung');
    expect(enqueueCommand).not.toHaveBeenCalled();
    // kein Optimismus im Fehlerfall: die Zeile bleibt ungelesen
    expect(ungelesen()).toBe(1);
  });
});

describe('setzeBenachrichtigungenZurueck', () => {
  it('leert Zeilen/Zähler und invalidiert laufende Ladevorgänge (Generationsschutz, WR-02/WR-04)', async () => {
    benachrichtigungen.zeilen = [zeile({ id: 'alt' })];
    let loese!: (v: { benachrichtigungen: BenachrichtigungDto[] }) => void;
    const api = {
      listBenachrichtigungen: vi.fn(
        (): Promise<{ benachrichtigungen: BenachrichtigungDto[] }> => new Promise((resolve) => { loese = resolve; }),
      ),
    } as unknown as ApiClient;

    const ladung = ladeBenachrichtigungen(api);
    setzeBenachrichtigungenZurueck(); // Desk-Wechsel/Abmeldung während der Ladung
    loese({ benachrichtigungen: [zeile({ id: 'stale' })] });
    await ladung;

    expect(benachrichtigungen.zeilen).toEqual([]);
    expect(ungelesen()).toBe(0);
    expect(benachrichtigungen.laden).toBe(false);
    expect(benachrichtigungen.fehler).toBeNull();
    expect(benachrichtigungen.letzterModus).toBeNull();
  });
});

/**
 * 13-04 Task 3: KI-Sammelzeile, inert-Auflösung und Klickziele — dieselbe Zustandsquelle
 * (freigaben.svelte.ts::zaehler()) wie das Freigaben-Signal, keine zweite Zählung
 * (T-13-04-04); loeseZielAuf/klickZiel prüfen gegen den geladenen DesktopState.
 */
function staat(teil: Partial<DesktopState> = {}): DesktopState {
  return { ...emptyState(), ...teil };
}

describe('zeilenMitSammelzeile', () => {
  it('bei zaehler() === 0 enthält die Liste keine KI-Zeile', () => {
    benachrichtigungen.zeilen = [zeile({ id: 'a' })];
    freigaben.vorschlaege = [];

    const liste = zeilenMitSammelzeile();

    expect(liste).toHaveLength(1);
    expect(liste.some(istSammelzeile)).toBe(false);
  });

  it('bei zaehler() ≥ 1 enthält die Liste GENAU EINE Sammelzeile mit dem fixierten Text (N eingesetzt), unabhängig von der Zahl der Tabellenzeilen', () => {
    benachrichtigungen.zeilen = [zeile({ id: 'a' }), zeile({ id: 'b' }), zeile({ id: 'c' })];
    freigaben.vorschlaege = [
      { id: 'v1', status: 'ausstehend' } as never,
      { id: 'v2', status: 'ausstehend' } as never,
    ];

    const liste = zeilenMitSammelzeile();
    const sammelzeilen = liste.filter(istSammelzeile);

    expect(liste).toHaveLength(4);
    expect(sammelzeilen).toHaveLength(1);
    expect(sammelzeilen[0]).toEqual({ id: '__ki-sammelzeile__', art: 'ki-sammelzeile', anzahl: 2 });
  });
});

describe('loeseZielAuf', () => {
  it('Erwähnungs-Zeile: notizId fehlt im State -> inert (false); ist die Notiz vorhanden -> auflösbar (true)', () => {
    const z = zeile({ art: 'erwaehnung', payload: { notizId: 'n-weg' } });
    expect(loeseZielAuf(z, staat())).toBe(false);

    const vorhanden = staat({ notes: [{ id: 'n-weg', kind: 'notiz', text: 'x', position: { x: 0, y: 0 }, zIndex: 1 }] });
    expect(loeseZielAuf(z, vorhanden)).toBe(true);
  });

  it('Aufgaben-Zeile: aufgabeId fehlt im State -> inert; vorhandene Aufgabe -> auflösbar', () => {
    const z = zeile({ art: 'aufgabe', payload: { aufgabeId: 't-weg', titel: 'Frist' } });
    expect(loeseZielAuf(z, staat())).toBe(false);

    const vorhanden = staat({
      legalObjects: [{ id: 't-weg', kind: 'aufgabe', text: 'Frist', position: { x: 0, y: 0 }, zIndex: 1 }],
    });
    expect(loeseZielAuf(z, vorhanden)).toBe(true);
  });

  it('ersetzt-/quelle-Zeile: dokumentId fehlt im State -> inert; vorhandenes Dokument -> auflösbar', () => {
    const z = zeile({ art: 'ersetzt', payload: { dokumentId: 'd-weg', dokumentName: 'Vertrag.pdf' } });
    expect(loeseZielAuf(z, staat())).toBe(false);

    const vorhanden = staat({
      docs: [{ id: 'd-weg', fileId: 'f1', name: 'Vertrag.pdf', kind: 'pdf', position: { x: 0, y: 0 }, rotation: 0, zIndex: 1 }],
    });
    expect(loeseZielAuf(z, vorhanden)).toBe(true);
  });

  it('Sammelzeile ist immer auflösbar (kein Server-Ziel, Klickziel ist der VorschlaegeDialog)', () => {
    const sammelzeile = { id: '__ki-sammelzeile__' as const, art: 'ki-sammelzeile' as const, anzahl: 3 };
    expect(loeseZielAuf(sammelzeile, staat())).toBe(true);
  });
});

describe('klickZiel', () => {
  it('erwaehnung/aufgabe liefern einen Sprung-Deskriptor (Bestands-Sprungweg) auf die Objekt-id', () => {
    const notizState = staat({ notes: [{ id: 'n1', kind: 'notiz', text: 'x', position: { x: 5, y: 5 }, zIndex: 1 }] });
    const erwaehnung = zeile({ art: 'erwaehnung', payload: { notizId: 'n1' } });
    expect(klickZiel(erwaehnung, notizState)).toMatchObject({ art: 'sprung' });

    const aufgabeState = staat({
      legalObjects: [{ id: 't1', kind: 'aufgabe', text: 'Frist', position: { x: 5, y: 5 }, zIndex: 1 }],
    });
    const aufgabe = zeile({ art: 'aufgabe', payload: { aufgabeId: 't1', titel: 'Frist' } });
    expect(klickZiel(aufgabe, aufgabeState)).toMatchObject({ art: 'sprung' });
  });

  it('ersetzt/quelle liefern das Öffnen des Dokuments (Fundstelle mit docId)', () => {
    const state = staat({
      docs: [{ id: 'd1', fileId: 'f1', name: 'Vertrag.pdf', kind: 'pdf', position: { x: 0, y: 0 }, rotation: 0, zIndex: 1 }],
    });
    const ersetzt = zeile({ art: 'ersetzt', payload: { dokumentId: 'd1', dokumentName: 'Vertrag.pdf' } });
    expect(klickZiel(ersetzt, state)).toEqual({ art: 'dokument', ziel: { docId: 'd1', page: 1 } });
  });

  it('geteilt liefert den Desk-Wechsel (deskId aus dem Payload)', () => {
    const geteilt = zeile({ art: 'geteilt', payload: { deskId: 'desk-x', deskName: 'Akte X', rolle: 'Kommentator' } });
    expect(klickZiel(geteilt, staat())).toEqual({ art: 'desk', deskId: 'desk-x' });
  });

  it('Sammelzeile liefert das Öffnen des VorschlaegeDialog', () => {
    const sammelzeile = { id: '__ki-sammelzeile__' as const, art: 'ki-sammelzeile' as const, anzahl: 1 };
    expect(klickZiel(sammelzeile, staat())).toEqual({ art: 'sammelzeile' });
  });

  it('inert (Ziel fehlt) liefert null — kein Klickziel', () => {
    const erwaehnung = zeile({ art: 'erwaehnung', payload: { notizId: 'n-weg' } });
    expect(klickZiel(erwaehnung, staat())).toBeNull();
  });
});
