import type { DesktopState, Vec2, Size, FileKind, CommandMeta } from './model';
import { addDoc, moveDoc, bringToFront, setDocLandscape } from './documents';
import {
  addLink, setLinkNote, removeLink, setLinkKind, addVersionLink, removeVersionLink,
  LINK_MEANINGS, type LinkMeaning,
} from './links';
import { stackDocs, removeFromStack, dissolveStack, renameStack, moveStack, stapleStack, unstapleStack } from './stacks';
import { removeDoc, removeStack } from './removal';
import { expandDoc, collapseDoc, setDocPage, resizeDoc, extractPage } from './viewer';
import { expandStack, collapseStack, setStackPage, resizeStack } from './konvolut';
import { addStroke, removeStroke, type Stroke, type StrokeTool } from './ink';
import { addNote, editNote, moveNote, removeNote, setNoteDone, type NoteKind } from './notes';
import {
  addLegalObject, editLegalObject, moveLegalObject, removeLegalObject,
  setTaskStatus, setTaskAssignee, setTaskDueDate, setTaskPriority, setTaskDocRef, removeTaskDocRef,
  markTaskHandedOver,
  LEGAL_OBJECT_KINDS, TASK_STATUSES, TASK_PRIORITIES,
  type LegalObjectKind, type TaskStatus, type TaskPriority, type TaskDocRef,
} from './legalObjects';
import {
  addTable, moveTable, renameTable, removeTable, expandTable, collapseTable, resizeTable,
  addTableRow, setTableCell, removeTableRow, setTableRowBeleg, addTableColumn, addTableFormulaColumn, removeTableColumn,
  type BelegRef,
} from './tables';
import {
  addZeitleiste, moveZeitleiste, removeZeitleiste, expandZeitleiste, collapseZeitleiste, resizeZeitleiste,
  addZeitleisteEintrag, setZeitleisteEintrag, removeZeitleisteEintrag,
  ZEITLEISTE_EINTRAG_ARTEN, ZEITANGABE_ARTEN,
  type ZeitleisteEintragArt, type ZeitangabeArt,
} from './zeitleiste';
import { FORMEL_ARTEN, type FormelArt } from './tableFormulas';
import {
  addSitzungsmappe, addSitzungsmappeDoc, renameSitzungsmappe, removeSitzungsmappe,
  removeSitzungsmappeDoc, verschiebeSitzungsmappeDoc, addOffeneFrage, setOffeneFrageText,
  setOffeneFrageBeantwortet, removeOffeneFrage,
} from './sitzungsmappe';
import { addCutout, moveCutout, removeCutout } from './cutouts';
import { addMark, removeMark, type Mark, type MarkKind } from './marks';
import { addStamp, removeStamp, type Stamp } from './stamps';
import { addFlag, removeFlag, type Flag } from './flags';
import { addClip, removeClip } from './clips';
import { setTaped } from './tape';
import { trashObject, restoreObject, emptyTrash, shredTrashItem } from './trash';
import { copyObject } from './copy';
import { setBackground, type DeskBackground } from './background';
import { addCustomLayer, changeLayerId, setLayerExportierbar } from './layers';
import { ALLE_FREIGABEN, setFreigabeIn, type Freigabe } from './freigabe';
import { addZone, renameZone, removeZone, normalisiereZonenName } from './zonen';
import { valideExternRef } from './extern';
import { CommandError } from './errors';

// Re-Export: die Fehlerklasse lebt seit 13-02 in errors.ts (Blatt-Modul, damit reine
// Validator-Module wie extern.ts sie ohne Zirkularimport werfen können) — sämtliche
// Bestands-Importe aus './commands' bleiben funktionsfähig.
export { CommandError } from './errors';

export interface Command {
  type: string;
  payload?: Record<string, unknown>;
}

// Exportiert seit Phase 12 (vorschlagAnwenden/inverse validieren Register-Nutzdaten mit
// denselben deutschen Feldfehlern wie die Kommando-Handler — keine zweite Validator-Quelle).
export function id(v: unknown, field: string): string {
  if (typeof v !== 'string' || v === '') throw new CommandError(`Feld "${field}" fehlt oder ist leer`);
  return v;
}

