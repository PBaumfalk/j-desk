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
import { trashObject, restoreObject, emptyTrash, trashedFileIds, shredTrashItem } from './trash';
import { copyObject } from './copy';
import { applyCommand } from './commands';
import { addZeitleiste, addZeitleisteEintrag } from './zeitleiste';

const T = '2026-07-18T12:00:00.000Z';

function mitDoc() {
  return addDoc(emptyState(), 'f1', 'a.pdf', { x: 0, y: 0 }, 'd1');
}

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

  describe('shredTrashItem', () => {
    it('entfernt genau einen Eintrag endgültig — Wiederherstellen danach unmöglich', () => {
      let s = trashObject(mitDoc(), 'd1', '2026-07-19T10:00:00Z', 't1');
      s = addNote(s, 'notiz', 'bleibt', { x: 0, y: 0 }, 'n1');
      s = trashObject(s, 'n1', '2026-07-19T10:01:00Z', 't2');
      const nach = shredTrashItem(s, 't1');
      expect((nach.trash ?? []).map((t) => t.id)).toEqual(['t2']);
      expect(() => restoreObject(nach, 't1')).toThrow('nicht gefunden');
    });

    it('unbekannte trashId wird abgewiesen; Command-Weg funktioniert', () => {
      expect(() => shredTrashItem(emptyState(), 'nix')).toThrow('nicht gefunden');
      const s = trashObject(mitDoc(), 'd1', '2026-07-19T10:00:00Z', 't1');
      const nach = applyCommand(s, { type: 'shredTrashItem', payload: { trashId: 't1' } });
      expect(nach.trash ?? []).toEqual([]);
    });
  });

  describe('zeitleisten (09-02: Papierkorb — wegwerfen und vollständig wiederherstellen)', () => {
    function mitZeitleisteVoll() {
      let s = mitDoc();
      s = addZeitleiste(s, { x: 0, y: 0 }, 'z1');
      s = addZeitleisteEintrag(s, 'z1', 'd1', 'ereignis', 'genau', '2026-01-01', undefined, 'e1');
      s = addZeitleisteEintrag(s, 'z1', 'd1', 'frist', 'zeitraum', '2026-02-01', '2026-02-10', 'e2');
      s = addZeitleisteEintrag(s, 'z1', 'd1', 'zahlung', 'streitig', '2026-03-01', undefined, 'e3');
      return s;
    }

    it('eine Zeitleiste mit Einträgen landet mit kind "zeitleiste" im Korb, trägt den Kartennamen "Zeitleiste" und verschwindet vom Tisch', () => {
      const s = trashObject(mitZeitleisteVoll(), 'z1', T, 't1');
      expect(s.zeitleisten).toHaveLength(0);
      const item = s.trash?.[0];
      expect(item).toMatchObject({ id: 't1', kind: 'zeitleiste', name: 'Zeitleiste', trashedAt: T });
      expect(item?.payload.zeitleisten).toHaveLength(1);
      expect(item?.payload.zeitleisten[0].eintraege).toHaveLength(3);
    });

    it('wirft eine Zeitleiste mit drei Einträgen weg, stellt sie wieder her und vergleicht die Eintragsliste feldweise mit dem Ausgangszustand', () => {
      const vorher = mitZeitleisteVoll();
      const eintraegeVorher = vorher.zeitleisten![0].eintraege;
      let s = trashObject(vorher, 'z1', T, 't1');
      s = restoreObject(s, 't1');
      expect(s.trash).toHaveLength(0);
      expect(s.zeitleisten).toHaveLength(1);
      expect(s.zeitleisten![0]).toMatchObject({ id: 'z1', titel: 'Zeitleiste' });
      expect(s.zeitleisten![0].eintraege).toEqual(eintraegeVorher);
    });

    it('restore wirft, wenn eine Zeitleiste mit derselben id bereits wieder auf dem Tisch liegt', () => {
      let s = trashObject(mitZeitleisteVoll(), 'z1', T, 't1');
      s = { ...s, zeitleisten: [...(s.zeitleisten ?? []), { ...s.trash![0].payload.zeitleisten[0] }] }; // dieselbe id z1 künstlich zurück auf den Tisch
      expect(() => restoreObject(s, 't1')).toThrow('bereits');
    });

    it('eine Zeitleiste ohne Einträge lässt sich ebenso wegwerfen und wiederherstellen', () => {
      let s = addZeitleiste(mitDoc(), { x: 0, y: 0 }, 'z2');
      s = trashObject(s, 'z2', T, 't1');
      expect(s.zeitleisten).toHaveLength(0);
      expect(s.trash?.[0]?.payload.zeitleisten[0].eintraege).toHaveLength(0);
      s = restoreObject(s, 't1');
      expect(s.zeitleisten).toHaveLength(1);
      expect(s.zeitleisten![0].eintraege).toHaveLength(0);
    });

    it('ein Korb-Eintrag ohne zeitleisten-Feld im Payload (Bestandsdatenbank) lässt sich wiederherstellen, ohne eine Ausnahme zu werfen', () => {
      let s = trashObject(mitZeitleisteVoll(), 'z1', T, 't1');
      // Simuliert einen Korb-Eintrag aus einer Datenbank, die vor dieser Phase geschrieben wurde:
      // das Payload trägt kein zeitleisten-Feld.
      const altesPayload = { ...s.trash![0].payload } as Record<string, unknown>;
      delete altesPayload.zeitleisten;
      s = { ...s, trash: [{ ...s.trash![0], payload: altesPayload as typeof s.trash[0]['payload'] }] };
      const nach = restoreObject(s, 't1');
      expect(nach.zeitleisten ?? []).toHaveLength(0); // kein zeitleisten-Feld im Alt-Payload -> nichts wiederhergestellt, aber kein Absturz
    });
  });
});
