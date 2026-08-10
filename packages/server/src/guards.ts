import type { FastifyReply, FastifyRequest } from 'fastify';
import type { GefahrlicheAktion, Rolle } from '@j-desk/core';
import type { Db } from './db';
import { DeskNotFoundError, pruefeDeskAktion, pruefeDeskZugriff, ZugriffVerweigertError } from './deskStore';

/**
 * Fastify-preHandler-Fabriken für Desk-Zugriffsprüfung (PERM-04, T-02-02): jede Desk-ID im
 * Pfad ist untrusted, der Zugriff muss VOR dem Route-Handler geprüft werden (RESEARCH Pattern
 * 2 — preHandler statt Handler-Körper, damit kein Handler die Prüfung vergessen kann).
 * Registrierung an den Routen folgt in 02-04; hier nur das Modul + isolierte Tests.
 */

declare module 'fastify' {
  interface FastifyRequest {
    rolle?: Rolle;
  }
}

function deskIdAusRequest(req: FastifyRequest): string {
  return (req.params as { id: string }).id;
}

function userIdAusRequest(req: FastifyRequest): string | undefined {
  return (req as FastifyRequest & { userId?: string }).userId;
}

/**
 * Verlangt irgendeine Rolle (oder — falls angegeben — eine der `erforderlicheRollen`) für den
 * Desk aus `req.params.id`. Fail-closed: fehlender/ungültiger userId gilt als kein Zugriff.
 * Bei Erfolg wird die ermittelte Rolle als `req.rolle` an den Handler weitergereicht.
 */
export function requireDeskRolle(db: Db, erforderlicheRollen?: Rolle[]) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const deskId = deskIdAusRequest(req);
    const userId = userIdAusRequest(req);
    try {
      if (!userId) throw new ZugriffVerweigertError('Kein Zugriff auf diesen Schreibtisch.');
      req.rolle = pruefeDeskZugriff(db, deskId, userId, erforderlicheRollen);
    } catch (e) {
      if (e instanceof ZugriffVerweigertError) {
        reply.code(403).send({ error: e.message });
        return;
      }
      // Ein tatsächlich nicht existierender Desk bleibt 404 (Bestandsverhalten mehrerer
      // Routen, z. B. GET /state nach DELETE /desks/:id) — nur die fehlende/unzureichende
      // Rolle an einem EXISTIERENDEN Desk ist 403 (s. pruefeDeskZugriff, 02-04).
      if (e instanceof DeskNotFoundError) {
        reply.code(404).send({ error: e.message });
        return;
      }
      throw e;
    }
  };
}

/**
 * Wie requireDeskRolle, prüft zusätzlich die gefährliche Aktion gegen die Rechte-Matrix
 * (darfAktion, PERM-04) — z. B. Löschen/Export/Upload/MCP/Rollen- und Ebenenverwaltung.
 */
export function requireDeskAktion(db: Db, aktion: GefahrlicheAktion) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const deskId = deskIdAusRequest(req);
    const userId = userIdAusRequest(req);
    try {
      if (!userId) throw new ZugriffVerweigertError('Kein Zugriff auf diesen Schreibtisch.');
      req.rolle = pruefeDeskAktion(db, deskId, userId, aktion);
    } catch (e) {
      if (e instanceof ZugriffVerweigertError) {
        reply.code(403).send({ error: `Berechtigung verweigert für diese Aktion: ${e.message}` });
        return;
      }
      if (e instanceof DeskNotFoundError) {
        reply.code(404).send({ error: e.message });
        return;
      }
      throw e;
    }
  };
}
