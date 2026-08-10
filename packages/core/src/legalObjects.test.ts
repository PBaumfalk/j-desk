import { describe, it, expect } from 'vitest';
import { emptyState, isValidState } from './model';
import {
  addLegalObject, editLegalObject, moveLegalObject, removeLegalObject, findLegalObject,
  legalObjectBox, LEGAL_OBJECT_KINDS, LEGAL_W, LEGAL_H, type LegalObjectKind,
  setTaskStatus, setTaskAssignee, setTaskDueDate, setTaskPriority, setTaskDocRef, removeTaskDocRef,
  markTaskHandedOver,
  istUeberfaellig, TASK_STATUSES, TASK_PRIORITIES, AUFGABE_W, AUFGABE_H,
} from './legalObjects';
import { addLink } from './links';
import { applyCommand, CommandError } from './commands';
import { stempeleGeaenderte } from './stempel';
import { trashObject, restoreObject } from './trash';

const S = { rev: 3, at: '2026-08-07T12:00:00.000Z', by: 'Frau Meier' };

describe('addLegalObject', () => {
  it('hängt genau ein Objekt an, vergibt zIndex und lässt übrige Arrays referenzidentisch', () => {
    const alt = emptyState();
    const neu = addLegalObject(alt, 'tatsache', 'Text', { x: 10, y: 20 }, 'lo1');
    expect(neu.legalObjects).toHaveLength(1);
    expect(neu.legalObjects![0]).toMatchObject({ id: 'lo1', kind: 'tatsache', text: 'Text', position: { x: 10, y: 20 } });
    expect(neu.legalObjects![0].zIndex).toBeGreaterThan(0);
    expect(neu.docs).toBe(alt.docs);
    expect(neu.links).toBe(alt.links);
  });

  it('vergibt eine id, wenn keine mitkommt, und kennt alle 13 Typen', () => {
    expect(LEGAL_OBJECT_KINDS).toHaveLength(13);
    for (const kind of LEGAL_OBJECT_KINDS) {
      const s = addLegalObject(emptyState(), kind, 'x', { x: 0, y: 0 });
      expect(s.legalObjects![0].id).toBeTruthy();
      expect(s.legalObjects![0].kind).toBe(kind);
    }
  });

  it('lehnt einen Wert außerhalb von LEGAL_OBJECT_KINDS ab', () => {
    expect(() => addLegalObject(emptyState(), 'geistesblitz' as LegalObjectKind, 'x', { x: 0, y: 0 })).toThrow();
  });

  it('funktioniert auf alten States ohne legalObjects-Feld', () => {
    const alt = emptyState();
    delete (alt as { legalObjects?: unknown }).legalObjects;
    expect(addLegalObject(alt, 'frist', 'x', { x: 0, y: 0 }).legalObjects).toHaveLength(1);
  });
});

describe('applyCommand: addLegalObject/editLegalObject/moveLegalObject/removeLegalObject', () => {
  it('addLegalObject erzeugt das Objekt mit genau der mitgegebenen id', () => {
    const s = applyCommand(emptyState(), {
      type: 'addLegalObject',
      payload: { kind: 'frist', text: '', position: { x: 0, y: 0 }, id: 'lo1' },
    });
    expect(findLegalObject(s, 'lo1')).toMatchObject({ kind: 'frist' });
  });

  it('lehnt einen unbekannten kind-Wert mit CommandError ab und lässt den Zustand unverändert', () => {
    const alt = emptyState();
    expect(() => applyCommand(alt, {
      type: 'addLegalObject',
      payload: { kind: 'unbekannt', text: '', position: { x: 0, y: 0 }, id: 'lo1' },
    })).toThrow(CommandError);
  });

  it('editLegalObject ändert den Text, moveLegalObject die Position', () => {
    let s = applyCommand(emptyState(), { type: 'addLegalObject', payload: { kind: 'tatsache', text: 'Alt', position: { x: 0, y: 0 }, id: 'lo1' } });
    s = applyCommand(s, { type: 'editLegalObject', payload: { id: 'lo1', text: 'Neu' } });
    expect(findLegalObject(s, 'lo1')?.text).toBe('Neu');
    s = applyCommand(s, { type: 'moveLegalObject', payload: { id: 'lo1', position: { x: 5, y: 6 } } });
    expect(findLegalObject(s, 'lo1')?.position).toEqual({ x: 5, y: 6 });
  });

  it('editLegalObject/moveLegalObject auf unbekannter id werfen "nicht gefunden"', () => {
    expect(() => editLegalObject(emptyState(), 'nix', 'x')).toThrow(/nicht gefunden/);
    expect(() => moveLegalObject(emptyState(), 'nix', { x: 0, y: 0 })).toThrow(/nicht gefunden/);
    expect(() => removeLegalObject(emptyState(), 'nix')).toThrow(/nicht gefunden/);
  });

  it('unveränderte Objekte behalten ihre Referenz (Strukturteilung)', () => {
    let s = addLegalObject(emptyState(), 'tatsache', 'A', { x: 0, y: 0 }, 'lo1');
    s = addLegalObject(s, 'frist', 'B', { x: 10, y: 10 }, 'lo2');
    const vorherLo2 = s.legalObjects![1];
    const neu = editLegalObject(s, 'lo1', 'A-geändert');
    expect(neu.legalObjects![1]).toBe(vorherLo2);
  });

  it('removeLegalObject entfernt das Objekt UND alle Verknüpfungen, an denen es beteiligt ist', () => {
    let s = addLegalObject(emptyState(), 'tatsache', 'A', { x: 0, y: 0 }, 'lo1');
    s = addLegalObject(s, 'beweismittel', 'B', { x: 100, y: 0 }, 'lo2');
    s = addLink(s, 'lo1', 'lo2', 'l-1');
    s = applyCommand(s, { type: 'removeLegalObject', payload: { id: 'lo1' } });
    expect(findLegalObject(s, 'lo1')).toBeUndefined();
    expect(s.links).toEqual([]);
  });
});

