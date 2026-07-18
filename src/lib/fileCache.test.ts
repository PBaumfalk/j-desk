import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getFileUrl, revokeFileUrls } from './fileCache';
import type { ApiClient } from './api';

let objectUrlCounter = 0;
let revoked: string[] = [];
beforeEach(() => {
  objectUrlCounter = 0;
  revoked = [];
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: () => `blob:test-${objectUrlCounter++}`,
    revokeObjectURL: (url: string) => revoked.push(url),
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

  it('dedupliziert parallele Aufrufe für dieselbe Datei (ein Fetch, eine URL)', async () => {
    const fetchFile = vi.fn().mockResolvedValue(new Uint8Array([4, 5, 6]));
    const api = { fetchFile } as unknown as ApiClient;
    const [url1, url2] = await Promise.all([
      getFileUrl(api, 'file-cache-test-parallel'),
      getFileUrl(api, 'file-cache-test-parallel'),
    ]);
    expect(url1).toBe(url2);
    expect(fetchFile).toHaveBeenCalledTimes(1);
  });

  it('bedient sich aus IndexedDB, ohne den Server zu fragen', async () => {
    const { idbPut, FILE_STORE } = await import('./idb');
    await idbPut(FILE_STORE, 'file-cache-test-idb', new Uint8Array([9, 9]));
    const fetchFile = vi.fn();
    const api = { fetchFile } as unknown as ApiClient;
    await expect(getFileUrl(api, 'file-cache-test-idb')).resolves.toMatch(/^blob:/);
    expect(fetchFile).not.toHaveBeenCalled();
  });

  it('wiederholt nach einem Fehlschlag statt den Fehler zu cachen', async () => {
    const fetchFile = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(new Uint8Array([7]));
    const api = { fetchFile } as unknown as ApiClient;
    await expect(getFileUrl(api, 'file-cache-test-retry')).rejects.toThrow('offline');
    await expect(getFileUrl(api, 'file-cache-test-retry')).resolves.toMatch(/^blob:/);
  });
});

describe('revokeFileUrls', () => {
  it('gibt alle Objekt-URLs frei; danach wird neu erzeugt', async () => {
    const fetchFile = vi.fn().mockResolvedValue(new Uint8Array([8]));
    const api = { fetchFile } as unknown as ApiClient;
    const url1 = await getFileUrl(api, 'file-cache-test-revoke');
    revokeFileUrls();
    expect(revoked).toContain(url1);
    const url2 = await getFileUrl(api, 'file-cache-test-revoke');
    expect(url2).not.toBe(url1);
  });
});
