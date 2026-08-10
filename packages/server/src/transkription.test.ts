import { readFileSync } from 'node:fs';
import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import multipartPlugin from '@fastify/multipart';
import {
  transkribiere, registerTranskription, TranskriptionError,
  GROESSENKAPPE_BYTES, type TranskriptionConfig, type TranskriptionContext,
} from './transkription';

/**
 * Tests für transkription.ts (VOICE-01, 14-09): Fake-`fetch` als Anymize-Gegenstelle
 * (Muster packages/mcp/src/anymize.test.ts) für die Job-Logik, plus ein eigenständiger
 * Fastify-Testserver (nur `@fastify/multipart` registriert, kein voller buildApp()-Stack —
 * die Route ist absichtlich betriebsmodusunabhängig und braucht keine DB) für die Route selbst.
 */

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

const cfg = (overrides: Partial<TranskriptionConfig> = {}): TranskriptionConfig => ({
  apiUrl: 'https://anymize.test', apiKey: 'k-test', pollIntervalMs: 1, timeoutMs: 500, ...overrides,
});

function happyRoutes(zweiterSchluessel = false): Route {
  let polls = 0;
  return (url, init) => {
    if (url === 'https://anymize.test/api/transcribe' && init?.method === 'POST') {
      return json(202, { job_id: 'job_1' });
    }
    if (url === 'https://anymize.test/api/status/job_1') {
      polls += 1;
      if (polls < 2) return json(200, { status: 'processing' });
      return zweiterSchluessel
        ? json(200, { status: 'completed', transcribed_text_raw: 'Diktierter Text.' })
        : json(200, { status: 'completed', result: { text: 'Diktierter Text.' } });
    }
    return undefined;
  };
}