export function optId(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/** Optionales Zusatzfeld: nur übernehmen, wenn String; sonst ignorieren (kein Fehler — Zusatznutzen, kein Pflichtfeld).
 *  Exportiert seit Phase 12 (vorschlagAnwenden validiert optionale Register-Nutzdaten damit). */
export function optStr(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

export function text(v: unknown, field: string): string {
  if (typeof v !== 'string') throw new CommandError(`Feld "${field}" fehlt oder ist kein Text`);
  return v;
}

export function vec(v: unknown, field: string): Vec2 {
  const p = v as Vec2 | undefined;
  if (!p || typeof p !== 'object' || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
    throw new CommandError(`Feld "${field}" fehlt oder ist keine Position {x, y}`);
  }
  return { x: p.x, y: p.y };
}

// Exportiert seit Phase 12 (vorschlagAnwenden prüft numerische Register-Nutzdaten — Seiten,
// Offsets, Geometrie — mit demselben deutschen Feldfehler wie die Kommando-Handler).
export function num(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new CommandError(`Feld "${field}" fehlt oder ist keine Zahl`);
  return v;
}

function size(v: unknown, field: string): Size {
  const p = v as Size | undefined;
  if (!p || typeof p !== 'object' || !Number.isFinite(p.w) || !Number.isFinite(p.h)) {
    throw new CommandError(`Feld "${field}" fehlt oder ist keine Größe {w, h}`);
  }
  return { w: p.w, h: p.h };
}

/** Freigabe-Stufen-Validator (EXP-03): nur die drei bekannten Stufen aus ALLE_FREIGABEN. */
function freigabe(v: unknown): Freigabe {
  if (typeof v !== 'string' || !(ALLE_FREIGABEN as readonly string[]).includes(v)) {
    throw new CommandError('Feld "freigabe" muss eine bekannte Stufe sein');
  }
  return v as Freigabe;
}

/** Literal-Union-Validator für juristische Objekttypen (LEGAL-01, T-08-01): nur die 13
 *  bekannten Typen aus LEGAL_OBJECT_KINDS — exakt nach dem Vorbild von freigabe() oben. */
function legalObjectKind(v: unknown): LegalObjectKind {
  if (typeof v !== 'string' || !(LEGAL_OBJECT_KINDS as readonly string[]).includes(v)) {
    throw new CommandError('Feld "kind" muss ein bekannter juristischer Objekttyp sein');
  }
  return v as LegalObjectKind;
}

/** Literal-Union-Validator für Aufgaben-Status (TASK-01) — exakt nach dem Vorbild von freigabe(). */
function taskStatus(v: unknown): TaskStatus {
  if (typeof v !== 'string' || !(TASK_STATUSES as readonly string[]).includes(v)) {
    throw new CommandError('Feld "status" muss ein bekannter Aufgaben-Status sein');
  }
  return v as TaskStatus;
}

/** Literal-Union-Validator für Aufgaben-Priorität (TASK-01) — exakt nach dem Vorbild von freigabe(). */
function taskPriority(v: unknown): TaskPriority {
  if (typeof v !== 'string' || !(TASK_PRIORITIES as readonly string[]).includes(v)) {
    throw new CommandError('Feld "priority" muss eine bekannte Priorität sein');
  }
  return v as TaskPriority;
}

/** Literal-Union-Validator für Verknüpfungsbedeutungen (LEGAL-02, T-08-11): nur die 11
 *  bekannten Werte aus LINK_MEANINGS — exakt nach dem Vorbild von freigabe() oben, mit einer
 *  Ausnahme: undefined/null sind gültige Eingaben und bedeuten „Bedeutung entfernen". */
function linkMeaning(v: unknown): LinkMeaning | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || !(LINK_MEANINGS as readonly string[]).includes(v)) {
    throw new CommandError('Feld "kind" muss eine bekannte Verknüpfungsbedeutung sein');
  }
  return v as LinkMeaning;
}

const TABLE_COLUMN_ARTEN = ['text', 'zahl', 'datum'] as const;
type TableColumnArt = (typeof TABLE_COLUMN_ARTEN)[number];

/** Literal-Union-Validator für Rohwert-Spaltenarten (08-07, addTableColumn) — exakt nach dem
 *  Vorbild von freigabe()/formelArt(). 'formel' ist hier bewusst KEIN gültiger Wert:
 *  Formelspalten entstehen ausschließlich über addTableFormulaColumn(). */
function tableColumnArt(v: unknown): TableColumnArt {
  if (typeof v !== 'string' || !(TABLE_COLUMN_ARTEN as readonly string[]).includes(v)) {
    throw new CommandError('Feld "art" muss text, zahl oder datum sein');
  }
  return v as TableColumnArt;
}

/** Literal-Union-Validator für Formelarten (CALC-01, T-08-26): nur die 4 bekannten Arten aus
 *  FORMEL_ARTEN — exakt nach dem Vorbild von freigabe() oben. */
function formelArt(v: unknown): FormelArt {
  if (typeof v !== 'string' || !(FORMEL_ARTEN as readonly string[]).includes(v)) {
    throw new CommandError('Feld "formel" muss eine bekannte Formelart sein');
  }
  return v as FormelArt;
}