describe('legalObjectBox', () => {
  it('liefert die Box für Geometrie/Culling in LEGAL_W/LEGAL_H', () => {
    const s = addLegalObject(emptyState(), 'tatsache', 'x', { x: 7, y: 8 }, 'lo1');
    const b = legalObjectBox(s.legalObjects![0]);
    expect(b).toEqual({ x: 7, y: 8, w: LEGAL_W, h: LEGAL_H });
  });
});

describe('stempeleGeaenderte für legalObjects', () => {
  it('versieht ein geändertes juristisches Objekt mit updatedRev/updatedAt/updatedBy', () => {
    const alt = addLegalObject(emptyState(), 'tatsache', 'Alt', { x: 0, y: 0 }, 'lo1');
    const neu = stempeleGeaenderte(alt, editLegalObject(alt, 'lo1', 'Neu'), S);
    const obj = neu.legalObjects!.find((o) => o.id === 'lo1')!;
    expect(obj.updatedRev).toBe(3);
    expect(obj.updatedAt).toBe(S.at);
    expect(obj.updatedBy).toBe('Frau Meier');
  });
});

describe('trashObject/restoreObject für legalObjects', () => {
  it('legt einen TrashedItem mit kind legalObject an; restoreObject bringt es zurück', () => {
    let s = addLegalObject(emptyState(), 'tatsache', 'Text', { x: 0, y: 0 }, 'lo1');
    s = trashObject(s, 'lo1', '2026-08-07T00:00:00.000Z', 't1');
    expect(findLegalObject(s, 'lo1')).toBeUndefined();
    expect(s.trash?.[0]).toMatchObject({ id: 't1', kind: 'legalObject' });
    s = restoreObject(s, 't1');
    expect(findLegalObject(s, 'lo1')).toMatchObject({ kind: 'tatsache', text: 'Text' });
  });
});

describe('isValidState mit legalObjects', () => {
  it('akzeptiert einen Zustand ohne legalObjects-Schlüssel', () => {
    const s = emptyState();
    delete (s as { legalObjects?: unknown }).legalObjects;
    expect(isValidState(s)).toBe(true);
  });

  it('lehnt legalObjects: "x" ab', () => {
    const s = { ...emptyState(), legalObjects: 'x' as unknown };
    expect(isValidState(s)).toBe(false);
  });
});

/**
 * TASK-01: Aufgabenfelder (Verantwortlicher, Fälligkeit, Priorität, Status, Dokument-/
 * Fundstellenbezug) und ihre validierten Setter — vgl. setNoteDone auf kind 'todo' als
 * Vorbild für das kind-Gate (08-UI-SPEC.md Copywriting Contract).
 */
