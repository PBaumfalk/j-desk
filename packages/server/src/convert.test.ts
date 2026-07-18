import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConverter, ConvertError } from './convert';
import { startFakeConvertServer, type FakeConvertServer } from './testConvertServer';

/** Mini-Quellserver: liefert an jeder Route feste Bytes, zeichnet abgerufene Pfade auf. */
function startSourceServer(bytes: Buffer): Promise<{ url: string; requests: string[]; server: Server; stop: () => Promise<void> }> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(bytes);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${port}`, requests, server, stop: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

const SOURCE_BYTES = Buffer.from('fake-office-document-bytes');

let fake: FakeConvertServer;
let source: Awaited<ReturnType<typeof startSourceServer>>;
let dataDir: string;

beforeEach(async () => {
  fake = await startFakeConvertServer();
  source = await startSourceServer(SOURCE_BYTES);
  dataDir = mkdtempSync(join(tmpdir(), 'dd-conv-'));
});

afterEach(async () => {
  await fake.stop();
  await source.stop();
});

function makeConverter(overrides: Partial<{ secret: string; pollIntervalMs: number; timeoutMs: number }> = {}) {
  return createConverter({
    config: { url: fake.url, jwtSecret: overrides.secret ?? fake.secret },
    sourceUrl: (fileId) => `${source.url}/${fileId}`,
    dataDir,
    pollIntervalMs: overrides.pollIntervalMs ?? 5,
    timeoutMs: overrides.timeoutMs ?? 2000,
  });
}

describe('Euro-Office-Konvertierung (convert.ts)', () => {
  it('konvertiert beim ersten Aufruf, cacht danach (kein zweiter DS-Kontakt)', async () => {
    const conv = makeConverter();
    const path = await conv.ensurePreview('f1', 'cache-1', 'Vertrag.docx');
    expect(readFileSync(path).subarray(0, 5).toString()).toBe('%PDF-');
    const callsAfterFirst = fake.convertCalls.filter((k) => k === 'cache-1').length;
    expect(callsAfterFirst).toBe(1);

    const path2 = await conv.ensurePreview('f1', 'cache-1', 'Vertrag.docx');
    expect(path2).toBe(path);
    expect(fake.convertCalls.filter((k) => k === 'cache-1').length).toBe(callsAfterFirst); // kein zweiter DS-Kontakt
  });

  it('dedupliziert parallele ensurePreview-Aufrufe (ein DS-Request)', async () => {
    fake.configure('cache-2', { pollsUntilDone: 1 });
    const conv = makeConverter();
    const [p1, p2] = await Promise.all([
      conv.ensurePreview('f2', 'cache-2', 'Bericht.odt'),
      conv.ensurePreview('f2', 'cache-2', 'Bericht.odt'),
    ]);
    expect(p1).toBe(p2);
    // eine einzelne Konvertierung mit pollsUntilDone=1 braucht genau 2 Requests (1 Poll + 1 fertig);
    // bei fehlender Deduplizierung wären es doppelt so viele.
    expect(fake.convertCalls.filter((k) => k === 'cache-2').length).toBe(2);
  });

  it('pollt bei async-Antworten bis endConvert', async () => {
    fake.configure('cache-3', { pollsUntilDone: 2 });
    const conv = makeConverter();
    const path = await conv.ensurePreview('f3', 'cache-3', 'Tabelle.xlsx');
    expect(readFileSync(path).subarray(0, 5).toString()).toBe('%PDF-');
    expect(fake.convertCalls.filter((k) => k === 'cache-3').length).toBe(3); // 2 Polls + 1 fertig
  });

  it('signiert mit JWT; der Fake lehnt falsche Signatur ab -> failed', async () => {
    const conv = makeConverter({ secret: 'falsches-secret' });
    await expect(conv.ensurePreview('f4', 'cache-4', 'Brief.rtf')).rejects.toMatchObject({ reason: 'failed' });
  });

  it('deaktiviert (config null) wirft ConvertError disabled', async () => {
    const conv = createConverter({ config: null, sourceUrl: (id) => `${source.url}/${id}`, dataDir });
    expect(conv.enabled()).toBe(false);
    await expect(conv.ensurePreview('f5', 'cache-5', 'Text.txt')).rejects.toMatchObject({ reason: 'disabled' });
    await expect(conv.ensurePreview('f5', 'cache-5', 'Text.txt')).rejects.toBeInstanceOf(ConvertError);
  });

  it('DS nicht erreichbar wirft unavailable', async () => {
    const conv = createConverter({
      config: { url: 'http://127.0.0.1:1', jwtSecret: 'x' },
      sourceUrl: (id) => `${source.url}/${id}`,
      dataDir,
      pollIntervalMs: 5,
      timeoutMs: 500,
    });
    await expect(conv.ensurePreview('f6', 'cache-6', 'Text.txt')).rejects.toMatchObject({ reason: 'unavailable' });
  });

  it('lädt die Quelle über die übergebene sourceUrl (Fake hat sie abgerufen)', async () => {
    const conv = makeConverter();
    await conv.ensurePreview('f7', 'cache-7', 'Angebot.pptx');
    const expectedUrl = `${source.url}/f7`;
    expect(fake.fetchedSourceUrls).toContain(expectedUrl);
    expect(source.requests.some((r) => r.includes('/f7'))).toBe(true);
  });
});
