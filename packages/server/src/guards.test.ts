import { describe, it, expect, beforeEach } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { openDb, type Db } from './db';
import { createDesk } from './deskStore';
import { requireDeskRolle, requireDeskAktion } from './guards';

/**
 * Fake-req/reply statt vollem Fastify-Server (RESEARCH Pattern 2: preHandler statt
 * Handler-Körper) — guards.ts wird erst in 02-04 an echten Routen registriert; hier genügt
 * der isolierte Aufruf der preHandler-Fabrik mit einem minimalen Double.
 */
function fakeReq(deskId: string, userId: string | undefined): FastifyRequest & { userId?: string; rolle?: string } {
  return { params: { id: deskId }, userId } as unknown as FastifyRequest & { userId?: string; rolle?: string };
}

function fakeReply(): { reply: FastifyReply; codes: number[]; bodies: unknown[] } {
  const codes: number[] = [];
  const bodies: unknown[] = [];
  const reply = {
    code(status: number) {
      codes.push(status);
      return reply;
    },
    send(body: unknown) {
      bodies.push(body);
      return reply;
    },
  } as unknown as FastifyReply;
  return { reply, codes, bodies };
}

let db: Db;
beforeEach(() => {
  db = openDb(':memory:');
  db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)').run('u1', 'p', 'h', 0);
  db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)').run('u2', 'q', 'h', 0);
});

describe('requireDeskRolle', () => {
  it('antwortet mit 403, wenn der Nutzer keine Rolle für den Desk hat', async () => {
    const desk = createDesk(db, 'u1', 'Neu');
    const req = fakeReq(desk.id, 'u2');
    const { reply, codes, bodies } = fakeReply();

    await requireDeskRolle(db)(req, reply);

    expect(codes).toEqual([403]);
    expect(bodies).toHaveLength(1);
    expect(req.rolle).toBeUndefined();
  });

  it('antwortet mit 403 bei unzureichender Rolle (Kommentator, wo Eigentümer/Bearbeiter verlangt sind)', async () => {
    const desk = createDesk(db, 'u1', 'Neu');
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(desk.id, 'u2', 'Kommentator');
    const req = fakeReq(desk.id, 'u2');
    const { reply, codes } = fakeReply();

    await requireDeskRolle(db, ['Eigentümer', 'Bearbeiter'])(req, reply);

    expect(codes).toEqual([403]);
  });

  it('lässt bei ausreichender Rolle durch und setzt req.rolle', async () => {
    const desk = createDesk(db, 'u1', 'Neu');
    const req = fakeReq(desk.id, 'u1');
    const { reply, codes } = fakeReply();

    await requireDeskRolle(db)(req, reply);

    expect(codes).toEqual([]);
    expect(req.rolle).toBe('Eigentümer');
  });
});

describe('requireDeskAktion', () => {
  it('403 bei Kommentator für eine gefährliche Aktion (delete)', async () => {
    const desk = createDesk(db, 'u1', 'Neu');
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(desk.id, 'u2', 'Kommentator');
    const req = fakeReq(desk.id, 'u2');
    const { reply, codes } = fakeReply();

    await requireDeskAktion(db, 'delete')(req, reply);

    expect(codes).toEqual([403]);
    expect(req.rolle).toBeUndefined();
  });

  it('lässt Eigentümer für dieselbe Aktion durch und setzt req.rolle', async () => {
    const desk = createDesk(db, 'u1', 'Neu');
    const req = fakeReq(desk.id, 'u1');
    const { reply, codes } = fakeReply();

    await requireDeskAktion(db, 'delete')(req, reply);

    expect(codes).toEqual([]);
    expect(req.rolle).toBe('Eigentümer');
  });
});
