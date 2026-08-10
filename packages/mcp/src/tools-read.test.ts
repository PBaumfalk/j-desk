import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestSetup, type TestSetup } from './testServer';
import { sendCommand } from './deskApi';

// Task 9: get_document_text pollt bei kind 'convertible' die Vorschau (Default-Intervall 2 s,
// Produktions-Wert). Für Tests über MCP_PREVIEW_POLL_INTERVAL_MS drastisch verkürzt.
process.env.MCP_PREVIEW_POLL_INTERVAL_MS = '20';

let ts: TestSetup;
beforeAll(async () => {
  ts = await startTestSetup();
});
afterAll(async () => {
  await ts.stop();
});

async function callTool(name: string, args: Record<string, unknown> = {}) {
  return ts.mcpClient.callTool({ name, arguments: args });
}
const textOf = (r: Awaited<ReturnType<typeof callTool>>) =>
  (r.content as { type: string; text: string }[]).map((c) => c.text).join('');

describe('Lese-Tools', () => {
  it('list_desks liefert anonymisierte Namen', async () => {
    await ts.createDesk('Desk von Max Mustermann');
    const r = await callTool('list_desks');
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain('[[Person-TEST1]]');
    expect(textOf(r)).not.toContain('Max Mustermann');
  });

  it('get_desk liefert Karten mit anonymisierten Namen; Cache spart anymize-Aufrufe', async () => {
    const deskId = await ts.createDesk('Zweiter Desk');
    await ts.addDoc(deskId, 'Rechnung Max Mustermann.pdf');
    const vorher = ts.anymizeCalls();
    const r1 = await callTool('get_desk', { deskId });
    expect(textOf(r1)).toContain('[[Person-TEST1]]');
    await callTool('get_desk', { deskId });
    expect(ts.anymizeCalls()).toBe(vorher + 1); // zweiter Aufruf komplett aus dem Cache
  });

  it('get_document_text: PDF via Fake-anymize, gecacht pro fileId', async () => {
    const deskId = await ts.createDesk('Textdesk');
    const docId = await ts.addDoc(deskId, 'Brief.pdf');
    const vorher = ts.anymizeCalls();
    const r = await callTool('get_document_text', { deskId, docId });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain('[[Person-TEST1]]');
    await callTool('get_document_text', { deskId, docId });
    expect(ts.anymizeCalls()).toBe(vorher + 1);
  });

  it('fail-closed: anymize down → Fehler statt Klartext', async () => {
    ts.setAnymizeDown(true);
    const deskId = await ts.createDesk('Geheim Max Mustermann');
    const r = await callTool('get_desk', { deskId });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('Anonymisierung nicht verfügbar');
    expect(textOf(r)).not.toContain('Max Mustermann');
    ts.setAnymizeDown(false);
  });

  it('ungültiges Token → 401-Meldung', async () => {
    const fremd = await ts.clientMitToken('falsches-token');
    const r = await fremd.callTool({ name: 'list_desks', arguments: {} });
    expect(r.isError).toBe(true);
    expect((r.content as { text: string }[])[0].text).toContain('mcp:token');
  });

  it('02-04: ein zweiter Nutzer OHNE desk_roles-Zeile bekommt keinen Zugriff auf den Desk', async () => {
    const deskId = await ts.createDesk('Nicht geteilter Desk');
    await ts.addDoc(deskId, 'Rechnung Max Mustermann.pdf');
    const { token } = await ts.zweitBenutzer();
    const zweiterClient = await ts.clientMitToken(token);
    const r = await zweiterClient.callTool({ name: 'get_desk', arguments: { deskId } });
    expect(r.isError).toBe(true);
  });

  it('mit vergebener Rolle liest ein zweiter Nutzer denselben Desk (anonymisiert, eigenes Mapping)', async () => {
    const deskId = await ts.createDesk('Geteilter Desk');
    await ts.addDoc(deskId, 'Rechnung Max Mustermann.pdf');
    const { token, userId } = await ts.zweitBenutzer();
    // 02-04: Desks sind nicht mehr implizit kanzlei-weit sichtbar — MCP nutzt dieselben
    // REST-Routen wie das Frontend (10-Pfade-Tabelle Zeile 10) und braucht daher ebenfalls
    // eine desk_roles-Zeile für den zugreifenden Nutzer.
    ts.gewaehreRolle(deskId, userId, 'Bearbeiter');
    const zweiterClient = await ts.clientMitToken(token);
    const r = await zweiterClient.callTool({ name: 'get_desk', arguments: { deskId } });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).not.toContain('Max Mustermann'); // anonymisiert, mit eigenem Mapping
  });
});

