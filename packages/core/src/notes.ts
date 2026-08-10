import { provenienz, type DesktopState, type Vec2, type CommandMeta, CARD_W } from './model';
import { removeLinksFor } from './links';
import { removeFromClips } from './clips';
import type { Box } from './viewport';
import { uid } from './uid';

/** Gedankenobjekte der Vision: ein Notizzettel trägt optional eine Denk-Rolle. */
export const NOTE_KINDS = [
  'notiz', 'frage', 'these', 'angriffspunkt', 'risiko',
  'behauptung', 'beweisziel', 'idee', 'todo', 'argument', 'rechtsfrage', 'eigen',
  'tafel', // Tafel-Text: weißer Filzstift-Freitext ohne Papier, direkt auf dem Filz
] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

export const NOTE_BADGE_MAX = 24;

export interface Note {
  id: string;
  kind: NoteKind;
  text: string;
  position: Vec2;    // Weltkoordinaten, linke obere Ecke
  zIndex: number;
  taped?: boolean;   // Klebeband: am Tisch festgeklebt, Drag gesperrt
  customLabel?: string; // nur bei kind 'eigen': frei benanntes Badge
  done?: boolean;       // nur bei kind 'todo': abgehakt
  createdBy?: string;   // Provenienz: wer hat den Zettel erzeugt; fehlt in Alt-States
  createdById?: string; // Provenienz: stabile users.id des Erzeugers (WR-05); fehlt in Alt-States
  createdAt?: string;   // Provenienz: wann, ISO-Zeitpunkt; fehlt in Alt-States
  updatedRev?: number;  // Konflikterkennung: Schreibtisch-rev der letzten Änderung; fehlt in Alt-States
  updatedAt?: string;   // Provenienz: wann zuletzt geändert, ISO-Zeitpunkt; fehlt in Alt-States
  updatedBy?: string;   // Provenienz: wer zuletzt geändert hat; fehlt in Alt-States
  layerId?: string;     // Sichtbarkeits-/Bearbeitungsebene; fehlt in Alt-States (implizit "Kanzlei")
  freigabe?: import('./freigabe').Freigabe; // Freigabe-Override (EXP-03); fehlt in Alt-States (implizit Ebenen-Default, fail-closed 'intern', D-14)
  extern?: import('./extern').ExternRef; // Externe-Referenz-Markierung (EXT-01, 13-02); deklarativ, nie rechte-relevant; fehlt in Alt-States
  sitzungsnotiz?: true; // SESS-03: Kennzeichen „im Termin erfasst", orthogonal zur Zettelart —
                        // ausdrücklich KEIN weiterer Wert von NOTE_KINDS; fehlt in Alt-States
                        // und wird nie als false geschrieben (Strukturgleichheit mit Bestandsnotizen)
}

export const NOTE_W = 170;
export const NOTE_H = 130;
/** Tafel-Texte schreiben größer — eigene Fläche für Treffer-/Anker-/Culling-Geometrie. */
export const TAFEL_W = 300;
export const TAFEL_H = 160;

function maxZ(s: DesktopState): number {
  return Math.max(
    0,
    ...s.docs.map((d) => d.zIndex),
    ...s.stacks.map((st) => st.zIndex),
    ...(s.notes ?? []).map((n) => n.zIndex),
    ...(s.cutouts ?? []).map((c) => c.zIndex),
    // 11-REVIEW WR-02: legalObjects/tables/zeitleisten fehlten hier — derselbe
    // 08-07-Reihenfolge-Bug wie in documents.ts: eine neue Notiz (gerade Sitzungsnotizen und
    // Telefon-Diktate an festen Ersatzkoordinaten) könnte sonst einen niedrigeren z-Wert als
    // eine vorhandene Tabellenkarte/Zeitleiste/ein juristisches Objekt erhalten und dahinter
    // unsichtbar verschwinden.
    ...(s.legalObjects ?? []).map((o) => o.zIndex),
    ...(s.tables ?? []).map((t) => t.zIndex),
    ...(s.zeitleisten ?? []).map((z) => z.zIndex),
  );
}

function mapNote(s: DesktopState, id: string, fn: (n: Note) => Note): DesktopState {
  const notes = s.notes ?? [];
  if (!notes.some((n) => n.id === id)) throw new Error(`Notizzettel "${id}" nicht gefunden`);
  return { ...s, notes: notes.map((n) => (n.id === id ? fn(n) : n)) };
}

export function addNote(
  s: DesktopState,
  kind: NoteKind,
  text: string,
  position: Vec2,
  id: string = uid(),
  customLabel?: string,
  meta?: CommandMeta,
  optionen?: { sitzungsnotiz?: boolean; extern?: import('./extern').ExternRef },
): DesktopState {
  if (!NOTE_KINDS.includes(kind)) throw new Error(`Unbekannter Zettel-Typ: ${String(kind)}`);
  if (kind === 'eigen') {
    if (typeof customLabel !== 'string' || customLabel.trim() === '' || customLabel.trim().length > NOTE_BADGE_MAX) {
      throw new Error(`Badge-Text fehlt oder ist länger als ${NOTE_BADGE_MAX} Zeichen`);
    }
  } else if (customLabel !== undefined) {
    throw new Error('Badge-Text ist nur beim Typ "eigen" erlaubt');
  }
  const note: Note = {
    id, kind, text, position, zIndex: maxZ(s) + 1,
    ...(kind === 'eigen' ? { customLabel: customLabel!.trim() } : {}),
    // Das Kennzeichen wird nur bei wahr geschrieben — nie als false,
    // damit Bestandsnotizen und neue gewöhnliche Notizen strukturgleich bleiben.
    ...(optionen?.sitzungsnotiz === true ? { sitzungsnotiz: true as const } : {}),
    // extern wird nur geschrieben, wenn definiert — Additive-Only, Alt-Objekte bleiben feldlos.
    ...(optionen?.extern !== undefined ? { extern: optionen.extern } : {}),
    ...provenienz(meta),
  };
  return { ...s, notes: [...(s.notes ?? []), note] };
}

