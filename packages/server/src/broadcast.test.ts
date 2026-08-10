import { describe, it, expect } from 'vitest';
import WsClient from 'ws';
import { register, unregister, broadcast, aktualisiereRolle, trenneNutzer } from './broadcast';
import { createTestAppMitZweiNutzern } from './testUtils';
import { getRolleForNutzer } from './deskStore';

/**
 * Actor-fähige broadcast-Registry + Projektion pro Empfänger-Socket (PERM-05, T-02-01, 02-05
 * Task 1) — schließt strukturell die Broadcast-Leck-Bugklasse, die im Projekt bereits zweimal
 * real auftrat (aec4f58, fcda808): broadcast() kannte bislang gar nicht, WELCHER Nutzer an
 * welchem Socket hängt, konnte also nicht empfängerspezifisch projizieren.
 */

interface AufgezeichneterSocket {
  empfangen: string[];
  send(data: string): void;
}

function fakeSocket(): AufgezeichneterSocket {
  const empfangen: string[] = [];
  return { empfangen, send: (data: string) => { empfangen.push(data); } };
}

const STATE_MIT_PRIVATEM_OBJEKT_VON_A = {
  rev: 1,
  state: {
    docs: [], links: [], stacks: [],
    layers: [{ id: 'privat-a', typ: 'privat', name: 'Privat', ownerUserId: 'user-a' }],
    notes: [
      { id: 'n-a-privat', kind: 'notiz', text: 'geheim', position: { x: 0, y: 0 }, zIndex: 1, layerId: 'privat-a' },
      { id: 'n-oeffentlich', kind: 'notiz', text: 'für alle', position: { x: 1, y: 1 }, zIndex: 2 },
    ],
  },
};

describe('broadcast(): empfängerspezifische Projektion pro Socket', () => {
  it('projiziert pro Socket: das private Objekt von A fehlt im JSON an B, ist aber im JSON an A enthalten', () => {
    const deskId = 'desk-1';
    const socketA = fakeSocket();
    const socketB = fakeSocket();
    register(deskId, socketA, 'user-a', 'Eigentümer');
    register(deskId, socketB, 'user-b', 'Bearbeiter');

    broadcast(deskId, STATE_MIT_PRIVATEM_OBJEKT_VON_A);

    const anA = JSON.parse(socketA.empfangen[0]);
    const anB = JSON.parse(socketB.empfangen[0]);
    const idsA = (anA.state.notes as { id: string }[]).map((n) => n.id);
    const idsB = (anB.state.notes as { id: string }[]).map((n) => n.id);

    expect(idsA).toContain('n-a-privat');
    expect(idsA).toContain('n-oeffentlich');
    expect(idsB).not.toContain('n-a-privat');
    expect(idsB).toContain('n-oeffentlich');

    unregister(deskId, socketA);
    unregister(deskId, socketB);
  });

  it('register verlangt userId + rolle; unregister räumt korrekt auf (kein Broadcast an entfernte Sockets)', () => {
    const deskId = 'desk-2';
    const socketA = fakeSocket();
    register(deskId, socketA, 'user-a', 'Eigentümer');
    unregister(deskId, socketA);

    // Nach unregister erreicht ein Broadcast den Socket nicht mehr.
    broadcast(deskId, { rev: 1, state: { docs: [], links: [], stacks: [] } });
    expect(socketA.empfangen).toHaveLength(0);
  });

  it('broadcast an einen unbekannten/leeren Room wirft nicht und sendet nichts', () => {
    expect(() => broadcast('kein-room', { rev: 1, state: { docs: [], links: [], stacks: [] } })).not.toThrow();
  });
});

