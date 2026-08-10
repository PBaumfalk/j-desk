import { describe, it, expect } from 'vitest';
import { sanitizeForExport, validateImportState, nurBekannteFelder, mapFileIds } from './jdesk';
import type { DesktopState } from './model';

const doc = {
  id: 'd1', fileId: 'f1', name: 'Akte.pdf',
  position: { x: 0, y: 0 }, rotation: 0, zIndex: 1,
};

function state(teil: Partial<DesktopState> = {}): DesktopState {
  return { docs: [doc], links: [], stacks: [], ...teil };
}

const rect = (x: number, y: number) => ({ x, y, w: 50, h: 20 });

describe('sanitizeForExport', () => {
  it('nimmt der Schwärzung ihren eigenen Klartext', () => {
    const s = sanitizeForExport(state({
      marks: [{ id: 'm1', docId: 'd1', page: 1, rect: rect(10, 10), kind: 'redact', textSnapshot: 'geheim' }],
    }));
    expect(s.marks![0].textSnapshot).toBeUndefined();
    expect(s.marks![0].rect).toEqual(rect(10, 10)); // Fläche bleibt erhalten
  });

  it('nimmt einem überlappenden Ausschnitt den Klartext', () => {
    const s = sanitizeForExport(state({
      marks: [{ id: 'm1', docId: 'd1', page: 1, rect: rect(10, 10), kind: 'redact' }],
      cutouts: [{
        id: 'c1', fileId: 'f1', page: 1, rect: rect(30, 20),
        position: { x: 0, y: 0 }, zIndex: 2, textSnapshot: 'geheim',
      }],
    }));
    expect(s.cutouts![0].textSnapshot).toBeUndefined();
  });

  it('lässt einen nicht überlappenden Ausschnitt unangetastet', () => {
    const s = sanitizeForExport(state({
      marks: [{ id: 'm1', docId: 'd1', page: 1, rect: rect(10, 10), kind: 'redact' }],
      cutouts: [{
        id: 'c1', fileId: 'f1', page: 1, rect: rect(500, 500),
        position: { x: 0, y: 0 }, zIndex: 2, textSnapshot: 'harmlos',
      }],
    }));
    expect(s.cutouts![0].textSnapshot).toBe('harmlos');
  });

  it('unterscheidet Seiten', () => {
    const s = sanitizeForExport(state({
      marks: [{ id: 'm1', docId: 'd1', page: 1, rect: rect(10, 10), kind: 'redact' }],
      cutouts: [{
        id: 'c1', fileId: 'f1', page: 2, rect: rect(10, 10),
        position: { x: 0, y: 0 }, zIndex: 2, textSnapshot: 'andere Seite',
      }],
    }));
    expect(s.cutouts![0].textSnapshot).toBe('andere Seite');
  });

  it('bereinigt auch Papierkorb-Kopien', () => {
    const s = sanitizeForExport(state({
      trash: [{
        id: 't1', kind: 'doc', name: 'Akte.pdf', trashedAt: '2026-07-20T10:00:00.000Z',
        payload: {
          docs: [{ ...doc, id: 'd9', fileId: 'f9' }], notes: [], cutouts: [], stacks: [],
          strokes: [],
          marks: [{ id: 'm9', docId: 'd9', page: 1, rect: rect(10, 10), kind: 'redact', textSnapshot: 'geheim' }],
          stamps: [], flags: [],
        },
      }],
    }));
    expect(s.trash![0].payload.marks[0].textSnapshot).toBeUndefined();
  });

  it('eine Schwärzung im Papierkorb wirkt auf den Live-Ausschnitt (bewusst zu viel entfernen)', () => {
    const s = sanitizeForExport(state({
      cutouts: [{
        id: 'c1', fileId: 'f1', page: 1, rect: rect(10, 10),
        position: { x: 0, y: 0 }, zIndex: 2, textSnapshot: 'geheim',
      }],
      trash: [{
        id: 't1', kind: 'doc', name: 'Alt.pdf', trashedAt: '2026-07-20T10:00:00.000Z',
        payload: {
          docs: [{ ...doc, id: 'd9' }], notes: [], cutouts: [], stacks: [], strokes: [],
          marks: [{ id: 'm9', docId: 'd9', page: 1, rect: rect(10, 10), kind: 'redact' }],
          stamps: [], flags: [],
        },
      }],
    }));
    expect(s.cutouts![0].textSnapshot).toBeUndefined();
  });

  it('lässt den Eingabezustand unverändert', () => {
    const eingabe = state({
      marks: [{ id: 'm1', docId: 'd1', page: 1, rect: rect(10, 10), kind: 'redact', textSnapshot: 'geheim' }],
    });
    sanitizeForExport(eingabe);
    expect(eingabe.marks![0].textSnapshot).toBe('geheim');
  });
});

