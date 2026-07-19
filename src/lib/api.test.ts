import { describe, it, expect, vi, afterEach } from 'vitest';
import { ApiClient } from './api';

afterEach(() => vi.unstubAllGlobals());

describe('ApiClient.wsUrl', () => {
  it('baut aus expliziter http-Basis eine ws-URL mit Ticket', () => {
    expect(new ApiClient('http://x:4810', 'tok').wsUrl('d1', 'tic-1')).toBe(
      'ws://x:4810/api/v1/desks/d1/ws?ticket=tic-1',
    );
  });

  it('baut aus https-Basis eine wss-URL', () => {
    expect(new ApiClient('https://kanzlei.example', 'tok').wsUrl('d1', 'tic-1')).toBe(
      'wss://kanzlei.example/api/v1/desks/d1/ws?ticket=tic-1',
    );
  });

  it('nutzt bei leerer Basis den Origin der Seite', () => {
    vi.stubGlobal('location', { origin: 'https://kanzlei.example' });
    expect(new ApiClient('', 'tok').wsUrl('d1', 'tic-1')).toBe(
      'wss://kanzlei.example/api/v1/desks/d1/ws?ticket=tic-1',
    );
  });
});

describe('ApiClient.fetchPreview', () => {
  it('liefert bei 200 die PDF-Bytes als ready', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: async () => bytes.buffer,
      }),
    );
    await expect(new ApiClient('http://x', 'tok').fetchPreview('f1')).resolves.toEqual({
      status: 'ready',
      bytes,
    });
  });

  it('meldet bei 202 converting', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 202 }));
    await expect(new ApiClient('http://x', 'tok').fetchPreview('f1')).resolves.toEqual({
      status: 'converting',
    });
  });

  it('meldet bei 409 error mit der Server-Meldung', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: async () => ({ error: 'Konvertierung fehlgeschlagen', reason: 'failed' }),
      }),
    );
    await expect(new ApiClient('http://x', 'tok').fetchPreview('f1')).resolves.toEqual({
      status: 'error',
      message: 'Konvertierung fehlgeschlagen',
    });
  });

  it('wirft bei 404 wie gehabt einen ApiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({ error: 'Datei nicht gefunden' }),
      }),
    );
    await expect(new ApiClient('http://x', 'tok').fetchPreview('f1')).rejects.toThrow('Datei nicht gefunden');
  });
});
