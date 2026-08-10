import { describe, expect, it } from 'vitest';
import { applyCommand, type Command } from './commands';
import { emptyState, type DesktopState } from './model';
import { inverseFuer } from './inverse';
import { vorschlagAnwenden } from './vorschlagAnwenden';
import type { Vorschlag } from './vorschlag';

const addNoteCmd: Command = {
  type: 'addNote',
  payload: { id: 'n-ki-1', kind: 'notiz', text: 'Fundstelle prüfen', position: { x: 5, y: 5 } },
};

/**
 * Fixture-State über reguläre Kommandos gebaut (keine Meta → keine Stempel, damit der
 * inhaltliche Vergleich ohne Normalisierung der Erzeugungsfelder auskommt):
 * - Docs d1..d5; st1 = [d2, d3] (umbenannt, ungeheftet); st2 = [d4, d5] (geheftet)
 * - Notizen n1 (Text „alter Text"), n-todo (explizit done:false), n2 (unverlinkt, für den Korb),
 *   n3 liegt bereits als Korb-Eintrag 'tr-alt' im Papierkorb
 * - Link l1 zwischen d1 und st1 (note '', ohne kind)
 */
function basisState(): DesktopState {
  let s = emptyState();
  s = applyCommand(s, { type: 'addDoc', payload: { id: 'd1', fileId: 'f1', name: 'a.pdf', position: { x: 0, y: 0 } } });
  s = applyCommand(s, { type: 'addDoc', payload: { id: 'd2', fileId: 'f2', name: 'b.pdf', position: { x: 300, y: 0 } } });
  s = applyCommand(s, { type: 'addDoc', payload: { id: 'd3', fileId: 'f3', name: 'c.pdf', position: { x: 600, y: 0 } } });
  s = applyCommand(s, { type: 'addDoc', payload: { id: 'd4', fileId: 'f4', name: 'd.pdf', position: { x: 0, y: 300 } } });
  s = applyCommand(s, { type: 'addDoc', payload: { id: 'd5', fileId: 'f5', name: 'e.pdf', position: { x: 300, y: 300 } } });
  s = applyCommand(s, { type: 'stackDocs', payload: { draggedId: 'd3', targetId: 'd2', id: 'st1' } });
  s = applyCommand(s, { type: 'renameStack', payload: { stackId: 'st1', name: 'Klagebegründung' } });
  s = applyCommand(s, { type: 'stackDocs', payload: { draggedId: 'd5', targetId: 'd4', id: 'st2' } });
  s = applyCommand(s, { type: 'stapleStack', payload: { stackId: 'st2' } });
  s = applyCommand(s, { type: 'addNote', payload: { id: 'n1', kind: 'notiz', text: 'alter Text', position: { x: 10, y: 10 } } });
  s = applyCommand(s, { type: 'addNote', payload: { id: 'n-todo', kind: 'todo', text: 'Frist prüfen', position: { x: 20, y: 20 } } });
  s = applyCommand(s, { type: 'setNoteDone', payload: { id: 'n-todo', done: false } });
  s = applyCommand(s, { type: 'addNote', payload: { id: 'n2', kind: 'notiz', text: 'wegwerf-notiz', position: { x: 30, y: 30 } } });
  s = applyCommand(s, { type: 'addNote', payload: { id: 'n3', kind: 'notiz', text: 'korb-notiz', position: { x: 40, y: 40 } } });
  s = applyCommand(s, { type: 'addLink', payload: { fromId: 'd1', toId: 'st1', id: 'l1' } });
  s = applyCommand(s, { type: 'trashObject', payload: { id: 'n3', trashedAt: '2026-01-01T00:00:00.000Z', trashId: 'tr-alt' } });
  return s;
}

const STEMPEL_FELDER = new Set(['rev', 'updatedRev', 'updatedAt', 'updatedBy', 'createdBy', 'createdById', 'createdAt', 'trashedBy']);

