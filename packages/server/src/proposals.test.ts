import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WsClient from 'ws';
import { createTestAppMitZweiNutzern, type ZweiNutzerContext } from './testUtils';
import { createDesk } from './deskStore';
import type { Db } from './db';
import { storeFile } from './files';
import { warteAufLeerlauf } from './ocr/ocrQueue';
import { pruefeKommandosFuerActor } from './app';

/**
 * AI-01-Tracer (12-01): Vorschlag erstellen (Desk bleibt unverändert) → genehmigen (Wirkung
 * ausschließlich über applyDeskCommand, Journal-Doppelstempel) — Rechte-Ränder 403/404/409.
 *
 * AI-03-Härtung (12-03, Task 1): art-abhängige Quellenpflicht mit atomarer Verifikation
 * (pruefeQuellen VOR dem INSERT in EINER Transaktion — jeder 422-Fall bleibt persistenzfrei,
 * COUNT-Beweis), Budget-Guardrails (quellen ≤ 5, Text ≤ 2000, zusammenfassung-Kappung 280)
 * und das mandat_fremd-Rate-Signal (Sev-2, inhaltsfrei). Desk-Fixture trägt deshalb ein
 * echtes Dokument mit file_pages-Zeilen (Muster aus quelleServer.test.ts/fileText.test.ts).
 */

const SEITE_1_TEXT = 'Die Klage ist unbegründet. Der Anspruch ist verjährt.';
const SEITE_2_TEXT = 'Völlig anderer Inhalt der zweiten Seite.';
const GEHEIMER_SEITENTEXT = 'Geheimer Inhalt der Privatseite MARKER-PRIVAT-8c1d';

let ctx: ZweiNutzerContext;
let deskId: string;

/**
 * Legt `file_pages`-Zeilen direkt an — dieselbe Datenform wie im echten Lauf, ohne die
 * Extraktion tatsächlich auszuführen (Muster aus quelleServer.test.ts `legeSeitenAn`).
 */
function legeSeitenAn(
  db: Db,
  fileId: string,
  seiten: { page: number; pdfText?: string | null; ocrText?: string | null }[],
): void {
  db.prepare('DELETE FROM file_pages WHERE file_id = ?').run(fileId);
  for (const seite of seiten) {
    db.prepare(
      'INSERT INTO file_pages (file_id, page, pdf_text, ocr_text, ocr_confidence) VALUES (?, ?, ?, ?, NULL)',
    ).run(fileId, seite.page, seite.pdfText ?? null, seite.ocrText ?? null);
  }
}

const addNoteBody = {
  art: 'addNote',
  payload: { id: 'n-ki-1', kind: 'notiz', text: 'Bitte Fundstelle prüfen', position: { x: 100, y: 200 } },
  quellen: [{ dokumentId: 'doc-1', seite: 1, zitat: 'Der Anspruch ist verjährt.' }],
  zusammenfassung: 'Notiz zur Fundstelle anlegen',
};

function postVorschlag(headers: { authorization: string }, body: unknown = addNoteBody, desk: string = deskId) {
  return ctx.app.inject({ method: 'POST', url: `/api/v1/desks/${desk}/vorschlaege`, headers, payload: body as Record<string, unknown> });
}

function postEntscheidung(headers: { authorization: string }, vorschlagId: string, aktion: 'genehmigen' | 'ablehnen' | 'zuruecknehmen') {
  return ctx.app.inject({ method: 'POST', url: `/api/v1/desks/${deskId}/vorschlaege/${vorschlagId}/${aktion}`, headers });
}

async function stateFuer(headers: { authorization: string }) {
  const antwort = await ctx.app.inject({ method: 'GET', url: `/api/v1/desks/${deskId}/state`, headers });
  return antwort.json() as { rev: number; state: {
    docs?: { id: string; position: { x: number; y: number } }[];
    notes?: { id: string; text: string; createdBy?: string; updatedRev?: number }[];
    stamps?: { id: string }[];
    flags?: { id: string }[];
    trash?: { id: string; kind: string }[];
  } };
}

async function journalFuer(headers: { authorization: string }) {
  const antwort = await ctx.app.inject({ method: 'GET', url: `/api/v1/desks/${deskId}/journal`, headers });
  return (antwort.json() as { entries: {
    type: string;
    actorName: string;
    payload: { vorschlagId?: string; kiAkteur?: string; approvedBy?: string; zusammenfassung?: string } | null;
  }[] }).entries;
}

async function erstelleVorschlagUeberRest(body: unknown = addNoteBody): Promise<string> {
  const antwort = await postVorschlag(ctx.a.authHeaders, body);
  expect(antwort.statusCode).toBe(200);
  return (antwort.json() as { vorschlagId: string }).vorschlagId;
}

/** Persistenzfreiheits-Beweis: kein 422-Fall darf eine Registerzeile hinterlassen. */
function anzahlVorschlaege(desk: string = deskId): number {
  return (ctx.db.prepare('SELECT COUNT(*) AS n FROM vorschlaege WHERE desk_id = ?').get(desk) as { n: number }).n;
}

function rolleFuerB(rolle: string, desk: string = deskId): void {
  ctx.db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(desk, ctx.b.userId, rolle);
}

function getVorschlaege(headers: { authorization: string }, desk: string = deskId) {
  return ctx.app.inject({ method: 'GET', url: `/api/v1/desks/${desk}/vorschlaege`, headers });
}

/** WS-Helfer (projection.test.ts-Muster): Ticket holen, Socket verbinden, offen abwarten. */
async function oeffneSocket(headers: { authorization: string }): Promise<WsClient> {
  const ticket = (
    await ctx.app.inject({ method: 'POST', url: '/api/v1/ws-ticket', headers })
  ).json().ticket as string;
  const { port } = ctx.app.server.address() as { port: number };
  const ws = new WsClient(`ws://127.0.0.1:${port}/api/v1/desks/${deskId}/ws?ticket=${ticket}`);
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  return ws;
}

function sammleNachrichtenBisSignale(ws: WsClient, anzahlSignale: number): Promise<string[]> {
  // Sammelt ALLE Frames, bis das Signal `anzahlSignale`-mal gesehen wurde — praesenz-Frames
  // beim Connect werden mitgeschnitten und fließen in die Inhaltsfreiheits-Assertion ein.
  return new Promise((resolve) => {
    const frames: string[] = [];
    let gesehen = 0;
    const handler = (d: WsClient.RawData) => {
      const text = d.toString();
      frames.push(text);
      if (text === SIGNAL_ROH) gesehen++;
      if (gesehen === anzahlSignale) {
        ws.off('message', handler);
        resolve(frames);
      }
    };
    ws.on('message', handler);
  });
}

/** Sammelt ALLE Frames über ein festes Zeitfenster (Fehlerfall-Assertions: es darf eben
 *  KEIN Signal kommen — dafür gibt es kein Terminierungs-Event). */
function sammleAlleFrames(ws: WsClient, ms: number): Promise<string[]> {
  return new Promise((resolve) => {
    const frames: string[] = [];
    const handler = (d: WsClient.RawData) => frames.push(d.toString());
    ws.on('message', handler);
    setTimeout(() => { ws.off('message', handler); resolve(frames); }, ms);
  });
}

/** Das Signal ist wortgleich an jedem Mutationspfad — ein Schlüssel, kein Zähler, kein Payload. */
const SIGNAL_ROH = '{"event":"vorschlaegeGeaendert"}';

/** Dokument auf As privater Ebene — für B (jede Rolle) unsichtbar (projection.test.ts-Muster). */
async function legePrivatesDokumentAn(docId: string, seitenText: string): Promise<void> {
  const meta = storeFile(ctx.db, ctx.dataDir, Buffer.from('%PDF-1.4\nprivat'), 'privat.pdf');
  await warteAufLeerlauf();
  legeSeitenAn(ctx.db, meta.id, [{ page: 1, pdfText: seitenText }]);
  const doc = await ctx.app.inject({
    method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers: ctx.a.authHeaders,
    payload: { type: 'addDoc', payload: { id: docId, fileId: meta.id, name: 'Privates Schreiben', position: { x: 50, y: 50 } } },
  });
  expect(doc.statusCode).toBe(200);
  const privat = await ctx.app.inject({
    method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers: ctx.a.authHeaders,
    payload: { type: 'changeLayerId', payload: { objectId: docId, layerId: 'privat' } },
  });
  expect(privat.statusCode).toBe(200);
}

beforeEach(async () => {
  ctx = await createTestAppMitZweiNutzern();
  deskId = createDesk(ctx.db, ctx.a.userId, 'Gate-Desk').id;
  const meta = storeFile(ctx.db, ctx.dataDir, Buffer.from('%PDF-1.4\nfund'), 'fund.pdf');
  await warteAufLeerlauf();
  legeSeitenAn(ctx.db, meta.id, [
    { page: 1, pdfText: SEITE_1_TEXT },
    { page: 2, pdfText: SEITE_2_TEXT },
  ]);
  const doc = await ctx.app.inject({
    method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers: ctx.a.authHeaders,
    payload: { type: 'addDoc', payload: { id: 'doc-1', fileId: meta.id, name: 'Schriftsatz', position: { x: 0, y: 0 } } },
  });
  expect(doc.statusCode).toBe(200);
});

afterEach(async () => {
  await ctx.app.close();
});

describe('POST /api/v1/desks/:id/vorschlaege', () => {
  it('legt einen ausstehenden Vorschlag an, ohne den Desk zu verändern (rev identisch, keine neue Notiz)', async () => {
    const vorher = await stateFuer(ctx.a.authHeaders);

    const antwort = await postVorschlag(ctx.a.authHeaders);

    expect(antwort.statusCode).toBe(200);
    const koerper = antwort.json() as { vorschlagId: string; status: string };
    expect(typeof koerper.vorschlagId).toBe('string');
    expect(koerper.vorschlagId.length).toBeGreaterThan(0);
    expect(koerper.status).toBe('ausstehend');
    // Die Registerzeile existiert.
    expect(anzahlVorschlaege()).toBe(1);

    // AI-01/edge: rev unverändert, kein neues Desk-Objekt — die Vorab-Anzeige läuft nur über das Register.
    const nachher = await stateFuer(ctx.a.authHeaders);
    expect(nachher.rev).toBe(vorher.rev);
    expect(nachher.state.notes ?? []).toHaveLength(0);
  });

  it('liefert 403 für Rollen ohne Erstellungsrecht (Kommentator, Nur-Lesen)', async () => {
    rolleFuerB('Kommentator');
    expect((await postVorschlag(ctx.b.authHeaders)).statusCode).toBe(403);

    ctx.db.prepare('UPDATE desk_roles SET rolle = ? WHERE desk_id = ? AND user_id = ?').run('Nur-Lesen', deskId, ctx.b.userId);
    expect((await postVorschlag(ctx.b.authHeaders)).statusCode).toBe(403);
  });

  it('liefert 400 bei fehlender art oder fehlendem payload', async () => {
    const antwort = await postVorschlag(ctx.a.authHeaders, { zusammenfassung: 'ohne art' });
    expect(antwort.statusCode).toBe(400);
  });
});

