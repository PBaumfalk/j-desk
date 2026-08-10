import { describe, expect, it } from 'vitest';
import { emptyState, type DesktopState } from './model';
import type { Ebene } from './layers';
import { applyCommand, CommandError } from './commands';
import { zielObjektIdsFuerCommand } from './objektbezug';
import { ALLE_FREIGABEN, effektiveFreigabe, freigabeFilter, type Freigabe } from './freigabe';

/**
 * Freigabe-Kernmodell (EXP-03): effektiveFreigabe (Ebenen-Default + Override, fail-closed
 * nach D-14) und freigabeFilter (lautloses Entfernen nicht-freigegebener Objekte, D-08).
 * Die Test-Marker stehen bewusst auf System-Ebenen-Ids — die Exportkette darf sich nie
 * auf Client-mitgeschickte Stufen verlassen.
 */

describe('ALLE_FREIGABEN', () => {
  it('enthält genau die drei Stufen in kanonischer Reihenfolge', () => {
    expect(ALLE_FREIGABEN).toEqual(['intern', 'mandant', 'export']);
  });
});

describe('effektiveFreigabe', () => {
  it('Objekt auf der System-Ebene exportierbar (Flag exportierbar: true) ⇒ export', () => {
    expect(effektiveFreigabe({ layerId: 'exportierbar' })).toBe('export');
  });

  it('Objekt auf der Kanzlei-Ebene ⇒ intern (Ebenen-Default)', () => {
    expect(effektiveFreigabe({ layerId: 'kanzlei' })).toBe('intern');
  });

  it('benutzerdefinierte Ebene mit exportierbar-Flag ⇒ export (Flag zählt, nicht nur der Typ)', () => {
    const layers: Ebene[] = [{ id: 'freigabe-runde', typ: 'custom', name: 'Freigaberunde', exportierbar: true }];
    expect(effektiveFreigabe({ layerId: 'freigabe-runde' }, layers)).toBe('export');
  });

  it('benutzerdefinierte Ebene ohne exportierbar-Flag ⇒ intern', () => {
    const layers: Ebene[] = [{ id: 'notizen-yvonne', typ: 'custom', name: 'Notizen von Yvonne' }];
    expect(effektiveFreigabe({ layerId: 'notizen-yvonne' }, layers)).toBe('intern');
  });

  it('Override am Objekt schlägt jede Ebene (export auf der Kanzlei-Ebene)', () => {
    expect(effektiveFreigabe({ layerId: 'kanzlei', freigabe: 'export' })).toBe('export');
  });

  it('Override am Objekt schlägt auch die exportierbare Ebene (intern auf exportierbar)', () => {
    expect(effektiveFreigabe({ layerId: 'exportierbar', freigabe: 'intern' })).toBe('intern');
  });

  it('Override mandant gewinnt ebenfalls über den Ebenen-Default', () => {
    expect(effektiveFreigabe({ layerId: 'exportierbar', freigabe: 'mandant' })).toBe('mandant');
  });

  it('fail-closed (D-14): Objekt ohne freigabe auf unbekannter Ebene ⇒ intern', () => {
    expect(effektiveFreigabe({ layerId: 'gibts-nicht' })).toBe('intern');
  });

  it('fail-closed (D-14): Objekt ohne layerId und ohne freigabe ⇒ intern', () => {
    expect(effektiveFreigabe({})).toBe('intern');
  });
});