/**
 * Vergleich ohne rev/updatedRev/Stempel (12-04 Property-Nachweis): entfernt Versions- und
 * Provenienzfelder rekursiv und normalisiert Default-Schreibweisen, die Kommandos explizit
 * schreiben, Alt-Stände aber weglassen — `done: false` (setNoteDone), `open: false` und
 * `stapled: false` (unstapleStack) sind semantisch der Ausgangszustand. Zusätzlich werden
 * die Objekt-SAMMELLISTEN nach id sortiert: ihre Einfügereihenfolge ist ein Artefakt der
 * Entfernen-und-Neu-Anhängen-Mechanik (z. B. wiederhergestellter Stapel landet am Ende),
 * Identität und Ordnung tragen id bzw. zIndex — die SEMANTISCHE Reihenfolge innerhalb von
 * Stapeln (docIds) und Klammern (memberIds) bleibt unangetastet. Lokale Testfunktion, geht
 * bewusst NICHT in den Produktivcode (Plan-Vorgabe).
 */
const SAMMEL_LISTEN = new Set([
  'docs', 'links', 'stacks', 'strokes', 'notes', 'cutouts', 'marks', 'stamps', 'flags',
  'clips', 'trash', 'legalObjects', 'tables', 'zeitleisten', 'sitzungsmappen',
]);

function stateOhneStempel(s: DesktopState): unknown {
  const ohneStempel = JSON.parse(JSON.stringify(s, (schluessel, wert: unknown) =>
    STEMPEL_FELDER.has(schluessel) ? undefined : wert)) as unknown;
  const normalisieren = (knoten: unknown, schluessel?: string): void => {
    if (Array.isArray(knoten)) {
      if (schluessel !== undefined && SAMMEL_LISTEN.has(schluessel)) {
        knoten.sort((a, b) => String((a as { id?: unknown }).id ?? '').localeCompare(String((b as { id?: unknown }).id ?? '')));
      }
      for (const eintrag of knoten) normalisieren(eintrag);
      return;
    }
    if (knoten && typeof knoten === 'object') {
      const obj = knoten as Record<string, unknown>;
      if (obj.done === false) delete obj.done;
      if (obj.open === false) delete obj.open;
      if (obj.stapled === false) delete obj.stapled;
      for (const [key, wert] of Object.entries(obj)) normalisieren(wert, key);
    }
  };
  normalisieren(ohneStempel);
  return ohneStempel;
}

function vorschlagFuer(art: string, payload: Record<string, unknown>): Vorschlag {
  return {
    id: 'v-prop', deskId: 'desk1', art, payload, quellen: [], zusammenfassung: 'z',
    status: 'ausstehend', createdBy: 'ki-agent', createdAt: 1000,
  };
}