describe('WR-01: Rollenänderung/-entzug wirkt auf offene Verbindungen', () => {
  it('trenneNutzer schließt nur die Sockets des betroffenen Nutzers (4003) und entfernt sie aus dem Room', () => {
    const deskId = 'desk-trennen';
    const geschlossen: { code?: number }[] = [];
    const socketB1 = { ...fakeSocket(), close: (code?: number) => { geschlossen.push({ code }); } };
    const socketB2 = { ...fakeSocket(), close: (code?: number) => { geschlossen.push({ code }); } };
    const socketA = { ...fakeSocket(), close: (code?: number) => { geschlossen.push({ code }); } };
    register(deskId, socketB1, 'user-b', 'Bearbeiter');
    register(deskId, socketB2, 'user-b', 'Bearbeiter');
    register(deskId, socketA, 'user-a', 'Eigentümer');

    trenneNutzer(deskId, 'user-b', 'entfernt');

    expect(geschlossen).toEqual([{ code: 4003 }, { code: 4003 }]);
    // B ist aus dem Room: kein Broadcast mehr an B, A empfängt weiter.
    broadcast(deskId, { rev: 2, state: { docs: [], links: [], stacks: [] } });
    expect(socketB1.empfangen).toHaveLength(0);
    expect(socketB2.empfangen).toHaveLength(0);
    expect(socketA.empfangen).toHaveLength(1);

    unregister(deskId, socketA);
  });

  it('aktualisiereRolle lässt die Verbindung bestehen und wirft nicht (auch bei unbekanntem Room/Nutzer)', () => {
    const deskId = 'desk-rolle';
    const socketB = fakeSocket();
    register(deskId, socketB, 'user-b', 'Bearbeiter');
    expect(() => aktualisiereRolle(deskId, 'user-b', 'Nur-Lesen')).not.toThrow();
    expect(() => aktualisiereRolle('kein-room', 'user-b', 'Nur-Lesen')).not.toThrow();
    expect(() => aktualisiereRolle(deskId, 'user-c', 'Nur-Lesen')).not.toThrow();
    // Verbindung lebt weiter: Broadcasts erreichen B nach wie vor.
    broadcast(deskId, { rev: 3, state: { docs: [], links: [], stacks: [] } });
    expect(socketB.empfangen).toHaveLength(1);
    unregister(deskId, socketB);
  });

  it('DELETE /members/:userId trennt die offene WS-Verbindung des entfernten Nutzers sofort (4003)', async () => {
    const { app, db, a, b } = await createTestAppMitZweiNutzern();
    await app.listen({ port: 0 });
    try {
      const { port } = app.server.address() as { port: number };
      const desk = (
        await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte A' } })
      ).json();
      db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(desk.id, b.userId, 'Bearbeiter');

      const { ticket } = (
        await app.inject({ method: 'POST', url: '/api/v1/ws-ticket', headers: b.authHeaders })
      ).json();
      const ws = new WsClient(`ws://127.0.0.1:${port}/api/v1/desks/${desk.id}/ws?ticket=${ticket}`);
      await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });

      // A entzieht B die Rolle, während die Verbindung offen ist.
      const del = await app.inject({
        method: 'DELETE', url: `/api/v1/desks/${desk.id}/members/${b.userId}`, headers: a.authHeaders,
      });
      expect(del.statusCode).toBe(200);

      const closeCode = await new Promise<number>((resolve, reject) => {
        ws.on('close', (code) => resolve(code));
        ws.on('error', reject);
      });
      expect(closeCode).toBe(4003);
    } finally {
      await app.close();
    }
  });
});

describe('WS-Connect-Guard (PERM-05, T-02-02): Zugriffsprüfung beim Verbindungsaufbau', () => {
  it('ein Nutzer ohne Rolle für den Desk wird beim WS-Connect mit typisiertem Code getrennt (kein register)', async () => {
    const { app, db, a, b } = await createTestAppMitZweiNutzern();
    await app.listen({ port: 0 });
    try {
      const { port } = app.server.address() as { port: number };
      const desk = (
        await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte A' } })
      ).json();

      // B hat KEINE Rolle an diesem Desk.
      expect(getRolleForNutzer(db, desk.id, b.userId)).toBeNull();

      const { ticket } = (
        await app.inject({ method: 'POST', url: '/api/v1/ws-ticket', headers: b.authHeaders })
      ).json();
      const ws = new WsClient(`ws://127.0.0.1:${port}/api/v1/desks/${desk.id}/ws?ticket=${ticket}`);
      const closeCode = await new Promise<number>((resolve, reject) => {
        ws.on('close', (code) => resolve(code));
        ws.on('error', reject);
      });
      expect(closeCode).toBe(4003);
    } finally {
      await app.close();
    }
  });

  it('ein Nutzer MIT Rolle für den Desk wird verbunden und erhält Broadcasts', async () => {
    const { app, db, a } = await createTestAppMitZweiNutzern();
    await app.listen({ port: 0 });
    try {
      const { port } = app.server.address() as { port: number };
      const desk = (
        await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte A' } })
      ).json();
      expect(getRolleForNutzer(db, desk.id, a.userId)).toBe('Eigentümer');

      const { ticket } = (
        await app.inject({ method: 'POST', url: '/api/v1/ws-ticket', headers: a.authHeaders })
      ).json();
      const ws = new WsClient(`ws://127.0.0.1:${port}/api/v1/desks/${desk.id}/ws?ticket=${ticket}`);
      await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
      ws.close();
    } finally {
      await app.close();
    }
  });
});