describe('Aufgabenfelder: addLegalObject-Vorbelegung', () => {
  it('addLegalObject mit kind aufgabe setzt priority mittel und status offen', () => {
    const s = addLegalObject(emptyState(), 'aufgabe', 'Schriftsatz fertigstellen', { x: 0, y: 0 }, 'a1');
    expect(s.legalObjects![0]).toMatchObject({ priority: 'mittel', status: 'offen' });
  });

  it('addLegalObject mit anderem kind setzt weder priority noch status', () => {
    const s = addLegalObject(emptyState(), 'tatsache', 'Text', { x: 0, y: 0 }, 't1');
    expect(s.legalObjects![0].priority).toBeUndefined();
    expect(s.legalObjects![0].status).toBeUndefined();
  });

  it('kennt genau vier Status- und drei Prioritätswerte', () => {
    expect(TASK_STATUSES).toEqual(['offen', 'in-arbeit', 'erledigt', 'uebergeben']);
    expect(TASK_PRIORITIES).toEqual(['hoch', 'mittel', 'niedrig']);
  });
});

describe('Aufgabenfelder: kind-gegatete Setter', () => {
  function aufgabe() {
    return addLegalObject(emptyState(), 'aufgabe', 'Aufgabe', { x: 0, y: 0 }, 'a1');
  }

  it('setTaskStatus setzt den Status auf einer Aufgabe, übrige Objekte bleiben referenzidentisch', () => {
    let s = aufgabe();
    s = addLegalObject(s, 'tatsache', 'Andere', { x: 10, y: 10 }, 't1');
    const andereVorher = s.legalObjects!.find((o) => o.id === 't1');
    const neu = setTaskStatus(s, 'a1', 'in-arbeit');
    expect(neu.legalObjects!.find((o) => o.id === 'a1')?.status).toBe('in-arbeit');
    expect(neu.legalObjects!.find((o) => o.id === 't1')).toBe(andereVorher);
  });

  it('setTaskStatus auf einem Nicht-Aufgabe-Objekt wirft', () => {
    const s = addLegalObject(emptyState(), 'tatsache', 'Text', { x: 0, y: 0 }, 't1');
    expect(() => setTaskStatus(s, 't1', 'erledigt')).toThrow(/Nur Aufgaben/);
  });

  it('setTaskAssignee auf einem Nicht-Aufgabe-Objekt wirft', () => {
    const s = addLegalObject(emptyState(), 'tatsache', 'Text', { x: 0, y: 0 }, 't1');
    expect(() => setTaskAssignee(s, 't1', 'Frau Meier')).toThrow(/Nur Aufgaben/);
  });

  it('setTaskDueDate auf einem Nicht-Aufgabe-Objekt wirft', () => {
    const s = addLegalObject(emptyState(), 'tatsache', 'Text', { x: 0, y: 0 }, 't1');
    expect(() => setTaskDueDate(s, 't1', '2026-09-01')).toThrow(/Nur Aufgaben/);
  });

  it('setTaskPriority auf einem Nicht-Aufgabe-Objekt wirft', () => {
    const s = addLegalObject(emptyState(), 'tatsache', 'Text', { x: 0, y: 0 }, 't1');
    expect(() => setTaskPriority(s, 't1', 'hoch')).toThrow(/Nur Aufgaben/);
  });

  it('setTaskDocRef auf einem Nicht-Aufgabe-Objekt wirft', () => {
    const s = addLegalObject(emptyState(), 'tatsache', 'Text', { x: 0, y: 0 }, 't1');
    expect(() => setTaskDocRef(s, 't1', { docId: 'd1' })).toThrow(/Nur Aufgaben/);
  });

  it('setTaskAssignee setzt den Verantwortlichen', () => {
    const neu = setTaskAssignee(aufgabe(), 'a1', 'Herr Schmidt');
    expect(neu.legalObjects![0].assignee).toBe('Herr Schmidt');
  });

  it('setTaskAssignee mit leerem String löscht das Feld statt einen leeren String zu speichern', () => {
    let s = setTaskAssignee(aufgabe(), 'a1', 'Herr Schmidt');
    s = setTaskAssignee(s, 'a1', '');
    expect(s.legalObjects![0].assignee).toBeUndefined();
    expect('assignee' in s.legalObjects![0]).toBe(false);
  });

  it('setTaskDueDate setzt die Fälligkeit', () => {
    const neu = setTaskDueDate(aufgabe(), 'a1', '2026-09-01');
    expect(neu.legalObjects![0].dueDate).toBe('2026-09-01');
  });

  it('setTaskDueDate mit leerem String löscht das Feld', () => {
    let s = setTaskDueDate(aufgabe(), 'a1', '2026-09-01');
    s = setTaskDueDate(s, 'a1', '');
    expect(s.legalObjects![0].dueDate).toBeUndefined();
    expect('dueDate' in s.legalObjects![0]).toBe(false);
  });

  it('setTaskPriority setzt die Priorität', () => {
    const neu = setTaskPriority(aufgabe(), 'a1', 'hoch');
    expect(neu.legalObjects![0].priority).toBe('hoch');
  });

  it('setTaskDocRef akzeptiert docId allein, docId+page und docId+page+cutoutId', () => {
    let s = setTaskDocRef(aufgabe(), 'a1', { docId: 'd1' });
    expect(s.legalObjects![0].docRef).toEqual({ docId: 'd1' });
    s = setTaskDocRef(s, 'a1', { docId: 'd1', page: 3 });
    expect(s.legalObjects![0].docRef).toEqual({ docId: 'd1', page: 3 });
    s = setTaskDocRef(s, 'a1', { docId: 'd1', page: 3, cutoutId: 'c1' });
    expect(s.legalObjects![0].docRef).toEqual({ docId: 'd1', page: 3, cutoutId: 'c1' });
  });

  it('removeTaskDocRef löscht den Bezug (setTaskDocRef selbst kann das nicht — docId ist Pflicht)', () => {
    let s = setTaskDocRef(aufgabe(), 'a1', { docId: 'd1' });
    s = removeTaskDocRef(s, 'a1');
    expect(s.legalObjects![0].docRef).toBeUndefined();
    expect('docRef' in s.legalObjects![0]).toBe(false);
  });

  it('removeTaskDocRef auf einem Nicht-Aufgabe-Objekt wirft', () => {
    const s = addLegalObject(emptyState(), 'tatsache', 'Text', { x: 0, y: 0 }, 't1');
    expect(() => removeTaskDocRef(s, 't1')).toThrow(/Nur Aufgaben/);
  });

  it('markTaskHandedOver (TASK-02) setzt Status "uebergeben" und die Übergabe-Provenienz', () => {
    const neu = markTaskHandedOver(aufgabe(), 'a1', '2026-08-20T10:00:00.000Z', 'dd-1');
    expect(neu.legalObjects![0].status).toBe('uebergeben');
    expect(neu.legalObjects![0].handedOverToJLawyer).toEqual({ at: '2026-08-20T10:00:00.000Z', jlDueDateId: 'dd-1' });
  });

  it('markTaskHandedOver auf einem Nicht-Aufgabe-Objekt wirft', () => {
    const s = addLegalObject(emptyState(), 'tatsache', 'Text', { x: 0, y: 0 }, 't1');
    expect(() => markTaskHandedOver(s, 't1', '2026-08-20T10:00:00.000Z', 'dd-1')).toThrow(/Nur Aufgaben/);
  });
});

