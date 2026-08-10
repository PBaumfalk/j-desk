import type { Command } from './commands';

/**
 * Objekt-Bezug von Commands (CR-03/CR-04): zwei serverseitige Mechanismen müssen wissen, auf
 * WELCHES Objekt sich ein Command-Payload bezieht —
 *
 * 1. die Journal-Payload-Projektion (server/journal.ts, Pfad 7 der 10-Pfade-Garantie): ein
 *    Journal-Eintrag, dessen referenziertes Objekt für den Betrachter aktuell unsichtbar ist,
 *    wird ausgelassen (fail-closed) — sonst laufen Volltexte/Positionen privat gestellter
 *    Objekte über die Historie weiter (INHALT_OBJEKT_ID).
 * 2. die Ebenen-Bearbeitungsprüfung im Command-Pfad (server/app.ts, CR-04): Mutationen an
 *    Objekten auf fremden privaten Ebenen werden mit 403 abgelehnt (ZIEL_OBJEKT_IDS).
 *
 * Beide Tabellen leben HIER im Core (statt beim jeweiligen Server-Verbraucher), weil sie die
 * Payload-Formen der Command-Typen spiegeln — ein Wächtertest (objektbezug.test.ts) sichert
 * gegen commandTypen() ab, dass kein neuer Command-Typ unklassifiziert durchrutscht.
 */

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

const verschachtelteId = (p: Record<string, unknown>, schluessel: string): string | undefined =>
  str((p[schluessel] as Record<string, unknown> | undefined)?.id);

const verschachtelteDocId = (p: Record<string, unknown>, schluessel: string): string | undefined =>
  str((p[schluessel] as Record<string, unknown> | undefined)?.docId);

const liste = (...ids: (string | undefined)[]): string[] => ids.filter((id): id is string => id !== undefined);

/**
 * ID des INHALTS-tragenden Objekts je Command-Typ — bei erzeugenden Commands die (optionale,
 * clientvergebene) ID des NEUEN Objekts, bei mutierenden die ID des bestehenden Zielobjekts.
 * Fehlt die ID im Payload (Erzeugungs-Command ohne Client-ID), ist der Journal-Eintrag nicht
 * auflösbar und fiele fail-closed aus der projizierten Historie ALLER Betrachter heraus —
 * genau deshalb injiziert der Server fehlende Erzeuger-IDs VOR der Anwendung
 * (stelleErzeugerIdSicher unten, verdrahtet in server/deskStore.ts, WR-02): der Core
 * (`optId()`) übernimmt eine mitgeschickte ID anstelle der internen uid(), Objekt und
 * Journal-Eintrag tragen dadurch dieselbe ID.
 *
 * Lösch-/Korb-Lifecycle-Commands (remove*, trashObject, restoreObject, shredTrashItem,
 * emptyTrash) stehen hier bewusst NICHT drin: ihr referenziertes Objekt ist nach Anwendung
 * per Definition nicht mehr im Live-State (die Korb-Kopie findet der Journal-Resolver
 * seit WR-01, aber diese Einträge sind inhaltsleer — nur IDs/Zeitstempel — und brauchen
 * keine Sichtprüfung).
 */