describe('Quellenpflicht im Erstellungspfad (AI-03, atomar vor dem INSERT)', () => {
  it('addNote OHNE quellen → 422 quelle_fehlt; die Tabelle bleibt leer', async () => {
    const antwort = await postVorschlag(ctx.a.authHeaders, { ...addNoteBody, quellen: [] });

    expect(antwort.statusCode).toBe(422);
    expect((antwort.json() as { grund: string }).grund).toBe('quelle_fehlt');
    expect(anzahlVorschlaege()).toBe(0);
  });

  it('addNote ganz ohne quellen-Feld → ebenfalls 422 quelle_fehlt', async () => {
    const { quellen: _weggelassen, ...ohneQuellen } = addNoteBody;
    const antwort = await postVorschlag(ctx.a.authHeaders, ohneQuellen);

    expect(antwort.statusCode).toBe(422);
    expect((antwort.json() as { grund: string }).grund).toBe('quelle_fehlt');
    expect(anzahlVorschlaege()).toBe(0);
  });

  it('Zitat auf falscher Seite → 422 zitat_nicht_auflösbar mit betroffeneQuelle; keine Zeile', async () => {
    const quelle = { dokumentId: 'doc-1', seite: 2, zitat: 'Der Anspruch ist verjährt.' };
    const antwort = await postVorschlag(ctx.a.authHeaders, { ...addNoteBody, quellen: [quelle] });

    expect(antwort.statusCode).toBe(422);
    const koerper = antwort.json() as { grund: string; betroffeneQuelle: unknown };
    expect(koerper.grund).toBe('zitat_nicht_auflösbar');
    expect(koerper.betroffeneQuelle).toEqual(quelle);
    expect(anzahlVorschlaege()).toBe(0);
  });

  it('quelle auf unsichtbares Dokument → 422 mandat_fremd, byte-identisch zum Fall „dokumentId existiert nicht"', async () => {
    rolleFuerB('Bearbeiter');
    await legePrivatesDokumentAn('doc-privat', GEHEIMER_SEITENTEXT);
    const zweitDesk = createDesk(ctx.db, ctx.a.userId, 'Zweit-Desk').id;
    rolleFuerB('Bearbeiter', zweitDesk);

    // Dieselbe Quelle in zwei Lagen: deskId hat das Dokument (für B unsichtbar), zweitDesk kennt die id nicht.
    const body = { ...addNoteBody, quellen: [{ dokumentId: 'doc-privat', seite: 1, zitat: GEHEIMER_SEITENTEXT }] };
    const unsichtbar = await postVorschlag(ctx.b.authHeaders, body);
    const nichtExistent = await postVorschlag(ctx.b.authHeaders, body, zweitDesk);

    expect(unsichtbar.statusCode).toBe(422);
    expect(nichtExistent.statusCode).toBe(422);
    expect((unsichtbar.json() as { grund: string }).grund).toBe('mandat_fremd');
    // Keine Existenz-Auskunft (T-12-03-05): die Antwort ist reine Funktion aus grund + Eingabe-Spiegel.
    expect(unsichtbar.body).toBe(nichtExistent.body);
    expect(anzahlVorschlaege()).toBe(0);
    expect(anzahlVorschlaege(zweitDesk)).toBe(0);
  });

  it('zwei quellen, zweite nicht auflösbar → 422 mit der ZWEITEN als betroffeneQuelle; keine Zeile (atomar)', async () => {
    const zweite = { dokumentId: 'doc-1', seite: 2, zitat: 'Der Anspruch ist verjährt.' };
    const antwort = await postVorschlag(ctx.a.authHeaders, {
      ...addNoteBody,
      quellen: [{ dokumentId: 'doc-1', seite: 1, zitat: 'Der Anspruch ist verjährt.' }, zweite],
    });

    expect(antwort.statusCode).toBe(422);
    const koerper = antwort.json() as { grund: string; betroffeneQuelle: unknown };
    expect(koerper.grund).toBe('zitat_nicht_auflösbar');
    expect(koerper.betroffeneQuelle).toEqual(zweite);
    expect(anzahlVorschlaege()).toBe(0);
  });

  it('art ohne Genehmigungs-Abbildung → 422 art_nicht_genehmigungsfähig; keine Zeile', async () => {
    // Seit 12-04 ist 'moveDoc' genehmigungsfähig — die Sperre läuft jetzt gegen eine
    // endgültige Lösch-art (LOESCH_COMMANDS): die bleibt konstruktiv ausgeschlossen.
    const antwort = await postVorschlag(ctx.a.authHeaders, {
      ...addNoteBody,
      art: 'removeDoc',
      payload: { id: 'doc-1' },
      quellen: [{ dokumentId: 'doc-1', seite: 1, zitat: 'Der Anspruch ist verjährt.' }],
    });

    expect(antwort.statusCode).toBe(422);
    expect((antwort.json() as { grund: string }).grund).toBe('art_nicht_genehmigungsfähig');
    expect(anzahlVorschlaege()).toBe(0);
  });
});

describe('Budget-Guardrails im Erstellungspfad (AI-SPEC: die Anzeige muss prüfbar bleiben)', () => {
  it('mehr als 5 quellen → 422 budget_überschritten; keine Zeile', async () => {
    const quellen = Array.from({ length: 6 }, () => ({ dokumentId: 'doc-1', seite: 1, zitat: 'Der Anspruch ist verjährt.' }));
    const antwort = await postVorschlag(ctx.a.authHeaders, { ...addNoteBody, quellen });

    expect(antwort.statusCode).toBe(422);
    expect((antwort.json() as { grund: string }).grund).toBe('budget_überschritten');
    expect(anzahlVorschlaege()).toBe(0);
  });

  it('payload-Textfeld über 2000 Zeichen → 422 budget_überschritten; keine Zeile', async () => {
    const antwort = await postVorschlag(ctx.a.authHeaders, {
      ...addNoteBody,
      payload: { ...addNoteBody.payload, text: 'x'.repeat(2001) },
    });

    expect(antwort.statusCode).toBe(422);
    expect((antwort.json() as { grund: string }).grund).toBe('budget_überschritten');
    expect(anzahlVorschlaege()).toBe(0);
  });

  it('VERSCHACHTELTES Textfeld über 2000 Zeichen → 422 budget_überschritten (WR-05: rekursive Prüfung); keine Zeile', async () => {
    const antwort = await postVorschlag(ctx.a.authHeaders, {
      ...addNoteBody,
      payload: { ...addNoteBody.payload, kontext: { notiz: 'x'.repeat(2001) } },
    });

    expect(antwort.statusCode).toBe(422);
    expect((antwort.json() as { grund: string }).grund).toBe('budget_überschritten');
    expect(anzahlVorschlaege()).toBe(0);
  });

  it('zitat über 2000 Zeichen → 400 (WR-05: Zitat-Längenlimit); keine Zeile', async () => {
    const antwort = await postVorschlag(ctx.a.authHeaders, {
      ...addNoteBody,
      quellen: [{ dokumentId: 'doc-1', seite: 1, zitat: 'z'.repeat(2001) }],
    });

    expect(antwort.statusCode).toBe(400);
    expect(anzahlVorschlaege()).toBe(0);
  });

  it('seite 0 oder nicht ganzzahlig → 400 (WR-05: Seiten-Minimum); keine Zeile', async () => {
    const seite0 = await postVorschlag(ctx.a.authHeaders, {
      ...addNoteBody,
      quellen: [{ dokumentId: 'doc-1', seite: 0, zitat: 'Der Anspruch ist verjährt.' }],
    });
    const krumm = await postVorschlag(ctx.a.authHeaders, {
      ...addNoteBody,
      quellen: [{ dokumentId: 'doc-1', seite: 1.5, zitat: 'Der Anspruch ist verjährt.' }],
    });

    expect(seite0.statusCode).toBe(400);
    expect(krumm.statusCode).toBe(400);
    expect(anzahlVorschlaege()).toBe(0);
  });

  it('zusammenfassung über 280 Zeichen wird gekappt statt abgelehnt (kappeTextSnapshot-Präzedenz)', async () => {
    const antwort = await postVorschlag(ctx.a.authHeaders, {
      ...addNoteBody,
      zusammenfassung: 'z'.repeat(300),
    });

    expect(antwort.statusCode).toBe(200);
    const zeile = ctx.db.prepare('SELECT zusammenfassung FROM vorschlaege WHERE desk_id = ?').get(deskId) as { zusammenfassung: string };
    expect(zeile.zusammenfassung).toHaveLength(280);
  });
});

