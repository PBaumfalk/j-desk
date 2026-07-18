/**
 * Einziger Ort mit Kenntnis der j-lawyer-REST-API (Rework-Spec).
 * baseUrl inklusive Kontextpfad, z. B. "http://kanzlei-server:8080/j-lawyer-io".
 */
export class JLawyerError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export interface JLawyerCase {
  id: string;
  fileNumber: string;
  name: string;
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

/** Aktenliste mit tolerantem Feld-Mapping (exakte Feldnamen klärt der API-Spike). */
export async function listCases(baseUrl: string, username: string, password: string): Promise<JLawyerCase[]> {
  const res = await jlFetch(baseUrl, '/v1/cases/list', username, password);
  if (res.status === 401 || res.status === 403) throw new JLawyerError('j-lawyer-Anmeldung abgelaufen', 401);
  if (!res.ok) throw new JLawyerError(`j-lawyer antwortet mit HTTP ${res.status}`, 502);
  const raw = (await res.json()) as Record<string, unknown>[];
  if (!Array.isArray(raw)) throw new JLawyerError('Unerwartete Antwort von j-lawyer', 502);
  return raw.map((c) => ({
    id: String(c.id ?? ''),
    fileNumber: String(c.fileNumber ?? c.aktenzeichen ?? ''),
    name: String(c.reason ?? c.rubrum ?? c.name ?? ''),
  }));
}
