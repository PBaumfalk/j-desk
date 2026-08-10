import { describe, expect, it } from 'vitest';
import { CommandError, type Command } from './commands';
import { GENEHMIGUNGS_FAEHIGE_ARTEN, vorschlagAnwenden } from './vorschlagAnwenden';
import type { Vorschlag } from './vorschlag';

function vorschlag(ueberschreibungen: Partial<Vorschlag> = {}): Vorschlag {
  return {
    id: 'v1',
    deskId: 'desk1',
    art: 'addNote',
    payload: { id: 'n-ki-1', kind: 'notiz', text: 'Fundstelle prüfen', position: { x: 10, y: 20 } },
    quellen: [],
    zusammenfassung: 'Notiz anlegen',
    status: 'ausstehend',
    createdBy: 'ki-agent',
    createdAt: 1000,
    ...ueberschreibungen,
  };
}

/** Die 19 genehmigungsfähigen arten (12-04) — sortiert, wie die Konstante sie halten soll. */
const ERWARTETE_ARTEN = [
  'addClip', 'addFlag', 'addLink', 'addNote', 'addStamp', 'dissolveStack', 'editNote',
  'extractPage', 'moveDoc', 'moveStack', 'removeFromStack', 'renameStack', 'restoreObject',
  'setLinkNote', 'setNoteDone', 'stackDocs', 'stapleStack', 'trashObject', 'unstapleStack',
];

/**
 * Ausschlussliste als Literalmenge — bewusst KEINE neue Konstante im Produktivcode: der
 * Server führt seine LOESCH_COMMANDS/SCHREDDER_COMMANDS bereits (packages/server/src/app.ts:131-150),
 * core bleibt davon frei. Dieser Test spiegelt die Liste, damit eine Server-Erweiterung hier
 * auffällt, sobald eine endgültige Lösch-art versehentlich genehmigungsfähig würde.
 */
const ENDGUELTIGE_LOESCH_ARTEN = [
  'removeDoc', 'removeLink', 'removeStack', 'removeStroke', 'removeNote', 'removeCutout',
  'removeMark', 'removeStamp', 'removeFlag', 'removeClip', 'removeLegalObject', 'removeTable',
  'removeSitzungsmappe', 'removeZeitleiste', 'shredTrashItem', 'emptyTrash',
];