/** Ein Objekt je versionierter Art auf der exportierbaren Ebene plus ein nicht-freigegebenes Gegenstück. */
function stateMitAllenArten(): DesktopState {
  return {
    ...emptyState(),
    docs: [
      { id: 'd-export', fileId: 'f1', name: 'a.pdf', position: { x: 0, y: 0 }, rotation: 0, zIndex: 1, layerId: 'exportierbar' },
      { id: 'd-intern', fileId: 'f2', name: 'b.pdf', position: { x: 0, y: 0 }, rotation: 0, zIndex: 2, layerId: 'kanzlei' },
    ],
    stacks: [
      { id: 's-export', name: 'Stapel', docIds: [], position: { x: 0, y: 0 }, zIndex: 3, layerId: 'exportierbar' },
      { id: 's-mandant', name: 'Stapel', docIds: [], position: { x: 0, y: 0 }, zIndex: 4, freigabe: 'mandant' },
    ],
    links: [
      { id: 'l-export', fromId: 'd-export', toId: 'd-export', note: '', layerId: 'exportierbar' },
      { id: 'l-intern', fromId: 'd-export', toId: 'd-export', note: '' },
    ],
    strokes: [
      { id: 'str-export', docId: 'd-export', page: 1, tool: 'pen', color: '#000000', width: 1, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], layerId: 'exportierbar' },
      { id: 'str-intern', docId: 'd-export', page: 1, tool: 'pen', color: '#000000', width: 1, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
    ],
    notes: [
      { id: 'n-export', kind: 'todo', text: 'Aufgabe', position: { x: 0, y: 0 }, zIndex: 5, layerId: 'exportierbar' },
      { id: 'n-intern', kind: 'notiz', text: 'intern', position: { x: 0, y: 0 }, zIndex: 6 },
    ],
    cutouts: [
      { id: 'c-export', fileId: 'f1', page: 1, rect: { x: 0, y: 0, w: 10, h: 10 }, position: { x: 0, y: 0 }, zIndex: 7, layerId: 'exportierbar' },
      { id: 'c-intern', fileId: 'f1', page: 1, rect: { x: 0, y: 0, w: 10, h: 10 }, position: { x: 0, y: 0 }, zIndex: 8 },
    ],
    marks: [
      { id: 'm-export', docId: 'd-export', page: 1, rect: { x: 0, y: 0, w: 10, h: 10 }, kind: 'redact', layerId: 'exportierbar' },
      { id: 'm-intern', docId: 'd-export', page: 1, rect: { x: 0, y: 0, w: 10, h: 10 }, kind: 'tippex' },
    ],
    stamps: [
      { id: 'st-export', docId: 'd-export', page: 1, x: 0, y: 0, angle: 0, text: 'WICHTIG', color: 'red', baseW: 100, baseH: 100, layerId: 'exportierbar' },
      { id: 'st-intern', docId: 'd-export', page: 1, x: 0, y: 0, angle: 0, text: 'EINGANG', color: 'blue', baseW: 100, baseH: 100 },
    ],
    flags: [
      { id: 'f-export', docId: 'd-export', page: 1, offset: 0.5, color: '#f5c518', layerId: 'exportierbar' },
      { id: 'f-intern', docId: 'd-export', page: 1, offset: 0.5, color: '#f5c518' },
    ],
    clips: [
      { id: 'cl-export', memberIds: ['d-export'], layerId: 'exportierbar' },
      { id: 'cl-intern', memberIds: ['d-export'] },
    ],
  };
}

