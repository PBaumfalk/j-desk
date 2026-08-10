import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { createTestApp, createTestAppMitZweiNutzern } from './testUtils';
import { openDb } from './db';
import { createDesk, getDeskState, putDeskState } from './deskStore';
import { listJournal } from './journal';
import { buildPackage, readPackage } from './jdesk';
import { storeFile } from './files';
import { createUser } from './auth';
import { warteAufLeerlauf } from './ocr/ocrQueue';

const pdf = Buffer.from('%PDF-1.4\ninhalt');

/**
 * Journal-Payload-Projektion (02-05 Task 2, PERM-05/T-02-04) + .jdesk-Export-Projektion
 * (02-05 Task 3, PERM-05/T-02-05) — die letzten beiden der 10 Auslieferungspfade
 * (02-RESEARCH.md), die noch nicht durch projectStateForActor() liefen.
 */

describe('Task 2: listJournal() projiziert Payloads pro Betrachter', () => {
  it('projiziert das state-Feld state-tragender Einträge mit Betrachter-Kontext statt es nur auf \'…\' zu kürzen', async () => {
    const db = openDb(':memory:');
    const userIdA = await createUser(db, 'nutzer-a', 'test-passwort');
    const desk = createDesk(db, userIdA, 'Akte A', { id: userIdA, name: 'A' });
    putDeskState(db, desk.id, {
      docs: [], links: [], stacks: [],
      layers: [{ id: 'privat-a', typ: 'privat', name: 'Privat', ownerUserId: userIdA }],
      notes: [
        { id: 'n-privat', kind: 'notiz', text: 'geheim', position: { x: 0, y: 0 }, zIndex: 1, layerId: 'privat-a' },
        { id: 'n-oeffentlich', kind: 'notiz', text: 'für alle', position: { x: 1, y: 1 }, zIndex: 2 },
      ],
    }, { type: 'stateReplaced', actor: { id: userIdA, name: 'A' } });

    // Ohne Betrachter-Kontext: Bestandsverhalten (Kürzung auf '…') bleibt unangetastet.
    const ohneKontext = listJournal(db, desk.id);
    const eintragOhne = ohneKontext.find((e) => e.type === 'stateReplaced')!;
    expect((eintragOhne.payload as { state: unknown }).state).toBe('…');

    // Mit Betrachter-Kontext (B, kein Zugriff auf die private Ebene von A): projizierter State
    // statt Kürzung — das private Objekt fehlt, das öffentliche bleibt.
    const mitKontext = listJournal(db, desk.id, {
      ctx: { userId: 'user-b', rolle: 'Bearbeiter' },
      state: getDeskState(db, desk.id)!.state,
    });
    const eintragMit = mitKontext.find((e) => e.type === 'stateReplaced')!;
    const projiziert = (eintragMit.payload as { state: { notes: { id: string }[] } }).state;
    expect(projiziert.notes.map((n) => n.id)).not.toContain('n-privat');
    expect(projiziert.notes.map((n) => n.id)).toContain('n-oeffentlich');
  });

  it('addCutout-Journal-Eintrag mit textSnapshot eines (nachträglich) privaten Fremdobjekts ist für B in GET /journal nicht sichtbar', async () => {
    const { app, db, dataDir, a, b } = await createTestAppMitZweiNutzern();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte A' } })
    ).json();
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(desk.id, b.userId, 'Bearbeiter');
    const meta = storeFile(db, dataDir, pdf, 'a.pdf');
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: a.authHeaders,
      payload: { type: 'addDoc', payload: { fileId: meta.id, name: 'a.pdf', position: { x: 0, y: 0 }, id: 'doc-1' } },
    });
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: a.authHeaders,
      payload: {
        type: 'addCutout',
        payload: { docId: 'doc-1', page: 1, rect: { x: 0, y: 0, w: 10, h: 10 }, position: { x: 1, y: 1 }, id: 'cut-1', textSnapshot: 'geheimer Fundstellentext' },
      },
    });

    // A verschiebt den Ausschnitt nachträglich auf eine private Ebene — direkte
    // State-Manipulation als Fixture-Kürzel (der Command-Weg über die Platzhalter-id 'privat'
    // existiert seit 02-09; hier steht die Journal-Projektion im Fokus, nicht der Anlage-Pfad).
    const vorher = getDeskState(db, desk.id)!.state;
    putDeskState(db, desk.id, {
      ...vorher,
      layers: [{ id: 'privat-a', typ: 'privat', name: 'Privat', ownerUserId: a.userId }],
      cutouts: (vorher.cutouts ?? []).map((c) => (c.id === 'cut-1' ? { ...c, layerId: 'privat-a' } : c)),
    });

    const resB = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/journal`, headers: b.authHeaders });
    expect(resB.statusCode).toBe(200);
    const entriesB = resB.json().entries as { type: string; payload: unknown }[];
    expect(entriesB.find((e) => e.type === 'addCutout')).toBeUndefined();

    // A (Eigentümer, sieht die eigene private Ebene) sieht den Eintrag inklusive textSnapshot weiterhin.
    const resA = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/journal`, headers: a.authHeaders });
    const entriesA = resA.json().entries as { type: string; payload: { textSnapshot?: string } }[];
    expect(entriesA.find((e) => e.type === 'addCutout')?.payload).toMatchObject({ textSnapshot: 'geheimer Fundstellentext' });
  });

  it('CR-03: addNote/editNote-Journal-Einträge mit Volltext einer (nachträglich) privaten Notiz sind für B nicht sichtbar', async () => {
    const { app, db, a, b } = await createTestAppMitZweiNutzern();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte A' } })
    ).json();
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(desk.id, b.userId, 'Bearbeiter');
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: a.authHeaders,
      payload: { type: 'addNote', payload: { id: 'n-geheim', kind: 'notiz', text: 'GEHEIMER-NOTIZTEXT-9f2c', position: { x: 0, y: 0 } } },
    });
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: a.authHeaders,
      payload: { type: 'editNote', payload: { id: 'n-geheim', text: 'GEHEIMER-NOTIZTEXT-9f2c v2' } },
    });

    // A stellt die Notiz nachträglich auf seine private Ebene (direkte State-Manipulation als
    // Fixture-Kürzel wie oben — der Command-Weg existiert seit 02-09).
    const vorher = getDeskState(db, desk.id)!.state;
    putDeskState(db, desk.id, {
      ...vorher,
      layers: [{ id: 'privat-a', typ: 'privat', name: 'Privat', ownerUserId: a.userId }],
      notes: (vorher.notes ?? []).map((n) => (n.id === 'n-geheim' ? { ...n, layerId: 'privat-a' } : n)),
    });

    // B (Bearbeiter, kein Sichtrecht auf die private Ebene): weder addNote- noch editNote-
    // Eintrag dürfen in der Historie auftauchen — der Volltext läuft sonst über Pfad 7 weiter.
    const resB = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/journal`, headers: b.authHeaders });
    expect(resB.statusCode).toBe(200);
    const entriesB = resB.json().entries as { type: string }[];
    expect(entriesB.find((e) => e.type === 'addNote')).toBeUndefined();
    expect(entriesB.find((e) => e.type === 'editNote')).toBeUndefined();
    expect(JSON.stringify(resB.json())).not.toContain('GEHEIMER-NOTIZTEXT-9f2c');

    // A (Eigentümer der privaten Ebene) sieht beide Einträge inklusive Text weiterhin.
    const resA = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/journal`, headers: a.authHeaders });
    expect(JSON.stringify(resA.json())).toContain('GEHEIMER-NOTIZTEXT-9f2c');
  });

  it('GET /journal ohne ausreichende Rolle (Kommentator) -> 403', async () => {
    const { app, db, a, b } = await createTestAppMitZweiNutzern();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte A' } })
    ).json();
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(desk.id, b.userId, 'Kommentator');
    const res = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/journal`, headers: b.authHeaders });
    expect(res.statusCode).toBe(403);
  });

  it('Eigentümer und Bearbeiter erhalten die (projizierte) Historie', async () => {
    const { app, db, a, b } = await createTestAppMitZweiNutzern();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte A' } })
    ).json();
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(desk.id, b.userId, 'Bearbeiter');
    const resA = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/journal`, headers: a.authHeaders });
    expect(resA.statusCode).toBe(200);
    const resB = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/journal`, headers: b.authHeaders });
    expect(resB.statusCode).toBe(200);
  });

  it('WR-01: öffentliche Notiz → Papierkorb — addNote/editNote bleiben in der Historie ALLER Betrachter (Korb-Kopie trägt die layerId weiter)', async () => {
    const { app, db, a, b } = await createTestAppMitZweiNutzern();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte A' } })
    ).json();
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(desk.id, b.userId, 'Bearbeiter');
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: a.authHeaders,
      payload: { type: 'addNote', payload: { id: 'n-offen', kind: 'notiz', text: 'OFFENER-TEXT-7a1f', position: { x: 0, y: 0 } } },
    });
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: a.authHeaders,
      payload: { type: 'editNote', payload: { id: 'n-offen', text: 'OFFENER-TEXT-7a1f v2' } },
    });
    const trash = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: a.authHeaders,
      payload: { type: 'trashObject', payload: { id: 'n-offen', trashedAt: new Date().toISOString() } },
    });
    expect(trash.statusCode).toBe(200);

    // Vor dem Fix verschwanden addNote/editNote mit dem Wegwerfen aus der Historie ALLER
    // Nutzer — der Audit-Trail verlor die Vorgeschichte jedes Korb-Objekts.
    const typen = async (headers: { authorization: string }) => {
      const res = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/journal`, headers });
      expect(res.statusCode).toBe(200);
      return (res.json().entries as { type: string }[]).map((e) => e.type);
    };
    for (const headers of [a.authHeaders, b.authHeaders]) {
      const t = await typen(headers);
      expect(t).toContain('addNote');
      expect(t).toContain('editNote');
      expect(t).toContain('trashObject');
    }
  });

  it('WR-01: privat gestellte Notiz → Papierkorb — Einträge bleiben bei B verborgen, bei A sichtbar (CR-03-Leck bleibt geschlossen)', async () => {
    const MARKER = 'PRIVAT-KORB-MARKER-3e9b';
    const { app, db, a, b } = await createTestAppMitZweiNutzern();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte A' } })
    ).json();
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(desk.id, b.userId, 'Bearbeiter');
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: a.authHeaders,
      payload: { type: 'addNote', payload: { id: 'n-priv', kind: 'notiz', text: MARKER, position: { x: 0, y: 0 } } },
    });

    // A stellt die Notiz auf seine private Ebene und wirft sie danach weg (direkte
    // State-Manipulation für die private Ebene wie in den CR-03-Tests oben).
    const vorher = getDeskState(db, desk.id)!.state;
    putDeskState(db, desk.id, {
      ...vorher,
      layers: [{ id: 'privat-a', typ: 'privat', name: 'Privat', ownerUserId: a.userId }],
      notes: (vorher.notes ?? []).map((n) => (n.id === 'n-priv' ? { ...n, layerId: 'privat-a' } : n)),
    });
    const trash = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: a.authHeaders,
      payload: { type: 'trashObject', payload: { id: 'n-priv', trashedAt: new Date().toISOString() } },
    });
    expect(trash.statusCode).toBe(200);

    // B (kein Sichtrecht auf die private Ebene): der Volltext darf auch über die Korb-
    // Kopie nicht wieder auftauchen — Eintrag bleibt ausgelassen (CR-03-Schutz greift).
    const resB = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/journal`, headers: b.authHeaders });
    expect(resB.statusCode).toBe(200);
    expect((resB.json().entries as { type: string }[]).find((e) => e.type === 'addNote')).toBeUndefined();
    expect(JSON.stringify(resB.json())).not.toContain(MARKER);

    // A (Eigentümer der privaten Ebene) sieht die Vorgeschichte seiner Korb-Notiz weiterhin.
    const resA = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/journal`, headers: a.authHeaders });
    const typenA = (resA.json().entries as { type: string }[]).map((e) => e.type);
    expect(typenA).toContain('addNote');
    expect(typenA).toContain('trashObject');
  });
});

