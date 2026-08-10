import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startTestSetup, type TestSetup } from './testServer';
import { getState } from './deskApi';

/**
 * Adversariale Gate-Suite (12-05, AI-SPEC Dimension 1 — Release-Blocker): beweist auf
 * Protokoll- UND Verhaltensebene, dass der MCP-Kanal nach dem Umbau nur noch Vorschläge
 * erzeugen kann. Die Suite läuft in jedem Standard-Testlauf — ein künftig versehentlich
 * hinzugefügtes Direkt-Tool (Pitfall 1: Gate-Umgehung durch ein übersehenes Tool) wird
 * sofort rot.
 */

let ts: TestSetup;
beforeAll(async () => {
  ts = await startTestSetup();
});
afterAll(async () => {
  await ts.stop();
});

const textOf = (r: { content: unknown }) => (r.content as { text: string }[]).map((c) => c.text).join('');

/** Lese-Allowlist (Vertrag, kein Zählen auf 19): alles außerhalb dieser Liste MUSS ein
 *  propose_*-Tool sein. create_desk/rename_desk sind Desk-Verwaltung (kein Desk-Inhalt). */
const LESE_ALLOWLIST = [
  'list_desks', 'get_desk', 'get_document_text', 'get_document_page_text',
  'deanonymize', 'create_desk', 'rename_desk',
];

/** Die 24 Direkt-Schreib-Namen des alten Stands — inkl. der fünf LOESCH-Tools, die
 *  ersatzlos entfallen (KI-Aufräumen läuft über propose_trash_object). */
const ALTE_DIREKT_NAMEN = [
  'move_document', 'stack_documents', 'remove_from_stack', 'dissolve_stack', 'rename_stack',
  'move_stack', 'link_documents', 'add_note', 'edit_note', 'remove_note', 'add_stamp',
  'remove_stamp', 'add_flag', 'remove_flag', 'staple_stack', 'unstaple_stack', 'clip_objects',
  'remove_clip', 'trash_object', 'restore_trash', 'set_note_done', 'extract_page',
  'set_link_note', 'remove_link',
];

interface VorschlagZeile {
  id: string;
  art: string;
  payload: Record<string, unknown>;
  status: string;
  zusammenfassung?: string;
}

/** Registerzeilen über die REST-Liste des Test-Tokens (Plan 12-03, projizierte GET-Route). */
async function vorschlaegeLaden(deskId: string): Promise<VorschlagZeile[]> {
  const res = await fetch(`${ts.deskUrl}/api/v1/desks/${deskId}/vorschlaege`, {
    headers: { authorization: `Bearer ${ts.token}` },
  });
  expect(res.ok).toBe(true);
  return ((await res.json()) as { vorschlaege: VorschlagZeile[] }).vorschlaege;
}

const SEITENTEXT = 'Am 12.03.2024 hat Max Mustermann den Betrag von 5.000 EUR gezahlt.';

/** Desk mit einem Dokument, dessen Seite 1 einen namenstragenden Klartext trägt; der
 *  get_document_page_text-Aufruf füllt das Mapping ([[Person-TEST1]]) wie im echten Lauf. */
async function deskMitDokument(name: string): Promise<{ deskId: string; docId: string }> {
  const deskId = await ts.createDesk(name);
  const docId = await ts.addDoc(deskId, 'Rechnung.pdf');
  ts.legeSeitenAnFuerDoc(deskId, docId, [{ page: 1, pdfText: SEITENTEXT }]);
  return { deskId, docId };
}

