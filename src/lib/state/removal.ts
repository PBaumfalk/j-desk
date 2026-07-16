import { findStack, stackOf, type DesktopState } from './model';
import { removeLinksFor } from './links';
import { dissolveStack } from './stacks';

export function removeDoc(s: DesktopState, docId: string): DesktopState {
  const st = stackOf(s, docId);
  let next = removeLinksFor(s, docId);
  next = { ...next, docs: next.docs.filter((d) => d.id !== docId) };
  if (st) {
    next = {
      ...next,
      stacks: next.stacks.map((x) =>
        x.id === st.id ? { ...x, docIds: x.docIds.filter((i) => i !== docId) } : x,
      ),
    };
    if (findStack(next, st.id)!.docIds.length === 1) next = dissolveStack(next, st.id);
  }
  return next;
}

export function removeStack(s: DesktopState, stackId: string): DesktopState {
  const st = findStack(s, stackId);
  if (!st) return s;
  let next = removeLinksFor(s, stackId);
  for (const docId of st.docIds) next = removeLinksFor(next, docId);
  return {
    ...next,
    docs: next.docs.filter((d) => !st.docIds.includes(d.id)),
    stacks: next.stacks.filter((x) => x.id !== stackId),
  };
}