export const INHALT_OBJEKT_ID: Record<string, (p: Record<string, unknown>) => string | undefined> = {
  // Erzeugende Commands (eigene, optionale Client-ID des neuen Objekts).
  addDoc: (p) => str(p.id),
  addNote: (p) => str(p.id),
  addCutout: (p) => str(p.id),
  addMark: (p) => verschachtelteId(p, 'mark'),
  addStroke: (p) => verschachtelteId(p, 'stroke'),
  addStamp: (p) => verschachtelteId(p, 'stamp'),
  addFlag: (p) => verschachtelteId(p, 'flag'),
  addLink: (p) => str(p.id),
  addVersionLink: (p) => str(p.id),
  addClip: (p) => str(p.id),
  stackDocs: (p) => str(p.id),
  extractPage: (p) => str(p.id),
  copyObject: (p) => str(p.id),
  addLegalObject: (p) => str(p.id),
  addTable: (p) => str(p.id),
  addZeitleiste: (p) => str(p.id),
  addSitzungsmappe: (p) => str(p.id),
  // 13-02: addZone trägt die Zonen-id als Top-Level-id (Journal-Auflösbarkeit + Offline-Dedupe).
  addZone: (p) => str(p.id),
  // Mutierende Commands (bestehendes Zielobjekt).
  moveDoc: (p) => str(p.id),
  bringToFront: (p) => str(p.id),
  setDocLandscape: (p) => str(p.id),
  expandDoc: (p) => str(p.id),
  collapseDoc: (p) => str(p.id),
  setDocPage: (p) => str(p.id),
  resizeDoc: (p) => str(p.id),
  editNote: (p) => str(p.id),
  moveNote: (p) => str(p.id),
  setNoteDone: (p) => str(p.id),
  editLegalObject: (p) => str(p.id),
  moveLegalObject: (p) => str(p.id),
  setTaskStatus: (p) => str(p.id),
  setTaskPriority: (p) => str(p.id),
  setTaskAssignee: (p) => str(p.id),
  setTaskDueDate: (p) => str(p.id),
  setTaskDocRef: (p) => str(p.id),
  removeTaskDocRef: (p) => str(p.id),
  markTaskHandedOver: (p) => str(p.id),
  moveTable: (p) => str(p.id),
  renameTable: (p) => str(p.id),
  expandTable: (p) => str(p.id),
  collapseTable: (p) => str(p.id),
  resizeTable: (p) => str(p.id),
  addTableRow: (p) => str(p.tableId),
  setTableCell: (p) => str(p.tableId),
  removeTableRow: (p) => str(p.tableId),
  setTableRowBeleg: (p) => str(p.tableId),
  addTableColumn: (p) => str(p.tableId),
  addTableFormulaColumn: (p) => str(p.tableId),
  removeTableColumn: (p) => str(p.tableId),
  moveZeitleiste: (p) => str(p.id),
  expandZeitleiste: (p) => str(p.id),
  collapseZeitleiste: (p) => str(p.id),
  resizeZeitleiste: (p) => str(p.id),
  addZeitleisteEintrag: (p) => str(p.zeitleisteId),
  setZeitleisteEintrag: (p) => str(p.zeitleisteId),
  removeZeitleisteEintrag: (p) => str(p.zeitleisteId),
  addSitzungsmappeDoc: (p) => str(p.id),
  // 11-05: renameSitzungsmappe/removeSitzungsmappeDoc/verschiebeSitzungsmappeDoc/addOffeneFrage/
  // setOffeneFrageText/setOffeneFrageBeantwortet/removeOffeneFrage mutieren allesamt eine
  // BESTEHENDE, weiterhin live liegende Sitzungsmappe (nie das ganze Objekt entfernend) — exakt
  // dieselbe Einordnung wie addZeitleisteEintrag/setZeitleisteEintrag/removeZeitleisteEintrag
  // oben: der Journal-Resolver kann die Mappe unter ihrer eigenen id weiterhin auflösen.
  // removeSitzungsmappe (löscht die ganze Mappe) steht bewusst NICHT hier — dieselbe Begründung
  // wie removeTable/removeZeitleiste (s. Modul-Kopfkommentar, Lösch-Lifecycle-Ausnahme).
  renameSitzungsmappe: (p) => str(p.id),
  removeSitzungsmappeDoc: (p) => str(p.id),
  verschiebeSitzungsmappeDoc: (p) => str(p.id),
  addOffeneFrage: (p) => str(p.id),
  setOffeneFrageText: (p) => str(p.id),
  setOffeneFrageBeantwortet: (p) => str(p.id),
  removeOffeneFrage: (p) => str(p.id),
  moveCutout: (p) => str(p.id),
  moveStack: (p) => str(p.stackId),
  renameStack: (p) => str(p.stackId),
  dissolveStack: (p) => str(p.stackId),
  stapleStack: (p) => str(p.stackId),
  unstapleStack: (p) => str(p.stackId),
  expandStack: (p) => str(p.id),
  collapseStack: (p) => str(p.id),
  setStackPage: (p) => str(p.id),
  resizeStack: (p) => str(p.id),
  removeFromStack: (p) => str(p.docId),
  setLinkNote: (p) => str(p.linkId),
  setLinkKind: (p) => str(p.linkId),
  tapeObject: (p) => str(p.id),
  untapeObject: (p) => str(p.id),
  changeLayerId: (p) => str(p.objectId),
  setFreigabe: (p) => str(p.objectId),
};

