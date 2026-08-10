import { provenienz, type DesktopState, type Vec2, type CommandMeta } from './model';
import { removeLinksFor } from './links';
import { removeFromClips } from './clips';
import type { Box } from './viewport';
import { uid } from './uid';

/**
 * Juristische Objekttypen (LEGAL-01): strukturierte, auswertbare Bausteine der Fallanalyse —
 * anders als die informellen Brainstorming-Zettel (notes.ts) ein EIGENER, formaler Namensraum
 * (08-UI-SPEC.md Kernentscheidung). Reihenfolge entspricht REQUIREMENTS.md:77 und ist zugleich
 * die Menü-Reihenfolge im ＋-Untermenü.
 */
export const LEGAL_OBJECT_KINDS = [
  'tatsache',
  'eigene-behauptung',
  'behauptung-gegenseite',
  'beweismittel',
  'gegenbeweis',
  'rechtsfrage',
  'tatbestandsmerkmal',
  'einwendung',
  'risiko',
  'frist',
  'aufgabe',
  'fundstelle-zitierfaehig',
  'ergebnis',
] as const;
export type LegalObjectKind = (typeof LEGAL_OBJECT_KINDS)[number];

/** Aufgaben-Status (TASK-01): Reihenfolge = Copywriting Contract (08-UI-SPEC.md). */
export const TASK_STATUSES = ['offen', 'in-arbeit', 'erledigt', 'uebergeben'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Aufgaben-Priorität (TASK-01): Reihenfolge = Copywriting Contract (08-UI-SPEC.md). */
export const TASK_PRIORITIES = ['hoch', 'mittel', 'niedrig'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

/** Bezug einer Aufgabe zu Dokument/Fundstelle — springt über den Bestands-jump.ts-Pfad. */
export interface TaskDocRef {
  docId: string;
  page?: number;
  cutoutId?: string;
}

export interface LegalObject {
  id: string;
  kind: LegalObjectKind;
  text: string;
  position: Vec2;   // Weltkoordinaten, linke obere Ecke
  zIndex: number;
  taped?: boolean;       // Klebeband: am Tisch festgeklebt, Drag gesperrt
  createdBy?: string;    // Provenienz: wer hat das Objekt erzeugt; fehlt in Alt-States
  createdById?: string;  // Provenienz: stabile users.id des Erzeugers (WR-05); fehlt in Alt-States
  createdAt?: string;    // Provenienz: wann, ISO-Zeitpunkt; fehlt in Alt-States
  updatedRev?: number;   // Konflikterkennung: Schreibtisch-rev der letzten Änderung; fehlt in Alt-States
  updatedAt?: string;    // Provenienz: wann zuletzt geändert, ISO-Zeitpunkt; fehlt in Alt-States
  updatedBy?: string;    // Provenienz: wer zuletzt geändert hat; fehlt in Alt-States
  layerId?: string;      // Sichtbarkeits-/Bearbeitungsebene; fehlt in Alt-States (implizit "Kanzlei")
  freigabe?: import('./freigabe').Freigabe; // Freigabe-Override (EXP-03); fehlt in Alt-States (implizit Ebenen-Default, fail-closed 'intern', D-14)
  // Aufgabenspezifische Zusatzfelder (TASK-01) — nur bei kind === 'aufgabe' gesetzt:
  assignee?: string;      // Verantwortliche/r; leer statt gesetzt heißt "kein Verantwortlicher"
  dueDate?: string;       // Fälligkeit, ISO-Kalendertag (YYYY-MM-DD)
  priority?: TaskPriority; // Vorbelegung bei Neuanlage: 'mittel'
  status?: TaskStatus;     // Vorbelegung bei Neuanlage: 'offen'
  docRef?: TaskDocRef;     // Bezug zu Dokument/Fundstelle
  // TASK-02 (08-08): Provenienz der Übergabe an j-lawyer — NUR serverseitig NACH Bestätigung
  // durch j-lawyer gesetzt (markTaskHandedOver), nie optimistisch vom Client.
  handedOverToJLawyer?: { at: string; jlDueDateId: string };
}

export const LEGAL_W = 170;
export const LEGAL_H = 130;
/** Aufgabenkarten brauchen Platz für Prioritäts-Punkt/Status-Badge/Metazeile — eigene Sondergröße. */
export const AUFGABE_W = 200;
export const AUFGABE_H = 176;

function maxZ(s: DesktopState): number {
  return Math.max(
    0,
    ...s.docs.map((d) => d.zIndex),
    ...s.stacks.map((st) => st.zIndex),
    ...(s.notes ?? []).map((n) => n.zIndex),
    ...(s.cutouts ?? []).map((c) => c.zIndex),
    ...(s.legalObjects ?? []).map((o) => o.zIndex),
  );
}

function mapLegalObject(s: DesktopState, id: string, fn: (o: LegalObject) => LegalObject): DesktopState {
  const legalObjects = s.legalObjects ?? [];
  if (!legalObjects.some((o) => o.id === id)) throw new Error(`Juristisches Objekt "${id}" nicht gefunden`);
  return { ...s, legalObjects: legalObjects.map((o) => (o.id === id ? fn(o) : o)) };
}

export function addLegalObject(
  s: DesktopState,
  kind: LegalObjectKind,
  text: string,
  position: Vec2,
  id: string = uid(),
  meta?: CommandMeta,
): DesktopState {
  if (!LEGAL_OBJECT_KINDS.includes(kind)) throw new Error(`Unbekannter juristischer Objekttyp: ${String(kind)}`);
  const obj: LegalObject = {
    id, kind, text, position, zIndex: maxZ(s) + 1,
    // Aufgaben-Vorbelegung nach UI-SPEC: genau eine Priorität ("Mittel") und genau ein
    // Status ("Offen") bei Neuanlage — alle übrigen zwölf Typen bleiben unverändert.
    ...(kind === 'aufgabe' ? { priority: 'mittel' as TaskPriority, status: 'offen' as TaskStatus } : {}),
    ...provenienz(meta),
  };
  return { ...s, legalObjects: [...(s.legalObjects ?? []), obj] };
}

/**
 * Gemeinsamer Helfer für alle fünf Aufgaben-Setter (TASK-01): wirft, wenn das Zielobjekt
 * kein `kind: 'aufgabe'` trägt — Muster identisch zu setNoteDone auf einem Nicht-To-do
 * (notes.ts), damit ein fremdes Objekt nie still Aufgabenfelder erhält.
 */
function mapAufgabe(s: DesktopState, id: string, fn: (o: LegalObject) => LegalObject): DesktopState {
  return mapLegalObject(s, id, (o) => {
    if (o.kind !== 'aufgabe') throw new Error('Nur Aufgaben tragen dieses Feld');
    return fn(o);
  });
}

export function setTaskStatus(s: DesktopState, id: string, status: TaskStatus): DesktopState {
  return mapAufgabe(s, id, (o) => ({ ...o, status }));
}

export function setTaskPriority(s: DesktopState, id: string, priority: TaskPriority): DesktopState {
  return mapAufgabe(s, id, (o) => ({ ...o, priority }));
}

/** Ein nach trim() leerer Wert löscht den Verantwortlichen, statt einen leeren String zu speichern. */
export function setTaskAssignee(s: DesktopState, id: string, assignee: string): DesktopState {
  return mapAufgabe(s, id, (o) => {
    if (assignee.trim() === '') {
      const { assignee: _entfernt, ...rest } = o;
      return rest as LegalObject;
    }
    return { ...o, assignee };
  });
}

/** Ein nach trim() leerer Wert löscht die Fälligkeit, statt einen leeren String zu speichern. */
export function setTaskDueDate(s: DesktopState, id: string, dueDate: string): DesktopState {
  return mapAufgabe(s, id, (o) => {
    if (dueDate.trim() === '') {
      const { dueDate: _entfernt, ...rest } = o;
      return rest as LegalObject;
    }
    return { ...o, dueDate };
  });
}

export function setTaskDocRef(s: DesktopState, id: string, docRef: TaskDocRef): DesktopState {
  return mapAufgabe(s, id, (o) => ({ ...o, docRef }));
}

/**
 * Entfernt den Dokument-/Fundstellenbezug einer Aufgabe (Menüeintrag „Bezug entfernen", Task 3).
 * `setTaskDocRef` selbst kann das nicht: sein `docRef`-Parameter verlangt zwingend `docId`
 * (TASK-01-Vertrag) — es gibt also KEINEN Aufruf von setTaskDocRef, der das Feld löscht, anders
 * als setTaskAssignee/setTaskDueDate mit ihrem "leerer String löscht"-Muster. Eigener Setter,
 * gleiches Lösch-Muster wie dort (destrukturierendes Weglassen statt undefined zu speichern).
 */
export function removeTaskDocRef(s: DesktopState, id: string): DesktopState {
  return mapAufgabe(s, id, (o) => {
    const { docRef: _entfernt, ...rest } = o;
    return rest as LegalObject;
  });
}

/**
 * TASK-02 (08-08): trägt die Übergabe an j-lawyer ein — ausschließlich vom Server NACH
 * Bestätigung durch j-lawyer aufgerufen (app.ts handover-Route, NIE optimistisch vom Client).
 * Setzt den Status auf 'uebergeben' und hinterlegt Zeitpunkt + die von j-lawyer vergebene
 * Kennung. Wirft über mapAufgabe, wenn das Zielobjekt keine Aufgabe ist.
 */
export function markTaskHandedOver(s: DesktopState, id: string, at: string, jlDueDateId: string): DesktopState {
  return mapAufgabe(s, id, (o) => ({ ...o, status: 'uebergeben' as TaskStatus, handedOverToJLawyer: { at, jlDueDateId } }));
}

/**
 * Überfälligkeits-Prüfung (TASK-01), reine Funktion: nur wahr, wenn eine Fälligkeit gesetzt
 * ist, sie vor dem Kalendertag von `jetztIso` liegt, UND der Status weder erledigt noch
 * übergeben ist. Vergleich über die ersten zehn Zeichen der ISO-Strings (Kalendertag-Ebene),
 * damit keine Zeitzonenverschiebung eine Aufgabe einen Tag zu früh als überfällig markiert.
 */
export function istUeberfaellig(o: LegalObject, jetztIso: string): boolean {
  if (!o.dueDate) return false;
  if (o.status === 'erledigt' || o.status === 'uebergeben') return false;
  return o.dueDate.slice(0, 10) < jetztIso.slice(0, 10);
}

export function editLegalObject(s: DesktopState, id: string, text: string): DesktopState {
  return mapLegalObject(s, id, (o) => ({ ...o, text }));
}

export function moveLegalObject(s: DesktopState, id: string, position: Vec2): DesktopState {
  return mapLegalObject(s, id, (o) => ({ ...o, position }));
}

export function removeLegalObject(s: DesktopState, id: string): DesktopState {
  const legalObjects = s.legalObjects ?? [];
  if (!legalObjects.some((o) => o.id === id)) throw new Error(`Juristisches Objekt "${id}" nicht gefunden`);
  // removeFromClips (Task 2, 08-01-PLAN.md): seit die Karte ein Kontextmenü mit "Anklammern
  // an…" trägt, können juristische Objekte Büroklammer-Mitglied sein — beim Entfernen muss die
  // Gruppenmitgliedschaft daher genauso aufgeräumt werden wie bei allen anderen Objektarten
  // (notes.ts removeNote, cutouts.ts removeCutout, removal.ts), sonst blieben tote ids in
  // Klammer-Gruppen stehen.
  const next = removeFromClips(removeLinksFor(s, id), id);
  return { ...next, legalObjects: legalObjects.filter((o) => o.id !== id) };
}

export function findLegalObject(s: DesktopState, id: string): LegalObject | undefined {
  return (s.legalObjects ?? []).find((o) => o.id === id);
}

export function legalObjectBox(o: LegalObject): Box {
  const w = o.kind === 'aufgabe' ? AUFGABE_W : LEGAL_W;
  const h = o.kind === 'aufgabe' ? AUFGABE_H : LEGAL_H;
  return { x: o.position.x, y: o.position.y, w, h };
}
