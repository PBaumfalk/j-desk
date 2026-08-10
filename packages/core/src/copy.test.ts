import { describe, expect, it } from 'vitest';
import { emptyState } from './model';
import { addDoc } from './documents';
import { addNote } from './notes';
import { addLegalObject, markTaskHandedOver } from './legalObjects';
import { addCutout } from './cutouts';
import { addStroke } from './ink';
import { addStamp } from './stamps';
import { stackDocs } from './stacks';
import { addTable } from './tables';
import { copyObject } from './copy';
import { applyCommand } from './commands';
import { setTaped } from './tape';

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

  it('kopiert ein juristisches Objekt mit frischer id, leicht versetzt', () => {
    let s = addLegalObject(emptyState(), 'tatsache', 'Fristablauf', { x: 100, y: 100 }, 'lo1');
    s = copyObject(s, 'lo1');
    expect(s.legalObjects).toHaveLength(2);
    const kopie = s.legalObjects![1];
    expect(kopie.id).not.toBe('lo1');
    expect(kopie.kind).toBe('tatsache');
    expect(kopie.text).toBe('Fristablauf');
    expect(kopie.position).toEqual({ x: 128, y: 120 });
  });

  // CR-04: die Kopie eines festgeklebten juristischen Objekts kam bisher weiterhin taped an
  // (sofort drag-gesperrt, wie bei doc/note/cutout ausdrücklich vermieden).
  it('kopiert ein festgeklebtes juristisches Objekt OHNE taped', () => {
    let s = addLegalObject(emptyState(), 'tatsache', 'Fristablauf', { x: 0, y: 0 }, 'lo1');
    s = setTaped(s, 'lo1', true);
    s = copyObject(s, 'lo1');
    const kopie = s.legalObjects!.find((o) => o.id !== 'lo1')!;
    expect(kopie.taped).toBeUndefined();
  });

  // CR-04: eine bereits an j-lawyer übergebene Aufgabe durfte durch Kopieren keine zweite,
  // fälschlich "übergebene" Aufgabe mit demselben jlDueDateId erzeugen — handedOverToJLawyer
  // wird laut docs/deployment/jlawyer-aufgabenuebergabe.md AUSSCHLIESSLICH serverseitig nach
  // Bestätigung durch j-lawyer gesetzt, nie optimistisch vom Client.
  it('kopiert eine übergebene Aufgabe als neue offene Aufgabe ohne Übergabe-Provenienz', () => {
    let s = addLegalObject(emptyState(), 'aufgabe', 'Frist wahren', { x: 0, y: 0 }, 'a1');
    s = markTaskHandedOver(s, 'a1', '2026-08-20T10:00:00.000Z', 'dd-1');
    s = copyObject(s, 'a1');
    const kopie = s.legalObjects!.find((o) => o.id !== 'a1')!;
    expect(kopie.status).toBe('offen');
    expect(kopie.handedOverToJLawyer).toBeUndefined();
  });

  // WR-01: copy.ts eigenes maxZ() beruecksichtigte tables nicht — eine Kopie neben einer
  // bereits vorhandenen Tabellenkarte mit hoeherem zIndex landete dahinter statt davor.
  it('legt eine Kopie ueber eine bereits vorhandene Tabellenkarte mit hoeherem zIndex', () => {
    let s = addDoc(emptyState(), 'f1', 'a.pdf', { x: 0, y: 0 }, 'd1');
    s = addTable(s, { x: 0, y: 0 }, 'tb1');
    s = { ...s, tables: s.tables!.map((t) => ({ ...t, zIndex: 99 })) };
    s = copyObject(s, 'd1');
    const kopie = s.docs.find((d) => d.id !== 'd1')!;
    expect(kopie.zIndex).toBeGreaterThan(99);
  });

  it('wirft für Stapel und Unbekanntes', () => {
    let s = addDoc(emptyState(), 'f1', 'a.pdf', { x: 0, y: 0 }, 'd1');
    s = addDoc(s, 'f2', 'b.pdf', { x: 10, y: 10 }, 'd2');
    s = stackDocs(s, 'd2', 'd1', 'st1');
    expect(() => copyObject(s, 'st1')).toThrow('Stapel');
    expect(() => copyObject(s, 'nix')).toThrow('nicht gefunden');
  });

  // WR-04: eine Tabellenkarten-id fiel bisher durch alle Zweige und landete in der
  // irreführenden "Objekt nicht gefunden"-Meldung, obwohl die Tabelle existiert — jetzt eine
  // eigene Fehlermeldung analog zum Stapel-Fall.
  it('wirft eine eigene Meldung für Tabellenkarten', () => {
    const s = addTable(emptyState(), { x: 0, y: 0 }, 'tb1');
    expect(() => copyObject(s, 'tb1')).toThrow('Tabellen');
  });

  it('Command copyObject über applyCommand', () => {
    const s = applyCommand(addDoc(emptyState(), 'f1', 'a.pdf', { x: 0, y: 0 }, 'd1'), { type: 'copyObject', payload: { id: 'd1' } });
    expect(s.docs).toHaveLength(2);
  });
});
