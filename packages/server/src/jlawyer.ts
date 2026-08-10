/** Fehlerklasse für die HTTP-Außenwirkung UND den Grund, damit Aufrufer (z. B. `jlFehler`
 *  in app.ts) unterscheiden können, ohne den status zu überladen: 'auth' (401 — Session
 *  abgelaufen, erzwingt Logout), 'verboten' (403 — kein Logout, nur diese Aktion untersagt),
 *  'fehlt' (404), 'nichtErreichbar' (Netzfehler/Timeout), 'server' (sonstiger Fehlerstatus). */
export type JLawyerFehlerArt = 'auth' | 'verboten' | 'fehlt' | 'nichtErreichbar' | 'server';

/**
 * Einziger Ort mit Kenntnis der j-lawyer-REST-API (Rework-Spec).
 * baseUrl inklusive Kontextpfad, z. B. "http://kanzlei-server:8080/j-lawyer-io".
 */
export class JLawyerError extends Error {
  constructor(message: string, readonly status: number, readonly art: JLawyerFehlerArt) {
    super(message);
  }
}

/** Zentrale Statuscode->Fehlerklasse-Abbildung für Antworten, die auf jlFetch folgen
 *  (jlFetch selbst wirft bereits 'nichtErreichbar' bei Netzfehlern/Timeout). */
