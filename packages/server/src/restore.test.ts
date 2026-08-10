import { describe, it, expect } from 'vitest';
import { createTestApp, createTestAppMitZweiNutzern } from './testUtils';
import { storeFile } from './files';
import { appendJournal } from './journal';

const pdf = Buffer.from('%PDF-1.4\ninhalt');

describe('POST /desks/:id/restore (04-01 Task 1: durchgehende Bahn)', () => {
  it('stellt den Stand nach der ersten Journal-Zeile wieder her, sichert den Vorzustand als snapshot und journaliert sich selbst', async () => {
    const { app, db, dataDir, authHeaders } = await createTestApp();
    const meta = storeFile(db, dataDir, pdf, 'a.pdf');
    const desk = (await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'D' } })).json();

    for (const id of ['doc-a', 'doc-b', 'doc-c']) {
      const res = await app.inject({
        method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
        payload: { type: 'addDoc', payload: { fileId: meta.id, name: 'a.pdf', position: { x: 1, y: 2 }, id } },
      });
      expect(res.statusCode).toBe(200);
    }

    const journalVor = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/journal`, headers: authHeaders });
    const entriesVor = journalVor.json().entries as { id: number; rev: number; type: string }[];
    const ersteAddDoc = entriesVor.find((e) => e.rev === 1)!;
    expect(ersteAddDoc.type).toBe('addDoc');

    const restoreRes = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/restore`, headers: authHeaders,
      payload: { toEntryId: ersteAddDoc.id },
    });
    expect(restoreRes.statusCode).toBe(200);
    expect(restoreRes.json().rev).toBe(4);

    const stateRes = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/state`, headers: authHeaders });
    expect(stateRes.json().state.docs).toHaveLength(1);
    expect(stateRes.json().state.docs[0].id).toBe('doc-a');

    const journalNach = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/journal`, headers: authHeaders });
    const entriesNach = journalNach.json().entries as { id: number; rev: number; type: string }[];
    expect(entriesNach[0].type).toBe('stateRestored');
    expect(entriesNach[1].type).toBe('snapshot');
  });
});

