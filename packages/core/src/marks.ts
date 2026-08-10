import { findDoc, provenienz, type DesktopState, type CommandMeta } from './model';
import { uid } from './uid';
import { TEXT_SNAPSHOT_MAX } from './cutouts';

/** Tipp-Ex und Schwärzung: deckende Flächen auf PDF-Seiten (rein visuell, nicht forensisch). */
export type MarkKind = 'redact' | 'tippex';

export interface Mark {
  id: string;
  docId: string;
  page: number;                                          // 1-basiert
  rect: { x: number; y: number; w: number; h: number };  // Basiskoordinaten der Seite (scale = 1)
  kind: MarkKind;
  createdBy?: string;   // Provenienz: wer hat die Fläche erzeugt; fehlt in Alt-States
  createdById?: string; // Provenienz: stabile users.id des Erzeugers (WR-05); fehlt in Alt-States
  createdAt?: string;   // Provenienz: wann, ISO-Zeitpunkt; fehlt in Alt-States
  updatedRev?: number;  // Konflikterkennung: Schreibtisch-rev der letzten Änderung; fehlt in Alt-States
  updatedAt?: string;   // Provenienz: wann zuletzt geändert, ISO-Zeitpunkt; fehlt in Alt-States
  updatedBy?: string;   // Provenienz: wer zuletzt geändert hat; fehlt in Alt-States
  textSnapshot?: string; // Sprung zur Quelle: ursprünglicher (überdeckter) Text, gekappt auf TEXT_SNAPSHOT_MAX
  fileSha256?: string;   // Sprung zur Quelle: Hash der Quelldatei zum Zeitpunkt der Markierung
  layerId?: string;      // Sichtbarkeits-/Bearbeitungsebene; fehlt in Alt-States (implizit "Kanzlei")
  freigabe?: import('./freigabe').Freigabe; // Freigabe-Override (EXP-03); fehlt in Alt-States (implizit Ebenen-Default, fail-closed 'intern', D-14)
}

const KINDS: readonly MarkKind[] = ['redact', 'tippex'];

export function addMark(s: DesktopState, mark: Omit<Mark, 'id'> & { id?: string }, meta?: CommandMeta): DesktopState {
  if (!findDoc(s, mark.docId)) throw new Error(`Dokument "${mark.docId}" nicht gefunden`);
  if (!Number.isInteger(mark.page) || mark.page < 1) throw new Error(`Ungültige Seite: ${mark.page}`);
  if (!KINDS.includes(mark.kind)) throw new Error(`Unbekannte Art: ${String(mark.kind)}`);
  const r = mark.rect;
  if (!(r.w > 0) || !(r.h > 0) || !Number.isFinite(r.x) || !Number.isFinite(r.y)) throw new Error('Ungültige Fläche');
  const entry: Mark = {
    id: mark.id ?? uid(), docId: mark.docId, page: mark.page, rect: { ...r }, kind: mark.kind,
    ...provenienz(meta),
    ...(mark.textSnapshot !== undefined && mark.textSnapshot !== ''
      ? { textSnapshot: mark.textSnapshot.slice(0, TEXT_SNAPSHOT_MAX) }
      : {}),
    ...(mark.fileSha256 !== undefined && mark.fileSha256 !== '' ? { fileSha256: mark.fileSha256 } : {}),
  };
  return { ...s, marks: [...(s.marks ?? []), entry] };
}

export function removeMark(s: DesktopState, markId: string): DesktopState {
  const marks = s.marks ?? [];
  if (!marks.some((m) => m.id === markId)) throw new Error(`Fläche "${markId}" nicht gefunden`);
  return { ...s, marks: marks.filter((m) => m.id !== markId) };
}

export function marksFor(s: DesktopState, docId: string, page: number): Mark[] {
  return (s.marks ?? []).filter((m) => m.docId === docId && m.page === page);
}

/** Entfernt alle Flächen der angegebenen Dokumente (Aufräumen bei removeDoc/removeStack). */
export function removeMarksForDocs(s: DesktopState, docIds: string[]): DesktopState {
  const marks = s.marks ?? [];
  if (marks.length === 0) return s;
  return { ...s, marks: marks.filter((m) => !docIds.includes(m.docId)) };
}
