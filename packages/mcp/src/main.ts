import express from 'express';
import type http from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadConfig, type McpConfig } from './config';
import { AnymizeClient } from './anymize';
import { AnonCache, MappingStore } from './mapping';
import { Anonymizer } from './anonymizer';
import { buildMcpServer } from './server';

export interface Shared {
  anonymizer: Anonymizer;
  mappings: MappingStore;
}

export function startHttpServer(config: McpConfig, shared: Shared): Promise<http.Server> {
  const app = express();
  app.use(express.json({ limit: '4mb' }));

  app.post('/mcp', async (req, res) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Authorization-Header mit Desk-Server-Token erforderlich' });
      return;
    }
    const token = header.slice(7);
    const server = buildMcpServer({ config, anonymizer: shared.anonymizer, mappings: shared.mappings, token });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.all('/mcp', (_req, res) => {
    res.status(405).json({ error: 'Nur POST wird unterstützt (stateless Streamable HTTP)' });
  });

  return new Promise((resolve) => {
    const s = app.listen(config.port, () => resolve(s));
  });
}

// Direktstart (nicht in Tests)
if (process.argv[1]?.endsWith('main.ts')) {
  const config = loadConfig(process.env);
  const mappings = new MappingStore();
  const anonymizer = new Anonymizer(new AnymizeClient({ apiUrl: config.anymizeApiUrl, apiKey: config.anymizeApiKey }), mappings, new AnonCache());
  void startHttpServer(config, { anonymizer, mappings }).then(() =>
    console.log(`Digital-Desktop-MCP-Server läuft auf Port ${config.port} (Desk-Server: ${config.deskServerUrl})`),
  );
}
