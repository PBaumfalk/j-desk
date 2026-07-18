import { describe, expect, it } from 'vitest';
import { emptyState } from './model';
import { addDoc } from './documents';
import { addNote } from './notes';
import { addLink } from './links';
import { addStroke } from './ink';
import { addMark } from './marks';
import { addStamp } from './stamps';
import { addFlag, FLAG_COLORS } from './flags';
import { stackDocs, stapleStack } from './stacks';
import { addClip } from './clips';
import { trashObject, restoreObject, emptyTrash, trashedFileIds } from './trash';
import { copyObject } from './copy';
import { applyCommand } from './commands';

const T = '2026-07-18T12:00:00.000Z';

function voll() {
  let s = addDoc(emptyState(), 'f1', 'a.pdf', { x: 0, y: 0 }, 'd1');
  s = addNote(s, 'frage', 'Warum?', { x: 400, y: 0 }, 'n1');
  s = addLink(s, 'd1', 'n1', 'l1');
  s = addStroke(s, { docId: 'd1', page: 1, tool: 'pen', color: '#1d3557', width: 1.5, points: [{ x: 0, y: 0 }, { x: 5, y: 5 }], id: 'sk1' });
  s = addMark(s, { docId: 'd1', page: 1, rect: { x: 0, y: 0, w: 9, h: 9 }, kind: 'redact', id: 'm1' });
  s = addStamp(s, { docId: 'd1', page: 1, x: 1, y: 1, angle: 0, text: 'KOPIE', color: 'blue', baseW: 595, baseH: 842, id: 'sp1' });
  return addFlag(s, { docId: 'd1', page: 1, offset: 0.2, color: FLAG_COLORS[0], id: 'fg1' });
}

describe('trash', () => {
  it('legt eine Karte samt Annotationen in den Korb, kappt Schnüre und Klammern', () => {
    let s = addClip(voll(), 'd1', 'n1', 'c1');
    s = trashObject(s, 'd1', T, 't1');
    expect(s.docs).toHaveLength(0);
    expect(s.links).toHaveLength(0);
    expect(s.clips).toHaveLength(0);
    expect(s.strokes).toHaveLength(0);
    expect(s.marks).toHaveLength(0);
    const item = s.trash?.[0];
    expect(item).toMatchObject({ id: 't1', kind: 'doc', name: 'a.pdf', trashedAt: T });
    expect(item?.payload.docs).toHaveLength(1);
    expect(item?.payload.strokes).toHaveLength(1);
    expect(item?.payload.marks).toHaveLength(1);
    expect(item?.payload.stamps).toHaveLength(1);
    expect(item?.payload.flags).toHaveLength(1);
  });

  it('restoreObject legt alles zurück (ohne Schnüre) und leert den Korb-Eintrag', () => {
    let s = trashObject(voll(), 'd1', T, 't1');
    s = restoreObject(s, 't1');
    expect(s.trash).toHaveLength(0);
    expect(s.docs).toHaveLength(1);
    expect(s.strokes).toHaveLength(1);
    expect(s.stamps).toHaveLength(1);
    expect(s.links).toHaveLength(0); // Schnüre kommen nicht zurück — dokumentiert
  });

  it('Stapel wandert mit allen Mitgliedern und deren Annotationen in den Korb', () => {
    let s = addDoc(voll(), 'f2', 'b.pdf', { x: 200, y: 0 }, 'd2');
    s = stackDocs(s, 'd2', 'd1', 'st1');
    s = stapleStack(s, 'st1');
    s = trashObject(s, 'st1', T, 't1');
    expect(s.docs).toHaveLength(0);
    expect(s.stacks).toHaveLength(0);
    expect(s.trash?.[0]?.kind).toBe('stack');
    expect(s.trash?.[0]?.payload.docs).toHaveLength(2);
    expect(s.trash?.[0]?.payload.stacks).toHaveLength(1);
    expect(trashedFileIds(s).sort()).toEqual(['f1', 'f2']);
    s = restoreObject(s, 't1');
    expect(s.docs).toHaveLength(2);
    expect(s.stacks?.[0]).toMatchObject({ id: 'st1', stapled: true });
  });

  it('restore wirft nicht mehr wegen gleicher fileId — seit dem Kopierer sind fileId-Duplikate legitim', () => {
    let s = trashObject(voll(), 'd1', T, 't1');
    s = addDoc(s, 'f1', 'a.pdf', { x: 50, y: 50 }, 'd9'); // andere ID, gleiche fileId liegt schon auf dem Tisch
    s = restoreObject(s, 't1');
    expect(s.docs.map((d) => d.id).sort()).toEqual(['d1', 'd9']); // beide Karten liegen da
  });

  it('restore wirft weiterhin, wenn genau dieselbe Dokument-ID bereits wieder auf dem Tisch liegt', () => {
    let s = trashObject(voll(), 'd1', T, 't1');
    s = { ...s, docs: [...s.docs, { ...s.trash![0].payload.docs[0] }] }; // dieselbe doc-ID d1 künstlich zurück auf den Tisch
    expect(() => restoreObject(s, 't1')).toThrow('bereits');
  });

  it('Kopie trashen und wiederherstellen: 2 Karten mit gleicher fileId liegen am Ende auf dem Tisch', () => {
    let s = addDoc(emptyState(), 'f1', 'a.pdf', { x: 0, y: 0 }, 'd1');
    s = copyObject(s, 'd1'); // Kopie bekommt neue ID, gleiche fileId
    const kopieId = s.docs.find((d) => d.id !== 'd1')!.id;
    s = trashObject(s, kopieId, T, 't-kopie');
    s = restoreObject(s, 't-kopie');
    expect(s.docs).toHaveLength(2);
    expect(s.docs.map((d) => d.fileId)).toEqual(['f1', 'f1']);
  });

  it('Zettel und unbekannte Objekte; emptyTrash leert endgültig', () => {
    let s = trashObject(voll(), 'n1', T, 't1');
    expect(s.notes).toHaveLength(0);
    expect(s.trash?.[0]).toMatchObject({ kind: 'note', name: 'Warum?' });
    expect(() => trashObject(s, 'nix', T)).toThrow('nicht gefunden');
    expect(emptyTrash(s).trash).toHaveLength(0);
  });

  it('Commands trashObject/restoreObject/emptyTrash über applyCommand', () => {
    let s = applyCommand(voll(), { type: 'trashObject', payload: { id: 'd1', trashedAt: T, trashId: 't1' } });
    expect(s.trash).toHaveLength(1);
    s = applyCommand(s, { type: 'restoreObject', payload: { trashId: 't1' } });
    expect(s.docs).toHaveLength(1);
    expect(applyCommand(s, { type: 'emptyTrash' }).trash).toEqual([]);
    expect(() => applyCommand(s, { type: 'trashObject', payload: { id: 'd1' } })).toThrow(); // trashedAt fehlt
  });
});
