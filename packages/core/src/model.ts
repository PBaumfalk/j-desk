export interface Vec2 { x: number; y: number }

export interface Size { w: number; h: number }

export interface Doc {
  id: string;
  fileId: string;      // Server-Datei (files-Tabelle)
  name: string;        // Anzeigename (Original-Dateiname)
  position: Vec2;      // Weltkoordinaten, linke obere Ecke
  rotation: number;    // Grad, feste leichte Zufallsdrehung
  zIndex: number;
  open?: boolean;      // aufgeschlagen (große Karte) statt Miniatur
  openSize?: Size;     // Größe der großen Karte (Weltkoordinaten)
  page?: number;       // aktuell sichtbare Seite, 1-basiert
}

export interface Link {
  id: string;
  fromId: string;      // Doc- oder Stack-id
  toId: string;        // Doc- oder Stack-id
  note: string;
}

export interface Stack {
  id: string;
  name: string;
  docIds: string[];    // Reihenfolge: unten → oben
  position: Vec2;
  zIndex: number;
}

export interface DesktopState {
  docs: Doc[];
  links: Link[];
  stacks: Stack[];
  /** Freihand-Striche (Stift/Marker) auf PDF-Seiten; fehlt in Staaten vor Teilprojekt E. */
  strokes?: import('./ink').Stroke[];
  /** Notizzettel/Gedankenobjekte; fehlt in älteren Staaten. */
  notes?: import('./notes').Note[];
}

export const CARD_W = 180;
export const CARD_H = 240;

export function emptyState(): DesktopState {
  return { docs: [], links: [], stacks: [], strokes: [], notes: [] };
}

export function findDoc(s: DesktopState, id: string): Doc | undefined {
  return s.docs.find((d) => d.id === id);
}

export function findStack(s: DesktopState, id: string): Stack | undefined {
  return s.stacks.find((st) => st.id === id);
}

export function stackOf(s: DesktopState, docId: string): Stack | undefined {
  return s.stacks.find((st) => st.docIds.includes(docId));
}

export function freeDocs(s: DesktopState): Doc[] {
  return s.docs.filter((d) => !stackOf(s, d.id));
}

export function isValidState(v: unknown): v is DesktopState {
  if (!v || typeof v !== 'object') return false;
  const s = v as DesktopState;
  return (
    Array.isArray(s.docs) &&
    Array.isArray(s.links) &&
    Array.isArray(s.stacks) &&
    (s.strokes === undefined || Array.isArray(s.strokes)) &&
    (s.notes === undefined || Array.isArray(s.notes)) &&
    s.docs.every(
      (d) =>
        !!d && typeof d.id === 'string' && typeof d.fileId === 'string' && typeof d.name === 'string',
    )
  );
}
