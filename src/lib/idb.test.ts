import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { idbGet, idbPut, trimStore, FILE_STORE } from './idb';

describe('idb', () => {
  it('liefert null für unbekannte Schlüssel', async () => {
    expect(await idbGet(FILE_STORE, 'gibtsnicht')).toBeNull();
  });

  it('speichert und liest Bytes', async () => {
    await idbPut(FILE_STORE, 'a', new Uint8Array([1, 2, 3]));
    expect(await idbGet(FILE_STORE, 'a')).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('verdrängt beim Trimmen die ältesten Einträge', async () => {
    await idbPut(FILE_STORE, 'alt', new Uint8Array([1]));
    await new Promise((r) => setTimeout(r, 5)); // ts-Auflösung
    await idbPut(FILE_STORE, 'neu', new Uint8Array([2]));
    await trimStore(FILE_STORE, 1);
    expect(await idbGet(FILE_STORE, 'alt')).toBeNull();
    expect(await idbGet(FILE_STORE, 'neu')).toEqual(new Uint8Array([2]));
  });

  it('lässt Stores unterhalb der Obergrenze unangetastet', async () => {
    await idbPut(FILE_STORE, 'x1', new Uint8Array([1]));
    await idbPut(FILE_STORE, 'x2', new Uint8Array([2]));
    await trimStore(FILE_STORE, 10);
    expect(await idbGet(FILE_STORE, 'x1')).toEqual(new Uint8Array([1]));
    expect(await idbGet(FILE_STORE, 'x2')).toEqual(new Uint8Array([2]));
  });
});
