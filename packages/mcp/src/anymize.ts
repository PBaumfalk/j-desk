export class AnymizeError extends Error {
  constructor(message: string, readonly kind: 'unavailable' | 'failed' | 'timeout' | 'zdr') {
    super(message);
  }
}

export interface HashPair {
  original: string;
  placeholder: string;
}

interface AnymizeCfg {
  apiUrl: string;
  apiKey: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

const schlafe = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class AnymizeClient {
  private readonly poll: number;
  private readonly timeout: number;

  constructor(private readonly cfg: AnymizeCfg, private readonly fetchFn: typeof fetch = fetch) {
    this.poll = cfg.pollIntervalMs ?? 2000;
    this.timeout = cfg.timeoutMs ?? 120000;
  }

  private async call(path: string, init: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.cfg.apiUrl}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${this.cfg.apiKey}`, ...(init.headers ?? {}) },
      });
    } catch {
      throw new AnymizeError('Anonymisierung nicht verfügbar — anymize ist nicht erreichbar', 'unavailable');
    }
    return res;
  }

  private async job(path: string, init: RequestInit): Promise<{ text: string; pairs: HashPair[] }> {
    const start = await this.call(path, init);
    if (!start.ok) throw new AnymizeError(`Anonymisierung nicht verfügbar (anymize HTTP ${start.status})`, 'unavailable');
    const { job_id: jobId } = (await start.json()) as { job_id: string };

    const frist = Date.now() + this.timeout;
    let result: { text: string; entities_found?: number } | undefined;
    for (;;) {
      if (Date.now() > frist) throw new AnymizeError('Anonymisierung dauert zu lange (Timeout)', 'timeout');
      const res = await this.call(`/api/status/${jobId}`, { method: 'GET' });
      if (!res.ok) throw new AnymizeError(`Anonymisierung nicht verfügbar (anymize HTTP ${res.status})`, 'unavailable');
      const status = (await res.json()) as { status: string; result?: { text: string; entities_found?: number } };
      if (status.status === 'failed') throw new AnymizeError('Anonymisierung fehlgeschlagen (anymize-Job failed)', 'failed');
      if (status.status === 'completed' && status.result) {
        result = status.result;
        break;
      }
      await schlafe(this.poll);
    }

    const strings = await this.call(`/api/status/${jobId}/strings`, { method: 'GET' });
    if (!strings.ok) {
      throw new AnymizeError(
        'De-Anonymisierung nicht verfügbar — vermutlich ist Zero Data Retention im anymize-Account aktiv',
        'zdr',
      );
    }
    const body = (await strings.json()) as { hash_pairs: { original: string; hash: string }[] };
    const pairs: HashPair[] = (body.hash_pairs ?? []).map((p) => ({ original: p.original, placeholder: p.hash }));
    if (pairs.length === 0 && (result.entities_found ?? 0) > 0) {
      throw new AnymizeError(
        'De-Anonymisierung nicht verfügbar — vermutlich ist Zero Data Retention im anymize-Account aktiv',
        'zdr',
      );
    }
    return { text: result.text, pairs };
  }

  anonymizeText(text: string): Promise<{ text: string; pairs: HashPair[] }> {
    return this.job('/api/anonymize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, language: 'de' }),
    });
  }

  anonymizeFile(bytes: Uint8Array, filename: string): Promise<{ text: string; pairs: HashPair[] }> {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'application/pdf' }), filename);
    form.append('language', 'de');
    return this.job('/api/ocr', { method: 'POST', body: form });
  }
}