/** Literal-Union-Validator für Zeitleisten-Eintragsarten (CHRONO-01, 09-01): nur die 7
 *  bekannten Werte aus ZEITLEISTE_EINTRAG_ARTEN — exakt nach dem Vorbild von tableColumnArt(). */
function zeitleisteEintragArt(v: unknown): ZeitleisteEintragArt {
  if (typeof v !== 'string' || !(ZEITLEISTE_EINTRAG_ARTEN as readonly string[]).includes(v)) {
    throw new CommandError('Feld "art" muss eine bekannte Zeitleisten-Eintragsart sein');
  }
  return v as ZeitleisteEintragArt;
}

/** Literal-Union-Validator für Zeitangaben (CHRONO-02, 09-01): nur die 5 bekannten Werte aus
 *  ZEITANGABE_ARTEN — exakt nach dem Vorbild von tableColumnArt(). undefined ist gültig (Default
 *  'genau' entsteht im Kern, s. zeitleiste.ts pruefeZeitangabe). */
function zeitangabeArt(v: unknown): ZeitangabeArt | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || !(ZEITANGABE_ARTEN as readonly string[]).includes(v)) {
    throw new CommandError('Feld "zeitangabe" muss eine bekannte Zeitangabe sein');
  }
  return v as ZeitangabeArt;
}

/** Literal-Validator für die Umsortier-Richtung einer Sitzungsmappe-Agenda (SESS-02, 11-05): nur
 *  -1 (nach oben) und +1 (nach unten) sind gültig — exakt nach dem Vorbild von freigabe()/
 *  tableColumnArt(), hier über ein Zwei-Werte-Literal statt eines String-Arrays. */
function verschiebeRichtung(v: unknown): -1 | 1 {
  if (v !== -1 && v !== 1) throw new CommandError('Feld "richtung" muss -1 oder 1 sein');
  return v;
}

/** Zonenname-Validator (UX-03, 13-02): Pflichttext, serverseitig normalisiert über
 *  normalisiereZonenName (Trim + NFC + 40, T-13-02-06) — ein nur aus Leerraum bestehender
 *  Name ist nach der Normalisierung leer und damit ungültig. */
function zonesName(v: unknown): string {
  const name = normalisiereZonenName(text(v, 'name'));
  if (name === '') throw new CommandError('Feld "name" fehlt oder ist leer');
  return name;
}

/**
 * Baut das Teilaktualisierungs-Feldobjekt für setZeitleisteEintrag: nur Schlüssel, die im
 * Payload TATSÄCHLICH vorkommen, werden übernommen (`in`-Prüfung statt `!== undefined` —
 * Muster wie in zeitleiste.ts setZeitleisteEintrag dokumentiert). `datumBis: null` im Payload
 * bedeutet „ausdrücklich entfernen" (JSON kennt kein undefined) und wird zu einem vorhandenen
 * Schlüssel mit Wert `undefined`.
 */
function zeitleisteEintragFelder(p: Record<string, unknown>): {
  art?: ZeitleisteEintragArt; zeitangabe?: ZeitangabeArt; datum?: string; datumBis?: string;
} {
  const felder: { art?: ZeitleisteEintragArt; zeitangabe?: ZeitangabeArt; datum?: string; datumBis?: string } = {};
  if ('art' in p && p.art !== undefined) felder.art = zeitleisteEintragArt(p.art);
  if ('zeitangabe' in p && p.zeitangabe !== undefined) felder.zeitangabe = zeitangabeArt(p.zeitangabe);
  if ('datum' in p && p.datum !== undefined) felder.datum = text(p.datum, 'datum');
  if ('datumBis' in p) felder.datumBis = p.datumBis === null ? undefined : text(p.datumBis, 'datumBis');
  return felder;
}

/** Validiert den Beleg-Bezug einer Tabellenzeile (CALC-01): docId Pflicht bei gesetztem Bezug;
 *  undefined/null entfernen den Bezug — Muster identisch zu linkMeaning() (setLinkKind). */
function belegRef(v: unknown): BelegRef | undefined {
  if (v === undefined || v === null) return undefined;
  const r = v as Partial<BelegRef> | undefined;
  if (!r || typeof r !== 'object') throw new CommandError('Feld "belegRef" fehlt oder ist kein Objekt');
  const docId = id(r.docId, 'belegRef.docId');
  const page = typeof r.page === 'number' && Number.isFinite(r.page) ? r.page : undefined;
  const cutoutId = typeof r.cutoutId === 'string' && r.cutoutId !== '' ? r.cutoutId : undefined;
  return { docId, ...(page !== undefined ? { page } : {}), ...(cutoutId !== undefined ? { cutoutId } : {}) };
}

