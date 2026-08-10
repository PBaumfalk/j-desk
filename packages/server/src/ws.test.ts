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

  // 04-06 Task 1 (D-08, P-12): Wiederherstellung darf für andere verbundene Nutzer nicht
  // stumm geschehen — beide Sockets müssen das additive event:'restored'-Feld erhalten.
  it('beide verbundenen Clients erhalten nach einer Wiederherstellung event:"restored" samt historischem Stand', async () => {
    const { app, db, dataDir, authHeaders } = await createTestApp();
    await app.listen({ port: 0 });
    const { port } = app.server.address() as { port: number };

    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'D' } })
    ).json();
    const meta = storeFile(db, dataDir, pdf, 'a.pdf');

    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'addDoc', payload: { fileId: meta.id, name: 'a.pdf', position: { x: 1, y: 2 }, id: 'doc-a' } },
    });
    const journal = (
      await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/journal`, headers: authHeaders })
    ).json().entries as { id: number; rev: number; type: string }[];
    const ersteAddDoc = journal.find((e) => e.rev === 1)!;

    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'addDoc', payload: { fileId: meta.id, name: 'a.pdf', position: { x: 3, y: 4 }, id: 'doc-b' } },
    });

    const { ticket: ticket1 } = (
      await app.inject({ method: 'POST', url: '/api/v1/ws-ticket', headers: authHeaders })
    ).json();
    const { ticket: ticket2 } = (
      await app.inject({ method: 'POST', url: '/api/v1/ws-ticket', headers: authHeaders })
    ).json();
    const ws1 = new WsClient(`ws://127.0.0.1:${port}/api/v1/desks/${desk.id}/ws?ticket=${ticket1}`);
    const ws2 = new WsClient(`ws://127.0.0.1:${port}/api/v1/desks/${desk.id}/ws?ticket=${ticket2}`);
    await Promise.all([
      new Promise((resolve, reject) => { ws1.on('open', resolve); ws1.on('error', reject); }),
      new Promise((resolve, reject) => { ws2.on('open', resolve); ws2.on('error', reject); }),
    ]);

    const msg1 = new Promise<{ rev: number; state: { docs: unknown[] }; event?: string }>((resolve) => {
      ws1.on('message', (data) => resolve(JSON.parse(data.toString())));
    });
    const msg2 = new Promise<{ rev: number; state: { docs: unknown[] }; event?: string }>((resolve) => {
      ws2.on('message', (data) => resolve(JSON.parse(data.toString())));
    });

    const restoreRes = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/restore`, headers: authHeaders,
      payload: { toEntryId: ersteAddDoc.id },
    });
    expect(restoreRes.statusCode).toBe(200);

    const [received1, received2] = await Promise.all([msg1, msg2]);
    expect(received1.event).toBe('restored');
    expect(received1.state.docs).toHaveLength(1);
    expect(received2.event).toBe('restored');
    expect(received2.state.docs).toHaveLength(1);

    ws1.close();
    ws2.close();
    await app.close();
  });

  it('ein gewöhnlicher Command-Broadcast trägt kein event-Feld (sonst würde jeder Command einen Wiederherstellungs-Toast auslösen)', async () => {
    const { app, db, dataDir, authHeaders } = await createTestApp();
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
    await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });

    const message = new Promise<{ rev: number; state: { docs: unknown[] }; event?: string }>((resolve) => {
      ws.on('message', (data) => resolve(JSON.parse(data.toString())));
    });

    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'addDoc', payload: { fileId: meta.id, name: 'a.pdf', position: { x: 1, y: 2 }, id: 'doc-a' } },
    });

    const msg = await message;
    expect(msg.event).toBeUndefined();

    ws.close();
    await app.close();
  });
});
