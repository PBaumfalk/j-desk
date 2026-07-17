import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getFileUrl } from './fileCache';
import type { ApiClient } from './api';

let objectUrlCounter = 0;
beforeEach(() => {
  objectUrlCounter = 0;
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: () => `blob:test-${objectUrlCounter++}`,
  });
});

describe('getFileUrl', () => {
  it('lädt einmal vom Server und beantwortet Folgeaufrufe aus dem Cache', async () => {
    const fetchFile = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));
    const api = { fetchFile } as unknown as ApiClient;
    const url1 = await getFileUrl(api, 'file-cache-test-1');
    const url2 = await getFileUrl(api, 'file-cache-test-1');
    expect(url1).toBe(url2);
    expect(fetchFile).toHaveBeenCalledTimes(1);
  });
});
