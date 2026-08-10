import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyState, type DesktopState } from '@j-desk/core';
import {
  VIEWS_KEY_PREFIX,
  ANSICHT_NAME_MAX,
  normalisiereName,
  leseAnsichten,
  schreibeAnsichten,
  sortiereAnsichten,
  ansichtSpeichern,
  ansichtEntfernen,
  klemmeSkalierung,
  planeAnsichtAnwendung,
  type Ansicht,
  type AnsichtZustand,
} from './views';

/**
 * views.test.ts (VIEW-01, 11-02, Wave-0-Datei aus 11-VALIDATION.md): reine Vitest-Tests ohne DOM
 * (`environment: 'node'`) — localStorage-Stub identisch zu store.layers.test.ts.
 */

function zustand(overrides: Partial<AnsichtZustand> = {}): AnsichtZustand {
  return {
    vp: { x: 0, y: 0, scale: 1 },
    visibleLayers: ['kanzlei'],
    suchText: '',
    highlightedIds: [],
    openDocIds: [],
    ...overrides,
  };
}

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

describe('leseAnsichten', () => {
  it('liefert bei fehlendem Schlüssel ein leeres Array', () => {
    expect(leseAnsichten('d1')).toEqual([]);
  });

  it('liefert bei kaputtem JSON ein leeres Array statt zu werfen', () => {
    localStorage.setItem(VIEWS_KEY_PREFIX + 'd1', '{kaputt');
    expect(leseAnsichten('d1')).toEqual([]);
  });

  it('überspringt einzelne ungültige Einträge und behält die gültigen', () => {
    const gueltig: Ansicht = { id: 'a1', name: 'Gültig', ...zustand(), updatedAt: '2026-01-01T00:00:00.000Z' };
    const ohneName = { id: 'a2', ...zustand(), updatedAt: '2026-01-01T00:00:00.000Z' };
    const kaputterVp = {
      id: 'a3', name: 'Kaputt', ...zustand({ vp: { x: NaN, y: 0, scale: 1 } }), updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const kaputteVpInfinity = {
      id: 'a5', name: 'AuchKaputt', ...zustand({ vp: { x: 0, y: Infinity, scale: 1 } }), updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const docIdsKeinArray = {
      id: 'a4', name: 'NochKaputt', ...zustand(), openDocIds: 'nope', updatedAt: '2026-01-01T00:00:00.000Z',
    };
    localStorage.setItem(
      VIEWS_KEY_PREFIX + 'd1',
      JSON.stringify([gueltig, ohneName, kaputterVp, kaputteVpInfinity, docIdsKeinArray]),
    );
    expect(leseAnsichten('d1')).toEqual([gueltig]);
  });

  it('liefert bei werfendem localStorage.getItem ein leeres Array', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('gesperrt'); },
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
    });
    expect(leseAnsichten('d1')).toEqual([]);
  });

  it('Ansichten verschiedener deskIds landen unter verschiedenen Schlüsseln und sehen einander nicht', () => {
    ansichtSpeichern('d1', 'A', zustand(), '2026-01-01T00:00:00.000Z', 'v1');
    ansichtSpeichern('d2', 'B', zustand(), '2026-01-01T00:00:00.000Z', 'v2');
    expect(leseAnsichten('d1').map((a) => a.id)).toEqual(['v1']);
    expect(leseAnsichten('d2').map((a) => a.id)).toEqual(['v2']);
  });
});

describe('schreibeAnsichten', () => {
  it('kehrt bei werfendem setItem still zurück', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => { throw new Error('gesperrt'); },
      removeItem: () => {},
      clear: () => {},
    });
    expect(() => schreibeAnsichten('d1', [])).not.toThrow();
  });
});

describe('normalisiereName', () => {
  it('kürzt auf 40 UTF-16-Codeeinheiten', () => {
    const lang = 'x'.repeat(50);
    expect(normalisiereName(lang)).toHaveLength(ANSICHT_NAME_MAX);
  });
});

