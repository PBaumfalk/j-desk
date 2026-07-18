import { describe, it, expect, vi, afterEach } from 'vitest';
import { uid } from './uid';

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

afterEach(() => vi.unstubAllGlobals());

describe('uid', () => {
  it('liefert ein gültiges v4-UUID-Format', () => {
    expect(uid()).toMatch(V4);
  });

  it('nutzt den Fallback, wenn crypto.randomUUID fehlt (unsicherer Kontext)', () => {
    const realCrypto = globalThis.crypto;
    vi.stubGlobal('crypto', { getRandomValues: realCrypto.getRandomValues.bind(realCrypto) }); // ohne randomUUID
    expect(uid()).toMatch(V4);
  });

  it('erzeugt unterschiedliche Werte', () => {
    expect(uid()).not.toBe(uid());
  });
});