/**
 * IDs der BESTEHENDEN Objekte, die ein Command berührt (mutiert, annotiert, verknüpft,
 * wegwirft) — Grundlage der Ebenen-Bearbeitungsprüfung (CR-04). Bei erzeugenden
 * Annotierungs-Commands (addMark/addStroke/addStamp/addFlag/addCutout) ist das die
 * Eltern-Karte (docId): eine Annotation auf einer fremden Privatkarte bekäme sonst eine
 * eigene, für alle sichtbare layerId und läge als Volltext-Anker auf einem unsichtbaren Dok.
 */
export const ZIEL_OBJEKT_IDS: Record<string, (p: Record<string, unknown>) => string[]> = {
  moveDoc: (p) => liste(str(p.id)),
  bringToFront: (p) => liste(str(p.id)),
  setDocLandscape: (p) => liste(str(p.id)),
  expandDoc: (p) => liste(str(p.id)),
  collapseDoc: (p) => liste(str(p.id)),
  setDocPage: (p) => liste(str(p.id)),
  resizeDoc: (p) => liste(str(p.id)),
  removeDoc: (p) => liste(str(p.id)),
  extractPage: (p) => liste(str(p.docId)),
  addCutout: (p) => liste(str(p.docId)),
  editNote: (p) => liste(str(p.id)),
  moveNote: (p) => liste(str(p.id)),
  setNoteDone: (p) => liste(str(p.id)),
  removeNote: (p) => liste(str(p.id)),
  editLegalObject: (p) => liste(str(p.id)),
  moveLegalObject: (p) => liste(str(p.id)),
  removeLegalObject: (p) => liste(str(p.id)),
  setTaskStatus: (p) => liste(str(p.id)),
  setTaskPriority: (p) => liste(str(p.id)),
  setTaskAssignee: (p) => liste(str(p.id)),
  setTaskDueDate: (p) => liste(str(p.id)),
  setTaskDocRef: (p) => liste(str(p.id)),
  removeTaskDocRef: (p) => liste(str(p.id)),
  markTaskHandedOver: (p) => liste(str(p.id)),
  moveTable: (p) => liste(str(p.id)),
  renameTable: (p) => liste(str(p.id)),
  removeTable: (p) => liste(str(p.id)),
  expandTable: (p) => liste(str(p.id)),
  collapseTable: (p) => liste(str(p.id)),
  resizeTable: (p) => liste(str(p.id)),
  addTableRow: (p) => liste(str(p.tableId)),
  setTableCell: (p) => liste(str(p.tableId)),
  removeTableRow: (p) => liste(str(p.tableId)),
  setTableRowBeleg: (p) => liste(str(p.tableId)),
  addTableColumn: (p) => liste(str(p.tableId)),
  addTableFormulaColumn: (p) => liste(str(p.tableId)),
  removeTableColumn: (p) => liste(str(p.tableId)),
  moveZeitleiste: (p) => liste(str(p.id)),
  removeZeitleiste: (p) => liste(str(p.id)),
  expandZeitleiste: (p) => liste(str(p.id)),
  collapseZeitleiste: (p) => liste(str(p.id)),
  resizeZeitleiste: (p) => liste(str(p.id)),
  // addZeitleisteEintrag berührt zusätzlich das REFERENZIERTE Objekt (objRef): ein Eintrag auf
  // ein fremdes Privatobjekt darf dessen Ebenen-Bearbeitungsprüfung nicht umgehen (T-09-04).
  addZeitleisteEintrag: (p) => liste(str(p.zeitleisteId), str(p.objRef)),
  setZeitleisteEintrag: (p) => liste(str(p.zeitleisteId)),
  removeZeitleisteEintrag: (p) => liste(str(p.zeitleisteId)),
  // addSitzungsmappeDoc berührt zusätzlich das REFERENZIERTE Dokument (docId) — dieselbe
  // Begründung wie addZeitleisteEintrag/objRef oben: eine Agenda-Zeile auf ein fremdes
  // Privatdokument darf dessen Ebenen-Bearbeitungsprüfung nicht umgehen.
  addSitzungsmappeDoc: (p) => liste(str(p.id), str(p.docId)),
  // removeSitzungsmappeDoc/verschiebeSitzungsmappeDoc berühren NUR die eigene Mappe (nicht den
  // referenzierten docId) — anders als addSitzungsmappeDoc wird hier kein neuer Bezug zu einem
  // fremden Dokument HERGESTELLT, sondern nur die eigene Agenda-Reihenfolge/-Mitgliedschaft
  // verändert (dieselbe Einordnung wie removeZeitleisteEintrag oben, nur zeitleisteId).
  removeSitzungsmappeDoc: (p) => liste(str(p.id)),
  verschiebeSitzungsmappeDoc: (p) => liste(str(p.id)),
  renameSitzungsmappe: (p) => liste(str(p.id)),
  removeSitzungsmappe: (p) => liste(str(p.id)),
  addOffeneFrage: (p) => liste(str(p.id)),
  setOffeneFrageText: (p) => liste(str(p.id)),
  setOffeneFrageBeantwortet: (p) => liste(str(p.id)),
  removeOffeneFrage: (p) => liste(str(p.id)),
  moveCutout: (p) => liste(str(p.id)),
  removeCutout: (p) => liste(str(p.id)),
  addMark: (p) => liste(verschachtelteDocId(p, 'mark')),
  removeMark: (p) => liste(str(p.markId)),
  addStroke: (p) => liste(verschachtelteDocId(p, 'stroke')),
  removeStroke: (p) => liste(str(p.strokeId)),
  addStamp: (p) => liste(verschachtelteDocId(p, 'stamp')),
  removeStamp: (p) => liste(str(p.stampId)),
  addFlag: (p) => liste(verschachtelteDocId(p, 'flag')),
  removeFlag: (p) => liste(str(p.flagId)),
  moveStack: (p) => liste(str(p.stackId)),
  renameStack: (p) => liste(str(p.stackId)),
  removeStack: (p) => liste(str(p.stackId)),
  dissolveStack: (p) => liste(str(p.stackId)),
  stapleStack: (p) => liste(str(p.stackId)),
  unstapleStack: (p) => liste(str(p.stackId)),
  expandStack: (p) => liste(str(p.id)),
  collapseStack: (p) => liste(str(p.id)),
  setStackPage: (p) => liste(str(p.id)),
  resizeStack: (p) => liste(str(p.id)),
  removeFromStack: (p) => liste(str(p.docId)),
  stackDocs: (p) => liste(str(p.draggedId), str(p.targetId)),
  addLink: (p) => liste(str(p.fromId), str(p.toId)),
  setLinkNote: (p) => liste(str(p.linkId)),
  setLinkKind: (p) => liste(str(p.linkId)),
  removeLink: (p) => liste(str(p.linkId)),
  // addVersionLink liefert beide Dokument-ids — ohne den zweiten Eintrag ließe sich eine
  // Versionsbeziehung an einem Dokument auf einer fremden privaten Ebene vorbei anlegen (T-09-18).
  addVersionLink: (p) => liste(str(p.olderId), str(p.newerId)),
  removeVersionLink: (p) => liste(str(p.linkId)),
  addClip: (p) => liste(str(p.aId), str(p.bId)),
  removeClip: (p) => liste(str(p.clipId)),
  tapeObject: (p) => liste(str(p.id)),
  untapeObject: (p) => liste(str(p.id)),
  trashObject: (p) => liste(str(p.id)),
  copyObject: (p) => liste(str(p.id)),
  changeLayerId: (p) => liste(str(p.objectId)),
  setFreigabe: (p) => liste(str(p.objectId)),
};

