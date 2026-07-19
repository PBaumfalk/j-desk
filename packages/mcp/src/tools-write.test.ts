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

describe('Vision-Objekte (Zettel, Schnüre, Enthefter)', () => {
  it('add_note mit Platzhalter → Klartext im State; get_desk liefert die Note anonymisiert', async () => {
    const deskId = await ts.createDesk('Zettel-Desk');
    await ts.addDoc(deskId, 'Rechnung Max Mustermann.pdf');
    await ts.mcpClient.callTool({ name: 'get_desk', arguments: { deskId } }); // füllt Mapping

    const r = await ts.mcpClient.callTool({
      name: 'add_note',
      arguments: { deskId, kind: 'frage', text: 'Hat [[Person-TEST1]] bezahlt?', x: 10, y: 20 },
    });
    expect(r.isError).toBeFalsy();
    const s = await getState(ts.deskUrl, ts.token, deskId);
    expect(s.state.notes).toHaveLength(1);
    expect(s.state.notes![0].text).toBe('Hat Max Mustermann bezahlt?'); // Klartext auf dem Tisch
    expect(s.state.notes![0].kind).toBe('frage');

    const gd = await ts.mcpClient.callTool({ name: 'get_desk', arguments: { deskId } });
    expect(textOf(gd)).toContain('[[Person-TEST1]]');
    expect(textOf(gd)).not.toContain('Max Mustermann');
  });

  it('link_documents verbindet Zettel mit Karte; remove_note räumt die Schnur ab', async () => {
    const deskId = await ts.createDesk('Schnur-Desk');
    const docId = await ts.addDoc(deskId, 'Brief.pdf');
    const note = JSON.parse(textOf(await ts.mcpClient.callTool({
      name: 'add_note', arguments: { deskId, kind: 'notiz', text: 'Frist prüfen', x: 0, y: 0 },
    })));
    const ln = await ts.mcpClient.callTool({ name: 'link_documents', arguments: { deskId, fromId: note.id, toId: docId } });
    expect(ln.isError).toBeFalsy();
    let s = await getState(ts.deskUrl, ts.token, deskId);
    expect(s.state.links).toHaveLength(1);
    await ts.mcpClient.callTool({ name: 'remove_note', arguments: { deskId, noteId: note.id } });
    s = await getState(ts.deskUrl, ts.token, deskId);
    expect(s.state.notes).toHaveLength(0);
    expect(s.state.links).toHaveLength(0);
  });

  it('extract_page legt eine seitenfixierte Karte an', async () => {
    const deskId = await ts.createDesk('Enthefter-Desk');
    const docId = await ts.addDoc(deskId, 'Vertrag.pdf');
    const r = await ts.mcpClient.callTool({ name: 'extract_page', arguments: { deskId, docId, page: 2, x: 300, y: 40 } });
    expect(r.isError).toBeFalsy();
    const s = await getState(ts.deskUrl, ts.token, deskId);
    expect(s.state.docs).toHaveLength(2);
    const seite = s.state.docs.find((d) => d.id !== docId)! as { pageOnly?: number; name: string };
    expect(seite.pageOnly).toBe(2);
    expect(seite.name).toContain('S. 2');
  });
});

