import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestSetup, type TestSetup } from './testServer';
import { getState, listDesks, sendCommand } from './deskApi';

/**
 * Bestands-Schreib-Suite, 12-05 auf die Vorschlagsfläche gepflegt: die 24 Direkt-Tools sind
 * durch 19 propose_*-Tools ersetzt (LOESCH-Tools ersatzlos entfallen). Jeder umgestellte
 * Test trägt einen Kommentar, wo seine frühere Schutzfunktion weiterlebt — entweder hier
 * (gegen das Register statt den Desk-State) oder in der adversarialen Gate-Suite
 * (tools-propose.test.ts: tools/list-Vollständigkeit, rev-Identität, Protokollstrenge).
 */

let ts: TestSetup;
beforeAll(async () => {
  ts = await startTestSetup();
});
afterAll(async () => {
  await ts.stop();
});
const textOf = (r: { content: unknown }) => (r.content as { text: string }[]).map((c) => c.text).join('');

interface VorschlagZeile {
  id: string;
  art: string;
  payload: Record<string, unknown>;
  status: string;
}

/** Registerzeilen über die REST-Liste des Test-Tokens (Plan 12-03). */
async function vorschlaegeLaden(deskId: string): Promise<VorschlagZeile[]> {
  const res = await fetch(`${ts.deskUrl}/api/v1/desks/${deskId}/vorschlaege`, {
    headers: { authorization: `Bearer ${ts.token}` },
  });
  expect(res.ok).toBe(true);
  return ((await res.json()) as { vorschlaege: VorschlagZeile[] }).vorschlaege;
}

const ergebnisVon = (r: { content: unknown }) => JSON.parse(textOf(r)) as { vorschlagId: string; status: string };

