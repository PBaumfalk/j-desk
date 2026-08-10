import { describe, it, expect } from 'vitest';
import { loadConfig } from './config';

const basis = { ANYMIZE_API_KEY: 'key-123' };

describe('loadConfig', () => {
  it('liefert Defaults und liest ENV', () => {
    expect(loadConfig(basis)).toEqual({
      port: 4820,
      deskServerUrl: 'http://localhost:4810',
      anymizeApiKey: 'key-123',
      anymizeApiUrl: 'https://app.anymize.ai',
      allowDeanonymize: true,
    });
    expect(loadConfig({ ...basis, MCP_PORT: '5000', MCP_ALLOW_DEANONYMIZE: 'false' })).toMatchObject({
      port: 5000,
      allowDeanonymize: false,
    });
  });

  it('entfernt Trailing-Slashes und verlangt den anymize-Key', () => {
    expect(loadConfig({ ...basis, DESK_SERVER_URL: 'http://x:1/', ANYMIZE_API_URL: 'https://y/' }))
      .toMatchObject({ deskServerUrl: 'http://x:1', anymizeApiUrl: 'https://y' });
    expect(() => loadConfig({})).toThrow('ANYMIZE_API_KEY fehlt');
  });
});
