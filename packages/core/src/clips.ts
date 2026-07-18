import type { DesktopState } from './model';
import { uid } from './uid';

/** Büroklammer: lose Gruppe — Objekte bleiben einzeln liegen, werden aber gemeinsam verschoben. */
export interface Clip {
  id: string;
  memberIds: string[];   // Doc-/Stack-/Note-/Cutout-ids
}

function objectExists(s: DesktopState, id: string): boolean {
  return (
    s.docs.some((d) => d.id === id) ||
    s.stacks.some((st) => st.id === id) ||
    (s.notes ?? []).some((n) => n.id === id) ||
    (s.cutouts ?? []).some((c) => c.id === id)
  );
}

export function clipOf(s: DesktopState, objectId: string): Clip | undefined {
  return (s.clips ?? []).find((c) => c.memberIds.includes(objectId));
}

/** Mitglieder der Gruppe des Objekts inklusive seiner selbst; ohne Gruppe nur das Objekt. */
export function clipMembersOf(s: DesktopState, objectId: string): string[] {
  return clipOf(s, objectId)?.memberIds ?? [objectId];
}

export function addClip(s: DesktopState, aId: string, bId: string, id: string = uid()): DesktopState {
  if (aId === bId) throw new Error('Ein Objekt lässt sich nicht mit sich selbst klammern');
  if (!objectExists(s, aId)) throw new Error(`Objekt "${aId}" nicht gefunden`);
  if (!objectExists(s, bId)) throw new Error(`Objekt "${bId}" nicht gefunden`);
  const a = clipOf(s, aId);
  const b = clipOf(s, bId);
  if (a && b) {
    if (a.id === b.id) return s; // schon zusammen geklammert
    // Zwei Gruppen verschmelzen in die erste
    const merged = { ...a, memberIds: [...a.memberIds, ...b.memberIds.filter((m) => !a.memberIds.includes(m))] };
    return { ...s, clips: (s.clips ?? []).filter((c) => c.id !== b.id).map((c) => (c.id === a.id ? merged : c)) };
  }
  const existing = a ?? b;
  if (existing) {
    const newcomer = a ? bId : aId;
    return {
      ...s,
      clips: (s.clips ?? []).map((c) => (c.id === existing.id ? { ...c, memberIds: [...c.memberIds, newcomer] } : c)),
    };
  }
  return { ...s, clips: [...(s.clips ?? []), { id, memberIds: [aId, bId] }] };
}

export function removeClip(s: DesktopState, clipId: string): DesktopState {
  const clips = s.clips ?? [];
  if (!clips.some((c) => c.id === clipId)) throw new Error(`Klammer "${clipId}" nicht gefunden`);
  return { ...s, clips: clips.filter((c) => c.id !== clipId) };
}

/** Objekt verlässt seine Gruppe (Aufräumen bei Entfernen/Papierkorb); Gruppen < 2 lösen sich auf. */
export function removeFromClips(s: DesktopState, objectId: string): DesktopState {
  const clips = s.clips ?? [];
  if (!clips.some((c) => c.memberIds.includes(objectId))) return s;
  return {
    ...s,
    clips: clips
      .map((c) => ({ ...c, memberIds: c.memberIds.filter((m) => m !== objectId) }))
      .filter((c) => c.memberIds.length >= 2),
  };
}
