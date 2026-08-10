import { describe, expect, it } from 'vitest';
import { applyCommand, emptyState, type CommandMeta, type DesktopState } from './index';

const anna: CommandMeta = { createdBy: 'anna', createdAt: '2026-07-19T10:00:00.000Z' };
const bert: CommandMeta = { createdBy: 'bert', createdAt: '2026-07-19T11:00:00.000Z' };

function addNote(s: DesktopState, meta?: CommandMeta): DesktopState {
  return applyCommand(s, { type: 'addNote', payload: { kind: 'notiz', text: 'x', position: { x: 0, y: 0 } } }, meta);
}

describe('Provenienz-Stempel', () => {
  it('stempelt neue Notizen mit createdBy/createdAt', () => {
    const s = addNote(emptyState(), anna);
    expect(s.notes![0].createdBy).toBe('anna');
    expect(s.notes![0].createdAt).toBe('2026-07-19T10:00:00.000Z');
  });

  it('lässt Felder ohne meta weg (Client-Optimismus, Altverhalten)', () => {
    const s = addNote(emptyState());
    expect(s.notes![0].createdBy).toBeUndefined();
    expect(s.notes![0].createdAt).toBeUndefined();
  });

  it('stempelt NICHT bei reinen Änderungs-Commands (moveNote behält Original-Stempel)', () => {
    let s = addNote(emptyState(), anna);
    const id = s.notes![0].id;
    s = applyCommand(s, { type: 'moveNote', payload: { id, position: { x: 5, y: 5 } } }, bert);
    expect(s.notes![0].createdBy).toBe('anna');
    expect(s.notes![0].createdAt).toBe('2026-07-19T10:00:00.000Z');
  });

  it('stempelt Kopien mit dem Kopierenden neu (copyObject)', () => {
    let s = addNote(emptyState(), anna);
    const id = s.notes![0].id;
    s = applyCommand(s, { type: 'copyObject', payload: { id } }, bert);
    const original = s.notes!.find((n) => n.id === id)!;
    const kopie = s.notes!.find((n) => n.id !== id)!;
    expect(original.createdBy).toBe('anna');
    expect(kopie.createdBy).toBe('bert');
    expect(kopie.createdAt).toBe('2026-07-19T11:00:00.000Z');
  });

  it('stempelt addDoc, addLink, stackDocs (neuer Stapel), extractPage, addCutout, addStamp, addFlag, addMark, addStroke, addClip', () => {
    let s = emptyState();
    s = applyCommand(s, { type: 'addDoc', payload: { fileId: 'f1', name: 'A.pdf', position: { x: 0, y: 0 } } }, anna);
    const doc1 = s.docs[0];
    expect(doc1.createdBy).toBe('anna');

    s = applyCommand(s, { type: 'addDoc', payload: { fileId: 'f2', name: 'B.pdf', position: { x: 100, y: 0 } } }, anna);
    const doc2 = s.docs.find((d) => d.fileId === 'f2')!;

    s = applyCommand(s, { type: 'addLink', payload: { fromId: doc1.id, toId: doc2.id } }, anna);
    expect(s.links[0].createdBy).toBe('anna');

    s = applyCommand(s, { type: 'addDoc', payload: { fileId: 'f3', name: 'C.pdf', position: { x: 200, y: 0 } } }, anna);
    const doc3 = s.docs.find((d) => d.fileId === 'f3')!;
    s = applyCommand(s, { type: 'stackDocs', payload: { draggedId: doc3.id, targetId: doc2.id } }, anna);
    const stack = s.stacks[0];
    expect(stack.createdBy).toBe('anna');

    // Weiteres Dokument in denselben (bestehenden) Stapel einordnen: KEIN erneuter Stempel.
    s = applyCommand(s, { type: 'addDoc', payload: { fileId: 'f4', name: 'D.pdf', position: { x: 300, y: 0 } } }, anna);
    const doc4 = s.docs.find((d) => d.fileId === 'f4')!;
    s = applyCommand(s, { type: 'stackDocs', payload: { draggedId: doc4.id, targetId: stack.id } }, bert);
    expect(s.stacks[0].createdBy).toBe('anna');

    s = applyCommand(s, { type: 'extractPage', payload: { docId: doc1.id, page: 1, position: { x: 400, y: 0 } } }, bert);
    const extracted = s.docs.find((d) => d.pageOnly === 1)!;
    expect(extracted.createdBy).toBe('bert');

    s = applyCommand(s, { type: 'addCutout', payload: { docId: doc1.id, page: 1, rect: { x: 0, y: 0, w: 10, h: 10 }, position: { x: 0, y: 100 } } }, anna);
    expect(s.cutouts![0].createdBy).toBe('anna');

    s = applyCommand(s, { type: 'addStamp', payload: { stamp: { docId: doc1.id, page: 1, x: 0, y: 0, angle: 0, text: 'ERLEDIGT', color: 'red', baseW: 100, baseH: 100 } } }, anna);
    expect(s.stamps![0].createdBy).toBe('anna');

    s = applyCommand(s, { type: 'addFlag', payload: { flag: { docId: doc1.id, page: 1, offset: 0.5, color: '#f5c518' } } }, anna);
    expect(s.flags![0].createdBy).toBe('anna');

    s = applyCommand(s, { type: 'addMark', payload: { mark: { docId: doc1.id, page: 1, rect: { x: 0, y: 0, w: 10, h: 10 }, kind: 'tippex' } } }, anna);
    expect(s.marks![0].createdBy).toBe('anna');

    s = applyCommand(s, { type: 'addStroke', payload: { stroke: { docId: doc1.id, page: 1, tool: 'pen', color: '#000', width: 2, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] } } }, anna);
    expect(s.strokes![0].createdBy).toBe('anna');

    s = applyCommand(s, { type: 'addClip', payload: { aId: doc1.id, bId: doc2.id } }, anna);
    const clipId = s.clips![0].id;
    expect(s.clips![0].createdBy).toBe('anna');

    // Beitritt zu einer BESTEHENDEN Klammer: kein neuer Stempel.
    s = applyCommand(s, { type: 'addClip', payload: { aId: doc1.id, bId: extracted.id } }, bert);
    expect(s.clips!.find((c) => c.id === clipId)!.createdBy).toBe('anna');

    // Zwei Klammern verschmelzen: Ergebnis behält den Stempel der ersten Gruppe, kein neuer Stempel.
    s = applyCommand(s, { type: 'addClip', payload: { aId: doc3.id, bId: doc4.id } }, bert);
    s = applyCommand(s, { type: 'addClip', payload: { aId: doc2.id, bId: doc3.id } }, bert);
    expect(s.clips!.length).toBe(1);
    expect(s.clips![0].createdBy).toBe('anna');
  });

  it('copyObject ohne meta: Kopie einer Annotation erbt NICHT die Provenienz des Originals', () => {
    let s = applyCommand(emptyState(), { type: 'addDoc', payload: { fileId: 'f1', name: 'A.pdf', position: { x: 0, y: 0 } } }, anna);
    const doc = s.docs[0];
    s = applyCommand(s, { type: 'addStamp', payload: { stamp: { docId: doc.id, page: 1, x: 0, y: 0, angle: 0, text: 'ERLEDIGT', color: 'red', baseW: 100, baseH: 100 } } }, anna);
    expect(s.stamps![0].createdBy).toBe('anna');

    // Karte OHNE meta kopieren (Alt-Client) — die mitkopierte Annotation darf die Original-Provenienz nicht erben.
    s = applyCommand(s, { type: 'copyObject', payload: { id: doc.id } });
    expect(s.stamps!.length).toBe(2);
    const kopie = s.stamps!.find((st) => st.docId !== doc.id)!;
    expect(kopie.createdBy).toBeUndefined();
    expect(kopie.createdAt).toBeUndefined();
  });

  it('trashObject setzt trashedBy; restoreObject stellt Original-Metadaten wieder her', () => {
    let s = addNote(emptyState(), anna);
    const id = s.notes![0].id;
    s = applyCommand(s, { type: 'trashObject', payload: { id, trashedAt: '2026-07-19T12:00:00.000Z' } }, bert);
    expect(s.trash![0].trashedBy).toBe('bert');
    const trashId = s.trash![0].id;
    s = applyCommand(s, { type: 'restoreObject', payload: { trashId } });
    expect(s.notes![0].createdBy).toBe('anna');
  });
});
