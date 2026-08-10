import { projectStateForActor, type DesktopState, type Rolle } from '@j-desk/core';

interface Sendable {
  send(data: string): void;
  close?(code?: number, reason?: string): void;
}

/** Empfänger-Kontext pro Socket — ohne Actor+Rolle kann broadcast() nicht empfängerspezifisch
 *  projizieren (Research Pitfall 1, T-02-01: die real bereits zweimal aufgetretene
 *  Broadcast-Leck-Bugklasse aec4f58/fcda808). */
interface SocketInfo {
  userId: string;
  rolle: Rolle;
}

const rooms = new Map<string, Map<Sendable, SocketInfo>>();

/** Registriert einen verbundenen Socket samt Actor-Kontext (userId + Rolle) für einen Desk-Room.
 *  Wird ausschließlich nach erfolgreicher Zugriffsprüfung beim WS-Connect aufgerufen (app.ts). */
export function register(deskId: string, socket: Sendable, userId: string, rolle: Rolle): void {
  let room = rooms.get(deskId);
  if (!room) rooms.set(deskId, (room = new Map()));
  room.set(socket, { userId, rolle });
}

export function unregister(deskId: string, socket: Sendable): void {
  const room = rooms.get(deskId);
  room?.delete(socket);
  if (room && room.size === 0) rooms.delete(deskId);
}

/**
 * WR-01: Rollenänderung wirkt auf OFFENE Verbindungen — bis zur Review fror register() die
 * Rolle zum Connect-Zeitpunkt ein, eine Herabstufung (z. B. Bearbeiter → Nur-Lesen) griff
 * erst nach einem Reconnect. Aktualisiert den Actor-Kontext aller Sockets des Nutzers im
 * Room; die nächste Projektion nutzt bereits die neue Rolle.
 */
export function aktualisiereRolle(deskId: string, userId: string, rolle: Rolle): void {
  const room = rooms.get(deskId);
  if (!room) return;
  for (const [socket, info] of room) {
    if (info.userId === userId) room.set(socket, { userId, rolle });
  }
}

/**
 * WR-01: RollenENTZUG wirkt sofort — ein entfernter Nutzer darf nicht weiter projizierte
 * States empfangen, bis er zufällig disconnected (ShareDialog-Versprechen „Die Person
 * verliert sofort den Zugriff"). Schließt alle Sockets des Nutzers im Room mit 4003 (wie
 * der Connect-Guard); der Client reconnectet automatisch und scheitert dann am Rollen-Check.
 */
export function trenneNutzer(deskId: string, userId: string, grund: string): void {
  const room = rooms.get(deskId);
  if (!room) return;
  for (const [socket, info] of [...room]) {
    if (info.userId !== userId) continue;
    try {
      socket.close?.(4003, grund);
    } catch {
      // toter Socket — wird über sein close-Event ausgetragen
    }
    room.delete(socket);
  }
  if (room.size === 0) rooms.delete(deskId);
}

/** Trägt `msg` ein `state`-Feld (die übliche `{ rev, state }`-Form aller bisherigen
 *  broadcast()-Aufrufer), projiziert nach diesem für den jeweiligen Empfänger; sonst
 *  unverändert (z. B. rein transiente, nicht State-tragende Nachrichten). */
function projiziertFuerEmpfaenger(msg: unknown, info: SocketInfo): unknown {
  if (msg && typeof msg === 'object' && 'state' in msg) {
    const eingehuellt = msg as Record<string, unknown> & { state: DesktopState };
    return { ...eingehuellt, state: projectStateForActor(eingehuellt.state, { userId: info.userId, rolle: info.rolle }) };
  }
  return msg;
}

/**
 * Sendet `msg` an jeden verbundenen Socket eines Desk-Rooms — JEDER Empfänger bekommt seine
 * EIGENE, für seinen Actor-Kontext projizierte Fassung (PERM-05). Die Projektion passiert HIER,
 * pro Socket, nicht vorher beim Aufrufer: ein roher, unprojizierter State an broadcast() zu
 * übergeben ist deshalb korrekt (s. Aufrufer in app.ts) — würde der Aufrufer selbst bereits für
 * EINEN Actor projizieren, bekämen alle anderen Sockets fälschlich dessen Sicht.
 */
export function broadcast(deskId: string, msg: unknown): void {
  const room = rooms.get(deskId);
  if (!room) return;
  for (const [socket, info] of room) {
    try {
      socket.send(JSON.stringify(projiziertFuerEmpfaenger(msg, info)));
    } catch {
      // toter Socket — wird über sein close-Event ausgetragen
    }
  }
}
