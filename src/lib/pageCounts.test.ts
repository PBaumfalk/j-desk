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

import * as pdfjs from 'pdfjs-dist';
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
});
