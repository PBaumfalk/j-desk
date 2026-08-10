import { describe, expect, it } from 'vitest';
import { emptyState, type DesktopState } from './model';
import type { Ebene } from './layers';
import { VERSIONIERTE_ARTEN } from './stempel';
import { projectStateForActor, type ActorContext } from './projection';

const PRIVAT_A: Ebene = { id: 'privat-a', typ: 'privat', name: 'Privat (A)', ownerUserId: 'nutzer-a' };

const eigentuemerA: ActorContext = { userId: 'nutzer-a', rolle: 'Eigentümer' };
const bearbeiterB: ActorContext = { userId: 'nutzer-b', rolle: 'Bearbeiter' };

const GEHEIME_ID = 'geheimes-privates-objekt';
const GEHEIM_TEXT = 'Streng vertrauliche Notiz von Nutzer A';

/** Ein State mit genau EINEM privaten Objekt (Nutzer A) pro versionierter Art + einem Doc ohne layerId. */
function stateMitPrivatenObjekten(): DesktopState {
  const s = emptyState();
  return {
    ...s,
    layers: [PRIVAT_A],
    docs: [
      {
        id: GEHEIME_ID, fileId: 'f-privat', name: GEHEIM_TEXT,
        position: { x: 0, y: 0 }, rotation: 0, zIndex: 1, layerId: PRIVAT_A.id,
      },
      {
        id: 'oeffentliches-doc', fileId: 'f-oeffentlich', name: 'Öffentliches Dokument',
        position: { x: 10, y: 10 }, rotation: 0, zIndex: 2,
        // keine layerId — implizit Kanzlei
      },
    ],
    stacks: [
      {
        id: GEHEIME_ID, name: 'Privater Stapel', docIds: [], position: { x: 0, y: 0 }, zIndex: 1,
        layerId: PRIVAT_A.id,
      },
    ],
    links: [
      { id: GEHEIME_ID, fromId: 'a', toId: 'b', note: GEHEIM_TEXT, layerId: PRIVAT_A.id },
    ],
    strokes: [
      {
        id: GEHEIME_ID, docId: 'd1', page: 1, tool: 'pen', color: '#000', width: 2,
        points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], layerId: PRIVAT_A.id,
      },
    ],
    notes: [
      {
        id: GEHEIME_ID, kind: 'notiz', text: GEHEIM_TEXT, position: { x: 0, y: 0 }, zIndex: 1,
        layerId: PRIVAT_A.id,
      },
    ],
    cutouts: [
      {
        id: GEHEIME_ID, fileId: 'f1', page: 1, rect: { x: 0, y: 0, w: 1, h: 1 },
        position: { x: 0, y: 0 }, zIndex: 1, textSnapshot: GEHEIM_TEXT, layerId: PRIVAT_A.id,
      },
    ],
    marks: [
      {
        id: GEHEIME_ID, docId: 'd1', page: 1, rect: { x: 0, y: 0, w: 1, h: 1 }, kind: 'redact',
        textSnapshot: GEHEIM_TEXT, layerId: PRIVAT_A.id,
      },
    ],
    stamps: [
      {
        id: GEHEIME_ID, docId: 'd1', page: 1, x: 0, y: 0, angle: 0, text: GEHEIM_TEXT, color: 'red',
        baseW: 100, baseH: 100, layerId: PRIVAT_A.id,
      },
    ],
    flags: [
      { id: GEHEIME_ID, docId: 'd1', page: 1, offset: 0.5, color: '#f5c518', layerId: PRIVAT_A.id },
    ],
    clips: [
      { id: GEHEIME_ID, memberIds: ['d1', 'd2'], layerId: PRIVAT_A.id },
    ],
    legalObjects: [
      {
        id: GEHEIME_ID, kind: 'tatsache', text: GEHEIM_TEXT, position: { x: 0, y: 0 }, zIndex: 1,
        layerId: PRIVAT_A.id,
      },
    ],
    tables: [
      {
        id: GEHEIME_ID, titel: GEHEIM_TEXT, spalten: [], rows: [], position: { x: 0, y: 0 }, zIndex: 1,
        layerId: PRIVAT_A.id,
      },
    ],
    zeitleisten: [
      {
        id: GEHEIME_ID, titel: 'Zeitleiste', eintraege: [], position: { x: 0, y: 0 }, zIndex: 1,
        layerId: PRIVAT_A.id,
      },
    ],
    sitzungsmappen: [
      { id: GEHEIME_ID, titel: GEHEIM_TEXT, docIds: [], offeneFragen: [], layerId: PRIVAT_A.id },
    ],
    zones: [], // Zonen tragen kein layerId (U4-Gebot, 13-02) — sie können per Konstruktion
               // keine Privatobjekte sein; die leere Liste hält die generische Iteration unten
               // definiert, die Sichtbarkeitsfrage deckt der 13-02-Zonen-Projektionstest ab.
  } as DesktopState;
}