/**
 * Command-Typen ganz OHNE Bezug zu einem versionierten Desk-Objekt: Verwaltungs-/System-
 * Commands (Ebenen, Hintergrund) und Korb-Lifecycle-Commands, deren trashId KEIN Objekt im
 * Sinne von findeObjekt bezeichnet. Wächtertest-relevant: commandTypen() muss sich
 * vollständig auf INHALT_OBJEKT_ID ∪ ZIEL_OBJEKT_IDS ∪ OHNE_OBJEKT_BEZUG verteilen.
 */
export const OHNE_OBJEKT_BEZUG: readonly string[] = [
  'setBackground', 'addCustomLayer', 'setLayerExportierbar',
  'restoreObject', 'shredTrashItem', 'emptyTrash',
  // 13-02: renameZone/removeZone referenzieren kein geschütztes Fremdobjekt — Zonen tragen
  // keine layerId (U4-Gebot), damit greift weder die Journal-Sichtprüfung noch die
  // Ebenen-Bearbeitungsprüfung; removeZone trägt die Zonen-id selbst (analog removeMark).
  'renameZone', 'removeZone',
];

/** ID des inhalts-tragenden Objekts eines Commands (Journal-Projektion), sonst undefined. */
export function objektIdFuerCommand(cmd: Command): string | undefined {
  return INHALT_OBJEKT_ID[cmd.type]?.(cmd.payload ?? {});
}

