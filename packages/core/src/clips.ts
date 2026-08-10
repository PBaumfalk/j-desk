import { provenienz, type DesktopState, type CommandMeta } from './model';
import { uid } from './uid';

/** Büroklammer: lose Gruppe — Objekte bleiben einzeln liegen, werden aber gemeinsam verschoben. */
export interface Clip {
  id: string;
  memberIds: string[];   // Doc-/Stack-/Note-/Cutout-ids
  createdBy?: string;    // Provenienz: wer hat die Klammer erzeugt; fehlt in Alt-States
  createdById?: string;  // Provenienz: stabile users.id des Erzeugers (WR-05); fehlt in Alt-States
  createdAt?: string;    // Provenienz: wann, ISO-Zeitpunkt; fehlt in Alt-States
  updatedRev?: number;   // Konflikterkennung: Schreibtisch-rev der letzten Änderung; fehlt in Alt-States
  updatedAt?: string;    // Provenienz: wann zuletzt geändert, ISO-Zeitpunkt; fehlt in Alt-States
  updatedBy?: string;    // Provenienz: wer zuletzt geändert hat; fehlt in Alt-States
  layerId?: string;      // Sichtbarkeits-/Bearbeitungsebene; fehlt in Alt-States (implizit "Kanzlei")
  freigabe?: import('./freigabe').Freigabe; // Freigabe-Override (EXP-03); fehlt in Alt-States (implizit Ebenen-Default, fail-closed 'intern', D-14)
}

function objectExists(s: DesktopState, id: string): boolean {
  return (
    s.docs.some((d) => d.id === id) ||
    s.stacks.some((st) => st.id === id) ||
    (s.notes ?? []).some((n) => n.id === id) ||
    (s.cutouts ?? []).some((c) => c.id === id) ||
    (s.legalObjects ?? []).some((o) => o.id === id) ||
    (s.tables ?? []).some((t) => t.id === id) ||
    (s.zeitleisten ?? []).some((z) => z.id === id)
  );
}

export function clipOf(s: DesktopState, objectId: string): Clip | undefined {
  return (s.clips ?? []).find((c) => c.memberIds.includes(objectId));
}

/** Mitglieder der Gruppe des Objekts inklusive seiner selbst; ohne Gruppe nur das Objekt. */
export function clipMembersOf(s: DesktopState, objectId: string): string[] {
  return clipOf(s, objectId)?.memberIds ?? [objectId];
}

export function addClip(s: DesktopState, aId: string, bId: string, id: string = uid(), meta?: CommandMeta): DesktopState {
  if (aId === bId) throw new Error('Ein Objekt lässt sich nicht mit sich selbst klammern');
  if (!objectExists(s, aId)) throw new Error(`Objekt "${aId}" nicht gefunden`);
  if (!objectExists(s, bId)) throw new Error(`Objekt "${bId}" nicht gefunden`);
  const a = clipOf(s, aId);
  const b = clipOf(s, bId);
  if (a && b) {
    if (a.id === b.id) return s; // schon zusammen geklammert
    // Zwei Gruppen verschmelzen in die erste — keine neue Klammer, kein neuer Stempel
    const merged = { ...a, memberIds: [...a.memberIds, ...b.memberIds.filter((m) => !a.memberIds.includes(m))] };
    return { ...s, clips: (s.clips ?? []).filter((c) => c.id !== b.id).map((c) => (c.id === a.id ? merged : c)) };
  }
  const existing = a ?? b;
  if (existing) {
    // Beitritt zu einer BESTEHENDEN Klammer — kein neuer Stempel
    const newcomer = a ? bId : aId;
    return {
      ...s,
      clips: (s.clips ?? []).map((c) => (c.id === existing.id ? { ...c, memberIds: [...c.memberIds, newcomer] } : c)),
    };
  }
  return {
    ...s,
    clips: [...(s.clips ?? []), { id, memberIds: [aId, bId], ...provenienz(meta) }],
  };
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
    // Nur die betroffene(n) Klammer(n) neu bauen — unbeteiligte Klammern bleiben referenzgleich,
    // sonst würde die zentrale Stempelung (stempel.ts) sie fälschlich als geändert erkennen.
    clips: clips
      .map((c) => (c.memberIds.includes(objectId) ? { ...c, memberIds: c.memberIds.filter((m) => m !== objectId) } : c))
      .filter((c) => c.memberIds.length >= 2),
  };
}
