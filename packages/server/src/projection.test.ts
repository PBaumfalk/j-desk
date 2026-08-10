import { describe, it, expect } from 'vitest';
import WsClient from 'ws';
import { createTestAppMitZweiNutzern, addUser } from './testUtils';
import { storeFile } from './files';
import { readPackage } from './jdesk';

/**
 * PERM-05-Abnahme: der Netzwerk-Trace-Test über ALLE 10 Auslieferungspfade (02-RESEARCH.md).
 * Sonde: ein eindeutiger Marker-String an einem privaten Objekt von Nutzer A (Ausschnitt mit
 * `textSnapshot`, per echtem `changeLayerId`-Command auf As private Ebene verschoben). Jede
 * Assertion prüft `JSON.stringify(<rohe Payload an B>)` — Abwesenheit im Payload, nicht nur
 * Nicht-Rendern (Research „Looks Done But Isn't"). Pfad 10 (MCP) wird in mcp-projektion.test.ts
 * abgedeckt (MCP nutzt dieselben REST-Pfade, siehe 02-RESEARCH.md Component Responsibilities).
 */

const pdf = Buffer.from('%PDF-1.4\ninhalt');
const MARKER = 'MARKER-GEHEIM-7f3e1a2b9c';

/**
 * Baut den gemeinsamen Trace-Grundzustand auf: A legt Desk + Dokument an, B bekommt `rolleB`.
 * A verschiebt einen Ausschnitt mit dem MARKER im `textSnapshot` per echtem `changeLayerId`-
 * Command auf seine private Ebene — seit 02-09 über die Platzhalter-id 'privat' (exakt das,
 * was die UI sendet); die Pro-Nutzer-Privat-Instanz entsteht dabei produktiv und atomar im
 * selben Command (ensurePrivateLayer über meta.createdById). Kein Direkt-State-Zugriff mehr
 * im Aufbau — die Sonde beweist die Isolation über denselben Weg wie der Produktbetrieb.
 */
async function aufbauMitPrivatemMarkerObjekt(rolleB: string) {
  const { app, db, dataDir, a, b } = await createTestAppMitZweiNutzern();
  const desk = (
    await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte A' } })
  ).json() as { id: string };
  db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(desk.id, b.userId, rolleB);

  const meta = storeFile(db, dataDir, pdf, 'a.pdf');
  await app.inject({
    method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: a.authHeaders,
    payload: { type: 'addDoc', payload: { fileId: meta.id, name: 'a.pdf', position: { x: 0, y: 0 }, id: 'doc-marker' } },
  });
  await app.inject({
    method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: a.authHeaders,
    payload: {
      type: 'addCutout',
      payload: {
        docId: 'doc-marker', page: 1, rect: { x: 0, y: 0, w: 10, h: 10 }, position: { x: 1, y: 1 },
        id: 'cut-marker', textSnapshot: MARKER,
      },
    },
  });
  const privat = await app.inject({
    method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: a.authHeaders,
    payload: { type: 'changeLayerId', payload: { objectId: 'cut-marker', layerId: 'privat' } },
  });
  expect(privat.statusCode).toBe(200);

  return { app, db, dataDir, a, b, deskId: desk.id, fileMeta: meta };
}

