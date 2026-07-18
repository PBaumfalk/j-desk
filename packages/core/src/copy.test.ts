import { describe, expect, it } from 'vitest';
import { emptyState } from './model';
import { addDoc } from './documents';
import { addNote } from './notes';
import { addCutout } from './cutouts';
import { addStroke } from './ink';
import { addStamp } from './stamps';
import { stackDocs } from './stacks';
import { copyObject } from './copy';
import { applyCommand } from './commands';

describe('copy', () => {
  it('kopiert eine Karte inkl. Annotationen mit frischen ids, leicht versetzt', () => {
    let s = addDoc(emptyState(), 'f1', 'a.pdf', { x: 100, y: 100 }, 'd1');
    s = addStroke(s, { docId: 'd1', page: 1, tool: 'pen', color: '#1d3557', width: 1.5, points: [{ x: 0, y: 0 }, { x: 5, y: 5 }], id: 'sk1' });
    s = addStamp(s, { docId: 'd1', page: 1, x: 1, y: 1, angle: 0, text: 'KOPIE', color: 'blue', baseW: 595, baseH: 842, id: 'sp1' });
    s = copyObject(s, 'd1');
    expect(s.docs).toHaveLength(2);
    const kopie = s.docs[1];
    expect(kopie.id).not.toBe('d1');
    expect(kopie.fileId).toBe('f1');
    expect(kopie.position).toEqual({ x: 128, y: 120 });
    expect(s.strokes).toHaveLength(2);
    expect(s.stamps).toHaveLength(2);
    const strokeKopie = s.strokes!.find((st) => st.id !== 'sk1')!;
    expect(strokeKopie.docId).toBe(kopie.id);
  });

  it('kopiert Zettel und Ausschnitte', () => {
    let s = addDoc(emptyState(), 'f1', 'a.pdf', { x: 0, y: 0 }, 'd1');
    s = addNote(s, 'these', 'Text', { x: 300, y: 0 }, 'n1');
    s = addCutout(s, 'd1', 1, { x: 0, y: 0, w: 50, h: 40 }, { x: 500, y: 0 }, 'c1');
    s = copyObject(s, 'n1');
    s = copyObject(s, 'c1');
    expect(s.notes).toHaveLength(2);
    expect(s.cutouts).toHaveLength(2);
    expect(s.notes![1].text).toBe('Text');
  });

  it('wirft für Stapel und Unbekanntes', () => {
    let s = addDoc(emptyState(), 'f1', 'a.pdf', { x: 0, y: 0 }, 'd1');
    s = addDoc(s, 'f2', 'b.pdf', { x: 10, y: 10 }, 'd2');
    s = stackDocs(s, 'd2', 'd1', 'st1');
    expect(() => copyObject(s, 'st1')).toThrow('Stapel');
    expect(() => copyObject(s, 'nix')).toThrow('nicht gefunden');
  });

  it('Command copyObject über applyCommand', () => {
    const s = applyCommand(addDoc(emptyState(), 'f1', 'a.pdf', { x: 0, y: 0 }, 'd1'), { type: 'copyObject', payload: { id: 'd1' } });
    expect(s.docs).toHaveLength(2);
  });
});
