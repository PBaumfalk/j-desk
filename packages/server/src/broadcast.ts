interface Sendable {
  send(data: string): void;
}

const rooms = new Map<string, Set<Sendable>>();

export function register(deskId: string, socket: Sendable): void {
  let room = rooms.get(deskId);
  if (!room) rooms.set(deskId, (room = new Set()));
  room.add(socket);
}

export function unregister(deskId: string, socket: Sendable): void {
  const room = rooms.get(deskId);
  room?.delete(socket);
  if (room && room.size === 0) rooms.delete(deskId);
}

export function broadcast(deskId: string, msg: unknown): void {
  const data = JSON.stringify(msg);
  for (const socket of rooms.get(deskId) ?? []) {
    try {
      socket.send(data);
    } catch {
      // toter Socket — wird über sein close-Event ausgetragen
    }
  }
}
