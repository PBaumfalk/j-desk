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

  private async json<T>(res: Response): Promise<T> {
    try {
      return (await res.json()) as T;
    } catch {
      throw new AnymizeError('Anonymisierung nicht verfügbar — unerwartete Antwort von anymize', 'unavailable');
    }
  }

  private async job(path: string, init: RequestInit): Promise<{ text: string; pairs: HashPair[] }> {
    const start = await this.call(path, init);
    if (!start.ok) throw new AnymizeError(`Anonymisierung nicht verfügbar (anymize HTTP ${start.status})`, 'unavailable');
    const { job_id: jobId } = await this.json<{ job_id: string }>(start);

    const frist = Date.now() + this.timeout;
    let result: { text: string; entities_found?: number } | undefined;
    for (;;) {
      if (Date.now() > frist) throw new AnymizeError('Anonymisierung dauert zu lange (Timeout)', 'timeout');
      const res = await this.call(`/api/status/${jobId}`, { method: 'GET' });
      if (!res.ok) throw new AnymizeError(`Anonymisierung nicht verfügbar (anymize HTTP ${res.status})`, 'unavailable');
      const status = await this.json<{
        status: string;
        result?: { text: string; entities_found?: number };
        // Reales API-Format (live verifiziert 2026-07-19): Text liegt direkt am Status-Objekt.
        anonymized_text_raw?: string;
      }>(res);
      if (status.status === 'failed') throw new AnymizeError('Anonymisierung fehlgeschlagen (anymize-Job failed)', 'failed');
      if (status.status === 'completed') {
        const text = status.result?.text ?? status.anonymized_text_raw;
        if (text === undefined) {
          throw new AnymizeError('Anonymisierung fehlgeschlagen (anymize-Antwort ohne Ergebnis)', 'failed');
        }
        result = { text, ...(status.result?.entities_found !== undefined ? { entities_found: status.result.entities_found } : {}) };
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
    const body = await this.json<{ hash_pairs: { original: string; hash: string; placeholder?: string }[] }>(strings);
    // Real liefert anymize den vollen Platzhalter ([[person-XYZ]]) im Feld placeholder —
    // nur damit findet die Deanonymisierung die Vorkommen im Text (hash allein wäre "XYZ").
    const pairs: HashPair[] = (body.hash_pairs ?? []).map((p) => ({ original: p.original, placeholder: p.placeholder ?? p.hash }));
    if (pairs.length === 0 && ((result.entities_found ?? 0) > 0 || result.text.includes('[['))) {
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
