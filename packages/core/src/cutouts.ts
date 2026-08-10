import { findDoc, provenienz, type DesktopState, type FileKind, type Vec2, type CommandMeta } from './model';
import { removeLinksFor } from './links';
import { removeFromClips } from './clips';
import type { Box } from './viewport';
import { uid } from './uid';

/** Fundstellen-Provenienz: Textausschnitt-Vorschau wird auf diese Länge gekappt (kein Fehler bei Überlänge). */
export const TEXT_SNAPSHOT_MAX = 2000;

/** Schere: rechteckiger Ausschnitt einer PDF-Seite als eigenes Objekt auf dem Tisch. */
export interface Cutout {
  id: string;
  fileId: string;
  page: number;                              // 1-basiert
  rect: { x: number; y: number; w: number; h: number }; // Basiskoordinaten der Seite (scale = 1)
  position: Vec2;                            // Weltkoordinaten, linke obere Ecke
  zIndex: number;
  taped?: boolean;                           // Klebeband: am Tisch festgeklebt, Drag gesperrt
  kind?: FileKind;                           // Datei-Art der Quelle: bestimmt Darstellungs-Weg (fehlt = PDF-Alt-Semantik)
  sourceName?: string;                       // Dateiname der Quelle (für Bild-MIME-Erkennung)
  createdBy?: string;                        // Provenienz: wer hat den Ausschnitt erzeugt; fehlt in Alt-States
  createdById?: string;                      // Provenienz: stabile users.id des Erzeugers (WR-05); fehlt in Alt-States
  createdAt?: string;                        // Provenienz: wann, ISO-Zeitpunkt; fehlt in Alt-States
  updatedRev?: number;                       // Konflikterkennung: Schreibtisch-rev der letzten Änderung; fehlt in Alt-States
  updatedAt?: string;                        // Provenienz: wann zuletzt geändert, ISO-Zeitpunkt; fehlt in Alt-States
  updatedBy?: string;                        // Provenienz: wer zuletzt geändert hat; fehlt in Alt-States
  textSnapshot?: string;                     // Sprung zur Quelle: ursprünglicher Text zum Zeitpunkt des Ausschnitts, gekappt auf TEXT_SNAPSHOT_MAX
  fileSha256?: string;                       // Sprung zur Quelle: Hash der Quelldatei zum Zeitpunkt des Ausschnitts
  layerId?: string;                          // Sichtbarkeits-/Bearbeitungsebene; fehlt in Alt-States (implizit "Kanzlei")
  freigabe?: import('./freigabe').Freigabe;  // Freigabe-Override (EXP-03); fehlt in Alt-States (implizit Ebenen-Default, fail-closed 'intern', D-14)
}

function maxZ(s: DesktopState): number {
  return Math.max(
    0,
    ...s.docs.map((d) => d.zIndex),
    ...s.stacks.map((st) => st.zIndex),
    ...(s.notes ?? []).map((n) => n.zIndex),
    ...(s.cutouts ?? []).map((c) => c.zIndex),
  );
}

export function addCutout(
  s: DesktopState,
  docId: string,
  page: number,
  rect: { x: number; y: number; w: number; h: number },
  position: Vec2,
  id: string = uid(),
  meta?: CommandMeta,
  extras?: { textSnapshot?: string; fileSha256?: string },
): DesktopState {
  const quelle = findDoc(s, docId);
  if (!quelle) throw new Error(`Dokument "${docId}" nicht gefunden`);
  if (!Number.isInteger(page) || page < 1) throw new Error(`Ungültige Seite: ${page}`);
  if (!(rect.w > 0) || !(rect.h > 0) || !Number.isFinite(rect.x) || !Number.isFinite(rect.y)) {
    throw new Error('Ungültiger Ausschnitt');
  }
  const cutout: Cutout = {
    id,
    fileId: quelle.fileId,
    page,
    rect,
    position,
    zIndex: maxZ(s) + 1,
    ...(quelle.kind !== undefined ? { kind: quelle.kind, sourceName: quelle.name } : {}),
    ...provenienz(meta),
    ...(extras?.textSnapshot !== undefined && extras.textSnapshot !== ''
      ? { textSnapshot: extras.textSnapshot.slice(0, TEXT_SNAPSHOT_MAX) }
      : {}),
    ...(extras?.fileSha256 !== undefined && extras.fileSha256 !== '' ? { fileSha256: extras.fileSha256 } : {}),
  };
  return { ...s, cutouts: [...(s.cutouts ?? []), cutout] };
}

export function moveCutout(s: DesktopState, id: string, position: Vec2): DesktopState {
  const cutouts = s.cutouts ?? [];
  if (!cutouts.some((c) => c.id === id)) throw new Error(`Ausschnitt "${id}" nicht gefunden`);
  return { ...s, cutouts: cutouts.map((c) => (c.id === id ? { ...c, position } : c)) };
}

export function removeCutout(s: DesktopState, id: string): DesktopState {
  const cutouts = s.cutouts ?? [];
  if (!cutouts.some((c) => c.id === id)) throw new Error(`Ausschnitt "${id}" nicht gefunden`);
  const next = removeFromClips(removeLinksFor(s, id), id);
  return { ...next, cutouts: cutouts.filter((c) => c.id !== id) };
}

export function findCutout(s: DesktopState, id: string): Cutout | undefined {
  return (s.cutouts ?? []).find((c) => c.id === id);
}

/** Ausschnitte liegen in Originalgröße auf dem Tisch (Basiskoordinaten ≈ Weltpixel). */
export function cutoutBox(c: Cutout): Box {
  return { x: c.position.x, y: c.position.y, w: c.rect.w, h: c.rect.h };
}
