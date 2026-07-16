import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestSetup, type TestSetup } from './testServer';
import { getState, listDesks } from './deskApi';

let ts: TestSetup;
beforeAll(async () => {
  ts = await startTestSetup();
});
afterAll(async () => {
  await ts.stop();
});
const textOf = (r: { content: unknown }) => (r.content as { text: string }[]).map((c) => c.text).join('');

describe('Organisier-Tools', () => {
  it('move_document, stack_documents, rename_stack mit De-Anonymisierung', async () => {
    const deskId = await ts.createDesk('Orga');
    const a = await ts.addDoc(deskId, 'Rechnung Max Mustermann.pdf');
    const b = await ts.addDoc(deskId, 'Brief.pdf');
    await ts.mcpClient.callTool({ name: 'get_desk', arguments: { deskId } }); // füllt Mapping ([[Person-TEST1]])

    const mv = await ts.mcpClient.callTool({ name: 'move_document', arguments: { deskId, docId: a, x: 100, y: 50 } });
    expect(mv.isError).toBeFalsy();

    const st = await ts.mcpClient.callTool({ name: 'stack_documents', arguments: { deskId, draggedId: a, targetId: b } });
    expect(st.isError).toBeFalsy();
    const s1 = await getState(ts.deskUrl, ts.token, deskId);
    expect(s1.state.stacks).toHaveLength(1);

    // Platzhalter im Namen → Klartext auf dem Schreibtisch
    const rn = await ts.mcpClient.callTool({
      name: 'rename_stack',
      arguments: { deskId, stackId: s1.state.stacks[0].id, name: 'Unterlagen [[Person-TEST1]]' },
    });
    expect(rn.isError).toBeFalsy();
    const s2 = await getState(ts.deskUrl, ts.token, deskId);
    expect(s2.state.stacks[0].name).toBe('Unterlagen Max Mustermann');
  });

  it('link_documents + set_link_note + remove_link; create_desk/rename_desk', async () => {
    const deskId = await ts.createDesk('Links');
    const a = await ts.addDoc(deskId, 'A.pdf');
    const b = await ts.addDoc(deskId, 'B.pdf');
    const link = await ts.mcpClient.callTool({ name: 'link_documents', arguments: { deskId, fromId: a, toId: b } });
    expect(link.isError).toBeFalsy();
    const linkId = (await getState(ts.deskUrl, ts.token, deskId)).state.links[0].id;
    await ts.mcpClient.callTool({ name: 'set_link_note', arguments: { deskId, linkId, note: 'gehört zusammen' } });
    expect((await getState(ts.deskUrl, ts.token, deskId)).state.links[0].note).toBe('gehört zusammen');
    await ts.mcpClient.callTool({ name: 'remove_link', arguments: { deskId, linkId } });
    expect((await getState(ts.deskUrl, ts.token, deskId)).state.links).toHaveLength(0);

    const neu = await ts.mcpClient.callTool({ name: 'create_desk', arguments: { name: 'KI-Desk' } });
    expect(neu.isError).toBeFalsy();
    const neuId = (JSON.parse(textOf(neu)) as { id: string }).id;
    const rn = await ts.mcpClient.callTool({ name: 'rename_desk', arguments: { deskId: neuId, name: 'KI-Desk 2' } });
    expect(rn.isError).toBeFalsy();
  });

  it('unbekannte Platzhalter → Fehler, nichts geschrieben', async () => {
    const deskId = await ts.createDesk('Fehlerfall');
    const r = await ts.mcpClient.callTool({ name: 'rename_desk', arguments: { deskId, name: 'Für [[Person-UNBEKANNT9]]' } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('Unbekannte Platzhalter');
  });

  it('destruktive Tools existieren nicht', async () => {
    const tools = await ts.mcpClient.listTools();
    const namen = tools.tools.map((t) => t.name);
    expect(namen).not.toContain('remove_document');
    expect(namen).not.toContain('delete_desk');
    expect(namen).toContain('deanonymize');
  });

  it('deanonymize-Tool übersetzt bekannte Platzhalter', async () => {
    const r = await ts.mcpClient.callTool({ name: 'deanonymize', arguments: { text: 'Hallo [[Person-TEST1]]' } });
    expect(textOf(r)).toContain('Hallo Max Mustermann');
  });

  it('Layout-Tools ohne Textbezug funktionieren auch bei anymize-Ausfall', async () => {
    const deskId = await ts.createDesk('Offline-Orga');
    const docId = await ts.addDoc(deskId, 'A.pdf');
    ts.setAnymizeDown(true);
    const r = await ts.mcpClient.callTool({ name: 'move_document', arguments: { deskId, docId, x: 5, y: 5 } });
    expect(r.isError).toBeFalsy();
    ts.setAnymizeDown(false);
  });
});

describe('Mandantengrenze (Fix 1: Mapping/Namens-Cache pro Token)', () => {
  it('deanonymize eines Fremdbenutzers löst fremde Platzhalter nicht auf', async () => {
    const deskId = await ts.createDesk('Mandanten-Desk');
    await ts.addDoc(deskId, 'Rechnung Max Mustermann.pdf');
    await ts.mcpClient.callTool({ name: 'get_desk', arguments: { deskId } }); // füllt Mapping des Test-Users

    const { token } = await ts.zweitBenutzer();
    const zweiterClient = await ts.clientMitToken(token);
    const r = await zweiterClient.callTool({ name: 'deanonymize', arguments: { text: 'Hallo [[Person-TEST1]]' } });
    expect(textOf(r)).toContain('[[Person-TEST1]]');
    expect(textOf(r)).not.toContain('Max Mustermann');
    expect(textOf(r)).toContain('Unbekannte Platzhalter');
  });

  it('create_desk mit Platzhalter im Namen: Tool-Antwort zeigt Eingabewert, Desk-Server-State den Klartext', async () => {
    const quelle = await ts.createDesk('Quelle');
    await ts.addDoc(quelle, 'Ausweis Max Mustermann.pdf');
    await ts.mcpClient.callTool({ name: 'get_desk', arguments: { deskId: quelle } }); // füllt Mapping des Test-Users

    const neu = await ts.mcpClient.callTool({ name: 'create_desk', arguments: { name: 'Akte [[Person-TEST1]]' } });
    expect(neu.isError).toBeFalsy();
    expect(textOf(neu)).toContain('[[Person-TEST1]]');
    expect(textOf(neu)).not.toContain('Max Mustermann');

    const desks = await listDesks(ts.deskUrl, ts.token);
    expect(desks.find((d) => d.name === 'Akte Max Mustermann')).toBeDefined();
  });
});

describe('MCP_ALLOW_DEANONYMIZE=false', () => {
  it('versteckt das deanonymize-Tool', async () => {
    const strikt = await startTestSetup({ allowDeanonymize: false });
    const tools = await strikt.mcpClient.listTools();
    expect(tools.tools.map((t) => t.name)).not.toContain('deanonymize');
    await strikt.stop();
  });
});
