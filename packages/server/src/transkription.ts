import type { FastifyInstance } from 'fastify';

/**
 * Anymize-Transkription (VOICE-01, 14-09): ersetzt die Cloud-Spracherkennung des Browsers
 * (bislang `src/lib/diktat.ts`, Web Speech API) durch Aufnahme-mit-anschließender-Transkription
 * über Anymize — vermittelt durch DIESE Route, damit der API-Schlüssel den Browser nie erreicht
 * (T-14-09-02) und die Anymize-Job-Kennung den Server nie verlässt (T-14-09-03: das Warten läuft
 * vollständig serverintern innerhalb derselben Anfrage).
 *
 * Aufbau wortgleich zur `job()`-Methode des Bestandsclients `packages/mcp/src/anymize.ts`: Job
 * starten, dann Status abfragen bis `completed`, `failed`/Wartefrist getrennt behandelt,
 * injizierbares `fetch` für Tests. Eingabeprüfung VOR jedem Außenaufruf nach dem Muster
 * `packages/server/src/aufnahme.ts` (Größenkappe schützt nur, wenn sie VOR dem Aufruf greift).
 * Konfigurationsdisziplin wie `packages/server/src/diagnosepaket.ts`: dieses Modul liest
 * `process.env` an KEINER Stelle selbst — `main.ts` ist die einzige Stelle, die den Rohwert
 * liest und als Wert weiterreicht.
 *
 * Legt die Aufnahme NIRGENDS ab: kein Dateisystem-Schreibpfad, kein Datenbankzugriff, kein
 * Zwischenspeicher — die Bytes leben nur im Arbeitsspeicher dieser einen Anfrage (T-14-09-04,
 * Quellenassertion in transkription.test.ts).
 *
 * ENDPUNKT-VERIFIKATION: am 2026-08-10 mit synthetischem Test-Audio (1 s Sinuston, keine
 * Inhalte) gegen den echten Dienst geprüft. Belegtes Ergebnis:
 *   - Start: `POST https://app.anymize.ai/api/transcribe`, multipart-Feld `file` + `language`
 *     → **HTTP 202** mit `{ job_id, status: 'processing', message: '… Use /api/status/{job_id} …' }`.
 *     202 statt 200 ist der Normalfall und wird von der `res.ok`-Prüfung unten mit abgedeckt.
 *   - Status: `GET https://app.anymize.ai/api/status/{jobId}` → `{ job_id, status }`, pollt bis
 *     `completed`.
 *   - Die in der Anbieter-Dokumentation genannte Basis `…/api/v1/llm` trägt für die Transkription
 *     NICHT: sowohl `/api/v1/llm/api/transcribe` als auch `/api/v1/llm/transcribe` antworten mit
 *     HTTP 404 „Server action not found". Die hier implementierte Lesart (Basis ohne `/api/v1/llm`,
 *     konsistent mit `AnymizeClient` im MCP-Paket) ist die tragende.
 * NICHT verifiziert blieb die Form des Ergebnisfeldes im `completed`-Status: der Probelauf stand
 * nach 12 s noch auf `processing`. Deshalb liest der Code weiterhin `result.text` UND den zweiten
 * Schlüssel `transcribed_text_raw` (Analogie zu `anonymized_text_raw` im Bestandsclient) — diese
 * Verzweigung bleibt eine Annahme und ist im Abnahmepunkt „Endpunkt-Vertrag" als Restpunkt geführt.
 * Der Fake-Backend-Test unten schreibt die Lesart fest.
 */

export type TranskriptionFehlerArt = 'nicht_eingerichtet' | 'unerreichbar' | 'fehlgeschlagen' | 'zeitueberschreitung' | 'zu_gross';

export class TranskriptionError extends Error {
  constructor(message: string, readonly kind: TranskriptionFehlerArt) {
    super(message);
  }
}

export interface TranskriptionConfig {
  apiUrl: string;
  apiKey: string;
  /** Nur für Tests — Standard 2000 ms (wie packages/mcp/src/anymize.ts). */
  pollIntervalMs?: number;
  /** Nur für Tests — Standard 180000 ms (deckt die 300-s-Höchstdauer der Aufnahme mit Reserve). */
  timeoutMs?: number;
}

/** Größenkappe der Aufnahme: großzügig gegenüber ~240 KB/min eines Opus-Streams (die
 *  zulässigen 300 s Höchstdauer ergeben ~1,2 MB), aber weit unter der globalen 100-MiB-
 *  Multipart-Kappe aus app.ts — DIESE Kappe ist die wirksame, weil sie VOR jedem Außenaufruf
 *  greift (die globale Kappe hätte die Aufnahme bereits vollständig übertragen). */
export const GROESSENKAPPE_BYTES = 25 * 1024 * 1024;
const ABFRAGE_INTERVALL_MS = 2000;
const WARTEFRIST_MS = 180000;

const schlafe = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface StartAntwort {
  job_id?: unknown;
}
interface StatusAntwort {
  status?: unknown;
  result?: { text?: unknown };
  // Zweiter Textschlüssel direkt am Statusobjekt (unverifizierte Annahme, s. Kopfkommentar).
  transcribed_text_raw?: unknown;
}