describe('tools/list: Gate-Vollständigkeit (Pitfall 1)', () => {
  it('jedes Tool außerhalb der Lese-Allowlist beginnt mit propose_', async () => {
    const tools = await ts.mcpClient.listTools();
    const namen = tools.tools.map((t) => t.name);
    for (const name of namen) {
      if (LESE_ALLOWLIST.includes(name)) continue;
      expect(name, `Tool "${name}" ist weder Lese-Allowlist noch propose_*`).toMatch(/^propose_/);
    }
    // Vollständigkeit der Allowlist selbst: kein erwartetes Lese-Tool darf fehlen.
    for (const name of LESE_ALLOWLIST) expect(namen).toContain(name);
  });

  it('die 24 alten Direkt-Namen kommen nicht in tools/list vor', async () => {
    const tools = await ts.mcpClient.listTools();
    const namen = tools.tools.map((t) => t.name);
    for (const alt of ALTE_DIREKT_NAMEN) expect(namen).not.toContain(alt);
  });

  it('kein Tool-Name enthält Genehmigungs-/Ablehnungs-/Rücknahme-Bestandteile (Self-Approval-Verbot)', async () => {
    const tools = await ts.mcpClient.listTools();
    for (const t of tools.tools) {
      expect(t.name).not.toMatch(/genehmig|ablehn|zurueck|approv|reject/i);
    }
  });
});

