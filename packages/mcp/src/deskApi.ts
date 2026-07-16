export class DeskApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function request<T>(baseUrl: string, token: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${baseUrl}/api/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let message = `Desk-Server-Fehler (HTTP ${res.status})`;
    try {
      message = ((await res.json()) as { error?: string }).error ?? message;
    } catch {
      // kein JSON-Body
    }
    throw new DeskApiError(message, res.status);
  }
  return (await res.json()) as T;
}

export interface DeskInfo { id: string; name: string; ownerId: string; ownerName: string; isOwner: boolean }
export interface Doc { id: string; fileId: string; name: string; position: { x: number; y: number }; rotation: number; zIndex: number }
export interface Link { id: string; fromId: string; toId: string; note: string }
export interface Stack { id: string; name: string; docIds: string[]; position: { x: number; y: number }; zIndex: number }
export interface DeskState { rev: number; state: { docs: Doc[]; links: Link[]; stacks: Stack[] } }

export const listDesks = (b: string, t: string) => request<DeskInfo[]>(b, t, 'GET', '/desks');
export const getState = (b: string, t: string, deskId: string) => request<DeskState>(b, t, 'GET', `/desks/${deskId}/state`);
export const sendCommand = (b: string, t: string, deskId: string, cmd: { type: string; payload: unknown }) =>
  request<DeskState>(b, t, 'POST', `/desks/${deskId}/commands`, cmd);
export const createDesk = (b: string, t: string, name: string) => request<DeskInfo>(b, t, 'POST', '/desks', { name });
export const renameDesk = (b: string, t: string, deskId: string, name: string) =>
  request<{ ok: boolean }>(b, t, 'PATCH', `/desks/${deskId}`, { name });

export async function getFile(baseUrl: string, token: string, fileId: string): Promise<Uint8Array> {
  const res = await fetch(`${baseUrl}/api/v1/files/${fileId}`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new DeskApiError(`Datei nicht ladbar (HTTP ${res.status})`, res.status);
  return new Uint8Array(await res.arrayBuffer());
}
