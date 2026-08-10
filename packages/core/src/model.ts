export interface Vec2 { x: number; y: number }

export interface Size { w: number; h: number }

/** Provenienz-Stempel: wer/wann hat ein Objekt erzeugt. Vom Server gesetzt, nie vom Client.
 *  `createdById` (stabile users.id) fehlt bei System-Stempeln (z. B. j-lawyer-Abgleich). */
export interface CommandMeta { createdBy: string; createdAt: string; createdById?: string }

/**
 * Baut den Provenienz-Stempel für neu erzeugte Objekte (Server-Feldhoheit): Name + Zeitpunkt,
 * seit WR-05 zusätzlich die stabile userId (`createdById`) — der Username (`createdBy`) ist
 * nach einer Konto-Löschung neu vergebbar und damit als Berechtigungs-Anker (Eigentumsprüfung
 * „nur eigene Notizen bearbeiten") ungeeignet. Einheitlich über diese Funktion statt
 * 13 handgeschriebener Stempelstellen, damit kein Erzeugungsweg das Feld vergessen kann.
 */
export function provenienz(meta?: CommandMeta): { createdBy?: string; createdAt?: string; createdById?: string } {
  if (!meta) return {};
  return {
    createdBy: meta.createdBy,
    createdAt: meta.createdAt,
    ...(meta.createdById ? { createdById: meta.createdById } : {}),
  };
}

/** Datei-Art einer Karte: bestimmt Darstellung und Vorschau-Weg. Fehlt in Alt-States (= pdf). */
export type FileKind = 'pdf' | 'image' | 'convertible' | 'other';
export const FILE_KINDS: readonly FileKind[] = ['pdf', 'image', 'convertible', 'other'];

export interface Doc {
  id: string;
  fileId: string;      // Server-Datei (files-Tabelle)
  name: string;        // Anzeigename (Original-Dateiname)
  position: Vec2;      // Weltkoordinaten, linke obere Ecke
  rotation: number;    // Grad, feste leichte Zufallsdrehung
  zIndex: number;
  kind?: FileKind;     // Datei-Art: bestimmt Darstellung und Vorschau-Weg
  open?: boolean;      // aufgeschlagen (große Karte) statt Miniatur
  openSize?: Size;     // Größe der großen Karte (Weltkoordinaten)
  page?: number;       // aktuell sichtbare Seite, 1-basiert
  pageOnly?: number;   // herausgelöste Einzelseite (Enthefterzange): Karte zeigt nur diese Seite
  landscape?: true;    // Querformat-Karte (erste Seite breiter als hoch); einmalig gesetzt, kein Zurück
  taped?: boolean;     // Klebeband: am Tisch festgeklebt, Drag gesperrt
  createdBy?: string;  // Provenienz: wer hat die Karte erzeugt; fehlt in Alt-States
  createdById?: string; // Provenienz: stabile users.id des Erzeugers (WR-05); fehlt in Alt-States/System-Stempeln
  createdAt?: string;  // Provenienz: wann, ISO-Zeitpunkt; fehlt in Alt-States
  updatedRev?: number; // Konflikterkennung: Schreibtisch-rev der letzten Änderung; fehlt in Alt-States
  updatedAt?: string;  // Provenienz: wann zuletzt geändert, ISO-Zeitpunkt; fehlt in Alt-States
  updatedBy?: string;  // Provenienz: wer zuletzt geändert hat; fehlt in Alt-States
  layerId?: string;    // Sichtbarkeits-/Bearbeitungsebene; fehlt in Alt-States (implizit "Kanzlei")
  freigabe?: import('./freigabe').Freigabe; // Freigabe-Override (EXP-03); fehlt in Alt-States (implizit Ebenen-Default, fail-closed 'intern', D-14)
  extern?: import('./extern').ExternRef; // Externe-Referenz-Markierung (EXT-01, 13-02); deklarativ, nie rechte-relevant; fehlt in Alt-States

  // jl-Referenzstatus: nur im j-lawyer-Modus gesetzt, ausschließlich vom Server-Abgleich (putDeskState) gepflegt.
  sourceGone?: true;          // Quelldokument in j-lawyer nicht mehr vorhanden — Karte verwaist, Annotationen bleiben erhalten
  sourceChangeDate?: number;  // jl-changeDate (Epoch-Millis) der Quelle — Versionssignal für den Abgleich
  sourceReplacedAt?: string;  // ISO-Zeitpunkt, wann der Abgleich erstmals eine neue Fassung der Quelle sah
  sourceRenamedAt?: string;   // ISO-Zeitpunkt, wann der Abgleich erstmals eine Umbenennung sah — bewusst getrennt von
                               // sourceReplacedAt (fachlich verschiedene Zustände, RESEARCH Anti-Pattern A4)
  sourceAccessDenied?: true;  // Berechtigung für dieses Dokument entzogen (403 beim gezielten Einzelabruf) — kein sourceGone
  sourceArchived?: true;      // zugehörige j-lawyer-Akte ist archiviert (Fall-Feld "archived", 01-SPIKE-FINDINGS.md)
  sourceNotReachable?: true;  // transienter Live-Zustand: letzter Einzelabruf schlug mit Netzfehler/Timeout fehl;
                               // wird NIE persistiert (nicht Teil des gespeicherten Desk-Zustands)
}

