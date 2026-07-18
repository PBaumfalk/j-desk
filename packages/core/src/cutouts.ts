import { findDoc, type DesktopState, type FileKind, type Vec2 } from './model';
import { removeLinksFor } from './links';
import { removeFromClips } from './clips';
import type { Box } from './viewport';
import { uid } from './uid';

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