describe('inverseFuer', () => {
  it('bildet addNote auf removeNote mit derselben id ab', () => {
    expect(inverseFuer(emptyState(), [addNoteCmd])).toEqual([
      { type: 'removeNote', payload: { id: 'n-ki-1' } },
    ]);
  });

  it('kehrt die Reihenfolge bei mehreren Kommandos um', () => {
    const inverse = inverseFuer(emptyState(), [
      addNoteCmd,
      { type: 'addNote', payload: { id: 'n-ki-2', kind: 'notiz', text: 'zweite', position: { x: 9, y: 9 } } },
    ]);

    expect(inverse.map((c) => (c.payload as { id: string }).id)).toEqual(['n-ki-2', 'n-ki-1']);
  });

  it('wirft bei einem Kommandotyp ohne definierte Inverse mit benannter Meldung', () => {
    expect(() => inverseFuer(emptyState(), [{ type: 'shredTrashItem', payload: { id: 'k1' } }]))
      .toThrow('Keine Inverse definiert für: shredTrashItem');
  });

  it('Ausschluss-Regressionssperre: endgültige Lösch-/Schredder-arten haben keine Inverse', () => {
    // Spiegel der Server-Listen LOESCH_COMMANDS/SCHREDDER_COMMANDS (app.ts:131-150) — die
    // Mengenbegrenzung des default-Wurfs ist die konstruktive Sperre (T-12-04-04).
    for (const art of ['removeDoc', 'removeNote', 'removeLink', 'removeStamp', 'removeFlag', 'removeClip', 'shredTrashItem', 'emptyTrash']) {
      expect(() => inverseFuer(emptyState(), [{ type: art, payload: { id: 'x' } }]))
        .toThrow(`Keine Inverse definiert für: ${art}`);
    }
  });

  it('Property: Anwenden der Inversen auf den Folgezustand stellt den Ausgangszustand inhaltlich wieder her', () => {
    const s = emptyState();
    const meta = { createdBy: 'ki-agent', createdAt: '2026-08-08T00:00:00.000Z' };
    const s2 = applyCommand(s, addNoteCmd, meta);
    expect(s2.notes).toHaveLength(1);

    const inverse = inverseFuer(s2, [addNoteCmd]);
    const s3 = applyCommand(s2, inverse[0], meta);

    // Inhaltlicher Vergleich ohne rev/Stempel-Felder: die Objektlisten müssen dem Ausgangszustand entsprechen.
    expect(s3.notes ?? []).toEqual(s.notes ?? []);
    expect(s3.docs).toEqual(s.docs);
    expect(s3.links).toEqual(s.links);
  });

  describe('konkrete Inverse-Formen (exakte Assertionen)', () => {
    it('editNote → editNote mit dem ALTEN Text aus dem State', () => {
      const inverse = inverseFuer(basisState(), [{ type: 'editNote', payload: { id: 'n1', text: 'neu' } }]);
      expect(inverse).toEqual([{ type: 'editNote', payload: { id: 'n1', text: 'alter Text' } }]);
    });

    it('moveDoc → moveDoc mit der ALTEN Position aus dem State', () => {
      const inverse = inverseFuer(basisState(), [{ type: 'moveDoc', payload: { id: 'd1', position: { x: 9, y: 9 } } }]);
      expect(inverse).toEqual([{ type: 'moveDoc', payload: { id: 'd1', position: { x: 0, y: 0 } } }]);
    });

    it('addLink → removeLink mit der Link-id', () => {
      const inverse = inverseFuer(basisState(), [{ type: 'addLink', payload: { fromId: 'd2', toId: 'd3', id: 'l-neu' } }]);
      expect(inverse).toEqual([{ type: 'removeLink', payload: { linkId: 'l-neu' } }]);
    });

    it('trashObject → restoreObject mit der trashId aus dem Payload des Original-Kommandos', () => {
      const inverse = inverseFuer(basisState(), [{ type: 'trashObject', payload: { id: 'n2', trashedAt: '2026-08-08T00:00:00.000Z', trashId: 'tr-x' } }]);
      expect(inverse).toEqual([{ type: 'restoreObject', payload: { trashId: 'tr-x' } }]);
    });

    it('dissolveStack → Re-Stack-Sequenz in ursprünglicher Reihenfolge (plus Stapel-Link, Name, Positionen)', () => {
      const inverse = inverseFuer(basisState(), [{ type: 'dissolveStack', payload: { stackId: 'st1' } }]);

      // Erster Schritt stapelt das zweite Mitglied auf das erste — mit der URSPRÜNGLICHEN
      // Stapel-id, damit Verknüpfungen auf die Stapel-id wieder greifen.
      expect(inverse[0]).toEqual({ type: 'stackDocs', payload: { draggedId: 'd3', targetId: 'd2', id: 'st1' } });
      // Die beim Auflösen entfernte Verknüpfung d1↔st1 wird wiederhergestellt.
      expect(inverse).toContainEqual({ type: 'addLink', payload: { fromId: 'd1', toId: 'st1', id: 'l1' } });
      expect(inverse).toContainEqual({ type: 'renameStack', payload: { stackId: 'st1', name: 'Klagebegründung' } });
      expect(inverse).toContainEqual({ type: 'moveDoc', payload: { id: 'd3', position: { x: 600, y: 0 } } });
    });

    it('setNoteDone → setNoteDone mit dem ALTEN done-Wert aus dem State', () => {
      const inverse = inverseFuer(basisState(), [{ type: 'setNoteDone', payload: { id: 'n-todo', done: true } }]);
      expect(inverse).toEqual([{ type: 'setNoteDone', payload: { id: 'n-todo', done: false } }]);
    });
  });

  describe('Property-Nachweis über alle 19 genehmigungsfähigen arten', () => {
    const faelle: { art: string; payload: Record<string, unknown> }[] = [
      { art: 'moveDoc', payload: { id: 'd1', position: { x: 50, y: 60 } } },
      { art: 'stackDocs', payload: { draggedId: 'd1', targetId: 'st1' } },
      { art: 'removeFromStack', payload: { docId: 'd3', position: { x: 700, y: 0 } } },
      { art: 'dissolveStack', payload: { stackId: 'st1' } },
      { art: 'renameStack', payload: { stackId: 'st1', name: 'Neuer Name' } },
      { art: 'moveStack', payload: { stackId: 'st1', position: { x: 9, y: 9 } } },
      { art: 'addLink', payload: { fromId: 'd2', toId: 'd3', id: 'l-neu' } },
      { art: 'addNote', payload: { id: 'n-neu', kind: 'notiz', text: 'neu', position: { x: 1, y: 2 } } },
      { art: 'editNote', payload: { id: 'n1', text: 'neuer Text' } },
      { art: 'addStamp', payload: { docId: 'd1', page: 1, x: 10, y: 20, angle: 5, text: 'GEPRÜFT', color: 'blue', baseW: 595, baseH: 842, id: 'st-neu' } },
      { art: 'addFlag', payload: { docId: 'd1', page: 2, offset: 0.4, color: '#f5c518', id: 'f-neu' } },
      { art: 'stapleStack', payload: { stackId: 'st1' } },
      { art: 'unstapleStack', payload: { stackId: 'st2' } },
      { art: 'addClip', payload: { aId: 'd1', bId: 'n1', id: 'c-neu' } },
      { art: 'trashObject', payload: { objectId: 'n2' } },
      { art: 'restoreObject', payload: { trashId: 'tr-alt' } },
      { art: 'setNoteDone', payload: { id: 'n-todo', done: true } },
      { art: 'extractPage', payload: { docId: 'd1', page: 3, position: { x: 800, y: 800 }, id: 'd-ext' } },
      { art: 'setLinkNote', payload: { linkId: 'l1', note: 'Belegstelle' } },
    ];

    it.each(faelle)('$art: anwenden + Inverse ≡ Ausgangsstand (inhaltlich, ohne Stempel)', ({ art, payload }) => {
      const s = basisState();
      const kommandos = vorschlagAnwenden(vorschlagFuer(art, payload));
      const s2 = kommandos.reduce((stand, c) => applyCommand(stand, c), s);

      // Zur GENEHMIGUNGSZEIT aus dem State VOR der Anwendung berechnet (Stale-Inverse-Verbot).
      const inverse = inverseFuer(s, kommandos);
      const s3 = inverse.reduce((stand, c) => applyCommand(stand, c), s2);

      expect(stateOhneStempel(s3)).toEqual(stateOhneStempel(s));
    });

    it('deckt alle 19 arten ab', () => {
      expect(faelle).toHaveLength(19);
      expect(new Set(faelle.map((f) => f.art)).size).toBe(19);
    });
  });

  it('Sequenz-Test: zwei genehmigte Vorschläge, Rücknahme in BEIDEN Reihenfolgen ≡ Ausgangsstand', () => {
    const s0 = basisState();
    const k1 = vorschlagAnwenden(vorschlagFuer('addNote', { id: 'n-seq', kind: 'these', text: 'These', position: { x: 99, y: 99 } }));
    const s1 = applyCommand(s0, k1[0]);
    const k2 = vorschlagAnwenden(vorschlagFuer('moveDoc', { id: 'd1', position: { x: 500, y: 500 } }));
    const s2 = applyCommand(s1, k2[0]);

    // Jede Inverse entsteht zum Genehmigungszeitpunkt IHRES Vorschlags (frischer State).
    const inv1 = inverseFuer(s0, k1);
    const inv2 = inverseFuer(s1, k2);

    // Reihenfolge 1: jüngster Vorschlag zuerst zurückgenommen.
    let rueck1 = s2;
    for (const c of inv2) rueck1 = applyCommand(rueck1, c);
    for (const c of inv1) rueck1 = applyCommand(rueck1, c);

    // Reihenfolge 2: ältester zuerst.
    let rueck2 = s2;
    for (const c of inv1) rueck2 = applyCommand(rueck2, c);
    for (const c of inv2) rueck2 = applyCommand(rueck2, c);

    expect(stateOhneStempel(rueck1)).toEqual(stateOhneStempel(s0));
    expect(stateOhneStempel(rueck2)).toEqual(stateOhneStempel(s0));
  });
});
