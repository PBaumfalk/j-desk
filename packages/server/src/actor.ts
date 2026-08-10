import type { FastifyRequest } from 'fastify';
import type { Db } from './db';
import type { Actor } from './deskStore';

/** Auslösender Nutzer für Provenienz (Command-Stempel + Journal). Fallback defensiv —
    der Auth-Hook garantiert req.userId normalerweise. */
export function actorFromRequest(db: Db, req: FastifyRequest): Actor {
  const userId = (req as FastifyRequest & { userId?: string }).userId;
  const row = userId ? (db.prepare('SELECT username FROM users WHERE id = ?').get(userId) as { username: string } | undefined) : undefined;
  return row ? { id: userId!, name: row.username } : { id: null, name: 'unbekannt' };
}