export interface Link {
  id: string;
  fromId: string;      // Doc- oder Stack-id
  toId: string;        // Doc- oder Stack-id
  note: string;
  createdBy?: string;  // Provenienz: wer hat den Link erzeugt; fehlt in Alt-States
  createdById?: string; // Provenienz: stabile users.id des Erzeugers (WR-05); fehlt in Alt-States
  createdAt?: string;  // Provenienz: wann, ISO-Zeitpunkt; fehlt in Alt-States
  updatedRev?: number; // Konflikterkennung: Schreibtisch-rev der letzten Änderung; fehlt in Alt-States
  updatedAt?: string;  // Provenienz: wann zuletzt geändert, ISO-Zeitpunkt; fehlt in Alt-States
  updatedBy?: string;  // Provenienz: wer zuletzt geändert hat; fehlt in Alt-States
  layerId?: string;    // Sichtbarkeits-/Bearbeitungsebene; fehlt in Alt-States (implizit "Kanzlei")
  freigabe?: import('./freigabe').Freigabe; // Freigabe-Override (EXP-03); fehlt in Alt-States (implizit Ebenen-Default, fail-closed 'intern', D-14)
  kind?: import('./links').LinkMeaning; // Verknüpfungsbedeutung (LEGAL-02); fehlt = Familie "Offen" (familieVon()), Bestandsverknüpfungen bleiben bewusst ohne Wert
  struktur?: 'version'; // Strukturelle Beziehung zwischen zwei Dokumenten (COMP-03), orthogonal zur
  // juristischen Bedeutung; eine Verknüpfung trägt entweder eine Bedeutung oder diese
  // Kennzeichnung, nie beides — die Oberfläche bietet für beide getrennte Erzeugungswege an;
  // fehlt in Alt-States.
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
  createdBy?: string;  // Provenienz: wer hat den Stapel erzeugt; fehlt in Alt-States
  createdById?: string; // Provenienz: stabile users.id des Erzeugers (WR-05); fehlt in Alt-States
  createdAt?: string;  // Provenienz: wann, ISO-Zeitpunkt; fehlt in Alt-States
  updatedRev?: number; // Konflikterkennung: Schreibtisch-rev der letzten Änderung; fehlt in Alt-States
  updatedAt?: string;  // Provenienz: wann zuletzt geändert, ISO-Zeitpunkt; fehlt in Alt-States
  updatedBy?: string;  // Provenienz: wer zuletzt geändert hat; fehlt in Alt-States
  layerId?: string;    // Sichtbarkeits-/Bearbeitungsebene; fehlt in Alt-States (implizit "Kanzlei")
  freigabe?: import('./freigabe').Freigabe; // Freigabe-Override (EXP-03); fehlt in Alt-States (implizit Ebenen-Default, fail-closed 'intern', D-14)
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
  /** Erscheinungsbild (Farbe/Material) dieses Schreibtischs; fehlt in älteren Staaten (= Standard). */
  background?: import('./background').DeskBackground;
  /** Benutzerdefinierte Ebenen (private Nutzer-Ebenen + Kanzlei-Ebenen); fehlt in älteren Staaten. */
  layers?: import('./layers').Ebene[];
  /** Juristische Objekttypen (LEGAL-01): strukturierte Fallanalyse-Bausteine; fehlt in älteren Staaten. */
  legalObjects?: import('./legalObjects').LegalObject[];
  /** Tabellenkarten (CALC-01): Forderungsaufstellungen/Fristketten/Zinsrechnungen; fehlt in älteren Staaten. */
  tables?: import('./tables').TableCard[];
  /** Zeitleistenkarten (CHRONO-01): chronologische Sammlung von Objekt-Referenzen; fehlt in älteren Staaten. */
  zeitleisten?: import('./zeitleiste').ZeitleisteCard[];
  /** Sitzungsmappen (SESS-02): vorbereitete Termin-Agenden; fehlt in älteren Staaten. */
  sitzungsmappen?: import('./sitzungsmappe').Sitzungsmappe[];
  /** Zonen (UX-03, 13-02): benannte Orientierungsbereiche — geteilte, synchronisierte
   *  Infrastruktur ohne Referenzfelder (U4); fehlt in älteren Staaten. */
  zones?: import('./zonen').Zone[];
}

export const CARD_W = 180;
export const CARD_H = 240;

export function emptyState(): DesktopState {
  // zones fehlt hier bewusst (Muster layers/background, 13-02): Zonen sind Desk-Infrastruktur
  // und materialisieren erst mit dem ersten addZone — so bleiben frische Desks und Alt-States
  // strukturgleich feldlos, statt zwei Schreibweisen desselben Leerstands zu erzeugen.
  return { docs: [], links: [], stacks: [], strokes: [], notes: [], cutouts: [], marks: [], stamps: [], flags: [], clips: [], trash: [], legalObjects: [], tables: [], zeitleisten: [], sitzungsmappen: [] };
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
    (s.legalObjects === undefined || Array.isArray(s.legalObjects)) &&
    (s.tables === undefined || Array.isArray(s.tables)) &&
    (s.zeitleisten === undefined || Array.isArray(s.zeitleisten)) &&
    (s.sitzungsmappen === undefined || Array.isArray(s.sitzungsmappen)) &&
    (s.zones === undefined || Array.isArray(s.zones)) &&
    (s.background === undefined ||
      (!!s.background && typeof s.background === 'object' &&
        typeof s.background.themeId === 'string' && typeof s.background.material === 'string' &&
        (s.background.brightness === undefined || typeof s.background.brightness === 'number') &&
        (s.background.textureIntensity === undefined || typeof s.background.textureIntensity === 'number') &&
        (s.background.vignette === undefined || typeof s.background.vignette === 'boolean'))) &&
    s.docs.every(
      (d) =>
        !!d && typeof d.id === 'string' && typeof d.fileId === 'string' && typeof d.name === 'string',
    )
  );
}