describe('Neue Schreib-Tools (Stempel, Fahnen, Heften, Klammern, Korb, To-do)', () => {
  it('add_stamp: Preset landet mit korrekter Farbe im State, Position oben rechts', async () => {
    const deskId = await ts.createDesk('Stempel-Desk');
    const docId = await ts.addDoc(deskId, 'Vertrag.pdf');
    const r = await ts.mcpClient.callTool({ name: 'add_stamp', arguments: { deskId, docId, page: 1, preset: 'ERLEDIGT' } });
    expect(r.isError).toBeFalsy();
    const s = await getState(ts.deskUrl, ts.token, deskId);
    expect(s.state.stamps).toHaveLength(1);
    const stamp = s.state.stamps![0];
    expect(stamp.text).toBe('ERLEDIGT');
    expect(stamp.color).toBe('red');
    expect(stamp.x > stamp.baseW / 2 && stamp.y < stamp.baseH / 4).toBe(true);
  });

  it('add_stamp: freeText wird deanonymisiert', async () => {
    const deskId = await ts.createDesk('Stempel-Freitext-Desk');
    await ts.addDoc(deskId, 'Rechnung Max Mustermann.pdf');
    await ts.mcpClient.callTool({ name: 'get_desk', arguments: { deskId } }); // füllt Mapping
    const docId = await ts.addDoc(deskId, 'Vertrag.pdf');
    const r = await ts.mcpClient.callTool({
      name: 'add_stamp',
      arguments: { deskId, docId, page: 1, freeText: 'Für [[Person-TEST1]]' },
    });
    expect(r.isError).toBeFalsy();
    const s = await getState(ts.deskUrl, ts.token, deskId);
    expect(s.state.stamps![0].text).toBe('Für Max Mustermann');
    expect(s.state.stamps![0].color).toBe('blue');
  });

  it('add_stamp: Preset EINGANG trägt ein Datum', async () => {
    const deskId = await ts.createDesk('Stempel-Eingang-Desk');
    const docId = await ts.addDoc(deskId, 'Post.pdf');
    const r = await ts.mcpClient.callTool({ name: 'add_stamp', arguments: { deskId, docId, page: 1, preset: 'EINGANG' } });
    expect(r.isError).toBeFalsy();
    const s = await getState(ts.deskUrl, ts.token, deskId);
    expect(typeof s.state.stamps![0].date).toBe('string');
  });

  it('remove_stamp entfernt einen Stempel wieder', async () => {
    const deskId = await ts.createDesk('Stempel-Entfernen-Desk');
    const docId = await ts.addDoc(deskId, 'Vertrag.pdf');
    const angelegt = JSON.parse(textOf(await ts.mcpClient.callTool({
      name: 'add_stamp', arguments: { deskId, docId, page: 1, preset: 'KOPIE' },
    })));
    await ts.mcpClient.callTool({ name: 'remove_stamp', arguments: { deskId, stampId: angelegt.id } });
    const s = await getState(ts.deskUrl, ts.token, deskId);
    expect(s.state.stamps).toHaveLength(0);
  });

  it('add_flag/remove_flag: Farbe wird gemappt, Offset wächst je Fahne am Dokument', async () => {
    const deskId = await ts.createDesk('Fahnen-Desk');
    const docId = await ts.addDoc(deskId, 'Akte.pdf');
    const r1 = await ts.mcpClient.callTool({ name: 'add_flag', arguments: { deskId, docId, page: 1, color: 'gelb' } });
    expect(r1.isError).toBeFalsy();
    const r2 = await ts.mcpClient.callTool({ name: 'add_flag', arguments: { deskId, docId, page: 2, color: 'gruen' } });
    expect(r2.isError).toBeFalsy();
    const s = await getState(ts.deskUrl, ts.token, deskId);
    expect(s.state.flags).toHaveLength(2);
    expect(s.state.flags![0].color).toBe('#f5c518');
    expect(s.state.flags![0].offset).toBeCloseTo(0.08);
    expect(s.state.flags![1].color).toBe('#30a46c');
    expect(s.state.flags![1].offset).toBeCloseTo(0.26);

    const id2 = JSON.parse(textOf(r2)).id;
    await ts.mcpClient.callTool({ name: 'remove_flag', arguments: { deskId, flagId: id2 } });
    const s2 = await getState(ts.deskUrl, ts.token, deskId);
    expect(s2.state.flags).toHaveLength(1);
  });

  it('staple_stack/unstaple_stack: Konvolut-Status wird umgeschaltet', async () => {
    const deskId = await ts.createDesk('Heft-Desk');
    const a = await ts.addDoc(deskId, 'A.pdf');
    const b = await ts.addDoc(deskId, 'B.pdf');
    await ts.mcpClient.callTool({ name: 'stack_documents', arguments: { deskId, draggedId: a, targetId: b } });
    const stackId = (await getState(ts.deskUrl, ts.token, deskId)).state.stacks[0].id;

    const r = await ts.mcpClient.callTool({ name: 'staple_stack', arguments: { deskId, stackId } });
    expect(r.isError).toBeFalsy();
    expect((await getState(ts.deskUrl, ts.token, deskId)).state.stacks[0].stapled).toBe(true);

    const r2 = await ts.mcpClient.callTool({ name: 'unstaple_stack', arguments: { deskId, stackId } });
    expect(r2.isError).toBeFalsy();
    expect((await getState(ts.deskUrl, ts.token, deskId)).state.stacks[0].stapled).toBe(false);
  });

  it('clip_objects/remove_clip: Klammer-Gruppe entsteht und lässt sich lösen', async () => {
    const deskId = await ts.createDesk('Klammer-Desk');
    const a = await ts.addDoc(deskId, 'A.pdf');
    const b = await ts.addDoc(deskId, 'B.pdf');
    const r = await ts.mcpClient.callTool({ name: 'clip_objects', arguments: { deskId, aId: a, bId: b } });
    expect(r.isError).toBeFalsy();
    const s = await getState(ts.deskUrl, ts.token, deskId);
    expect(s.state.clips).toHaveLength(1);
    const clipId = s.state.clips![0].id;
    await ts.mcpClient.callTool({ name: 'remove_clip', arguments: { deskId, clipId } });
    const s2 = await getState(ts.deskUrl, ts.token, deskId);
    expect(s2.state.clips).toHaveLength(0);
  });

  it('trash_object/restore_trash: Objekt landet im Korb und lässt sich zurückholen', async () => {
    const deskId = await ts.createDesk('Korb-Desk');
    const docId = await ts.addDoc(deskId, 'A.pdf');
    const r = await ts.mcpClient.callTool({ name: 'trash_object', arguments: { deskId, objectId: docId } });
    expect(r.isError).toBeFalsy();
    let s = await getState(ts.deskUrl, ts.token, deskId);
    expect(s.state.trash).toHaveLength(1);
    expect(s.state.docs).toHaveLength(0);
    const trashId = s.state.trash![0].id;

    const r2 = await ts.mcpClient.callTool({ name: 'restore_trash', arguments: { deskId, trashId } });
    expect(r2.isError).toBeFalsy();
    s = await getState(ts.deskUrl, ts.token, deskId);
    expect(s.state.trash).toHaveLength(0);
    expect(s.state.docs).toHaveLength(1);
  });

  it('set_note_done: hakt einen To-do-Zettel ab und wieder auf', async () => {
    const deskId = await ts.createDesk('Todo-Desk');
    const note = JSON.parse(textOf(await ts.mcpClient.callTool({
      name: 'add_note', arguments: { deskId, kind: 'todo', text: 'Frist prüfen', x: 0, y: 0 },
    })));
    const r = await ts.mcpClient.callTool({ name: 'set_note_done', arguments: { deskId, noteId: note.id, done: true } });
    expect(r.isError).toBeFalsy();
    let s = await getState(ts.deskUrl, ts.token, deskId);
    expect(s.state.notes![0].done).toBe(true);
    await ts.mcpClient.callTool({ name: 'set_note_done', arguments: { deskId, noteId: note.id, done: false } });
    s = await getState(ts.deskUrl, ts.token, deskId);
    expect(s.state.notes![0].done).toBe(false);
  });

  it('add_note: kind "rechtsfrage" wird akzeptiert', async () => {
    const deskId = await ts.createDesk('Rechtsfrage-Desk');
    const r = await ts.mcpClient.callTool({
      name: 'add_note', arguments: { deskId, kind: 'rechtsfrage', text: 'Verjährt das?', x: 0, y: 0 },
    });
    expect(r.isError).toBeFalsy();
    const s = await getState(ts.deskUrl, ts.token, deskId);
    expect(s.state.notes![0].kind).toBe('rechtsfrage');
  });

  it('add_note: kind "eigen" mit customLabel wird deanonymisiert durchgereicht', async () => {
    const deskId = await ts.createDesk('Eigen-Desk');
    await ts.addDoc(deskId, 'Rechnung Max Mustermann.pdf');
    await ts.mcpClient.callTool({ name: 'get_desk', arguments: { deskId } }); // füllt Mapping
    const r = await ts.mcpClient.callTool({
      name: 'add_note',
      arguments: { deskId, kind: 'eigen', text: 'Sonderfall', customLabel: '[[Person-TEST1]]', x: 0, y: 0 },
    });
    expect(r.isError).toBeFalsy();
    const s = await getState(ts.deskUrl, ts.token, deskId);
    expect(s.state.notes![0].customLabel).toBe('Max Mustermann');
  });

  it('add_note: kind "eigen" ohne customLabel schlägt fehl', async () => {
    const deskId = await ts.createDesk('Eigen-Fehler-Desk');
    const r = await ts.mcpClient.callTool({
      name: 'add_note', arguments: { deskId, kind: 'eigen', text: 'Sonderfall', x: 0, y: 0 },
    });
    expect(r.isError).toBe(true);
  });
});
