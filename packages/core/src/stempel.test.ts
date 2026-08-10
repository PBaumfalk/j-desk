import { describe, expect, it } from 'vitest';
import { emptyState, type DesktopState } from './model';
import { moveDoc, addDoc } from './documents';
import { editNote, addNote } from './notes';
import { findeObjekt, stempeleGeaenderte, VERSIONIERTE_ARTEN } from './stempel';
import { applyCommand, commandTypen } from './commands';
import { addCutout } from './cutouts';
import { addStroke } from './ink';
import { addMark } from './marks';
import { addStamp } from './stamps';
import { addFlag, FLAG_COLORS } from './flags';
import { addLink } from './links';
import { stackDocs, stapleStack } from './stacks';
import { addClip } from './clips';
import { trashObject } from './trash';
import { addLegalObject } from './legalObjects';
import { addTable, addTableRow, addTableFormulaColumn } from './tables';
import { addZeitleiste, addZeitleisteEintrag } from './zeitleiste';
import { addSitzungsmappe, addSitzungsmappeDoc, addOffeneFrage } from './sitzungsmappe';
import { addZone } from './zonen';

const S = { rev: 7, at: '2026-07-20T12:00:00.000Z', by: 'Frau Meier' };

function tisch(): DesktopState {
  let s = emptyState();
  s = addDoc(s, 'f1', 'Akte.pdf', { x: 0, y: 0 }, 'd1');
  s = addDoc(s, 'f2', 'Zweite.pdf', { x: 10, y: 0 }, 'd2');
  s = addNote(s, 'notiz', 'Notiz', { x: 5, y: 5 }, 'n1');
  return s;
}

describe('stempeleGeaenderte', () => {
  it('stempelt nur das beruehrte Objekt', () => {
    const alt = tisch();
    const neu = stempeleGeaenderte(alt, moveDoc(alt, 'd1', { x: 99, y: 99 }), S);

    const d1 = neu.docs.find((d) => d.id === 'd1')!;
    const d2 = neu.docs.find((d) => d.id === 'd2')!;
    expect(d1.updatedRev).toBe(7);
    expect(d1.updatedBy).toBe('Frau Meier');
    expect(d1.updatedAt).toBe(S.at);
    expect(d2.updatedRev).toBeUndefined();
  });

  it('stempelt ueber Objektarten hinweg', () => {
    const alt = tisch();
    const neu = stempeleGeaenderte(alt, editNote(alt, 'n1', 'geaendert'), S);
    expect(neu.notes!.find((n) => n.id === 'n1')!.updatedRev).toBe(7);
    expect(neu.docs.find((d) => d.id === 'd1')!.updatedRev).toBeUndefined();
  });

  it('stempelt neu erzeugte Objekte', () => {
    const alt = tisch();
    const neu = stempeleGeaenderte(alt, addDoc(alt, 'f3', 'Neu.pdf', { x: 1, y: 1 }, 'd3'), S);
    expect(neu.docs.find((d) => d.id === 'd3')!.updatedRev).toBe(7);
  });

  it('laesst den Papierkorb unberuehrt', () => {
    const alt: DesktopState = {
      ...tisch(),
      trash: [{
        id: 't1', at: '2026-07-19T00:00:00.000Z', trashedBy: 'Anwalt',
        payload: { docs: [], stacks: [], links: [], notes: [], strokes: [], stamps: [], flags: [], clips: [], marks: [], cutouts: [] },
      }],
    } as DesktopState;
    const neu = stempeleGeaenderte(alt, moveDoc(alt, 'd1', { x: 1, y: 1 }), S);
    expect(neu.trash).toBe(alt.trash);
  });

  it('aendert nichts, wenn der Command nichts veraendert hat', () => {
    const alt = tisch();
    const neu = stempeleGeaenderte(alt, alt, S);
    expect(neu).toBe(alt);
  });
});

