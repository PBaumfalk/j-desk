import { fetch } from '@tauri-apps/plugin-http';
import type { Command, DesktopState } from '@digital-desktop/core';

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export interface DeskInfo {
  id: string;
  name: string;
  ownerId: string;
  ownerName: string;
  isOwner: boolean;
}

export interface UserInfo {
  id: string;
  username: string;
  isAdmin: boolean;
}

export interface MemberInfo {
  id: string;
  username: string;
}

export interface InviteInfo {
  token: string;
  deskId: string | null;
  deskName: string | null;
  createdBy: string;
  expiresAt: number;
}

export interface DeskState {
  rev: number;
  state: DesktopState;
}

export class ApiClient {
  constructor(
    public baseUrl: string,
    public token: string | null = null,
  ) {}

  private authHeaders(): Record<string, string> {
    return this.token ? { authorization: `Bearer ${this.token}` } : {};
  }

  private async parseError(res: Response): Promise<ApiError> {
    let message = `HTTP ${res.status}`;
    try {
      message = ((await res.json()) as { error?: string }).error ?? message;
    } catch {
      // kein JSON-Body — Statuscode reicht
    }
    return new ApiError(message, res.status);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}/api/v1${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...this.authHeaders(),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw await this.parseError(res);
    return (await res.json()) as T;
  }

  status(): Promise<{ needsSetup: boolean }> {
    return this.request('GET', '/auth/status');
  }

  async setup(username: string, password: string): Promise<void> {
    const r = await this.request<{ token: string }>('POST', '/auth/setup', { username, password });
    this.token = r.token;
  }

  async login(username: string, password: string): Promise<void> {
    const r = await this.request<{ token: string }>('POST', '/auth/login', { username, password });
    this.token = r.token;
  }

  async logout(): Promise<void> {
    await this.request('POST', '/auth/logout').finally(() => (this.token = null));
  }

  me(): Promise<UserInfo> {
    return this.request('GET', '/auth/me');
  }

  changePassword(oldPassword: string, newPassword: string): Promise<{ ok: boolean }> {
    return this.request('POST', '/auth/password', { oldPassword, newPassword });
  }

  listUsers(): Promise<UserInfo[]> {
    return this.request('GET', '/users');
  }

  createUser(username: string, password: string): Promise<UserInfo> {
    return this.request('POST', '/users', { username, password });
  }

  renameUser(userId: string, username: string): Promise<{ ok: boolean }> {
    return this.request('PATCH', `/users/${userId}`, { username });
  }

  resetUserPassword(userId: string, password: string): Promise<{ ok: boolean }> {
    return this.request('POST', `/users/${userId}/password`, { password });
  }

  deleteUser(userId: string): Promise<{ ok: boolean }> {
    return this.request('DELETE', `/users/${userId}`);
  }

  getUserDesks(userId: string): Promise<{ id: string; name: string }[]> {
    return this.request('GET', `/users/${userId}/desks`);
  }

  listMembers(deskId: string): Promise<MemberInfo[]> {
    return this.request('GET', `/desks/${deskId}/members`);
  }

  addMember(deskId: string, username: string): Promise<MemberInfo> {
    return this.request('POST', `/desks/${deskId}/members`, { username });
  }

  removeMember(deskId: string, userId: string): Promise<{ ok: boolean }> {
    return this.request('DELETE', `/desks/${deskId}/members/${userId}`);
  }

  createInvite(deskId?: string): Promise<{ token: string; expiresAt: number }> {
    return this.request('POST', '/invites', deskId ? { deskId } : {});
  }

  listInvites(): Promise<InviteInfo[]> {
    return this.request('GET', '/invites');
  }

  revokeInvite(token: string): Promise<{ ok: boolean }> {
    return this.request('DELETE', `/invites/${token}`);
  }

  inviteInfo(token: string): Promise<{ deskName: string | null }> {
    return this.request('GET', `/auth/invite/${token}`);
  }

  async redeem(token: string, username: string, password: string): Promise<void> {
    const r = await this.request<{ token: string }>('POST', '/auth/redeem', { token, username, password });
    this.token = r.token;
  }

  listDesks(): Promise<DeskInfo[]> {
    return this.request('GET', '/desks');
  }

  createDesk(name: string): Promise<DeskInfo> {
    return this.request('POST', '/desks', { name });
  }

  renameDesk(deskId: string, name: string): Promise<{ ok: boolean }> {
    return this.request('PATCH', `/desks/${deskId}`, { name });
  }

  deleteDesk(deskId: string): Promise<{ ok: boolean }> {
    return this.request('DELETE', `/desks/${deskId}`);
  }

  getState(deskId: string): Promise<DeskState> {
    return this.request('GET', `/desks/${deskId}/state`);
  }

  sendCommand(deskId: string, cmd: Command): Promise<DeskState> {
    return this.request('POST', `/desks/${deskId}/commands`, cmd);
  }

  putState(deskId: string, state: DesktopState): Promise<DeskState> {
    return this.request('PUT', `/desks/${deskId}/state`, state);
  }

  async uploadFile(bytes: Uint8Array, name: string): Promise<string> {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'application/pdf' }), name);
    const res = await fetch(`${this.baseUrl}/api/v1/files`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: form,
    });
    if (!res.ok) throw await this.parseError(res);
    return ((await res.json()) as { fileId: string }).fileId;
  }

  async fetchFile(fileId: string): Promise<Uint8Array> {
    const res = await fetch(`${this.baseUrl}/api/v1/files/${fileId}`, { headers: this.authHeaders() });
    if (!res.ok) throw await this.parseError(res);
    return new Uint8Array(await res.arrayBuffer());
  }

  wsUrl(deskId: string): string {
    return `${this.baseUrl.replace(/^http/, 'ws')}/api/v1/desks/${deskId}/ws?token=${this.token ?? ''}`;
  }
}
