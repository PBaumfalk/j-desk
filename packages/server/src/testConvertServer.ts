import { createServer, type Server } from 'node:http';
import { createHmac } from 'node:crypto';

/**
 * Fake-DocumentServer (Euro-Office/OnlyOffice-kompatibel) für Tests: nimmt POSTs auf
 * /ConvertService.ashx an, verifiziert die JWT-Signatur des `token`-Felds gegen das
 * Test-Secret (Fehlsignatur -> 403), antwortet konfigurierbar (sofort fertig / erst nach
 * N Polls fertig / Fehlercode) und stellt GET /result.pdf mit Mini-PDF-Bytes bereit.
 * Ruft die übergebene Quell-URL beim ersten Request pro Konvertierungs-Key selbst ab
 * (Ticket-Weg end-to-end).
 */
export interface FakeConvertServer {
  server: Server;
  url: string;
  secret: string;
  /** Rohe Request-Zeilen (Methode + Pfad), wie bei testJLawyer. */
  requests: string[];
  /** Ein Eintrag je angenommenem POST /ConvertService.ashx, mit dem verwendeten key. */
  convertCalls: string[];
  /** Quell-URLs, die der Fake tatsächlich selbst abgerufen hat. */
  fetchedSourceUrls: string[];
  /** Verhalten für einen bestimmten cacheKey festlegen (vor dem jeweiligen Aufruf). */
  configure(
    key: string,
    opts: {
      pollsUntilDone?: number;
      errorCode?: string;
      /** Fehlercode ohne endConvert:true melden (reale OnlyOffice-/Euro-Office-Server tun das). */
      errorWithoutEndConvert?: boolean;
      /** Request annehmen, aber nie antworten (simuliert einen hängenden DS). */
      hang?: boolean;
    },
  ): void;
  stop(): Promise<void>;
}

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 298 420]>>endobj\ntrailer<</Size 4/Root 1 0 R>>\n%%EOF\n');

export function startFakeConvertServer(secret = 'test-convert-secret'): Promise<FakeConvertServer> {
  const requests: string[] = [];
  const convertCalls: string[] = [];
  const fetchedSourceUrls: string[] = [];
  const configs = new Map<
    string,
    { pollsUntilDone: number; errorCode?: string; errorWithoutEndConvert?: boolean; hang?: boolean }
  >();
  const pollCounts = new Map<string, number>();
  const fetchedKeys = new Set<string>();
  let baseUrl = '';

  function verifyToken(token: unknown): boolean {
    if (typeof token !== 'string') return false;
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const [header, payload, sig] = parts;
    const expected = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
    return expected === sig;
  }

  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    const url = req.url ?? '';
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (req.method === 'POST' && url === '/ConvertService.ashx') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', async () => {
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(raw);
        } catch {
          return json(400, { error: 'bad json' });
        }
        const key = String(body.key ?? '');
        convertCalls.push(key);
        if (!verifyToken(body.token)) {
          return json(403, { error: 'invalid signature' });
        }
        if (!fetchedKeys.has(key)) {
          fetchedKeys.add(key);
          try {
            const sourceRes = await fetch(String(body.url));
            await sourceRes.arrayBuffer();
            fetchedSourceUrls.push(String(body.url));
          } catch {
            // Quelle nicht erreichbar -> ignorieren, Konvertierung läuft im Fake trotzdem fiktiv weiter
          }
        }
        const cfg = configs.get(key) ?? { pollsUntilDone: 0 };
        if (cfg.hang) {
          // Nie antworten: simuliert einen hängenden DocumentServer.
          return;
        }
        if (cfg.errorCode) {
          return json(200, { endConvert: !cfg.errorWithoutEndConvert, percent: 100, error: cfg.errorCode });
        }
        const count = (pollCounts.get(key) ?? 0) + 1;
        pollCounts.set(key, count);
        if (count <= cfg.pollsUntilDone) {
          return json(200, { endConvert: false, percent: Math.round((count / (cfg.pollsUntilDone + 1)) * 100) });
        }
        return json(200, { endConvert: true, percent: 100, fileUrl: `${baseUrl}/result.pdf` });
      });
      return;
    }

    if (req.method === 'GET' && url === '/result.pdf') {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      return res.end(PDF);
    }

    res.writeHead(404);
    res.end();
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      baseUrl = `http://127.0.0.1:${port}`;
      resolve({
        server,
        url: baseUrl,
        secret,
        requests,
        convertCalls,
        fetchedSourceUrls,
        configure(key, opts) {
          configs.set(key, {
            pollsUntilDone: opts.pollsUntilDone ?? 0,
            errorCode: opts.errorCode,
            errorWithoutEndConvert: opts.errorWithoutEndConvert,
            hang: opts.hang,
          });
        },
        stop: () =>
          new Promise<void>((r) => {
            // closeAllConnections: hängende (nie beantwortete) Requests dürfen den Server-Shutdown
            // in Tests nicht blockieren.
            server.closeAllConnections();
            server.close(() => r());
          }),
      });
    });
  });
}
