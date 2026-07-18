import { findDoc, type DesktopState, type Vec2 } from './model';
import { uid } from './uid';

export type StrokeTool = 'pen' | 'marker' | 'pencil';

export interface Stroke {
  id: string;
  docId: string;
  page: number;        // 1-basiert
  tool: StrokeTool;
  color: string;       // Hex, vom Werkzeug vorgegeben
  width: number;       // Strichbreite in Basiskoordinaten
  points: Vec2[];      // >= 2 Punkte im PDF-Seitenraum bei scale = 1
}

const TOOLS: readonly StrokeTool[] = ['pen', 'marker', 'pencil'];

function validPoints(points: Vec2[]): boolean {
  return (
    Array.isArray(points) &&
    points.length >= 2 &&
    points.every((p) => !!p && Number.isFinite(p.x) && Number.isFinite(p.y))
  );
}

/** Fügt einen Freihand-Strich hinzu; Koordinaten im Basisraum der PDF-Seite (scale = 1). */
export function addStroke(
  s: DesktopState,
  stroke: Omit<Stroke, 'id'> & { id?: string },
): DesktopState {
  if (!findDoc(s, stroke.docId)) throw new Error(`Dokument "${stroke.docId}" nicht gefunden`);
  if (!Number.isInteger(stroke.page) || stroke.page < 1) throw new Error(`Ungültige Seite: ${stroke.page}`);
  if (!TOOLS.includes(stroke.tool)) throw new Error(`Unbekanntes Werkzeug: ${String(stroke.tool)}`);
  if (typeof stroke.color !== 'string' || stroke.color === '') throw new Error('Farbe fehlt');
  if (!(stroke.width > 0) || !Number.isFinite(stroke.width)) throw new Error(`Ungültige Strichbreite: ${stroke.width}`);
  if (!validPoints(stroke.points)) throw new Error('Ein Strich braucht mindestens zwei endliche Punkte');
  const entry: Stroke = {
    id: stroke.id ?? uid(),
    docId: stroke.docId,
    page: stroke.page,
    tool: stroke.tool,
    color: stroke.color,
    width: stroke.width,
    points: stroke.points.map((p) => ({ x: p.x, y: p.y })),
  };
  return { ...s, strokes: [...(s.strokes ?? []), entry] };
}

export function removeStroke(s: DesktopState, strokeId: string): DesktopState {
  const strokes = s.strokes ?? [];
  if (!strokes.some((st) => st.id === strokeId)) throw new Error(`Strich "${strokeId}" nicht gefunden`);
  return { ...s, strokes: strokes.filter((st) => st.id !== strokeId) };
}

/** Alle Striche einer Seite eines Dokuments (alte States ohne strokes-Feld: leer). */
export function strokesFor(s: DesktopState, docId: string, page: number): Stroke[] {
  return (s.strokes ?? []).filter((st) => st.docId === docId && st.page === page);
}

/** Entfernt alle Striche der angegebenen Dokumente (Aufräumen bei removeDoc/removeStack). */
export function removeStrokesForDocs(s: DesktopState, docIds: string[]): DesktopState {
  const strokes = s.strokes ?? [];
  if (strokes.length === 0) return s;
  return { ...s, strokes: strokes.filter((st) => !docIds.includes(st.docId)) };
}
