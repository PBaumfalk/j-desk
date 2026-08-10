import { uid } from './uid';
import type { DesktopState, Vec2, FileKind, CommandMeta } from './model';
import { FILE_KINDS, provenienz } from './model';

function maxZ(s: DesktopState): number {
  return Math.max(
    0,
    ...s.docs.map((d) => d.zIndex),
    ...s.stacks.map((st) => st.zIndex),
    ...(s.notes ?? []).map((n) => n.zIndex),
    ...(s.cutouts ?? []).map((c) => c.zIndex),
    // 08-07: legalObjects/tables fehlten hier — bringToFront() unten hätte sonst einen z-Wert
    // ausgegeben, der unter einer bereits vorhandenen Tabellenkarte/einem juristischen Objekt
    // liegen kann (Reihenfolge-Bug, direkt durch die Registrierung von tables hier ausgelöst).
    ...(s.legalObjects ?? []).map((o) => o.zIndex),
    ...(s.tables ?? []).map((t) => t.zIndex),
    // 09-01: zeitleisten fehlte hier — derselbe 08-07-Reihenfolge-Bug wie oben, jetzt für die
    // erste neue Weltkartenart nach Phase 8 vorweggenommen statt erst nachträglich gefunden.
    ...(s.zeitleisten ?? []).map((z) => z.zIndex),
  );
}

/** Deterministische leichte Drehung aus der id, in [-3, 3] Grad. */
export function rotationFor(id: string): number {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) | 0;
  return ((Math.abs(h) % 61) - 30) / 10;
}

export function addDoc(
  s: DesktopState,
  fileId: string,
  name: string,
  position: Vec2,
  id: string = uid(),
  kind?: FileKind,
  meta?: CommandMeta,
  extern?: import('./extern').ExternRef,
): DesktopState {
  if (kind !== undefined && !FILE_KINDS.includes(kind)) throw new Error(`Unbekannte Datei-Art: ${String(kind)}`);
  if (s.docs.some((d) => d.fileId === fileId)) return s; // liegt schon auf dem Tisch
  const doc = {
    id, fileId, name, position, rotation: rotationFor(id), zIndex: maxZ(s) + 1,
    ...(kind !== undefined ? { kind } : {}),
    // extern wird nur geschrieben, wenn definiert — Additive-Only, Alt-Objekte bleiben feldlos.
    ...(extern !== undefined ? { extern } : {}),
    ...provenienz(meta),
  };
  return { ...s, docs: [...s.docs, doc] };
}

export function moveDoc(s: DesktopState, id: string, position: Vec2): DesktopState {
  return { ...s, docs: s.docs.map((d) => (d.id === id ? { ...d, position } : d)) };
}

/** Hebt ein Dokument, einen Stapel oder eine Tabellenkarte über alles andere. */
export function bringToFront(s: DesktopState, id: string): DesktopState {
  const z = maxZ(s) + 1;
  return {
    ...s,
    docs: s.docs.map((d) => (d.id === id ? { ...d, zIndex: z } : d)),
    stacks: s.stacks.map((st) => (st.id === id ? { ...st, zIndex: z } : st)),
    ...(s.notes ? { notes: s.notes.map((n) => (n.id === id ? { ...n, zIndex: z } : n)) } : {}),
    ...(s.cutouts ? { cutouts: s.cutouts.map((c) => (c.id === id ? { ...c, zIndex: z } : c)) } : {}),
    // 08-07: LegalObjectCard.svelte ruft bringToFront beim Anfassen auf (identische Mechanik zu
    // DocCard.svelte) — ohne diesen Zweig bliebe ein angefasstes juristisches Objekt optisch
    // hinter anderen Karten liegen (CR-02: maxZ() oben berücksichtigte legalObjects bereits,
    // dieser Zweig fehlte).
    ...(s.legalObjects ? { legalObjects: s.legalObjects.map((o) => (o.id === id ? { ...o, zIndex: z } : o)) } : {}),
    // 08-07: TableCard.svelte ruft bringToFront beim Anfassen auf (identische Mechanik zu
    // DocCard.svelte) — ohne diesen Zweig bliebe eine angefasste Tabellenkarte optisch hinter
    // anderen Karten liegen.
    ...(s.tables ? { tables: s.tables.map((t) => (t.id === id ? { ...t, zIndex: z } : t)) } : {}),
    // 09-01: ZeitleisteCard.svelte ruft bringToFront beim Anfassen auf, identische Mechanik.
    ...(s.zeitleisten ? { zeitleisten: s.zeitleisten.map((zl) => (zl.id === id ? { ...zl, zIndex: z } : zl)) } : {}),
  };
}

/** Querformat einmalig markieren (Client meldet es, sobald die erste Seite bekannt ist).
 *  Idempotent und ohne Fehlerfall — mehrere Clients dürfen gleichzeitig melden. */
export function setDocLandscape(s: DesktopState, docId: string): DesktopState {
  const doc = s.docs.find((d) => d.id === docId);
  if (!doc || doc.landscape) return s;
  return { ...s, docs: s.docs.map((d) => (d.id === docId ? { ...d, landscape: true as const } : d)) };
}