/** Optionale numerische Formel-Parameter (z. B. Zinssatz, Tage, Anzahl) — jeder Wert muss eine
 *  endliche Zahl sein, sonst CommandError. */
function tableParameter(v: unknown): Record<string, number> | undefined {
  if (v === undefined) return undefined;
  if (!v || typeof v !== 'object') throw new CommandError('Feld "parameter" ist kein Objekt');
  const eingabe = v as Record<string, unknown>;
  const ausgabe: Record<string, number> = {};
  for (const schluessel of Object.keys(eingabe)) {
    const wert = eingabe[schluessel];
    if (typeof wert !== 'number' || !Number.isFinite(wert)) {
      throw new CommandError(`Feld "parameter.${schluessel}" ist keine Zahl`);
    }
    ausgabe[schluessel] = wert;
  }
  return ausgabe;
}

/** Validiert den Bezug zu Dokument/Fundstelle einer Aufgabe (TASK-01): docId Pflicht,
 *  page/cutoutId werden nur übernommen, wenn sie den erwarteten Typ haben. */
function taskDocRef(v: unknown): TaskDocRef {
  const r = v as Partial<TaskDocRef> | undefined;
  if (!r || typeof r !== 'object') throw new CommandError('Feld "docRef" fehlt');
  const docId = id(r.docId, 'docRef.docId');
  const page = typeof r.page === 'number' && Number.isFinite(r.page) ? r.page : undefined;
  const cutoutId = typeof r.cutoutId === 'string' && r.cutoutId !== '' ? r.cutoutId : undefined;
  return { docId, ...(page !== undefined ? { page } : {}), ...(cutoutId !== undefined ? { cutoutId } : {}) };
}

function wrap(fn: () => DesktopState): DesktopState {
  try {
    return fn();
  } catch (e) {
    if (e instanceof CommandError) throw e;
    throw new CommandError(e instanceof Error ? e.message : 'Ungültige Aktion');
  }
}