describe('vorschlagAnwenden', () => {
  it('bildet einen addNote-Vorschlag auf genau ein addNote-Command mit den Register-Nutzdaten ab', () => {
    expect(vorschlagAnwenden(vorschlag())).toEqual([
      { type: 'addNote', payload: { id: 'n-ki-1', kind: 'notiz', text: 'Fundstelle prüfen', position: { x: 10, y: 20 } } },
    ]);
  });

  it('vergibt eine serverseitige id, wenn payload.id fehlt (optId-Fallback)', () => {
    const v = vorschlag({ payload: { kind: 'notiz', text: 't', position: { x: 0, y: 0 } } });
    const kommandos = vorschlagAnwenden(v);

    expect(kommandos).toHaveLength(1);
    const payload = kommandos[0].payload as { id: unknown };
    expect(typeof payload.id).toBe('string');
    expect((payload.id as string).length).toBeGreaterThan(0);
  });

  it('wirft einen benannten Fehler bei einer art ohne hinterlegte Abbildung (Mengenbegrenzung)', () => {
    expect(() => vorschlagAnwenden(vorschlag({ art: 'removeDoc', payload: { id: 'd1' } })))
      .toThrow('Keine Genehmigungs-Abbildung definiert für: removeDoc');
  });

  it('wirft CommandError bei fehlendem oder nicht-textuellem text-Feld', () => {
    expect(() => vorschlagAnwenden(vorschlag({ payload: { kind: 'notiz', position: { x: 0, y: 0 } } })))
      .toThrow(CommandError);
  });

  it('wirft CommandError bei fehlender Position', () => {
    expect(() => vorschlagAnwenden(vorschlag({ payload: { kind: 'notiz', text: 't' } })))
      .toThrow(CommandError);
  });

  it('GENEHMIGUNGS_FAEHIGE_ARTEN enthält genau die 19 genehmigungsfähigen arten (sortierte Array-Gleichheit)', () => {
    expect([...GENEHMIGUNGS_FAEHIGE_ARTEN]).toEqual(ERWARTETE_ARTEN);
    // Sortierung ist Vertrag (deterministische Whitelist-Prüfung/Diffbarkeit).
    expect([...GENEHMIGUNGS_FAEHIGE_ARTEN].sort()).toEqual([...GENEHMIGUNGS_FAEHIGE_ARTEN]);
  });

  it('KEINE endgültige Lösch-/Schredder-art ist genehmigungsfähig (KI räumt über den Papierkorb auf)', () => {
    for (const art of ENDGUELTIGE_LOESCH_ARTEN) {
      expect(GENEHMIGUNGS_FAEHIGE_ARTEN).not.toContain(art);
    }
  });

  describe('Abbildung aller 19 arten (Tabellen-Test: art → erwartete Command-Liste)', () => {
    const faelle: { art: string; payload: Record<string, unknown>; erwartet: Command[] }[] = [
      { art: 'moveDoc', payload: { id: 'd1', position: { x: 1, y: 2 } },
        erwartet: [{ type: 'moveDoc', payload: { id: 'd1', position: { x: 1, y: 2 } } }] },
      { art: 'stackDocs', payload: { draggedId: 'd1', targetId: 'd2', id: 'st1' },
        erwartet: [{ type: 'stackDocs', payload: { draggedId: 'd1', targetId: 'd2', id: 'st1' } }] },
      { art: 'removeFromStack', payload: { docId: 'd1', position: { x: 3, y: 4 } },
        erwartet: [{ type: 'removeFromStack', payload: { docId: 'd1', position: { x: 3, y: 4 } } }] },
      { art: 'dissolveStack', payload: { stackId: 'st1' },
        erwartet: [{ type: 'dissolveStack', payload: { stackId: 'st1' } }] },
      { art: 'renameStack', payload: { stackId: 'st1', name: 'Klage' },
        erwartet: [{ type: 'renameStack', payload: { stackId: 'st1', name: 'Klage' } }] },
      { art: 'moveStack', payload: { stackId: 'st1', position: { x: 5, y: 6 } },
        erwartet: [{ type: 'moveStack', payload: { stackId: 'st1', position: { x: 5, y: 6 } } }] },
      { art: 'addLink', payload: { fromId: 'd1', toId: 'd2', id: 'l1' },
        erwartet: [{ type: 'addLink', payload: { fromId: 'd1', toId: 'd2', id: 'l1' } }] },
      { art: 'addNote', payload: { id: 'n1', kind: 'notiz', text: 't', position: { x: 0, y: 0 } },
        erwartet: [{ type: 'addNote', payload: { id: 'n1', kind: 'notiz', text: 't', position: { x: 0, y: 0 } } }] },
      { art: 'editNote', payload: { id: 'n1', text: 'neuer Text' },
        erwartet: [{ type: 'editNote', payload: { id: 'n1', text: 'neuer Text' } }] },
      { art: 'addStamp', payload: { docId: 'd1', page: 1, x: 10, y: 20, angle: 5, text: 'GEPRÜFT', color: 'blue', baseW: 595, baseH: 842, id: 'st1' },
        erwartet: [{ type: 'addStamp', payload: { stamp: { id: 'st1', docId: 'd1', page: 1, x: 10, y: 20, angle: 5, text: 'GEPRÜFT', color: 'blue', baseW: 595, baseH: 842 } } }] },
      { art: 'addFlag', payload: { docId: 'd1', page: 2, offset: 0.4, color: '#f5c518', id: 'f1', label: 'wichtig' },
        erwartet: [{ type: 'addFlag', payload: { flag: { id: 'f1', docId: 'd1', page: 2, offset: 0.4, color: '#f5c518', label: 'wichtig' } } }] },
      { art: 'stapleStack', payload: { stackId: 'st1' },
        erwartet: [{ type: 'stapleStack', payload: { stackId: 'st1' } }] },
      { art: 'unstapleStack', payload: { stackId: 'st1' },
        erwartet: [{ type: 'unstapleStack', payload: { stackId: 'st1' } }] },
      { art: 'addClip', payload: { aId: 'd1', bId: 'n1', id: 'c1' },
        erwartet: [{ type: 'addClip', payload: { aId: 'd1', bId: 'n1', id: 'c1' } }] },
      { art: 'trashObject', payload: { objectId: 'd1', trashId: 'tr1' },
        erwartet: [{ type: 'trashObject', payload: { id: 'd1', trashId: 'tr1', trashedAt: expect.any(String) } }] },
      { art: 'restoreObject', payload: { trashId: 'tr1' },
        erwartet: [{ type: 'restoreObject', payload: { trashId: 'tr1' } }] },
      { art: 'setNoteDone', payload: { id: 'n1', done: true },
        erwartet: [{ type: 'setNoteDone', payload: { id: 'n1', done: true } }] },
      { art: 'extractPage', payload: { docId: 'd1', page: 3, position: { x: 7, y: 8 }, id: 'd9' },
        erwartet: [{ type: 'extractPage', payload: { docId: 'd1', page: 3, position: { x: 7, y: 8 }, id: 'd9' } }] },
      { art: 'setLinkNote', payload: { linkId: 'l1', note: 'Beleg' },
        erwartet: [{ type: 'setLinkNote', payload: { linkId: 'l1', note: 'Beleg' } }] },
    ];

    it.each(faelle)('$art erzeugt aus einer Minimal-Eingabe die erwartete Command-Liste', ({ art, payload, erwartet }) => {
      expect(vorschlagAnwenden(vorschlag({ art, payload }))).toEqual(erwartet);
    });

    it('deckt alle 19 arten ab (kein Fall ohne Tabellen-Zeile)', () => {
      expect(faelle.map((f) => f.art).sort()).toEqual(ERWARTETE_ARTEN);
    });
  });

  it('trashObject generiert eine trashId vorab, wenn der Vorschlag keine trägt (Inversen-Pflicht)', () => {
    const kommandos = vorschlagAnwenden(vorschlag({ art: 'trashObject', payload: { objectId: 'd1' } }));

    expect(kommandos).toHaveLength(1);
    const payload = kommandos[0].payload as { id: unknown; trashId: unknown; trashedAt: unknown };
    expect(payload.id).toBe('d1');
    // Die trashId steht im Payload, BEVOR das erste Kommando wirkt — sonst kennt die
    // restoreObject-Inverse die trashId nicht (Inversen-Pflicht aus 12-01).
    expect(typeof payload.trashId).toBe('string');
    expect((payload.trashId as string).length).toBeGreaterThan(0);
    expect(typeof payload.trashedAt).toBe('string');
  });

  it('setNoteDone lehnt einen nicht-boolschen done-Wert ab (Handler-Prüfung gespiegelt)', () => {
    expect(() => vorschlagAnwenden(vorschlag({ art: 'setNoteDone', payload: { id: 'n1', done: 'ja' } })))
      .toThrow(CommandError);
  });

  it('erzeugende arten vergeben serverseitige ids, wenn der Vorschlag keine trägt', () => {
    for (const [art, payload] of [
      ['addLink', { fromId: 'd1', toId: 'd2' }],
      ['stackDocs', { draggedId: 'd1', targetId: 'd2' }],
      ['extractPage', { docId: 'd1', page: 1, position: { x: 0, y: 0 } }],
      ['addClip', { aId: 'd1', bId: 'n1' }],
    ] as const) {
      const kommandos = vorschlagAnwenden(vorschlag({ art, payload }));
      const p = (kommandos[0].payload ?? {}) as { id?: unknown };
      expect(typeof p.id, `${art} sollte eine id generieren`).toBe('string');
    }
  });

  it('für jede art in GENEHMIGUNGS_FAEHIGE_ARTEN existiert eine Abbildung (Whitelist-Sync)', () => {
    // Die REST-Erstellungs-Whitelist (proposals.ts, 12-03) liest GENEHMIGUNGS_FAEHIGE_ARTEN —
    // wächst die Konstante ohne Abbildung im switch, muss dieser Test scheitern, BEVOR die
    // Whitelist eine art annimmt, die erst bei der Genehmigung wirft.
    const gueltigePayloads: Record<string, Record<string, unknown>> = {
      moveDoc: { id: 'd1', position: { x: 0, y: 0 } },
      stackDocs: { draggedId: 'd1', targetId: 'd2' },
      removeFromStack: { docId: 'd1', position: { x: 0, y: 0 } },
      dissolveStack: { stackId: 'st1' },
      renameStack: { stackId: 'st1', name: 'n' },
      moveStack: { stackId: 'st1', position: { x: 0, y: 0 } },
      addLink: { fromId: 'd1', toId: 'd2' },
      addNote: { kind: 'notiz', text: 't', position: { x: 0, y: 0 } },
      editNote: { id: 'n1', text: 't' },
      addStamp: { docId: 'd1', page: 1, x: 1, y: 1, angle: 0, text: 'GEPRÜFT', color: 'blue', baseW: 595, baseH: 842 },
      addFlag: { docId: 'd1', page: 1, offset: 0.5, color: '#f5c518' },
      stapleStack: { stackId: 'st1' },
      unstapleStack: { stackId: 'st1' },
      addClip: { aId: 'd1', bId: 'n1' },
      trashObject: { objectId: 'd1' },
      restoreObject: { trashId: 'tr1' },
      setNoteDone: { id: 'n1', done: true },
      extractPage: { docId: 'd1', page: 1, position: { x: 0, y: 0 } },
      setLinkNote: { linkId: 'l1', note: 'n' },
    };
    expect(GENEHMIGUNGS_FAEHIGE_ARTEN.length).toBeGreaterThan(0);
    for (const art of GENEHMIGUNGS_FAEHIGE_ARTEN) {
      const payload = gueltigePayloads[art];
      expect(payload, `Test-Payload für ${art} fehlt — bitte hier ergänzen`).toBeDefined();
      expect(() => vorschlagAnwenden(vorschlag({ art, payload }))).not.toThrow();
    }
  });
});
