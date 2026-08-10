import { describe, expect, it } from 'vitest';
import { addDoc } from './documents';
import { addCutout, TEXT_SNAPSHOT_MAX } from './cutouts';
import { addMark } from './marks';
import { copyObject } from './copy';
import { applyCommand, emptyState, type CommandMeta, type DesktopState } from './index';

const anna: CommandMeta = { createdBy: 'anna', createdAt: '2026-07-19T10:00:00.000Z' };

const base = () => addDoc(emptyState(), 'file-a', 'a.pdf', { x: 0, y: 0 }, 'doc-a');

describe('Sprung zur Quelle: textSnapshot/fileSha256', () => {
  describe('addCutout', () => {
    it('übernimmt textSnapshot und fileSha256, wenn übergeben', () => {
      const s = addCutout(base(), 'doc-a', 1, { x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 0 }, 'cut-1', undefined, {
        textSnapshot: 'Hallo Welt',
        fileSha256: 'abc123',
      });
      expect(s.cutouts![0].textSnapshot).toBe('Hallo Welt');
      expect(s.cutouts![0].fileSha256).toBe('abc123');
    });

    it('lässt die Felder weg, wenn nicht übergeben (Altverhalten)', () => {
      const s = addCutout(base(), 'doc-a', 1, { x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 0 }, 'cut-1');
      expect(s.cutouts![0]).not.toHaveProperty('textSnapshot');
      expect(s.cutouts![0]).not.toHaveProperty('fileSha256');
    });

    it('kappt textSnapshot auf genau TEXT_SNAPSHOT_MAX Zeichen', () => {
      const langerText = 'x'.repeat(TEXT_SNAPSHOT_MAX + 500);
      const s = addCutout(base(), 'doc-a', 1, { x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 0 }, 'cut-1', undefined, {
        textSnapshot: langerText,
      });
      expect(s.cutouts![0].textSnapshot).toHaveLength(TEXT_SNAPSHOT_MAX);
      expect(s.cutouts![0].textSnapshot).toBe('x'.repeat(TEXT_SNAPSHOT_MAX));
    });

    it('lässt textSnapshot weg, wenn leerer String übergeben wird', () => {
      const s = addCutout(base(), 'doc-a', 1, { x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 0 }, 'cut-1', undefined, {
        textSnapshot: '',
      });
      expect(s.cutouts![0]).not.toHaveProperty('textSnapshot');
    });

    it('kombiniert Provenienz-Meta (createdBy) und textSnapshot am selben Objekt', () => {
      const s = addCutout(base(), 'doc-a', 1, { x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 0 }, 'cut-1', anna, {
        textSnapshot: 'Beleg-Text',
      });
      expect(s.cutouts![0].createdBy).toBe('anna');
      expect(s.cutouts![0].createdAt).toBe('2026-07-19T10:00:00.000Z');
      expect(s.cutouts![0].textSnapshot).toBe('Beleg-Text');
    });
  });

  describe('addMark', () => {
    const markBase = { docId: 'doc-a', page: 1, rect: { x: 0, y: 0, w: 10, h: 10 }, kind: 'tippex' as const };

    it('übernimmt textSnapshot, wenn übergeben', () => {
      const s = addMark(base(), { ...markBase, textSnapshot: 'Original Absatz' });
      expect(s.marks![0].textSnapshot).toBe('Original Absatz');
    });

    it('lässt das Feld weg, wenn nicht übergeben (Altverhalten)', () => {
      const s = addMark(base(), { ...markBase });
      expect(s.marks![0]).not.toHaveProperty('textSnapshot');
    });

    it('kappt textSnapshot auf genau TEXT_SNAPSHOT_MAX Zeichen', () => {
      const langerText = 'y'.repeat(TEXT_SNAPSHOT_MAX + 250);
      const s = addMark(base(), { ...markBase, textSnapshot: langerText });
      expect(s.marks![0].textSnapshot).toHaveLength(TEXT_SNAPSHOT_MAX);
      expect(s.marks![0].textSnapshot).toBe('y'.repeat(TEXT_SNAPSHOT_MAX));
    });

    it('lässt textSnapshot weg, wenn leerer String übergeben wird', () => {
      const s = addMark(base(), { ...markBase, textSnapshot: '' });
      expect(s.marks![0]).not.toHaveProperty('textSnapshot');
    });

    it('kombiniert Provenienz-Meta (createdBy) und textSnapshot am selben Objekt', () => {
      const s = addMark(base(), { ...markBase, textSnapshot: 'Geschwärzter Satz' }, anna);
      expect(s.marks![0].createdBy).toBe('anna');
      expect(s.marks![0].textSnapshot).toBe('Geschwärzter Satz');
    });
  });

  describe('Handler-Payload (commands.ts / applyCommand)', () => {
    function addCutoutCmd(s: DesktopState, extra: Record<string, unknown> = {}): DesktopState {
      return applyCommand(s, {
        type: 'addCutout',
        payload: { docId: 'doc-a', page: 1, rect: { x: 0, y: 0, w: 10, h: 10 }, position: { x: 0, y: 0 }, ...extra },
      });
    }

    it('addCutout-Handler liest textSnapshot und fileSha256 aus dem Payload', () => {
      const s = addCutoutCmd(base(), { textSnapshot: 'Rechnungstext', fileSha256: 'sha-1' });
      expect(s.cutouts![0].textSnapshot).toBe('Rechnungstext');
      expect(s.cutouts![0].fileSha256).toBe('sha-1');
    });

    it('addCutout-Handler ignoriert Nicht-String-Werte, ohne Fehler zu werfen', () => {
      const s = addCutoutCmd(base(), { textSnapshot: 12345, fileSha256: { hash: 'x' } });
      expect(s.cutouts![0]).not.toHaveProperty('textSnapshot');
      expect(s.cutouts![0]).not.toHaveProperty('fileSha256');
    });

    it('addMark-Handler liest textSnapshot via markPayload aus dem Payload', () => {
      const s = applyCommand(base(), {
        type: 'addMark',
        payload: { mark: { docId: 'doc-a', page: 1, rect: { x: 0, y: 0, w: 10, h: 10 }, kind: 'redact', textSnapshot: 'Geheim' } },
      });
      expect(s.marks![0].textSnapshot).toBe('Geheim');
    });

    it('addMark-Handler ignoriert Nicht-String-Werte für textSnapshot, ohne Fehler zu werfen', () => {
      const s = applyCommand(base(), {
        type: 'addMark',
        payload: { mark: { docId: 'doc-a', page: 1, rect: { x: 0, y: 0, w: 10, h: 10 }, kind: 'redact', textSnapshot: 999 } },
      });
      expect(s.marks![0]).not.toHaveProperty('textSnapshot');
    });
  });

  describe('copyObject behält Inhalts-Metadaten von Cutouts', () => {
    it('kopiert textSnapshot und fileSha256 mit, ohne sie zu strippen (anders als createdBy/createdAt)', () => {
      let s = addCutout(base(), 'doc-a', 1, { x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 0 }, 'cut-1', anna, {
        textSnapshot: 'Erhaltener Text',
        fileSha256: 'sha-original',
      });
      s = copyObject(s, 'cut-1', { createdBy: 'bert', createdAt: '2026-07-19T11:00:00.000Z' });
      const kopie = s.cutouts!.find((c) => c.id !== 'cut-1')!;
      expect(kopie.textSnapshot).toBe('Erhaltener Text');
      expect(kopie.fileSha256).toBe('sha-original');
      // Provenienz hingegen wird neu gestempelt (anderer Mechanismus).
      expect(kopie.createdBy).toBe('bert');
    });
  });
});