describe('ansichtSpeichern', () => {
  it('legt einen Eintrag mit id, normalisiertem Namen, Zustandskopie und updatedAt an', () => {
    const z = zustand({ suchText: 'Kündigung' });
    const liste = ansichtSpeichern('d1', '  Übersicht  ', z, '2026-01-01T00:00:00.000Z', 'v1');
    expect(liste).toHaveLength(1);
    expect(liste[0]).toMatchObject({
      id: 'v1', name: 'Übersicht', suchText: 'Kündigung', updatedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('ersetzt bei erneutem Aufruf mit demselben Namen den bestehenden Eintrag (Länge 1, gleiche id, neues updatedAt)', () => {
    ansichtSpeichern('d1', 'Übersicht', zustand(), '2026-01-01T00:00:00.000Z', 'v1');
    const liste = ansichtSpeichern('d1', 'Übersicht', zustand({ suchText: 'geändert' }), '2026-01-02T00:00:00.000Z', 'v2');
    expect(liste).toHaveLength(1);
    expect(liste[0].id).toBe('v1');
    expect(liste[0].updatedAt).toBe('2026-01-02T00:00:00.000Z');
    expect(liste[0].suchText).toBe('geändert');
  });

  it('Namensidentität ist unabhängig von Leerzeichen, Groß-/Kleinschreibung und Unicode-Normalisierungsform', () => {
    ansichtSpeichern('d1', 'Übersicht', zustand(), '2026-01-01T00:00:00.000Z', 'v1');
    let liste = ansichtSpeichern('d1', ' übersicht ', zustand(), '2026-01-02T00:00:00.000Z', 'v2');
    expect(liste).toHaveLength(1);
    expect(liste[0].id).toBe('v1');

    const nfd = 'Übersicht'; // NFD-Schreibweise von "Übersicht" (U + kombinierender Trema)
    liste = ansichtSpeichern('d1', nfd, zustand(), '2026-01-03T00:00:00.000Z', 'v3');
    expect(liste).toHaveLength(1);
    expect(liste[0].id).toBe('v1');
  });

  it('liest unmittelbar vor dem Schreiben erneut aus localStorage (Read-Modify-Write)', () => {
    ansichtSpeichern('d1', 'Erste', zustand(), '2026-01-01T00:00:00.000Z', 'v1');
    const aussen: Ansicht = { id: 'extern', name: 'Von außen', ...zustand(), updatedAt: '2026-01-01T12:00:00.000Z' };
    const bisherige = leseAnsichten('d1');
    schreibeAnsichten('d1', [...bisherige, aussen]);
    const liste = ansichtSpeichern('d1', 'Zweite', zustand(), '2026-01-02T00:00:00.000Z', 'v2');
    expect(liste.map((a) => a.id).sort()).toEqual(['extern', 'v1', 'v2']);
  });
});

describe('ansichtEntfernen', () => {
  it('entfernt genau den Eintrag mit der übergebenen id und lässt die übrigen unverändert', () => {
    ansichtSpeichern('d1', 'A', zustand(), '2026-01-01T00:00:00.000Z', 'v1');
    ansichtSpeichern('d1', 'B', zustand(), '2026-01-01T00:00:00.000Z', 'v2');
    const liste = ansichtEntfernen('d1', 'v1');
    expect(liste.map((a) => a.id)).toEqual(['v2']);
  });

  it('lässt die Liste bei unbekannter id unverändert', () => {
    ansichtSpeichern('d1', 'A', zustand(), '2026-01-01T00:00:00.000Z', 'v1');
    const liste = ansichtEntfernen('d1', 'unbekannt');
    expect(liste.map((a) => a.id)).toEqual(['v1']);
  });
});

describe('sortiereAnsichten', () => {
  it('sortiert nach Name über localeCompare("de")', () => {
    const beta: Ansicht = { id: '2', name: 'Beta', ...zustand(), updatedAt: '2026-01-01T00:00:00.000Z' };
    const alpha: Ansicht = { id: '1', name: 'Alpha', ...zustand(), updatedAt: '2026-01-01T00:00:00.000Z' };
    expect(sortiereAnsichten([beta, alpha]).map((x) => x.id)).toEqual(['1', '2']);
  });

  it('sortiert bei Namensgleichheit nach updatedAt absteigend, danach nach id', () => {
    const gammaAlt: Ansicht = { id: 'z', name: 'Gamma', ...zustand(), updatedAt: '2026-01-01T00:00:00.000Z' };
    const gammaNeuA: Ansicht = { id: 'a', name: 'Gamma', ...zustand(), updatedAt: '2026-01-02T00:00:00.000Z' };
    const gammaNeuB: Ansicht = { id: 'b', name: 'Gamma', ...zustand(), updatedAt: '2026-01-02T00:00:00.000Z' };
    const sortiert = sortiereAnsichten([gammaAlt, gammaNeuB, gammaNeuA]);
    expect(sortiert.map((x) => x.id)).toEqual(['a', 'b', 'z']);
  });

  it('zweimaliges Sortieren derselben Liste ergibt dieselbe Reihenfolge', () => {
    const liste: Ansicht[] = [
      { id: '2', name: 'Beta', ...zustand(), updatedAt: '2026-01-01T00:00:00.000Z' },
      { id: '1', name: 'Alpha', ...zustand(), updatedAt: '2026-01-01T00:00:00.000Z' },
    ];
    const einmal = sortiereAnsichten(liste);
    const zweimal = sortiereAnsichten(einmal);
    expect(zweimal.map((x) => x.id)).toEqual(einmal.map((x) => x.id));
  });
});

describe('klemmeSkalierung', () => {
  it('klemmt auf den Bestandsbereich [0.15, 3] (Grenzen wortgleich zoomAt/zoomToFit)', () => {
    expect(klemmeSkalierung(0.149)).toBeCloseTo(0.15);
    expect(klemmeSkalierung(0.15)).toBe(0.15);
    expect(klemmeSkalierung(1)).toBe(1);
    expect(klemmeSkalierung(3)).toBe(3);
    expect(klemmeSkalierung(3.001)).toBe(3);
  });

  it('liefert 1 für nicht endliche Werte (NaN, Infinity)', () => {
    expect(klemmeSkalierung(NaN)).toBe(1);
    expect(klemmeSkalierung(Infinity)).toBe(1);
  });
});

describe('planeAnsichtAnwendung', () => {
  function docFixture(id: string, open = false): DesktopState['docs'][number] {
    return { id, fileId: `f-${id}`, name: id, position: { x: 0, y: 0 }, rotation: 0, zIndex: 1, open };
  }

  it('liefert fehlendeDocs 0 und eine leere Liste zuOeffnendeDocIds ohne openDocIds', () => {
    const state = emptyState();
    const ansicht: Ansicht = { id: 'v1', name: 'A', ...zustand(), updatedAt: 'x' };
    const plan = planeAnsichtAnwendung(state, ansicht);
    expect(plan.fehlendeDocs).toBe(0);
    expect(plan.zuOeffnendeDocIds).toEqual([]);
  });

  it('listet zwei vorhandene, geschlossene Dokumente in zuOeffnendeDocIds; fehlendeDocs bleibt 0', () => {
    const state: DesktopState = { ...emptyState(), docs: [docFixture('d1'), docFixture('d2')] };
    const ansicht: Ansicht = { id: 'v1', name: 'A', ...zustand({ openDocIds: ['d1', 'd2'] }), updatedAt: 'x' };
    const plan = planeAnsichtAnwendung(state, ansicht);
    expect(plan.zuOeffnendeDocIds.slice().sort()).toEqual(['d1', 'd2']);
    expect(plan.fehlendeDocs).toBe(0);
  });

  it('lässt bereits offene Dokumente aus zuOeffnendeDocIds aus (Idempotenz)', () => {
    const state: DesktopState = { ...emptyState(), docs: [docFixture('d1', true), docFixture('d2', false)] };
    const ansicht: Ansicht = { id: 'v1', name: 'A', ...zustand({ openDocIds: ['d1', 'd2'] }), updatedAt: 'x' };
    const plan = planeAnsichtAnwendung(state, ansicht);
    expect(plan.zuOeffnendeDocIds).toEqual(['d2']);
  });

  it('zählt gelöschte Dokumente als fehlendeDocs, plant die übrigen Bestandteile trotzdem', () => {
    const state = emptyState();
    const ansicht: Ansicht = {
      id: 'v1', name: 'A', ...zustand({ openDocIds: ['weg'], suchText: 'Kündigung', vp: { x: 5, y: 5, scale: 2 } }),
      updatedAt: 'x',
    };
    const plan = planeAnsichtAnwendung(state, ansicht);
    expect(plan.fehlendeDocs).toBe(1);
    expect(plan.suchText).toBe('Kündigung');
    expect(plan.vp).toEqual({ x: 5, y: 5, scale: 2 });
  });

  it('reduziert highlightedIds auf über findeObjekt auflösbare ids, ohne fehlendeDocs zu erhöhen', () => {
    const state: DesktopState = { ...emptyState(), docs: [docFixture('d1')] };
    const ansicht: Ansicht = { id: 'v1', name: 'A', ...zustand({ highlightedIds: ['d1', 'unbekannt'] }), updatedAt: 'x' };
    const plan = planeAnsichtAnwendung(state, ansicht);
    expect(plan.highlightedIds).toEqual(new Set(['d1']));
    expect(plan.fehlendeDocs).toBe(0);
  });

  it('reduziert visibleLayers auf dem Schreibtisch bekannte Ebenen-ids (vier Systemebenen plus state.layers)', () => {
    const state: DesktopState = { ...emptyState(), layers: [{ id: 'custom1', typ: 'custom', name: 'Eigene' }] };
    const ansicht: Ansicht = {
      id: 'v1', name: 'A', ...zustand({ visibleLayers: ['kanzlei', 'custom1', 'unbekannt'] }), updatedAt: 'x',
    };
    const plan = planeAnsichtAnwendung(state, ansicht);
    expect(plan.visibleLayers.slice().sort()).toEqual(['custom1', 'kanzlei']);
  });

  it('verändert weder den übergebenen State noch die übergebene Ansicht', () => {
    const state: DesktopState = { ...emptyState(), docs: [docFixture('d1')] };
    const ansicht: Ansicht = { id: 'v1', name: 'A', ...zustand({ openDocIds: ['d1'] }), updatedAt: 'x' };
    const stateKopie = JSON.parse(JSON.stringify(state)) as DesktopState;
    const ansichtKopie = JSON.parse(JSON.stringify(ansicht)) as Ansicht;
    planeAnsichtAnwendung(state, ansicht);
    expect(state).toEqual(stateKopie);
    expect(ansicht).toEqual(ansichtKopie);
  });

  it('liefert bei zwei Aufrufen mit demselben State und derselben Ansicht gleiche Werte (reine Funktion)', () => {
    const state: DesktopState = { ...emptyState(), docs: [docFixture('d1')] };
    const ansicht: Ansicht = { id: 'v1', name: 'A', ...zustand({ openDocIds: ['d1'] }), updatedAt: 'x' };
    const plan1 = planeAnsichtAnwendung(state, ansicht);
    const plan2 = planeAnsichtAnwendung(state, ansicht);
    expect(plan1.zuOeffnendeDocIds).toEqual(plan2.zuOeffnendeDocIds);
    expect(plan1.fehlendeDocs).toBe(plan2.fehlendeDocs);
    expect(plan1.highlightedIds).toEqual(plan2.highlightedIds);
    expect(plan1.vp).toEqual(plan2.vp);
  });
});