describe('Verhaltensbeweis: propose_* wirkt nicht auf den Desk', () => {
  it('rev identisch + keine Notiz nach propose_add_note; genau eine Registerzeile', async () => {
    const { deskId, docId } = await deskMitDokument('Gate-Desk');
    await ts.mcpClient.callTool({ name: 'get_document_page_text', arguments: { deskId, docId, seite: 1 } });

    const vorher = await getState(ts.deskUrl, ts.token, deskId);
    const r = await ts.mcpClient.callTool({
      name: 'propose_add_note',
      arguments: {
        deskId, kind: 'behauptung', text: 'Zahlung erfolgt', x: 10, y: 20,
        quelle: { dokumentId: docId, seite: 1, zitat: 'den Betrag von 5.000 EUR gezahlt' },
      },
    });
    expect(r.isError).toBeFalsy();
    const ergebnis = JSON.parse(textOf(r)) as { vorschlagId: string; status: string; kommandoAnzahl: number };
    expect(ergebnis.status).toBe('ausstehend');
    expect(ergebnis.kommandoAnzahl).toBe(1);

    const nachher = await getState(ts.deskUrl, ts.token, deskId);
    expect(nachher.rev).toBe(vorher.rev);
    expect(nachher.state.notes ?? []).toHaveLength(0);

    const zeilen = await vorschlaegeLaden(deskId);
    expect(zeilen).toHaveLength(1);
    expect(zeilen[0].id).toBe(ergebnis.vorschlagId);
    expect(zeilen[0].art).toBe('addNote');
  });

  it('propose_add_note ohne quelle → SDK-Protokollablehnung (kein Fachfehler), keine Registerzeile', async () => {
    const { deskId } = await deskMitDokument('Protokoll-Desk');
    const r = await ts.mcpClient.callTool({
      name: 'propose_add_note',
      arguments: { deskId, kind: 'notiz', text: 'Ohne Fundstelle', x: 0, y: 0 },
    });
    expect(r.isError).toBe(true);
    // Protokoll-Ebene (zod-Validierung der SDK VOR dem Handler), nicht das fachliche
    // fehler()-JSON mit grund — der Call hat den Handler nie erreicht.
    expect(textOf(r)).toContain('Invalid arguments');
    expect(textOf(r)).not.toContain('"grund"');
    expect(await vorschlaegeLaden(deskId)).toHaveLength(0);
  });

  it('nicht auflösbares Zitat → isError mit maschinenlesbarem grund zitat_nicht_auflösbar', async () => {
    const { deskId, docId } = await deskMitDokument('Zitat-Desk');
    const r = await ts.mcpClient.callTool({
      name: 'propose_add_note',
      arguments: {
        deskId, kind: 'behauptung', text: 'Erfundene Behauptung', x: 0, y: 0,
        quelle: { dokumentId: docId, seite: 1, zitat: 'dieser Wortlaut steht so nicht im Dokument' },
      },
    });
    expect(r.isError).toBe(true);
    const fehler = JSON.parse(textOf(r)) as { grund: string; detail: string; betroffeneQuelle?: Record<string, unknown> };
    expect(fehler.grund).toBe('zitat_nicht_auflösbar');
    // Retry-Kanal (CR-01 It. 2): betroffeneQuelle trägt nur noch dokumentId/seite — das Zitat
    // wird an der MCP-Naht gekürzt (der Server spiegelt es deanonymisiert = Klartext-Leck).
    expect(fehler.betroffeneQuelle).toEqual({ dokumentId: docId, seite: 1 });
    expect(await vorschlaegeLaden(deskId)).toHaveLength(0);
  });

  it('Deanonymisierungs-Orakel geschlossen (CR-01 It. 2): unlösbares Platzhalter-Zitat → KEIN Klartext in der Fehlerantwort', async () => {
    const { deskId, docId } = await deskMitDokument('Orakel-Desk');
    // Mapping füllen: der Agent kennt den Namen nur als [[Person-TEST1]].
    await ts.mcpClient.callTool({ name: 'get_document_page_text', arguments: { deskId, docId, seite: 1 } });

    const r = await ts.mcpClient.callTool({
      name: 'propose_add_note',
      arguments: {
        deskId, kind: 'behauptung', text: 'Orakel-Versuch', x: 0, y: 0,
        // Absichtlich unlösbar NACH deanon („Max Mustermann zzqwr" steht so nicht auf der Seite) —
        // genau der Angriffspfad: Platzhalter durchprobieren und das Klartext-Echo abgreifen.
        quelle: { dokumentId: docId, seite: 1, zitat: '[[Person-TEST1]] zzqwr' },
      },
    });
    expect(r.isError).toBe(true);
    const roh = textOf(r);
    const fehler = JSON.parse(roh) as { grund: string; betroffeneQuelle?: Record<string, unknown> };
    expect(fehler.grund).toBe('zitat_nicht_auflösbar');
    // Das Orakel ist geschlossen: der deanonymisierte Klartext-Name darf NIRGENDS in der
    // Fehlerantwort auftauchen — weder im Echo noch in detail/grund (byte-genau generisch).
    expect(roh).not.toContain('Max Mustermann');
    expect(fehler.betroffeneQuelle).toEqual({ dokumentId: docId, seite: 1 });
    expect(JSON.stringify(fehler.betroffeneQuelle)).not.toContain('zitat');
    expect(await vorschlaegeLaden(deskId)).toHaveLength(0);
  });

  it('namenstragendes Zitat mit Platzhalter → Erfolg (deanon VOR der Verifikation, Pitfall 2)', async () => {
    const { deskId, docId } = await deskMitDokument('Deanon-Desk');
    // Mapping füllen: der Agent kennt den Namen nur als [[Person-TEST1]].
    const seite = await ts.mcpClient.callTool({ name: 'get_document_page_text', arguments: { deskId, docId, seite: 1 } });
    expect(textOf(seite)).toContain('[[Person-TEST1]]');

    const r = await ts.mcpClient.callTool({
      name: 'propose_add_note',
      arguments: {
        deskId, kind: 'behauptung', text: 'Zahlung durch [[Person-TEST1]] erfolgt', x: 0, y: 0,
        quelle: { dokumentId: docId, seite: 1, zitat: '[[Person-TEST1]] den Betrag von 5.000 EUR gezahlt' },
      },
    });
    // Ohne deanon vor dem REST-Call verifizierte der Server „[[Person-TEST1]] …" gegen den
    // Klartext und der Call schlüge grundlos fehl — Erfolg beweist die Reihenfolge.
    expect(r.isError).toBeFalsy();
    const zeilen = await vorschlaegeLaden(deskId);
    expect(zeilen).toHaveLength(1);
    // Server speichert Klartext (Vertraulichkeit bleibt intern gewahrt).
    expect(zeilen[0].payload.text).toBe('Zahlung durch Max Mustermann erfolgt');
  });

  it('Idempotenz: Replay desselben idempotenzKey → dieselbe vorschlagId, genau eine Registerzeile', async () => {
    const { deskId, docId } = await deskMitDokument('Idempotenz-Desk');
    const schluessel = randomUUID();
    const aufruf = () => ts.mcpClient.callTool({
      name: 'propose_add_note',
      arguments: {
        deskId, kind: 'notiz', text: 'Einmalig', x: 0, y: 0,
        quelle: { dokumentId: docId, seite: 1, zitat: 'gezahlt' },
        idempotenzKey: schluessel,
      },
    });
    const r1 = await aufruf();
    const r2 = await aufruf();
    expect(r1.isError).toBeFalsy();
    expect(r2.isError).toBeFalsy();
    const id1 = (JSON.parse(textOf(r1)) as { vorschlagId: string }).vorschlagId;
    const id2 = (JSON.parse(textOf(r2)) as { vorschlagId: string }).vorschlagId;
    expect(id2).toBe(id1);
    expect(await vorschlaegeLaden(deskId)).toHaveLength(1);
  });

  it('Halluzinations-Feld im Call → SDK-Protokollablehnung, keine Registerzeile', async () => {
    const { deskId, docId } = await deskMitDokument('Strenge-Desk');
    const r = await ts.mcpClient.callTool({
      name: 'propose_add_note',
      arguments: {
        deskId, kind: 'notiz', text: 'Strenge-Test', x: 0, y: 0,
        quelle: { dokumentId: docId, seite: 1, zitat: 'gezahlt' },
        geistreich: true, // halluziniertes Feld — darf nicht still gestripped werden (Pitfall 4)
      },
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('Invalid arguments');
    expect(await vorschlaegeLaden(deskId)).toHaveLength(0);
  });
});

describe('Erfolgsnaht klartextfrei (CR-01 It. 3): propose-Erfolgsantwort spiegelt nur die Platzhalter-Form', () => {
  /** Gemeinsame Orakel-Assertion: die Erfolgsantwort (JSON-Text UND structuredContent) darf
   *  den deanonymisierten Klartext NIRGENDS enthalten; die Platzhalter-Form der eigenen
   *  Eingabe muss im Echo wiedererkennbar bleiben (kein Funktionsverlust für den Agenten). */
  function erwartePlatzhalterEcho(
    r: { isError?: boolean; content: unknown; structuredContent?: unknown },
    platzhalter: string,
  ): void {
    expect(r.isError).toBeFalsy();
    const roh = textOf(r);
    expect(roh).not.toContain('Max Mustermann');
    expect(JSON.stringify(r.structuredContent ?? {})).not.toContain('Max Mustermann');
    const erg = JSON.parse(roh) as { zusammenfassung: string; status: string };
    expect(erg.status).toBe('ausstehend');
    expect(erg.zusammenfassung).toContain(platzhalter);
  }

  it('propose_add_note: Echo in Platzhalter-Form, Register behält Klartext für die Prüffläche', async () => {
    const { deskId, docId } = await deskMitDokument('Echo-AddNote-Desk');
    await ts.mcpClient.callTool({ name: 'get_document_page_text', arguments: { deskId, docId, seite: 1 } });

    const r = await ts.mcpClient.callTool({
      name: 'propose_add_note',
      arguments: {
        deskId, kind: 'behauptung', text: 'Zahlung durch [[Person-TEST1]] erfolgt', x: 0, y: 0,
        quelle: { dokumentId: docId, seite: 1, zitat: 'gezahlt' },
      },
    });
    erwartePlatzhalterEcho(r, '[[Person-TEST1]]');

    // Register (menschliche Prüffläche) behält die Klartext-Fassung — gekürzt wird NUR das
    // Agenten-Echo.
    const zeilen = await vorschlaegeLaden(deskId);
    expect(zeilen).toHaveLength(1);
    expect(zeilen[0].zusammenfassung).toContain('Max Mustermann');
    expect(zeilen[0].payload.text).toBe('Zahlung durch Max Mustermann erfolgt');
  });

  it('propose_edit_note: Echo in Platzhalter-Form, Register in Klartext', async () => {
    const { deskId, docId } = await deskMitDokument('Echo-EditNote-Desk');
    await ts.mcpClient.callTool({ name: 'get_document_page_text', arguments: { deskId, docId, seite: 1 } });

    const r = await ts.mcpClient.callTool({
      name: 'propose_edit_note',
      arguments: {
        deskId, noteId: 'n-1', text: 'Neu: [[Person-TEST1]] hat gezahlt',
        quelle: { dokumentId: docId, seite: 1, zitat: 'gezahlt' },
      },
    });
    erwartePlatzhalterEcho(r, '[[Person-TEST1]]');

    const zeilen = await vorschlaegeLaden(deskId);
    expect(zeilen).toHaveLength(1);
    expect(zeilen[0].zusammenfassung).toContain('Max Mustermann');
  });

  it('propose_rename_stack: Echo in Platzhalter-Form, Register in Klartext', async () => {
    const { deskId, docId } = await deskMitDokument('Echo-RenameStack-Desk');
    await ts.mcpClient.callTool({ name: 'get_document_page_text', arguments: { deskId, docId, seite: 1 } });

    const r = await ts.mcpClient.callTool({
      name: 'propose_rename_stack',
      arguments: { deskId, stackId: 'st-1', name: 'Akte [[Person-TEST1]]' },
    });
    erwartePlatzhalterEcho(r, '[[Person-TEST1]]');

    const zeilen = await vorschlaegeLaden(deskId);
    expect(zeilen).toHaveLength(1);
    expect(zeilen[0].zusammenfassung).toContain('Max Mustermann');
  });

  it('propose_set_link_note: Echo in Platzhalter-Form, Register in Klartext', async () => {
    const { deskId, docId } = await deskMitDokument('Echo-SetLinkNote-Desk');
    await ts.mcpClient.callTool({ name: 'get_document_page_text', arguments: { deskId, docId, seite: 1 } });

    const r = await ts.mcpClient.callTool({
      name: 'propose_set_link_note',
      arguments: { deskId, linkId: 'l-1', note: 'Verweis auf [[Person-TEST1]]' },
    });
    erwartePlatzhalterEcho(r, '[[Person-TEST1]]');

    const zeilen = await vorschlaegeLaden(deskId);
    expect(zeilen).toHaveLength(1);
    expect(zeilen[0].zusammenfassung).toContain('Max Mustermann');
  });

  it('propose_add_stamp (freeText): Echo in Platzhalter-Form, Register in Klartext', async () => {
    const { deskId, docId } = await deskMitDokument('Echo-AddStamp-Desk');
    await ts.mcpClient.callTool({ name: 'get_document_page_text', arguments: { deskId, docId, seite: 1 } });

    const r = await ts.mcpClient.callTool({
      name: 'propose_add_stamp',
      arguments: { deskId, docId, page: 1, freeText: 'Eingang [[Person-TEST1]]' },
    });
    erwartePlatzhalterEcho(r, '[[Person-TEST1]]');

    const zeilen = await vorschlaegeLaden(deskId);
    expect(zeilen).toHaveLength(1);
    expect(zeilen[0].zusammenfassung).toContain('Max Mustermann');
  });
});

describe('get_document_page_text (seitenadressiertes Lesen, A6)', () => {
  it('liefert anonymisierten Text der richtigen Seite — Klartext-Name kommt nicht vor', async () => {
    const { deskId, docId } = await deskMitDokument('Seiten-Desk');
    ts.legeSeitenAnFuerDoc(deskId, docId, [
      { page: 1, pdfText: SEITENTEXT },
      { page: 2, pdfText: 'Seite zwei ohne Namensnennung.' },
    ]);

    const r = await ts.mcpClient.callTool({ name: 'get_document_page_text', arguments: { deskId, docId, seite: 1 } });
    expect(r.isError).toBeFalsy();
    const seite = JSON.parse(textOf(r)) as { seite: number; text: string };
    expect(seite.seite).toBe(1);
    expect(seite.text).toContain('[[Person-TEST1]]');
    expect(seite.text).not.toContain('Max Mustermann');
    expect(seite.text).toContain('5.000 EUR');

    const r2 = await ts.mcpClient.callTool({ name: 'get_document_page_text', arguments: { deskId, docId, seite: 2 } });
    expect(JSON.parse(textOf(r2)) as { text: string }).toEqual(
      expect.objectContaining({ text: expect.stringContaining('Seite zwei') }),
    );
  });

  it('unbekannte docId → generische Ablehnung ohne Existenz-Auskunft', async () => {
    const { deskId } = await deskMitDokument('Unbekannt-Desk');
    const r = await ts.mcpClient.callTool({ name: 'get_document_page_text', arguments: { deskId, docId: 'doc-gibts-nicht', seite: 1 } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('nicht gefunden oder nicht sichtbar');
  });
});

describe('MCP_ALLOW_DEANONYMIZE=false: Fehler- und Erfolgsnaht bleiben klartextfrei (CR-01 It. 2 + It. 3)', () => {
  // Eigenes Setup mit deaktiviertem Betreiber-Schalter: das deanonymize-Tool wird dann nicht
  // registriert (server.ts) — die 422-Fehlernaht darf dieses Verbot nicht still umgehen.
  let tsNoDeanon: TestSetup;
  beforeAll(async () => {
    tsNoDeanon = await startTestSetup({ allowDeanonymize: false });
  });
  afterAll(async () => {
    await tsNoDeanon.stop();
  });

  it('unlösbares Platzhalter-Zitat → isError OHNE Klartext-Echo (Orakel auch ohne Schalter geschlossen)', async () => {
    const tools = await tsNoDeanon.mcpClient.listTools();
    expect(tools.tools.map((t) => t.name)).not.toContain('deanonymize');

    const deskId = await tsNoDeanon.createDesk('Orakel-NoDeanon-Desk');
    const docId = await tsNoDeanon.addDoc(deskId, 'Rechnung.pdf');
    tsNoDeanon.legeSeitenAnFuerDoc(deskId, docId, [{ page: 1, pdfText: SEITENTEXT }]);
    await tsNoDeanon.mcpClient.callTool({ name: 'get_document_page_text', arguments: { deskId, docId, seite: 1 } });

    const r = await tsNoDeanon.mcpClient.callTool({
      name: 'propose_add_note',
      arguments: {
        deskId, kind: 'behauptung', text: 'Orakel-Versuch', x: 0, y: 0,
        quelle: { dokumentId: docId, seite: 1, zitat: '[[Person-TEST1]] zzqwr' },
      },
    });
    expect(r.isError).toBe(true);
    const roh = textOf(r);
    expect((JSON.parse(roh) as { grund: string }).grund).toBe('zitat_nicht_auflösbar');
    expect(roh).not.toContain('Max Mustermann');
  });

  it('alle fünf deanon-Pfade: Token-Eingabe → Erfolgsantwort OHNE Klartext (Orakel auch ohne Schalter geschlossen)', async () => {
    const deskId = await tsNoDeanon.createDesk('Echo-NoDeanon-Desk');
    const docId = await tsNoDeanon.addDoc(deskId, 'Rechnung.pdf');
    tsNoDeanon.legeSeitenAnFuerDoc(deskId, docId, [{ page: 1, pdfText: SEITENTEXT }]);
    await tsNoDeanon.mcpClient.callTool({ name: 'get_document_page_text', arguments: { deskId, docId, seite: 1 } });

    // Alle fünf Pfade, die ihre Zusammenfassung aus deanon()-Text bauen (CR-01 It. 3):
    // add_note / edit_note / rename_stack / set_link_note / add_stamp (freeText).
    const calls: [string, Record<string, unknown>][] = [
      ['propose_add_note', {
        deskId, kind: 'behauptung', text: 'Zahlung durch [[Person-TEST1]] erfolgt', x: 0, y: 0,
        quelle: { dokumentId: docId, seite: 1, zitat: 'gezahlt' },
      }],
      ['propose_edit_note', {
        deskId, noteId: 'n-1', text: 'Neu: [[Person-TEST1]] hat gezahlt',
        quelle: { dokumentId: docId, seite: 1, zitat: 'gezahlt' },
      }],
      ['propose_rename_stack', { deskId, stackId: 'st-1', name: 'Akte [[Person-TEST1]]' }],
      ['propose_set_link_note', { deskId, linkId: 'l-1', note: 'Verweis auf [[Person-TEST1]]' }],
      ['propose_add_stamp', { deskId, docId, page: 1, freeText: 'Eingang [[Person-TEST1]]' }],
    ];
    for (const [name, args] of calls) {
      const r = await tsNoDeanon.mcpClient.callTool({ name, arguments: args });
      expect(r.isError, name).toBeFalsy();
      const roh = textOf(r);
      expect(roh, name).not.toContain('Max Mustermann');
      expect(JSON.stringify(r.structuredContent ?? {}), name).not.toContain('Max Mustermann');
      expect(roh, name).toContain('[[Person-TEST1]]');
    }
  });
});
