import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createTestApp } from '../../server/src/testUtils';
import { listDesks, getState, sendCommand, createDesk, renameDesk, getFile, DeskApiError } from './deskApi';

let app: FastifyInstance;
let baseUrl: string;
let token: string;

beforeAll(async () => {
  const ctx = await createTestApp();
  app = ctx.app;
  token = ctx.token;
  await app.listen({ port: 0 });
  const addr = app.server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
});
afterAll(async () => {
  await app.close();
});

describe('deskApi', () => {
  it('createDesk, listDesks, getState, sendCommand, renameDesk', async () => {
    const desk = await createDesk(baseUrl, token, 'MCP-Test');
    const desks = await listDesks(baseUrl, token);
    expect(desks.some((d) => d.id === desk.id && d.isOwner)).toBe(true);
    const s0 = await getState(baseUrl, token, desk.id);
    expect(s0.state.docs).toEqual([]);
    const s1 = await sendCommand(baseUrl, token, desk.id, { type: 'bringToFront', payload: { id: 'x' } });
    expect(s1.rev).toBe(1);
    await renameDesk(baseUrl, token, desk.id, 'Umbenannt');
    expect((await listDesks(baseUrl, token)).find((d) => d.id === desk.id)?.name).toBe('Umbenannt');
  });

  it('wirft DeskApiError mit Status und deutscher Meldung', async () => {
    await expect(listDesks(baseUrl, 'falsches-token')).rejects.toMatchObject({ status: 401 });
    await expect(getFile(baseUrl, token, 'gibtsnicht')).rejects.toMatchObject({
      message: 'Datei nicht gefunden',
    });
  });
});