const handlers: Record<string, (s: DesktopState, p: Record<string, unknown>, m?: CommandMeta) => DesktopState> = {
  addDoc: (s, p, m) => addDoc(s, id(p.fileId, 'fileId'), text(p.name, 'name'), vec(p.position, 'position'), optId(p.id), p.kind as FileKind | undefined, m, valideExternRef(p.extern)),
  moveDoc: (s, p) => moveDoc(s, id(p.id, 'id'), vec(p.position, 'position')),
  bringToFront: (s, p) => bringToFront(s, id(p.id, 'id')),
  removeDoc: (s, p) => removeDoc(s, id(p.id, 'id')),
  setDocLandscape: (s, p) => setDocLandscape(s, id(p.id, 'id')),
  addLink: (s, p, m) => addLink(s, id(p.fromId, 'fromId'), id(p.toId, 'toId'), optId(p.id), m),
  setLinkNote: (s, p) => setLinkNote(s, id(p.linkId, 'linkId'), text(p.note, 'note')),
  setLinkKind: (s, p) => wrap(() => setLinkKind(s, id(p.linkId, 'linkId'), linkMeaning(p.kind))),
  removeLink: (s, p) => removeLink(s, id(p.linkId, 'linkId')),
  addVersionLink: (s, p, m) => wrap(() => addVersionLink(s, id(p.olderId, 'olderId'), id(p.newerId, 'newerId'), optId(p.id), m)),
  removeVersionLink: (s, p) => wrap(() => removeVersionLink(s, id(p.linkId, 'linkId'))),
  stackDocs: (s, p, m) => stackDocs(s, id(p.draggedId, 'draggedId'), id(p.targetId, 'targetId'), optId(p.id), m),
  removeFromStack: (s, p) => removeFromStack(s, id(p.docId, 'docId'), vec(p.position, 'position')),
  dissolveStack: (s, p) => dissolveStack(s, id(p.stackId, 'stackId')),
  renameStack: (s, p) => renameStack(s, id(p.stackId, 'stackId'), text(p.name, 'name')),
  moveStack: (s, p) => moveStack(s, id(p.stackId, 'stackId'), vec(p.position, 'position')),
  removeStack: (s, p) => removeStack(s, id(p.stackId, 'stackId')),
  expandDoc: (s, p) => wrap(() => expandDoc(s, id(p.id, 'id'))),
  collapseDoc: (s, p) => wrap(() => collapseDoc(s, id(p.id, 'id'))),
  setDocPage: (s, p) => wrap(() => setDocPage(s, id(p.id, 'id'), num(p.page, 'page'))),
  resizeDoc: (s, p) => wrap(() => resizeDoc(s, id(p.id, 'id'), size(p.size, 'size'))),
  extractPage: (s, p, m) => wrap(() => extractPage(s, id(p.docId, 'docId'), num(p.page, 'page'), vec(p.position, 'position'), optId(p.id), m)),
  addStroke: (s, p, m) => wrap(() => addStroke(s, strokePayload(p.stroke), m)),
  removeStroke: (s, p) => wrap(() => removeStroke(s, id(p.strokeId, 'strokeId'))),
  addNote: (s, p, m) => {
    // SESS-03: das Kennzeichen wird nur als echter Boolean akzeptiert — dieselbe
    // explizite Prüfung, die setNoteDone für „done" vorführt (T-11-05).
    if (p.sitzungsnotiz !== undefined && typeof p.sitzungsnotiz !== 'boolean') {
      throw new CommandError('Feld "sitzungsnotiz" muss true oder false sein');
    }
    // EXT-01 (13-02): optionale extern-Markierung — Validator-Position hier im Handler-Zweig
    // (Trennung Payload-Validierung vs. Domänenlogik, Bestandsmuster).
    const extern = valideExternRef(p.extern);
    const optionen = {
      ...(p.sitzungsnotiz !== undefined ? { sitzungsnotiz: p.sitzungsnotiz as boolean } : {}),
      ...(extern !== undefined ? { extern } : {}),
    };
    return wrap(() => addNote(s, p.kind as NoteKind, text(p.text, 'text'), vec(p.position, 'position'), optId(p.id),
      p.customLabel === undefined ? undefined : text(p.customLabel, 'customLabel'), m,
      Object.keys(optionen).length > 0 ? optionen : undefined));
  },
  setNoteDone: (s, p) => {
    if (typeof p.done !== 'boolean') throw new CommandError('Feld "done" muss true oder false sein');
    return wrap(() => setNoteDone(s, id(p.id, 'id'), p.done as boolean));
  },
  editNote: (s, p) => wrap(() => editNote(s, id(p.id, 'id'), text(p.text, 'text'), valideExternRef(p.extern))),
  moveNote: (s, p) => wrap(() => moveNote(s, id(p.id, 'id'), vec(p.position, 'position'))),
  removeNote: (s, p) => wrap(() => removeNote(s, id(p.id, 'id'))),
  addLegalObject: (s, p, m) => wrap(() => addLegalObject(s, legalObjectKind(p.kind), text(p.text, 'text'), vec(p.position, 'position'), optId(p.id), m)),
  editLegalObject: (s, p) => wrap(() => editLegalObject(s, id(p.id, 'id'), text(p.text, 'text'))),
  moveLegalObject: (s, p) => wrap(() => moveLegalObject(s, id(p.id, 'id'), vec(p.position, 'position'))),
  removeLegalObject: (s, p) => wrap(() => removeLegalObject(s, id(p.id, 'id'))),
  setTaskStatus: (s, p) => wrap(() => setTaskStatus(s, id(p.id, 'id'), taskStatus(p.status))),
  setTaskPriority: (s, p) => wrap(() => setTaskPriority(s, id(p.id, 'id'), taskPriority(p.priority))),
  setTaskAssignee: (s, p) => wrap(() => setTaskAssignee(s, id(p.id, 'id'), text(p.assignee, 'assignee'))),
  setTaskDueDate: (s, p) => wrap(() => setTaskDueDate(s, id(p.id, 'id'), text(p.dueDate, 'dueDate'))),
  setTaskDocRef: (s, p) => wrap(() => setTaskDocRef(s, id(p.id, 'id'), taskDocRef(p.docRef))),
  removeTaskDocRef: (s, p) => wrap(() => removeTaskDocRef(s, id(p.id, 'id'))),
  // TASK-02 (08-08): serverseitig NACH j-lawyer-Bestätigung angewendet (app.ts handover-Route) —
  // at/jlDueDateId sind serverseitige Fakten, keine Nutzereingabe, aber genauso über den
  // Command-Pfad validiert wie jedes andere Feld (kein zweiter, ungeprüfter Schreibweg).
  markTaskHandedOver: (s, p) => wrap(() => markTaskHandedOver(s, id(p.id, 'id'), text(p.at, 'at'), text(p.jlDueDateId, 'jlDueDateId'))),
  addTable: (s, p, m) => wrap(() => addTable(s, vec(p.position, 'position'), optId(p.id), m)),
  moveTable: (s, p) => wrap(() => moveTable(s, id(p.id, 'id'), vec(p.position, 'position'))),
  renameTable: (s, p) => wrap(() => renameTable(s, id(p.id, 'id'), text(p.titel, 'titel'))),
  removeTable: (s, p) => wrap(() => removeTable(s, id(p.id, 'id'))),
  expandTable: (s, p) => wrap(() => expandTable(s, id(p.id, 'id'))),
  collapseTable: (s, p) => wrap(() => collapseTable(s, id(p.id, 'id'))),
  resizeTable: (s, p) => wrap(() => resizeTable(s, id(p.id, 'id'), size(p.size, 'size'))),
  addTableRow: (s, p) => wrap(() => addTableRow(s, id(p.tableId, 'tableId'), optId(p.id))),
  setTableCell: (s, p) => wrap(() => setTableCell(s, id(p.tableId, 'tableId'), id(p.rowId, 'rowId'), id(p.spaltenId, 'spaltenId'), text(p.wert, 'wert'))),
  removeTableRow: (s, p) => wrap(() => removeTableRow(s, id(p.tableId, 'tableId'), id(p.rowId, 'rowId'))),
  setTableRowBeleg: (s, p) => wrap(() => setTableRowBeleg(s, id(p.tableId, 'tableId'), id(p.rowId, 'rowId'), belegRef(p.belegRef))),
  addTableColumn: (s, p) => wrap(() => addTableColumn(s, id(p.tableId, 'tableId'), text(p.titel, 'titel'), tableColumnArt(p.art), optId(p.id))),
  addTableFormulaColumn: (s, p) => wrap(() => addTableFormulaColumn(
    s, id(p.tableId, 'tableId'), text(p.titel, 'titel'), formelArt(p.formel),
    optStr(p.quelleSpalteId), tableParameter(p.parameter), optId(p.id),
  )),
  removeTableColumn: (s, p) => wrap(() => removeTableColumn(s, id(p.tableId, 'tableId'), id(p.spaltenId, 'spaltenId'))),
  addZeitleiste: (s, p, m) => wrap(() => addZeitleiste(s, vec(p.position, 'position'), optId(p.id), m)),
  moveZeitleiste: (s, p) => wrap(() => moveZeitleiste(s, id(p.id, 'id'), vec(p.position, 'position'))),
  removeZeitleiste: (s, p) => wrap(() => removeZeitleiste(s, id(p.id, 'id'))),
  expandZeitleiste: (s, p) => wrap(() => expandZeitleiste(s, id(p.id, 'id'))),
  collapseZeitleiste: (s, p) => wrap(() => collapseZeitleiste(s, id(p.id, 'id'))),
  resizeZeitleiste: (s, p) => wrap(() => resizeZeitleiste(s, id(p.id, 'id'), size(p.size, 'size'))),
  addZeitleisteEintrag: (s, p) => wrap(() => addZeitleisteEintrag(
    s, id(p.zeitleisteId, 'zeitleisteId'), id(p.objRef, 'objRef'), zeitleisteEintragArt(p.art),
    zeitangabeArt(p.zeitangabe), text(p.datum, 'datum'), optStr(p.datumBis), optId(p.id),
  )),
  setZeitleisteEintrag: (s, p) => wrap(() => setZeitleisteEintrag(
    s, id(p.zeitleisteId, 'zeitleisteId'), id(p.eintragId, 'eintragId'), zeitleisteEintragFelder(p),
  )),
  removeZeitleisteEintrag: (s, p) => wrap(() => removeZeitleisteEintrag(s, id(p.zeitleisteId, 'zeitleisteId'), id(p.eintragId, 'eintragId'))),
  addSitzungsmappe: (s, p, m) => wrap(() => addSitzungsmappe(s, text(p.titel, 'titel'), optId(p.id), m)),
  addSitzungsmappeDoc: (s, p) => wrap(() => addSitzungsmappeDoc(s, id(p.id, 'id'), id(p.docId, 'docId'))),
  renameSitzungsmappe: (s, p) => wrap(() => renameSitzungsmappe(s, id(p.id, 'id'), text(p.titel, 'titel'))),
  removeSitzungsmappe: (s, p) => wrap(() => removeSitzungsmappe(s, id(p.id, 'id'))),
  removeSitzungsmappeDoc: (s, p) => wrap(() => removeSitzungsmappeDoc(s, id(p.id, 'id'), id(p.docId, 'docId'))),
  verschiebeSitzungsmappeDoc: (s, p) => wrap(() => verschiebeSitzungsmappeDoc(s, id(p.id, 'id'), id(p.docId, 'docId'), verschiebeRichtung(p.richtung))),
  addOffeneFrage: (s, p) => wrap(() => addOffeneFrage(s, id(p.id, 'id'), text(p.text, 'text'), optId(p.frageId))),
  setOffeneFrageText: (s, p) => wrap(() => setOffeneFrageText(s, id(p.id, 'id'), id(p.frageId, 'frageId'), text(p.text, 'text'))),
  setOffeneFrageBeantwortet: (s, p) => {
    if (typeof p.beantwortet !== 'boolean') throw new CommandError('Feld "beantwortet" muss true oder false sein');
    return wrap(() => setOffeneFrageBeantwortet(s, id(p.id, 'id'), id(p.frageId, 'frageId'), p.beantwortet as boolean));
  },
  removeOffeneFrage: (s, p) => wrap(() => removeOffeneFrage(s, id(p.id, 'id'), id(p.frageId, 'frageId'))),
  addCutout: (s, p, m) => wrap(() => addCutout(s, id(p.docId, 'docId'), num(p.page, 'page'), rect(p.rect), vec(p.position, 'position'), optId(p.id), m,
    { textSnapshot: optStr(p.textSnapshot), fileSha256: optStr(p.fileSha256) })),
  moveCutout: (s, p) => wrap(() => moveCutout(s, id(p.id, 'id'), vec(p.position, 'position'))),
  removeCutout: (s, p) => wrap(() => removeCutout(s, id(p.id, 'id'))),
  addMark: (s, p, m) => wrap(() => addMark(s, markPayload(p.mark), m)),
  removeMark: (s, p) => wrap(() => removeMark(s, id(p.markId, 'markId'))),
  addStamp: (s, p, m) => wrap(() => addStamp(s, stampPayload(p.stamp), m)),
  removeStamp: (s, p) => wrap(() => removeStamp(s, id(p.stampId, 'stampId'))),
  addFlag: (s, p, m) => wrap(() => addFlag(s, flagPayload(p.flag), m)),
  removeFlag: (s, p) => wrap(() => removeFlag(s, id(p.flagId, 'flagId'))),
  addClip: (s, p, m) => wrap(() => addClip(s, id(p.aId, 'aId'), id(p.bId, 'bId'), optId(p.id), m)),
  removeClip: (s, p) => wrap(() => removeClip(s, id(p.clipId, 'clipId'))),
  tapeObject: (s, p) => wrap(() => setTaped(s, id(p.id, 'id'), true)),
  untapeObject: (s, p) => wrap(() => setTaped(s, id(p.id, 'id'), false)),
  stapleStack: (s, p) => wrap(() => stapleStack(s, id(p.stackId, 'stackId'))),
  unstapleStack: (s, p) => wrap(() => unstapleStack(s, id(p.stackId, 'stackId'))),
  expandStack: (s, p) => wrap(() => expandStack(s, id(p.id, 'id'))),
  collapseStack: (s, p) => wrap(() => collapseStack(s, id(p.id, 'id'))),
  setStackPage: (s, p) => wrap(() => setStackPage(s, id(p.id, 'id'), num(p.page, 'page'))),
  resizeStack: (s, p) => wrap(() => resizeStack(s, id(p.id, 'id'), size(p.size, 'size'))),
  trashObject: (s, p, m) => wrap(() => trashObject(s, id(p.id, 'id'), text(p.trashedAt, 'trashedAt'), optId(p.trashId), m)),
  restoreObject: (s, p) => wrap(() => restoreObject(s, id(p.trashId, 'trashId'))),
  shredTrashItem: (s, p) => wrap(() => shredTrashItem(s, id(p.trashId, 'trashId'))),
  emptyTrash: (s) => emptyTrash(s),
  copyObject: (s, p, m) => wrap(() => copyObject(s, id(p.id, 'id'), m)),
  setBackground: (s, p) => wrap(() => setBackground(s, backgroundPayload(p.background))),
  changeLayerId: (s, p, m) => wrap(() => changeLayerId(s, id(p.objectId, 'objectId'), text(p.layerId, 'layerId'), m)),
  setFreigabe: (s, p) => wrap(() => setFreigabeIn(s, id(p.objectId, 'objectId'), freigabe(p.freigabe))),
  addCustomLayer: (s, p, m) => wrap(() => addCustomLayer(s, text(p.name, 'name'), m, Boolean(p.exportierbar))),
  setLayerExportierbar: (s, p, m) => wrap(() => setLayerExportierbar(s, id(p.layerId, 'layerId'), Boolean(p.exportierbar), m)),
  // UX-03 (13-02): Zonen — Desk-Infrastruktur ohne Referenzfelder; rect läuft über den
  // Bestands-Rechteck-Validator (kein neuer Geometrie-Validator).
  addZone: (s, p, m) => wrap(() => addZone(s, zonesName(p.name), rect(p.rect), optId(p.id), m)),
  renameZone: (s, p) => wrap(() => renameZone(s, id(p.id, 'id'), zonesName(p.name))),
  removeZone: (s, p) => wrap(() => removeZone(s, id(p.id, 'id'))),
};