describe('mandant-Stufe (EXP-03, D-06): REST-Auslieferung an externen Gast', () => {
  const MARKER_MANDANT = 'MARKER-MANDANT-8c2e';
  const MARKER_INTERN = 'MARKER-INTERN-5b1d';

  /** Desk von A mit zwei Notizen (mandant-Override via setFreigabe-Command, Kanzlei-Default). */
  async function deskMitMarkern() {
    const ctx = await createTestAppMitZweiNutzern();
    const desk = (
      await ctx.app.inject({ method: 'POST', url: '/api/v1/desks', headers: ctx.a.authHeaders, payload: { name: 'Akte A' } })
    ).json();
    // Objekte per echten Commands anlegen — kein Direkt-State-Zugriff im Aufbau.
    await ctx.app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: ctx.a.authHeaders,
      payload: { type: 'addNote', payload: { id: 'n-mandant', kind: 'notiz', text: MARKER_MANDANT, position: { x: 0, y: 0 } } },
    });
    await ctx.app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: ctx.a.authHeaders,
      payload: { type: 'addNote', payload: { id: 'n-intern', kind: 'notiz', text: MARKER_INTERN, position: { x: 1, y: 1 } } },
    });
    // Freigabe-Override per setFreigabe-Command (03-01): 'mandant' = Gast-sichtbar, nicht Export.
    const freigabe = await ctx.app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: ctx.a.authHeaders,
      payload: { type: 'setFreigabe', payload: { objectId: 'n-mandant', freigabe: 'mandant' } },
    });
    expect(freigabe.statusCode).toBe(200);
    return { ...ctx, desk };
  }

  it('externer Gast erhält über GET /state den mandant-Marker, den intern-Marker nicht', async () => {
    const { app, db, b, desk } = await deskMitMarkern();
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(desk.id, b.userId, 'externer Gast');

    const res = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/state`, headers: b.authHeaders });
    expect(res.statusCode).toBe(200);
    const json = JSON.stringify(res.json());
    expect(json).toContain(MARKER_MANDANT);
    expect(json).not.toContain(MARKER_INTERN);
  });

  it('derselbe Stand als Bearbeiter enthält beide Marker (kein Verhaltensbruch, T-03-02-03)', async () => {
    const { app, db, b, desk } = await deskMitMarkern();
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(desk.id, b.userId, 'Bearbeiter');

    const res = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/state`, headers: b.authHeaders });
    expect(res.statusCode).toBe(200);
    const json = JSON.stringify(res.json());
    expect(json).toContain(MARKER_MANDANT);
    expect(json).toContain(MARKER_INTERN);
  });
});