describe('projectStateForActor', () => {
  it('entfernt ein privates Fremdobjekt vollständig aus JEDER Objektliste', () => {
    const state = stateMitPrivatenObjekten();
    const projiziert = projectStateForActor(state, bearbeiterB);

    for (const art of VERSIONIERTE_ARTEN) {
      const liste = (projiziert as unknown as Record<string, { id: string }[] | undefined>)[art];
      expect(liste?.some((o) => o.id === GEHEIME_ID)).toBe(false);
    }
  });

  it('das private Objekt taucht nicht einmal im rohen JSON auf (PERM-05-Kern)', () => {
    const state = stateMitPrivatenObjekten();
    const projiziert = projectStateForActor(state, bearbeiterB);
    const json = JSON.stringify(projiziert);

    expect(json).not.toContain(GEHEIME_ID);
    expect(json).not.toContain(GEHEIM_TEXT);
  });

  it('der Eigentümer der privaten Ebene sieht seine eigenen Objekte', () => {
    const state = stateMitPrivatenObjekten();
    const projiziert = projectStateForActor(state, eigentuemerA);

    for (const art of VERSIONIERTE_ARTEN) {
      // zones (13-02): keine Privatobjekte möglich — das Fixture trägt eine leere Liste;
      // die Zonen-Sichtbarkeit für alle Rollen beweist der eigene 13-02-Projektionstest.
      if (art === 'zones') continue;
      const liste = (projiziert as unknown as Record<string, { id: string }[] | undefined>)[art];
      expect(liste?.some((o) => o.id === GEHEIME_ID)).toBe(true);
    }
  });

  it('ein Objekt ohne layerId bleibt für jeden Betrachter erhalten (implizit Kanzlei)', () => {
    const state = stateMitPrivatenObjekten();
    const projiziert = projectStateForActor(state, bearbeiterB);
    expect(projiziert.docs.some((d) => d.id === 'oeffentliches-doc')).toBe(true);
  });

  it('deckt alle VERSIONIERTE_ARTEN ab', () => {
    expect(VERSIONIERTE_ARTEN).toEqual([
      'docs', 'stacks', 'links', 'strokes', 'notes', 'cutouts', 'marks', 'stamps', 'flags', 'clips',
      'legalObjects', 'tables', 'zeitleisten', 'sitzungsmappen', 'zones',
    ]);
  });

  it('referenzielle Identität: nichts gefiltert => derselbe State-Bezug', () => {
    const state = stateMitPrivatenObjekten();
    const projiziert = projectStateForActor(state, eigentuemerA);
    expect(projiziert).toBe(state);
  });

  it('CR-02: Papierkorb-Eintrag mit privatem Inhalt fehlt komplett bei fremden Betrachtern (kein Platzhalter)', () => {
    const s = emptyState();
    const state = {
      ...s,
      layers: [PRIVAT_A],
      trash: [
        {
          id: 'korb-privat', kind: 'doc', name: GEHEIM_TEXT, trashedAt: '2026-07-01T00:00:00Z',
          payload: {
            docs: [{
              id: 'd-privat', fileId: 'f-privat', name: GEHEIM_TEXT,
              position: { x: 0, y: 0 }, rotation: 0, zIndex: 1, layerId: PRIVAT_A.id,
            }],
            notes: [], cutouts: [], stacks: [], strokes: [], marks: [], stamps: [], flags: [],
          },
        },
        {
          id: 'korb-oeffentlich', kind: 'note', name: 'Öffentlicher Zettel', trashedAt: '2026-07-01T00:00:00Z',
          payload: {
            docs: [],
            notes: [{ id: 'n-1', kind: 'notiz', text: 'sichtbar', position: { x: 0, y: 0 }, zIndex: 1 }],
            cutouts: [], stacks: [], strokes: [], marks: [], stamps: [], flags: [],
          },
        },
      ],
    } as unknown as DesktopState;

    const projiziert = projectStateForActor(state, bearbeiterB);
    const korbIds = (projiziert.trash ?? []).map((t) => t.id);
    expect(korbIds).not.toContain('korb-privat');
    expect(korbIds).toContain('korb-oeffentlich');
    // PERM-05-Kern: der Inhalt taucht nicht einmal im rohen JSON auf.
    expect(JSON.stringify(projiziert)).not.toContain(GEHEIM_TEXT);

    // Der Eigentümer der privaten Ebene sieht beide Einträge weiterhin.
    const projiziertA = projectStateForActor(state, eigentuemerA);
    expect((projiziertA.trash ?? []).map((t) => t.id)).toEqual(['korb-privat', 'korb-oeffentlich']);
  });

  it('CR-02: gemischter Korb-Eintrag (sichtbar + privat) fällt komplett — keine Teil-Auslieferung', () => {
    const s = emptyState();
    const state = {
      ...s,
      layers: [PRIVAT_A],
      trash: [
        {
          id: 'korb-gemischt', kind: 'stack', name: 'Stapel', trashedAt: '2026-07-01T00:00:00Z',
          payload: {
            docs: [
              { id: 'd-oeff', fileId: 'f1', name: 'sichtbar', position: { x: 0, y: 0 }, rotation: 0, zIndex: 1 },
              {
                id: 'd-priv', fileId: 'f2', name: GEHEIM_TEXT,
                position: { x: 1, y: 1 }, rotation: 0, zIndex: 2, layerId: PRIVAT_A.id,
              },
            ],
            notes: [], cutouts: [], stacks: [], strokes: [], marks: [], stamps: [], flags: [],
          },
        },
      ],
    } as unknown as DesktopState;

    const projiziert = projectStateForActor(state, bearbeiterB);
    expect(projiziert.trash ?? []).toEqual([]);
    expect(JSON.stringify(projiziert)).not.toContain(GEHEIM_TEXT);
  });
});

