export class DeskApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** Ablehnung des Vorschlags-Erstellungspfads (12-05): trägt zusätzlich den maschinenlesbaren
 *  grund + betroffeneQuelle des Servers (proposals.ts 422-Form) — der propose-Handler baut
 *  daraus die strukturierte isError-Antwort (Retry-Kanal des Agenten, AI-SPEC Section 4b). */
export class VorschlagError extends DeskApiError {
  constructor(
    message: string,
    status: number,
    readonly grund?: string,
    readonly betroffeneQuelle?: unknown,
  ) {
    super(message, status);
  }
}

/** Datei-Art einer Karte (Task 5): bestimmt, wie get_document_text an Text kommt.
    Lokale Definition statt Abhängigkeit auf @j-desk/core — die MCP spricht
    den Desk-Server ausschließlich über HTTP, ohne Paket-Kopplung. */
export type FileKind = 'pdf' | 'image' | 'convertible' | 'other';

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

// Rework-Semantik: Desks sind kanzlei-weit geteilt — Eigentümer-Felder entfallen.
export interface DeskInfo { id: string; name: string; ownerId: string }
export interface Doc {
  id: string; fileId: string; name: string; position: { x: number; y: number }; rotation: number; zIndex: number;
  kind?: FileKind; taped?: boolean;
  /** j-lawyer-Abgleich (R1): Quelldokument verwaist bzw. seither ersetzt — reine Flags/Datum, kein Klartext. */
  sourceGone?: boolean; sourceReplacedAt?: string;
}
export interface Link { id: string; fromId: string; toId: string; note: string }
export interface Stack { id: string; name: string; docIds: string[]; position: { x: number; y: number }; zIndex: number; stapled?: boolean; taped?: boolean }
export interface Note { id: string; kind: string; text: string; position: { x: number; y: number }; zIndex: number; customLabel?: string; done?: boolean; taped?: boolean }
export interface Cutout { id: string; fileId: string; page: number; rect: { x: number; y: number; w: number; h: number }; position: { x: number; y: number }; zIndex: number; taped?: boolean }
export interface Stamp { id: string; docId: string; page: number; text: string; color: string; date?: string }
export interface Flag { id: string; docId: string; page: number; offset: number; color: string }
export interface Mark { id: string; docId: string; kind: string }
export interface Clip { id: string; memberIds: string[] }
export interface TrashedItem { id: string; kind: string; name: string; trashedAt: string }
export interface DeskState {
  rev: number;
  state: {
    docs: Doc[]; links: Link[]; stacks: Stack[]; notes?: Note[]; cutouts?: Cutout[];
    stamps?: Stamp[]; flags?: Flag[]; marks?: Mark[]; clips?: Clip[]; trash?: TrashedItem[];
  };
}

export const listDesks = (b: string, t: string) => request<DeskInfo[]>(b, t, 'GET', '/desks');
export const getState = (b: string, t: string, deskId: string) => request<DeskState>(b, t, 'GET', `/desks/${deskId}/state`);
export const sendCommand = (b: string, t: string, deskId: string, cmd: { type: string; payload: unknown }) =>
  request<DeskState>(b, t, 'POST', `/desks/${deskId}/commands`, cmd);
export const createDesk = (b: string, t: string, name: string) => request<DeskInfo>(b, t, 'POST', '/desks', { name });
export const renameDesk = (b: string, t: string, deskId: string, name: string) =>
  request<{ ok: boolean }>(b, t, 'PATCH', `/desks/${deskId}`, { name });

/** Body der Vorschlags-Erstellung (POST /desks/:id/vorschlaege, Plan 12-03): quellen nur bei
 *  inhaltsbezogenen arten (Server-Quellenpflicht), idempotenzKey als Agenten-Retry-Schutz. */
export interface VorschlagBody {
  art: string;
  payload: Record<string, unknown>;
  quellen?: { dokumentId: string; seite: number; zitat: string }[];
  zusammenfassung: string;
  idempotenzKey?: string;
}

