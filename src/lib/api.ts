import type { Command, DesktopState, FileKind } from '@j-desk/core';

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export interface DeskInfo {
  id: string;
  name: string;
  ownerId: string;
}

export interface DeskState {
  rev: number;
  state: DesktopState;
}

export class ApiClient {
  constructor(public baseUrl = '', public token: string | null = null) {}

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

  status(): Promise<{ needsSetup: boolean; mode?: 'standalone' | 'jlawyer' }> {
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

  async uploadFile(bytes: Uint8Array, name: string, mime = 'application/pdf'): Promise<{ fileId: string; kind: FileKind }> {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: mime }), name);
    const res = await fetch(`${this.baseUrl}/api/v1/files`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: form,
    });
    if (!res.ok) throw await this.parseError(res);
    return (await res.json()) as { fileId: string; kind: FileKind };
  }

  // ---- j-lawyer-Modus ----
  getCases(): Promise<{ id: string; fileNumber: string; name: string; reason: string }[]> {
    return this.request('GET', '/cases');
  }

  /** Akten-Schreibtisch öffnen — der Server gleicht mit j-lawyer ab. */
  getCaseDesk(caseId: string): Promise<DeskState> {
    return this.request('GET', `/cases/${caseId}/desk`);
  }

  /** Upload in die Akte; die Karte legt der Server erst nach j-lawyer-Bestätigung an. */
  async uploadToCase(caseId: string, bytes: Uint8Array, name: string): Promise<DeskState> {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'application/pdf' }), name);
    const res = await fetch(`${this.baseUrl}/api/v1/cases/${caseId}/documents`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: form,
    });
    if (!res.ok) throw await this.parseError(res);
    return (await res.json()) as DeskState;
  }

  async fetchFile(fileId: string): Promise<Uint8Array> {
    const res = await fetch(`${this.baseUrl}/api/v1/files/${fileId}`, { headers: this.authHeaders() });
    if (!res.ok) throw await this.parseError(res);
    return new Uint8Array(await res.arrayBuffer());
  }

  /**
   * Vorschau einer Datei: 200 = fertige PDF-Bytes, 202 = Konvertierung läuft noch,
   * 409 = Konvertierung (endgültig oder vorerst) fehlgeschlagen. Andere Fehler (u. a. 404)
   * werfen wie gehabt einen ApiError.
   */
  async fetchPreview(
    fileId: string,
  ): Promise<{ status: 'ready'; bytes: Uint8Array } | { status: 'converting' } | { status: 'error'; message: string }> {
    const res = await fetch(`${this.baseUrl}/api/v1/files/${fileId}/preview`, { headers: this.authHeaders() });
    if (res.status === 202) return { status: 'converting' };
    if (res.status === 409) {
      let message = `HTTP ${res.status}`;
      try {
        message = ((await res.json()) as { error?: string }).error ?? message;
      } catch {
        // kein JSON-Body — Statuscode reicht
      }
      return { status: 'error', message };
    }
    if (!res.ok) throw await this.parseError(res);
    return { status: 'ready', bytes: new Uint8Array(await res.arrayBuffer()) };
  }

  /** Kurzlebiges Einmal-Ticket für den WebSocket-Verbindungsaufbau. */
  wsTicket(): Promise<{ ticket: string }> {
    return this.request('POST', '/ws-ticket');
  }

  wsUrl(deskId: string, ticket: string): string {
    const base = this.baseUrl || location.origin;
    return `${base.replace(/^http/, 'ws')}/api/v1/desks/${deskId}/ws?ticket=${ticket}`;
  }
}