describe('Task 9: MCP kind-bewusst', () => {
  it('get_desk liefert kind je Karte (pdf, convertible, image, other)', async () => {
    const deskId = await ts.createDesk('Kind-Desk');
    await ts.addDoc(deskId, 'Brief.pdf'); // Default-Bytes = %PDF-... -> kind pdf
    await ts.addDoc(deskId, 'Bericht.odt', Buffer.from('bericht-inhalt'));
    await ts.addDoc(deskId, 'Foto.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]));
    await ts.addDoc(deskId, 'Sonstiges.exe', Buffer.from('zufaelliger inhalt'));

    const r = await callTool('get_desk', { deskId });
    expect(r.isError).toBeFalsy();
    const kinds = (JSON.parse(textOf(r)).docs as { kind: string }[]).map((d) => d.kind);
    expect(kinds).toEqual(['pdf', 'convertible', 'image', 'other']);
  });

  it('get_document_text: image/other liefert klaren Fehler statt Text', async () => {
    const deskId = await ts.createDesk('Kein-Text-Desk');
    const bildId = await ts.addDoc(deskId, 'Foto.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]));
    const sonstId = await ts.addDoc(deskId, 'Sonstiges.exe', Buffer.from('zufaelliger inhalt'));

    for (const docId of [bildId, sonstId]) {
      const r = await callTool('get_document_text', { deskId, docId });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toContain('Für diese Datei-Art ist kein Text-Inhalt verfügbar');
    }
  });

  it('get_document_text: convertible pollt die Vorschau (202 -> 200) und liefert den anonymisierten Text', async () => {
    const deskId = await ts.createDesk('Konvertier-Desk');
    // pollsUntilDone: 1 -> erster preview-Aufruf liefert 202, danach im Hintergrund fertig;
    // die MCP muss also mindestens einmal erneut pollen, bevor sie 200 bekommt.
    const docId = await ts.addDoc(deskId, 'Bericht.odt', Buffer.from('bericht-inhalt'), { pollsUntilDone: 1 });

    const r = await callTool('get_document_text', { deskId, docId });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain('[[Person-TEST1]]');
    expect(textOf(r)).not.toContain('Max Mustermann');
  });

  it('get_document_text: convertible reicht 409-Fehler des Servers durch', async () => {
    const deskId = await ts.createDesk('Konvertier-Fehler-Desk');
    const docId = await ts.addDoc(deskId, 'Fehler.docx', Buffer.from('fehler-inhalt'), {
      errorCode: '-3',
      errorWithoutEndConvert: true,
    });

    // Erster Aufruf stößt die (fehlschlagende) Konvertierung im Hintergrund an (202);
    // gepollt wird, bis der Fehler-Merker als 409 zurückkommt.
    const r = await callTool('get_document_text', { deskId, docId });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('-3');
  });
});

describe('Task 5: MCP liest den Werkzeugkasten', () => {
  it('get_desk liefert Stempel, Fahnen, Marks-Zähler, Klammern, Konvolute und Papierkorb (anonymisiert)', async () => {
    const deskId = await ts.createDesk('Werkzeugkasten-Desk');
    const docA = await ts.addDoc(deskId, 'DocA.pdf');
    const docB = await ts.addDoc(deskId, 'DocB.pdf');
    const docC = await ts.addDoc(deskId, 'DocC.pdf');
    const docD = await ts.addDoc(deskId, 'Rechnung Max Mustermann.pdf');

    await sendCommand(ts.deskUrl, ts.token, deskId, {
      type: 'addStamp',
      payload: { stamp: { docId: docA, page: 1, x: 10, y: 10, angle: 0, text: 'Fristsache Max Mustermann', color: 'red', baseW: 120, baseH: 40 } },
    });
    await sendCommand(ts.deskUrl, ts.token, deskId, {
      type: 'addFlag',
      payload: { flag: { docId: docA, page: 1, offset: 0.5, color: '#f5c518' } },
    });
    await sendCommand(ts.deskUrl, ts.token, deskId, {
      type: 'addMark',
      payload: { mark: { docId: docA, page: 1, rect: { x: 0, y: 0, w: 10, h: 10 }, kind: 'tippex' } },
    });
    await sendCommand(ts.deskUrl, ts.token, deskId, {
      type: 'addMark',
      payload: { mark: { docId: docA, page: 1, rect: { x: 20, y: 20, w: 10, h: 10 }, kind: 'redact' } },
    });
    const nachStapel = await sendCommand(ts.deskUrl, ts.token, deskId, {
      type: 'stackDocs',
      payload: { draggedId: docB, targetId: docA },
    });
    const stackId = nachStapel.state.stacks[0].id;
    await sendCommand(ts.deskUrl, ts.token, deskId, { type: 'stapleStack', payload: { stackId } });
    await sendCommand(ts.deskUrl, ts.token, deskId, { type: 'tapeObject', payload: { id: stackId } });
    await sendCommand(ts.deskUrl, ts.token, deskId, { type: 'addClip', payload: { aId: docA, bId: docC } });
    await sendCommand(ts.deskUrl, ts.token, deskId, {
      type: 'addNote',
      payload: { kind: 'eigen', text: 'Eigener Zettel', position: { x: 0, y: 0 }, customLabel: 'Max Mustermann' },
    });
    const nachTodo = await sendCommand(ts.deskUrl, ts.token, deskId, {
      type: 'addNote',
      payload: { kind: 'todo', text: 'Erledigen', position: { x: 0, y: 0 } },
    });
    const todoId = nachTodo.state.notes!.find((n) => n.kind === 'todo')!.id;
    await sendCommand(ts.deskUrl, ts.token, deskId, { type: 'setNoteDone', payload: { id: todoId, done: true } });
    await sendCommand(ts.deskUrl, ts.token, deskId, {
      type: 'trashObject',
      payload: { id: docD, trashedAt: new Date().toISOString() },
    });

    const r = await callTool('get_desk', { deskId });
    expect(r.isError).toBeFalsy();
    const body = JSON.parse(textOf(r));

    expect(body.stamps).toHaveLength(1);
    expect(body.stamps[0].text).toContain('[[Person-TEST1]]');
    expect(body.stamps[0].text).not.toContain('Max Mustermann'); // anonymisiert

    expect(body.flags[0]).toMatchObject({ page: expect.any(Number), color: expect.any(String) });

    expect(body.markCounts).toEqual({ [docA]: { tippex: 1, redact: 1 } });

    expect(body.clips[0].memberIds.length).toBeGreaterThan(1);

    const stapelStack = body.stacks.find((st: { id: string }) => st.id === stackId);
    expect(stapelStack.stapled).toBe(true);
    expect(stapelStack.taped).toBe(true);

    expect(body.trash[0].name).toContain('[[Person-TEST1]]');
    expect(body.trash[0].name).not.toContain('Max Mustermann'); // anonymisiert

    const eigenNote = body.notes.find((n: { kind: string }) => n.kind === 'eigen');
    expect(eigenNote.customLabel).toContain('[[Person-TEST1]]');
    expect(eigenNote.customLabel).not.toContain('Max Mustermann'); // anonymisiert

    const todoNote = body.notes.find((n: { kind: string }) => n.kind === 'todo');
    expect(todoNote.done).toBe(true);
  });
});

describe('R1 Task 5: get_desk meldet sourceGone/sourceReplacedAt', () => {
  it('gesetzte Felder landen (reine Flags, kein Klartext); ungesetzt fehlen sie ganz', async () => {
    const deskId = await ts.createDesk('Referenzstatus-Desk');
    const verwaist = await ts.addDoc(deskId, 'Verwaistes.pdf');
    const ersetzt = await ts.addDoc(deskId, 'Ersetztes.pdf');
    const normal = await ts.addDoc(deskId, 'Normales.pdf');

    const replacedAt = new Date('2026-07-19T10:00:00.000Z').toISOString();
    await ts.patchDoc(deskId, verwaist, { sourceGone: true });
    await ts.patchDoc(deskId, ersetzt, { sourceReplacedAt: replacedAt });

    const r = await callTool('get_desk', { deskId });
    expect(r.isError).toBeFalsy();
    const docs = JSON.parse(textOf(r)).docs as Record<string, unknown>[];

    const docVerwaist = docs.find((d) => d.id === verwaist)!;
    expect(docVerwaist.sourceGone).toBe(true);
    expect('sourceReplacedAt' in docVerwaist).toBe(false);

    const docErsetzt = docs.find((d) => d.id === ersetzt)!;
    expect(docErsetzt.sourceReplacedAt).toBe(replacedAt);
    expect('sourceGone' in docErsetzt).toBe(false);

    const docNormal = docs.find((d) => d.id === normal)!;
    expect('sourceGone' in docNormal).toBe(false);
    expect('sourceReplacedAt' in docNormal).toBe(false);
  });
});