describe('applyCommand: Aufgaben-Setter über den Command-Pfad', () => {
  function aufgabe() {
    return applyCommand(emptyState(), {
      type: 'addLegalObject',
      payload: { kind: 'aufgabe', text: 'Aufgabe', position: { x: 0, y: 0 }, id: 'a1' },
    });
  }

  it('setTaskStatus mit unbekanntem Statuswert wirft CommandError, der Zustand bleibt unverändert', () => {
    const s = aufgabe();
    expect(() => applyCommand(s, { type: 'setTaskStatus', payload: { id: 'a1', status: 'erfunden' } })).toThrow(CommandError);
    expect(applyCommand(s, { type: 'moveLegalObject', payload: { id: 'a1', position: { x: 0, y: 0 } } }).legalObjects![0].status).toBe('offen');
  });

  it('setTaskPriority mit unbekanntem Prioritätswert wirft CommandError', () => {
    const s = aufgabe();
    expect(() => applyCommand(s, { type: 'setTaskPriority', payload: { id: 'a1', priority: 'sehr-hoch' } })).toThrow(CommandError);
  });

  it('setTaskDocRef ohne docId wirft CommandError', () => {
    const s = aufgabe();
    expect(() => applyCommand(s, { type: 'setTaskDocRef', payload: { id: 'a1', docRef: { page: 2 } } })).toThrow(CommandError);
  });

  it('setTaskStatus/setTaskPriority/setTaskAssignee/setTaskDueDate/setTaskDocRef über applyCommand setzen die jeweiligen Felder', () => {
    let s = aufgabe();
    s = applyCommand(s, { type: 'setTaskStatus', payload: { id: 'a1', status: 'in-arbeit' } });
    expect(findLegalObject(s, 'a1')?.status).toBe('in-arbeit');
    s = applyCommand(s, { type: 'setTaskPriority', payload: { id: 'a1', priority: 'niedrig' } });
    expect(findLegalObject(s, 'a1')?.priority).toBe('niedrig');
    s = applyCommand(s, { type: 'setTaskAssignee', payload: { id: 'a1', assignee: 'Frau Meier' } });
    expect(findLegalObject(s, 'a1')?.assignee).toBe('Frau Meier');
    s = applyCommand(s, { type: 'setTaskDueDate', payload: { id: 'a1', dueDate: '2026-09-01' } });
    expect(findLegalObject(s, 'a1')?.dueDate).toBe('2026-09-01');
    s = applyCommand(s, { type: 'setTaskDocRef', payload: { id: 'a1', docRef: { docId: 'd1' } } });
    expect(findLegalObject(s, 'a1')?.docRef).toEqual({ docId: 'd1' });
    s = applyCommand(s, { type: 'removeTaskDocRef', payload: { id: 'a1' } });
    expect(findLegalObject(s, 'a1')?.docRef).toBeUndefined();
  });

  it('markTaskHandedOver über applyCommand setzt Status und Provenienz (TASK-02)', () => {
    const s = aufgabe();
    const neu = applyCommand(s, { type: 'markTaskHandedOver', payload: { id: 'a1', at: '2026-08-20T10:00:00.000Z', jlDueDateId: 'dd-1' } });
    expect(findLegalObject(neu, 'a1')?.status).toBe('uebergeben');
    expect(findLegalObject(neu, 'a1')?.handedOverToJLawyer).toEqual({ at: '2026-08-20T10:00:00.000Z', jlDueDateId: 'dd-1' });
  });

  it('markTaskHandedOver ohne "at"/"jlDueDateId" wirft CommandError', () => {
    const s = aufgabe();
    expect(() => applyCommand(s, { type: 'markTaskHandedOver', payload: { id: 'a1' } })).toThrow(CommandError);
  });
});