describe('findeObjekt', () => {
  it('findet ueber alle versionierten Arten', () => {
    const s = tisch();
    expect(findeObjekt(s, 'd1')?.art).toBe('docs');
    expect(findeObjekt(s, 'n1')?.art).toBe('notes');
    expect(findeObjekt(s, 'gibt-es-nicht')).toBeUndefined();
  });

  it('findet eine Zone als art "zones" (13-02: Grundlage der Journal-CR-03-Auflösung und Offline-Dublettenerkennung)', () => {
    const s = addZone(emptyState(), 'Orientierung', { x: 0, y: 0, w: 10, h: 10 }, 'z1');
    expect(findeObjekt(s, 'z1')?.art).toBe('zones');
  });
});

/**
 * Reichhaltiger Aufbau für den Wächtertest: genug Objekte jeder Art, dass jeder Command-Typ
 * einen gültigen, realistischen Angriffspunkt hat.
 *
 * - d1, d2, d3: freie Karten. d3 trägt alle Annotationsarten (Strich, Fläche, Stempel, Fahne)
 *   sowie zwei Ausschnitte — Ziel für addStroke/addMark/addStamp/addFlag/addCutout/copyObject.
 * - st1 (sa, sb, sc): ungehefteter Stapel mit drei Karten — Entfernen einer Karte löst keinen
 *   Auto-Kollaps aus (der Stapel schrumpft auf zwei, nicht auf eine einzelne Karte).
 * - st2 (ka, kb): geheftetes Konvolut — Voraussetzung für expandStack.
 * - n1 (Notiz), n2 (To-do), nClip (Notiz, geklammert).
 * - c1 (Ausschnitt), cClip (Ausschnitt, geklammert).
 * - lnk1: Verknüpfung zwischen d1 und sa.
 * - clipA (nClip, cClip): wird von manchen Tests durch Entfernen eines Mitglieds aufgelöst.
 * - clipB (d1, d2): UNBETEILIGTE Klammer — muss bei jedem Entfernen woanders unberührt bleiben.
 *   Deckt genau die Strukturteilung von removeFromClips ab (siehe clips.ts).
 * - dKorb/t1: ein Papierkorb-Eintrag.
 */