describe('projectStateForActor: mandant-Stufe (EXP-03, D-06)', () => {
  const gast: ActorContext = { userId: 'gast-x', rolle: 'externer Gast' };
  const MANDANT_TEXT = 'Mandanten-sichtbare Aktennotiz';
  const INTERN_TEXT = 'INTERN-GEHEIM-4d7a';

  /** Vier Notizen: mandant-Override, intern-Override, Kanzlei-Default (kein Override), exportierbar-Ebene. */
  function stateMitFreigaben(): DesktopState {
    const s = emptyState();
    return {
      ...s,
      notes: [
        { id: 'n-mandant', kind: 'notiz', text: MANDANT_TEXT, position: { x: 0, y: 0 }, zIndex: 1, freigabe: 'mandant' },
        { id: 'n-intern-override', kind: 'notiz', text: INTERN_TEXT, position: { x: 1, y: 0 }, zIndex: 2, freigabe: 'intern' },
        { id: 'n-kanzlei-default', kind: 'notiz', text: INTERN_TEXT, position: { x: 2, y: 0 }, zIndex: 3 },
        { id: 'n-export-ebene', kind: 'notiz', text: 'exportierbarer Inhalt', position: { x: 3, y: 0 }, zIndex: 4, layerId: 'exportierbar' },
      ],
    } as DesktopState;
  }

  it('externer Gast sieht mandant-Override, aber kein intern (Override oder Kanzlei-Default)', () => {
    const projiziert = projectStateForActor(stateMitFreigaben(), gast);
    const ids = (projiziert.notes ?? []).map((n) => n.id);
    expect(ids).toContain('n-mandant');
    expect(ids).not.toContain('n-intern-override');
    expect(ids).not.toContain('n-kanzlei-default');
    // D-06: interne Inhalte fehlen komplett — kein Platzhalter, keine Metadaten.
    expect(JSON.stringify(projiziert)).not.toContain(INTERN_TEXT);
  });

  it("externer Gast sieht Objekte auf 'exportierbar'-Ebene ohne Override (Ebenen-Default 'export')", () => {
    const projiziert = projectStateForActor(stateMitFreigaben(), gast);
    expect((projiziert.notes ?? []).some((n) => n.id === 'n-export-ebene')).toBe(true);
  });

  it('externer Gast: Korb-Eintrag mit gemischter Payload (ein internes Objekt) fällt komplett', () => {
    const s = emptyState();
    const state = {
      ...s,
      trash: [
        {
          id: 'korb-gemischt', kind: 'stack', name: 'Stapel', trashedAt: '2026-07-01T00:00:00Z',
          payload: {
            docs: [
              { id: 'd-mandant', fileId: 'f1', name: 'sichtbar', position: { x: 0, y: 0 }, rotation: 0, zIndex: 1, freigabe: 'mandant' },
              { id: 'd-intern', fileId: 'f2', name: INTERN_TEXT, position: { x: 1, y: 1 }, rotation: 0, zIndex: 2 },
            ],
            notes: [], cutouts: [], stacks: [], strokes: [], marks: [], stamps: [], flags: [],
          },
        },
        {
          id: 'korb-mandant', kind: 'note', name: MANDANT_TEXT, trashedAt: '2026-07-01T00:00:00Z',
          payload: {
            docs: [],
            notes: [{ id: 'n-1', kind: 'notiz', text: MANDANT_TEXT, position: { x: 0, y: 0 }, zIndex: 1, freigabe: 'mandant' }],
            cutouts: [], stacks: [], strokes: [], marks: [], stamps: [], flags: [],
          },
        },
      ],
    } as unknown as DesktopState;

    const projiziert = projectStateForActor(state, gast);
    const korbIds = (projiziert.trash ?? []).map((t) => t.id);
    expect(korbIds).not.toContain('korb-gemischt');
    expect(korbIds).toContain('korb-mandant');
    expect(JSON.stringify(projiziert)).not.toContain(INTERN_TEXT);
  });

  it('alle Nicht-Gast-Rollen sehen interne Objekte weiterhin (kein stiller Verhaltenswechsel, T-03-02-03)', () => {
    const rollen: ActorContext[] = [
      { userId: 'u-e', rolle: 'Eigentümer' },
      { userId: 'u-b', rolle: 'Bearbeiter' },
      { userId: 'u-k', rolle: 'Kommentator' },
      { userId: 'u-n', rolle: 'Nur-Lesen' },
    ];
    for (const ctx of rollen) {
      const state = stateMitFreigaben();
      const projiziert = projectStateForActor(state, ctx);
      const ids = (projiziert.notes ?? []).map((n) => n.id);
      expect(ids).toEqual(['n-mandant', 'n-intern-override', 'n-kanzlei-default', 'n-export-ebene']);
      // Referenzidentität: nichts zu filtern => derselbe State-Bezug (geaendert-Konvention).
      expect(projiziert).toBe(state);
    }
  });
});