describe('transkribiere() — Job-Logik gegen die Fake-Gegenstelle', () => {
  it('Erfolgsweg: Job starten, pollen bis completed, result.text liefern', async () => {
    const r = await transkribiere(new Uint8Array([1, 2, 3]), 'audio/webm', 'a.webm', cfg(), fakeFetch(happyRoutes()));
    expect(r.text).toBe('Diktierter Text.');
  });

  it('liest den zweiten, direkt am Statusobjekt liegenden Textschlüssel, wenn result.text fehlt', async () => {
    const r = await transkribiere(new Uint8Array([1, 2, 3]), 'audio/webm', 'a.webm', cfg(), fakeFetch(happyRoutes(true)));
    expect(r.text).toBe('Diktierter Text.');
  });

  it('completed ohne irgendeinen Textschlüssel → fehlgeschlagen, kein leeres Transkript', async () => {
    const route = fakeFetch((url, init) => {
      if (init?.method === 'POST') return json(202, { job_id: 'j' });
      if (url.endsWith('/api/status/j')) return json(200, { status: 'completed' });
      return undefined;
    });
    await expect(transkribiere(new Uint8Array([1]), 'audio/webm', 'a.webm', cfg(), route))
      .rejects.toMatchObject({ kind: 'fehlgeschlagen' });
  });

  it("status 'failed' → fehlgeschlagen mit deutscher Meldung", async () => {
    const route = fakeFetch((url, init) => {
      if (init?.method === 'POST') return json(202, { job_id: 'j' });
      if (url.endsWith('/api/status/j')) return json(200, { status: 'failed' });
      return undefined;
    });
    const err = await transkribiere(new Uint8Array([1]), 'audio/webm', 'a.webm', cfg(), route).catch((e) => e as TranskriptionError);
    expect(err).toBeInstanceOf(TranskriptionError);
    expect(err.kind).toBe('fehlgeschlagen');
    expect(err.message).not.toBe('');
  });

  it('überschreitet die Wartefrist → zeitueberschreitung', async () => {
    const route = fakeFetch((url, init) => {
      if (init?.method === 'POST') return json(202, { job_id: 'j' });
      if (url.endsWith('/api/status/j')) return json(200, { status: 'processing' });
      return undefined;
    });
    await expect(transkribiere(new Uint8Array([1]), 'audio/webm', 'a.webm', cfg({ timeoutMs: 5 }), route))
      .rejects.toMatchObject({ kind: 'zeitueberschreitung' });
  });

  it('Netzwerkfehler → unerreichbar (nicht fehlgeschlagen)', async () => {
    const kaputt = (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch;
    await expect(transkribiere(new Uint8Array([1]), 'audio/webm', 'a.webm', cfg(), kaputt))
      .rejects.toMatchObject({ kind: 'unerreichbar' });
  });

  it('Nicht-OK-HTTP beim Start → unerreichbar (nicht fehlgeschlagen)', async () => {
    const route = fakeFetch(() => json(500, { error: 'kaputt' }));
    await expect(transkribiere(new Uint8Array([1]), 'audio/webm', 'a.webm', cfg(), route))
      .rejects.toMatchObject({ kind: 'unerreichbar' });
  });

  it('Nicht-OK-HTTP beim Poll → unerreichbar', async () => {
    const route = fakeFetch((url, init) => {
      if (init?.method === 'POST') return json(202, { job_id: 'j' });
      if (url.endsWith('/api/status/j')) return json(503, { error: 'kaputt' });
      return undefined;
    });
    await expect(transkribiere(new Uint8Array([1]), 'audio/webm', 'a.webm', cfg(), route))
      .rejects.toMatchObject({ kind: 'unerreichbar' });
  });

  it('sendet den Bearer-Header, den multipart-Feldnamen "file" und den erwarteten Pfad/Methode', async () => {
    const calls: { url: string; method?: string; auth?: string }[] = [];
    const route = fakeFetch((url, init) => {
      calls.push({ url, method: init?.method, auth: (init?.headers as Record<string, string> | undefined)?.authorization });
      if (init?.method === 'POST') return json(202, { job_id: 'j' });
      if (url.endsWith('/api/status/j')) return json(200, { status: 'completed', result: { text: 'x' } });
      return undefined;
    });
    await transkribiere(new Uint8Array([1]), 'audio/webm', 'a.webm', cfg({ apiKey: 'geheimer-schluessel' }), route);
    expect(calls[0]).toMatchObject({ url: 'https://anymize.test/api/transcribe', method: 'POST', auth: 'Bearer geheimer-schluessel' });
    expect(calls[1]).toMatchObject({ url: 'https://anymize.test/api/status/j', method: 'GET', auth: 'Bearer geheimer-schluessel' });
  });

  it('der konfigurierte Schlüsselwert kommt in keiner Antwort/Fehlermeldung vor (Gegenprobe)', async () => {
    const geheim = 'GEHEIM-1234567890';
    const r = await transkribiere(new Uint8Array([1]), 'audio/webm', 'a.webm', cfg({ apiKey: geheim }), fakeFetch(happyRoutes()));
    expect(JSON.stringify(r)).not.toContain(geheim);
    const err = await transkribiere(new Uint8Array([1]), 'audio/webm', 'a.webm', cfg({ apiKey: geheim }), fakeFetch(() => json(500, {})))
      .catch((e) => e as TranskriptionError);
    expect(err.message).not.toContain(geheim);
  });
});

describe('Netzwerk-/Ablage-Freiheit (Quellenassertionen, T-14-09-04)', () => {
  const quelle = readFileSync(new URL('./transkription.ts', import.meta.url), 'utf8');
  const ohneKommentare = quelle
    .split('\n')
    .filter((z) => !/^\s*(\/\/|\*|\/\*)/.test(z))
    .join('\n');

  it('kein Schreibpfad ins Dateisystem, kein Datenbankzugriff, kein Zwischenspeicher', () => {
    expect((ohneKommentare.match(/writeFile|createWriteStream|storeFile|db\.prepare/g) ?? [])).toHaveLength(0);
  });

  it('die Job-Kennung wird nie an den Client zurückgegeben oder protokolliert', () => {
    expect((ohneKommentare.match(/reply\.send\([^)]*job|return \{[^}]*job/g) ?? [])).toHaveLength(0);
  });
});

describe('registerTranskription — Route (eigenständiger Fastify-Testserver)', () => {
  function multipartBody(bytes: Buffer, filename = 'aufnahme.webm', mime = 'audio/webm') {
    const grenze = '----transktest';
    const kopf = Buffer.from(
      `--${grenze}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${mime}\r\n\r\n`,
    );
    const fuss = Buffer.from(`\r\n--${grenze}--\r\n`);
    return {
      payload: Buffer.concat([kopf, bytes, fuss]),
      headers: { 'content-type': `multipart/form-data; boundary=${grenze}` },
    };
  }

  async function testApp(ctx: TranskriptionContext) {
    const app = Fastify();
    await app.register(multipartPlugin, { limits: { fileSize: 100 * 1024 * 1024 } });
    registerTranskription(app, ctx);
    return app;
  }

  it('GET /api/v1/transkription: verfuegbar true/false je nach Konfiguration', async () => {
    const mitConfig = await testApp({ config: cfg() });
    expect((await mitConfig.inject({ method: 'GET', url: '/api/v1/transkription' })).json()).toEqual({ verfuegbar: true });
    await mitConfig.close();

    const ohneConfig = await testApp({ config: null });
    expect((await ohneConfig.inject({ method: 'GET', url: '/api/v1/transkription' })).json()).toEqual({ verfuegbar: false });
    await ohneConfig.close();
  });

  it('POST ohne Konfiguration: 503 "nicht eingerichtet", die Gegenstelle wird NIE gerufen', async () => {
    const fetchSpy = vi.fn();
    const app = await testApp({ config: null, fetchFn: fetchSpy as unknown as typeof fetch });
    const body = multipartBody(Buffer.from([1, 2, 3]));
    const res = await app.inject({ method: 'POST', url: '/api/v1/transkription', headers: body.headers, payload: body.payload });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toContain('nicht eingerichtet');
    expect(fetchSpy).not.toHaveBeenCalled();
    await app.close();
  });

  it('POST ohne Datei (gültiger multipart-Body ohne Dateifeld): 400, die Gegenstelle wird NIE gerufen', async () => {
    const fetchSpy = vi.fn();
    const app = await testApp({ config: cfg(), fetchFn: fetchSpy as unknown as typeof fetch });
    const grenze = '----ohnedatei';
    const payload = Buffer.from(
      `--${grenze}\r\nContent-Disposition: form-data; name="sonstwas"\r\n\r\nx\r\n--${grenze}--\r\n`,
    );
    const res = await app.inject({
      method: 'POST', url: '/api/v1/transkription',
      headers: { 'content-type': `multipart/form-data; boundary=${grenze}` }, payload,
    });
    expect(res.statusCode).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
    await app.close();
  });

  it('POST über der Größenkappe: 400, die Gegenstelle wird NIE gerufen (Prüfung VOR jedem Außenaufruf)', async () => {
    const fetchSpy = vi.fn();
    const app = await testApp({ config: cfg(), fetchFn: fetchSpy as unknown as typeof fetch });
    const body = multipartBody(Buffer.alloc(GROESSENKAPPE_BYTES + 1));
    const res = await app.inject({ method: 'POST', url: '/api/v1/transkription', headers: body.headers, payload: body.payload });
    expect(res.statusCode).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
    await app.close();
  });

  it('erfolgreicher Roundtrip: 200 { text } — AUSSCHLIESSLICH der Text, keine Job-Kennung', async () => {
    const app = await testApp({ config: cfg(), fetchFn: fakeFetch(happyRoutes()) });
    const body = multipartBody(Buffer.from([1, 2, 3]));
    const res = await app.inject({ method: 'POST', url: '/api/v1/transkription', headers: body.headers, payload: body.payload });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ text: 'Diktierter Text.' });
    expect(JSON.stringify(res.json())).not.toMatch(/job/i);
    await app.close();
  });

  it('Fehlerarten auf HTTP abgebildet: unerreichbar→502, fehlgeschlagen→502, zeitueberschreitung→504', async () => {
    const unerreichbar = await testApp({ config: cfg(), fetchFn: fakeFetch(() => json(500, {})) });
    let body = multipartBody(Buffer.from([1]));
    expect((await unerreichbar.inject({ method: 'POST', url: '/api/v1/transkription', headers: body.headers, payload: body.payload })).statusCode).toBe(502);
    await unerreichbar.close();

    const fehlgeschlagen = await testApp({
      config: cfg(),
      fetchFn: fakeFetch((url, init) => {
        if (init?.method === 'POST') return json(202, { job_id: 'j' });
        if (url.endsWith('/api/status/j')) return json(200, { status: 'failed' });
        return undefined;
      }),
    });
    body = multipartBody(Buffer.from([1]));
    expect((await fehlgeschlagen.inject({ method: 'POST', url: '/api/v1/transkription', headers: body.headers, payload: body.payload })).statusCode).toBe(502);
    await fehlgeschlagen.close();

    const zeitueberschreitung = await testApp({ config: cfg({ timeoutMs: 5 }), fetchFn: fakeFetch((url, init) => {
      if (init?.method === 'POST') return json(202, { job_id: 'j' });
      if (url.endsWith('/api/status/j')) return json(200, { status: 'processing' });
      return undefined;
    }) });
    body = multipartBody(Buffer.from([1]));
    expect((await zeitueberschreitung.inject({ method: 'POST', url: '/api/v1/transkription', headers: body.headers, payload: body.payload })).statusCode).toBe(504);
    await zeitueberschreitung.close();
  });

  it('der konfigurierte Schlüsselwert kommt im gesamten Antwortkörper NIE vor (Erfolg wie Fehler)', async () => {
    const geheim = 'ROUTEN-GEHEIMNIS-9876';
    const erfolg = await testApp({ config: cfg({ apiKey: geheim }), fetchFn: fakeFetch(happyRoutes()) });
    let body = multipartBody(Buffer.from([1]));
    let res = await erfolg.inject({ method: 'POST', url: '/api/v1/transkription', headers: body.headers, payload: body.payload });
    expect(res.body).not.toContain(geheim);
    await erfolg.close();

    const fehler = await testApp({ config: cfg({ apiKey: geheim }), fetchFn: fakeFetch(() => json(500, {})) });
    body = multipartBody(Buffer.from([1]));
    res = await fehler.inject({ method: 'POST', url: '/api/v1/transkription', headers: body.headers, payload: body.payload });
    expect(res.body).not.toContain(geheim);
    await fehler.close();
  });
});
