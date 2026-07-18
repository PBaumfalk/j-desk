/**
 * Einziger Ort mit Kenntnis der j-lawyer-REST-API (Rework-Spec).
 * baseUrl inklusive Kontextpfad, z. B. "http://kanzlei-server:8080/j-lawyer-io".
 */
export class JLawyerError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** Felder aus RestfulCaseOverviewV1 (j-lawyer-Quellcode, verifiziert 2026-07-18). */
export interface JLawyerCase {
  id: string;
  fileNumber: string;
  name: string;    // Rubrum
  reason: string;  // „wegen"
}

/** Felder aus RestfulDocumentV1. changeDate normalisiert auf Unix-Millis. */
export interface JLawyerDocument {
  id: string;
  name: string;
  changeDate: number;
  size: number;
}

const TIMEOUT_MS = 10_000;

function basicAuth(username: string, password: string): string {
  return 'Basic ' + Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
}

async function jlFetch(baseUrl: string, path: string, username: string, password: string): Promise<Response> {
  const url = `${baseUrl.replace(/\/+$/, '')}${path}`;
  try {
    return await fetch(url, {
      headers: { authorization: basicAuth(username, password) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new JLawyerError('j-lawyer ist nicht erreichbar', 502);
  }
}

/** Prüft Zugangsdaten per Testabruf der Aktenliste (kleinster lesender Endpunkt). */
export async function validateLogin(baseUrl: string, username: string, password: string): Promise<boolean> {
  const res = await jlFetch(baseUrl, '/v1/cases/list', username, password);
  if (res.status === 401 || res.status === 403) return false;
  if (!res.ok) throw new JLawyerError(`j-lawyer antwortet mit HTTP ${res.status}`, 502);
  return true;
}

async function jlJson(baseUrl: string, path: string, username: string, password: string): Promise<unknown> {
  const res = await jlFetch(baseUrl, path, username, password);
  if (res.status === 401 || res.status === 403) throw new JLawyerError('j-lawyer-Anmeldung abgelaufen', 401);
  if (!res.ok) throw new JLawyerError(`j-lawyer antwortet mit HTTP ${res.status}`, 502);
  return res.json();
}

/** j-lawyer serialisiert java.util.Date je nach Konfiguration als Millis oder ISO-String. */
function toMillis(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return t;
  }
  return 0;
}

export async function listCases(baseUrl: string, username: string, password: string): Promise<JLawyerCase[]> {
  const raw = await jlJson(baseUrl, '/v1/cases/list', username, password);
  if (!Array.isArray(raw)) throw new JLawyerError('Unerwartete Antwort von j-lawyer', 502);
  return (raw as Record<string, unknown>[]).map((c) => ({
    id: String(c.id ?? ''),
    fileNumber: String(c.fileNumber ?? ''),
    name: String(c.name ?? ''),
    reason: String(c.reason ?? ''),
  }));
}

export async function listDocuments(baseUrl: string, username: string, password: string, caseId: string): Promise<JLawyerDocument[]> {
  const raw = await jlJson(baseUrl, `/v1/cases/${encodeURIComponent(caseId)}/documents`, username, password);
  if (!Array.isArray(raw)) throw new JLawyerError('Unerwartete Antwort von j-lawyer', 502);
  return (raw as Record<string, unknown>[]).map((d) => ({
    id: String(d.id ?? ''),
    name: String(d.name ?? ''),
    changeDate: toMillis(d.changeDate),
    size: Number(d.size ?? 0),
  }));
}

/** Metadaten eines Dokuments — dient zugleich als Berechtigungsprüfung mit den Sitzungs-Credentials. */
export async function getDocumentMeta(baseUrl: string, username: string, password: string, docId: string): Promise<{ id: string; caseId: string; name: string; changeDate: number }> {
  const d = (await jlJson(baseUrl, `/v1/cases/document/${encodeURIComponent(docId)}`, username, password)) as Record<string, unknown>;
  return { id: String(d.id ?? ''), caseId: String(d.caseId ?? ''), name: String(d.name ?? ''), changeDate: toMillis(d.changeDate) };
}

/** Dokumentinhalt; j-lawyer liefert Base64 (RestfulDocumentContentV1.base64content). */
export async function getDocumentContent(baseUrl: string, username: string, password: string, docId: string): Promise<Buffer> {
  const d = (await jlJson(baseUrl, `/v1/cases/document/${encodeURIComponent(docId)}/content`, username, password)) as Record<string, unknown>;
  if (typeof d.base64content !== 'string') throw new JLawyerError('Unerwartete Antwort von j-lawyer (kein base64content)', 502);
  return Buffer.from(d.base64content, 'base64');
}

/** Legt ein Dokument in der Akte an (PUT document/create) und liefert die neue Dokument-ID. */
export async function createDocument(baseUrl: string, username: string, password: string, caseId: string, fileName: string, bytes: Buffer): Promise<{ id: string }> {
  const url = `${baseUrl.replace(/\/+$/, '')}/v1/cases/document/create`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'PUT',
      headers: { authorization: basicAuth(username, password), 'content-type': 'application/json' },
      body: JSON.stringify({ caseId, fileName, base64content: bytes.toString('base64') }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new JLawyerError('j-lawyer ist nicht erreichbar', 502);
  }
  if (res.status === 401 || res.status === 403) throw new JLawyerError('j-lawyer-Anmeldung abgelaufen', 401);
  if (!res.ok) throw new JLawyerError(`j-lawyer antwortet mit HTTP ${res.status}`, 502);
  const d = (await res.json()) as Record<string, unknown>;
  return { id: String(d.id ?? '') };
}
