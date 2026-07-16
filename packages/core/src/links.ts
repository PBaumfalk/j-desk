import { findDoc, findStack, type DesktopState, type Doc } from './model';

export function addLink(
  s: DesktopState,
  fromId: string,
  toId: string,
  id: string = crypto.randomUUID(),
): DesktopState {
  if (fromId === toId) return s;
  const exists = s.links.some(
    (l) => (l.fromId === fromId && l.toId === toId) || (l.fromId === toId && l.toId === fromId),
  );
  if (exists) return s;
  return { ...s, links: [...s.links, { id, fromId, toId, note: '' }] };
}

export function setLinkNote(s: DesktopState, linkId: string, note: string): DesktopState {
  return { ...s, links: s.links.map((l) => (l.id === linkId ? { ...l, note } : l)) };
}

export function removeLink(s: DesktopState, linkId: string): DesktopState {
  return { ...s, links: s.links.filter((l) => l.id !== linkId) };
}

export function removeLinksFor(s: DesktopState, entityId: string): DesktopState {
  return { ...s, links: s.links.filter((l) => l.fromId !== entityId && l.toId !== entityId) };
}

export function linkedEntityIds(s: DesktopState, entityId: string): string[] {
  return s.links
    .filter((l) => l.fromId === entityId || l.toId === entityId)
    .map((l) => (l.fromId === entityId ? l.toId : l.fromId));
}

/** Dokumente der Entität selbst plus aller direkt verknüpften Entitäten (Stapel → enthaltene Dokumente), dedupliziert. */
export function collectLinkedDocs(s: DesktopState, entityId: string): Doc[] {
  const docs = new Map<string, Doc>();
  const addEntity = (id: string) => {
    const st = findStack(s, id);
    if (st) {
      for (const docId of st.docIds) {
        const d = findDoc(s, docId);
        if (d) docs.set(d.id, d);
      }
      return;
    }
    const d = findDoc(s, id);
    if (d) docs.set(d.id, d);
  };
  addEntity(entityId);
  for (const other of linkedEntityIds(s, entityId)) addEntity(other);
  return [...docs.values()];
}