/**
 * Feste Ersatzkoordinate für Sitzungsnotizen (SESS-03): Weltursprung plus Kaskadenversatz
 * je bereits vorhandener Sitzungsnotiz — derselbe Versatz wie beim Mehrfach-Datei-Upload
 * (x um CARD_W + 24, y um 8 je Stück). Es gibt bewusst keinen Bildschirmmitte-Bezug: die
 * Vollbild-Chrome des Sitzungsmodus hat keinen sinnvollen Weltausschnitt, und das räumliche
 * Einsortieren bleibt dem nächsten Zugriff außerhalb des Termins überlassen.
 */
export function naechsteSitzungsnotizPosition(s: DesktopState): Vec2 {
  const n = (s.notes ?? []).filter((note) => note.sitzungsnotiz === true).length;
  return { x: n * (CARD_W + 24), y: n * 8 };
}

/** Slot-Index einer Position auf der Weltursprungs-Kaskade ({ x: k*(CARD_W+24), y: k*8 }),
 *  sonst null — Positionen auf der Kaskade sind immer ganzzahlig exakt erzeugt. */
function kaskadenSlot(p: Vec2): number | null {
  const k = p.y / 8;
  if (!Number.isInteger(k) || k < 0 || p.x !== k * (CARD_W + 24)) return null;
  return k;
}

/**
 * Erster freier Slot der Weltursprungs-Kaskade (WR-01, 11-REVIEW): dieselbe Kaskade wie
 * `naechsteSitzungsnotizPosition`, aber belegte Slots werden zusätzlich aus den tatsächlichen
 * Positionen abgeleitet — gekennzeichnete Sitzungsnotizen UND Docs. Telefon-Foto-Uploads sind
 * Docs und werden von `naechsteSitzungsnotizPosition` nie gezählt: ohne diese Positionsableitung
 * läge jedes weitere Foto deckungsgleich auf dem ersten Slot. Die Anzahl gekennzeichneter
 * Notizen bleibt als Untergrenze erhalten, damit eine vom Slot wegbewegte Sitzungsnotiz die
 * Kaskade weiter fortschiebt wie bisher.
 */
export function naechsteKaskadenPosition(s: DesktopState): Vec2 {
  let n = (s.notes ?? []).filter((note) => note.sitzungsnotiz === true).length;
  for (const note of s.notes ?? []) {
    if (note.sitzungsnotiz !== true) continue;
    const k = kaskadenSlot(note.position);
    if (k !== null && k + 1 > n) n = k + 1;
  }
  for (const d of s.docs) {
    const k = kaskadenSlot(d.position);
    if (k !== null && k + 1 > n) n = k + 1;
  }
  return { x: n * (CARD_W + 24), y: n * 8 };
}

/** To-do abhaken/aufheben — nur für kind 'todo' erlaubt. */
export function setNoteDone(s: DesktopState, id: string, done: boolean): DesktopState {
  return mapNote(s, id, (n) => {
    if (n.kind !== 'todo') throw new Error('Nur To-do-Zettel können abgehakt werden');
    return { ...n, done };
  });
}

export function editNote(s: DesktopState, id: string, text: string, extern?: import('./extern').ExternRef): DesktopState {
  // extern wird nur geschrieben, wenn es im Aufruf definiert ist — ein editNote ohne
  // extern-Argument erhält eine bestehende Markierung (kein implizites Löschen, 13-02).
  return mapNote(s, id, (n) => ({ ...n, text, ...(extern !== undefined ? { extern } : {}) }));
}

export function moveNote(s: DesktopState, id: string, position: Vec2): DesktopState {
  return mapNote(s, id, (n) => ({ ...n, position }));
}

export function removeNote(s: DesktopState, id: string): DesktopState {
  const notes = s.notes ?? [];
  if (!notes.some((n) => n.id === id)) throw new Error(`Notizzettel "${id}" nicht gefunden`);
  const next = removeFromClips(removeLinksFor(s, id), id);
  return { ...next, notes: notes.filter((n) => n.id !== id) };
}

export function findNote(s: DesktopState, id: string): Note | undefined {
  return (s.notes ?? []).find((n) => n.id === id);
}

export function noteBox(n: Note): Box {
  const w = n.kind === 'tafel' ? TAFEL_W : NOTE_W;
  const h = n.kind === 'tafel' ? TAFEL_H : NOTE_H;
  return { x: n.position.x, y: n.position.y, w, h };
}