describe('Task 3: buildPackage() projiziert VOR sanitizeForExport() + Export-Guard', () => {
  it('buildPackage mit einem Actor ohne Sicht auf ein privates Objekt erzeugt ein Paket, dessen entpacktes JSON dieses Objekt nicht enthält', async () => {
    const db = openDb(':memory:');
    const dataDir = mkdtempSync(join(tmpdir(), 'dd-export-projektion-'));
    const userIdA = await createUser(db, 'nutzer-a', 'test-passwort');
    const desk = createDesk(db, userIdA, 'Akte A', { id: userIdA, name: 'A' });
    putDeskState(db, desk.id, {
      docs: [], links: [], stacks: [],
      layers: [{ id: 'privat-a', typ: 'privat', name: 'Privat', ownerUserId: userIdA }],
      notes: [
        { id: 'n-privat', kind: 'notiz', text: 'geheim', position: { x: 0, y: 0 }, zIndex: 1, layerId: 'privat-a' },
        { id: 'n-oeffentlich', kind: 'notiz', text: 'für alle', position: { x: 1, y: 1 }, zIndex: 2 },
      ],
    }, { type: 'stateReplaced', actor: { id: 'user-a', name: 'A' } });

    const paket = buildPackage(db, dataDir, desk.id, { createdBy: 'B', jlawyer: false, userId: 'user-b', rolle: 'Bearbeiter' });
    const { state } = readPackage(paket);
    expect((state.notes ?? []).map((n) => n.id)).not.toContain('n-privat');
    expect((state.notes ?? []).map((n) => n.id)).toContain('n-oeffentlich');
  });

  it('GET /export ohne Export-Recht (Kommentator) -> 403', async () => {
    const { app, db, a, b } = await createTestAppMitZweiNutzern();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte A' } })
    ).json();
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(desk.id, b.userId, 'Kommentator');
    const res = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/export`, headers: b.authHeaders });
    expect(res.statusCode).toBe(403);
  });

  it('GET /export: Bearbeiter mit Exportrecht erhält ein Paket ohne privates Fremdobjekt von A', async () => {
    const { app, db, a, b } = await createTestAppMitZweiNutzern();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte A' } })
    ).json();
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(desk.id, b.userId, 'Bearbeiter');
    putDeskState(db, desk.id, {
      docs: [], links: [], stacks: [],
      layers: [{ id: 'privat-a', typ: 'privat', name: 'Privat', ownerUserId: a.userId }],
      notes: [
        { id: 'n-privat', kind: 'notiz', text: 'geheim', position: { x: 0, y: 0 }, zIndex: 1, layerId: 'privat-a' },
        { id: 'n-oeffentlich', kind: 'notiz', text: 'für alle', position: { x: 1, y: 1 }, zIndex: 2 },
      ],
    }, { type: 'stateReplaced', actor: { id: a.userId, name: 'A' } });

    const res = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/export`, headers: b.authHeaders });
    expect(res.statusCode).toBe(200);
    const { state } = readPackage(res.rawPayload);
    expect((state.notes ?? []).map((n) => n.id)).not.toContain('n-privat');
    expect((state.notes ?? []).map((n) => n.id)).toContain('n-oeffentlich');
  });
});