function tischFuerWaechter(): DesktopState {
  let s = emptyState();

  s = addDoc(s, 'f1', 'Frei1.pdf', { x: 0, y: 0 }, 'd1');
  s = addDoc(s, 'f2', 'Frei2.pdf', { x: 20, y: 0 }, 'd2');
  s = addDoc(s, 'f3', 'Quelle.pdf', { x: 40, y: 0 }, 'd3');

  s = addDoc(s, 'f4', 'Stapel-a.pdf', { x: 100, y: 0 }, 'sa');
  s = addDoc(s, 'f5', 'Stapel-b.pdf', { x: 100, y: 40 }, 'sb');
  s = addDoc(s, 'f6', 'Stapel-c.pdf', { x: 100, y: 80 }, 'sc');
  s = stackDocs(s, 'sb', 'sa', 'st1');
  s = stackDocs(s, 'sc', 'st1');

  s = addDoc(s, 'f7', 'Konvolut-a.pdf', { x: 200, y: 0 }, 'ka');
  s = addDoc(s, 'f8', 'Konvolut-b.pdf', { x: 200, y: 40 }, 'kb');
  s = stackDocs(s, 'kb', 'ka', 'st2');
  s = stapleStack(s, 'st2');

  s = addNote(s, 'notiz', 'Normale Notiz', { x: 300, y: 0 }, 'n1');
  s = addNote(s, 'todo', 'Erledigen', { x: 300, y: 40 }, 'n2');
  s = addNote(s, 'notiz', 'Klammer-Notiz', { x: 300, y: 80 }, 'nClip');

  s = addCutout(s, 'd3', 1, { x: 0, y: 0, w: 50, h: 50 }, { x: 400, y: 0 }, 'c1');
  s = addCutout(s, 'd3', 1, { x: 60, y: 0, w: 50, h: 50 }, { x: 400, y: 60 }, 'cClip');

  s = addStroke(s, { id: 'str1', docId: 'd3', page: 1, tool: 'pen', color: '#000000', width: 2, points: [{ x: 0, y: 0 }, { x: 10, y: 10 }] });
  s = addMark(s, { id: 'mk1', docId: 'd3', page: 1, rect: { x: 0, y: 0, w: 20, h: 20 }, kind: 'redact' });
  s = addStamp(s, { id: 'stp1', docId: 'd3', page: 1, x: 10, y: 10, angle: 0, text: 'GEPRÜFT', color: 'blue', baseW: 500, baseH: 700 });
  s = addFlag(s, { id: 'fl1', docId: 'd3', page: 1, offset: 0.5, color: FLAG_COLORS[0] });

  s = addLink(s, 'd1', 'sa', 'lnk1');

  s = addClip(s, 'nClip', 'cClip', 'clipA');
  s = addClip(s, 'd1', 'd2', 'clipB');

  s = addDoc(s, 'f9', 'Korb.pdf', { x: 500, y: 0 }, 'dKorb');
  s = trashObject(s, 'dKorb', '2026-07-01T00:00:00.000Z', 't1');

  s = addLegalObject(s, 'tatsache', 'Juristisches Objekt', { x: 600, y: 0 }, 'lo1');
  s = addLegalObject(s, 'aufgabe', 'Aufgabe', { x: 700, y: 0 }, 'a1');

  s = addTable(s, { x: 800, y: 0 }, 'tb1');
  s = addTableRow(s, 'tb1', 'tbr1');
  s = addTableFormulaColumn(s, 'tb1', 'Summe', 'summe', undefined, undefined, 'sp1');

  s = addZeitleiste(s, { x: 900, y: 0 }, 'zt1');
  s = addZeitleisteEintrag(s, 'zt1', 'd1', 'ereignis', 'genau', '2026-01-01', undefined, 'zte1');

  s = addSitzungsmappe(s, 'Termin', 'sm1');
  s = addSitzungsmappeDoc(s, 'sm1', 'd1');
  // d3 statt d2 als zweiter Agenda-Eintrag: d2 bleibt frei für den addSitzungsmappeDoc-FAELLE-
  // Eintrag unten (sonst wäre dieser wegen der Idempotenz von addSitzungsmappeDoc ein No-op).
  s = addSitzungsmappeDoc(s, 'sm1', 'd3');
  s = addOffeneFrage(s, 'sm1', 'Wie ist der Streitwert?', 'frage1');

  // 02-07: feste layerId statt addCustomLayer() (das vergibt eine zufällige uid() —
  // FAELLE braucht eine im Payload fest referenzierbare id für setLayerExportierbar).
  s = { ...s, layers: [{ id: 'lay1', typ: 'custom', name: 'Testebene', exportierbar: false }] };

  // 13-02: eine Bestandszone — Ziel der renameZone/removeZone-FAELLE-Einträge unten.
  s = addZone(s, 'Bestandszone', { x: 1000, y: 0, w: 200, h: 200 }, 'z1');

  return s;
}

type Fall = {
  payload: Record<string, unknown>;
  /**
   * Objekte, deren Änderung fachlich beabsichtigt ist. Als Funktion nur für copyObject:
   * der Kopierer vergibt für Kopie und kopierte Annotationen immer neue, zufällige ids
   * (uid()) — im Payload nicht vorgebbar, daher aus dem Ergebnis abgeleitet statt fest verdrahtet.
   */
  darf: string[] | ((neu: DesktopState) => string[]);
};

/**
 * Beispielaufruf je Command-Typ: Payload und die IDs, die der Command laut seiner
 * Absicht berühren DARF. Der Test prüft, dass nicht mehr gestempelt wird.
 *
 * Jeder Command-Typ MUSS hier stehen. Fehlt einer, schlägt der letzte Test fehl —
 * genau das soll passieren, wenn jemand einen Command-Typ hinzufügt, ohne die
 * Auswirkung auf die Konflikterkennung zu bedenken.
 */
