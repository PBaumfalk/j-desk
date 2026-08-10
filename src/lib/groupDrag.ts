import {
  clipMembersOf, findDoc, findStack, findNote, findCutout, findLegalObject, findTable, findZeitleiste, isTaped,
  moveDoc, moveStack, moveNote, moveCutout, moveLegalObject, moveTable, moveZeitleiste, type DesktopState,
} from '@j-desk/core';
import { desktop } from './store.svelte';

function moveAny(s: DesktopState, id: string, dx: number, dy: number): DesktopState {
  const doc = findDoc(s, id);
  if (doc) return moveDoc(s, id, { x: doc.position.x + dx, y: doc.position.y + dy });
  const st = findStack(s, id);
  if (st) return moveStack(s, id, { x: st.position.x + dx, y: st.position.y + dy });
  const n = findNote(s, id);
  if (n) return moveNote(s, id, { x: n.position.x + dx, y: n.position.y + dy });
  const c = findCutout(s, id);
  if (c) return moveCutout(s, id, { x: c.position.x + dx, y: c.position.y + dy });
  // WR-02: LegalObjectCard.svelte nutzt dieselbe Klammer-Gruppenzug-Mechanik wie DocCard/
  // CutoutCard/TableCard — ohne diesen Zweig bliebe ein geklammertes juristisches Objekt beim
  // Gruppenzug unbewegt stehen und die Gruppe fiele optisch auseinander.
  const o = findLegalObject(s, id);
  if (o) return moveLegalObject(s, id, { x: o.position.x + dx, y: o.position.y + dy });
  // 08-07: TableCard.svelte nutzt dieselbe Klammer-Gruppenzug-Mechanik wie DocCard/CutoutCard —
  // ohne diesen Zweig bliebe eine geklammerte Tabellenkarte beim Gruppenzug (und beim Ziehen
  // ihrer selbst über moveGroupLocal) unbewegt stehen.
  const t = findTable(s, id);
  if (t) return moveTable(s, id, { x: t.position.x + dx, y: t.position.y + dy });
  // 09-01: ZeitleisteCard.svelte nutzt dieselbe Klammer-Gruppenzug-Mechanik wie DocCard/TableCard —
  // ohne diesen Zweig bliebe eine geklammerte Zeitleiste beim Gruppenzug unbewegt stehen.
  const zl = findZeitleiste(s, id);
  if (zl) return moveZeitleiste(s, id, { x: zl.position.x + dx, y: zl.position.y + dy });
  return s;
}

/** Büroklammer-Gruppenzug: alle Mitglieder folgen demselben Delta (nur lokal, ohne Server-Roundtrip). */
// Festgeklebte Mitglieder bleiben kleben — die Klebeband-Zusicherung "Ziehen gesperrt" gilt pro
// Objekt, auch innerhalb einer Klammer-Gruppe. Der Rest der Gruppe bewegt sich trotzdem.
export function moveGroupLocal(memberIds: string[], dx: number, dy: number): void {
  desktop.applyLocal((s) => memberIds.reduce((acc, id) => (isTaped(s, id) ? acc : moveAny(acc, id, dx, dy)), s));
}

/** Persistiert die aktuellen Positionen aller Gruppen-Mitglieder nach dem Loslassen. */
export function commitGroupMove(memberIds: string[]): void {
  const s = desktop.state;
  for (const id of memberIds) {
    if (isTaped(s, id)) continue; // festgeklebt: nicht bewegt, nichts zu persistieren
    const doc = findDoc(s, id);
    if (doc) { void desktop.command('moveDoc', { id, position: { ...doc.position } }); continue; }
    const st = findStack(s, id);
    if (st) { void desktop.command('moveStack', { stackId: id, position: { ...st.position } }); continue; }
    const n = findNote(s, id);
    if (n) { void desktop.command('moveNote', { id, position: { ...n.position } }); continue; }
    const c = findCutout(s, id);
    if (c) { void desktop.command('moveCutout', { id, position: { ...c.position } }); continue; }
    const o = findLegalObject(s, id);
    if (o) { void desktop.command('moveLegalObject', { id, position: { ...o.position } }); continue; }
    const t = findTable(s, id);
    if (t) { void desktop.command('moveTable', { id, position: { ...t.position } }); continue; }
    const zl = findZeitleiste(s, id);
    if (zl) void desktop.command('moveZeitleiste', { id, position: { ...zl.position } });
  }
}

/** Mitglieder der Klammer-Gruppe des Objekts (inklusive seiner selbst). */
export function groupOf(id: string): string[] {
  return clipMembersOf(desktop.state, id);
}