/**
 * GET /desks/:id/file-text/:fileId (COMP-01/02, 09-08 Task 2) — die einzige neue Serverroute
 * dieser Phase, deshalb hier zusätzlich zur Modultests-Suite (fileText.test.ts) auf HTTP-Ebene
 * abgesichert: derselbe Guard wie GET /state (T-09-33), GENAU EIN Ablehnungszweig für
 * „nicht sichtbar" und „gibt es nicht" (T-09-32).
 */
describe('GET /desks/:id/file-text/:fileId (COMP-01/02, 09-08)', () => {
  it('liefert für eine sichtbare Datei die Seitenliste mit demselben Guard wie /state', async () => {
    const { app, db, dataDir, authHeaders } = await createTestApp();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'Akte' } })
    ).json();
    const meta = storeFile(db, dataDir, Buffer.from('%PDF-1.4\nrouten-text'), 'routen-text.pdf');
    await warteAufLeerlauf();
    db.prepare(
      `INSERT INTO file_extract (file_id, stand, seiten, fehler, aktualisiert_am)
       VALUES (?, 'pdf-text', 1, NULL, ?)
       ON CONFLICT(file_id) DO UPDATE SET
         stand = excluded.stand, seiten = excluded.seiten, fehler = excluded.fehler,
         aktualisiert_am = excluded.aktualisiert_am`,
    ).run(meta.id, Date.now());
    db.prepare('DELETE FROM file_pages WHERE file_id = ?').run(meta.id);
    db.prepare(
      'INSERT INTO file_pages (file_id, page, pdf_text, ocr_text, ocr_confidence) VALUES (?, 1, ?, NULL, NULL)',
    ).run(meta.id, 'Routentest-Inhalt');
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'addDoc', payload: { id: 'doc-routen-test', fileId: meta.id, name: 'Schreiben', position: { x: 0, y: 0 } } },
    });

    const res = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/file-text/${meta.id}`, headers: authHeaders });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ stand: 'pdf-text', seiten: [{ seite: 1, text: 'Routentest-Inhalt', quelle: 'pdf-text' }] });
  });

  it('ohne gültigen Token liefert die Route 401 — kein neuer, ungeschützter Auslieferungspfad', async () => {
    const { app } = await createTestApp();
    const res = await app.inject({
      method: 'GET', url: '/api/v1/desks/irgendein-desk/file-text/irgendeine-datei',
      headers: { authorization: 'Bearer ungueltig' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('ein Nutzer ohne Rolle am Schreibtisch wird abgelehnt (403) — derselbe Guard wie /state', async () => {
    const { app, a, b } = await createTestAppMitZweiNutzern();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte A' } })
    ).json();
    // b hat für DIESEN Desk keine Rolle (createTestAppMitZweiNutzern vergibt standardmäßig keine).
    const res = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/file-text/irgendeine-datei`, headers: b.authHeaders });
    expect(res.statusCode).toBe(403);
  });

  it('liefert für eine nicht sichtbare (private) und eine nicht existierende Datei-id denselben Statuscode und denselben Antwortkörper', async () => {
    const { app, db, dataDir, a, b } = await createTestAppMitZweiNutzern();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte A' } })
    ).json();
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(desk.id, b.userId, 'Bearbeiter');

    const meta = storeFile(db, dataDir, Buffer.from('%PDF-1.4\nprivat-route'), 'privat-route.pdf');
    await warteAufLeerlauf();
    db.prepare(
      `INSERT INTO file_extract (file_id, stand, seiten, fehler, aktualisiert_am)
       VALUES (?, 'pdf-text', 1, NULL, ?)
       ON CONFLICT(file_id) DO UPDATE SET
         stand = excluded.stand, seiten = excluded.seiten, fehler = excluded.fehler,
         aktualisiert_am = excluded.aktualisiert_am`,
    ).run(meta.id, Date.now());
    db.prepare('DELETE FROM file_pages WHERE file_id = ?').run(meta.id);
    db.prepare(
      'INSERT INTO file_pages (file_id, page, pdf_text, ocr_text, ocr_confidence) VALUES (?, 1, ?, NULL, NULL)',
    ).run(meta.id, 'Geheim');
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: a.authHeaders,
      payload: { type: 'addDoc', payload: { id: 'doc-privat-route', fileId: meta.id, name: 'Privates Schreiben', position: { x: 0, y: 0 } } },
    });
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: a.authHeaders,
      payload: { type: 'changeLayerId', payload: { objectId: 'doc-privat-route', layerId: 'privat' } },
    });

    const resUnsichtbar = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/file-text/${meta.id}`, headers: b.authHeaders });
    const resNichtExistent = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/file-text/datei-gibt-es-nicht`, headers: b.authHeaders });
    expect(resUnsichtbar.statusCode).toBe(resNichtExistent.statusCode);
    expect(resUnsichtbar.json()).toEqual(resNichtExistent.json());
    expect(resUnsichtbar.statusCode).toBe(404);
  });
});
