export interface McpConfig {
  port: number;
  deskServerUrl: string;
  anymizeApiKey: string;
  anymizeApiUrl: string;
  allowDeanonymize: boolean;
}

const ohneSlash = (u: string) => u.replace(/\/+$/, '');

export function loadConfig(env: Record<string, string | undefined>): McpConfig {
  const key = env.ANYMIZE_API_KEY ?? '';
  if (key === '') throw new Error('ANYMIZE_API_KEY fehlt');
  return {
    port: Number(env.MCP_PORT ?? 4820),
    deskServerUrl: ohneSlash(env.DESK_SERVER_URL ?? 'http://localhost:4810'),
    anymizeApiKey: key,
    anymizeApiUrl: ohneSlash(env.ANYMIZE_API_URL ?? 'https://app.anymize.ai'),
    allowDeanonymize: (env.MCP_ALLOW_DEANONYMIZE ?? 'true') !== 'false',
  };
}