describe('validateImportState', () => {
  it('nimmt einen sauberen Zustand an', () => {
    expect(validateImportState(state())).toEqual({ ok: true });
  });

  it('lehnt Nicht-Zustände ab', () => {
    expect(validateImportState(null).ok).toBe(false);
    expect(validateImportState({ docs: 'nein' }).ok).toBe(false);
  });

  it('lehnt eine Verknüpfung ins Leere ab', () => {
    const p = validateImportState(state({
      links: [{ id: 'l1', fromId: 'd1', toId: 'gibtsnicht', note: '' }],
    }));
    expect(p.ok).toBe(false);
    expect(p.ok === false && p.grund).toContain('l1');
  });

  it('lehnt einen Stapel mit unbekanntem Dokument ab', () => {
    const p = validateImportState(state({
      stacks: [{ id: 's1', name: 'Stapel', docIds: ['d1', 'weg'], position: { x: 0, y: 0 }, zIndex: 1 }],
    }));
    expect(p.ok).toBe(false);
    expect(p.ok === false && p.grund).toContain('weg');
  });

  it('lehnt eine Fläche auf unbekanntem Dokument ab', () => {
    const p = validateImportState(state({
      marks: [{ id: 'm1', docId: 'weg', page: 1, rect: rect(1, 1), kind: 'tippex' }],
    }));
    expect(p.ok).toBe(false);
  });

  it('lehnt eine Klammer mit unbekanntem Mitglied ab', () => {
    const p = validateImportState(state({ clips: [{ id: 'k1', memberIds: ['d1', 'weg'] }] }));
    expect(p.ok).toBe(false);
  });

  it('lehnt eine Klammer ohne Mitgliederliste sauber ab', () => {
    const p = validateImportState(state({ clips: [{ id: 'k1' } as any] }));
    expect(p.ok).toBe(false);
    expect(p.ok === false && p.grund).toContain('k1');
  });

  it('lehnt einen kaputten Stapel (null) ab, statt zu werfen', () => {
    expect(() => validateImportState(state({ stacks: [null as any] }))).not.toThrow();
    const p = validateImportState(state({ stacks: [null as any] }));
    expect(p.ok).toBe(false);
  });

  it('lehnt eine kaputte Notiz (null) ab, statt zu werfen', () => {
    expect(() => validateImportState(state({ notes: [null as any] }))).not.toThrow();
    const p = validateImportState(state({ notes: [null as any] }));
    expect(p.ok).toBe(false);
  });

  it('lehnt einen kaputten Ausschnitt (null) ab, statt zu werfen', () => {
    expect(() => validateImportState(state({ cutouts: [null as any] }))).not.toThrow();
    const p = validateImportState(state({ cutouts: [null as any] }));
    expect(p.ok).toBe(false);
  });

  it('lehnt eine kaputte Verknüpfung (null) ab, statt zu werfen', () => {
    expect(() => validateImportState(state({ links: [null as any] }))).not.toThrow();
    const p = validateImportState(state({ links: [null as any] }));
    expect(p.ok).toBe(false);
  });

  it('lehnt eine kaputte Klammer (null) ab, statt zu werfen', () => {
    expect(() => validateImportState(state({ clips: [null as any] }))).not.toThrow();
    const p = validateImportState(state({ clips: [null as any] }));
    expect(p.ok).toBe(false);
  });

  it('lehnt eine kaputte Fläche (null) ab, statt zu werfen', () => {
    expect(() => validateImportState(state({ marks: [null as any] }))).not.toThrow();
    const p = validateImportState(state({ marks: [null as any] }));
    expect(p.ok).toBe(false);
  });

  it('lehnt eine kaputte Fahne (null) ab, statt zu werfen', () => {
    expect(() => validateImportState(state({ flags: [null as any] }))).not.toThrow();
    const p = validateImportState(state({ flags: [null as any] }));
    expect(p.ok).toBe(false);
  });
});

describe('nurBekannteFelder', () => {
  it('verwirft unbekannte Felder oberster Ebene', () => {
    const roh = { ...state(), schadcode: 'weg', __proto__x: 1 } as unknown as DesktopState;
    const s = nurBekannteFelder(roh);
    expect('schadcode' in s).toBe(false);
    expect(s.docs).toHaveLength(1);
  });

  it('lässt fehlende Optionalfelder fehlen', () => {
    const s = nurBekannteFelder(state());
    expect('marks' in s).toBe(false);
  });
});

describe('mapFileIds', () => {
  it('schreibt Dokument- und Ausschnitt-Verweise um', () => {
    const s = mapFileIds(
      state({
        cutouts: [{ id: 'c1', fileId: 'f1', page: 1, rect: rect(1, 1), position: { x: 0, y: 0 }, zIndex: 2 }],
      }),
      new Map([['f1', 'neu-1']]),
    );
    expect(s.docs[0].fileId).toBe('neu-1');
    expect(s.cutouts![0].fileId).toBe('neu-1');
  });

  it('lässt unbekannte fileIds stehen', () => {
    const s = mapFileIds(state(), new Map([['anderes', 'neu-1']]));
    expect(s.docs[0].fileId).toBe('f1');
  });

  it('schreibt auch Papierkorb-Kopien um', () => {
    const s = mapFileIds(
      state({
        trash: [{
          id: 't1', kind: 'doc', name: 'Akte.pdf', trashedAt: '2026-07-20T10:00:00.000Z',
          payload: { docs: [doc], notes: [], cutouts: [], stacks: [], strokes: [], marks: [], stamps: [], flags: [] },
        }],
      }),
      new Map([['f1', 'neu-1']]),
    );
    expect(s.trash![0].payload.docs[0].fileId).toBe('neu-1');
  });
});
