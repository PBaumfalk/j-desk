import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const idbStore = new Map<string, unknown>();

vi.mock('./idb', () => ({
  FILE_STORE: 'files',
  idbGet: vi.fn(async (_store: string, key: string) => idbStore.get(key) ?? null),
  idbPut: vi.fn(async (_store: string, key: string, value: unknown) => {
    idbStore.set(key, value);
  }),
}));

import { idbGet, idbPut } from './idb';
import { fetchPreviewBytes, PreviewError, previewCacheKey } from './previewPoll';

const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 90_000;

function makeApi(fetchPreview: ReturnType<typeof vi.fn>) {
  return { fetchPreview } as never;
}

describe('fetchPreviewBytes', () => {
  beforeEach(() => {
    idbStore.clear();
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pollt converting -> converting -> ready, liefert Bytes und cacht in IDB', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const fetchPreview = vi
      .fn()
      .mockResolvedValueOnce({ status: 'converting' })
      .mockResolvedValueOnce({ status: 'converting' })
      .mockResolvedValueOnce({ status: 'ready', bytes });
    const api = makeApi(fetchPreview);

    const promise = fetchPreviewBytes(api, 'f1');
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    await expect(promise).resolves.toEqual(bytes);
    expect(fetchPreview).toHaveBeenCalledTimes(3);
    expect(idbPut).toHaveBeenCalledWith('files', previewCacheKey('f1'), bytes);
    expect(idbGet).toHaveBeenCalledWith('files', previewCacheKey('f1'));
  });

  it('wirft PreviewError mit der Server-Meldung bei Status error', async () => {
    const fetchPreview = vi.fn().mockResolvedValue({ status: 'error', message: 'Konvertierung fehlgeschlagen' });
    const api = makeApi(fetchPreview);

    await expect(fetchPreviewBytes(api, 'f2')).rejects.toThrow('Konvertierung fehlgeschlagen');
    await expect(fetchPreviewBytes(api, 'f2')).rejects.toBeInstanceOf(PreviewError);
  });

  it('wirft nach 90 s Zeitüberschreitung', async () => {
    const fetchPreview = vi.fn().mockResolvedValue({ status: 'converting' });
    const api = makeApi(fetchPreview);

    const promise = fetchPreviewBytes(api, 'f3');
    // Rejection sofort abfangen, damit Vitest sie nicht als "unhandled" meldet, während
    // wir die Zeit weiter vorspulen.
    const assertion = expect(promise).rejects.toThrow('Zeitüberschreitung');

    await vi.advanceTimersByTimeAsync(POLL_TIMEOUT_MS + POLL_INTERVAL_MS);

    await assertion;
  });

  it('bricht bei isCancelled sofort mit PreviewError ab', async () => {
    const fetchPreview = vi.fn().mockResolvedValue({ status: 'converting' });
    const api = makeApi(fetchPreview);
    let cancelled = false;

    const promise = fetchPreviewBytes(api, 'f4', () => cancelled);
    const assertion = expect(promise).rejects.toThrow('abgebrochen');

    // Erster Poll läuft (nicht abgebrochen), danach kippen wir das Flag vor dem
    // nächsten Durchlauf.
    await vi.advanceTimersByTimeAsync(0);
    cancelled = true;
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    await assertion;
    // Kein weiterer Server-Poll nach dem Abbruch.
    expect(fetchPreview).toHaveBeenCalledTimes(1);
  });
});
