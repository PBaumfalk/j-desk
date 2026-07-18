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
