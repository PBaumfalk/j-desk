export interface WsConn {
  send(data: string): void;
  close(code: number, reason: string): void;
}

const rooms = new Map<string, Map<WsConn, string>>();

export function register(deskId: string, socket: WsConn, userId: string): void {
  let room = rooms.get(deskId);
  if (!room) rooms.set(deskId, (room = new Map()));
  room.set(socket, userId);
}

export function unregister(deskId: string, socket: WsConn): void {
  const room = rooms.get(deskId);
  room?.delete(socket);
  if (room && room.size === 0) rooms.delete(deskId);
}

export function broadcast(deskId: string, msg: unknown): void {
  const data = JSON.stringify(msg);
  for (const socket of rooms.get(deskId)?.keys() ?? []) {
    try {
      socket.send(data);
    } catch {
      // toter Socket — wird über sein close-Event ausgetragen
    }
  }
}

function schliessen(socket: WsConn, code: number, reason: string): void {
  try {
    socket.close(code, reason);
  } catch {
    // bereits zu
  }
}

/** Desk wurde gelöscht — alle Clients des Desks trennen. */
export function closeDesk(deskId: string): void {
  for (const socket of rooms.get(deskId)?.keys() ?? []) schliessen(socket, 4001, 'desk-deleted');
  rooms.delete(deskId);
}

/** Zugriff eines Benutzers auf einen Desk entzogen. */
export function closeUserOnDesk(deskId: string, userId: string): void {
  const room = rooms.get(deskId);
  if (!room) return;
  for (const [socket, uid] of room) {
    if (uid === userId) schliessen(socket, 4003, 'access-revoked');
  }
}

/** Konto gelöscht — alle Sockets des Benutzers auf allen Desks trennen. */
export function closeUserEverywhere(userId: string): void {
  for (const deskId of rooms.keys()) closeUserOnDesk(deskId, userId);
}