function backgroundPayload(v: unknown): DeskBackground {
  const b = v as Partial<DeskBackground> | undefined;
  if (!b || typeof b !== 'object') throw new CommandError('Feld "background" fehlt');
  const themeId = text(b.themeId, 'background.themeId') as DeskBackground['themeId'];
  const material = text(b.material, 'background.material') as DeskBackground['material'];
  const brightness = num(b.brightness, 'background.brightness');
  const textureIntensity = num(b.textureIntensity, 'background.textureIntensity');
  if (typeof b.vignette !== 'boolean') throw new CommandError('Feld "background.vignette" muss true oder false sein');
  return { themeId, material, brightness, textureIntensity, vignette: b.vignette };
}

function rect(v: unknown): { x: number; y: number; w: number; h: number } {
  const r = v as { x: number; y: number; w: number; h: number } | undefined;
  if (!r || typeof r !== 'object' || !Number.isFinite(r.x) || !Number.isFinite(r.y) || !Number.isFinite(r.w) || !Number.isFinite(r.h)) {
    throw new CommandError('Feld "rect" fehlt oder ist kein Rechteck {x, y, w, h}');
  }
  return { x: r.x, y: r.y, w: r.w, h: r.h };
}

function strokePayload(v: unknown): Omit<Stroke, 'id'> & { id?: string } {
  const st = v as Partial<Stroke> | undefined;
  if (!st || typeof st !== 'object') throw new CommandError('Feld "stroke" fehlt');
  if (!Array.isArray(st.points)) throw new CommandError('Feld "stroke.points" fehlt');
  return {
    ...(typeof st.id === 'string' && st.id !== '' ? { id: st.id } : {}),
    docId: id(st.docId, 'stroke.docId'),
    page: num(st.page, 'stroke.page'),
    tool: st.tool as StrokeTool,
    color: text(st.color, 'stroke.color'),
    width: num(st.width, 'stroke.width'),
    points: st.points.map((p, i) => vec(p, `stroke.points[${i}]`)),
  };
}

