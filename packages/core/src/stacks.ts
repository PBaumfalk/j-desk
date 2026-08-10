import { uid } from './uid';
import { findDoc, findStack, stackOf, provenienz, type DesktopState, type Vec2, type CommandMeta } from './model';
import { removeLinksFor } from './links';

export function stackDocs(
  s: DesktopState,
  draggedId: string,
  targetId: string,
  newStackId: string = uid(),
  meta?: CommandMeta,
): DesktopState {
  if (draggedId === targetId) return s;
  if (stackOf(s, draggedId)) return s; // erst aus dem alten Stapel ziehen
  const targetStack = findStack(s, targetId) ?? stackOf(s, targetId);
  if (targetStack) {
    if (targetStack.stapled) return s;
    // Karte wandert in einen BESTEHENDEN Stapel — kein neuer Stempel, der Stapel existierte schon.
    return {
      ...s,
      stacks: s.stacks.map((st) =>
        st.id === targetStack.id ? { ...st, docIds: [...st.docIds, draggedId] } : st,
      ),
    };
  }
  const target = findDoc(s, targetId);
  if (!target) return s;
  const stack = {
    id: newStackId,
    name: '',
    docIds: [targetId, draggedId],
    position: target.position,
    zIndex: target.zIndex,
    ...provenienz(meta),
  };
  return { ...s, stacks: [...s.stacks, stack] };
}

export function removeFromStack(s: DesktopState, docId: string, position: Vec2): DesktopState {
  const st = stackOf(s, docId);
  if (!st) return s;
  if (st.stapled) throw new Error('Konvolut zuerst entheften');
  let next: DesktopState = {
    ...s,
    docs: s.docs.map((d) => (d.id === docId ? { ...d, position } : d)),
    stacks: s.stacks.map((x) =>
      x.id === st.id ? { ...x, docIds: x.docIds.filter((i) => i !== docId) } : x,
    ),
  };
  if (findStack(next, st.id)!.docIds.length === 1) next = dissolveStack(next, st.id);
  return next;
}

export function dissolveStack(s: DesktopState, stackId: string): DesktopState {
  const st = findStack(s, stackId);
  if (!st) return s;
  if (st.stapled) throw new Error('Konvolut zuerst entheften');
  const docs = s.docs.map((d) => {
    const i = st.docIds.indexOf(d.id);
    return i < 0 ? d : { ...d, position: { x: st.position.x + i * 40, y: st.position.y + i * 24 } };
  });
  return removeLinksFor(
    { ...s, docs, stacks: s.stacks.filter((x) => x.id !== stackId) },
    stackId,
  );
}

export function renameStack(s: DesktopState, stackId: string, name: string): DesktopState {
  return { ...s, stacks: s.stacks.map((st) => (st.id === stackId ? { ...st, name } : st)) };
}

export function moveStack(s: DesktopState, stackId: string, position: Vec2): DesktopState {
  return { ...s, stacks: s.stacks.map((st) => (st.id === stackId ? { ...st, position } : st)) };
}

export function stapleStack(s: DesktopState, stackId: string): DesktopState {
  const st = findStack(s, stackId);
  if (!st) throw new Error(`Stapel "${stackId}" nicht gefunden`);
  return { ...s, stacks: s.stacks.map((x) => (x.id === stackId ? { ...x, stapled: true } : x)) };
}

export function unstapleStack(s: DesktopState, stackId: string): DesktopState {
  const st = findStack(s, stackId);
  if (!st) throw new Error(`Stapel "${stackId}" nicht gefunden`);
  return { ...s, stacks: s.stacks.map((x) => (x.id === stackId ? { ...x, stapled: false, open: false } : x)) };
}
