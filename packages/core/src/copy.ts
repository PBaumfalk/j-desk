import { findDoc, provenienz, type DesktopState, type CommandMeta } from './model';
import { findNote } from './notes';
import { findCutout } from './cutouts';
import { findLegalObject } from './legalObjects';
import { rotationFor } from './documents';
import { uid } from './uid';

const OFFSET = { x: 28, y: 20 };

function maxZ(s: DesktopState): number {
  return Math.max(
    0,
    ...s.docs.map((d) => d.zIndex),
    ...s.stacks.map((st) => st.zIndex),
    ...(s.notes ?? []).map((n) => n.zIndex),
    ...(s.cutouts ?? []).map((c) => c.zIndex),
    ...(s.legalObjects ?? []).map((o) => o.zIndex),
    // WR-01: tables fehlte hier, anders als in documents.ts/tables.ts maxZ() (dort mit
    // demselben 08-07-Reihenfolge-Bug-Kommentar) — eine frische Kopie konnte hinter einer
    // bereits vorhandenen Tabellenkarte mit höherem zIndex landen.
    ...(s.tables ?? []).map((t) => t.zIndex),
    // 09-01: dieselbe Vorwegnahme für die neue Zeitleisten-Art.
    ...(s.zeitleisten ?? []).map((z) => z.zIndex),
  );
}

/**
 * Kopierer: dupliziert Karte, Seitenkarte, Zettel oder Ausschnitt inkl. Annotationen.
 * Gleiche Datei-Referenz, keine Datei-Duplizierung, kein j-lawyer-Schreibvorgang.
 */
export function copyObject(s: DesktopState, objectId: string, meta?: CommandMeta): DesktopState {
  const stamp = provenienz(meta);
  const doc = findDoc(s, objectId);
  if (doc) {
    const neueId = uid();
    // Kopien sind neue Werke: Provenienz des Originals wird NICHT übernommen, nur der neue Stempel gilt.
    const { open: _o, openSize: _os, taped: _t, createdBy: _cb, createdAt: _ca, ...rest } = doc;
    const kopie = {
      ...rest,
      id: neueId,
      position: { x: doc.position.x + OFFSET.x, y: doc.position.y + OFFSET.y },
      rotation: rotationFor(neueId),
      zIndex: maxZ(s) + 1,
      ...stamp,
    };
    // Annotationen sind ebenfalls neue Werke: Original-Provenienz strippen, bevor der neue Stempel (falls vorhanden) gilt.
    const kopieAnnotation = <T extends { createdBy?: string; createdAt?: string }>(x: T) => {
      const { createdBy: _cb, createdAt: _ca, ...restA } = x;
      return { ...restA, id: uid(), docId: neueId, ...stamp };
    };
    return {
      ...s,
      docs: [...s.docs, kopie],
      strokes: [...(s.strokes ?? []), ...(s.strokes ?? []).filter((x) => x.docId === doc.id).map(kopieAnnotation)],
      marks: [...(s.marks ?? []), ...(s.marks ?? []).filter((x) => x.docId === doc.id).map(kopieAnnotation)],
      stamps: [...(s.stamps ?? []), ...(s.stamps ?? []).filter((x) => x.docId === doc.id).map(kopieAnnotation)],
      flags: [...(s.flags ?? []), ...(s.flags ?? []).filter((x) => x.docId === doc.id).map(kopieAnnotation)],
    };
  }
  const note = findNote(s, objectId);
  if (note) {
    const { taped: _t, createdBy: _cb, createdAt: _ca, ...rest } = note;
    const kopie = { ...rest, id: uid(), position: { x: note.position.x + OFFSET.x, y: note.position.y + OFFSET.y }, zIndex: maxZ(s) + 1, ...stamp };
    return { ...s, notes: [...(s.notes ?? []), kopie] };
  }
  const cutout = findCutout(s, objectId);
  if (cutout) {
    const { taped: _t, createdBy: _cb, createdAt: _ca, ...rest } = cutout;
    const kopie = { ...rest, id: uid(), position: { x: cutout.position.x + OFFSET.x, y: cutout.position.y + OFFSET.y }, zIndex: maxZ(s) + 1, ...stamp };
    return { ...s, cutouts: [...(s.cutouts ?? []), kopie] };
  }
  const legalObject = findLegalObject(s, objectId);
  if (legalObject) {
    // Kopien sind neue Werke (wie doc/note/cutout oben): taped wird NIE übernommen. Für Aufgaben
    // zusätzlich status/handedOverToJLawyer strippen — markTaskHandedOver darf laut eigenem
    // Kommentar/docs/deployment/jlawyer-aufgabenuebergabe.md AUSSCHLIESSLICH serverseitig nach
    // Bestätigung durch j-lawyer gesetzt werden; copyObject ist ein unconditionaler
    // Client-Command und darf diese Provenienz nicht optimistisch fabrizieren (CR-04).
    const { taped: _t, createdBy: _cb, createdAt: _ca, status: _st, handedOverToJLawyer: _ho, ...rest } = legalObject;
    const kopie = {
      ...rest,
      id: uid(),
      position: { x: legalObject.position.x + OFFSET.x, y: legalObject.position.y + OFFSET.y },
      zIndex: maxZ(s) + 1,
      ...(legalObject.kind === 'aufgabe' ? { status: 'offen' as const } : {}),
      ...stamp,
    };
    return { ...s, legalObjects: [...(s.legalObjects ?? []), kopie] };
  }
  if (s.stacks.some((st) => st.id === objectId)) throw new Error('Stapel lassen sich nicht kopieren');
  // WR-04: menus.ts bietet auf TableCards bewusst kein "Kopieren" an (Bestandslücke bleibt
  // unerreichbar über das Standardmenü) — ein direkter Aufruf gegen eine Tabellenkarte-id warf
  // bisher trotzdem die irreführende "nicht gefunden"-Meldung, obwohl die Tabelle existiert.
  if ((s.tables ?? []).some((t) => t.id === objectId)) throw new Error('Tabellen lassen sich nicht kopieren');
  // 09-01: dieselbe WR-04-Lücke vorweggenommen für Zeitleisten — menus.ts bietet auf
  // ZeitleisteCard ebenfalls kein "Kopieren" an (eine kopierte Zeitleiste mit denselben
  // Einträgen hätte keinen erkennbaren fachlichen Nutzen).
  if ((s.zeitleisten ?? []).some((z) => z.id === objectId)) throw new Error('Zeitleisten lassen sich nicht kopieren');
  throw new Error(`Objekt "${objectId}" nicht gefunden`);
}
