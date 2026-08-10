import { findDoc, provenienz, type DesktopState, type CommandMeta } from './model';
import { uid } from './uid';

/** Notizfahnen: farbige Laschen am rechten Seitenrand — sichtbar auch an der zugeklappten Karte. */
export const FLAG_COLORS: readonly string[] = ['#f5c518', '#e5484d', '#3b82f6', '#30a46c'];

export interface Flag {
  id: string;
  docId: string;
  page: number;    // 1-basiert — Klick auf die Lasche springt hierhin
  offset: number;  // 0..1, vertikale Position am rechten Rand
  color: string;   // aus FLAG_COLORS
  label?: string;
  createdBy?: string;  // Provenienz: wer hat die Fahne erzeugt; fehlt in Alt-States
  createdById?: string; // Provenienz: stabile users.id des Erzeugers (WR-05); fehlt in Alt-States
  createdAt?: string;  // Provenienz: wann, ISO-Zeitpunkt; fehlt in Alt-States
  updatedRev?: number; // Konflikterkennung: Schreibtisch-rev der letzten Änderung; fehlt in Alt-States
  updatedAt?: string;  // Provenienz: wann zuletzt geändert, ISO-Zeitpunkt; fehlt in Alt-States
  updatedBy?: string;  // Provenienz: wer zuletzt geändert hat; fehlt in Alt-States
  layerId?: string;    // Sichtbarkeits-/Bearbeitungsebene; fehlt in Alt-States (implizit "Kanzlei")
  freigabe?: import('./freigabe').Freigabe; // Freigabe-Override (EXP-03); fehlt in Alt-States (implizit Ebenen-Default, fail-closed 'intern', D-14)
}

export function addFlag(s: DesktopState, flag: Omit<Flag, 'id'> & { id?: string }, meta?: CommandMeta): DesktopState {
  if (!findDoc(s, flag.docId)) throw new Error(`Dokument "${flag.docId}" nicht gefunden`);
  if (!Number.isInteger(flag.page) || flag.page < 1) throw new Error(`Ungültige Seite: ${flag.page}`);
  if (!Number.isFinite(flag.offset) || flag.offset < 0 || flag.offset > 1) throw new Error(`Ungültiger Offset: ${flag.offset}`);
  if (!FLAG_COLORS.includes(flag.color)) throw new Error(`Unbekannte Farbe: ${String(flag.color)}`);
  if (flag.label !== undefined && typeof flag.label !== 'string') throw new Error('Ungültige Beschriftung');
  const entry: Flag = {
    id: flag.id ?? uid(),
    docId: flag.docId, page: flag.page, offset: flag.offset, color: flag.color,
    ...(flag.label !== undefined ? { label: flag.label } : {}),
    ...provenienz(meta),
  };
  return { ...s, flags: [...(s.flags ?? []), entry] };
}

export function removeFlag(s: DesktopState, flagId: string): DesktopState {
  const flags = s.flags ?? [];
  if (!flags.some((f) => f.id === flagId)) throw new Error(`Fahne "${flagId}" nicht gefunden`);
  return { ...s, flags: flags.filter((f) => f.id !== flagId) };
}

/** Alle Fahnen eines Dokuments (über alle Seiten — Laschen sind immer sichtbar). */
export function flagsFor(s: DesktopState, docId: string): Flag[] {
  return (s.flags ?? []).filter((f) => f.docId === docId);
}

/** Entfernt alle Fahnen der angegebenen Dokumente (Aufräumen bei removeDoc/removeStack). */
export function removeFlagsForDocs(s: DesktopState, docIds: string[]): DesktopState {
  const flags = s.flags ?? [];
  if (flags.length === 0) return s;
  return { ...s, flags: flags.filter((f) => !docIds.includes(f.docId)) };
}
