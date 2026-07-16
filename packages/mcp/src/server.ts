import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { McpConfig } from './config';
import { Anonymizer } from './anonymizer';
import { MappingStore } from './mapping';
import { AnymizeError } from './anymize';
import * as desk from './deskApi';
import { DeskApiError } from './deskApi';

export interface McpDeps {
  config: McpConfig;
  anonymizer: Anonymizer;
  mappings: MappingStore;
  token: string;
}

const ok = (data: unknown) => ({ content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] });
const fehler = (text: string) => ({ isError: true, content: [{ type: 'text' as const, text }] });

function meldung(e: unknown): string {
  if (e instanceof DeskApiError && e.status === 401) return 'Token ungültig — neues Token mit npm run mcp:token erzeugen';
  if (e instanceof DeskApiError || e instanceof AnymizeError) return e.message;
  return e instanceof Error ? e.message : 'Unbekannter Fehler';
}

/** Registriert einen Tool-Handler mit einheitlicher Fehlerbehandlung. */
function tool(server: McpServer, name: string, description: string, schema: z.ZodRawShape, handler: (args: Record<string, unknown>) => Promise<unknown>) {
  server.registerTool(name, { description, inputSchema: schema }, async (args: Record<string, unknown>) => {
    try {
      return ok(await handler(args));
    } catch (e) {
      return fehler(meldung(e));
    }
  });
}

export function buildMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer({ name: 'digital-desktop', version: '0.1.0' });
  const { config, anonymizer, token } = deps;
  const base = config.deskServerUrl;

  tool(server, 'list_desks', 'Listet alle Schreibtische des Benutzers (Namen anonymisiert).', {}, async () => {
    const desks = await desk.listDesks(base, token);
    const namen = await anonymizer.anonNames(desks.map((d) => d.name));
    return desks.map((d, i) => ({ id: d.id, name: namen[i], isOwner: d.isOwner }));
  });

  tool(server, 'get_desk', 'Liefert Name, Karten, Stapel und Verknüpfungen eines Schreibtischs (Texte anonymisiert).', { deskId: z.string() }, async (a) => {
    const deskId = String(a.deskId);
    const [desks, s] = await Promise.all([desk.listDesks(base, token), desk.getState(base, token, deskId)]);
    const info = desks.find((d) => d.id === deskId);
    if (!info) throw new Error('Schreibtisch nicht gefunden');
    const texte = [
      info.name,
      ...s.state.docs.map((d) => d.name),
      ...s.state.stacks.map((st) => st.name),
      ...s.state.links.map((l) => l.note),
    ];
    const anon = await anonymizer.anonNames(texte);
    let i = 0;
    const name = anon[i++];
    const docs = s.state.docs.map((d) => ({ id: d.id, name: anon[i++], position: d.position }));
    const stacks = s.state.stacks.map((st) => ({ id: st.id, name: anon[i++], docIds: st.docIds, position: st.position }));
    const links = s.state.links.map((l) => ({ id: l.id, fromId: l.fromId, toId: l.toId, note: anon[i++] }));
    return { name, docs, stacks, links };
  });

  tool(server, 'get_document_text', 'Liefert den anonymisierten Volltext eines Dokuments (PDF via OCR).', { deskId: z.string(), docId: z.string() }, async (a) => {
    const s = await desk.getState(base, token, String(a.deskId));
    const doc = s.state.docs.find((d) => d.id === a.docId);
    if (!doc) throw new Error('Dokument nicht gefunden');
    return anonymizer.anonFileText(doc.fileId, () => desk.getFile(base, token, doc.fileId), doc.name);
  });

  return server;
}