function markPayload(v: unknown): Omit<Mark, 'id'> & { id?: string } {
  const m = v as Partial<Mark> | undefined;
  if (!m || typeof m !== 'object') throw new CommandError('Feld "mark" fehlt');
  const textSnapshot = optStr(m.textSnapshot);
  const fileSha256 = optStr(m.fileSha256);
  return {
    ...(typeof m.id === 'string' && m.id !== '' ? { id: m.id } : {}),
    docId: id(m.docId, 'mark.docId'),
    page: num(m.page, 'mark.page'),
    rect: rect(m.rect),
    kind: m.kind as MarkKind,
    ...(textSnapshot !== undefined ? { textSnapshot } : {}),
    ...(fileSha256 !== undefined ? { fileSha256 } : {}),
  };
}

function stampPayload(v: unknown): Omit<Stamp, 'id'> & { id?: string } {
  const st = v as Partial<Stamp> | undefined;
  if (!st || typeof st !== 'object') throw new CommandError('Feld "stamp" fehlt');
  return {
    ...(typeof st.id === 'string' && st.id !== '' ? { id: st.id } : {}),
    docId: id(st.docId, 'stamp.docId'),
    page: num(st.page, 'stamp.page'),
    x: num(st.x, 'stamp.x'),
    y: num(st.y, 'stamp.y'),
    angle: num(st.angle, 'stamp.angle'),
    text: text(st.text, 'stamp.text'),
    color: st.color as Stamp['color'],
    ...(st.date !== undefined ? { date: text(st.date, 'stamp.date') } : {}),
    baseW: num(st.baseW, 'stamp.baseW'),
    baseH: num(st.baseH, 'stamp.baseH'),
  };
}

function flagPayload(v: unknown): Omit<Flag, 'id'> & { id?: string } {
  const f = v as Partial<Flag> | undefined;
  if (!f || typeof f !== 'object') throw new CommandError('Feld "flag" fehlt');
  return {
    ...(typeof f.id === 'string' && f.id !== '' ? { id: f.id } : {}),
    docId: id(f.docId, 'flag.docId'),
    page: num(f.page, 'flag.page'),
    offset: num(f.offset, 'flag.offset'),
    color: text(f.color, 'flag.color'),
    ...(f.label !== undefined ? { label: text(f.label, 'flag.label') } : {}),
  };
}

export function applyCommand(state: DesktopState, cmd: Command, meta?: CommandMeta): DesktopState {
  const handler = handlers[cmd.type];
  if (!handler) throw new CommandError(`Unbekanntes Kommando: ${String(cmd.type)}`);
  return handler(state, cmd.payload ?? {}, meta);
}

/** Alle bekannten Command-Typen. Für den Wächtertest der Stempelung: Er läuft über
 *  diese Liste, damit ein neu hinzugefügter Command-Typ nicht unbemerkt durchrutscht. */
export function commandTypen(): string[] {
  return Object.keys(handlers);
}