/**
 * Job starten, Status abfragen bis `completed`. Die Job-Kennung bleibt AUSSCHLIESSLICH lokal in
 * dieser Funktion (T-14-09-03) — sie wird weder zurückgegeben noch protokolliert.
 */
export async function transkribiere(
  bytes: Uint8Array,
  mime: string,
  filename: string,
  cfg: TranskriptionConfig,
  fetchFn: typeof fetch = fetch,
): Promise<{ text: string }> {
  const poll = cfg.pollIntervalMs ?? ABFRAGE_INTERVALL_MS;
  const timeout = cfg.timeoutMs ?? WARTEFRIST_MS;

  async function call(path: string, init: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await fetchFn(`${cfg.apiUrl}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${cfg.apiKey}`, ...(init.headers ?? {}) },
      });
    } catch {
      throw new TranskriptionError('Transkription nicht erreichbar', 'unerreichbar');
    }
    return res;
  }

  async function json<T>(res: Response): Promise<T> {
    try {
      return (await res.json()) as T;
    } catch {
      throw new TranskriptionError('Transkription nicht erreichbar — unerwartete Antwort', 'unerreichbar');
    }
  }

  const form = new FormData();
  form.append('file', new Blob([bytes], { type: mime }), filename);
  form.append('language', 'de');
  const start = await call('/api/transcribe', { method: 'POST', body: form });
  if (!start.ok) throw new TranskriptionError(`Transkription nicht erreichbar (HTTP ${start.status})`, 'unerreichbar');
  const startBody = await json<StartAntwort>(start);
  const jobId = typeof startBody.job_id === 'string' ? startBody.job_id : undefined;
  if (!jobId) throw new TranskriptionError('Transkription nicht erreichbar — unerwartete Antwort', 'unerreichbar');

  const frist = Date.now() + timeout;
  for (;;) {
    if (Date.now() > frist) throw new TranskriptionError('Transkription dauert zu lange (Zeitüberschreitung)', 'zeitueberschreitung');
    const res = await call(`/api/status/${jobId}`, { method: 'GET' });
    if (!res.ok) throw new TranskriptionError(`Transkription nicht erreichbar (HTTP ${res.status})`, 'unerreichbar');
    const status = await json<StatusAntwort>(res);
    if (status.status === 'failed') throw new TranskriptionError('Transkription fehlgeschlagen', 'fehlgeschlagen');
    if (status.status === 'completed') {
      const text = typeof status.result?.text === 'string'
        ? status.result.text
        : typeof status.transcribed_text_raw === 'string'
          ? status.transcribed_text_raw
          : undefined;
      // Fehlt der Text trotz completed, ist das ein Fehlschlag, kein leeres Transkript
      // (T-14-09-06 — sonst sähe ein stiller Fehlweg wie ein leergesprochenes Diktat aus).
      if (text === undefined) throw new TranskriptionError('Transkription fehlgeschlagen — Antwort ohne Ergebnis', 'fehlgeschlagen');
      return { text };
    }
    await schlafe(poll);
  }
}

export interface TranskriptionContext {
  /** null/fehlend = keine Konfiguration (main.ts: fehlender Schlüssel ist KEIN Startfehler). */
  config: TranskriptionConfig | null;
  /** Nur für Tests — Standard: globales fetch. */
  fetchFn?: typeof fetch;
}

const STATUS_FUER_FEHLERART: Record<TranskriptionFehlerArt, number> = {
  nicht_eingerichtet: 503,
  unerreichbar: 502,
  fehlgeschlagen: 502,
  zeitueberschreitung: 504,
  zu_gross: 400,
};

/**
 * Registriert `GET /api/v1/transkription` (Verfügbarkeit) und `POST /api/v1/transkription`
 * (Aufnahme → Text) — beide hinter dem bestehenden Auth-Hook (app.ts registriert diese Route in
 * den modusunabhängigen Registrierungen, NICHT in PUBLIC_PATHS). Reihenfolge in der POST-Route,
 * ohne Ausnahme: Konfiguration vorhanden? → Datei vorhanden? → Größe unter der Kappe? → erst
 * dann Außenaufruf (aufnahme.ts-Muster).
 */
export function registerTranskription(app: FastifyInstance, ctx: TranskriptionContext): void {
  app.get('/api/v1/transkription', async () => ({ verfuegbar: ctx.config !== null }));

  app.post('/api/v1/transkription', async (req, reply) => {
    if (!ctx.config) return reply.code(503).send({ error: 'Transkription nicht eingerichtet' });
    const part = await req.file();
    if (!part) return reply.code(400).send({ error: 'Keine Aufnahme im Request' });
    const bytes = await part.toBuffer();
    if (bytes.byteLength > GROESSENKAPPE_BYTES) {
      return reply.code(400).send({ error: `Aufnahme zu groß (max. ${GROESSENKAPPE_BYTES / (1024 * 1024)} MiB)` });
    }
    try {
      const { text } = await transkribiere(new Uint8Array(bytes), part.mimetype, part.filename, ctx.config, ctx.fetchFn);
      return { text };
    } catch (e) {
      if (e instanceof TranskriptionError) {
        return reply.code(STATUS_FUER_FEHLERART[e.kind]).send({ error: e.message });
      }
      throw e;
    }
  });
}