describe('13-02: Zonen und extern-Markierung in der Projektion (U4/U3)', () => {
  const mitgliedsRollen: ActorContext[] = [
    { userId: 'u-e', rolle: 'Eigentümer' },
    { userId: 'u-b', rolle: 'Bearbeiter' },
    { userId: 'u-k', rolle: 'Kommentator' },
    { userId: 'u-n', rolle: 'Nur-Lesen' },
  ];

  it('liefert Zonen für alle vier Desk-Mitglieder-Rollen vollständig aus (kein layerId → keine Filterung; geteilte Orientierung, T-13-02-01)', () => {
    const state = {
      ...emptyState(),
      zones: [
        { id: 'z1', name: 'Beweiswürdigung', rect: { x: 0, y: 0, w: 100, h: 100 } },
        { id: 'z2', name: 'Vorbereitung', rect: { x: 200, y: 0, w: 100, h: 100 } },
      ],
    } as DesktopState;

    for (const ctx of mitgliedsRollen) {
      const projiziert = projectStateForActor(state, ctx);
      expect((projiziert.zones ?? []).map((z) => z.id), `Rolle ${ctx.rolle}`).toEqual(['z1', 'z2']);
      // Nichts zu filtern (kein layerId, keine Fremd-Privat-Ebenen im Fixture) => Referenzidentität.
      expect(projiziert, `Rolle ${ctx.rolle}`).toBe(state);
    }
  });

  it('eine extern-markierte Notiz auf der Privat-Ebene von A fehlt bei B komplett — extern ändert nichts an den Sichtregeln (EXT-01/edge, T-13-02-05)', () => {
    const state = {
      ...emptyState(),
      layers: [PRIVAT_A],
      notes: [
        {
          id: 'n-ext-privat', kind: 'notiz', text: 'externe Privat-Referenz', position: { x: 0, y: 0 }, zIndex: 1,
          layerId: PRIVAT_A.id, extern: { art: 'urteil', quelle: 'BGH, VI ZR 1/23' },
        },
        {
          id: 'n-ext-offen', kind: 'notiz', text: 'externe öffentliche Referenz', position: { x: 1, y: 1 }, zIndex: 2,
          extern: { art: 'weblink', url: 'https://beispiel.de/x' },
        },
      ],
    } as DesktopState;

    const projiziert = projectStateForActor(state, bearbeiterB);
    const ids = (projiziert.notes ?? []).map((n) => n.id);
    expect(ids).not.toContain('n-ext-privat');
    expect(ids).toContain('n-ext-offen'); // die Markierung selbst ändert die Sichtbarkeit nicht
    expect(JSON.stringify(projiziert)).not.toContain('BGH, VI ZR 1/23');

    // Positivkontrolle: der Ebenen-Eigentümer sieht beide Notizen.
    expect((projectStateForActor(state, eigentuemerA).notes ?? [])).toHaveLength(2);
  });
});