describe('istUeberfaellig', () => {
  function aufgabeMitStatus(status: (typeof TASK_STATUSES)[number] | undefined, dueDate?: string) {
    let s = addLegalObject(emptyState(), 'aufgabe', 'x', { x: 0, y: 0 }, 'a1');
    if (dueDate !== undefined) s = setTaskDueDate(s, 'a1', dueDate);
    if (status !== undefined) s = setTaskStatus(s, 'a1', status);
    return s.legalObjects![0];
  }

  it('liefert false ohne dueDate', () => {
    expect(istUeberfaellig(aufgabeMitStatus('offen'), '2026-09-05T00:00:00.000Z')).toBe(false);
  });

  it('liefert false, wenn dueDate in der Zukunft liegt', () => {
    expect(istUeberfaellig(aufgabeMitStatus('offen', '2026-09-10'), '2026-09-05T00:00:00.000Z')).toBe(false);
  });

  it('liefert true, wenn dueDate in der Vergangenheit liegt und Status offen ist', () => {
    expect(istUeberfaellig(aufgabeMitStatus('offen', '2026-09-01'), '2026-09-05T00:00:00.000Z')).toBe(true);
  });

  it('liefert true, wenn dueDate in der Vergangenheit liegt und Status in-arbeit ist', () => {
    expect(istUeberfaellig(aufgabeMitStatus('in-arbeit', '2026-09-01'), '2026-09-05T00:00:00.000Z')).toBe(true);
  });

  it('liefert false, wenn dueDate in der Vergangenheit liegt, aber Status erledigt ist', () => {
    expect(istUeberfaellig(aufgabeMitStatus('erledigt', '2026-09-01'), '2026-09-05T00:00:00.000Z')).toBe(false);
  });

  it('liefert false, wenn dueDate in der Vergangenheit liegt, aber Status uebergeben ist', () => {
    expect(istUeberfaellig(aufgabeMitStatus('uebergeben', '2026-09-01'), '2026-09-05T00:00:00.000Z')).toBe(false);
  });
});

describe('legalObjectBox: Sondergröße für Aufgaben', () => {
  it('liefert AUFGABE_W/AUFGABE_H für kind aufgabe', () => {
    const s = addLegalObject(emptyState(), 'aufgabe', 'x', { x: 3, y: 4 }, 'a1');
    expect(legalObjectBox(s.legalObjects![0])).toEqual({ x: 3, y: 4, w: AUFGABE_W, h: AUFGABE_H });
  });

  it('liefert weiterhin LEGAL_W/LEGAL_H für alle übrigen Typen', () => {
    const s = addLegalObject(emptyState(), 'tatsache', 'x', { x: 3, y: 4 }, 't1');
    expect(legalObjectBox(s.legalObjects![0])).toEqual({ x: 3, y: 4, w: LEGAL_W, h: LEGAL_H });
  });
});
