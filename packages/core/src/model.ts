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
  pageOnly?: number;   // herausgelöste Einzelseite (Enthefterzange): Karte zeigt nur diese Seite
  taped?: boolean;     // Klebeband: am Tisch festgeklebt, Drag gesperrt
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
  taped?: boolean;     // Klebeband: am Tisch festgeklebt, Drag gesperrt
  stapled?: boolean;   // Hefter: festes Konvolut — feste Reihenfolge, als Ganzes durchblätterbar
  open?: boolean;      // Konvolut aufgeschlagen (großer Viewer)
  openSize?: Size;     // Größe des Konvolut-Viewers (Weltkoordinaten)
  page?: number;       // globale Konvolut-Seite über alle Mitglieder, 1-basiert
}

export interface DesktopState {
  docs: Doc[];
  links: Link[];
  stacks: Stack[];
  /** Freihand-Striche (Stift/Marker) auf PDF-Seiten; fehlt in Staaten vor Teilprojekt E. */
  strokes?: import('./ink').Stroke[];
  /** Notizzettel/Gedankenobjekte; fehlt in älteren Staaten. */
  notes?: import('./notes').Note[];
  /** Scheren-Ausschnitte von PDF-Seiten; fehlt in älteren Staaten. */
  cutouts?: import('./cutouts').Cutout[];
  /** Tipp-Ex-/Schwärzungs-Flächen auf PDF-Seiten; fehlt in älteren Staaten. */
  marks?: import('./marks').Mark[];
  /** Kanzlei-Stempel auf PDF-Seiten; fehlt in älteren Staaten. */
  stamps?: import('./stamps').Stamp[];
  /** Notizfahnen: farbige Laschen am rechten Seitenrand; fehlt in älteren Staaten. */
  flags?: import('./flags').Flag[];
  /** Büroklammer-Gruppen: lose gemeinsam verschobene Objekte; fehlt in älteren Staaten. */
  clips?: import('./clips').Clip[];
  /** Papierkorb: entfernte Objekte, wiederherstellbar bis geleert; fehlt in älteren Staaten. */
  trash?: import('./trash').TrashedItem[];
}

export const CARD_W = 180;
export const CARD_H = 240;

export function emptyState(): DesktopState {
  return { docs: [], links: [], stacks: [], strokes: [], notes: [], cutouts: [], marks: [], stamps: [], flags: [], clips: [], trash: [] };
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
    (s.cutouts === undefined || Array.isArray(s.cutouts)) &&
    (s.marks === undefined || Array.isArray(s.marks)) &&
    (s.stamps === undefined || Array.isArray(s.stamps)) &&
    (s.flags === undefined || Array.isArray(s.flags)) &&
    (s.clips === undefined || Array.isArray(s.clips)) &&
    (s.trash === undefined || Array.isArray(s.trash)) &&
    s.docs.every(
      (d) =>
        !!d && typeof d.id === 'string' && typeof d.fileId === 'string' && typeof d.name === 'string',
    )
  );
}