describe('POST /desks/:id/restore — Absicherung (04-01 Task 3: Rechte, Fremdzugriff, Eingabe, P-01/P-03)', () => {
  it('toEntryId eines fremden Desks (T-04-02) -> 404, eigener Zustand unverändert', async () => {
    const { app, db, dataDir, authHeaders } = await createTestApp();
    const meta = storeFile(db, dataDir, pdf, 'a.pdf');
    const deskA = (await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'A' } })).json();
    const deskB = (await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'B' } })).json();

    await app.inject({
      method: 'POST', url: `/api/v1/desks/${deskA.id}/commands`, headers: authHeaders,
      payload: { type: 'addDoc', payload: { fileId: meta.id, name: 'a.pdf', position: { x: 1, y: 2 }, id: 'doc-a' } },
    });
    const cmdB = await app.inject({
      method: 'POST', url: `/api/v1/desks/${deskB.id}/commands`, headers: authHeaders,
      payload: { type: 'addDoc', payload: { fileId: meta.id, name: 'a.pdf', position: { x: 1, y: 2 }, id: 'doc-b' } },
    });
    expect(cmdB.statusCode).toBe(200);

    const journalB = (await app.inject({ method: 'GET', url: `/api/v1/desks/${deskB.id}/journal`, headers: authHeaders })).json().entries as { id: number; rev: number }[];
    const zeileB = journalB.find((e) => e.rev === 1)!;

    const res = await app.inject({
      method: 'POST', url: `/api/v1/desks/${deskA.id}/restore`, headers: authHeaders, payload: { toEntryId: zeileB.id },
    });
    expect(res.statusCode).toBe(404);

    const stateA = await app.inject({ method: 'GET', url: `/api/v1/desks/${deskA.id}/state`, headers: authHeaders });
    expect(stateA.json().rev).toBe(1);
  });

  it('unbekannte toEntryId -> 404', async () => {
    const { app, authHeaders } = await createTestApp();
    const desk = (await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'D' } })).json();
    const res = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/restore`, headers: authHeaders, payload: { toEntryId: 999999 },
    });
    expect(res.statusCode).toBe(404);
  });

  it('fehlender/ungültiger Body -> 400', async () => {
    const { app, authHeaders } = await createTestApp();
    const desk = (await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'D' } })).json();
    for (const payload of [{}, { toEntryId: 'x' }, { toEntryId: -1 }]) {
      const res = await app.inject({ method: 'POST', url: `/api/v1/desks/${desk.id}/restore`, headers: authHeaders, payload });
      expect(res.statusCode).toBe(400);
    }
  });

  it('Nutzer ohne manage-Recht (Nur-Lesen) -> 403, rev unverändert', async () => {
    const { app, db, dataDir, a, b } = await createTestAppMitZweiNutzern();
    const meta = storeFile(db, dataDir, pdf, 'a.pdf');
    const desk = (await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'D' } })).json();
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: a.authHeaders,
      payload: { type: 'addDoc', payload: { fileId: meta.id, name: 'a.pdf', position: { x: 1, y: 2 }, id: 'doc-a' } },
    });
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(desk.id, b.userId, 'Nur-Lesen');

    const journal = (await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/journal`, headers: a.authHeaders })).json().entries as { id: number; rev: number }[];
    const zeile = journal.find((e) => e.rev === 1)!;

    const res = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/restore`, headers: b.authHeaders, payload: { toEntryId: zeile.id },
    });
    expect(res.statusCode).toBe(403);

    const state = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/state`, headers: a.authHeaders });
    expect(state.json().rev).toBe(1);
  });

  it('Zielwahl läuft über id, nicht rev — zwei Zeilen mit demselben rev liefern unterschiedliche Restore-Ergebnisse', async () => {
    const { app, db, dataDir, authHeaders } = await createTestApp();
    const meta = storeFile(db, dataDir, pdf, 'a.pdf');
    const desk = (await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'D' } })).json();
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'addDoc', payload: { fileId: meta.id, name: 'a.pdf', position: { x: 1, y: 2 }, id: 'doc-a' } },
    });

    const journalVorher = (await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/journal`, headers: authHeaders })).json().entries as { id: number; rev: number; type: string }[];
    const commandZeile = journalVorher.find((e) => e.rev === 1)!;

    // Direkt eine snapshot-Zeile mit demselben rev wie die letzte Command-Zeile anlegen — ein
    // ANDERER Zustand als der aktuelle (zwei Dokumente statt eines).
    const anderesZustand = {
      docs: [
        { id: 'doc-x', fileId: meta.id, name: 'a.pdf', position: { x: 9, y: 9 }, size: { w: 240, h: 180 }, zIndex: 1, kind: 'pdf' },
        { id: 'doc-y', fileId: meta.id, name: 'a.pdf', position: { x: 10, y: 10 }, size: { w: 240, h: 180 }, zIndex: 2, kind: 'pdf' },
      ],
      links: [], stacks: [],
    };
    appendJournal(db, {
      deskId: desk.id, rev: commandZeile.rev, type: 'snapshot', payload: { state: anderesZustand }, actorId: null, actorName: 'Test',
    });

    const journalNachher = (await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/journal`, headers: authHeaders })).json().entries as { id: number; rev: number; type: string }[];
    const snapshotZeile = journalNachher.find((e) => e.type === 'snapshot')!;
    expect(snapshotZeile.rev).toBe(commandZeile.rev);
    expect(snapshotZeile.id).not.toBe(commandZeile.id);

    const restoreAufCommand = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/restore`, headers: authHeaders, payload: { toEntryId: commandZeile.id },
    });
    expect(restoreAufCommand.statusCode).toBe(200);
    const stateNachCommand = (await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/state`, headers: authHeaders })).json();
    expect((stateNachCommand.state.docs as { id: string }[]).map((d) => d.id)).toEqual(['doc-a']);

    const restoreAufSnapshot = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/restore`, headers: authHeaders, payload: { toEntryId: snapshotZeile.id },
    });
    expect(restoreAufSnapshot.statusCode).toBe(200);
    const stateNachSnapshot = (await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/state`, headers: authHeaders })).json();
    expect((stateNachSnapshot.state.docs as { id: string }[]).map((d) => d.id).sort()).toEqual(['doc-x', 'doc-y']);
  });

  it('der Sicherheits-Snapshot trägt den Stand VOR der Wiederherstellung — ein zweiter Restore auf seine id führt zurück zum Ausgangsstand (P-01)', async () => {
    const { app, db, dataDir, authHeaders } = await createTestApp();
    const desk = (await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'D' } })).json();
    // Zwei VERSCHIEDENE Dateien: addDoc ist ein No-op, wenn dieselbe fileId schon auf dem Tisch
    // liegt (documents.ts) — für zwei tatsächlich unterschiedliche Dokumente braucht es zwei fileIds.
    const metaA = storeFile(db, dataDir, pdf, 'a.pdf');
    const metaB = storeFile(db, dataDir, Buffer.from('%PDF-1.4\nanderer inhalt'), 'b.pdf');
    for (const [id, meta] of [['doc-a', metaA], ['doc-b', metaB]] as const) {
      await app.inject({
        method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
        payload: { type: 'addDoc', payload: { fileId: meta.id, name: `${id}.pdf`, position: { x: 1, y: 2 }, id } },
      });
    }
    const stateVorRestore = (await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/state`, headers: authHeaders })).json();
    expect((stateVorRestore.state.docs as { id: string }[]).map((d) => d.id).sort()).toEqual(['doc-a', 'doc-b']);

    const journal = (await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/journal`, headers: authHeaders })).json().entries as { id: number; rev: number }[];
    const ersteAddDoc = journal.find((e) => e.rev === 1)!;

    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/restore`, headers: authHeaders, payload: { toEntryId: ersteAddDoc.id },
    });

    // Direkt aus der DB gelesen (nicht über listJournal, das ohne ctx auf '…' kürzt).
    const row = db.prepare(
      "SELECT id, payload FROM command_journal WHERE desk_id = ? AND type = 'snapshot' ORDER BY id DESC LIMIT 1",
    ).get(desk.id) as { id: number; payload: string };
    const snapshotPayload = JSON.parse(row.payload) as { state: { docs: { id: string }[] } };
    expect(snapshotPayload.state.docs.map((d) => d.id).sort()).toEqual(['doc-a', 'doc-b']);

    const zweiterRestore = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/restore`, headers: authHeaders, payload: { toEntryId: row.id },
    });
    expect(zweiterRestore.statusCode).toBe(200);

    const stateNachZweitemRestore = (await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/state`, headers: authHeaders })).json();
    expect((stateNachZweitemRestore.state.docs as { id: string }[]).map((d) => d.id).sort()).toEqual(['doc-a', 'doc-b']);
  });

  it('addDoc → Export → addDoc → Restore auf den zweiten addDoc gelingt (200), obwohl eine exported-Zeile im Replay-Bereich liegt (04-04 CR-01)', async () => {
    const { app, db, dataDir, authHeaders } = await createTestApp();
    // Zwei VERSCHIEDENE Dateien: addDoc ist ein No-op, wenn dieselbe fileId schon auf dem Tisch
    // liegt (documents.ts) — sonst bliebe die zweite addDoc-Zeile aus und rev stiege nicht auf 2.
    const metaA = storeFile(db, dataDir, pdf, 'a.pdf');
    const metaB = storeFile(db, dataDir, Buffer.from('%PDF-1.4\nzweite Datei'), 'b.pdf');
    const desk = (await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'D' } })).json();

    const erst = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'addDoc', payload: { fileId: metaA.id, name: 'a.pdf', position: { x: 1, y: 2 }, id: 'doc-a' } },
    });
    expect(erst.statusCode).toBe(200);

    const exportRes = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/export`, headers: authHeaders });
    expect(exportRes.statusCode).toBe(200);

    const zweit = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'addDoc', payload: { fileId: metaB.id, name: 'b.pdf', position: { x: 3, y: 4 }, id: 'doc-b' } },
    });
    expect(zweit.statusCode).toBe(200);

    const journal = (await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/journal`, headers: authHeaders })).json().entries as { id: number; rev: number; type: string }[];
    const zweiterAddDoc = journal.find((e) => e.type === 'addDoc' && e.rev === 2)!;

    const restoreRes = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/restore`, headers: authHeaders, payload: { toEntryId: zweiterAddDoc.id },
    });
    expect(restoreRes.statusCode).toBe(200);

    const state = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/state`, headers: authHeaders });
    expect((state.json().state.docs as { id: string }[]).map((d) => d.id).sort()).toEqual(['doc-a', 'doc-b']);
  });

  it('ein Replay-Fehler (unbekannter Command-Typ in der Historie) -> 422, rev unverändert (P-03)', async () => {
    const { app, db, authHeaders } = await createTestApp();
    const desk = (await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'D' } })).json();
    appendJournal(db, { deskId: desk.id, rev: 1, type: 'kaputterTyp', payload: {}, actorId: null, actorName: 'Test' });

    const journal = (await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/journal`, headers: authHeaders })).json().entries as { id: number; type: string }[];
    const kaputteZeile = journal.find((e) => e.type === 'kaputterTyp')!;

    const res = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/restore`, headers: authHeaders, payload: { toEntryId: kaputteZeile.id },
    });
    expect(res.statusCode).toBe(422);

    const state = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/state`, headers: authHeaders });
    expect(state.json().rev).toBe(0);
  });
});