describe('Organisier-Tools (12-05: Vorschlagsfläche)', () => {
  it('propose_move_document/stack_documents/rename_stack registrieren Vorschläge — Desk-rev bleibt unverändert', async () => {
    // Schutzfunktion des alten Direkt-Tests (Organisier-Werkzeuge + deanon im Stapelnamen)
    // lebt hier weiter — Ziel der Assertion ist jetzt das REGISTER (Wirkung erst nach
    // Genehmigung); die rev-Identität beweist die Gate-Semantik direkt mit.
    const deskId = await ts.createDesk('Orga');
    const a = await ts.addDoc(deskId, 'Rechnung Max Mustermann.pdf');
    const b = await ts.addDoc(deskId, 'Brief.pdf');
    await ts.mcpClient.callTool({ name: 'get_desk', arguments: { deskId } }); // füllt Mapping ([[Person-TEST1]])

    const revVorher = (await getState(ts.deskUrl, ts.token, deskId)).rev;

    const mv = await ts.mcpClient.callTool({ name: 'propose_move_document', arguments: { deskId, docId: a, x: 100, y: 50 } });
    expect(mv.isError).toBeFalsy();
    expect(ergebnisVon(mv).status).toBe('ausstehend');

    const st = await ts.mcpClient.callTool({ name: 'propose_stack_documents', arguments: { deskId, draggedId: a, targetId: b } });
    expect(st.isError).toBeFalsy();

    const rn = await ts.mcpClient.callTool({
      name: 'propose_rename_stack',
      arguments: { deskId, stackId: 'stapel-fixture', name: 'Unterlagen [[Person-TEST1]]' },
    });
    expect(rn.isError).toBeFalsy();

    const s = await getState(ts.deskUrl, ts.token, deskId);
    expect(s.rev).toBe(revVorher);
    expect(s.state.stacks).toHaveLength(0);

    const zeilen = await vorschlaegeLaden(deskId);
    expect(zeilen).toHaveLength(3);
    // deanon-Beweis: der Vorschlag trägt den Klartext-Namen.
    expect(zeilen.find((z) => z.art === 'renameStack')?.payload.name).toBe('Unterlagen Max Mustermann');
  });

  it('propose_link_documents + propose_set_link_note; remove_link ist entfallen; create_desk/rename_desk unverändert', async () => {
    // Schutzfunktion (Schnur-Werkzeuge erreichbar, Desk-Verwaltung stabil) weiter an der
    // Vorschlagsfläche; remove_link entfällt ersatzlos (12-05) — die Abwesenheit aller
    // LOESCH-Namen beweist die Gate-Suite (tools-propose.test.ts).
    const deskId = await ts.createDesk('Links');
    const a = await ts.addDoc(deskId, 'A.pdf');
    const b = await ts.addDoc(deskId, 'B.pdf');
    ts.legeSeitenAnFuerDoc(deskId, a, [{ page: 1, pdfText: 'Querschnittsdarstellung der Beweislage.' }]);

    const ln = await ts.mcpClient.callTool({
      name: 'propose_link_documents',
      arguments: { deskId, fromId: a, toId: b, quelle: { dokumentId: a, seite: 1, zitat: 'Beweislage' } },
    });
    expect(ln.isError).toBeFalsy();

    await sendCommand(ts.deskUrl, ts.token, deskId, { type: 'addLink', payload: { fromId: b, toId: a } });
    const linkId = (await getState(ts.deskUrl, ts.token, deskId)).state.links[0].id;
    const sln = await ts.mcpClient.callTool({ name: 'propose_set_link_note', arguments: { deskId, linkId, note: 'gehört zusammen' } });
    expect(sln.isError).toBeFalsy();

    const alt = await ts.mcpClient.callTool({ name: 'remove_link', arguments: { deskId, linkId } });
    expect(alt.isError).toBe(true);
    expect(textOf(alt)).toContain('not found');

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
    // Die vollständige Abwesenheits-Assertion aller 24 alten Direkt-Namen (inkl. der fünf
    // LOESCH-Tools) liegt in tools-propose.test.ts — hier bleibt der historische Kern.
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

  it('Layout-Vorschläge ohne Textbezug funktionieren auch bei anymize-Ausfall', async () => {
    // Schutzfunktion des alten Tests (Layout-Tools brauchen keine Anonymisierung) —
    // propose_move_document hat keine Textfelder, also auch keinen anymize-Pfad.
    const deskId = await ts.createDesk('Offline-Orga');
    const docId = await ts.addDoc(deskId, 'A.pdf');
    ts.setAnymizeDown(true);
    const r = await ts.mcpClient.callTool({ name: 'propose_move_document', arguments: { deskId, docId, x: 5, y: 5 } });
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

describe('Vision-Objekte (Zettel, Schnüre, Enthefter) — 12-05: Vorschlagsfläche', () => {
  it('propose_add_note mit Platzhalter → Klartext im Register-payload; get_desk anonymisiert weiter', async () => {
    // Schutzfunktion des alten add_note-Tests (Platzhalter→Klartext beim Schreiben,
    // Anonymität beim Lesen) — jetzt gegen das Register statt den Desk-State; der
    // formale Gate-Beweis (rev, Registerzeile) liegt in tools-propose.test.ts.
    const deskId = await ts.createDesk('Zettel-Desk');
    const docId = await ts.addDoc(deskId, 'Rechnung Max Mustermann.pdf');
    ts.legeSeitenAnFuerDoc(deskId, docId, [{ page: 1, pdfText: 'Zahlungseingang verbucht.' }]);
    await ts.mcpClient.callTool({ name: 'get_desk', arguments: { deskId } }); // füllt Mapping

    const r = await ts.mcpClient.callTool({
      name: 'propose_add_note',
      arguments: {
        deskId, kind: 'frage', text: 'Hat [[Person-TEST1]] bezahlt?', x: 10, y: 20,
        quelle: { dokumentId: docId, seite: 1, zitat: 'Zahlungseingang' },
      },
    });
    expect(r.isError).toBeFalsy();
    const zeilen = await vorschlaegeLaden(deskId);
    expect(zeilen).toHaveLength(1);
    expect(zeilen[0].payload.text).toBe('Hat Max Mustermann bezahlt?'); // Klartext im Register
    expect(zeilen[0].payload.kind).toBe('frage');

    const s = await getState(ts.deskUrl, ts.token, deskId);
    expect(s.state.notes ?? []).toHaveLength(0); // Gate: nichts auf dem Tisch

    const gd = await ts.mcpClient.callTool({ name: 'get_desk', arguments: { deskId } });
    expect(textOf(gd)).toContain('[[Person-TEST1]]');
    expect(textOf(gd)).not.toContain('Max Mustermann');
  });

  it('remove_note ist ersatzlos entfallen — KI-Aufräumen heißt propose_trash_object', async () => {
    // Schutzfunktion des alten Schnur-Abräum-Tests entfällt mit dem LOESCH-Weg (12-05,
    // ersatzlos); die Abwesenheit aller fünf LOESCH-Namen beweist die Gate-Suite.
    const deskId = await ts.createDesk('Schnur-Desk');
    await sendCommand(ts.deskUrl, ts.token, deskId, {
      type: 'addNote', payload: { id: 'n-fixture', kind: 'notiz', text: 'Frist prüfen', position: { x: 0, y: 0 } },
    });
    const alt = await ts.mcpClient.callTool({ name: 'remove_note', arguments: { deskId, noteId: 'n-fixture' } });
    expect(alt.isError).toBe(true);
    expect(textOf(alt)).toContain('not found');

    const korb = await ts.mcpClient.callTool({ name: 'propose_trash_object', arguments: { deskId, objectId: 'n-fixture' } });
    expect(korb.isError).toBeFalsy();
    const zeilen = await vorschlaegeLaden(deskId);
    expect(zeilen[0].art).toBe('trashObject');
    // Gate: der Zettel liegt unverändert auf dem Tisch.
    expect((await getState(ts.deskUrl, ts.token, deskId)).state.notes).toHaveLength(1);
  });

  it('propose_extract_page registriert einen Vorschlag — keine neue Karte vor der Genehmigung', async () => {
    const deskId = await ts.createDesk('Enthefter-Desk');
    const docId = await ts.addDoc(deskId, 'Vertrag.pdf');
    ts.legeSeitenAnFuerDoc(deskId, docId, [{ page: 2, pdfText: 'Kündigungsklausel in Abschnitt sieben.' }]);
    const r = await ts.mcpClient.callTool({
      name: 'propose_extract_page',
      arguments: {
        deskId, docId, page: 2, x: 300, y: 40,
        quelle: { dokumentId: docId, seite: 2, zitat: 'Kündigungsklausel' },
      },
    });
    expect(r.isError).toBeFalsy();
    const zeilen = await vorschlaegeLaden(deskId);
    expect(zeilen[0].art).toBe('extractPage');
    expect((await getState(ts.deskUrl, ts.token, deskId)).state.docs).toHaveLength(1);
  });
});

describe('Vorschlags-Tools (Stempel, Fahnen, Heften, Klammern, Korb, To-do)', () => {
  it('propose_add_stamp: Preset landet mit korrekter Farbe im Register, Position oben rechts', async () => {
    // Schutzfunktion des alten add_stamp-Tests — Ziel jetzt das Register-payload.
    // CR-01: das Register-Payload ist FLACH (kanonische Register-Wahrheit) — die Assertions
    // lesen die Felder auf Top-Ebene, kein verschachteltes payload.stamp mehr.
    const deskId = await ts.createDesk('Stempel-Desk');
    const docId = await ts.addDoc(deskId, 'Vertrag.pdf');
    const r = await ts.mcpClient.callTool({ name: 'propose_add_stamp', arguments: { deskId, docId, page: 1, preset: 'ERLEDIGT' } });
    expect(r.isError).toBeFalsy();
    const zeilen = await vorschlaegeLaden(deskId);
    const stamp = zeilen[0].payload as { text: string; color: string; x: number; y: number; baseW: number; baseH: number };
    expect(stamp.text).toBe('ERLEDIGT');
    expect(stamp.color).toBe('red');
    expect(stamp.x > stamp.baseW / 2 && stamp.y < stamp.baseH / 4).toBe(true);
    expect((await getState(ts.deskUrl, ts.token, deskId)).state.stamps ?? []).toHaveLength(0);
  });

  it('propose_add_stamp: freeText wird deanonymisiert durchgereicht', async () => {
    const deskId = await ts.createDesk('Stempel-Freitext-Desk');
    const docId = await ts.addDoc(deskId, 'Rechnung Max Mustermann.pdf');
    await ts.mcpClient.callTool({ name: 'get_desk', arguments: { deskId } }); // füllt Mapping
    const r = await ts.mcpClient.callTool({
      name: 'propose_add_stamp',
      arguments: { deskId, docId, page: 1, freeText: 'Für [[Person-TEST1]]' },
    });
    expect(r.isError).toBeFalsy();
    const zeilen = await vorschlaegeLaden(deskId);
    const stamp = zeilen[0].payload as { text: string; color: string };
    expect(stamp.text).toBe('Für Max Mustermann');
    expect(stamp.color).toBe('blue');
  });

  it('propose_add_stamp: Preset EINGANG trägt ein Datum', async () => {
    const deskId = await ts.createDesk('Stempel-Eingang-Desk');
    const docId = await ts.addDoc(deskId, 'Post.pdf');
    const r = await ts.mcpClient.callTool({ name: 'propose_add_stamp', arguments: { deskId, docId, page: 1, preset: 'EINGANG' } });
    expect(r.isError).toBeFalsy();
    const zeilen = await vorschlaegeLaden(deskId);
    expect(typeof (zeilen[0].payload as { date?: string }).date).toBe('string');
  });

  it('propose_add_stamp: freeText über 2000 Zeichen wird am Schema abgelehnt (WR-05: Budget-Deckel)', async () => {
    const deskId = await ts.createDesk('Stempel-Budget-Desk');
    const docId = await ts.addDoc(deskId, 'Lang.pdf');
    const r = await ts.mcpClient.callTool({
      name: 'propose_add_stamp', arguments: { deskId, docId, page: 1, freeText: 'x'.repeat(2001) },
    });
    expect(r.isError).toBe(true);
    expect(await vorschlaegeLaden(deskId)).toHaveLength(0);
  });

  it('remove_stamp/remove_flag/remove_clip sind entfallen — Protokollfehler', async () => {
    // LOESCH-Tools entfallen ersatzlos (12-05); Vollständigkeit in tools-propose.test.ts.
    const deskId = await ts.createDesk('Loesch-Desk');
    for (const [name, args] of [
      ['remove_stamp', { deskId, stampId: 'x' }],
      ['remove_flag', { deskId, flagId: 'x' }],
      ['remove_clip', { deskId, clipId: 'x' }],
    ] as const) {
      const r = await ts.mcpClient.callTool({ name, arguments: args });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toContain('not found');
    }
  });

  it('propose_add_flag: Farbe wird gemappt, erste Fahne am Dokument mit Basis-Offset', async () => {
    // Schutzfunktion des alten add_flag-Tests (Farb-Mapping, Offset-Konvention) — gegen das
    // Register. Die Offset-STAFFELUNG je weiterer Fahne entsteht erst bei der Genehmigung:
    // wartende Vorschläge kennen einander nicht (12-05, dokumentierte Einschränkung).
    const deskId = await ts.createDesk('Fahnen-Desk');
    const docId = await ts.addDoc(deskId, 'Akte.pdf');
    const r = await ts.mcpClient.callTool({ name: 'propose_add_flag', arguments: { deskId, docId, page: 1, color: 'gelb' } });
    expect(r.isError).toBeFalsy();
    const zeilen = await vorschlaegeLaden(deskId);
    const flag = zeilen[0].payload as { color: string; offset: number };
    expect(flag.color).toBe('#f5c518');
    expect(flag.offset).toBeCloseTo(0.08);
    expect((await getState(ts.deskUrl, ts.token, deskId)).state.flags ?? []).toHaveLength(0);
  });

  it('propose_staple_stack/propose_unstaple_stack registrieren Vorschläge', async () => {
    const deskId = await ts.createDesk('Heft-Desk');
    const a = await ts.addDoc(deskId, 'A.pdf');
    const b = await ts.addDoc(deskId, 'B.pdf');
    await sendCommand(ts.deskUrl, ts.token, deskId, { type: 'stackDocs', payload: { draggedId: a, targetId: b } });
    const stackId = (await getState(ts.deskUrl, ts.token, deskId)).state.stacks[0].id;

    const r = await ts.mcpClient.callTool({ name: 'propose_staple_stack', arguments: { deskId, stackId } });
    expect(r.isError).toBeFalsy();
    const r2 = await ts.mcpClient.callTool({ name: 'propose_unstaple_stack', arguments: { deskId, stackId } });
    expect(r2.isError).toBeFalsy();
    const zeilen = await vorschlaegeLaden(deskId);
    expect(zeilen.map((z) => z.art)).toEqual(['stapleStack', 'unstapleStack']);
    // Gate: der Konvolut-Status ist unverändert.
    expect((await getState(ts.deskUrl, ts.token, deskId)).state.stacks[0].stapled).toBeFalsy();
  });

  it('propose_clip_objects registriert einen Vorschlag', async () => {
    const deskId = await ts.createDesk('Klammer-Desk');
    const a = await ts.addDoc(deskId, 'A.pdf');
    const b = await ts.addDoc(deskId, 'B.pdf');
    const r = await ts.mcpClient.callTool({ name: 'propose_clip_objects', arguments: { deskId, aId: a, bId: b } });
    expect(r.isError).toBeFalsy();
    const zeilen = await vorschlaegeLaden(deskId);
    expect(zeilen[0].art).toBe('addClip');
    expect((await getState(ts.deskUrl, ts.token, deskId)).state.clips ?? []).toHaveLength(0);
  });

  it('propose_trash_object/propose_restore_trash registrieren Vorschläge', async () => {
    const deskId = await ts.createDesk('Korb-Desk');
    const docId = await ts.addDoc(deskId, 'A.pdf');
    const r = await ts.mcpClient.callTool({ name: 'propose_trash_object', arguments: { deskId, objectId: docId } });
    expect(r.isError).toBeFalsy();
    // Gate: die Karte liegt unverändert auf dem Tisch.
    expect((await getState(ts.deskUrl, ts.token, deskId)).state.docs).toHaveLength(1);

    await sendCommand(ts.deskUrl, ts.token, deskId, {
      type: 'trashObject', payload: { id: docId, trashedAt: new Date().toISOString() },
    });
    const trashId = (await getState(ts.deskUrl, ts.token, deskId)).state.trash![0].id;
    const r2 = await ts.mcpClient.callTool({ name: 'propose_restore_trash', arguments: { deskId, trashId } });
    expect(r2.isError).toBeFalsy();
    const zeilen = await vorschlaegeLaden(deskId);
    expect(zeilen.map((z) => z.art)).toEqual(['trashObject', 'restoreObject']);
  });

  it('propose_set_note_done registriert einen Vorschlag', async () => {
    const deskId = await ts.createDesk('Todo-Desk');
    await sendCommand(ts.deskUrl, ts.token, deskId, {
      type: 'addNote', payload: { id: 'n-todo', kind: 'todo', text: 'Frist prüfen', position: { x: 0, y: 0 } },
    });
    const r = await ts.mcpClient.callTool({ name: 'propose_set_note_done', arguments: { deskId, noteId: 'n-todo', done: true } });
    expect(r.isError).toBeFalsy();
    const zeilen = await vorschlaegeLaden(deskId);
    expect(zeilen[0].art).toBe('setNoteDone');
    expect(zeilen[0].payload.done).toBe(true);
    // Gate: der Zettel ist nicht abgehakt.
    expect((await getState(ts.deskUrl, ts.token, deskId)).state.notes![0].done).toBeFalsy();
  });

  it('propose_add_note: kind "rechtsfrage" wird akzeptiert', async () => {
    const deskId = await ts.createDesk('Rechtsfrage-Desk');
    const docId = await ts.addDoc(deskId, 'Schriftsatz.pdf');
    ts.legeSeitenAnFuerDoc(deskId, docId, [{ page: 1, pdfText: 'Verjährungseinrede erhoben.' }]);
    const r = await ts.mcpClient.callTool({
      name: 'propose_add_note',
      arguments: {
        deskId, kind: 'rechtsfrage', text: 'Verjährt das?', x: 0, y: 0,
        quelle: { dokumentId: docId, seite: 1, zitat: 'Verjährungseinrede' },
      },
    });
    expect(r.isError).toBeFalsy();
    expect((await vorschlaegeLaden(deskId))[0].payload.kind).toBe('rechtsfrage');
  });

  it('propose_add_note: kind "eigen" ist nicht vorschlagsfähig → Protokollablehnung', async () => {
    // Schutzfunktion der alten eigen-Tests entfällt bewusst: customLabel ist bei 'eigen'
    // Pflicht (notes.ts), die Genehmigungs-Abbildung (vorschlagAnwenden addNote) trägt es
    // nicht — ein eigen-Vorschlag wäre strukturell nicht genehmigbar, darum scheitert der
    // Call bereits am Schema (12-05-Entscheidung, SUMMARY).
    const deskId = await ts.createDesk('Eigen-Desk');
    const docId = await ts.addDoc(deskId, 'Dok.pdf');
    ts.legeSeitenAnFuerDoc(deskId, docId, [{ page: 1, pdfText: 'Beliebiger Inhalt.' }]);
    const r = await ts.mcpClient.callTool({
      name: 'propose_add_note',
      arguments: {
        deskId, kind: 'eigen', text: 'Sonderfall', customLabel: 'X', x: 0, y: 0,
        quelle: { dokumentId: docId, seite: 1, zitat: 'Inhalt' },
      },
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('Invalid arguments');
    expect(await vorschlaegeLaden(deskId)).toHaveLength(0);
  });
});

describe('Ende-zu-Ende über die REST-Grenze (CR-01): MCP-Stempel-/Fahnen-Vorschlag bis zur Genehmigung', () => {
  /** Genehmigungs-Route als Mensch (Self-Approval-Verbot gilt nur für die MCP-Fläche). */
  async function genehmigen(deskId: string, vorschlagId: string): Promise<number> {
    const res = await fetch(`${ts.deskUrl}/api/v1/desks/${deskId}/vorschlaege/${vorschlagId}/genehmigen`, {
      method: 'POST', headers: { authorization: `Bearer ${ts.token}` },
    });
    return res.status;
  }

  it('propose_add_stamp (Preset) fährt bis zur Genehmigung durch: 200, Stempel regulär auf dem Desk', async () => {
    // Beweis des CR-01-Bruchs und seines Fixes: das MCP-Register-Payload (flach) muss der
    // Genehmigungspfad (vorschlagAnwenden, flacher Vertrag) ohne 500 verarbeiten können.
    const deskId = await ts.createDesk('Stempel-Genehmigungs-Desk');
    const docId = await ts.addDoc(deskId, 'Vertrag.pdf');
    const r = await ts.mcpClient.callTool({ name: 'propose_add_stamp', arguments: { deskId, docId, page: 1, preset: 'ERLEDIGT' } });
    expect(r.isError).toBeFalsy();
    const { vorschlagId } = ergebnisVon(r);

    expect(await genehmigen(deskId, vorschlagId)).toBe(200);

    const stamps = (await getState(ts.deskUrl, ts.token, deskId)).state.stamps ?? [];
    expect(stamps).toHaveLength(1);
    expect(stamps[0]).toMatchObject({ docId, page: 1, text: 'ERLEDIGT', color: 'red' });
  });

  it('propose_add_stamp (freeText) fährt bis zur Genehmigung durch: 200, Stempel mit Klartext', async () => {
    const deskId = await ts.createDesk('Stempel-Freitext-Genehmigungs-Desk');
    const docId = await ts.addDoc(deskId, 'Rechnung Max Mustermann.pdf');
    await ts.mcpClient.callTool({ name: 'get_desk', arguments: { deskId } }); // füllt Mapping
    const r = await ts.mcpClient.callTool({
      name: 'propose_add_stamp', arguments: { deskId, docId, page: 1, freeText: 'Für [[Person-TEST1]]' },
    });
    expect(r.isError).toBeFalsy();
    const { vorschlagId } = ergebnisVon(r);

    expect(await genehmigen(deskId, vorschlagId)).toBe(200);

    const stamps = (await getState(ts.deskUrl, ts.token, deskId)).state.stamps ?? [];
    expect(stamps).toHaveLength(1);
    expect(stamps[0]).toMatchObject({ docId, page: 1, text: 'Für Max Mustermann', color: 'blue' });
  });

  it('propose_add_flag fährt bis zur Genehmigung durch: 200, Fahne regulär am Dokument', async () => {
    const deskId = await ts.createDesk('Fahnen-Genehmigungs-Desk');
    const docId = await ts.addDoc(deskId, 'Akte.pdf');
    const r = await ts.mcpClient.callTool({ name: 'propose_add_flag', arguments: { deskId, docId, page: 2, color: 'rot' } });
    expect(r.isError).toBeFalsy();
    const { vorschlagId } = ergebnisVon(r);

    expect(await genehmigen(deskId, vorschlagId)).toBe(200);

    const flags = (await getState(ts.deskUrl, ts.token, deskId)).state.flags ?? [];
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ docId, page: 2, color: '#e5484d' });
  });
});