/** Eigener Fetch statt request(): die 422-Ablehnung trägt grund/betroffeneQuelle, die das
 *  generische request()-Muster verwerfen würde — sie sind der Retry-Kanal des Agenten. */
export async function sendeVorschlag(
  baseUrl: string,
  token: string,
  deskId: string,
  body: VorschlagBody,
): Promise<{ vorschlagId: string; status: string }> {
  const res = await fetch(`${baseUrl}/api/v1/desks/${deskId}/vorschlaege`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let message = `Desk-Server-Fehler (HTTP ${res.status})`;
    let grund: string | undefined;
    let betroffeneQuelle: unknown;
    try {
      const fehlerBody = (await res.json()) as { error?: string; grund?: string; betroffeneQuelle?: unknown };
      message = fehlerBody.error ?? message;
      grund = fehlerBody.grund;
      betroffeneQuelle = fehlerBody.betroffeneQuelle;
    } catch {
      // kein JSON-Body
    }
    throw new VorschlagError(message, res.status, grund, betroffeneQuelle);
  }
  return (await res.json()) as { vorschlagId: string; status: string };
}

/** Seitentext einer Datei (GET /desks/:id/file-text/:fileId, Phase 7) — Spiegel der
 *  Server-Antwort (search/fileText.ts): pdf_text zuerst, ocr_text als Fallback. */
export interface SeitenText {
  seite: number;
  text: string;
  quelle: 'pdf-text' | 'ocr';
}
export const getDocumentPageText = (b: string, t: string, deskId: string, fileId: string) =>
  request<{ seiten: SeitenText[]; stand: string }>(b, t, 'GET', `/desks/${deskId}/file-text/${fileId}`);

export async function getFile(baseUrl: string, token: string, fileId: string): Promise<Uint8Array> {
  const res = await fetch(`${baseUrl}/api/v1/files/${fileId}`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) {
    let message = `Datei nicht ladbar (HTTP ${res.status})`;
    try {
      message = ((await res.json()) as { error?: string }).error ?? message;
    } catch {
      // kein JSON-Body
    }
    throw new DeskApiError(message, res.status);
  }
  return new Uint8Array(await res.arrayBuffer());
}

export type PreviewResult = { status: 'ready'; bytes: Uint8Array } | { status: 'converting' };

/** Ein einzelner Abruf von /files/:id/preview (Task 5): 200 -> fertige PDF-Bytes,
    202 -> Konvertierung läuft noch, alles andere -> DeskApiError mit der Server-Meldung. */
export async function getPreview(baseUrl: string, token: string, fileId: string): Promise<PreviewResult> {
  const res = await fetch(`${baseUrl}/api/v1/files/${fileId}/preview`, { headers: { authorization: `Bearer ${token}` } });
  if (res.status === 202) return { status: 'converting' };
  if (!res.ok) {
    let message = `Vorschau nicht ladbar (HTTP ${res.status})`;
    try {
      message = ((await res.json()) as { error?: string }).error ?? message;
    } catch {
      // kein JSON-Body
    }
    throw new DeskApiError(message, res.status);
  }
  return { status: 'ready', bytes: new Uint8Array(await res.arrayBuffer()) };
}

export interface PollPreviewOptions {
  /** Wartezeit zwischen Polls in ms (Default 2000; über MCP_PREVIEW_POLL_INTERVAL_MS für Tests verkürzbar). */
  intervalMs?: number;
  /** Maximale Gesamtwartezeit in ms (Default 30000). */
  timeoutMs?: number;
}

/** Pollt die Vorschau eines konvertierbaren Dokuments (kind 'convertible'), bis sie fertig ist. */
export async function pollPreview(
  baseUrl: string,
  token: string,
  fileId: string,
  opts: PollPreviewOptions = {},
): Promise<Uint8Array> {
  const intervalMs = opts.intervalMs ?? Number(process.env.MCP_PREVIEW_POLL_INTERVAL_MS ?? 2000);
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await getPreview(baseUrl, token, fileId);
    if (r.status === 'ready') return r.bytes;
    if (Date.now() >= deadline) {
      throw new DeskApiError('Vorschau ist noch nicht fertig — später erneut versuchen', 408);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
