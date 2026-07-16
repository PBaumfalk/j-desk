import { describe, it, expect } from 'vitest';
import { AnymizeClient, AnymizeError } from './anymize';

type Route = (url: string, init?: RequestInit) => Response | undefined;
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function fakeFetch(route: Route): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const res = route(url, init);
    if (!res) throw new Error(`Unerwarteter Aufruf: ${url}`);
    return res;
  }) as typeof fetch;
}

const cfg = { apiUrl: 'https://anymize.test', apiKey: 'k', pollIntervalMs: 1, timeoutMs: 500 };

function happyRoutes(erwarteterPfad: string): Route {
  let polls = 0;
  return (url, init) => {
    if (url === `https://anymize.test${erwarteterPfad}` && init?.method === 'POST') {
      return json(202, { job_id: 'job_1', status: 'processing' });
    }
    if (url === 'https://anymize.test/api/status/job_1') {
      polls += 1;
      return polls < 2
        ? json(200, { job_id: 'job_1', status: 'processing', progress: 50 })
        : json(200, { job_id: 'job_1', status: 'completed', result: { text: 'Hallo [[Person-AB12]]', entities_found: 1 } });
    }
    if (url === 'https://anymize.test/api/status/job_1/strings') {
      return json(200, { job_id: 'job_1', hash_pairs: [{ original: 'Max Mustermann', hash: '[[Person-AB12]]', prefix_name: 'Person', placeholder: 'Person-AB12' }], total: 1 });
    }
    return undefined;
  };
}

describe('AnymizeClient', () => {
  it('anonymizeText: Job anlegen, pollen, Text + Mapping liefern', async () => {
    const client = new AnymizeClient(cfg, fakeFetch(happyRoutes('/api/anonymize')));
    const r = await client.anonymizeText('Hallo Max Mustermann');
    expect(r.text).toBe('Hallo [[Person-AB12]]');
    expect(r.pairs).toEqual([{ original: 'Max Mustermann', placeholder: '[[Person-AB12]]' }]);
  });

  it('anonymizeFile: multipart an /api/ocr, gleicher Ablauf', async () => {
    const client = new AnymizeClient(cfg, fakeFetch(happyRoutes('/api/ocr')));
    const r = await client.anonymizeFile(new Uint8Array([1, 2, 3]), 'a.pdf');
    expect(r.text).toContain('[[Person-AB12]]');
  });

  it('Netzwerkfehler → unavailable; Job failed → failed; Timeout → timeout', async () => {
    const kaputt = new AnymizeClient(cfg, (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch);
    await expect(kaputt.anonymizeText('x')).rejects.toMatchObject({ kind: 'unavailable' });

    const failed = new AnymizeClient(cfg, fakeFetch((url, init) =>
      init?.method === 'POST' ? json(202, { job_id: 'j', status: 'processing' })
      : url.endsWith('/api/status/j') ? json(200, { job_id: 'j', status: 'failed' }) : undefined));
    await expect(failed.anonymizeText('x')).rejects.toMatchObject({ kind: 'failed' });

    const ewig = new AnymizeClient({ ...cfg, timeoutMs: 5 }, fakeFetch((url, init) =>
      init?.method === 'POST' ? json(202, { job_id: 'j', status: 'processing' })
      : url.endsWith('/api/status/j') ? json(200, { job_id: 'j', status: 'processing' }) : undefined));
    await expect(ewig.anonymizeText('x')).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('strings 403 oder leer trotz Entities → zdr', async () => {
    const zdr = new AnymizeClient(cfg, fakeFetch((url, init) => {
      if (init?.method === 'POST') return json(202, { job_id: 'j', status: 'processing' });
      if (url.endsWith('/api/status/j')) return json(200, { job_id: 'j', status: 'completed', result: { text: '[[Person-X1]]', entities_found: 1 } });
      if (url.endsWith('/strings')) return json(403, { error: { message: 'ZDR enabled' } });
      return undefined;
    }));
    await expect(zdr.anonymizeText('x')).rejects.toMatchObject({ kind: 'zdr' });
  });
});
