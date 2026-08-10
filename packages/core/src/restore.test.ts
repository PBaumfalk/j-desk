import { describe, expect, it } from 'vitest';
import { emptyState, type DesktopState } from './model';
import { addDoc, moveDoc } from './documents';
import { applyCommand } from './commands';
import { stempeleGeaenderte } from './stempel';
import { replayJournal, ZUSTANDS_TRAGENDE_JOURNAL_TYPEN, NEBENWIRKUNGSFREIE_JOURNAL_TYPEN, type JournalReplayZeile } from './restore';

function stateMitEinemDoc(): DesktopState {
  return addDoc(emptyState(), 'f1', 'Akte.pdf', { x: 0, y: 0 }, 'd1');
}

describe('replayJournal', () => {
  it('liefert für eine reine Command-Folge denselben Zustand wie applyCommand + stempeleGeaenderte im Live-Betrieb', () => {
    const zeilen: JournalReplayZeile[] = [
      { id: 1, rev: 1, type: 'addDoc', payload: { fileId: 'f1', name: 'a.pdf', position: { x: 0, y: 0 }, id: 'd1' }, actorId: 'u1', actorName: 'Anna', at: 1_700_000_000_000 },
      { id: 2, rev: 2, type: 'moveDoc', payload: { id: 'd1', position: { x: 5, y: 5 } }, actorId: 'u1', actorName: 'Anna', at: 1_700_000_001_000 },
    ];

    const replayed = replayJournal(emptyState(), zeilen);

    // Live-Nachbau: dieselben Commands, dieselben Meta-/Stempelwerte pro Schritt.
    let live = emptyState();
    for (const z of zeilen) {
      const meta = { createdBy: z.actorName, createdAt: new Date(z.at).toISOString(), createdById: z.actorId! };
      const vorher = live;
      live = stempeleGeaenderte(vorher, applyCommand(vorher, { type: z.type, payload: z.payload as Record<string, unknown> }, meta), {
        rev: z.rev, at: meta.createdAt, by: z.actorName,
      });
    }

    expect(replayed).toEqual(live);
  });

  it('stempelt ein wiederhergestelltes Objekt mit updatedBy/updatedRev der historischen Zeile, nicht eines späteren Restaurators (P-02)', () => {
    const zeilen: JournalReplayZeile[] = [
      { id: 1, rev: 7, type: 'addDoc', payload: { fileId: 'f1', name: 'a.pdf', position: { x: 0, y: 0 }, id: 'd1' }, actorId: 'u1', actorName: 'Anna', at: 1_700_000_000_000 },
    ];

    const einmal = replayJournal(emptyState(), zeilen);
    const doc = einmal.docs.find((d) => d.id === 'd1')!;
    expect(doc.updatedRev).toBe(7);
    expect(doc.updatedBy).toBe('Anna');

    // replayJournal kennt keinen Restaurator-Kontext-Parameter — ein zweiter Aufruf derselben
    // Zeilen (wie es ein späterer Restore-Vorgang täte) liefert exakt dieselben Provenienz-Werte,
    // NICHT die eines wiederherstellenden Akteurs/Zeitpunkts.
    const zweimal = replayJournal(emptyState(), zeilen);
    const doc2 = zweimal.docs.find((d) => d.id === 'd1')!;
    expect(doc2.updatedRev).toBe(7);
    expect(doc2.updatedBy).toBe('Anna');
  });

  it('eine stateReplaced-Zeile mitten im Bereich ersetzt den Zustand vollständig — danach folgende Commands wirken auf dem ersetzten Zustand', () => {
    const zeilen: JournalReplayZeile[] = [
      { id: 1, rev: 5, type: 'stateReplaced', payload: { state: stateMitEinemDoc() }, actorId: null, actorName: 'System', at: 1000 },
      { id: 2, rev: 6, type: 'moveDoc', payload: { id: 'd1', position: { x: 99, y: 99 } }, actorId: 'u1', actorName: 'Bob', at: 2000 },
    ];

    const result = replayJournal(emptyState(), zeilen);
    expect(result.docs).toHaveLength(1);
    expect(result.docs[0].position).toEqual({ x: 99, y: 99 });
  });

  it('eine caseSync-Zeile verhält sich identisch zu stateReplaced', () => {
    const zeilen: JournalReplayZeile[] = [
      { id: 1, rev: 5, type: 'caseSync', payload: { state: stateMitEinemDoc() }, actorId: null, actorName: 'j-lawyer-Abgleich', at: 1000 },
      { id: 2, rev: 6, type: 'moveDoc', payload: { id: 'd1', position: { x: 42, y: 42 } }, actorId: 'u1', actorName: 'Bob', at: 2000 },
    ];

    const result = replayJournal(emptyState(), zeilen);
    expect(result.docs).toHaveLength(1);
    expect(result.docs[0].position).toEqual({ x: 42, y: 42 });
  });

  it('eine stateRestored-Zeile mitten im Bereich ersetzt den Zustand ebenfalls vollständig (Regressionsschutz gegen „überspringen")', () => {
    const zeilen: JournalReplayZeile[] = [
      { id: 1, rev: 5, type: 'stateRestored', payload: { state: stateMitEinemDoc(), targetAt: 500, targetEntryId: 0 }, actorId: 'u1', actorName: 'Anna', at: 1000 },
      { id: 2, rev: 6, type: 'moveDoc', payload: { id: 'd1', position: { x: 11, y: 11 } }, actorId: 'u1', actorName: 'Bob', at: 2000 },
    ];

    const result = replayJournal(emptyState(), zeilen);
    expect(result.docs).toHaveLength(1);
    expect(result.docs[0].position).toEqual({ x: 11, y: 11 });
  });

  it('eine snapshot-Zeile mitten im Bereich ersetzt den Zustand ebenfalls vollständig', () => {
    const zeilen: JournalReplayZeile[] = [
      { id: 1, rev: 5, type: 'snapshot', payload: { state: stateMitEinemDoc() }, actorId: null, actorName: 'Migration', at: 1000 },
      { id: 2, rev: 6, type: 'moveDoc', payload: { id: 'd1', position: { x: 3, y: 3 } }, actorId: 'u1', actorName: 'Bob', at: 2000 },
    ];

    const result = replayJournal(emptyState(), zeilen);
    expect(result.docs).toHaveLength(1);
    expect(result.docs[0].position).toEqual({ x: 3, y: 3 });
  });

  it('eine deskCreated-Zeile ändert nichts', () => {
    const start = stateMitEinemDoc();
    const zeilen: JournalReplayZeile[] = [
      { id: 1, rev: 0, type: 'deskCreated', payload: { name: 'Akte A' }, actorId: 'u1', actorName: 'Anna', at: 1000 },
    ];

    expect(replayJournal(start, zeilen)).toBe(start);
  });

  it('eine exported-Zeile mitten im Bereich ändert nichts und wirft nicht (04-04 CR-01: Export verbraucht keinen rev und darf Replay nicht abbrechen)', () => {
    const start = stateMitEinemDoc();
    const zeilen: JournalReplayZeile[] = [
      { id: 1, rev: 0, type: 'exported', payload: { format: 'jdesk' }, actorId: 'u1', actorName: 'Anna', at: 1000 },
    ];

    expect(replayJournal(start, zeilen)).toBe(start);
  });

  it('addDoc → exported → addDoc lässt sich vollständig und ohne Fehler replayen (04-04 CR-01 Regressionsschutz)', () => {
    const zeilen: JournalReplayZeile[] = [
      { id: 1, rev: 1, type: 'addDoc', payload: { fileId: 'f1', name: 'a.pdf', position: { x: 0, y: 0 }, id: 'd1' }, actorId: 'u1', actorName: 'Anna', at: 1_700_000_000_000 },
      { id: 2, rev: 1, type: 'exported', payload: { format: 'jdesk' }, actorId: 'u1', actorName: 'Anna', at: 1_700_000_000_500 },
      { id: 3, rev: 2, type: 'addDoc', payload: { fileId: 'f2', name: 'b.pdf', position: { x: 10, y: 10 }, id: 'd2' }, actorId: 'u1', actorName: 'Anna', at: 1_700_000_001_000 },
    ];

    const result = replayJournal(emptyState(), zeilen);
    expect(result.docs.map((d) => d.id).sort()).toEqual(['d1', 'd2']);
  });

  it('ein Journal mit Doppelstempel-Markern zwischen Kommandos replayt folgenlos zum selben End-State wie ohne Marker (12: KI-Genehmigung darf Wiederherstellung nicht brechen)', () => {
    const kommandos: JournalReplayZeile[] = [
      { id: 1, rev: 1, type: 'addNote', payload: { id: 'n1', kind: 'notiz', text: 'erste', position: { x: 0, y: 0 } }, actorId: 'u1', actorName: 'Anna', at: 1_700_000_000_000 },
      { id: 2, rev: 2, type: 'addNote', payload: { id: 'n2', kind: 'notiz', text: 'zweite', position: { x: 5, y: 5 } }, actorId: 'u1', actorName: 'Anna', at: 1_700_000_001_000 },
    ];
    const mitMarkern: JournalReplayZeile[] = [
      kommandos[0],
      { id: 3, rev: 1, type: 'vorschlagGenehmigt', payload: { vorschlagId: 'v1', kiAkteur: 'ki-agent', approvedBy: 'Anna', zusammenfassung: 'Notiz übernommen' }, actorId: 'u1', actorName: 'Anna', at: 1_700_000_000_500 },
      kommandos[1],
      { id: 4, rev: 2, type: 'vorschlagZurueckgenommen', payload: { vorschlagId: 'v1', kiAkteur: 'ki-agent', approvedBy: 'Anna', zusammenfassung: 'Notiz übernommen' }, actorId: 'u1', actorName: 'Anna', at: 1_700_000_001_500 },
    ];

    expect(replayJournal(emptyState(), mitMarkern)).toEqual(replayJournal(emptyState(), kommandos));
  });

  it('ein Journal, das nach deskCreated NUR Marker-Einträge trägt, replayt zum leeren Anfangs-State ohne Wurf', () => {
    const zeilen: JournalReplayZeile[] = [
      { id: 1, rev: 0, type: 'deskCreated', payload: { name: 'Akte A' }, actorId: 'u1', actorName: 'Anna', at: 1000 },
      { id: 2, rev: 0, type: 'vorschlagGenehmigt', payload: { vorschlagId: 'v1', kiAkteur: 'ki-agent', approvedBy: 'Anna', zusammenfassung: 's' }, actorId: 'u1', actorName: 'Anna', at: 2000 },
      { id: 3, rev: 0, type: 'vorschlagZurueckgenommen', payload: { vorschlagId: 'v1', kiAkteur: 'ki-agent', approvedBy: 'Anna', zusammenfassung: 's' }, actorId: 'u1', actorName: 'Anna', at: 3000 },
    ];

    const start = emptyState();
    const result = replayJournal(start, zeilen);
    expect(result).toEqual(start);
  });

  it('eine Zeile mit unbekanntem Typ lässt replayJournal werfen (kein stummes Überspringen)', () => {
    const zeilen: JournalReplayZeile[] = [
      { id: 1, rev: 1, type: 'gibtEsNicht', payload: {}, actorId: 'u1', actorName: 'Anna', at: 1000 },
    ];

    expect(() => replayJournal(emptyState(), zeilen)).toThrow();
  });

  it('der Fehler bei unbekanntem Typ nennt die auslösende Journal-Zeile (id/rev/type) für die Diagnose (04-04 WR-02)', () => {
    const zeilen: JournalReplayZeile[] = [
      { id: 42, rev: 7, type: 'gibtEsNicht', payload: {}, actorId: 'u1', actorName: 'Anna', at: 1000 },
    ];

    expect(() => replayJournal(emptyState(), zeilen)).toThrow(/id=42.*rev=7.*type=gibtEsNicht/);
  });

  it('eine leere Zeilenliste gibt den Startzustand unverändert zurück', () => {
    const start = stateMitEinemDoc();
    expect(replayJournal(start, [])).toBe(start);
  });

  it('eine zustands-tragende Zeile mit payload === null wird übersprungen statt den Zustand auf undefined zu setzen', () => {
    const start = stateMitEinemDoc();
    const zeilen: JournalReplayZeile[] = [
      { id: 1, rev: 5, type: 'snapshot', payload: null, actorId: null, actorName: 'Migration', at: 1000 },
    ];

    expect(replayJournal(start, zeilen)).toBe(start);
  });

  it('ZUSTANDS_TRAGENDE_JOURNAL_TYPEN enthält genau die vier state-tragenden Typen', () => {
    expect([...ZUSTANDS_TRAGENDE_JOURNAL_TYPEN].sort()).toEqual(['caseSync', 'snapshot', 'stateReplaced', 'stateRestored']);
  });

  it('NEBENWIRKUNGSFREIE_JOURNAL_TYPEN enthält genau die vier nebenwirkungsfreien Typen', () => {
    // Phase 12: die beiden Doppelstempel-Marker gehören zwingend dazu — sonst bricht
    // replayJournal auf Journalen mit Genehmigungs-Markern als "unbekanntes Command" ab.
    expect([...NEBENWIRKUNGSFREIE_JOURNAL_TYPEN].sort()).toEqual(
      ['deskCreated', 'exported', 'vorschlagGenehmigt', 'vorschlagZurueckgenommen'],
    );
  });
});
