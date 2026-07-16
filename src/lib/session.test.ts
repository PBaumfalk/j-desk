import { describe, it, expect } from 'vitest';
import { parseSession } from './session';

describe('parseSession', () => {
  it('liest eine gültige Sitzung', () => {
    expect(parseSession('{"serverUrl":"http://x:4810","token":"abc"}')).toEqual({
      serverUrl: 'http://x:4810',
      token: 'abc',
    });
  });

  it('liefert null bei kaputtem JSON oder falscher Struktur', () => {
    expect(parseSession('{ kaputt')).toBeNull();
    expect(parseSession('null')).toBeNull();
    expect(parseSession('{"serverUrl":"http://x"}')).toBeNull();
    expect(parseSession('{"serverUrl":5,"token":"abc"}')).toBeNull();
  });

  it('liest lastDeskId, wenn vorhanden und korrekt typisiert', () => {
    expect(parseSession('{"serverUrl":"http://x:4810","token":"abc","lastDeskId":"d1"}')).toEqual({
      serverUrl: 'http://x:4810',
      token: 'abc',
      lastDeskId: 'd1',
    });
  });

  it('verwirft ein falsch typisiertes lastDeskId, nicht die ganze Session', () => {
    expect(parseSession('{"serverUrl":"http://x:4810","token":"abc","lastDeskId":5}')).toEqual({
      serverUrl: 'http://x:4810',
      token: 'abc',
    });
  });
});
