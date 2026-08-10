import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient, VorschlagDto } from './api';
import {
  aktualisiereNachEntscheidung, freigaben, ladeVorschlaege, setzeFreigabenZurueck,
  signalEmpfangen, zaehler, zaehlerText,
} from './freigaben.svelte';

/** Minimales DTO (oeffentlicheFelder der Server-Route, 12-03) — nur die Felder, die der
 *  Server ausliefert; inverse/genehmigte_objekte kommen strukturell nie an. */
function vorschlag(teil: Partial<VorschlagDto> = {}): VorschlagDto {
  return {
    id: 'v1',
    art: 'addNote',
    payload: {},
    quellen: [],
    zusammenfassung: 'Notiz anlegen',
    status: 'ausstehend',
    createdBy: 'ki-agent',
    createdAt: 1000,
    ...teil,
  };
}

function apiMit(antwort: () => Promise<{ vorschlaege: VorschlagDto[] }>): ApiClient {
  return { listVorschlaege: vi.fn(antwort) } as unknown as ApiClient;
}

beforeEach(() => setzeFreigabenZurueck());

describe('zaehler', () => {
  it('zählt genau die Einträge mit status „ausstehend" — entschiedene zählen nicht', () => {
    freigaben.vorschlaege = [
      vorschlag({ id: 'a', status: 'ausstehend' }),
      vorschlag({ id: 'b', status: 'genehmigt' }),
      vorschlag({ id: 'c', status: 'ausstehend' }),
      vorschlag({ id: 'd', status: 'abgelehnt' }),
      vorschlag({ id: 'e', status: 'zurückgenommen' }),
    ];
    expect(zaehler()).toBe(2);
  });
});

describe('zaehlerText', () => {
  it('liefert die Zahl als String unter 100', () => {
    freigaben.vorschlaege = [vorschlag()];
    expect(zaehlerText()).toBe('1');
  });

  it('liefert „99+" ab 100 wartenden Vorschlägen (E1/overflow)', () => {
    freigaben.vorschlaege = Array.from({ length: 100 }, (_, i) => vorschlag({ id: `v${i}` }));
    expect(zaehlerText()).toBe('99+');
  });
});

describe('ladeVorschlaege', () => {
  it('ersetzt bei Erfolg die Liste und leert fehler', async () => {
    freigaben.fehler = 'alter Fehler';
    const liste = [vorschlag({ id: 'neu' })];
    const api = apiMit(async () => ({ vorschlaege: liste }));

    await ladeVorschlaege(api, 'd1');

    expect(freigaben.vorschlaege).toEqual(liste);
    expect(freigaben.fehler).toBeNull();
    expect(freigaben.laden).toBe(false);
    expect(api.listVorschlaege).toHaveBeenCalledWith('d1');
  });

  it('behält bei Fehlschlag die alte Liste, trägt die Server-Meldung und merkt den Schritt (Erneut-versuchen)', async () => {
    const alt = [vorschlag({ id: 'alt' })];
    freigaben.vorschlaege = alt;
    const listVorschlaege = vi
      .fn<() => Promise<{ vorschlaege: VorschlagDto[] }>>()
      .mockRejectedValueOnce(new Error('Server sagt nein'))
      .mockResolvedValueOnce({ vorschlaege: [vorschlag({ id: 'nach-retry' })] });
    const api = { listVorschlaege } as unknown as ApiClient;

    await ladeVorschlaege(api, 'd1');

    expect(freigaben.vorschlaege).toEqual(alt);
    expect(freigaben.fehler).toBe('Server sagt nein');
    expect(freigaben.laden).toBe(false);
    expect(freigaben.letzterModus).not.toBeNull();

    // „Erneut versuchen" (ActivityOverlay-Muster): exakt derselbe Schritt — gleiche Methode,
    // gleiche deskId — ohne dass der Aufrufer die Argumente erneut kennen muss.
    await freigaben.letzterModus!();
    expect(listVorschlaege).toHaveBeenCalledTimes(2);
    expect(listVorschlaege).toHaveBeenNthCalledWith(2, 'd1');
    expect(freigaben.vorschlaege[0].id).toBe('nach-retry');
    expect(freigaben.fehler).toBeNull();
  });

  it('verwirft eine stale Antwort nach Desk-Wechsel (WR-04: kein fremdes Mandat im Zustand)', async () => {
    // Race aus dem Review: WS-Signal auf Desk A startet den GET → Wechsel zu Desk B →
    // die ältere A-Antwort trifft ZULETZT ein und darf die B-Liste nicht überschreiben.
    let loeseA!: (v: { vorschlaege: VorschlagDto[] }) => void;
    const listVorschlaege = vi.fn((deskId: string): Promise<{ vorschlaege: VorschlagDto[] }> =>
      deskId === 'desk-a'
        ? new Promise((resolve) => { loeseA = resolve; })
        : Promise.resolve({ vorschlaege: [vorschlag({ id: 'von-b' })] }));
    const api = { listVorschlaege } as unknown as ApiClient;

    const ladungA = ladeVorschlaege(api, 'desk-a');
    await ladeVorschlaege(api, 'desk-b'); // Desk-Wechsel: B lädt und gewinnt das Rennen
    loeseA({ vorschlaege: [vorschlag({ id: 'von-a' })] });
    await ladungA;

    expect(freigaben.vorschlaege.map((v) => v.id)).toEqual(['von-b']);
    expect(freigaben.laden).toBe(false);
    expect(freigaben.fehler).toBeNull();
  });

  it('verwirft eine stale Antwort nach setzeFreigabenZurueck (WR-04: Rücksetzung invalidiert laufende Ladevorgänge)', async () => {
    let loese!: (v: { vorschlaege: VorschlagDto[] }) => void;
    const listVorschlaege = vi.fn(
      (): Promise<{ vorschlaege: VorschlagDto[] }> => new Promise((resolve) => { loese = resolve; }),
    );
    const api = { listVorschlaege } as unknown as ApiClient;

    const ladung = ladeVorschlaege(api, 'desk-a');
    setzeFreigabenZurueck(); // Desk-Wechsel/Abmeldung während der Ladung
    loese({ vorschlaege: [vorschlag({ id: 'stale' })] });
    await ladung;

    expect(freigaben.vorschlaege).toEqual([]);
    expect(freigaben.laden).toBe(false);
    expect(freigaben.fehler).toBeNull();
  });

  it('verwirft auch eine stale FEHLERMELDUNG nach Desk-Wechsel (WR-04)', async () => {
    let weiseZurueck!: (e: Error) => void;
    const listVorschlaege = vi.fn((deskId: string): Promise<{ vorschlaege: VorschlagDto[] }> =>
      deskId === 'desk-a'
        ? new Promise((_resolve, reject) => { weiseZurueck = reject; })
        : Promise.resolve({ vorschlaege: [vorschlag({ id: 'von-b' })] }));
    const api = { listVorschlaege } as unknown as ApiClient;

    const ladungA = ladeVorschlaege(api, 'desk-a');
    await ladeVorschlaege(api, 'desk-b');
    weiseZurueck(new Error('A-Server sagt nein'));
    await ladungA;

    expect(freigaben.fehler).toBeNull();
    expect(freigaben.vorschlaege.map((v) => v.id)).toEqual(['von-b']);
  });
});

