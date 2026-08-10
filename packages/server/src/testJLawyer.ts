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
  cases: { id: string; name: string; fileNumber: string; reason: string; archived?: number }[];
  documents: Map<string, { id: string; caseId: string; name: string; changeDate: number; size: number; bytes: Buffer }[]>;
  requests: string[];
  /** Erzwingt für die Dokument-Routen (meta/content) einer bestimmten docId eine bestimmte
   *  Antwort — für Fehlerklassen-Tests (403/404). 'destroy' kappt die Verbindung sofort
   *  (Netzfehler-Simulation ohne Timeout-Wartezeit, statt echt 10s auf einen Timeout zu warten). */
  forceStatus: Map<string, number | 'destroy'>;
  /** Wie forceStatus, aber für die Dokumentlisten-Route (/cases/:id/documents) einer bestimmten
   *  Akte — für Fehlerklassen-Tests des Abgleichs (z. B. 401 -> Login-Kette). */
  forceListStatus: Map<string, number | 'destroy'>;
  /** Erzwingt für die Aktenlisten-Route (/cases/list) eine feste Antwort — für Fallback-Tests
   *  von GET /api/v1/cases (kein Per-Akte-Schlüssel nötig, die Route liefert immer alle Akten).
   *  Objekt statt Map, damit Tests direkt `fake.forceCasesList.status = …` setzen können. */
  forceCasesList: { status: number | 'destroy' | null };
  /** REF-03 (01-07): apiLevel, das GET /v1/security/metadata zurückliefert. Standardmäßig die
   *  laut 01-SPIKE-FINDINGS.md live verifizierte getestete Ebene (8) — Tests überschreiben
   *  diesen Wert für 'inkompatibel'-Fälle. `status` erzwingt stattdessen einen Fehlerfall
   *  ('unbestimmt'-Test: kein Endpunkt/nicht erreichbar/unerwartete Antwort). */
  metadata: { apiLevel: number; status: number | 'destroy' | 'malformed' | null };
  /** Zuletzt empfangener Körper von PUT .../v6/cases/duedate/create — für Tests, die den
   *  tatsächlich gesendeten Feldsatz prüfen wollen (Task 1, TASK-02). Objekt-Wrapper nach dem
   *  `forceCasesList`-Muster, damit Tests direkt `fake.lastDueDateBody.body` lesen können. */
  lastDueDateBody: { body: Record<string, unknown> | null };
  /** Erzwingt für PUT .../v6/cases/duedate/create eine feste Antwort — für Fehlerklassen-Tests
   *  (401/403/404/500/Netzfehler) und den defensiven Kennung-fehlt-Fall der Übergaberoute
   *  (Task 1, Task 2). 'success-no-id' liefert 200 ohne id-Feld. */
  forceDueDateStatus: { status: number | 'destroy' | 'success-no-id' | null };
  stop(): Promise<void>;
}

/** Kalenderkennung, gegen die der Attrappen-Server `PUT .../v6/cases/duedate/create` prüft —
 *  entspricht der über JLAWYER_TASK_CALENDAR_ID konfigurierten echten Kennung (Task 2). */
export const FAKE_CALENDAR_ID = 'kalender-fristen';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 298 420]>>endobj\ntrailer<</Size 4/Root 1 0 R>>\n%%EOF\n');

/** Zweites festes Credential-Paar — für Tests, die zwei unterschiedliche j-lawyer-Nutzer
 *  (und damit zwei unterschiedliche desk-owner_id) brauchen (Cross-User-Fallback-Tests). */
export const FAKE_JLAWYER_USER_B = { username: 'kollegin', password: 'kanzlei456' };