function statusFehler(res: Response): JLawyerError {
  if (res.status === 401) return new JLawyerError('j-lawyer-Anmeldung abgelaufen', 401, 'auth');
  if (res.status === 403) return new JLawyerError('j-lawyer verweigert den Zugriff', 403, 'verboten');
  if (res.status === 404) return new JLawyerError('j-lawyer kennt diese Ressource nicht', 502, 'fehlt');
  return new JLawyerError(`j-lawyer antwortet mit HTTP ${res.status}`, 502, 'server');
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

/** Nimmt beide Schreibweisen an: …/j-lawyer-io und …/j-lawyer-io/rest (echte Instanz braucht /rest). */
export function normalizeBase(baseUrl: string): string {
  const b = baseUrl.replace(/\/+$/, '');
  return b.endsWith('/rest') ? b : `${b}/rest`;
}

async function jlFetch(baseUrl: string, path: string, username: string, password: string): Promise<Response> {
  const url = `${normalizeBase(baseUrl)}${path}`;
  try {
    return await fetch(url, {
      headers: { authorization: basicAuth(username, password) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new JLawyerError('j-lawyer ist nicht erreichbar', 502, 'nichtErreichbar');
  }
}

/** Prüft Zugangsdaten per Testabruf der Aktenliste (kleinster lesender Endpunkt).
 *  Login-Kontext: 401 UND 403 bedeuten hier beide „falsche Zugangsdaten", nicht „verboten". */
export async function validateLogin(baseUrl: string, username: string, password: string): Promise<boolean> {
  const res = await jlFetch(baseUrl, '/v1/cases/list', username, password);
  if (res.status === 401 || res.status === 403) return false;
  if (!res.ok) throw new JLawyerError(`j-lawyer antwortet mit HTTP ${res.status}`, 502, 'server');
  return true;
}

/** Setup-Probe: Ist unter der URL ein j-lawyer erreichbar? Ohne Zugangsdaten ist die
 *  korrekte Antwort 401/403 („verlangt Anmeldung"); 2xx akzeptieren wir ebenfalls. */
export async function probeJLawyer(baseUrl: string): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await jlFetch(baseUrl, '/v1/cases/list', '', '');
    if (res.status === 401 || res.status === 403 || res.ok) {
      return { ok: true, message: 'j-lawyer erreichbar' };
    }
    return { ok: false, message: `j-lawyer antwortet mit HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Server nicht erreichbar' };
  }
}

async function jlJson(baseUrl: string, path: string, username: string, password: string): Promise<unknown> {
  const res = await jlFetch(baseUrl, path, username, password);
  if (!res.ok) throw statusFehler(res);
  return res.json();
}

/** j-lawyer serialisiert java.util.Date als Millis oder ISO-String — die echte Instanz
    liefert ISO mit Zonen-Suffix in eckigen Klammern ("2026-07-18T14:44:38Z[UTC]"). */
function toMillis(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const t = Date.parse(v.replace(/\[[^\]]*\]$/, ''));
    if (!Number.isNaN(t)) return t;
  }
  return 0;
}

export async function listCases(baseUrl: string, username: string, password: string): Promise<JLawyerCase[]> {
  const raw = await jlJson(baseUrl, '/v1/cases/list', username, password);
  if (!Array.isArray(raw)) throw new JLawyerError('Unerwartete Antwort von j-lawyer', 502, 'server');
  return (raw as Record<string, unknown>[]).map((c) => ({
    id: String(c.id ?? ''),
    fileNumber: String(c.fileNumber ?? ''),
    name: String(c.name ?? ''),
    reason: String(c.reason ?? ''),
  }));
}

export async function listDocuments(baseUrl: string, username: string, password: string, caseId: string): Promise<JLawyerDocument[]> {
  const raw = await jlJson(baseUrl, `/v1/cases/${encodeURIComponent(caseId)}/documents`, username, password);
  if (!Array.isArray(raw)) throw new JLawyerError('Unerwartete Antwort von j-lawyer', 502, 'server');
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

/** Fall-Metadaten (v2) — dient hier ausschließlich der Archiv-Ableitung. Laut
 *  01-SPIKE-FINDINGS.md ist "archiviert" eine Ganzzahl (0/1) auf FALL-Ebene, kein
 *  Boolean, und existiert NICHT auf Dokument-/Bulk-Ebene. Live gegen die reale
 *  Testinstanz verifiziert (Setzen + Lesen + Persistenz). */
export async function getCase(baseUrl: string, username: string, password: string, caseId: string): Promise<{ archived: boolean }> {
  const raw = await jlJson(baseUrl, `/v2/cases/${encodeURIComponent(caseId)}`, username, password);
  const c = raw as Record<string, unknown>;
  return { archived: Number(c.archived ?? 0) !== 0 };
}

/** API-Ebene der j-lawyer-Instanz (REF-03, GET /v1/security/metadata -> ApiMetadataV1).
 *  Live gegen die reale Testinstanz verifiziert (01-SPIKE-FINDINGS.md): eine monoton
 *  wachsende Ganzzahl, kein Semver-String — dient ausschließlich der Versionskompatibilitäts-
 *  prüfung beim Verbinden in app.ts (nie login-blockierend, siehe dort). */
export async function getApiMetadata(baseUrl: string, username: string, password: string): Promise<{ apiLevel: number }> {
  const raw = await jlJson(baseUrl, '/v1/security/metadata', username, password);
  const m = raw as Record<string, unknown>;
  return { apiLevel: Number(m.apiLevel) };
}

/** Dokumentinhalt; j-lawyer liefert Base64 (RestfulDocumentContentV1.base64content). */
export async function getDocumentContent(baseUrl: string, username: string, password: string, docId: string): Promise<Buffer> {
  const d = (await jlJson(baseUrl, `/v1/cases/document/${encodeURIComponent(docId)}/content`, username, password)) as Record<string, unknown>;
  if (typeof d.base64content !== 'string') throw new JLawyerError('Unerwartete Antwort von j-lawyer (kein base64content)', 502, 'server');
  return Buffer.from(d.base64content, 'base64');
}

/** Legt ein Dokument in der Akte an (PUT document/create) und liefert die neue Dokument-ID. */
export async function createDocument(baseUrl: string, username: string, password: string, caseId: string, fileName: string, bytes: Buffer): Promise<{ id: string }> {
  const url = `${normalizeBase(baseUrl)}/v1/cases/document/create`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'PUT',
      headers: { authorization: basicAuth(username, password), 'content-type': 'application/json' },
      body: JSON.stringify({ caseId, fileName, base64content: bytes.toString('base64') }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new JLawyerError('j-lawyer ist nicht erreichbar', 502, 'nichtErreichbar');
  }
  if (!res.ok) throw statusFehler(res);
  const d = (await res.json()) as Record<string, unknown>;
  return { id: String(d.id ?? '') };
}

/** Eingabefelder für createDueDate — vom Aufrufer bestimmt. `type` (Wiedervorlage) und
 *  `reminderMinutes` (keine Erinnerung) sind BEWUSST FEST und werden ausschließlich innerhalb
 *  von createDueDate gesetzt (siehe dort), damit kein Aufrufer sie versehentlich abweichend
 *  belegt. Die Fristen-Variante ('RESPITE') ist ausdrücklich NICHT Teil dieser Phase
 *  (siehe COVERAGE.md). */
export interface JLawyerDueDateEingabe {
  caseId: string;
  calendar: string;
  summary: string;
  description?: string;
  assignee?: string;
  beginDate: string;
}

/** Von j-lawyer vergebene Kennung der neu angelegten Wiedervorlage. */
export interface JLawyerDueDateErgebnis {
  id: string;
}

/** Legt eine Wiedervorlage (Due Date) in j-lawyer an, PUT-Aufruf auf v6/cases/duedate,
 *  Unterpfad create. Der Feldsatz (RestfulDueDateV6) stammt aus dem Lesen des offenen
 *  j-lawyer-Quellcodes, NICHT aus einem Lauf gegen eine echte Instanz — wie schon einmal bei
 *  toMillis() (Kommentar oben) wich die echte Instanz für einen anderen Endpunkt vom Quellcode
 *  ab (Klammersuffix bei changeDate); vor dem Produktivbetrieb gegen die eigene
 *  j-lawyer-Fassung zu prüfen (siehe docs/deployment/jlawyer-aufgabenuebergabe.md). */
export async function createDueDate(baseUrl: string, username: string, password: string, eingabe: JLawyerDueDateEingabe): Promise<string> {
  const url = `${normalizeBase(baseUrl)}/v6/cases/duedate/create`;
  const body: Record<string, unknown> = {
    caseId: eingabe.caseId,
    calendar: eingabe.calendar,
    summary: eingabe.summary,
    beginDate: eingabe.beginDate,
    type: 'FOLLOWUP', // Wiedervorlage — fest, siehe Kommentar am Interface
    reminderMinutes: -1, // keine Erinnerung — fest
  };
  // Optionale Felder werden ausgelassen statt als leere Zeichenkette gesendet.
  if (eingabe.description !== undefined) body.description = eingabe.description;
  if (eingabe.assignee !== undefined) body.assignee = eingabe.assignee;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'PUT',
      headers: { authorization: basicAuth(username, password), 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new JLawyerError('j-lawyer ist nicht erreichbar', 502, 'nichtErreichbar');
  }
  if (!res.ok) throw statusFehler(res);
  const d = (await res.json()) as Record<string, unknown>;
  // Fehlende Kennung in der Antwort -> leere Zeichenkette statt Absturz.
  return String(d.id ?? '');
}