describe('mandat_fremd-Rate-Signal (Sev-2-Frühwarnung, inhaltsfrei)', () => {
  it('drei mandat_fremd-Ablehnungen desselben Tokens → Security-Log mit deskId + Akteur + Anzahl, OHNE dokumentId/Zitat', async () => {
    rolleFuerB('Bearbeiter');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (let i = 0; i < 3; i++) {
        const antwort = await postVorschlag(ctx.b.authHeaders, {
          ...addNoteBody,
          quellen: [{ dokumentId: 'doc-unbekannt', seite: 1, zitat: GEHEIMER_SEITENTEXT }],
        });
        expect(antwort.statusCode).toBe(422);
        expect((antwort.json() as { grund: string }).grund).toBe('mandat_fremd');
      }

      const sicherheitsLogs = spy.mock.calls.filter((c) => c[0] === '[SECURITY] mandat_fremd-Häufung');
      expect(sicherheitsLogs).toHaveLength(1);
      expect(sicherheitsLogs[0][1]).toEqual({ deskId, akteur: 'nutzer-b', anzahl: 3 });
      // Inhaltsfreiheit des Logs: weder die betroffene dokumentId noch das Zitat darf auftauchen.
      expect(JSON.stringify(sicherheitsLogs)).not.toContain('doc-unbekannt');
      expect(JSON.stringify(sicherheitsLogs)).not.toContain(GEHEIMER_SEITENTEXT);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('pruefeKommandosFuerActor (extrahierte Guard-Sequenz der Commands-Route, Pitfall 5)', () => {
  it('verweigert ein Kommando, das die Rolle nicht darf (Bearbeiter + removeNote)', () => {
    rolleFuerB('Bearbeiter');

    const meldung = pruefeKommandosFuerActor(ctx.db, deskId, 'Bearbeiter',
      { id: ctx.b.userId, name: 'nutzer-b' },
      [{ type: 'removeNote', payload: { id: 'irgendwas' } }]);

    expect(meldung).toContain('Bearbeiter');
    expect(meldung).toContain('removeNote');
  });

  it('verweigert ein Kommando auf ein Objekt einer fremden Privat-Ebene (Ebenen-Stufe)', async () => {
    rolleFuerB('Bearbeiter');
    // A legt eine Notiz an und verschiebt sie auf die eigene Privat-Ebene.
    const notiz = await ctx.app.inject({
      method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers: ctx.a.authHeaders,
      payload: { type: 'addNote', payload: { id: 'n-privat', kind: 'notiz', text: 'privat', position: { x: 1, y: 1 } } },
    });
    expect(notiz.statusCode).toBe(200);
    const privat = await ctx.app.inject({
      method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers: ctx.a.authHeaders,
      payload: { type: 'changeLayerId', payload: { objectId: 'n-privat', layerId: 'privat' } },
    });
    expect(privat.statusCode).toBe(200);

    const meldung = pruefeKommandosFuerActor(ctx.db, deskId, 'Bearbeiter',
      { id: ctx.b.userId, name: 'nutzer-b' },
      [{ type: 'editNote', payload: { id: 'n-privat', text: 'fremdbeareitung' } }]);

    expect(meldung).toBe('Dieses Objekt liegt auf einer privaten Ebene einer anderen Person.');
  });

  it('lässt ein erlaubtes Kommando durch (Bearbeiter + addNote) → null', () => {
    rolleFuerB('Bearbeiter');

    const meldung = pruefeKommandosFuerActor(ctx.db, deskId, 'Bearbeiter',
      { id: ctx.b.userId, name: 'nutzer-b' },
      [{ type: 'addNote', payload: { id: 'n-x', kind: 'notiz', text: 't', position: { x: 0, y: 0 } } }]);

    expect(meldung).toBeNull();
  });
});

describe('POST /api/v1/desks/:id/vorschlaege/:vorschlagId/genehmigen', () => {
  it('wendet den Vorschlag an: Notiz regulär auf dem Desk, Journal-Marker mit kiAkteur + approvedBy', async () => {
    const vorschlagId = await erstelleVorschlagUeberRest();

    const antwort = await postEntscheidung(ctx.a.authHeaders, vorschlagId, 'genehmigen');

    expect(antwort.statusCode).toBe(200);
    expect((antwort.json() as { ok: boolean }).ok).toBe(true);

    // AI-02/edge: die Notiz ist ein reguläres Desk-Objekt mit Provenienz-Stempel des Genehmigers.
    const nachher = await stateFuer(ctx.a.authHeaders);
    const notiz = (nachher.state.notes ?? []).find((n) => n.id === 'n-ki-1');
    expect(notiz).toBeDefined();
    expect(notiz!.text).toBe('Bitte Fundstelle prüfen');
    expect(notiz!.createdBy).toBe('nutzer-a');

    // Doppelstempel: Marker-Eintrag nennt KI-Akteur (Vorschlags-Ersteller) UND Genehmiger.
    // CR-02: die Nutzlast ist inhaltsfrei (nur Metadaten) — die Register-zusammenfassung
    // verlässt den Server über die Historie NICHT (Vertraulichkeits-Bugklasse).
    const journal = await journalFuer(ctx.a.authHeaders);
    const marker = journal.find((e) => e.type === 'vorschlagGenehmigt');
    expect(marker).toBeDefined();
    expect(marker!.payload).toMatchObject({
      vorschlagId,
      art: 'addNote',
      kiAkteur: 'nutzer-a',
      approvedBy: 'nutzer-a',
    });
    expect(marker!.payload).not.toHaveProperty('zusammenfassung');
  });

  it('ein Bearbeiter genehmigt einen addNote-Vorschlag erfolgreich (Baseline des Genehmigungs-Guards)', async () => {
    rolleFuerB('Bearbeiter');
    const vorschlagId = await erstelleVorschlagUeberRest();

    const antwort = await postEntscheidung(ctx.b.authHeaders, vorschlagId, 'genehmigen');

    expect(antwort.statusCode).toBe(200);
    const nachher = await stateFuer(ctx.a.authHeaders);
    expect((nachher.state.notes ?? []).some((n) => n.id === 'n-ki-1')).toBe(true);
  });

  it('liefert 403 für eine Rolle ohne manage-Recht (Kommentator)', async () => {
    rolleFuerB('Kommentator');
    const vorschlagId = await erstelleVorschlagUeberRest();

    const antwort = await postEntscheidung(ctx.b.authHeaders, vorschlagId, 'genehmigen');

    expect(antwort.statusCode).toBe(403);
    // Keine Wirkung: der Desk bleibt ohne die Notiz.
    const nachher = await stateFuer(ctx.a.authHeaders);
    expect(nachher.state.notes ?? []).toHaveLength(0);
  });

  it('liefert 409 bei Genehmigung eines bereits genehmigten Vorschlags', async () => {
    const vorschlagId = await erstelleVorschlagUeberRest();
    await postEntscheidung(ctx.a.authHeaders, vorschlagId, 'genehmigen');

    const antwort = await postEntscheidung(ctx.a.authHeaders, vorschlagId, 'genehmigen');

    expect(antwort.statusCode).toBe(409);
  });

  it('liefert 404 bei unbekannter vorschlagId', async () => {
    const antwort = await postEntscheidung(ctx.a.authHeaders, 'gibt-es-nicht', 'genehmigen');

    expect(antwort.statusCode).toBe(404);
  });

  it('liefert 409 kommando_nicht_anwendbar statt 500, wenn das Zielobjekt seit der Einreichung gelöscht wurde (WR-03)', async () => {
    // Alltagsfall hinter dem CommandError aus inverseFuer: das Zielobjekt des Vorschlags
    // existiert bei der Genehmigung nicht mehr — ein erwartbarer Fachfall (der Prüfer lehnt
    // den Vorschlag dann ab), kein Serverfehler.
    const vorschlagId = await erstelleVorschlagUeberRest({
      art: 'moveDoc',
      payload: { id: 'doc-1', position: { x: 500, y: 500 } },
      zusammenfassung: 'Schriftsatz verschieben',
    });
    const revVorher = (await stateFuer(ctx.a.authHeaders)).rev;
    // Menschliche Zwischenarbeit: das Zieldokument wandert in den Papierkorb.
    const trash = await ctx.app.inject({
      method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers: ctx.a.authHeaders,
      payload: { type: 'trashObject', payload: { id: 'doc-1', trashedAt: new Date().toISOString() } },
    });
    expect(trash.statusCode).toBe(200);

    const antwort = await postEntscheidung(ctx.a.authHeaders, vorschlagId, 'genehmigen');

    expect(antwort.statusCode).toBe(409);
    const koerper = antwort.json() as { error: string; grund: string };
    expect(koerper.grund).toBe('kommando_nicht_anwendbar');
    expect(koerper.error).toContain('Keine Inverse definierbar');
    // Voller Rollback: Status 'ausstehend', Desk-rev unverändert — der Vorschlag kann
    // anschließend regulär abgelehnt werden.
    const zeile = ctx.db.prepare('SELECT status, inverse FROM vorschlaege WHERE id = ?').get(vorschlagId) as { status: string; inverse: string | null };
    expect(zeile.status).toBe('ausstehend');
    expect(zeile.inverse).toBeNull();
    expect((await stateFuer(ctx.a.authHeaders)).rev).toBe(revVorher + 1); // nur das menschliche trashObject
  });
});

describe('POST /api/v1/desks/:id/vorschlaege/:vorschlagId/ablehnen', () => {
  it('setzt den Status auf abgelehnt ohne Desk-Wirkung und OHNE Journal-Marker', async () => {
    const vorher = await stateFuer(ctx.a.authHeaders);
    const vorschlagId = await erstelleVorschlagUeberRest();

    const antwort = await postEntscheidung(ctx.a.authHeaders, vorschlagId, 'ablehnen');

    expect(antwort.statusCode).toBe(200);
    expect((antwort.json() as { ok: boolean }).ok).toBe(true);

    // Keine Desk-Wirkung: rev unverändert, keine Notiz.
    const nachher = await stateFuer(ctx.a.authHeaders);
    expect(nachher.rev).toBe(vorher.rev);
    expect(nachher.state.notes ?? []).toHaveLength(0);

    // Ablehnung ist kein Historien-Ereignis in Phase 12 — die Registerzeile dokumentiert sie.
    const journal = await journalFuer(ctx.a.authHeaders);
    expect(journal.some((e) => e.type === 'vorschlagGenehmigt' || e.type === 'vorschlagZurueckgenommen')).toBe(false);

    // Die Registerzeile selbst trägt die Entscheidung samt Stempel.
    const zeile = ctx.db.prepare('SELECT status, decided_by, decided_at FROM vorschlaege WHERE id = ?').get(vorschlagId) as
      { status: string; decided_by: string | null; decided_at: number | null };
    expect(zeile.status).toBe('abgelehnt');
    expect(zeile.decided_by).toBe('nutzer-a');
    expect(zeile.decided_at).not.toBeNull();
  });

  it('liefert 409 bei Ablehnung eines bereits genehmigten Vorschlags', async () => {
    const vorschlagId = await erstelleVorschlagUeberRest();
    await postEntscheidung(ctx.a.authHeaders, vorschlagId, 'genehmigen');

    const antwort = await postEntscheidung(ctx.a.authHeaders, vorschlagId, 'ablehnen');

    expect(antwort.statusCode).toBe(409);
  });

  it('liefert 404 bei unbekannter vorschlagId', async () => {
    const antwort = await postEntscheidung(ctx.a.authHeaders, 'gibt-es-nicht', 'ablehnen');

    expect(antwort.statusCode).toBe(404);
  });

  it('liefert 403 für eine Rolle ohne manage-Recht (Kommentator)', async () => {
    rolleFuerB('Kommentator');
    const vorschlagId = await erstelleVorschlagUeberRest();

    const antwort = await postEntscheidung(ctx.b.authHeaders, vorschlagId, 'ablehnen');

    expect(antwort.statusCode).toBe(403);
    const zeile = ctx.db.prepare('SELECT status FROM vorschlaege WHERE id = ?').get(vorschlagId) as { status: string };
    expect(zeile.status).toBe('ausstehend');
  });
});

describe('POST /api/v1/desks/:id/vorschlaege/:vorschlagId/zuruecknehmen (AI-02, 12-04)', () => {
  const STEMPEL = ['createdBy', 'createdById', 'createdAt', 'updatedRev', 'updatedAt', 'updatedBy'] as const;

  /** Notizen ohne Stempel-Felder — inhaltlicher Vergleich (AI-02 „ohne Rückstände"). */
  function notizenOhneStempel(notizen: Record<string, unknown>[] | undefined): Record<string, unknown>[] {
    return (notizen ?? []).map((n) => Object.fromEntries(Object.entries(n).filter(([k]) => !(STEMPEL as readonly string[]).includes(k))));
  }

  it('genehmigen (addNote) → zuruecknehmen → 200; Notizen inhaltlich im Ausgangszustand; Journal-Marker mit Doppelstempel', async () => {
    // Eine Bestandsnotiz, damit der Rückbau mehr als „leer" beweist.
    const alt = await ctx.app.inject({
      method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers: ctx.a.authHeaders,
      payload: { type: 'addNote', payload: { id: 'n-alt', kind: 'notiz', text: 'bestand', position: { x: 7, y: 7 } } },
    });
    expect(alt.statusCode).toBe(200);
    const ausgang = (await stateFuer(ctx.a.authHeaders)).state.notes ?? [];
    const vorschlagId = await erstelleVorschlagUeberRest();
    await postEntscheidung(ctx.a.authHeaders, vorschlagId, 'genehmigen');

    const antwort = await postEntscheidung(ctx.a.authHeaders, vorschlagId, 'zuruecknehmen');

    expect(antwort.statusCode).toBe(200);
    expect((antwort.json() as { ok: boolean }).ok).toBe(true);
    const nachher = (await stateFuer(ctx.a.authHeaders)).state.notes ?? [];
    expect(nachher.some((n) => n.id === 'n-ki-1')).toBe(false);
    expect(notizenOhneStempel(nachher)).toEqual(notizenOhneStempel(ausgang));

    const journal = await journalFuer(ctx.a.authHeaders);
    const marker = journal.find((e) => e.type === 'vorschlagZurueckgenommen');
    expect(marker).toBeDefined();
    // CR-02: inhaltsfreie Marker-Nutzlast (nur Metadaten, keine Register-zusammenfassung).
    expect(marker!.payload).toMatchObject({
      vorschlagId,
      art: 'addNote',
      kiAkteur: 'nutzer-a',
      approvedBy: 'nutzer-a',
    });
    expect(marker!.payload).not.toHaveProperty('zusammenfassung');

    // Registerzeile: terminal 'zurückgenommen' samt Stempel des Rücknehmenden.
    const zeile = ctx.db.prepare('SELECT status, decided_by FROM vorschlaege WHERE id = ?').get(vorschlagId) as { status: string; decided_by: string };
    expect(zeile.status).toBe('zurückgenommen');
    expect(zeile.decided_by).toBe('nutzer-a');
  });

  it('fremde Änderung am selben Objekt seit der Übernahme → 409 objekt_seit_uebernahme_geaendert; Desk und Status unverändert (OQ2: kein hartes Zurücksetzen)', async () => {
    rolleFuerB('Bearbeiter');
    const vorschlagId = await erstelleVorschlagUeberRest();
    await postEntscheidung(ctx.a.authHeaders, vorschlagId, 'genehmigen');
    // Menschliche Zwischenarbeit: B bearbeitet die übernommene Notiz.
    const fremd = await ctx.app.inject({
      method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers: ctx.b.authHeaders,
      payload: { type: 'editNote', payload: { id: 'n-ki-1', text: 'von Mensch geändert' } },
    });
    expect(fremd.statusCode).toBe(200);

    const antwort = await postEntscheidung(ctx.a.authHeaders, vorschlagId, 'zuruecknehmen');

    expect(antwort.statusCode).toBe(409);
    const koerper = antwort.json() as { error: string; grund: string };
    expect(koerper.grund).toBe('objekt_seit_uebernahme_geaendert');
    expect(koerper.error).toContain('wurde seit der Übernahme verändert');
    // Keine Wirkung: die Menschenarbeit steht unverändert auf dem Tisch.
    const notizen = (await stateFuer(ctx.a.authHeaders)).state.notes ?? [];
    expect(notizen.find((n) => n.id === 'n-ki-1')?.text).toBe('von Mensch geändert');
    // Der Vorschlag bleibt 'genehmigt' — die Rücknahme kann nach manueller Klärung erneut laufen.
    const zeile = ctx.db.prepare('SELECT status FROM vorschlaege WHERE id = ?').get(vorschlagId) as { status: string };
    expect(zeile.status).toBe('genehmigt');
  });

  it('zuruecknehmen auf ausstehend/abgelehnt/zurückgenommen → je 409 (Terminal-Status)', async () => {
    const ausstehend = await erstelleVorschlagUeberRest({ ...addNoteBody, payload: { ...addNoteBody.payload, id: 'n-ki-s1' } });
    expect((await postEntscheidung(ctx.a.authHeaders, ausstehend, 'zuruecknehmen')).statusCode).toBe(409);

    const abgelehnt = await erstelleVorschlagUeberRest({ ...addNoteBody, payload: { ...addNoteBody.payload, id: 'n-ki-s2' } });
    await postEntscheidung(ctx.a.authHeaders, abgelehnt, 'ablehnen');
    expect((await postEntscheidung(ctx.a.authHeaders, abgelehnt, 'zuruecknehmen')).statusCode).toBe(409);

    // Die Rücknahme einer Rücknahme ist unmöglich — 'zurückgenommen' ist terminal (AI-02/edge).
    const terminal = await erstelleVorschlagUeberRest({ ...addNoteBody, payload: { ...addNoteBody.payload, id: 'n-ki-s3' } });
    await postEntscheidung(ctx.a.authHeaders, terminal, 'genehmigen');
    expect((await postEntscheidung(ctx.a.authHeaders, terminal, 'zuruecknehmen')).statusCode).toBe(200);
    expect((await postEntscheidung(ctx.a.authHeaders, terminal, 'zuruecknehmen')).statusCode).toBe(409);
  });

  it('zuruecknehmen ohne manage-Recht → 403; unbekannte vorschlagId → 404', async () => {
    rolleFuerB('Kommentator');
    const vorschlagId = await erstelleVorschlagUeberRest();
    await postEntscheidung(ctx.a.authHeaders, vorschlagId, 'genehmigen');

    expect((await postEntscheidung(ctx.b.authHeaders, vorschlagId, 'zuruecknehmen')).statusCode).toBe(403);
    expect((await postEntscheidung(ctx.a.authHeaders, 'gibt-es-nicht', 'zuruecknehmen')).statusCode).toBe(404);
    // Die 403 hatte keine Wirkung.
    const notizen = (await stateFuer(ctx.a.authHeaders)).state.notes ?? [];
    expect(notizen.some((n) => n.id === 'n-ki-1')).toBe(true);
  });

  it('Journal-Sequenz: genehmigte Kommandos + Inverse regulär mit menschlichem Akteur; KI-Akteur nur in den Markern', async () => {
    rolleFuerB('Bearbeiter');
    const vorschlagId = await erstelleVorschlagUeberRest();
    await postEntscheidung(ctx.b.authHeaders, vorschlagId, 'genehmigen'); // B genehmigt
    await postEntscheidung(ctx.a.authHeaders, vorschlagId, 'zuruecknehmen'); // A nimmt zurück

    // DB-Ebene statt REST-Projektion: die CR-03-Sichtfilterung (journal.ts) blendet die
    // addNote-Zeile für Betrachter aus, sobald die Notiz endgültig entfernt ist — das
    // Register selbst (die beweissichere Spur) bleibt vollständig.
    const zeilen = ctx.db.prepare(
      'SELECT type, actor_name AS actorName, payload FROM command_journal WHERE desk_id = ? ORDER BY id ASC',
    ).all(deskId) as { type: string; actorName: string; payload: string | null }[];
    const addNote = zeilen.find((z) => z.type === 'addNote');
    const removeNote = zeilen.find((z) => z.type === 'removeNote');
    expect(addNote?.actorName).toBe('nutzer-b'); // Genehmiger als Akteur der Übernahme
    expect(removeNote?.actorName).toBe('nutzer-a'); // Rücknehmender als Akteur der Inverse
    // Zwei Marker, beide mit KI-Akteur (Vorschlags-Ersteller) + jeweiligem Menschen.
    const marker = zeilen.filter((z) => z.type === 'vorschlagGenehmigt' || z.type === 'vorschlagZurueckgenommen');
    expect(marker).toHaveLength(2);
    expect(JSON.parse(marker[0].payload!)).toMatchObject({ vorschlagId, kiAkteur: 'nutzer-a', approvedBy: 'nutzer-b' });
    expect(JSON.parse(marker[1].payload!)).toMatchObject({ vorschlagId, kiAkteur: 'nutzer-a', approvedBy: 'nutzer-a' });
  });

  it('feuert nach zuruecknehmen das inhaltsfreie VORSCHLAG_SIGNAL', async () => {
    const vorschlagId = await erstelleVorschlagUeberRest();
    await postEntscheidung(ctx.a.authHeaders, vorschlagId, 'genehmigen');
    await ctx.app.listen({ port: 0 });
    const wsA = await oeffneSocket(ctx.a.authHeaders);
    try {
      const gesammelt = sammleNachrichtenBisSignale(wsA, 1);
      await postEntscheidung(ctx.a.authHeaders, vorschlagId, 'zuruecknehmen');
      const frames = await gesammelt;
      expect(frames.at(-1)).toBe(SIGNAL_ROH);
    } finally {
      wsA.close();
    }
  });

  it('trashObject-Rücknahme: Objekt im Papierkorb → nach zuruecknehmen wieder auf dem Tisch an alter Position', async () => {
    const vorschlagId = await erstelleVorschlagUeberRest({
      art: 'trashObject',
      payload: { objectId: 'doc-1' },
      zusammenfassung: 'Schriftsatz in den Papierkorb',
    });
    await postEntscheidung(ctx.a.authHeaders, vorschlagId, 'genehmigen');
    const imKorb = await stateFuer(ctx.a.authHeaders);
    expect(imKorb.state.docs ?? []).toHaveLength(0);
    expect(imKorb.state.trash ?? []).toHaveLength(1);

    const antwort = await postEntscheidung(ctx.a.authHeaders, vorschlagId, 'zuruecknehmen');

    expect(antwort.statusCode).toBe(200);
    const nachher = await stateFuer(ctx.a.authHeaders);
    const doc = (nachher.state.docs ?? []).find((d) => d.id === 'doc-1');
    expect(doc).toBeDefined();
    expect(doc!.position).toEqual({ x: 0, y: 0 });
    expect(nachher.state.trash ?? []).toHaveLength(0);
  });

  it('trashObject-Rücknahme nach manueller Wiederherstellung → 409 objekt_seit_uebernahme_geaendert (CR-03: kein 500)', async () => {
    // CR-03 (a): der Rücknahme-Anker einer trashObject-Genehmigung ist die KORB-id — hat ein
    // Mensch den Korb-Eintrag zwischenzeitlich manuell wiederhergestellt, muss die Rücknahme
    // ehrlich mit 409 antworten statt mit dem CommandError-500 der restoreObject-Inverse.
    const vorschlagId = await erstelleVorschlagUeberRest({
      art: 'trashObject',
      payload: { objectId: 'doc-1' },
      zusammenfassung: 'Schriftsatz in den Papierkorb',
    });
    await postEntscheidung(ctx.a.authHeaders, vorschlagId, 'genehmigen');
    // Menschliche Zwischenarbeit: A holt den Korb-Eintrag manuell zurück auf den Tisch.
    const imKorb = await stateFuer(ctx.a.authHeaders);
    const trashId = (imKorb.state.trash ?? [])[0]?.id;
    expect(trashId).toBeDefined();
    const manuell = await ctx.app.inject({
      method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers: ctx.a.authHeaders,
      payload: { type: 'restoreObject', payload: { trashId } },
    });
    expect(manuell.statusCode).toBe(200);

    const antwort = await postEntscheidung(ctx.a.authHeaders, vorschlagId, 'zuruecknehmen');

    expect(antwort.statusCode).toBe(409);
    expect((antwort.json() as { grund: string }).grund).toBe('objekt_seit_uebernahme_geaendert');
    // Keine Wirkung: das manuell wiederhergestellte Dokument bleibt unangetastet auf dem
    // Tisch, der Vorschlag bleibt 'genehmigt' (manuelle Klärung möglich).
    const nachher = await stateFuer(ctx.a.authHeaders);
    expect((nachher.state.docs ?? []).some((d) => d.id === 'doc-1')).toBe(true);
    const zeile = ctx.db.prepare('SELECT status FROM vorschlaege WHERE id = ?').get(vorschlagId) as { status: string };
    expect(zeile.status).toBe('genehmigt');
  });

  it('restoreObject-Rücknahme ohne Zwischenarbeit → 200, das Objekt liegt wieder im Papierkorb', async () => {
    // Korb-Befüllung auf menschlichem Weg, dann KI-Vorschlag zur Wiederherstellung.
    const trash = await ctx.app.inject({
      method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers: ctx.a.authHeaders,
      payload: { type: 'trashObject', payload: { id: 'doc-1', trashedAt: new Date().toISOString() } },
    });
    expect(trash.statusCode).toBe(200);
    const trashId = ((await stateFuer(ctx.a.authHeaders)).state.trash ?? [])[0]?.id;
    expect(trashId).toBeDefined();
    const vorschlagId = await erstelleVorschlagUeberRest({
      art: 'restoreObject',
      payload: { trashId },
      zusammenfassung: 'Schriftsatz aus dem Papierkorb zurückholen',
    });
    await postEntscheidung(ctx.a.authHeaders, vorschlagId, 'genehmigen');
    expect(((await stateFuer(ctx.a.authHeaders)).state.docs ?? []).some((d) => d.id === 'doc-1')).toBe(true);

    const antwort = await postEntscheidung(ctx.a.authHeaders, vorschlagId, 'zuruecknehmen');

    expect(antwort.statusCode).toBe(200);
    const nachher = await stateFuer(ctx.a.authHeaders);
    expect((nachher.state.docs ?? []).some((d) => d.id === 'doc-1')).toBe(false);
    expect((nachher.state.trash ?? []).some((t) => t.id === trashId)).toBe(true);
  });

  it('restoreObject-Rücknahme nach Menschen-Edit → 409 objekt_seit_uebernahme_geaendert (CR-03: kein stilles Re-Trash)', async () => {
    // CR-03 (b): der Mitschnitt einer restoreObject-Genehmigung verankert das wiederhergestellte
    // Objekt mit seiner frischen updatedRev — Menschenarbeit daran darf die Inverse
    // (trashObject) nicht ungeprüft re-trashen (OQ2: nie still überschreiben).
    rolleFuerB('Bearbeiter');
    const trash = await ctx.app.inject({
      method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers: ctx.a.authHeaders,
      payload: { type: 'trashObject', payload: { id: 'doc-1', trashedAt: new Date().toISOString() } },
    });
    expect(trash.statusCode).toBe(200);
    const trashId = ((await stateFuer(ctx.a.authHeaders)).state.trash ?? [])[0]?.id;
    const vorschlagId = await erstelleVorschlagUeberRest({
      art: 'restoreObject',
      payload: { trashId },
      zusammenfassung: 'Schriftsatz aus dem Papierkorb zurückholen',
    });
    await postEntscheidung(ctx.a.authHeaders, vorschlagId, 'genehmigen');
    // Menschliche Zwischenarbeit: B verschiebt das wiederhergestellte Dokument.
    const fremd = await ctx.app.inject({
      method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers: ctx.b.authHeaders,
      payload: { type: 'moveDoc', payload: { id: 'doc-1', position: { x: 400, y: 300 } } },
    });
    expect(fremd.statusCode).toBe(200);

    const antwort = await postEntscheidung(ctx.a.authHeaders, vorschlagId, 'zuruecknehmen');

    expect(antwort.statusCode).toBe(409);
    expect((antwort.json() as { grund: string }).grund).toBe('objekt_seit_uebernahme_geaendert');
    // Keine Wirkung: das Dokument bleibt an der vom Menschen gewählten Position auf dem Tisch.
    const nachher = await stateFuer(ctx.a.authHeaders);
    const doc = (nachher.state.docs ?? []).find((d) => d.id === 'doc-1');
    expect(doc).toBeDefined();
    expect(doc!.position).toEqual({ x: 400, y: 300 });
    expect(nachher.state.trash ?? []).toHaveLength(0);
    const zeile = ctx.db.prepare('SELECT status FROM vorschlaege WHERE id = ?').get(vorschlagId) as { status: string };
    expect(zeile.status).toBe('genehmigt');
  });

  it('extractPage: Menschen-Änderung am UNVERÄNDERTEN Quelldokument blockiert die Rücknahme nicht (WR-02)', async () => {
    // WR-02: der Mitschnitt enthält nur tatsächlich neu gestempelte Objekte — das
    // Quelldokument (extractPage rührt es nicht an) darf mit seiner Alt-updatedRev keinen
    // falschen 409-Blocker erzeugen, wenn ein Mensch es seither verschoben hat.
    const vorschlagId = await erstelleVorschlagUeberRest({
      art: 'extractPage',
      payload: { docId: 'doc-1', page: 1, position: { x: 300, y: 40 }, id: 'karte-extrakt' },
      quellen: [{ dokumentId: 'doc-1', seite: 1, zitat: 'Der Anspruch ist verjährt.' }],
      zusammenfassung: 'Seite 1 als Karte herauslösen',
    });
    await postEntscheidung(ctx.a.authHeaders, vorschlagId, 'genehmigen');
    expect(((await stateFuer(ctx.a.authHeaders)).state.docs ?? []).some((d) => d.id === 'karte-extrakt')).toBe(true);
    // Menschliche Zwischenarbeit am Quelldokument — sachlich irrelevant für die Inverse
    // (removeDoc auf die neue Karte), früher ein dauerhafter falscher 409-Blocker.
    const fremd = await ctx.app.inject({
      method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers: ctx.a.authHeaders,
      payload: { type: 'moveDoc', payload: { id: 'doc-1', position: { x: 50, y: 60 } } },
    });
    expect(fremd.statusCode).toBe(200);

    const antwort = await postEntscheidung(ctx.a.authHeaders, vorschlagId, 'zuruecknehmen');

    expect(antwort.statusCode).toBe(200);
    const nachher = await stateFuer(ctx.a.authHeaders);
    // Die Inverse hat nur die neue Karte entfernt; die Menschen-Position des Quelldokuments bleibt.
    expect((nachher.state.docs ?? []).some((d) => d.id === 'karte-extrakt')).toBe(false);
    const quelldoc = (nachher.state.docs ?? []).find((d) => d.id === 'doc-1');
    expect(quelldoc).toBeDefined();
    expect(quelldoc!.position).toEqual({ x: 50, y: 60 });
  });
});

describe('Route-level-403 des Genehmigungs-Guards (Nachhol aus 12-03, WINDOWS #18)', () => {
  it('Bearbeiter genehmigt einen editNote-Vorschlag auf eine Notiz auf fremder Privat-Ebene → 403 mit vollem Rollback', async () => {
    rolleFuerB('Bearbeiter');
    // A legt eine Notiz an und verschiebt sie auf die eigene Privat-Ebene.
    const notiz = await ctx.app.inject({
      method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers: ctx.a.authHeaders,
      payload: { type: 'addNote', payload: { id: 'n-privat', kind: 'notiz', text: 'privat', position: { x: 1, y: 1 } } },
    });
    expect(notiz.statusCode).toBe(200);
    const privat = await ctx.app.inject({
      method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers: ctx.a.authHeaders,
      payload: { type: 'changeLayerId', payload: { objectId: 'n-privat', layerId: 'privat' } },
    });
    expect(privat.statusCode).toBe(200);
    // A erstellt den editNote-Vorschlag (A sieht die eigene Privat-Notiz; Quelle auf öffentlichem doc-1).
    const vorschlagId = await erstelleVorschlagUeberRest({
      art: 'editNote',
      payload: { id: 'n-privat', text: 'übernommener Text' },
      quellen: [{ dokumentId: 'doc-1', seite: 1, zitat: 'Der Anspruch ist verjährt.' }],
      zusammenfassung: 'Notiztext überarbeiten',
    });
    const revVorher = (await stateFuer(ctx.a.authHeaders)).rev;

    const antwort = await postEntscheidung(ctx.b.authHeaders, vorschlagId, 'genehmigen');

    expect(antwort.statusCode).toBe(403);
    expect((antwort.json() as { error: string }).error)
      .toBe('Dieses Objekt liegt auf einer privaten Ebene einer anderen Person.');
    // Voller Rollback: Status 'ausstehend', inverse NULL, Desk unverändert.
    const zeile = ctx.db.prepare('SELECT status, inverse FROM vorschlaege WHERE id = ?').get(vorschlagId) as { status: string; inverse: string | null };
    expect(zeile.status).toBe('ausstehend');
    expect(zeile.inverse).toBeNull();
    expect((await stateFuer(ctx.a.authHeaders)).rev).toBe(revVorher);
    const notizen = (await stateFuer(ctx.a.authHeaders)).state.notes ?? [];
    expect(notizen.find((n) => n.id === 'n-privat')?.text).toBe('privat');
  });
});

describe('Journal-Marker-Inhaltsfreiheit (CR-02): kein Inhaltsschnipsel über GET /journal', () => {
  it('Bearbeiter ohne Sichtrecht liest den deanonymisierten Schnipsel der zusammenfassung NICHT — weder im Marker noch im Kommando', async () => {
    rolleFuerB('Bearbeiter');
    // A legt eine Notiz mit privatem Inhalt an und verschiebt sie auf die eigene Privat-Ebene.
    const notiz = await ctx.app.inject({
      method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers: ctx.a.authHeaders,
      payload: { type: 'addNote', payload: { id: 'n-privat', kind: 'notiz', text: 'Bestand', position: { x: 1, y: 1 } } },
    });
    expect(notiz.statusCode).toBe(200);
    const privat = await ctx.app.inject({
      method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers: ctx.a.authHeaders,
      payload: { type: 'changeLayerId', payload: { objectId: 'n-privat', layerId: 'privat' } },
    });
    expect(privat.statusCode).toBe(200);
    // A reicht einen editNote-Vorschlag ein, dessen zusammenfassung deanonymisierten
    // Klartext der Privat-Notiz trägt (MCP-Muster: „Notiz-Text ersetzen: <120 Zeichen>").
    const vorschlagId = await erstelleVorschlagUeberRest({
      art: 'editNote',
      payload: { id: 'n-privat', text: 'Uebernommener GEHEIM-Text-99' },
      quellen: [{ dokumentId: 'doc-1', seite: 1, zitat: 'Der Anspruch ist verjährt.' }],
      zusammenfassung: 'Notiz-Text ersetzen: Privatvermerk GEHEIM-NOTIZ-77',
    });
    // A genehmigt die eigene Privat-Ebene — erlaubt.
    expect((await postEntscheidung(ctx.a.authHeaders, vorschlagId, 'genehmigen')).statusCode).toBe(200);

    const antwortB = await ctx.app.inject({ method: 'GET', url: `/api/v1/desks/${deskId}/journal`, headers: ctx.b.authHeaders });

    expect(antwortB.statusCode).toBe(200);
    // Das eigentliche editNote-Kommando ist für B korrekt gefiltert (INHALT_OBJEKT_ID),
    // der Marker trägt den Schnipsel seit CR-02 gar nicht mehr — beide Pfade bleiben dicht.
    expect(antwortB.body).not.toContain('GEHEIM-NOTIZ-77');
    expect(antwortB.body).not.toContain('GEHEIM-Text-99');
    // Der Marker selbst bleibt sichtbar (Metadaten sind kein Inhalt), aber OHNE zusammenfassung.
    const eintraegeB = (antwortB.json() as { entries: { type: string; payload: Record<string, unknown> | null }[] }).entries;
    const markerB = eintraegeB.find((e) => e.type === 'vorschlagGenehmigt');
    expect(markerB).toBeDefined();
    expect(markerB!.payload).toMatchObject({ vorschlagId, art: 'editNote', kiAkteur: 'nutzer-a', approvedBy: 'nutzer-a' });
    expect(markerB!.payload).not.toHaveProperty('zusammenfassung');
  });

  it('bereinigt Alt-Zeilen beim Lesen: ein vor dem Fix journalierter Marker mit zusammenfassung liefert den Schnipsel nie wieder aus', async () => {
    // Legacy-Simulation: Zeile in der Vor-CR-02-Form direkt in die DB schreiben.
    ctx.db.prepare(
      'INSERT INTO command_journal (desk_id, rev, type, payload, actor_id, actor_name, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      deskId, 1, 'vorschlagGenehmigt',
      JSON.stringify({ vorschlagId: 'v-alt', kiAkteur: 'ki', approvedBy: 'nutzer-a', zusammenfassung: 'LEGACY-SCHNIPSEL-55' }),
      null, 'System', Date.now(),
    );

    const antwortA = await ctx.app.inject({ method: 'GET', url: `/api/v1/desks/${deskId}/journal`, headers: ctx.a.authHeaders });

    expect(antwortA.statusCode).toBe(200);
    expect(antwortA.body).not.toContain('LEGACY-SCHNIPSEL-55');
    const eintraege = (antwortA.json() as { entries: { type: string; payload: Record<string, unknown> | null }[] }).entries;
    const altMarker = eintraege.find((e) => e.type === 'vorschlagGenehmigt');
    expect(altMarker).toBeDefined();
    expect(altMarker!.payload).toMatchObject({ vorschlagId: 'v-alt', kiAkteur: 'ki', approvedBy: 'nutzer-a' });
    expect(altMarker!.payload).not.toHaveProperty('zusammenfassung');
  });
});

describe('Objekt-Referenzen in der Listen-Projektion (12-04)', () => {
  it('ein trashObject-Vorschlag auf ein für B unsichtbares Dokument fehlt KOMPLETT in Bs Liste', async () => {
    rolleFuerB('Bearbeiter');
    await legePrivatesDokumentAn('doc-privat', GEHEIMER_SEITENTEXT);
    const unsichtbarer = await erstelleVorschlagUeberRest({
      art: 'trashObject',
      payload: { objectId: 'doc-privat' },
      zusammenfassung: 'Privates Schreiben in den Papierkorb',
    });
    const sichtbarer = await erstelleVorschlagUeberRest();

    const listeA = (await getVorschlaege(ctx.a.authHeaders)).json() as { vorschlaege: { id: string }[] };
    const antwortB = await getVorschlaege(ctx.b.authHeaders);
    const listeB = antwortB.json() as { vorschlaege: { id: string }[] };

    expect(listeA.vorschlaege.map((v) => v.id)).toContain(unsichtbarer);
    expect(listeB.vorschlaege.map((v) => v.id)).toEqual([sichtbarer]);
    expect(antwortB.body).not.toContain('doc-privat');
  });

  it('ein restoreObject-Vorschlag auf einen Korb-Eintrag mit für B unsichtbarem Inhalt fehlt KOMPLETT in Bs Liste (WR-07)', async () => {
    rolleFuerB('Bearbeiter');
    // A legt eine private Notiz an und trasht sie — der Korb-Eintrag trägt die Vollkopie
    // samt privater layerId.
    const notiz = await ctx.app.inject({
      method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers: ctx.a.authHeaders,
      payload: { type: 'addNote', payload: { id: 'n-privat', kind: 'notiz', text: 'privat', position: { x: 1, y: 1 } } },
    });
    expect(notiz.statusCode).toBe(200);
    const privat = await ctx.app.inject({
      method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers: ctx.a.authHeaders,
      payload: { type: 'changeLayerId', payload: { objectId: 'n-privat', layerId: 'privat' } },
    });
    expect(privat.statusCode).toBe(200);
    const trashPrivat = await ctx.app.inject({
      method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers: ctx.a.authHeaders,
      payload: { type: 'trashObject', payload: { id: 'n-privat', trashedAt: new Date().toISOString() } },
    });
    expect(trashPrivat.statusCode).toBe(200);
    const privatTrashId = ((await stateFuer(ctx.a.authHeaders)).state.trash ?? [])[0]?.id;
    expect(privatTrashId).toBeDefined();
    // Kontrollgruppe: ein ÖFFENTLICHER Korb-Eintrag (doc-1) bleibt für B sichtbar.
    const trashOeffentlich = await ctx.app.inject({
      method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers: ctx.a.authHeaders,
      payload: { type: 'trashObject', payload: { id: 'doc-1', trashedAt: new Date().toISOString() } },
    });
    expect(trashOeffentlich.statusCode).toBe(200);
    const oeffentlichTrashId = ((await stateFuer(ctx.a.authHeaders)).state.trash ?? [])
      .find((t) => t.id !== privatTrashId)?.id;
    expect(oeffentlichTrashId).toBeDefined();

    const unsichtbarer = await erstelleVorschlagUeberRest({
      art: 'restoreObject',
      payload: { trashId: privatTrashId },
      zusammenfassung: 'Objekt aus dem Papierkorb zurückholen',
    });
    const sichtbarer = await erstelleVorschlagUeberRest({
      art: 'restoreObject',
      payload: { trashId: oeffentlichTrashId },
      zusammenfassung: 'Objekt aus dem Papierkorb zurückholen',
    });

    const listeA = (await getVorschlaege(ctx.a.authHeaders)).json() as { vorschlaege: { id: string }[] };
    const antwortB = await getVorschlaege(ctx.b.authHeaders);
    const listeB = antwortB.json() as { vorschlaege: { id: string }[] };

    expect(listeA.vorschlaege.map((v) => v.id)).toContain(unsichtbarer);
    expect(listeA.vorschlaege.map((v) => v.id)).toContain(sichtbarer);
    // Komplettes Fehlen — weder der Vorschlag noch die Korb-Eintrags-id erreichen B.
    expect(listeB.vorschlaege.map((v) => v.id)).toEqual([sichtbarer]);
    expect(antwortB.body).not.toContain(privatTrashId!);
  });
});

describe('Idempotenz über REST', () => {
  it('liefert bei demselben idempotenzKey dieselbe vorschlagId (200, kein Duplikat)', async () => {
    const body = { ...addNoteBody, idempotenzKey: 'retry-42' };

    const erste = await postVorschlag(ctx.a.authHeaders, body);
    const zweite = await postVorschlag(ctx.a.authHeaders, body);

    expect(erste.statusCode).toBe(200);
    expect(zweite.statusCode).toBe(200);
    expect((zweite.json() as { vorschlagId: string }).vorschlagId)
      .toBe((erste.json() as { vorschlagId: string }).vorschlagId);
    expect(anzahlVorschlaege()).toBe(1);
  });
});

describe('GET /api/v1/desks/:id/vorschlaege (projizierte Liste, PERM-05)', () => {
  it('listet ausstehende Vorschläge mit öffentlichen Feldern — ohne inverse/genehmigteObjekte', async () => {
    const vorschlagId = await erstelleVorschlagUeberRest();

    const antwort = await getVorschlaege(ctx.a.authHeaders);

    expect(antwort.statusCode).toBe(200);
    const liste = (antwort.json() as { vorschlaege: Record<string, unknown>[] }).vorschlaege;
    expect(liste).toHaveLength(1);
    const eintrag = liste[0];
    expect(eintrag).toMatchObject({
      id: vorschlagId,
      art: 'addNote',
      status: 'ausstehend',
      createdBy: 'nutzer-a',
      zusammenfassung: 'Notiz zur Fundstelle anlegen',
    });
    expect(typeof eintrag.createdAt).toBe('number');
    expect(eintrag.quellen).toEqual(addNoteBody.quellen);
    // Interne Felder verlassen den Server nicht im Listenpfad (T-12-03-06: inverse bleibt serverseitig).
    expect(eintrag).not.toHaveProperty('inverse');
    expect(eintrag).not.toHaveProperty('genehmigteObjekte');
    expect(eintrag).not.toHaveProperty('genehmigte_objekte');
  });

  it('ein Vorschlag mit quelle auf ein für B unsichtbares Dokument fehlt KOMPLETT in Bs Liste', async () => {
    rolleFuerB('Bearbeiter');
    await legePrivatesDokumentAn('doc-privat', GEHEIMER_SEITENTEXT);
    // A erstellt beide Vorschläge (A sieht das eigene Privatdokument — die Quelle löst auf).
    const unsichtbarer = await erstelleVorschlagUeberRest({
      ...addNoteBody,
      payload: { ...addNoteBody.payload, id: 'n-ki-privat' },
      quellen: [{ dokumentId: 'doc-privat', seite: 1, zitat: GEHEIMER_SEITENTEXT }],
    });
    const sichtbarer = await erstelleVorschlagUeberRest();

    const listeA = (await getVorschlaege(ctx.a.authHeaders)).json() as { vorschlaege: { id: string }[] };
    const antwortB = await getVorschlaege(ctx.b.authHeaders);
    const listeB = antwortB.json() as { vorschlaege: { id: string }[] };

    expect(antwortB.statusCode).toBe(200);
    expect(listeA.vorschlaege.map((v) => v.id)).toContain(unsichtbarer);
    expect(listeA.vorschlaege.map((v) => v.id)).toContain(sichtbarer);
    // PERM-05-Regel: komplettes Fehlen, kein Platzhalter, keine Teilredaktion.
    expect(listeB.vorschlaege.map((v) => v.id)).toEqual([sichtbarer]);
    // Verschärft: weder der geheime Zitat-String noch die unsichtbare docId tauchen im Roh-Body auf.
    expect(antwortB.body).not.toContain(GEHEIMER_SEITENTEXT);
    expect(antwortB.body).not.toContain('doc-privat');
  });

  it('Kommentator und Nur-Lesen erhalten 200 mit derselben Projektionsregel', async () => {
    rolleFuerB('Kommentator');
    await legePrivatesDokumentAn('doc-privat', GEHEIMER_SEITENTEXT);
    await erstelleVorschlagUeberRest({
      ...addNoteBody,
      payload: { ...addNoteBody.payload, id: 'n-ki-privat' },
      quellen: [{ dokumentId: 'doc-privat', seite: 1, zitat: GEHEIMER_SEITENTEXT }],
    });
    await erstelleVorschlagUeberRest();

    const kommentator = await getVorschlaege(ctx.b.authHeaders);
    expect(kommentator.statusCode).toBe(200);
    expect((kommentator.json() as { vorschlaege: unknown[] }).vorschlaege).toHaveLength(1);
    expect(kommentator.body).not.toContain(GEHEIMER_SEITENTEXT);

    ctx.db.prepare('UPDATE desk_roles SET rolle = ? WHERE desk_id = ? AND user_id = ?').run('Nur-Lesen', deskId, ctx.b.userId);
    const nurLesen = await getVorschlaege(ctx.b.authHeaders);
    expect(nurLesen.statusCode).toBe(200);
    expect((nurLesen.json() as { vorschlaege: unknown[] }).vorschlaege).toHaveLength(1);
    expect(nurLesen.body).not.toContain(GEHEIMER_SEITENTEXT);
  });

  it('ohne Desk-Rolle → 403; unbekannter Desk → 404', async () => {
    expect((await getVorschlaege(ctx.b.authHeaders)).statusCode).toBe(403);

    const unbekannt = await getVorschlaege(ctx.a.authHeaders, 'gibt-es-nicht');
    expect(unbekannt.statusCode).toBe(404);
  });

  it('entschiedene Vorschläge fehlen in der Default-Liste (Filter ausstehend)', async () => {
    const vorschlagId = await erstelleVorschlagUeberRest();
    await postEntscheidung(ctx.a.authHeaders, vorschlagId, 'ablehnen');

    const antwort = await getVorschlaege(ctx.a.authHeaders);

    expect(antwort.statusCode).toBe(200);
    expect((antwort.json() as { vorschlaege: unknown[] }).vorschlaege).toHaveLength(0);
  });
});

describe("WS-Signal 'vorschlaegeGeaendert' (inhaltsfrei, alle Mutationspfade)", () => {
  it('Erstellen: beide Sockets empfangen NUR das inhaltsfreie Signal — der Marker kommt bei keinem vor', async () => {
    rolleFuerB('Bearbeiter');
    await legePrivatesDokumentAn('doc-privat', GEHEIMER_SEITENTEXT);
    await ctx.app.listen({ port: 0 });
    const wsA = await oeffneSocket(ctx.a.authHeaders);
    const wsB = await oeffneSocket(ctx.b.authHeaders);
    try {
      const framesA = sammleNachrichtenBisSignale(wsA, 1);
      const framesB = sammleNachrichtenBisSignale(wsB, 1);

      // A erstellt einen Vorschlag mit GEHEIMEM Zitat auf dem für B unsichtbaren Dokument.
      await erstelleVorschlagUeberRest({
        ...addNoteBody,
        quellen: [{ dokumentId: 'doc-privat', seite: 1, zitat: GEHEIMER_SEITENTEXT }],
      });

      const [empfangenA, empfangenB] = await Promise.all([framesA, framesB]);
      // Inhaltsfreiheit bewiesen, nicht behauptet: das Signal ist wortgleich das nackte
      // Ein-Schlüssel-Event, und KEIN empfangener Frame (inkl. praesenz) trägt den Marker.
      expect(empfangenA.at(-1)).toBe(SIGNAL_ROH);
      expect(empfangenB.at(-1)).toBe(SIGNAL_ROH);
      for (const frame of empfangenB) expect(frame).not.toContain(GEHEIMER_SEITENTEXT);
    } finally {
      wsA.close();
      wsB.close();
    }
  });

  it('Genehmigen und Ablehnen feuern dasselbe inhaltsfreie Signal', async () => {
    // Erstellung VOR dem Socket-Connect — die Erstellungs-Signale gehen ins Leere.
    const genehmigt = await erstelleVorschlagUeberRest({
      ...addNoteBody,
      payload: { ...addNoteBody.payload, id: 'n-ki-signal-1' },
    });
    const abgelehnt = await erstelleVorschlagUeberRest({
      ...addNoteBody,
      payload: { ...addNoteBody.payload, id: 'n-ki-signal-2' },
    });
    await ctx.app.listen({ port: 0 });
    const wsA = await oeffneSocket(ctx.a.authHeaders);
    try {
      // Genehmigen: State-Broadcast je angewendetem Kommando + Signal; Ablehnen: nur Signal.
      const gesammelt = sammleNachrichtenBisSignale(wsA, 2);

      await postEntscheidung(ctx.a.authHeaders, genehmigt, 'genehmigen');
      await postEntscheidung(ctx.a.authHeaders, abgelehnt, 'ablehnen');

      const frames = await gesammelt;
      const signale = frames.filter((f) => f === SIGNAL_ROH);
      expect(signale).toHaveLength(2);
      // Genau ein Frame ist der State-Broadcast des Genehmigens (kein Vorschlagsinhalt —
      // das Register liegt außerhalb von DesktopState); alle übrigen Frames (praesenz)
      // tragen ebenfalls keinen Vorschlagsinhalt.
      const stateFrames = frames.filter((f) => f.includes('"rev"'));
      expect(stateFrames).toHaveLength(1);
      for (const frame of frames) expect(frame).not.toContain('Notiz zur Fundstelle anlegen');
    } finally {
      wsA.close();
    }
  });

  it('fehlgeschlagene Genehmigung (403 Ebenen-Guard) strahlt KEINE Phantom-States aus (WR-01: Broadcasts erst nach dem Commit)', async () => {
    rolleFuerB('Bearbeiter');
    // A legt eine Notiz auf seine Privat-Ebene; ein editNote-Vorschlag darauf ist für B
    // nicht genehmigbar — die Transaktion rollt vollständig zurück (403).
    const notiz = await ctx.app.inject({
      method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers: ctx.a.authHeaders,
      payload: { type: 'addNote', payload: { id: 'n-privat', kind: 'notiz', text: 'privat', position: { x: 1, y: 1 } } },
    });
    expect(notiz.statusCode).toBe(200);
    const privat = await ctx.app.inject({
      method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers: ctx.a.authHeaders,
      payload: { type: 'changeLayerId', payload: { objectId: 'n-privat', layerId: 'privat' } },
    });
    expect(privat.statusCode).toBe(200);
    const vorschlagId = await erstelleVorschlagUeberRest({
      art: 'editNote',
      payload: { id: 'n-privat', text: 'übernommener Text' },
      quellen: [{ dokumentId: 'doc-1', seite: 1, zitat: 'Der Anspruch ist verjährt.' }],
      zusammenfassung: 'Notiztext überarbeiten',
    });
    await ctx.app.listen({ port: 0 });
    const wsA = await oeffneSocket(ctx.a.authHeaders);
    try {
      const gesammelt = sammleAlleFrames(wsA, 400);

      const antwort = await postEntscheidung(ctx.b.authHeaders, vorschlagId, 'genehmigen');

      expect(antwort.statusCode).toBe(403);
      const frames = await gesammelt;
      // Kein State-Broadcast mit nie persistierter rev und kein Vorschlags-Signal: der
      // Broadcast liegt hinter dem Commit, der Rollback-Fall erreicht ihn nie.
      expect(frames.filter((f) => f.includes('"rev"'))).toHaveLength(0);
      expect(frames.filter((f) => f === SIGNAL_ROH)).toHaveLength(0);
    } finally {
      wsA.close();
    }
  });
});

describe('Rücknahme-Rechteposition (WR-01, Re-Review It. 2): kein Rücknahme-by-Proxy auf fremden Privat-Ebenen', () => {
  /** Notiz auf der Privat-Ebene des jeweiligen Nutzers (Route-level-403-Muster). */
  async function legePrivateNotizAn(headers: { authorization: string }, notizId: string): Promise<void> {
    const notiz = await ctx.app.inject({
      method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers,
      payload: { type: 'addNote', payload: { id: notizId, kind: 'notiz', text: 'privat', position: { x: 1, y: 1 } } },
    });
    expect(notiz.statusCode).toBe(200);
    const privat = await ctx.app.inject({
      method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers,
      payload: { type: 'changeLayerId', payload: { objectId: notizId, layerId: 'privat' } },
    });
    expect(privat.statusCode).toBe(200);
  }

  function editPrivatNotizBody(notizId: string, text: string) {
    return {
      art: 'editNote',
      payload: { id: notizId, text },
      quellen: [{ dokumentId: 'doc-1', seite: 1, zitat: 'Der Anspruch ist verjährt.' }],
      zusammenfassung: 'Notiztext überarbeiten',
    };
  }

  it('Bearbeiter B ohne Sichtrecht am Anker (Privat-Ebene von A) → 403 generisch, keine Inverse, Status bleibt genehmigt', async () => {
    // Der Angriffspfad aus dem Review: die Genehmigung auf As Privat-Ebene kann nur A selbst
    // ausführen (Ebenen-Stufe) — aber der inhaltsfreie Journal-Marker ist für ALLE manage-
    // Rollen sichtbar und trug die vorschlagId für die Rücknahme-by-Proxy durch B.
    await legePrivateNotizAn(ctx.a.authHeaders, 'n-privat');
    const vorschlagId = await erstelleVorschlagUeberRest(editPrivatNotizBody('n-privat', 'übernommener Text'));
    expect((await postEntscheidung(ctx.a.authHeaders, vorschlagId, 'genehmigen')).statusCode).toBe(200);
    expect((await stateFuer(ctx.a.authHeaders)).state.notes?.find((n) => n.id === 'n-privat')?.text)
      .toBe('übernommener Text');

    rolleFuerB('Bearbeiter');
    const antwort = await postEntscheidung(ctx.b.authHeaders, vorschlagId, 'zuruecknehmen');

    expect(antwort.statusCode).toBe(403);
    // Byte-genau generisch (mandat_fremd-Muster): keine Auskunft über das unsichtbare Objekt.
    expect((antwort.json() as { error: string }).error).toBe('Die Rücknahme ist für diesen Vorschlag nicht zulässig.');
    // Keine Inverse gespielt: As Privat-Notiz unverändert, Registerzeile bleibt 'genehmigt',
    // kein vorschlagZurueckgenommen-Marker (Rollback ist atomar).
    expect((await stateFuer(ctx.a.authHeaders)).state.notes?.find((n) => n.id === 'n-privat')?.text)
      .toBe('übernommener Text');
    const zeile = ctx.db.prepare('SELECT status FROM vorschlaege WHERE id = ?').get(vorschlagId) as { status: string };
    expect(zeile.status).toBe('genehmigt');
    const journal = await journalFuer(ctx.a.authHeaders);
    expect(journal.some((e) => e.type === 'vorschlagZurueckgenommen' && e.payload?.vorschlagId === vorschlagId)).toBe(false);

    // Der Genehmiger selbst darf weiterhin zurücknehmen (Rechteposition der Genehmigung).
    expect((await postEntscheidung(ctx.a.authHeaders, vorschlagId, 'zuruecknehmen')).statusCode).toBe(200);
    expect((await stateFuer(ctx.a.authHeaders)).state.notes?.find((n) => n.id === 'n-privat')?.text).toBe('privat');
  });

  it('manage-Bearbeiter MIT Sichtrecht am Anker darf fremde Genehmigung zurücknehmen (Sichtbarkeits-Weg, Bestandsmodell)', async () => {
    // geteilte Ebene: B ist weder Genehmiger noch Eigentümer — die Rücknahme läuft über die
    // Anker-Sichtbarkeit (manage-Rollen dürfen vergleichbare Aktionen, restore-Präzedenz).
    const vorschlagId = await erstelleVorschlagUeberRest(); // addNote auf Standard-Ebene
    expect((await postEntscheidung(ctx.a.authHeaders, vorschlagId, 'genehmigen')).statusCode).toBe(200);
    rolleFuerB('Bearbeiter');

    const antwort = await postEntscheidung(ctx.b.authHeaders, vorschlagId, 'zuruecknehmen');

    expect(antwort.statusCode).toBe(200);
    expect((await stateFuer(ctx.a.authHeaders)).state.notes ?? []).toHaveLength(0);
  });

  it('Eigentümer-Ausnahme: A darf Anker auf Bs Privat-Ebene zurücknehmen (Desk-Souverän)', async () => {
    // Ohne die Ausnahme schiene A hier durch (istObjektSichtbarFuer: privat ist pro Nutzer) —
    // der Eigentümer kann den Desk ohnehin vollständig zurücksetzen (restoreDeskTo), eine
    // Sperre wäre Sicherheitstheater und bräche den Betreuer-Fall.
    rolleFuerB('Bearbeiter');
    await legePrivateNotizAn(ctx.b.authHeaders, 'n-b-privat');
    const erstellt = await postVorschlag(ctx.b.authHeaders, editPrivatNotizBody('n-b-privat', 'von B geändert'));
    expect(erstellt.statusCode).toBe(200);
    const vorschlagId = (erstellt.json() as { vorschlagId: string }).vorschlagId;
    // B genehmigt auf der eigenen Privat-Ebene (Ebenen-Stufe: nur B selbst).
    expect((await postEntscheidung(ctx.b.authHeaders, vorschlagId, 'genehmigen')).statusCode).toBe(200);
    expect((await stateFuer(ctx.b.authHeaders)).state.notes?.find((n) => n.id === 'n-b-privat')?.text)
      .toBe('von B geändert');

    const antwort = await postEntscheidung(ctx.a.authHeaders, vorschlagId, 'zuruecknehmen');

    expect(antwort.statusCode).toBe(200);
    expect((await stateFuer(ctx.b.authHeaders)).state.notes?.find((n) => n.id === 'n-b-privat')?.text).toBe('privat');
  });

  it('Korb-Anker auf fremder Privat-Ebene → 403 (restoreObject-Inverse schriebe sonst blind zurück)', async () => {
    await legePrivatesDokumentAn('doc-privat', GEHEIMER_SEITENTEXT);
    const vorschlagId = await erstelleVorschlagUeberRest({
      art: 'trashObject',
      payload: { objectId: 'doc-privat' },
      zusammenfassung: 'Privates Dokument in den Papierkorb',
    });
    expect((await postEntscheidung(ctx.a.authHeaders, vorschlagId, 'genehmigen')).statusCode).toBe(200);
    expect(((await stateFuer(ctx.a.authHeaders)).state.trash ?? [])).toHaveLength(1);

    rolleFuerB('Bearbeiter');
    const antwort = await postEntscheidung(ctx.b.authHeaders, vorschlagId, 'zuruecknehmen');

    expect(antwort.statusCode).toBe(403);
    // Korb-Eintrag unverändert, Status bleibt 'genehmigt'.
    expect(((await stateFuer(ctx.a.authHeaders)).state.trash ?? [])).toHaveLength(1);
    // A (Genehmiger/Eigentümer) holt das Dokument regulär zurück.
    expect((await postEntscheidung(ctx.a.authHeaders, vorschlagId, 'zuruecknehmen')).statusCode).toBe(200);
    expect(((await stateFuer(ctx.a.authHeaders)).state.docs ?? []).some((d) => d.id === 'doc-privat')).toBe(true);
  });

  it('Journal-Marker trägt pro Empfänger zuruecknehmenErlaubt (Client-Ausblendung, PERM-04-Muster)', async () => {
    await legePrivateNotizAn(ctx.a.authHeaders, 'n-privat');
    const vorschlagId = await erstelleVorschlagUeberRest(editPrivatNotizBody('n-privat', 'übernommener Text'));
    expect((await postEntscheidung(ctx.a.authHeaders, vorschlagId, 'genehmigen')).statusCode).toBe(200);
    rolleFuerB('Bearbeiter');

    // B sieht den (inhaltsfreien) Marker weiterhin — aber mit zuruecknehmenErlaubt: false,
    // damit das ActivityOverlay die Zeilenaktion ausblendet (Komfort, keine Grenze).
    const markerB = (await journalFuer(ctx.b.authHeaders))
      .find((e) => e.type === 'vorschlagGenehmigt' && e.payload?.vorschlagId === vorschlagId);
    expect(markerB).toBeDefined();
    expect((markerB!.payload as { zuruecknehmenErlaubt?: boolean }).zuruecknehmenErlaubt).toBe(false);

    const markerA = (await journalFuer(ctx.a.authHeaders))
      .find((e) => e.type === 'vorschlagGenehmigt' && e.payload?.vorschlagId === vorschlagId);
    expect((markerA!.payload as { zuruecknehmenErlaubt?: boolean }).zuruecknehmenErlaubt).toBe(true);
  });

  it('addStamp-Anker auf fremder Privat-Ebene → 403 (verschachtelte stamp.id im Mitschnitt, WR-01 It. 3)', async () => {
    // Spiegel-Test zum editNote-Fall oben: die addStamp/addFlag-Kommandos tragen ihre neue
    // Objekt-id verschachtelt ({ stamp: { id } }) — ohne diesen Mitschnitt-Zweig bliebe
    // genehmigteObjekte leer und Weg 3 (Anker-Sichtbarkeit) vakuum wahr.
    await legePrivatesDokumentAn('doc-privat', GEHEIMER_SEITENTEXT);
    const vorschlagId = await erstelleVorschlagUeberRest({
      art: 'addStamp',
      payload: { docId: 'doc-privat', page: 1, x: 465, y: 70, angle: 0, text: 'ERLEDIGT', color: 'red', baseW: 595, baseH: 842 },
      zusammenfassung: 'Stempel auf privatem Dokument',
    });
    expect((await postEntscheidung(ctx.a.authHeaders, vorschlagId, 'genehmigen')).statusCode).toBe(200);
    expect(((await stateFuer(ctx.a.authHeaders)).state.stamps ?? [])).toHaveLength(1);

    rolleFuerB('Bearbeiter');
    const antwort = await postEntscheidung(ctx.b.authHeaders, vorschlagId, 'zuruecknehmen');

    expect(antwort.statusCode).toBe(403);
    expect((antwort.json() as { error: string }).error).toBe('Die Rücknahme ist für diesen Vorschlag nicht zulässig.');
    // Keine Inverse gespielt: Stempel unverändert, Registerzeile bleibt 'genehmigt'.
    expect(((await stateFuer(ctx.a.authHeaders)).state.stamps ?? [])).toHaveLength(1);
    const zeile = ctx.db.prepare('SELECT status FROM vorschlaege WHERE id = ?').get(vorschlagId) as { status: string };
    expect(zeile.status).toBe('genehmigt');
    // Marker-Flag: für B false (ActivityOverlay blendet die Zeilenaktion aus).
    const markerB = (await journalFuer(ctx.b.authHeaders))
      .find((e) => e.type === 'vorschlagGenehmigt' && e.payload?.vorschlagId === vorschlagId);
    expect(markerB).toBeDefined();
    expect((markerB!.payload as { zuruecknehmenErlaubt?: boolean }).zuruecknehmenErlaubt).toBe(false);

    // Legitimer Pfad: der Genehmiger/Eigentümer darf weiterhin zurücknehmen.
    expect((await postEntscheidung(ctx.a.authHeaders, vorschlagId, 'zuruecknehmen')).statusCode).toBe(200);
    expect(((await stateFuer(ctx.a.authHeaders)).state.stamps ?? [])).toHaveLength(0);
  });

  it('addFlag-Anker auf fremder Privat-Ebene → 403 (verschachtelte flag.id im Mitschnitt, WR-01 It. 3)', async () => {
    await legePrivatesDokumentAn('doc-privat', GEHEIMER_SEITENTEXT);
    const vorschlagId = await erstelleVorschlagUeberRest({
      art: 'addFlag',
      payload: { docId: 'doc-privat', page: 1, offset: 0.08, color: '#f5c518' },
      zusammenfassung: 'Notizfahne an privatem Dokument',
    });
    expect((await postEntscheidung(ctx.a.authHeaders, vorschlagId, 'genehmigen')).statusCode).toBe(200);
    expect(((await stateFuer(ctx.a.authHeaders)).state.flags ?? [])).toHaveLength(1);

    rolleFuerB('Bearbeiter');
    const antwort = await postEntscheidung(ctx.b.authHeaders, vorschlagId, 'zuruecknehmen');

    expect(antwort.statusCode).toBe(403);
    expect((antwort.json() as { error: string }).error).toBe('Die Rücknahme ist für diesen Vorschlag nicht zulässig.');
    expect(((await stateFuer(ctx.a.authHeaders)).state.flags ?? [])).toHaveLength(1);
    const zeile = ctx.db.prepare('SELECT status FROM vorschlaege WHERE id = ?').get(vorschlagId) as { status: string };
    expect(zeile.status).toBe('genehmigt');
    const markerB = (await journalFuer(ctx.b.authHeaders))
      .find((e) => e.type === 'vorschlagGenehmigt' && e.payload?.vorschlagId === vorschlagId);
    expect((markerB!.payload as { zuruecknehmenErlaubt?: boolean }).zuruecknehmenErlaubt).toBe(false);

    // Legitimer Pfad: der Genehmiger/Eigentümer darf weiterhin zurücknehmen.
    expect((await postEntscheidung(ctx.a.authHeaders, vorschlagId, 'zuruecknehmen')).statusCode).toBe(200);
    expect(((await stateFuer(ctx.a.authHeaders)).state.flags ?? [])).toHaveLength(0);
  });

  it('addStamp auf GETEILTEM Dokument: manage-Bearbeiter mit Sichtrecht darf zurücknehmen (Weg 3 bleibt offen)', async () => {
    // Schutz gegen Überkorrektur: der neue Anker darf den legitimen Sichtbarkeits-Weg nicht
    // brechen — Stempel auf doc-1 (Standard-Ebene) ist für B sichtbar.
    const vorschlagId = await erstelleVorschlagUeberRest({
      art: 'addStamp',
      payload: { docId: 'doc-1', page: 1, x: 465, y: 70, angle: 0, text: 'GEPRÜFT', color: 'blue', baseW: 595, baseH: 842 },
      zusammenfassung: 'Stempel auf geteiltem Dokument',
    });
    expect((await postEntscheidung(ctx.a.authHeaders, vorschlagId, 'genehmigen')).statusCode).toBe(200);
    expect(((await stateFuer(ctx.a.authHeaders)).state.stamps ?? [])).toHaveLength(1);
    rolleFuerB('Bearbeiter');

    const antwort = await postEntscheidung(ctx.b.authHeaders, vorschlagId, 'zuruecknehmen');

    expect(antwort.statusCode).toBe(200);
    expect(((await stateFuer(ctx.a.authHeaders)).state.stamps ?? [])).toHaveLength(0);
  });
});
