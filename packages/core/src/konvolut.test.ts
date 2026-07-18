import { describe, expect, it } from 'vitest';
import { emptyState, findStack, type DesktopState } from './model';
import { addDoc } from './documents';
import { stackDocs, dissolveStack, removeFromStack, stapleStack, unstapleStack } from './stacks';
import { extractPage } from './viewer';
import { konvolutPages, expandStack, collapseStack, setStackPage, resizeStack } from './konvolut';
import { hitTest } from './geometry';
import { applyCommand } from './commands';
import { removeDoc } from './removal';

function mitStapel(): DesktopState {
  let s = addDoc(emptyState(), 'f1', 'a.pdf', { x: 0, y: 0 }, 'd1');
  s = addDoc(s, 'f2', 'b.pdf', { x: 10, y: 10 }, 'd2');
  return stackDocs(s, 'd2', 'd1', 'st1');
}

describe('Hefter/Konvolut', () => {
  it('heftet und enthiftet; Entheften schließt den Viewer', () => {
    let s = stapleStack(mitStapel(), 'st1');
    expect(findStack(s, 'st1')?.stapled).toBe(true);
    s = expandStack(s, 'st1');
    s = unstapleStack(s, 'st1');
    expect(findStack(s, 'st1')?.stapled).toBe(false);
    expect(findStack(s, 'st1')?.open).toBe(false);
  });

  it('Guards: dissolve/removeFromStack verweigern am Konvolut, stackDocs prallt ab, hitTest ignoriert es', () => {
    let s = addDoc(mitStapel(), 'f3', 'c.pdf', { x: 500, y: 500 }, 'd3');
    s = stapleStack(s, 'st1');
    expect(() => dissolveStack(s, 'st1')).toThrow('entheften');
    expect(() => removeFromStack(s, 'd1', { x: 0, y: 0 })).toThrow('entheften');
    expect(stackDocs(s, 'd3', 'st1')).toBe(s);
    expect(hitTest(s, { x: 20, y: 20 }, 'd3')).toBeNull();
  });

  it('expandStack nur am Konvolut; setzt open/openSize/page mit Defaults', () => {
    expect(() => expandStack(mitStapel(), 'st1')).toThrow('geheftet');
    const s = expandStack(stapleStack(mitStapel(), 'st1'), 'st1');
    const st = findStack(s, 'st1')!;
    expect(st.open).toBe(true);
    expect(st.openSize).toEqual({ w: 560, h: 720 });
    expect(st.page).toBe(1);
  });

  it('collapse/setPage/resize spiegeln die Viewer-Semantik', () => {
    let s = expandStack(stapleStack(mitStapel(), 'st1'), 'st1');
    s = setStackPage(s, 'st1', 4);
    s = resizeStack(s, 'st1', { w: 700, h: 900 });
    s = collapseStack(s, 'st1');
    const st = findStack(s, 'st1')!;
    expect(st.page).toBe(4);
    expect(st.openSize).toEqual({ w: 700, h: 900 });
    expect(st.open).toBe(false);
    expect(() => setStackPage(s, 'st1', 0)).toThrow('Seite');
    expect(() => resizeStack(s, 'st1', { w: 0, h: 10 })).toThrow('Größe');
  });

  it('konvolutPages verkettet Mitgliederseiten in Stapelreihenfolge; Seitenkarten zählen 1', () => {
    // Stapel st1 = [d1 (unten), d2 (oben)] + herausgelöste Seitenkarte d3 (S. 5 von f1) obendrauf
    let s = extractPage(mitStapel(), 'd1', 5, { x: 200, y: 0 }, 'd3');
    s = stackDocs(s, 'd3', 'st1');
    s = stapleStack(s, 'st1');
    const st = findStack(s, 'st1')!;
    const pages = konvolutPages(s, st, { f1: 3, f2: 2 });
    expect(pages).toEqual([
      { docId: 'd1', fileId: 'f1', page: 1 },
      { docId: 'd1', fileId: 'f1', page: 2 },
      { docId: 'd1', fileId: 'f1', page: 3 },
      { docId: 'd2', fileId: 'f2', page: 1 },
      { docId: 'd2', fileId: 'f2', page: 2 },
      { docId: 'd3', fileId: 'f1', page: 5 },
    ]);
    expect(konvolutPages(s, st, { f1: 3 })).toBeNull(); // f2 unbekannt -> null
  });

  it('removeDoc am gehefteten 2er-Konvolut: enthäftet vor dem Auto-Auflösen statt zu werfen (j-lawyer-Sync-Deadlock)', () => {
    let s = stapleStack(mitStapel(), 'st1');
    expect(() => removeDoc(s, 'd2')).not.toThrow();
    s = removeDoc(s, 'd2');
    expect(s.stacks).toHaveLength(0);
    expect(s.docs.some((d) => d.id === 'd1')).toBe(true);
  });

  it('Commands laufen durch applyCommand', () => {
    let s = applyCommand(mitStapel(), { type: 'stapleStack', payload: { stackId: 'st1' } });
    s = applyCommand(s, { type: 'expandStack', payload: { id: 'st1' } });
    s = applyCommand(s, { type: 'setStackPage', payload: { id: 'st1', page: 2 } });
    s = applyCommand(s, { type: 'resizeStack', payload: { id: 'st1', size: { w: 600, h: 800 } } });
    s = applyCommand(s, { type: 'collapseStack', payload: { id: 'st1' } });
    s = applyCommand(s, { type: 'unstapleStack', payload: { stackId: 'st1' } });
    expect(findStack(s, 'st1')).toMatchObject({ stapled: false, open: false, page: 2 });
  });
});