describe('freigabeFilter', () => {
  it('entfernt interne und mandanten Objekte lautlos aus allen VERSIONIERTE_ARTEN', () => {
    const gefiltert = freigabeFilter(stateMitAllenArten());
    expect(gefiltert.docs.map((d) => d.id)).toEqual(['d-export']);
    expect(gefiltert.stacks.map((s) => s.id)).toEqual(['s-export']);
    expect(gefiltert.links.map((l) => l.id)).toEqual(['l-export']);
    expect(gefiltert.strokes?.map((s) => s.id)).toEqual(['str-export']);
    expect(gefiltert.notes?.map((n) => n.id)).toEqual(['n-export']);
    expect(gefiltert.cutouts?.map((c) => c.id)).toEqual(['c-export']);
    expect(gefiltert.marks?.map((m) => m.id)).toEqual(['m-export']);
    expect(gefiltert.stamps?.map((s) => s.id)).toEqual(['st-export']);
    expect(gefiltert.flags?.map((f) => f.id)).toEqual(['f-export']);
    expect(gefiltert.clips?.map((c) => c.id)).toEqual(['cl-export']);
  });

  it('Papierkorb-Eintrag bleibt nur, wenn seine gesamte Payload freigegeben ist (kein Platzhalter, D-08)', () => {
    const leer = { docs: [], notes: [], cutouts: [], stacks: [], strokes: [], marks: [], stamps: [], flags: [] };
    const zettel = (id: string, layerId?: string, freigabe?: Freigabe) => ({
      id, kind: 'notiz' as const, text: id, position: { x: 0, y: 0 }, zIndex: 1,
      ...(layerId !== undefined ? { layerId } : {}),
      ...(freigabe !== undefined ? { freigabe } : {}),
    });
    const state: DesktopState = {
      ...emptyState(),
      trash: [
        { id: 't-frei', kind: 'note', name: 'x', trashedAt: '2026-01-01T00:00:00.000Z',
          payload: { ...leer, notes: [zettel('n-frei', 'exportierbar')] } },
        { id: 't-gemischt', kind: 'note', name: 'x', trashedAt: '2026-01-01T00:00:00.000Z',
          payload: { ...leer, notes: [zettel('n-frei2', 'exportierbar'), zettel('n-geheim')] } },
      ],
    };
    const gefiltert = freigabeFilter(state);
    expect(gefiltert.trash?.map((t) => t.id)).toEqual(['t-frei']);
  });

  it('gibt bei nichts zu Filtern denselben State-Bezug zurück (geaendert-Konvention)', () => {
    const state: DesktopState = {
      ...emptyState(),
      notes: [{ id: 'n', kind: 'notiz', text: 'x', position: { x: 0, y: 0 }, zIndex: 1, layerId: 'exportierbar' }],
    };
    expect(freigabeFilter(state)).toBe(state);
  });

  it('reicht das layers-Array unverändert durch (Referenzidentität)', () => {
    const layers: Ebene[] = [{ id: 'privat-a', typ: 'privat', name: 'Privat', ownerUserId: 'a' }];
    const state: DesktopState = {
      ...emptyState(),
      layers,
      notes: [{ id: 'n', kind: 'notiz', text: 'x', position: { x: 0, y: 0 }, zIndex: 1 }],
    };
    const gefiltert = freigabeFilter(state);
    expect(gefiltert.layers).toBe(layers);
  });
});

describe('setFreigabe-Command (EXP-03, D-05)', () => {
  const stateMitNotiz = (): DesktopState => ({
    ...emptyState(),
    notes: [{ id: 'n1', kind: 'notiz', text: 'x', position: { x: 0, y: 0 }, zIndex: 1 }],
  });

  it('setzt eine gültige Stufe als Override am Objekt', () => {
    const state = stateMitNotiz();
    const neu = applyCommand(state, { type: 'setFreigabe', payload: { objectId: 'n1', freigabe: 'export' } });
    expect(neu.notes?.[0]?.freigabe).toBe('export');
    // Referenzidentität des unangetasteten Rests bleibt (Strukturteilung, Stempel-Wächter).
    expect(neu.docs).toBe(state.docs);
  });

  it('wirft bei unbekanntem Objekt (kein stiller No-Op)', () => {
    expect(() =>
      applyCommand(stateMitNotiz(), { type: 'setFreigabe', payload: { objectId: 'gibts-nicht', freigabe: 'export' } }),
    ).toThrow(CommandError);
  });

  it('wirft bei ungültiger Stufe als CommandError mit deutschem Feldnamen', () => {
    const ausfuehren = () =>
      applyCommand(stateMitNotiz(), { type: 'setFreigabe', payload: { objectId: 'n1', freigabe: 'oeffentlich' } });
    expect(ausfuehren).toThrow(CommandError);
    expect(ausfuehren).toThrow(/freigabe/);
  });

  it('zielObjektIdsFuerCommand liefert die objectId (die Privat-Ebenen-Prüfung greift)', () => {
    expect(zielObjektIdsFuerCommand({ type: 'setFreigabe', payload: { objectId: 'n1', freigabe: 'export' } })).toEqual(['n1']);
  });
});