describe('projectStateForActor: state.layers-Filter (02-09, T-02-09-01 — keine Andeutung privater Ebenen anderer)', () => {  const PRIVAT_B: Ebene = { id: 'privat-nutzer-b', typ: 'privat', name: 'Privat', ownerUserId: 'nutzer-b' };
  const CUSTOM: Ebene = { id: 'custom-1', typ: 'custom', name: 'Notizen von A' };

  it('entfernt fremde Privat-Instanzen aus state.layers — die eigene Instanz und custom-Ebenen bleiben', () => {
    const state = { ...stateMitPrivatenObjekten(), layers: [PRIVAT_A, PRIVAT_B, CUSTOM] };
    const projiziert = projectStateForActor(state, bearbeiterB);
    const ids = (projiziert.layers ?? []).map((e) => e.id);
    expect(ids).not.toContain(PRIVAT_A.id);
    expect(ids).toContain(PRIVAT_B.id);
    expect(ids).toContain(CUSTOM.id);
  });

  it('fremde Instanz-id und ownerUserId tauchen im rohen JSON der Projektion nicht auf', () => {
    const state = { ...stateMitPrivatenObjekten(), layers: [PRIVAT_A, PRIVAT_B] };
    const json = JSON.stringify(projectStateForActor(state, bearbeiterB).layers);
    expect(json).not.toContain(PRIVAT_A.id);
    expect(json).not.toContain('nutzer-a');
  });

  it('der Eigentümer sieht seine eigene Instanz weiterhin; Instanzen DRITTER bleiben auch fuer ihn gefiltert', () => {
    const dritter: Ebene = { id: 'privat-nutzer-c', typ: 'privat', name: 'Privat', ownerUserId: 'nutzer-c' };
    const state = { ...stateMitPrivatenObjekten(), layers: [PRIVAT_A, dritter] };
    const projiziert = projectStateForActor(state, eigentuemerA);
    expect((projiziert.layers ?? []).map((e) => e.id)).toEqual([PRIVAT_A.id]);
  });

  it('nichts zu filtern (nur eigene/custom-Ebenen) => unveraenderter State-Bezug', () => {
    const state = { ...emptyState(), layers: [PRIVAT_A, CUSTOM] };
    expect(projectStateForActor(state, eigentuemerA)).toBe(state);
  });
});
