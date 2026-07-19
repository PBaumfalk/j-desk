import { findDoc, type DesktopState } from './model';
import { uid } from './uid';

/** Stempel: Kanzlei-Set + Freitext, seitenverankert, leicht gedreht aufgebracht. */
export interface Stamp {
  id: string;
  docId: string;
  page: number;          // 1-basiert
  x: number;             // Stempelmitte, Basiskoordinaten
  y: number;
  angle: number;         // Grad, leicht gedreht (vom Client gewürfelt)
  text: string;
  color: 'red' | 'blue';
  date?: string;         // ISO-Tag, nur EINGANG
  baseW: number;         // Seitengröße beim Stempeln — fürs Overlay auf der Miniatur
  baseH: number;
}

export const STAMP_PRESETS: readonly { text: string; color: 'red' | 'blue'; withDate?: boolean }[] = [
  { text: 'ERLEDIGT', color: 'red' },
  { text: 'WICHTIG', color: 'red' },
  { text: 'FRIST!', color: 'red' },
  { text: 'GEPRÜFT', color: 'blue' },
  { text: 'EINGANG', color: 'blue', withDate: true },
  { text: 'ENTWURF', color: 'blue' },
  { text: 'KOPIE', color: 'blue' },
];

export const STAMP_TEXT_MAX = 40;

export function addStamp(s: DesktopState, stamp: Omit<Stamp, 'id'> & { id?: string }): DesktopState {
  if (!findDoc(s, stamp.docId)) throw new Error(`Dokument "${stamp.docId}" nicht gefunden`);
  if (!Number.isInteger(stamp.page) || stamp.page < 1) throw new Error(`Ungültige Seite: ${stamp.page}`);
  if (typeof stamp.text !== 'string' || stamp.text.trim() === '' || stamp.text.length > STAMP_TEXT_MAX) {
    throw new Error(`Stempel-Text fehlt oder ist länger als ${STAMP_TEXT_MAX} Zeichen`);
  }
  if (stamp.color !== 'red' && stamp.color !== 'blue') throw new Error(`Unbekannte Farbe: ${String(stamp.color)}`);
  if (!Number.isFinite(stamp.angle)) throw new Error('Ungültiger Winkel');
  if (!Number.isFinite(stamp.x) || !Number.isFinite(stamp.y)) throw new Error('Ungültige Position');
  if (!(stamp.baseW > 0) || !(stamp.baseH > 0)) throw new Error('Ungültige Seitengröße');
  if (stamp.date !== undefined && typeof stamp.date !== 'string') throw new Error('Ungültiges Datum');
  const entry: Stamp = {
    id: stamp.id ?? uid(),
    docId: stamp.docId, page: stamp.page, x: stamp.x, y: stamp.y,
    angle: stamp.angle, text: stamp.text.trim(), color: stamp.color,
    ...(stamp.date !== undefined ? { date: stamp.date } : {}),
    baseW: stamp.baseW, baseH: stamp.baseH,
  };
  return { ...s, stamps: [...(s.stamps ?? []), entry] };
}

export function removeStamp(s: DesktopState, stampId: string): DesktopState {
  const stamps = s.stamps ?? [];
  if (!stamps.some((st) => st.id === stampId)) throw new Error(`Stempel "${stampId}" nicht gefunden`);
  return { ...s, stamps: stamps.filter((st) => st.id !== stampId) };
}

export function stampsFor(s: DesktopState, docId: string, page: number): Stamp[] {
  return (s.stamps ?? []).filter((st) => st.docId === docId && st.page === page);
}

/** Entfernt alle Stempel der angegebenen Dokumente (Aufräumen bei removeDoc/removeStack). */
export function removeStampsForDocs(s: DesktopState, docIds: string[]): DesktopState {
  const stamps = s.stamps ?? [];
  if (stamps.length === 0) return s;
  return { ...s, stamps: stamps.filter((st) => !docIds.includes(st.docId)) };
}
