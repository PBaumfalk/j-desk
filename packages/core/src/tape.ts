import type { DesktopState } from './model';

/** Klebeband: Objekt ist am Tisch festgeklebt — Drag gesperrt, bis das Band abgezogen wird. */
export function setTaped(s: DesktopState, objectId: string, taped: boolean): DesktopState {
  const flag = taped ? { taped: true as const } : {};
  const strip = <T extends { taped?: boolean }>(o: T): T => {
    const { taped: _weg, ...rest } = o;
    return { ...(rest as T), ...flag };
  };
  if (s.docs.some((d) => d.id === objectId)) {
    return { ...s, docs: s.docs.map((d) => (d.id === objectId ? strip(d) : d)) };
  }
  if (s.stacks.some((st) => st.id === objectId)) {
    return { ...s, stacks: s.stacks.map((st) => (st.id === objectId ? strip(st) : st)) };
  }
  if ((s.notes ?? []).some((n) => n.id === objectId)) {
    return { ...s, notes: (s.notes ?? []).map((n) => (n.id === objectId ? strip(n) : n)) };
  }
  if ((s.cutouts ?? []).some((c) => c.id === objectId)) {
    return { ...s, cutouts: (s.cutouts ?? []).map((c) => (c.id === objectId ? strip(c) : c)) };
  }
  throw new Error(`Objekt "${objectId}" nicht gefunden`);
}

export function isTaped(s: DesktopState, objectId: string): boolean {
  return (
    s.docs.find((d) => d.id === objectId)?.taped === true ||
    s.stacks.find((st) => st.id === objectId)?.taped === true ||
    (s.notes ?? []).find((n) => n.id === objectId)?.taped === true ||
    (s.cutouts ?? []).find((c) => c.id === objectId)?.taped === true
  );
}