const FAELLE: Record<string, Fall> = {
  addDoc: { payload: { fileId: 'fNeu', name: 'Neu.pdf', position: { x: 1, y: 1 }, id: 'dNeu' }, darf: ['dNeu'] },
  moveDoc: { payload: { id: 'd1', position: { x: 50, y: 50 } }, darf: ['d1'] },
  bringToFront: { payload: { id: 'd2' }, darf: ['d2'] },
  removeDoc: {
    payload: { id: 'd2' },
    // d2 ist Mitglied von clipB (mit d1). Entfernen löst clipB auf (< 2 Mitglieder übrig) —
    // die UNBETEILIGTE clipA darf dabei nicht angefasst werden.
    darf: [],
  },
  setDocLandscape: { payload: { id: 'd1' }, darf: ['d1'] },
  addLink: { payload: { fromId: 'd1', toId: 'd2', id: 'lnkNeu' }, darf: ['lnkNeu'] },
  setLinkNote: { payload: { linkId: 'lnk1', note: 'neu' }, darf: ['lnk1'] },
  setLinkKind: { payload: { linkId: 'lnk1', kind: 'belegt' }, darf: ['lnk1'] },
  removeLink: { payload: { linkId: 'lnk1' }, darf: [] },
  addVersionLink: { payload: { olderId: 'd1', newerId: 'd2', id: 'vlNeu' }, darf: ['vlNeu'] },
  // lnk1 ist eine gewöhnliche Verknüpfung ohne Strukturkennzeichnung — removeVersionLink lässt
  // sie unangetastet (stilles No-op, s. links.ts removeVersionLink).
  removeVersionLink: { payload: { linkId: 'lnk1' }, darf: [] },
  stackDocs: {
    payload: { draggedId: 'd1', targetId: 'd2', id: 'stNeu' },
    // Nur der neue Stapel wird gestempelt: stackDocs ändert an d1/d2 selbst kein Feld
    // (Position/zIndex bleiben erhalten, sie werden nur über den Stapel gruppiert) —
    // die einzelnen Karten bleiben referenzgleich.
    darf: ['stNeu'],
  },
  removeFromStack: {
    payload: { docId: 'sb', position: { x: 5, y: 5 } },
    // sb bekommt eine neue Position, st1 (drei Karten, schrumpft auf zwei) bekommt neue
    // docIds — beides fachlich beabsichtigt. Kein Auto-Kollaps, weil zwei Karten übrig bleiben.
    darf: ['sb', 'st1'],
  },
  dissolveStack: {
    payload: { stackId: 'st1' },
    // Alle drei Karten werden neu positioniert (nebeneinander gelegt), der Stapel verschwindet.
    darf: ['sa', 'sb', 'sc'],
  },
  renameStack: { payload: { stackId: 'st1', name: 'Neuer Name' }, darf: ['st1'] },
  moveStack: { payload: { stackId: 'st1', position: { x: 7, y: 7 } }, darf: ['st1'] },
  removeStack: { payload: { stackId: 'st1' }, darf: [] },
  expandDoc: { payload: { id: 'd3' }, darf: ['d3'] },
  collapseDoc: { payload: { id: 'd3' }, darf: ['d3'] },
  setDocPage: { payload: { id: 'd3', page: 2 }, darf: ['d3'] },
  resizeDoc: { payload: { id: 'd3', size: { w: 600, h: 800 } }, darf: ['d3'] },
  extractPage: { payload: { docId: 'd3', page: 1, position: { x: 9, y: 9 }, id: 'dExtract' }, darf: ['dExtract'] },
  addStroke: {
    payload: {
      stroke: {
        docId: 'd3', page: 1, tool: 'pen', color: '#111111', width: 3,
        points: [{ x: 0, y: 0 }, { x: 5, y: 5 }], id: 'strNeu',
      },
    },
    darf: ['strNeu'],
  },
  removeStroke: { payload: { strokeId: 'str1' }, darf: [] },
  addNote: { payload: { kind: 'notiz', text: 'Neue Notiz', position: { x: 11, y: 11 }, id: 'nNeu' }, darf: ['nNeu'] },
  setNoteDone: { payload: { id: 'n2', done: true }, darf: ['n2'] },
  editNote: { payload: { id: 'n1', text: 'geändert' }, darf: ['n1'] },
  moveNote: { payload: { id: 'n1', position: { x: 12, y: 12 } }, darf: ['n1'] },
  removeNote: {
    payload: { id: 'nClip' },
    // nClip ist Mitglied von clipA (mit cClip) — löst clipA auf; clipB bleibt unberührt.
    darf: [],
  },
  addCutout: {
    payload: { docId: 'd3', page: 1, rect: { x: 5, y: 5, w: 10, h: 10 }, position: { x: 13, y: 13 }, id: 'cNeu' },
    darf: ['cNeu'],
  },
  moveCutout: { payload: { id: 'c1', position: { x: 14, y: 14 } }, darf: ['c1'] },
  removeCutout: {
    payload: { id: 'cClip' },
    // cClip ist Mitglied von clipA (mit nClip) — löst clipA auf; clipB bleibt unberührt.
    darf: [],
  },
  addMark: {
    payload: { mark: { docId: 'd3', page: 1, rect: { x: 0, y: 0, w: 15, h: 15 }, kind: 'tippex', id: 'mkNeu' } },
    darf: ['mkNeu'],
  },
  removeMark: { payload: { markId: 'mk1' }, darf: [] },
  addStamp: {
    payload: {
      stamp: {
        docId: 'd3', page: 1, x: 20, y: 20, angle: 5, text: 'KOPIE', color: 'blue',
        baseW: 500, baseH: 700, id: 'stpNeu',
      },
    },
    darf: ['stpNeu'],
  },
  removeStamp: { payload: { stampId: 'stp1' }, darf: [] },
  addFlag: {
    payload: { flag: { docId: 'd3', page: 1, offset: 0.3, color: FLAG_COLORS[1], id: 'flNeu' } },
    darf: ['flNeu'],
  },
  removeFlag: { payload: { flagId: 'fl1' }, darf: [] },
  addClip: { payload: { aId: 'n1', bId: 'c1', id: 'clipNeu' }, darf: ['clipNeu'] },
  removeClip: { payload: { clipId: 'clipA' }, darf: [] },
  tapeObject: { payload: { id: 'd1' }, darf: ['d1'] },
  untapeObject: { payload: { id: 'd1' }, darf: ['d1'] },
  stapleStack: { payload: { stackId: 'st1' }, darf: ['st1'] },
  unstapleStack: { payload: { stackId: 'st2' }, darf: ['st2'] },
  expandStack: { payload: { id: 'st2' }, darf: ['st2'] },
  collapseStack: { payload: { id: 'st2' }, darf: ['st2'] },
  setStackPage: { payload: { id: 'st2', page: 2 }, darf: ['st2'] },
  resizeStack: { payload: { id: 'st2', size: { w: 700, h: 900 } }, darf: ['st2'] },
  trashObject: {
    payload: { id: 'd1', trashedAt: '2026-07-20T00:00:00.000Z', trashId: 'tNeu' },
    // d1 ist Mitglied von clipB (mit d2) — löst clipB auf; clipA bleibt unberührt. Der
    // Papierkorb selbst ist nicht versioniert (trash gehört nicht zu VERSIONIERTE_ARTEN).
    darf: [],
  },
  restoreObject: { payload: { trashId: 't1' }, darf: ['dKorb'] },
  shredTrashItem: { payload: { trashId: 't1' }, darf: [] },
  emptyTrash: { payload: {}, darf: [] },
  copyObject: {
    payload: { id: 'd3' },
    // copyObject vergibt für Kopie und kopierte Annotationen immer neue, zufällige ids (uid())
    // — im Payload nicht vorgebbar. darf wird daher aus dem Ergebnis abgeleitet: die Kopie
    // (gleiche fileId wie d3, andere id) und ihre kopierten Annotationen (docId = Kopie-id).
    // Ausschnitte werden NICHT kopiert (copy.ts kennt keine cutouts).
    darf: (neu) => {
      const kopie = neu.docs.find((d) => d.fileId === 'f3' && d.id !== 'd3')!;
      return [
        kopie.id,
        ...(neu.strokes ?? []).filter((x) => x.docId === kopie.id).map((x) => x.id),
        ...(neu.marks ?? []).filter((x) => x.docId === kopie.id).map((x) => x.id),
        ...(neu.stamps ?? []).filter((x) => x.docId === kopie.id).map((x) => x.id),
        ...(neu.flags ?? []).filter((x) => x.docId === kopie.id).map((x) => x.id),
      ];
    },
  },
  setBackground: {
    payload: {
      background: { themeId: 'navy_blue', material: 'wood', brightness: 1.1, textureIntensity: 0.4, vignette: false },
    },
    // background ist kein Array von Objekten mit id — nicht in VERSIONIERTE_ARTEN, nie gestempelt.
    darf: [],
  },
  changeLayerId: { payload: { objectId: 'd2', layerId: 'privat' }, darf: ['d2'] },
  setFreigabe: { payload: { objectId: 'd2', freigabe: 'export' }, darf: ['d2'] },
  addCustomLayer: {
    payload: { name: 'Notizen von Yvonne' },
    // layers ist kein VERSIONIERTE_ARTEN-Array (kein Konfliktobjekt) — nie gestempelt.
    darf: [],
  },
  setLayerExportierbar: {
    payload: { layerId: 'lay1', exportierbar: true },
    // layers ist kein VERSIONIERTE_ARTEN-Array (kein Konfliktobjekt) — nie gestempelt.
    darf: [],
  },
  addLegalObject: { payload: { kind: 'tatsache', text: 'Neues Objekt', position: { x: 15, y: 15 }, id: 'loNeu' }, darf: ['loNeu'] },
  editLegalObject: { payload: { id: 'lo1', text: 'geändert' }, darf: ['lo1'] },
  moveLegalObject: { payload: { id: 'lo1', position: { x: 16, y: 16 } }, darf: ['lo1'] },
  removeLegalObject: { payload: { id: 'lo1' }, darf: [] },
  setTaskStatus: { payload: { id: 'a1', status: 'in-arbeit' }, darf: ['a1'] },
  setTaskPriority: { payload: { id: 'a1', priority: 'hoch' }, darf: ['a1'] },
  setTaskAssignee: { payload: { id: 'a1', assignee: 'Frau Meier' }, darf: ['a1'] },
  setTaskDueDate: { payload: { id: 'a1', dueDate: '2026-09-01' }, darf: ['a1'] },
  setTaskDocRef: { payload: { id: 'a1', docRef: { docId: 'd1' } }, darf: ['a1'] },
  removeTaskDocRef: { payload: { id: 'a1' }, darf: ['a1'] },
  markTaskHandedOver: { payload: { id: 'a1', at: '2026-08-20T10:00:00.000Z', jlDueDateId: 'dd-1' }, darf: ['a1'] },
  addTable: { payload: { position: { x: 17, y: 17 }, id: 'tbNeu' }, darf: ['tbNeu'] },
  moveTable: { payload: { id: 'tb1', position: { x: 18, y: 18 } }, darf: ['tb1'] },
  renameTable: { payload: { id: 'tb1', titel: 'Neuer Titel' }, darf: ['tb1'] },
  removeTable: { payload: { id: 'tb1' }, darf: [] },
  expandTable: { payload: { id: 'tb1' }, darf: ['tb1'] },
  collapseTable: { payload: { id: 'tb1' }, darf: ['tb1'] },
  resizeTable: { payload: { id: 'tb1', size: { w: 700, h: 500 } }, darf: ['tb1'] },
  addTableRow: { payload: { tableId: 'tb1', id: 'tbrNeu' }, darf: ['tb1'] },
  setTableCell: { payload: { tableId: 'tb1', rowId: 'tbr1', spaltenId: 'sp1', wert: '10,00' }, darf: ['tb1'] },
  removeTableRow: { payload: { tableId: 'tb1', rowId: 'tbr1' }, darf: ['tb1'] },
  setTableRowBeleg: { payload: { tableId: 'tb1', rowId: 'tbr1', belegRef: { docId: 'd1' } }, darf: ['tb1'] },
  addTableColumn: { payload: { tableId: 'tb1', titel: 'Betrag', art: 'zahl', id: 'spRohNeu' }, darf: ['tb1'] },
  addTableFormulaColumn: { payload: { tableId: 'tb1', titel: 'Zinsen', formel: 'zinsen', id: 'spNeu' }, darf: ['tb1'] },
  removeTableColumn: { payload: { tableId: 'tb1', spaltenId: 'sp1' }, darf: ['tb1'] },
  addZeitleiste: { payload: { position: { x: 19, y: 19 }, id: 'ztNeu' }, darf: ['ztNeu'] },
  moveZeitleiste: { payload: { id: 'zt1', position: { x: 20, y: 20 } }, darf: ['zt1'] },
  removeZeitleiste: { payload: { id: 'zt1' }, darf: [] },
  expandZeitleiste: { payload: { id: 'zt1' }, darf: ['zt1'] },
  collapseZeitleiste: { payload: { id: 'zt1' }, darf: ['zt1'] },
  resizeZeitleiste: { payload: { id: 'zt1', size: { w: 900, h: 400 } }, darf: ['zt1'] },
  addZeitleisteEintrag: {
    payload: { zeitleisteId: 'zt1', objRef: 'd1', art: 'ereignis', zeitangabe: 'genau', datum: '2026-02-01', id: 'zteNeu' },
    darf: ['zt1'],
  },
  setZeitleisteEintrag: { payload: { zeitleisteId: 'zt1', eintragId: 'zte1', art: 'frist' }, darf: ['zt1'] },
  removeZeitleisteEintrag: { payload: { zeitleisteId: 'zt1', eintragId: 'zte1' }, darf: ['zt1'] },
  addSitzungsmappe: { payload: { titel: 'Neuer Termin', id: 'smNeu' }, darf: ['smNeu'] },
  addSitzungsmappeDoc: { payload: { id: 'sm1', docId: 'd2' }, darf: ['sm1'] },
  renameSitzungsmappe: { payload: { id: 'sm1', titel: 'Neuer Termin-Titel' }, darf: ['sm1'] },
  removeSitzungsmappe: { payload: { id: 'sm1' }, darf: [] },
  removeSitzungsmappeDoc: { payload: { id: 'sm1', docId: 'd3' }, darf: ['sm1'] },
  verschiebeSitzungsmappeDoc: { payload: { id: 'sm1', docId: 'd1', richtung: 1 }, darf: ['sm1'] },
  addOffeneFrage: { payload: { id: 'sm1', text: 'Neue Frage?' }, darf: ['sm1'] },
  setOffeneFrageText: { payload: { id: 'sm1', frageId: 'frage1', text: 'geändert' }, darf: ['sm1'] },
  setOffeneFrageBeantwortet: { payload: { id: 'sm1', frageId: 'frage1', beantwortet: true }, darf: ['sm1'] },
  removeOffeneFrage: { payload: { id: 'sm1', frageId: 'frage1' }, darf: ['sm1'] },
  // 13-02: Zonen sind versionierte Objekte (Planner-Entscheidung) — addZone stempelt die neue
  // Zone, renameZone die umbenannte, removeZone entfernt ohne Stempelreste.
  addZone: { payload: { id: 'zNeu', name: 'Neue Zone', rect: { x: 950, y: 0, w: 100, h: 100 } }, darf: ['zNeu'] },
  renameZone: { payload: { id: 'z1', name: 'Umbenannte Zone' }, darf: ['z1'] },
  removeZone: { payload: { id: 'z1' }, darf: [] },
};

describe('Waechtertest: Strukturteilung der Handler', () => {
  it.each(Object.keys(FAELLE))('%s stempelt nur die beabsichtigten Objekte', (typ) => {
    const { payload, darf } = FAELLE[typ];
    const alt = tischFuerWaechter(); // reichhaltiger Aufbau mit d1, d2, n1, st1, …
    const neu = stempeleGeaenderte(alt, applyCommand(alt, { type: typ, payload }), S);

    const gestempelt: string[] = [];
    for (const art of VERSIONIERTE_ARTEN) {
      for (const o of ((neu as never)[art] ?? []) as { id: string; updatedRev?: number }[]) {
        if (o.updatedRev === S.rev) gestempelt.push(o.id);
      }
    }
    const erwartet = typeof darf === 'function' ? darf(neu) : darf;
    expect(gestempelt.sort()).toEqual([...erwartet].sort());
  });

  it('kennt jeden Command-Typ der Registry', () => {
    // Schlaegt an, sobald ein Command-Typ hinzukommt, ohne dass jemand geprueft hat,
    // welche Objekte er beruehrt — die Voraussetzung der zentralen Stempelung.
    expect(Object.keys(FAELLE).sort()).toEqual(commandTypen().sort());
  });
});