/** IDs der bestehenden Zielobjekte eines Commands (Ebenen-Bearbeitungsprüfung). */
export function zielObjektIdsFuerCommand(cmd: Command): string[] {
  return ZIEL_OBJEKT_IDS[cmd.type]?.(cmd.payload ?? {}) ?? [];
}

/**
 * Erzeugende Command-Typen und WO ihre (optionale) Objekt-ID im Payload liegt: Top-Level
 * (`id`) oder verschachtelt im Annotationsobjekt (`mark`/`stroke`/`stamp`/`flag`). Das ist
 * die Schreibseite zur Leseseite INHALT_OBJEKT_ID oben — der Wächtertest hält beide
 * konsistent (jeder Eintrag hier muss dort eine Auflösung haben).
 */
const ERZEUGEND_TOP_LEVEL: readonly string[] = [
  'addDoc', 'addNote', 'addCutout', 'addLink', 'addClip', 'stackDocs', 'extractPage', 'copyObject',
  'addZeitleiste', 'addVersionLink', 'addSitzungsmappe',
  // 13-02: addZone — Offline-Queue-Dedupe (istBereitsAngewendet) greift nur bei Registrierung.
  'addZone',
];
const ERZEUGEND_VERSCHACHTELT: Record<string, string> = {
  addMark: 'mark', addStroke: 'stroke', addStamp: 'stamp', addFlag: 'flag',
};

/** Nur für den Wächtertest exportiert: die erzeugenden Command-Typen (beide Tabellen). */
export function erzeugendeCommandTypen(): string[] {
  return [...ERZEUGEND_TOP_LEVEL, ...Object.keys(ERZEUGEND_VERSCHACHTELT)];
}

/**
 * WR-02: stellt sicher, dass ein ERZEUGENDER Command eine Objekt-ID im Payload trägt.
 * Die clientvergebene ID ist Konvention, keine Pflicht — die echten Erzeugungspfade ohne
 * sie (j-lawyer-Upload in app.ts, Sprung-zur-Quelle-Pfad, MCP-Aufrufe) erzeugten sonst
 * Journal-Einträge, die der CR-03-Filter nicht auflösen kann und die deshalb fail-closed
 * aus der Historie ALLER Betrachter fielen (empirisch nachgewiesen: jl-Upload → Historie
 * zeigte nur noch deskCreated). Der Server ruft dies VOR applyCommand auf: `optId()` im
 * Core übernimmt die injizierte ID anstelle der internen uid(), Objekt und Journal-Eintrag
 * tragen dieselbe ID. Mutiert `cmd.payload` — dasselbe Mutationsmuster wie
 * fileSha256/kappeTextSnapshot in app.ts. Mutierende Commands werden nie angefasst (eine
 * erfundene ID auf ein bestehendes Zielobjekt wäre ein Fehler).
 */
export function stelleErzeugerIdSicher(cmd: Command, neueId: () => string): void {
  const p = cmd.payload as Record<string, unknown> | undefined;
  if (!p || typeof p !== 'object') return;
  const schluessel = ERZEUGEND_VERSCHACHTELT[cmd.type];
  if (schluessel !== undefined) {
    const ziel = p[schluessel] as Record<string, unknown> | undefined;
    if (ziel && typeof ziel === 'object' && str(ziel.id) === undefined) ziel.id = neueId();
    return;
  }
  if (ERZEUGEND_TOP_LEVEL.includes(cmd.type) && str(p.id) === undefined) p.id = neueId();
}
