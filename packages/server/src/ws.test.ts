import { describe, it, expect } from 'vitest';
import WsClient from 'ws';
import { createTestApp } from './testUtils';
import { storeFile } from './files';

const pdf = Buffer.from('%PDF-1.4\ninhalt');

describe('WebSocket-Broadcast', () => {
  it('verbundene Clients erhalten {rev, state} nach jedem Kommando', async () => {
    const { app, db, dataDir, token, authHeaders } = await createTestApp();
    await app.listen({ port: 0 });
    const { port } = app.server.address() as { port: number };

    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'D' } })
    ).json();
    const meta = storeFile(db, dataDir, pdf, 'a.pdf');

    const { ticket } = (
      await app.inject({ method: 'POST', url: '/api/v1/ws-ticket', headers: authHeaders })
    ).json();
    const ws = new WsClient(`ws://127.0.0.1:${port}/api/v1/desks/${desk.id}/ws?ticket=${ticket}`);
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });
    const message = new Promise<{ rev: number; state: { docs: unknown[] } }>((resolve) => {
      ws.on('message', (data) => resolve(JSON.parse(data.toString())));
    });

    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'addDoc', payload: { fileId: meta.id, name: 'a.pdf', position: { x: 1, y: 2 }, id: 'id-a' } },
    });

    const msg = await message;
    expect(msg.rev).toBe(1);
    expect(msg.state.docs).toHaveLength(1);

    ws.close();
    await app.close();
  });

  it('WS ohne gültiges Ticket wird abgewiesen', async () => {
    const { app, authHeaders } = await createTestApp();
    await app.listen({ port: 0 });
    const { port } = app.server.address() as { port: number };
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'D' } })
    ).json();

    const ws = new WsClient(`ws://127.0.0.1:${port}/api/v1/desks/${desk.id}/ws?ticket=falsch`);
    const failed = await new Promise<boolean>((resolve) => {
      ws.on('open', () => resolve(false));
      ws.on('error', () => resolve(true));
      ws.on('unexpected-response', () => resolve(true));
    });
    expect(failed).toBe(true);
    await app.close();
  });

  it('das Session-Token in der Query wird für den WS NICHT mehr akzeptiert', async () => {
    const { app, token, authHeaders } = await createTestApp();
    await app.listen({ port: 0 });
    const { port } = app.server.address() as { port: number };
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'D' } })
    ).json();

    const ws = new WsClient(`ws://127.0.0.1:${port}/api/v1/desks/${desk.id}/ws?token=${token}`);
    const failed = await new Promise<boolean>((resolve) => {
      ws.on('open', () => resolve(false));
      ws.on('error', () => resolve(true));
      ws.on('unexpected-response', () => resolve(true));
    });
    expect(failed).toBe(true);
    await app.close();
  });

  it('ein Ticket ist nur einmal verwendbar', async () => {
    const { app, authHeaders } = await createTestApp();
    await app.listen({ port: 0 });
    const { port } = app.server.address() as { port: number };
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'D' } })
    ).json();
    const { ticket } = (
      await app.inject({ method: 'POST', url: '/api/v1/ws-ticket', headers: authHeaders })
    ).json();

    const first = new WsClient(`ws://127.0.0.1:${port}/api/v1/desks/${desk.id}/ws?ticket=${ticket}`);
    await new Promise((resolve, reject) => { first.on('open', resolve); first.on('error', reject); });

    const second = new WsClient(`ws://127.0.0.1:${port}/api/v1/desks/${desk.id}/ws?ticket=${ticket}`);
    const failed = await new Promise<boolean>((resolve) => {
      second.on('open', () => resolve(false));
      second.on('error', () => resolve(true));
      second.on('unexpected-response', () => resolve(true));
    });
    expect(failed).toBe(true);
    first.close();
    await app.close();
  });

  it('ws-ticket-Endpoint verlangt Anmeldung', async () => {
    const { app } = await createTestApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/ws-ticket' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
