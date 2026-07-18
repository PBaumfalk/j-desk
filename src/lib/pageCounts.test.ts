import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: vi.fn(() => ({ promise: Promise.resolve({ numPages: 7, destroy: vi.fn() }) })),
}));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }));
vi.mock('./idb', () => ({
  FILE_STORE: 'files',
  idbGet: async () => null,
  idbPut: async () => {},
}));
vi.mock('./previewPoll', () => ({
  fetchPreviewBytes: vi.fn(),
}));

import * as pdfjs from 'pdfjs-dist';
import { fetchPreviewBytes } from './previewPoll';
import { getPageCount, invalidatePageCounts } from './pageCounts';

const api = { fetchFile: vi.fn(async () => new Uint8Array([1, 2, 3])) } as never;

describe('pageCounts', () => {
  beforeEach(() => {
    invalidatePageCounts();
    vi.clearAllMocks();
  });

  it('liefert die Seitenzahl und cacht sie (kein zweiter Abruf)', async () => {
    expect(await getPageCount(api, 'f1')).toBe(7);
    expect(await getPageCount(api, 'f1')).toBe(7);
    expect(pdfjs.getDocument).toHaveBeenCalledTimes(1);
  });

  it('dedupliziert parallele Anfragen (In-Flight)', async () => {
    const [a, b] = await Promise.all([getPageCount(api, 'f2'), getPageCount(api, 'f2')]);
    expect(a).toBe(7);
    expect(b).toBe(7);
    expect(pdfjs.getDocument).toHaveBeenCalledTimes(1);
  });

  it('setzt inFlight nach Fehlschlag zurück, damit ein Retry möglich ist (Regression)', async () => {
    // Erster Aufruf: bytesFor (source 'preview' -> fetchPreviewBytes) schlägt fehl, z. B.
    // Timeout/409 bei der Vorschau-Konvertierung. Ohne den Fix bliebe die abgelehnte
    // Promise für immer in der inFlight-Map, und jeder weitere Aufruf würde sofort
    // dieselbe stale Rejection liefern statt es erneut zu versuchen.
    vi.mocked(fetchPreviewBytes)
      .mockRejectedValueOnce(new Error('Zeitüberschreitung'))
      .mockResolvedValueOnce(new Uint8Array([1, 2, 3]));

    await expect(getPageCount(api, 'f3', 'preview')).rejects.toThrow('Zeitüberschreitung');
    await expect(getPageCount(api, 'f3', 'preview')).resolves.toBe(7);
    expect(fetchPreviewBytes).toHaveBeenCalledTimes(2);
  });
});