describe('signalEmpfangen', () => {
  it('löst ausschließlich ein REST-Nachladen aus und dereferenziert das Event NIEMALS (Pitfall 3)', async () => {
    const api = apiMit(async () => ({ vorschlaege: [vorschlag()] }));
    // Das Event wird bewusst NICHT als Parameter entgegengenommen — wir reichen es hier
    // dennoch ein (als Proxy, der jeden Feldzugriff zählt), um zu beweisen, dass kein
    // Zugriff darauf stattfindet: das WS-Signal ist ein reiner Trigger, die Liste kommt
    // projiziert per GET (Inhaltsfreiheit, Andeutungs-Verbot).
    let zugriffe = 0;
    const event = new Proxy({}, { get: () => { zugriffe++; return undefined; } });

    await (signalEmpfangen as unknown as (a: ApiClient, d: string, e: unknown) => Promise<void>)(api, 'd1', event);

    expect(api.listVorschlaege).toHaveBeenCalledWith('d1');
    expect(zugriffe).toBe(0);
    expect(zaehler()).toBe(1);
  });
});

describe('aktualisiereNachEntscheidung', () => {
  it('ersetzt den betroffenen Eintrag lokal (status + entschiedenVon), ohne die übrigen anzufassen', () => {
    freigaben.vorschlaege = [vorschlag({ id: 'a' }), vorschlag({ id: 'b' })];

    aktualisiereNachEntscheidung('a', 'genehmigt', 'Kollegin');

    const [a, b] = freigaben.vorschlaege;
    expect(a.status).toBe('genehmigt');
    expect(a.decidedBy).toBe('Kollegin');
    expect(b.status).toBe('ausstehend');
    expect(b.decidedBy).toBeUndefined();
    // Live-Konsistenz-Zeile („Bereits übernommen von {Name}", Plan 12-07) UND Zähler
    // folgen derselben lokalen Aktualisierung — keine stale Aktion, kein Voll-Reload nötig.
    expect(zaehler()).toBe(1);
  });

  it('zeichnet auch eine Ablehnung lokal nach', () => {
    freigaben.vorschlaege = [vorschlag({ id: 'a' })];
    aktualisiereNachEntscheidung('a', 'abgelehnt', 'Kollege');
    expect(freigaben.vorschlaege[0].status).toBe('abgelehnt');
    expect(freigaben.vorschlaege[0].decidedBy).toBe('Kollege');
    expect(zaehler()).toBe(0);
  });
});

describe('setzeFreigabenZurueck', () => {
  it('leert Liste, fehler, laden und letzterModus (WR-02 — der Zustand überlebt weder Desk-Wechsel noch Abmeldung)', async () => {
    const api = apiMit(async () => ({ vorschlaege: [vorschlag()] }));
    await ladeVorschlaege(api, 'd1');
    freigaben.fehler = 'Restfehler';
    freigaben.laden = true;
    freigaben.fokussierterVorschlagId = 'scroll-ziel';

    setzeFreigabenZurueck();

    expect(freigaben.vorschlaege).toEqual([]);
    expect(freigaben.fehler).toBeNull();
    expect(freigaben.laden).toBe(false);
    expect(freigaben.letzterModus).toBeNull();
    expect(freigaben.fokussierterVorschlagId).toBeNull();
    expect(zaehler()).toBe(0);
  });
});
