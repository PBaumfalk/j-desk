import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseSession, loadSession, saveSession, clearSession, saveLastDeskId } from './session';

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('parseSession', () => {
  it('liest eine gültige Sitzung', () => {
    expect(parseSession('{"token":"abc"}')).toEqual({ token: 'abc' });
  });

  it('liefert null bei kaputtem JSON oder falscher Struktur', () => {
    expect(parseSession('{ kaputt')).toBeNull();
    expect(parseSession('null')).toBeNull();
    expect(parseSession('{"token":5}')).toBeNull();
  });

  it('liest lastDeskId, verwirft falsch typisiertes lastDeskId', () => {
    expect(parseSession('{"token":"abc","lastDeskId":"d1"}')).toEqual({ token: 'abc', lastDeskId: 'd1' });
    expect(parseSession('{"token":"abc","lastDeskId":5}')).toEqual({ token: 'abc' });
  });
});

describe('load/save/clear', () => {
  it('speichert und lädt über localStorage', () => {
    saveSession({ token: 'abc' });
    expect(loadSession()).toEqual({ token: 'abc' });
    clearSession();
    expect(loadSession()).toBeNull();
  });

  it('saveLastDeskId ergänzt die bestehende Sitzung und tut ohne Sitzung nichts', () => {
    saveLastDeskId('d9'); // keine Sitzung — kein Fehler
    expect(loadSession()).toBeNull();
    saveSession({ token: 'abc' });
    saveLastDeskId('d9');
    expect(loadSession()).toEqual({ token: 'abc', lastDeskId: 'd9' });
  });
});
