import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Adressiert einen (Euro-Office-kompatiblen) OnlyOffice-DocumentServer für die PDF-Vorschaukonvertierung. */
export interface ConvertConfig {
  url: string;
  jwtSecret: string;
}

export interface ConvertDeps {
  /** null = Konvertierung deaktiviert. */
  config: ConvertConfig | null;
  /** Liefert eine vom DocumentServer erreichbare Quell-URL (Einmal-Ticket) für eine Datei. */
  sourceUrl: (fileId: string) => string;
  dataDir: string;
  /** Wartezeit zwischen Polls in ms (Default 500 — Tests setzen kleinere Werte). */
  pollIntervalMs?: number;
  /** Maximale Gesamtwartezeit in ms (Default 60000). */
  timeoutMs?: number;
}

export class ConvertError extends Error {
  constructor(message: string, readonly reason: 'disabled' | 'unavailable' | 'failed') {
    super(message);
  }
}

function base64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}

/** Signiert ein JSON-Payload als HS256-JWT (node:crypto, keine neue Abhängigkeit). */
export function signJwtHS256(payload: Record<string, unknown>, secret: string): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const data = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const sig = createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i === -1 ? '' : name.slice(i + 1).toLowerCase();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface ConvertResponse {
  endConvert: boolean;
  percent?: number;
  fileUrl?: string;
  error?: unknown;
}

/** Erzeugt einen AbortController, der spätestens zur übergebenen Deadline (Date.now()-Timestamp) abbricht. */
function deadlineController(deadline: number): { controller: AbortController; clear: () => void } {
  const controller = new AbortController();
  const remaining = Math.max(1, deadline - Date.now());
  const timer = setTimeout(() => controller.abort(), remaining);
  return { controller, clear: () => clearTimeout(timer) };
}

async function attemptConvert(
  config: ConvertConfig,
  fileId: string,
  cacheKey: string,
  sourceName: string,
  sourceUrl: (fileId: string) => string,
  deadline: number,
): Promise<ConvertResponse> {
  const bodyWithoutToken = {
    async: true,
    filetype: extOf(sourceName),
    outputtype: 'pdf',
    key: cacheKey,
    title: sourceName,
    url: sourceUrl(fileId),
  };
  const token = signJwtHS256(bodyWithoutToken, config.jwtSecret);
  const body = { ...bodyWithoutToken, token };
  // Zweiter Signaturweg (Authorization-Header) für OnlyOffice-Kompatibilität.
  const authToken = signJwtHS256({ payload: body }, config.jwtSecret);

  let res: Response;
  const { controller, clear } = deadlineController(deadline);
  try {
    res = await fetch(`${config.url.replace(/\/+$/, '')}/ConvertService.ashx`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch {
    throw new ConvertError('Vorschau-Dienst nicht erreichbar', 'unavailable');
  } finally {
    clear();
  }
  if (!res.ok) {
    throw new ConvertError(`Konvertierung fehlgeschlagen (Code ${res.status})`, 'failed');
  }
  return (await res.json()) as ConvertResponse;
}

async function downloadToCache(fileUrl: string, cacheDir: string, cachePath: string, deadline: number): Promise<void> {
  let res: Response;
  const { controller, clear } = deadlineController(deadline);
  try {
    res = await fetch(fileUrl, { signal: controller.signal });
  } catch {
    throw new ConvertError('Vorschau-Dienst nicht erreichbar', 'unavailable');
  } finally {
    clear();
  }
  if (!res.ok) {
    throw new ConvertError(`Konvertierung fehlgeschlagen (Code ${res.status})`, 'failed');
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  mkdirSync(cacheDir, { recursive: true });
  const tmp = join(cacheDir, `.tmp-${randomUUID()}`);
  try {
    writeFileSync(tmp, bytes);
    renameSync(tmp, cachePath);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** Reale OnlyOffice-/Euro-Office-Server melden Fehlschläge oft als {error: -N} OHNE endConvert:true. */
function checkError(result: ConvertResponse): void {
  if (result.error !== undefined && result.error !== null) {
    throw new ConvertError(`Konvertierung fehlgeschlagen (Code ${result.error})`, 'failed');
  }
}

async function convert(
  config: ConvertConfig,
  fileId: string,
  cacheKey: string,
  sourceName: string,
  sourceUrl: (fileId: string) => string,
  cacheDir: string,
  cachePath: string,
  pollIntervalMs: number,
  timeoutMs: number,
): Promise<string> {
  const start = Date.now();
  const deadline = start + timeoutMs;
  let result = await attemptConvert(config, fileId, cacheKey, sourceName, sourceUrl, deadline);
  checkError(result);
  while (!result.endConvert) {
    if (Date.now() - start > timeoutMs) {
      throw new ConvertError('Konvertierung dauert zu lange', 'failed');
    }
    await sleep(pollIntervalMs);
    result = await attemptConvert(config, fileId, cacheKey, sourceName, sourceUrl, deadline);
    checkError(result);
  }
  if (!result.fileUrl) {
    throw new ConvertError('Konvertierung fehlgeschlagen (keine fileUrl)', 'failed');
  }
  await downloadToCache(result.fileUrl, cacheDir, cachePath, deadline);
  return cachePath;
}

export function createConverter(deps: ConvertDeps): {
  enabled(): boolean;
  ensurePreview(fileId: string, cacheKey: string, sourceName: string): Promise<string>;
} {
  const { config, sourceUrl, dataDir } = deps;
  const pollIntervalMs = deps.pollIntervalMs ?? 500;
  const timeoutMs = deps.timeoutMs ?? 60_000;
  const inFlight = new Map<string, Promise<string>>();

  function enabled(): boolean {
    return config !== null;
  }

  function ensurePreview(fileId: string, cacheKey: string, sourceName: string): Promise<string> {
    if (!config) {
      return Promise.reject(new ConvertError('Vorschau-Dienst nicht konfiguriert', 'disabled'));
    }
    const safeKey = cacheKey.replace(/[^A-Za-z0-9._-]/g, '_');
    const cacheDir = join(dataDir, 'convcache');
    const cachePath = join(cacheDir, `${safeKey}.pdf`);
    if (existsSync(cachePath)) return Promise.resolve(cachePath);

    const existing = inFlight.get(cacheKey);
    if (existing) return existing;

    const promise = convert(config, fileId, cacheKey, sourceName, sourceUrl, cacheDir, cachePath, pollIntervalMs, timeoutMs).finally(
      () => inFlight.delete(cacheKey),
    );
    inFlight.set(cacheKey, promise);
    return promise;
  }

  return { enabled, ensurePreview };
}