describe('PERM-05: Netzwerk-Trace-Abnahmetest über alle 10 Auslieferungspfade (02-RESEARCH.md)', () => {
  it('Pfad 1 (GET /desks als B): der Desk erscheint, der Marker taucht nirgends auf', async () => {
    const { app, b, deskId } = await aufbauMitPrivatemMarkerObjekt('Bearbeiter');
    const res = await app.inject({ method: 'GET', url: '/api/v1/desks', headers: b.authHeaders });
    expect(res.statusCode).toBe(200);
    const liste = res.json() as { id: string }[];
    expect(liste.map((d) => d.id)).toContain(deskId);
    expect(JSON.stringify(liste)).not.toContain(MARKER);
  });

  it('Pfad 2 (GET /state als B): JSON.stringify(response) enthält den Marker NICHT', async () => {
    const { app, b, deskId } = await aufbauMitPrivatemMarkerObjekt('Bearbeiter');
    const res = await app.inject({ method: 'GET', url: `/api/v1/desks/${deskId}/state`, headers: b.authHeaders });
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.json())).not.toContain(MARKER);
  });

  it('Pfad 2+ (GET /state als B): auch die fremde Privat-INSTANZ fehlt restlos — keine Andeutung privater Ebenen anderer (02-09, T-02-09-01)', async () => {
    const { app, a, b, deskId } = await aufbauMitPrivatemMarkerObjekt('Bearbeiter');
    const res = await app.inject({ method: 'GET', url: `/api/v1/desks/${deskId}/state`, headers: b.authHeaders });
    expect(res.statusCode).toBe(200);
    // Die Instanz-id taucht nirgends im Roh-JSON auf (weder als layers-Eintrag noch sonstwo).
    expect(JSON.stringify(res.json())).not.toContain(`privat-${a.userId}`);
    // Jede privat-Instanz in Bs Projektion gehört B selbst.
    const layers = (res.json() as { state: { layers?: { typ: string; ownerUserId?: string }[] } }).state.layers ?? [];
    for (const e of layers) {
      if (e.typ === 'privat') expect(e.ownerUserId).toBe(b.userId);
    }
  });

  it('Pfad 3 (POST /commands-Antwort an B): Marker fehlt', async () => {
    const { app, b, deskId } = await aufbauMitPrivatemMarkerObjekt('Bearbeiter');
    const res = await app.inject({
      method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers: b.authHeaders,
      payload: { type: 'addNote', payload: { id: 'n-b', kind: 'notiz', text: 'sichtbar', position: { x: 1, y: 1 } } },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.json())).not.toContain(MARKER);
  });

  it('Pfad 4 (PUT /state als B ohne Bearbeiter-Recht): Guard greift, Marker fehlt auch im Fehlerkörper', async () => {
    const { app, b, deskId } = await aufbauMitPrivatemMarkerObjekt('Kommentator');
    const res = await app.inject({
      method: 'PUT', url: `/api/v1/desks/${deskId}/state`, headers: b.authHeaders,
      payload: { docs: [], links: [], stacks: [] },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.stringify(res.json())).not.toContain(MARKER);
  });

  it('Pfad 5 (WS-Broadcast nach einem A-Command): die Frame an B enthält den Marker NICHT, die an A schon', async () => {
    const { app, a, b, deskId } = await aufbauMitPrivatemMarkerObjekt('Bearbeiter');
    await app.listen({ port: 0 });
    try {
      const { port } = app.server.address() as { port: number };
      const ticketA = (
        await app.inject({ method: 'POST', url: '/api/v1/ws-ticket', headers: a.authHeaders })
      ).json().ticket as string;
      const ticketB = (
        await app.inject({ method: 'POST', url: '/api/v1/ws-ticket', headers: b.authHeaders })
      ).json().ticket as string;
      const wsA = new WsClient(`ws://127.0.0.1:${port}/api/v1/desks/${deskId}/ws?ticket=${ticketA}`);
      const wsB = new WsClient(`ws://127.0.0.1:${port}/api/v1/desks/${deskId}/ws?ticket=${ticketB}`);
      await Promise.all([
        new Promise((resolve, reject) => { wsA.on('open', resolve); wsA.on('error', reject); }),
        new Promise((resolve, reject) => { wsB.on('open', resolve); wsB.on('error', reject); }),
      ]);
      const frameA = new Promise<string>((resolve) => wsA.on('message', (d) => resolve(d.toString())));
      const frameB = new Promise<string>((resolve) => wsB.on('message', (d) => resolve(d.toString())));

      await app.inject({
        method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers: a.authHeaders,
        payload: { type: 'addNote', payload: { id: 'n-broadcast', kind: 'notiz', text: 'sichtbar', position: { x: 2, y: 2 } } },
      });

      const [empfangenA, empfangenB] = await Promise.all([frameA, frameB]);
      expect(empfangenA).toContain(MARKER);
      expect(empfangenB).not.toContain(MARKER);

      wsA.close();
      wsB.close();
    } finally {
      await app.close();
    }
  });

  it('Pfad 6 (WS-Connect als Nutzer C ganz ohne Rolle): Verbindung wird geschlossen', async () => {
    const { app, db, deskId } = await aufbauMitPrivatemMarkerObjekt('Bearbeiter');
    await app.listen({ port: 0 });
    try {
      const { port } = app.server.address() as { port: number };
      const c = await addUser(db, 'nutzer-c');
      const ticketC = (
        await app.inject({ method: 'POST', url: '/api/v1/ws-ticket', headers: { authorization: `Bearer ${c.token}` } })
      ).json().ticket as string;
      const wsC = new WsClient(`ws://127.0.0.1:${port}/api/v1/desks/${deskId}/ws?ticket=${ticketC}`);
      const closeCode = await new Promise<number>((resolve, reject) => {
        wsC.on('close', (code) => resolve(code));
        wsC.on('error', reject);
      });
      expect(closeCode).toBe(4003);
    } finally {
      await app.close();
    }
  });

  it('Pfad 7 (GET /journal als B): Marker/textSnapshot fehlt', async () => {
    const { app, b, deskId } = await aufbauMitPrivatemMarkerObjekt('Bearbeiter');
    const res = await app.inject({ method: 'GET', url: `/api/v1/desks/${deskId}/journal`, headers: b.authHeaders });
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.json())).not.toContain(MARKER);
  });

  it('Pfad 8 (GET /export als B, entpacktes .jdesk): Marker fehlt', async () => {
    const { app, b, deskId } = await aufbauMitPrivatemMarkerObjekt('Bearbeiter');
    const res = await app.inject({ method: 'GET', url: `/api/v1/desks/${deskId}/export`, headers: b.authHeaders });
    expect(res.statusCode).toBe(200);
    const { state } = readPackage(res.rawPayload);
    expect(JSON.stringify(state)).not.toContain(MARKER);
  });

  it('Pfad 9 (POST /import als B ohne Recht): 403, Marker fehlt im Fehlerkörper', async () => {
    const { app, b, deskId } = await aufbauMitPrivatemMarkerObjekt('Kommentator');
    const boundary = '----importtrace';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="p.jdesk"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      Buffer.from('irrelevant'),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await app.inject({
      method: 'POST', url: `/api/v1/desks/${deskId}/import`,
      headers: { ...b.authHeaders, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.stringify(res.json())).not.toContain(MARKER);
  });

  it('Positivkontrolle: GET /state als A (Eigentümer) enthält den Marker weiterhin', async () => {
    const { app, a, deskId } = await aufbauMitPrivatemMarkerObjekt('Bearbeiter');
    const res = await app.inject({ method: 'GET', url: `/api/v1/desks/${deskId}/state`, headers: a.authHeaders });
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.json())).toContain(MARKER);
  });

  it('CR-02: privates Marker-Objekt im Papierkorb — Marker fehlt bei B in GET /state und im .jdesk-Export (inkl. Dateibytes)', async () => {
    const { app, a, b, deskId, fileMeta } = await aufbauMitPrivatemMarkerObjekt('Bearbeiter');

    // A wirft das private Marker-Objekt in den Papierkorb (echter REST-Command).
    const trash = await app.inject({
      method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers: a.authHeaders,
      payload: { type: 'trashObject', payload: { id: 'cut-marker', trashedAt: new Date().toISOString(), trashId: 'korb-marker' } },
    });
    expect(trash.statusCode).toBe(200);

    // Pfad 2 (GET /state als B): der Korb-Eintrag samt Vollkopie fehlt komplett.
    const stateB = await app.inject({ method: 'GET', url: `/api/v1/desks/${deskId}/state`, headers: b.authHeaders });
    expect(stateB.statusCode).toBe(200);
    expect(JSON.stringify(stateB.json())).not.toContain(MARKER);
    expect(JSON.stringify(stateB.json().state.trash ?? [])).not.toContain('korb-marker');

    // Verschärfter Fall Dateibytes: A stellt die Quell-Karte ebenfalls privat und wirft sie in
    // den Korb — danach verweist für B nichts Sichtbares mehr auf die Datei.
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers: a.authHeaders,
      payload: { type: 'changeLayerId', payload: { objectId: 'doc-marker', layerId: 'privat' } },
    });
    const trashDoc = await app.inject({
      method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers: a.authHeaders,
      payload: { type: 'trashObject', payload: { id: 'doc-marker', trashedAt: new Date().toISOString(), trashId: 'korb-doc' } },
    });
    expect(trashDoc.statusCode).toBe(200);

    // Pfad 8 (Export als B): weder Marker-Text noch die Dateibytes der im Korb liegenden
    // privaten Objekte dürfen im Paket stecken (referenzierteFileIds läuft auf dem projizierten State).
    const exportB = await app.inject({ method: 'GET', url: `/api/v1/desks/${deskId}/export`, headers: b.authHeaders });
    expect(exportB.statusCode).toBe(200);
    const paketB = readPackage(exportB.rawPayload);
    expect(JSON.stringify(paketB.state)).not.toContain(MARKER);
    expect([...paketB.files.keys()]).not.toContain(fileMeta.id);

    // Positivkontrolle: A (Eigentümer der privaten Ebene) sieht Korb-Einträge und Datei weiterhin.
    const stateA = await app.inject({ method: 'GET', url: `/api/v1/desks/${deskId}/state`, headers: a.authHeaders });
    expect(JSON.stringify(stateA.json())).toContain(MARKER);
    const exportA = await app.inject({ method: 'GET', url: `/api/v1/desks/${deskId}/export`, headers: a.authHeaders });
    expect([...readPackage(exportA.rawPayload).files.keys()]).toContain(fileMeta.id);
  });
});
