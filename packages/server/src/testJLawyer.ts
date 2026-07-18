import { createServer, type Server } from 'node:http';

/**
 * Fake-j-lawyer für Tests und E2E-Läufe: Basic Auth und die von uns benutzten
 * Endpunkte, mit dem Feldschema aus dem j-lawyer-Quellcode (RestfulCaseOverviewV1,
 * RestfulDocumentV1, RestfulDocumentContentV1 — verifiziert 2026-07-18).
 */
export interface FakeJLawyer {
  server: Server;
  url: string;
  /** Mutierbarer Zustand — Tests können Dokumente hinzufügen/entfernen. */
  cases: { id: string; name: string; fileNumber: string; reason: string }[];
  documents: Map<string, { id: string; caseId: string; name: string; changeDate: number; size: number; bytes: Buffer }[]>;
  requests: string[];
  stop(): Promise<void>;
}

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 298 420]>>endobj\ntrailer<</Size 4/Root 1 0 R>>\n%%EOF\n');

export function startFakeJLawyer(user = 'anwalt', pass = 'kanzlei123'): Promise<FakeJLawyer> {
  const ok = 'Basic ' + Buffer.from(`${user}:${pass}`, 'utf8').toString('base64');
  const cases = [
    { id: 'akte-1', name: 'Müller ./. Schmidt', fileNumber: '00001/26', reason: 'Kaufpreisklage' },
    { id: 'akte-2', name: 'Meier', fileNumber: '00002/26', reason: 'Verkehrsunfall' },
  ];
  const documents = new Map<string, { id: string; caseId: string; name: string; changeDate: number; size: number; bytes: Buffer }[]>([
    ['akte-1', [
      { id: 'jdoc-1', caseId: 'akte-1', name: 'Klageschrift.pdf', changeDate: 1750000000000, size: PDF.length, bytes: PDF },
      { id: 'jdoc-2', caseId: 'akte-1', name: 'Kaufvertrag.pdf', changeDate: 1750000100000, size: PDF.length, bytes: PDF },
    ]],
    ['akte-2', []],
  ]);
  const requests: string[] = [];
  let nextId = 100;

  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.headers.authorization !== ok) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="jlawyerRealm"' });
      return res.end();
    }
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const url = req.url ?? '';
    if (url === '/j-lawyer-io/v1/cases/list') {
      return json(200, cases.map((c) => ({ ...c, externalId: null, dateChanged: 1750000000000 })));
    }
    let m = url.match(/^\/j-lawyer-io\/v1\/cases\/([^/]+)\/documents$/);
    if (m) {
      const docs = documents.get(decodeURIComponent(m[1]));
      if (!docs) return json(500, {});
      return json(200, docs.map(({ bytes, ...rest }) => ({ ...rest, externalId: null, creationDate: rest.changeDate, favorite: false, tags: [] })));
    }
    m = url.match(/^\/j-lawyer-io\/v1\/cases\/document\/([^/]+)\/content$/);
    if (m) {
      const docId = decodeURIComponent(m[1]);
      for (const docs of documents.values()) {
        const d = docs.find((x) => x.id === docId);
        if (d) return json(200, { id: d.id, externalId: null, caseId: d.caseId, fileName: d.name, base64content: d.bytes.toString('base64') });
      }
      return json(500, {});
    }
    m = url.match(/^\/j-lawyer-io\/v1\/cases\/document\/([^/]+)$/);
    if (m && req.method === 'GET') {
      const docId = decodeURIComponent(m[1]);
      for (const docs of documents.values()) {
        const d = docs.find((x) => x.id === docId);
        if (d) return json(200, { id: d.id, caseId: d.caseId, externalId: null, name: d.name, changeDate: d.changeDate, creationDate: d.changeDate, size: d.size, favorite: false, tags: [] });
      }
      return json(500, {});
    }
    if (url === '/j-lawyer-io/v1/cases/document/create' && req.method === 'PUT') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const p = JSON.parse(body) as { caseId: string; fileName: string; base64content: string };
        const docs = documents.get(p.caseId);
        if (!docs) return json(500, {});
        const bytes = Buffer.from(p.base64content, 'base64');
        const doc = { id: `jdoc-${nextId++}`, caseId: p.caseId, name: p.fileName, changeDate: Date.now(), size: bytes.length, bytes };
        docs.push(doc);
        return json(200, { id: doc.id, externalId: null, caseId: doc.caseId, fileName: doc.name, base64content: p.base64content });
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      resolve({
        server,
        url: `http://127.0.0.1:${port}/j-lawyer-io`,
        cases,
        documents,
        requests,
        stop: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