export function startFakeJLawyer(user = 'anwalt', pass = 'kanzlei123'): Promise<FakeJLawyer> {
  const ok = 'Basic ' + Buffer.from(`${user}:${pass}`, 'utf8').toString('base64');
  const okB = 'Basic ' + Buffer.from(`${FAKE_JLAWYER_USER_B.username}:${FAKE_JLAWYER_USER_B.password}`, 'utf8').toString('base64');
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
  const forceStatus = new Map<string, number | 'destroy'>();
  const forceListStatus = new Map<string, number | 'destroy'>();
  const forceCasesList: { status: number | 'destroy' | null } = { status: null };
  const metadata: { apiLevel: number; status: number | 'destroy' | 'malformed' | null } = { apiLevel: 8, status: null };
  const lastDueDateBody: { body: Record<string, unknown> | null } = { body: null };
  const forceDueDateStatus: { status: number | 'destroy' | 'success-no-id' | null } = { status: null };
  let nextId = 100;
  let nextDueDateId = 1;

  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.headers.authorization !== ok && req.headers.authorization !== okB) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="jlawyerRealm"' });
      return res.end();
    }
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const url = req.url ?? '';
    if (req.method === 'GET') {
      const docMatch = url.match(/^\/j-lawyer-io\/rest\/v1\/cases\/document\/([^/]+?)(?:\/content)?$/);
      if (docMatch) {
        const forced = forceStatus.get(decodeURIComponent(docMatch[1]));
        if (forced === 'destroy') return req.socket.destroy();
        if (typeof forced === 'number') return json(forced, {});
      }
    }
    // REF-03 (01-07): ApiMetadataV1 ({ apiLevel }) — 01-SPIKE-FINDINGS.md, live gegen die
    // reale Testinstanz verifiziert (GET /v1/security/metadata).
    if (url === '/j-lawyer-io/rest/v1/security/metadata' && req.method === 'GET') {
      if (metadata.status === 'destroy') return req.socket.destroy();
      if (metadata.status === 'malformed') return json(200, {});
      if (typeof metadata.status === 'number') return json(metadata.status, {});
      return json(200, { apiLevel: metadata.apiLevel });
    }
    if (url === '/j-lawyer-io/rest/v1/cases/list') {
      if (forceCasesList.status === 'destroy') return req.socket.destroy();
      if (typeof forceCasesList.status === 'number') return json(forceCasesList.status, {});
      return json(200, cases.map((c) => ({ ...c, externalId: null, dateChanged: 1750000000000 })));
    }
    // v2 Fall-Metadaten (RestfulCaseV2) — dient dem "archiviert"-Feld (01-SPIKE-FINDINGS.md,
    // 01-05: getCase()). 0/1 statt Boolean, wie live gegen die reale Testinstanz verifiziert.
    const v2 = url.match(/^\/j-lawyer-io\/rest\/v2\/cases\/([^/]+)$/);
    if (v2 && req.method === 'GET') {
      const caseId = decodeURIComponent(v2[1]);
      const c = cases.find((x) => x.id === caseId);
      if (!c) return json(500, {});
      return json(200, { ...c, externalId: null, archived: c.archived ?? 0 });
    }
    let m = url.match(/^\/j-lawyer-io\/rest\/v1\/cases\/([^/]+)\/documents$/);
    if (m) {
      const caseId = decodeURIComponent(m[1]);
      const forced = forceListStatus.get(caseId);
      if (forced === 'destroy') return req.socket.destroy();
      if (typeof forced === 'number') return json(forced, {});
      const docs = documents.get(caseId);
      if (!docs) return json(500, {});
      return json(200, docs.map(({ bytes, ...rest }) => ({ ...rest, changeDate: new Date(rest.changeDate).toISOString().replace('.000Z', 'Z') + '[UTC]', externalId: null, creationDate: rest.changeDate, favorite: false, tags: [] })));
    }
    m = url.match(/^\/j-lawyer-io\/rest\/v1\/cases\/document\/([^/]+)\/content$/);
    if (m) {
      const docId = decodeURIComponent(m[1]);
      for (const docs of documents.values()) {
        const d = docs.find((x) => x.id === docId);
        if (d) return json(200, { id: d.id, externalId: null, caseId: d.caseId, fileName: d.name, base64content: d.bytes.toString('base64') });
      }
      return json(500, {});
    }
    m = url.match(/^\/j-lawyer-io\/rest\/v1\/cases\/document\/([^/]+)$/);
    if (m && req.method === 'GET') {
      const docId = decodeURIComponent(m[1]);
      for (const docs of documents.values()) {
        const d = docs.find((x) => x.id === docId);
        if (d) return json(200, { id: d.id, caseId: d.caseId, externalId: null, name: d.name, changeDate: d.changeDate, creationDate: d.changeDate, size: d.size, favorite: false, tags: [] });
      }
      return json(500, {});
    }
    if (url === '/j-lawyer-io/rest/v1/cases/document/create' && req.method === 'PUT') {
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
    // TASK-02: Wiedervorlage anlegen (RestfulDueDateV6, verifiziert 08-RESEARCH.md Pattern 5).
    // Antwortet mit einer erzeugten Kennung, wenn Fall und Kalenderkennung stimmen, sonst mit
    // einem Serverfehler — spiegelt exakt den empfangenen Körper für Tests wider.
    if (url === '/j-lawyer-io/rest/v6/cases/duedate/create' && req.method === 'PUT') {
      if (forceDueDateStatus.status === 'destroy') return req.socket.destroy();
      if (forceDueDateStatus.status === 'success-no-id') return json(200, {});
      if (typeof forceDueDateStatus.status === 'number') return json(forceDueDateStatus.status, {});
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const p = JSON.parse(body) as Record<string, unknown>;
        lastDueDateBody.body = p;
        const c = cases.find((x) => x.id === p.caseId);
        if (!c || p.calendar !== FAKE_CALENDAR_ID) return json(500, {});
        return json(200, { id: `dd-${nextDueDateId++}`, caseId: c.id, caseName: c.name, caseNumber: c.fileNumber, ...p });
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
        forceStatus,
        forceListStatus,
        forceCasesList,
        metadata,
        lastDueDateBody,
        forceDueDateStatus,
        stop: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
