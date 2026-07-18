import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestSetup, type TestSetup } from './testServer';

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

  it('Rework-Semantik: Desks sind kanzlei-weit geteilt — zweiter Nutzer liest denselben Desk (anonymisiert)', async () => {
    const deskId = await ts.createDesk('Geteilter Desk');
    await ts.addDoc(deskId, 'Rechnung Max Mustermann.pdf');
    const { token } = await ts.zweitBenutzer();
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
