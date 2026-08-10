import { describe, it, expect } from 'vitest';
import { createTestAppMitZweiNutzern } from './testUtils';
import { putDeskState, getDeskState } from './deskStore';
import { storeFile } from './files';

/**
 * Rollen- & Zugriffsguards auf den REST-Desk-Routen (PERM-03/PERM-04/PERM-05, 02-04).
 *
 * REST-Pfade 1–4/9 der 10-Pfade-Tabelle (02-RESEARCH.md): GET /desks (Liste), GET /state,
 * POST /commands, PUT /state, POST /import. Broadcast/Journal/Export/WS sind spätere Pläne.
 */

describe('Task 1: Guards + Projektion auf GET /desks, /state, POST /commands, PUT /state, /import', () => {
  it('Nutzer B sieht den Desk von Nutzer A nicht in GET /desks und bekommt 403 auf GET /state', async () => {
    const { app, a, b } = await createTestAppMitZweiNutzern();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte A' } })
    ).json();

    const listeB = await app.inject({ method: 'GET', url: '/api/v1/desks', headers: b.authHeaders });
    expect(listeB.json()).toEqual([]);

    const stateB = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/state`, headers: b.authHeaders });
    expect(stateB.statusCode).toBe(403);
  });

  it('Nutzer A (Eigentümer) sieht den eigenen Desk in GET /desks und bekommt 200 auf GET /state', async () => {
    const { app, a } = await createTestAppMitZweiNutzern();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte A' } })
    ).json();

    const listeA = await app.inject({ method: 'GET', url: '/api/v1/desks', headers: a.authHeaders });
    expect(listeA.json()).toHaveLength(1);

    const stateA = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/state`, headers: a.authHeaders });
    expect(stateA.statusCode).toBe(200);
    expect(stateA.json().rev).toBe(0);
  });

  it('unbekannter Schreibtisch bleibt 404 (nicht 403) — auch mit registriertem Guard', async () => {
    const { app, a } = await createTestAppMitZweiNutzern();
    const res = await app.inject({ method: 'GET', url: '/api/v1/desks/gibtsnicht/state', headers: a.authHeaders });
    expect(res.statusCode).toBe(404);
  });

  it('PUT /state und POST /import durch einen Nutzer ohne Bearbeiter-Recht -> 403', async () => {
    const { app, db, a, b } = await createTestAppMitZweiNutzern();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte A' } })
    ).json();
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(desk.id, b.userId, 'Kommentator');

    const put = await app.inject({
      method: 'PUT', url: `/api/v1/desks/${desk.id}/state`, headers: b.authHeaders,
      payload: { docs: [], links: [], stacks: [] },
    });
    expect(put.statusCode).toBe(403);

    const boundary = '----importtest';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="p.jdesk"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      Buffer.from('irrelevant'),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const imp = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/import`,
      headers: { ...b.authHeaders, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(imp.statusCode).toBe(403);
  });

  it('POST /commands-Antwort ist projiziert: privates Objekt von A fehlt in der Antwort an B', async () => {
    const { app, db, a, b } = await createTestAppMitZweiNutzern();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte A' } })
    ).json();
    // B bekommt eine Rolle (Bearbeiter) am Desk von A.
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(desk.id, b.userId, 'Bearbeiter');
    // A legt direkt im State eine private Notiz an (private Ebene mit ownerUserId = a, s. 02-01).
    putDeskState(db, desk.id, {
      docs: [], links: [], stacks: [],
      layers: [{ id: 'privat-a', typ: 'privat', name: 'Privat', ownerUserId: a.userId }],
      notes: [{ id: 'n-a-privat', kind: 'notiz', text: 'geheim', position: { x: 0, y: 0 }, zIndex: 1, layerId: 'privat-a' }],
    });

    const res = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: b.authHeaders,
      payload: { type: 'addNote', payload: { id: 'n-b', kind: 'notiz', text: 'sichtbar', position: { x: 1, y: 1 } } },
    });
    expect(res.statusCode).toBe(200);
    const noteIds = (res.json().state.notes as { id: string }[]).map((n) => n.id);
    expect(noteIds).toContain('n-b');
    expect(noteIds).not.toContain('n-a-privat');
  });
});

describe('Task 2: Command-Rechteprüfung (gefährliche Aktionen -> 403) + Server-Feldhoheit', () => {
  it('Kommentator-Lösch-Command -> 403, kein State-Wechsel', async () => {
    const { app, db, a, b } = await createTestAppMitZweiNutzern();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte A' } })
    ).json();
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(desk.id, b.userId, 'Kommentator');
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: a.authHeaders,
      payload: { type: 'addNote', payload: { id: 'n1', kind: 'notiz', text: 'x', position: { x: 0, y: 0 } } },
    });

    const res = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: b.authHeaders,
      payload: { type: 'removeNote', payload: { id: 'n1' } },
    });
    expect(res.statusCode).toBe(403);

    const state = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/state`, headers: a.authHeaders });
    expect(state.json().rev).toBe(1); // nur der addNote-Command hat gewirkt
    expect((state.json().state.notes as { id: string }[]).map((n) => n.id)).toContain('n1');
  });

  it('Nur-Lesen mutierender Command -> 403', async () => {
    const { app, db, a, b } = await createTestAppMitZweiNutzern();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte A' } })
    ).json();
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(desk.id, b.userId, 'Nur-Lesen');

    const res = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: b.authHeaders,
      payload: { type: 'addNote', payload: { id: 'n1', kind: 'notiz', text: 'x', position: { x: 0, y: 0 } } },
    });
    expect(res.statusCode).toBe(403);
  });

  it('Kommentator darf eine eigene Notiz anlegen, aber keine fremde Notiz bearbeiten (403)', async () => {
    const { app, db, a, b } = await createTestAppMitZweiNutzern();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte A' } })
    ).json();
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(desk.id, b.userId, 'Kommentator');

    const eigene = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: b.authHeaders,
      payload: { type: 'addNote', payload: { id: 'n-b', kind: 'notiz', text: 'eigen', position: { x: 0, y: 0 } } },
    });
    expect(eigene.statusCode).toBe(200);

    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: a.authHeaders,
      payload: { type: 'addNote', payload: { id: 'n-a', kind: 'notiz', text: 'fremd', position: { x: 1, y: 1 } } },
    });

    const fremdBearbeiten = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: b.authHeaders,
      payload: { type: 'editNote', payload: { id: 'n-a', text: 'veraendert' } },
    });
    expect(fremdBearbeiten.statusCode).toBe(403);

    const eigeneBearbeiten = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: b.authHeaders,
      payload: { type: 'editNote', payload: { id: 'n-b', text: 'angepasst' } },
    });
    expect(eigeneBearbeiten.statusCode).toBe(200);
  });

  it('CR-03: Bearbeiter darf removeLegalObject/removeTable nicht (403) — Eigentümer-only Löschregel', async () => {
    const { app, db, a, b } = await createTestAppMitZweiNutzern();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte A' } })
    ).json();
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(desk.id, b.userId, 'Bearbeiter');
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: a.authHeaders,
      payload: { type: 'addLegalObject', payload: { id: 'lo1', kind: 'tatsache', text: 'x', position: { x: 0, y: 0 } } },
    });
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: a.authHeaders,
      payload: { type: 'addTable', payload: { id: 'tb1', position: { x: 0, y: 0 } } },
    });

    const removeLo = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: b.authHeaders,
      payload: { type: 'removeLegalObject', payload: { id: 'lo1' } },
    });
    expect(removeLo.statusCode).toBe(403);

    const removeTb = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: b.authHeaders,
      payload: { type: 'removeTable', payload: { id: 'tb1' } },
    });
    expect(removeTb.statusCode).toBe(403);

    const state = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/state`, headers: a.authHeaders });
    expect((state.json().state.legalObjects as { id: string }[]).map((o) => o.id)).toContain('lo1');
    expect((state.json().state.tables as { id: string }[]).map((t) => t.id)).toContain('tb1');
  });

  it('11-REVIEW CR-01: Bearbeiter darf removeSitzungsmappe nicht (403) — endgültig, kein Papierkorb', async () => {
    const { app, db, a, b } = await createTestAppMitZweiNutzern();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte A' } })
    ).json();
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(desk.id, b.userId, 'Bearbeiter');
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: a.authHeaders,
      payload: { type: 'addSitzungsmappe', payload: { id: 'sm1', titel: 'Sitzung' } },
    });

    const res = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: b.authHeaders,
      payload: { type: 'removeSitzungsmappe', payload: { id: 'sm1' } },
    });
    expect(res.statusCode).toBe(403);

    // Eigentümer darf weiterhin löschen (Matrix-Referenz: 'delete' wie removeTable).
    const ok = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: a.authHeaders,
      payload: { type: 'removeSitzungsmappe', payload: { id: 'sm1' } },
    });
    expect(ok.statusCode).toBe(200);

    const state = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/state`, headers: a.authHeaders });
    expect((state.json().state.sitzungsmappen as { id: string }[]).map((m) => m.id)).not.toContain('sm1');
  });

  it('11-REVIEW CR-01-Nebenbefund: Bearbeiter darf removeZeitleiste nicht (403) — gleiche Matrix-Lücke', async () => {
    const { app, db, a, b } = await createTestAppMitZweiNutzern();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte A' } })
    ).json();
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(desk.id, b.userId, 'Bearbeiter');
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: a.authHeaders,
      payload: { type: 'addZeitleiste', payload: { id: 'zl1', position: { x: 0, y: 0 } } },
    });

    const res = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: b.authHeaders,
      payload: { type: 'removeZeitleiste', payload: { id: 'zl1' } },
    });
    expect(res.statusCode).toBe(403);

    const state = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/state`, headers: a.authHeaders });
    expect((state.json().state.zeitleisten as { id: string }[]).map((z) => z.id)).toContain('zl1');
  });

  it('ein im Payload mitgeschickter rolle-Wert ist wirkungslos (keine Rechte-Umgehung über den Payload)', async () => {
    const { app, db, a, b } = await createTestAppMitZweiNutzern();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte A' } })
    ).json();
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(desk.id, b.userId, 'Kommentator');

    // addStroke ist fuer Kommentator nicht erlaubt — ein mitgeschicktes "rolle": "Eigentümer"
    // im Payload darf daran nichts aendern (Threat T-02-03).
    const res = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: b.authHeaders,
      payload: {
        type: 'addStroke',
        payload: { stroke: { points: [{ x: 0, y: 0 }], color: '#000', width: 2 }, rolle: 'Eigentümer' },
      },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('CR-01: PATCH/DELETE /desks/:id sind guard-pflichtig (PERM-04)', () => {
  it('Nutzer ohne jede Rolle kann fremde Desks weder umbenennen (403) noch löschen (403)', async () => {
    const { app, a, b } = await createTestAppMitZweiNutzern();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte A' } })
    ).json();

    const patch = await app.inject({
      method: 'PATCH', url: `/api/v1/desks/${desk.id}`, headers: b.authHeaders, payload: { name: 'Uebernommen' },
    });
    expect(patch.statusCode).toBe(403);

    const del = await app.inject({ method: 'DELETE', url: `/api/v1/desks/${desk.id}`, headers: b.authHeaders });
    expect(del.statusCode).toBe(403);

    // Der Desk ist unverändert da, unter altem Namen.
    const liste = await app.inject({ method: 'GET', url: '/api/v1/desks', headers: a.authHeaders });
    expect(liste.json()).toEqual([expect.objectContaining({ id: desk.id, name: 'Akte A' })]);
  });

  it('Bearbeiter darf umbenennen (200), aber NICHT löschen (403) — delete ist Eigentümer-Aktion', async () => {
    const { app, db, a, b } = await createTestAppMitZweiNutzern();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte A' } })
    ).json();
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(desk.id, b.userId, 'Bearbeiter');

    const patch = await app.inject({
      method: 'PATCH', url: `/api/v1/desks/${desk.id}`, headers: b.authHeaders, payload: { name: 'Akte A (bearb.)' },
    });
    expect(patch.statusCode).toBe(200);

    const del = await app.inject({ method: 'DELETE', url: `/api/v1/desks/${desk.id}`, headers: b.authHeaders });
    expect(del.statusCode).toBe(403);

    // Eigentümer darf löschen.
    const delA = await app.inject({ method: 'DELETE', url: `/api/v1/desks/${desk.id}`, headers: a.authHeaders });
    expect(delA.statusCode).toBe(200);
  });

  it('unbekannter Desk bleibt 404 (nicht 403) — DeskNotFoundError im Guard', async () => {
    const { app, a } = await createTestAppMitZweiNutzern();
    const patch = await app.inject({
      method: 'PATCH', url: '/api/v1/desks/gibtsnicht', headers: a.authHeaders, payload: { name: 'Neu' },
    });
    expect(patch.statusCode).toBe(404);
    const del = await app.inject({ method: 'DELETE', url: '/api/v1/desks/gibtsnicht', headers: a.authHeaders });
    expect(del.statusCode).toBe(404);
  });
});

describe('CR-04: serverseitige Ebenen-Bearbeitungsprüfung (PERM-02, T-02-03)', () => {
  /** Desk von A mit einer privaten Ebene von A und je einem privaten/öffentlichen Objekt. */
  async function aufbauMitPrivaterEbene(rolleB: string) {
    const { app, db, a, b } = await createTestAppMitZweiNutzern();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte A' } })
    ).json();
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(desk.id, b.userId, rolleB);
    putDeskState(db, desk.id, {
      docs: [
        { id: 'doc-privat', fileId: 'f1', name: 'geheim.pdf', position: { x: 0, y: 0 }, rotation: 0, zIndex: 1, layerId: 'privat-a' },
        { id: 'doc-offen', fileId: 'f2', name: 'offen.pdf', position: { x: 1, y: 1 }, rotation: 0, zIndex: 2 },
      ],
      links: [], stacks: [],
      layers: [{ id: 'privat-a', typ: 'privat', name: 'Privat', ownerUserId: a.userId }],
      notes: [{ id: 'n-privat', kind: 'notiz', text: 'geheim', position: { x: 0, y: 0 }, zIndex: 1, layerId: 'privat-a' }],
    });
    return { app, db, a, b, deskId: desk.id as string };
  }

  it('Bearbeiter kann ein fremdes Privatobjekt NICHT per changeLayerId auf kanzlei ziehen (403, Objekt bleibt privat)', async () => {
    const { app, db, b, deskId } = await aufbauMitPrivaterEbene('Bearbeiter');
    const res = await app.inject({
      method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers: b.authHeaders,
      payload: { type: 'changeLayerId', payload: { objectId: 'n-privat', layerId: 'kanzlei' } },
    });
    expect(res.statusCode).toBe(403);
    const state = getDeskState(db, deskId)!.state;
    expect(state.notes!.find((n) => n.id === 'n-privat')!.layerId).toBe('privat-a');
  });

  it('Bearbeiter kann ein öffentliches Objekt NICHT auf eine fremde private Ebene verschieben (403)', async () => {
    const { app, db, b, deskId } = await aufbauMitPrivaterEbene('Bearbeiter');
    const res = await app.inject({
      method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers: b.authHeaders,
      payload: { type: 'changeLayerId', payload: { objectId: 'doc-offen', layerId: 'privat-a' } },
    });
    expect(res.statusCode).toBe(403);
    expect(getDeskState(db, deskId)!.state.docs.find((d) => d.id === 'doc-offen')!.layerId).toBeUndefined();
  });

  it('changeLayerId auf die KI-Vorschläge-Ebene ist niemandem direkt erlaubt (403, nur via Übernahme)', async () => {
    const { app, a, deskId } = await aufbauMitPrivaterEbene('Bearbeiter');
    const res = await app.inject({
      method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers: a.authHeaders,
      payload: { type: 'changeLayerId', payload: { objectId: 'doc-offen', layerId: 'ki-vorschlaege' } },
    });
    expect(res.statusCode).toBe(403);
  });

  it('Eigentümer der privaten Ebene darf das eigene Objekt weiterhin umhängen (200)', async () => {
    const { app, db, a, deskId } = await aufbauMitPrivaterEbene('Bearbeiter');
    const res = await app.inject({
      method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers: a.authHeaders,
      payload: { type: 'changeLayerId', payload: { objectId: 'n-privat', layerId: 'kanzlei' } },
    });
    expect(res.statusCode).toBe(200);
    expect(getDeskState(db, deskId)!.state.notes!.find((n) => n.id === 'n-privat')!.layerId).toBe('kanzlei');
  });

  it('Bearbeiter kann fremde Privatobjekte nicht mutieren/wegwerfen (editNote, moveDoc, trashObject, copyObject -> 403)', async () => {
    const { app, b, deskId } = await aufbauMitPrivaterEbene('Bearbeiter');
    for (const cmd of [
      { type: 'editNote', payload: { id: 'n-privat', text: 'manipuliert' } },
      { type: 'moveDoc', payload: { id: 'doc-privat', position: { x: 9, y: 9 } } },
      { type: 'trashObject', payload: { id: 'n-privat', trashedAt: new Date().toISOString() } },
      { type: 'copyObject', payload: { id: 'doc-privat' } },
    ]) {
      const res = await app.inject({
        method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers: b.authHeaders, payload: cmd,
      });
      expect(res.statusCode, `${cmd.type} auf fremdem Privatobjekt`).toBe(403);
    }
  });

  it('Bearbeiter kann eine fremde Privatkarte nicht annotieren (addMark/addCutout -> 403)', async () => {
    const { app, b, deskId } = await aufbauMitPrivaterEbene('Bearbeiter');
    const mark = await app.inject({
      method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers: b.authHeaders,
      payload: { type: 'addMark', payload: { mark: { id: 'm1', docId: 'doc-privat', page: 1, rect: { x: 0, y: 0, w: 1, h: 1 }, kind: 'redact' } } },
    });
    expect(mark.statusCode).toBe(403);
    const cutout = await app.inject({
      method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers: b.authHeaders,
      payload: { type: 'addCutout', payload: { docId: 'doc-privat', page: 1, rect: { x: 0, y: 0, w: 1, h: 1 }, position: { x: 0, y: 0 } } },
    });
    expect(cutout.statusCode).toBe(403);
  });

  it('Mutationen auf öffentlichen Objekten durch Bearbeiter bleiben erlaubt (200)', async () => {
    const { app, b, deskId } = await aufbauMitPrivaterEbene('Bearbeiter');
    const res = await app.inject({
      method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers: b.authHeaders,
      payload: { type: 'moveDoc', payload: { id: 'doc-offen', position: { x: 5, y: 5 } } },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('02-09: changeLayerId auf den Platzhalter "privat" materialisiert die eigene Privat-Instanz (PERM-01/PERM-05)', () => {
  /** Desk von A, B als `rolleB`; A legt eine Notiz an. */
  async function aufbauMitNotiz(rolleB: string) {
    const { app, db, a, b } = await createTestAppMitZweiNutzern();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte A' } })
    ).json();
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(desk.id, b.userId, rolleB);
    const notiz = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: a.authHeaders,
      payload: { type: 'addNote', payload: { id: 'n-privat-neu', kind: 'notiz', text: 'interne Notiz von A', position: { x: 0, y: 0 } } },
    });
    expect(notiz.statusCode).toBe(200);
    return { app, db, a, b, deskId: desk.id as string };
  }

  it('Eigentümer: 200 statt 403, Objekt trägt die Instanz-id, genau eine eigene Instanz in state.layers — und keine Dublette beim zweiten Mal', async () => {
    const { app, db, a, deskId } = await aufbauMitNotiz('Bearbeiter');
    const instanzId = `privat-${a.userId}`;

    const umhangen = await app.inject({
      method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers: a.authHeaders,
      payload: { type: 'changeLayerId', payload: { objectId: 'n-privat-neu', layerId: 'privat' } },
    });
    expect(umhangen.statusCode).toBe(200);

    const state = getDeskState(db, deskId)!.state;
    expect(state.notes!.find((n) => n.id === 'n-privat-neu')!.layerId).toBe(instanzId);
    const eigene = (state.layers ?? []).filter((e) => e.typ === 'privat' && e.ownerUserId === a.userId);
    expect(eigene).toHaveLength(1);
    expect(eigene[0].id).toBe(instanzId);
    expect(eigene[0].name).toBe('Privat');

    // Idempotenz: ein zweites Objekt auf 'privat' erzeugt KEINE zweite Instanz.
    const notiz2 = await app.inject({
      method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers: a.authHeaders,
      payload: { type: 'addNote', payload: { id: 'n-privat-zwei', kind: 'notiz', text: 'zweite interne Notiz', position: { x: 1, y: 1 } } },
    });
    expect(notiz2.statusCode).toBe(200);
    const zweites = await app.inject({
      method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers: a.authHeaders,
      payload: { type: 'changeLayerId', payload: { objectId: 'n-privat-zwei', layerId: 'privat' } },
    });
    expect(zweites.statusCode).toBe(200);
    const stateNach = getDeskState(db, deskId)!.state;
    expect((stateNach.layers ?? []).filter((e) => e.typ === 'privat' && e.ownerUserId === a.userId)).toHaveLength(1);
    expect(stateNach.notes!.find((n) => n.id === 'n-privat-zwei')!.layerId).toBe(instanzId);
  });

  it('Fremd-Isolation: B sieht weder das privat gestellte Objekt noch irgendeine Spur der fremden Instanz im Roh-JSON von GET /state', async () => {
    const { app, a, b, deskId } = await aufbauMitNotiz('Bearbeiter');
    const instanzId = `privat-${a.userId}`;
    const umhangen = await app.inject({
      method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers: a.authHeaders,
      payload: { type: 'changeLayerId', payload: { objectId: 'n-privat-neu', layerId: 'privat' } },
    });
    expect(umhangen.statusCode).toBe(200);

    const resB = await app.inject({ method: 'GET', url: `/api/v1/desks/${deskId}/state`, headers: b.authHeaders });
    expect(resB.statusCode).toBe(200);
    const roh = JSON.stringify(resB.json());
    expect(roh).not.toContain('interne Notiz von A');
    expect(roh).not.toContain(instanzId);
    // Keine Andeutung privater Ebenen anderer (CONTEXT): jede privat-Instanz in Bs Sicht gehoert B.
    const layersB = (resB.json() as { state: { layers?: { typ: string; ownerUserId?: string }[] } }).state.layers ?? [];
    for (const e of layersB) {
      if (e.typ === 'privat') expect(e.ownerUserId).toBe(b.userId);
    }

    // Positivkontrolle: A sieht Objekt und eigene Instanz weiterhin.
    const resA = await app.inject({ method: 'GET', url: `/api/v1/desks/${deskId}/state`, headers: a.authHeaders });
    const rohA = JSON.stringify(resA.json());
    expect(rohA).toContain('interne Notiz von A');
    expect(rohA).toContain(instanzId);
  });
});

describe('CR-05: PUT /state ist Eigentümer-only (kein State-Replace durch Bearbeiter)', () => {
  it('Bearbeiter bekommt 403 auf PUT /state — die Lösch-/Provenienz-/Ebenen-Hoheit bleibt gewahrt', async () => {
    const { app, db, a, b } = await createTestAppMitZweiNutzern();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte A' } })
    ).json();
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(desk.id, b.userId, 'Bearbeiter');

    const res = await app.inject({
      method: 'PUT', url: `/api/v1/desks/${desk.id}/state`, headers: b.authHeaders,
      payload: { docs: [], links: [], stacks: [] },
    });
    expect(res.statusCode).toBe(403);

    // Eigentümer darf weiterhin ersetzen; die Antwort ist für den Anfragenden projiziert.
    putDeskState(db, desk.id, {
      docs: [], links: [], stacks: [],
      layers: [{ id: 'privat-b', typ: 'privat', name: 'Privat', ownerUserId: b.userId }],
      notes: [{ id: 'n-b-privat', kind: 'notiz', text: 'geheim-b', position: { x: 0, y: 0 }, zIndex: 1, layerId: 'privat-b' }],
    });
    const ok = await app.inject({
      method: 'PUT', url: `/api/v1/desks/${desk.id}/state`, headers: a.authHeaders,
      payload: getDeskState(db, desk.id)!.state,
    });
    expect(ok.statusCode).toBe(200);
    expect(JSON.stringify(ok.json())).not.toContain('geheim-b');
  });
});

describe('WR-03: POST /files erfordert eine Schreibtisch-Mitgliedschaft (Standalone)', () => {
  const uploadBody = (boundary: string) => Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
    Buffer.from('%PDF-1.4\ninhalt'),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  it('Nutzer ohne jede Desk-Rolle bekommt 403; mit Mitgliedschaft 201', async () => {
    const { app, a, b } = await createTestAppMitZweiNutzern();
    const boundary = '----uploadtest';
    const headers = (auth: { authorization: string }) => ({ ...auth, 'content-type': `multipart/form-data; boundary=${boundary}` });

    // B hat keine Rolle an irgendeinem Desk — Upload wird abgelehnt.
    const verweigert = await app.inject({ method: 'POST', url: '/api/v1/files', headers: headers(b.authHeaders), payload: uploadBody(boundary) });
    expect(verweigert.statusCode).toBe(403);

    // A legt einen Desk an (Eigentümer-Rolle) — danach ist der Upload erlaubt.
    await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte A' } });
    const erlaubt = await app.inject({ method: 'POST', url: '/api/v1/files', headers: headers(a.authHeaders), payload: uploadBody(boundary) });
    expect(erlaubt.statusCode).toBe(201);
    expect(erlaubt.json().fileId).toBeTruthy();
  });
});

describe('WR-05: Kommentator-Eigentumsprüfung über createdById (stabile users.id)', () => {
  it('stempelt createdById auf neue Objekte; Namensgleichheit ohne id-Match reicht nicht (403), Alt-Fallback greift', async () => {
    const { app, db, a, b } = await createTestAppMitZweiNutzern();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte A' } })
    ).json();
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(desk.id, b.userId, 'Kommentator');

    // B legt eine eigene Notiz an — der Server stempelt createdById = b.userId.
    const add = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: b.authHeaders,
      payload: { type: 'addNote', payload: { id: 'n-b', kind: 'notiz', text: 'eigen', position: { x: 0, y: 0 } } },
    });
    expect(add.statusCode).toBe(200);
    const gestempelt = getDeskState(db, desk.id)!.state.notes!.find((n) => n.id === 'n-b')!;
    expect(gestempelt.createdBy).toBe('nutzer-b');
    expect(gestempelt.createdById).toBe(b.userId);

    // Eigene Notiz bearbeiten: createdById-Match -> 200.
    const eigene = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: b.authHeaders,
      payload: { type: 'editNote', payload: { id: 'n-b', text: 'angepasst' } },
    });
    expect(eigene.statusCode).toBe(200);

    // Bypass-Versuch (WR-05): Notiz mit dem USERNAME von B, aber der userId von A — vor dem
    // Fix glich der Namensvergleich sie fälschlich B zu (Konto-Lösch-/Neuvergabe-Szenario).
    const vorher = getDeskState(db, desk.id)!.state;
    putDeskState(db, desk.id, {
      ...vorher,
      notes: [
        ...(vorher.notes ?? []),
        { id: 'n-namensfake', kind: 'notiz', text: 'x', position: { x: 1, y: 1 }, zIndex: 98, createdBy: 'nutzer-b', createdById: a.userId },
        { id: 'n-alt', kind: 'notiz', text: 'x', position: { x: 2, y: 2 }, zIndex: 99, createdBy: 'nutzer-b' },
      ],
    });
    const fake = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: b.authHeaders,
      payload: { type: 'editNote', payload: { id: 'n-namensfake', text: 'manipuliert' } },
    });
    expect(fake.statusCode).toBe(403);

    // Alt-Objekt ohne createdById: der Namens-Fallback bleibt (Bestandsdaten bearbeitbar).
    const alt = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: b.authHeaders,
      payload: { type: 'editNote', payload: { id: 'n-alt', text: 'angepasst' } },
    });
    expect(alt.statusCode).toBe(200);
  });
});

describe('WR-06: Konflikt-409 räumt Akteur/Zeitpunkt verborgener Objekte nicht preis', () => {
  it('von/am werden gestrichen, wenn das konfligierende Objekt für den Anfragenden unsichtbar ist', async () => {
    const { app, db, a, b } = await createTestAppMitZweiNutzern();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte A' } })
    ).json();
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(desk.id, b.userId, 'Bearbeiter');
    putDeskState(db, desk.id, {
      docs: [], links: [], stacks: [],
      layers: [{ id: 'privat-a', typ: 'privat', name: 'Privat', ownerUserId: a.userId }],
      notes: [
        { id: 'n-privat', kind: 'notiz', text: 'geheim', position: { x: 0, y: 0 }, zIndex: 1, layerId: 'privat-a', updatedRev: 5, updatedBy: 'nutzer-a', updatedAt: '2026-07-01T00:00:00Z' },
        { id: 'n-offen', kind: 'notiz', text: 'offen', position: { x: 1, y: 1 }, zIndex: 2, updatedRev: 7, updatedBy: 'nutzer-a', updatedAt: '2026-07-01T00:00:00Z' },
      ],
    });

    // B provoziert einen Konflikt gegen das (für ihn unsichtbare) Privatobjekt mit geratener ID.
    const unsichtbar = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: b.authHeaders,
      payload: { type: 'addNote', payload: { id: 'n-neu', kind: 'notiz', text: 'x', position: { x: 0, y: 0 } }, erwartet: { 'n-privat': 1 } },
    });
    expect(unsichtbar.statusCode).toBe(409);
    const konfliktUnsichtbar = unsichtbar.json().konflikt;
    expect(konfliktUnsichtbar.objektId).toBe('n-privat');
    expect(konfliktUnsichtbar.von).toBeNull();
    expect(konfliktUnsichtbar.am).toBeNull();
    expect(JSON.stringify(konfliktUnsichtbar)).not.toContain('nutzer-a');

    // Positivkontrolle: bei einem SICHTBAREN Objekt bleibt der Akteur im Konflikt erhalten.
    const sichtbar = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: b.authHeaders,
      payload: { type: 'addNote', payload: { id: 'n-neu2', kind: 'notiz', text: 'x', position: { x: 0, y: 0 } }, erwartet: { 'n-offen': 1 } },
    });
    expect(sichtbar.statusCode).toBe(409);
    expect(sichtbar.json().konflikt.von).toBe('nutzer-a');
  });
});

describe('Task 3: Mitglieder-Routen für Rollenvergabe (minimal, bekannte Nutzer)', () => {
  it('GET /members (als Eigentümer) liefert die Mitgliederliste mit Name + Rolle', async () => {
    const { app, db, a, b } = await createTestAppMitZweiNutzern();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte A' } })
    ).json();
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(desk.id, b.userId, 'Bearbeiter');

    const res = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/members`, headers: a.authHeaders });
    expect(res.statusCode).toBe(200);
    const mitglieder = res.json() as { userId: string; username: string; rolle: string }[];
    expect(mitglieder).toContainEqual({ userId: a.userId, username: 'nutzer-a', rolle: 'Eigentümer' });
    expect(mitglieder).toContainEqual({ userId: b.userId, username: 'nutzer-b', rolle: 'Bearbeiter' });
  });

  it('POST /members weist einem existierenden Nutzer eine Rolle zu; unbekannter Nutzer -> 404; unbekannte Rolle -> 400', async () => {
    const { app, a } = await createTestAppMitZweiNutzern();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte A' } })
    ).json();

    const ok = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/members`, headers: a.authHeaders,
      payload: { username: 'nutzer-b', rolle: 'Bearbeiter' },
    });
    expect(ok.statusCode).toBe(201);

    const unbekannt = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/members`, headers: a.authHeaders,
      payload: { username: 'gibtsnicht', rolle: 'Bearbeiter' },
    });
    expect(unbekannt.statusCode).toBe(404);

    const ungueltig = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/members`, headers: a.authHeaders,
      payload: { username: 'nutzer-b', rolle: 'Superadmin' },
    });
    expect(ungueltig.statusCode).toBe(400);
  });

  it('PUT ändert die Rolle, DELETE entfernt die Zeile', async () => {
    const { app, db, a, b } = await createTestAppMitZweiNutzern();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte A' } })
    ).json();
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(desk.id, b.userId, 'Kommentator');

    const put = await app.inject({
      method: 'PUT', url: `/api/v1/desks/${desk.id}/members/${b.userId}`, headers: a.authHeaders,
      payload: { rolle: 'Bearbeiter' },
    });
    expect(put.statusCode).toBe(200);
    expect(db.prepare('SELECT rolle FROM desk_roles WHERE desk_id = ? AND user_id = ?').get(desk.id, b.userId))
      .toEqual({ rolle: 'Bearbeiter' });

    const del = await app.inject({
      method: 'DELETE', url: `/api/v1/desks/${desk.id}/members/${b.userId}`, headers: a.authHeaders,
    });
    expect(del.statusCode).toBe(200);
    expect(db.prepare('SELECT rolle FROM desk_roles WHERE desk_id = ? AND user_id = ?').get(desk.id, b.userId))
      .toBeUndefined();
  });

  it('alle Mitglieder-Routen sind nur fuer den Eigentuemer erlaubt; der Eigentuemer kann sich nicht selbst herabstufen/entfernen', async () => {
    const { app, db, a, b } = await createTestAppMitZweiNutzern();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte A' } })
    ).json();
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(desk.id, b.userId, 'Bearbeiter');

    const listeB = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/members`, headers: b.authHeaders });
    expect(listeB.statusCode).toBe(403);

    const postB = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/members`, headers: b.authHeaders,
      payload: { username: 'nutzer-a', rolle: 'Nur-Lesen' },
    });
    expect(postB.statusCode).toBe(403);

    const putSelbst = await app.inject({
      method: 'PUT', url: `/api/v1/desks/${desk.id}/members/${a.userId}`, headers: a.authHeaders,
      payload: { rolle: 'Bearbeiter' },
    });
    expect(putSelbst.statusCode).toBe(400);

    const delSelbst = await app.inject({
      method: 'DELETE', url: `/api/v1/desks/${desk.id}/members/${a.userId}`, headers: a.authHeaders,
    });
    expect(delSelbst.statusCode).toBe(400);
  });
});

describe('02-09: Kommentator-Ebenenpaar-Regel — eigene Notizen/Fähnchen zwischen kanzlei und eigener Privat-Instanz (CONTEXT-Locked-Decision)', () => {
  /** Desk von A; B ist Kommentator. A legt eine fremde Notiz + ein Doc an; B eine eigene Notiz und ein eigenes Fähnchen. */
  async function aufbauKommentator() {
    const { app, db, dataDir, a, b } = await createTestAppMitZweiNutzern();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte A' } })
    ).json();
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(desk.id, b.userId, 'Kommentator');

    const fremdeNotiz = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: a.authHeaders,
      payload: { type: 'addNote', payload: { id: 'n-fremd', kind: 'notiz', text: 'Notiz von A', position: { x: 0, y: 0 } } },
    });
    expect(fremdeNotiz.statusCode).toBe(200);

    const meta = storeFile(db, dataDir, Buffer.from('%PDF-1.4\ninhalt'), 'a.pdf');
    const doc = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: a.authHeaders,
      payload: { type: 'addDoc', payload: { fileId: meta.id, name: 'a.pdf', position: { x: 1, y: 1 }, id: 'doc-a' } },
    });
    expect(doc.statusCode).toBe(200);

    const eigeneNotiz = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: b.authHeaders,
      payload: { type: 'addNote', payload: { id: 'n-eigen', kind: 'notiz', text: 'Kommentar von B', position: { x: 2, y: 2 } } },
    });
    expect(eigeneNotiz.statusCode).toBe(200);

    const eigenesFaehnchen = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: b.authHeaders,
      payload: { type: 'addFlag', payload: { flag: { id: 'f-eigen', docId: 'doc-a', page: 1, offset: 0.5, color: '#f5c518' } } },
    });
    expect(eigenesFaehnchen.statusCode).toBe(200);

    return { app, db, a, b, deskId: desk.id as string };
  }

  function umhangen(app: import('fastify').FastifyInstance, headers: { authorization: string }, deskId: string, objectId: string, layerId: string) {
    return app.inject({
      method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers,
      payload: { type: 'changeLayerId', payload: { objectId, layerId } },
    });
  }

  it('eigene Notiz kanzlei -> "privat" (200, eigene Instanz entsteht) und zurueck -> "kanzlei" (200)', async () => {
    const { app, db, b, deskId } = await aufbauKommentator();
    const instanzId = `privat-${b.userId}`;

    const hin = await umhangen(app, b.authHeaders, deskId, 'n-eigen', 'privat');
    expect(hin.statusCode).toBe(200);
    const state = getDeskState(db, deskId)!.state;
    expect(state.notes!.find((n) => n.id === 'n-eigen')!.layerId).toBe(instanzId);
    expect((state.layers ?? []).filter((e) => e.typ === 'privat' && e.ownerUserId === b.userId)).toHaveLength(1);

    const zurueck = await umhangen(app, b.authHeaders, deskId, 'n-eigen', 'kanzlei');
    expect(zurueck.statusCode).toBe(200);
    expect(getDeskState(db, deskId)!.state.notes!.find((n) => n.id === 'n-eigen')!.layerId).toBe('kanzlei');
  });

  it('eigenes Faehnchen kanzlei -> "privat" (200)', async () => {
    const { app, db, b, deskId } = await aufbauKommentator();
    const hin = await umhangen(app, b.authHeaders, deskId, 'f-eigen', 'privat');
    expect(hin.statusCode).toBe(200);
    expect(getDeskState(db, deskId)!.state.flags!.find((f) => f.id === 'f-eigen')!.layerId).toBe(`privat-${b.userId}`);
  });

  it('fremde Notiz -> "privat" bleibt 403 (kein Eigentum)', async () => {
    const { app, db, b, deskId } = await aufbauKommentator();
    const res = await umhangen(app, b.authHeaders, deskId, 'n-fremd', 'privat');
    expect(res.statusCode).toBe(403);
    expect(getDeskState(db, deskId)!.state.notes!.find((n) => n.id === 'n-fremd')!.layerId).toBeUndefined();
  });

  it('eigene Notiz -> verwaltete Ebene (exportierbar / custom) bleibt 403', async () => {
    const { app, db, a, b, deskId } = await aufbauKommentator();
    const exportierbar = await umhangen(app, b.authHeaders, deskId, 'n-eigen', 'exportierbar');
    expect(exportierbar.statusCode).toBe(403);

    const customAnlegen = await app.inject({
      method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers: a.authHeaders,
      payload: { type: 'addCustomLayer', payload: { name: 'Notizen von Yvonne' } },
    });
    expect(customAnlegen.statusCode).toBe(200);
    const customId = getDeskState(db, deskId)!.state.layers!.find((e) => e.typ === 'custom')!.id;
    const custom = await umhangen(app, b.authHeaders, deskId, 'n-eigen', customId);
    expect(custom.statusCode).toBe(403);
    expect(getDeskState(db, deskId)!.state.notes!.find((n) => n.id === 'n-eigen')!.layerId).toBeUndefined();
  });

  it('eigene Notiz -> fremde Privat-Instanz-id bleibt 403 (geratene Instanz-id)', async () => {
    const { app, a, b, deskId } = await aufbauKommentator();
    // A materialisiert seine eigene Instanz ueber den echten Produktpfad.
    const aPrivat = await umhangen(app, a.authHeaders, deskId, 'n-fremd', 'privat');
    expect(aPrivat.statusCode).toBe(200);
    const res = await umhangen(app, b.authHeaders, deskId, 'n-eigen', `privat-${a.userId}`);
    expect(res.statusCode).toBe(403);
  });

  it('ein Doc (art != notes/flags) ist fuer den Kommentator nicht ebenenverschiebbar (403)', async () => {
    const { app, db, b, deskId } = await aufbauKommentator();
    const res = await umhangen(app, b.authHeaders, deskId, 'doc-a', 'privat');
    expect(res.statusCode).toBe(403);
    expect(getDeskState(db, deskId)!.state.docs.find((d) => d.id === 'doc-a')!.layerId).toBeUndefined();
  });

  it('Nur-Lesen -> "privat" bleibt 403', async () => {
    const { app, db, a, b } = await createTestAppMitZweiNutzern();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte A' } })
    ).json();
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(desk.id, b.userId, 'Nur-Lesen');
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: a.authHeaders,
      payload: { type: 'addNote', payload: { id: 'n-1', kind: 'notiz', text: 'Notiz', position: { x: 0, y: 0 } } },
    });
    const res = await umhangen(app, b.authHeaders, desk.id, 'n-1', 'privat');
    expect(res.statusCode).toBe(403);
  });
});

describe('02-REVIEW WR-01: setLayerExportierbar — Eigentums-Guard auf Privat-Instanzen (PERM-05)', () => {
  /** Desk von A; B bekommt `rolleB`; beide Privat-Instanzen liegen materialisiert im State. */
  async function aufbauMitInstanzen(rolleB: string) {
    const { app, db, a, b } = await createTestAppMitZweiNutzern();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte A' } })
    ).json();
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(desk.id, b.userId, rolleB);
    putDeskState(db, desk.id, {
      docs: [], links: [], stacks: [],
      layers: [
        { id: `privat-${a.userId}`, typ: 'privat', name: 'Privat', ownerUserId: a.userId },
        { id: `privat-${b.userId}`, typ: 'privat', name: 'Privat', ownerUserId: b.userId },
      ],
    });
    return { app, db, a, b, deskId: desk.id as string };
  }

  function setzeExportierbar(
    app: import('fastify').FastifyInstance, headers: { authorization: string },
    deskId: string, layerId: string, exportierbar: boolean,
  ) {
    return app.inject({
      method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers,
      payload: { type: 'setLayerExportierbar', payload: { layerId, exportierbar } },
    });
  }

  it('Bearbeiter kann das exportierbar-Flag einer FREMDEN Privat-Instanz nicht flippen (403, Flag bleibt unveraendert)', async () => {
    const { app, db, a, b, deskId } = await aufbauMitInstanzen('Bearbeiter');
    const res = await setzeExportierbar(app, b.authHeaders, deskId, `privat-${a.userId}`, true);
    expect(res.statusCode).toBe(403);
    const ebene = getDeskState(db, deskId)!.state.layers!.find((e) => e.id === `privat-${a.userId}`)!;
    expect(ebene.exportierbar ?? false).toBe(false);
  });

  it('auch der Desk-Eigentuemer kann das Flag einer fremden Privat-Instanz nicht flippen (403 — PERM-05 "fremde private Ebene unantastbar")', async () => {
    const { app, db, a, b, deskId } = await aufbauMitInstanzen('Bearbeiter');
    const res = await setzeExportierbar(app, a.authHeaders, deskId, `privat-${b.userId}`, true);
    expect(res.statusCode).toBe(403);
    const ebene = getDeskState(db, deskId)!.state.layers!.find((e) => e.id === `privat-${b.userId}`)!;
    expect(ebene.exportierbar ?? false).toBe(false);
  });

  it('die eigene Privat-Instanz bleibt fuer ihren Eigentuemer aenderbar (200)', async () => {
    const { app, db, b, deskId } = await aufbauMitInstanzen('Bearbeiter');
    const res = await setzeExportierbar(app, b.authHeaders, deskId, `privat-${b.userId}`, true);
    expect(res.statusCode).toBe(200);
    const ebene = getDeskState(db, deskId)!.state.layers!.find((e) => e.id === `privat-${b.userId}`)!;
    expect(ebene.exportierbar).toBe(true);
  });

  it('Platzhalter "privat" loest auf die EIGENE Instanz auf (200, lazy materialisiert) — niemals auf die SYSTEM-Platzhalter-Ebene oder eine fremde Instanz', async () => {
    const { app, db, a, b } = await createTestAppMitZweiNutzern();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte A' } })
    ).json();
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(desk.id, b.userId, 'Bearbeiter');
    putDeskState(db, desk.id, {
      docs: [], links: [], stacks: [],
      layers: [{ id: `privat-${a.userId}`, typ: 'privat', name: 'Privat', ownerUserId: a.userId }],
    });

    const res = await setzeExportierbar(app, b.authHeaders, desk.id, 'privat', true);
    expect(res.statusCode).toBe(200);
    const state = getDeskState(db, desk.id)!.state;
    const eigene = state.layers!.find((e) => e.id === `privat-${b.userId}`)!;
    expect(eigene.exportierbar).toBe(true);
    // A-Instanz unberuehrt; genau eine Instanz pro Nutzer.
    const fremde = state.layers!.find((e) => e.id === `privat-${a.userId}`)!;
    expect(fremde.exportierbar ?? false).toBe(false);
    expect(state.layers!.filter((e) => e.typ === 'privat')).toHaveLength(2);
  });

  it('Kommentator scheitert weiterhin an der manage-Matrix (403) — auch auf der eigenen Instanz', async () => {
    const { app, b, deskId } = await aufbauMitInstanzen('Kommentator');
    const res = await setzeExportierbar(app, b.authHeaders, deskId, `privat-${b.userId}`, true);
    expect(res.statusCode).toBe(403);
  });

  it('custom-Ebenen bleiben fuer Bearbeiter aenderbar (200) — der Guard engt nur den Privatbereich ein', async () => {
    const { app, db, a, b, deskId } = await aufbauMitInstanzen('Bearbeiter');
    const angelegt = await app.inject({
      method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers: a.authHeaders,
      payload: { type: 'addCustomLayer', payload: { name: 'Notizen' } },
    });
    expect(angelegt.statusCode).toBe(200);
    const customId = getDeskState(db, deskId)!.state.layers!.find((e) => e.typ === 'custom')!.id;
    const res = await setzeExportierbar(app, b.authHeaders, deskId, customId, true);
    expect(res.statusCode).toBe(200);
    expect(getDeskState(db, deskId)!.state.layers!.find((e) => e.id === customId)!.exportierbar).toBe(true);
  });
});

describe('13-02: Zonen-Kommandos — Rollenmatrix über den pruefeKommandoRecht-Fallthrough (A2, ohne Matrix-Änderung)', () => {
  /** Desk von A; B bekommt `rolleB`. */
  async function aufbau(rolleB: string) {
    const { app, db, a, b } = await createTestAppMitZweiNutzern();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte A' } })
    ).json();
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(desk.id, b.userId, rolleB);
    return { app, db, a, b, deskId: desk.id as string };
  }

  const ZONE = { id: 'z1', name: 'Beweiswürdigung', rect: { x: 0, y: 0, w: 100, h: 100 } };

  it('addZone als Eigentümer liefert 200 (Zone liegt im projizierten State)', async () => {
    const { app, a, deskId } = await aufbau('Bearbeiter');
    const res = await app.inject({
      method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers: a.authHeaders,
      payload: { type: 'addZone', payload: ZONE },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json().state.zones as { id: string }[]).map((z) => z.id)).toContain('z1');
  });

  it('addZone als Bearbeiter liefert 200', async () => {
    const { app, b, deskId } = await aufbau('Bearbeiter');
    const res = await app.inject({
      method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers: b.authHeaders,
      payload: { type: 'addZone', payload: ZONE },
    });
    expect(res.statusCode).toBe(200);
  });

  it('addZone als Kommentator liefert 403 mit der Fallthrough-Rollenmeldung', async () => {
    const { app, b, deskId } = await aufbau('Kommentator');
    const res = await app.inject({
      method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers: b.authHeaders,
      payload: { type: 'addZone', payload: ZONE },
    });
    expect(res.statusCode).toBe(403);
    // Die Meldung kommt aus dem bestehenden KOMMENTATOR_ERLAUBT-Fallthrough — es wurde
    // bewusst KEINE neue Zeile in LOESCH_COMMANDS/KOMMENTATOR_ERLAUBT ergänzt (A2).
    expect(res.json().error).toContain('Kommentator');
    expect(res.json().error).toContain('addZone');
  });

  it('addZone als Nur-Lesen liefert 403', async () => {
    const { app, b, deskId } = await aufbau('Nur-Lesen');
    const res = await app.inject({
      method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers: b.authHeaders,
      payload: { type: 'addZone', payload: ZONE },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain('Nur-Lesen');
  });

  it('renameZone/removeZone als Bearbeiter liefern 200 (Zone umbenannt, dann entfernt)', async () => {
    const { app, db, a, b, deskId } = await aufbau('Bearbeiter');
    const anlage = await app.inject({
      method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers: a.authHeaders,
      payload: { type: 'addZone', payload: ZONE },
    });
    expect(anlage.statusCode).toBe(200);

    const umbenennen = await app.inject({
      method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers: b.authHeaders,
      payload: { type: 'renameZone', payload: { id: 'z1', name: 'Umbenannt' } },
    });
    expect(umbenennen.statusCode).toBe(200);
    expect(getDeskState(db, deskId)!.state.zones![0]!.name).toBe('Umbenannt');

    const entfernen = await app.inject({
      method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers: b.authHeaders,
      payload: { type: 'removeZone', payload: { id: 'z1' } },
    });
    expect(entfernen.statusCode).toBe(200);
    expect(getDeskState(db, deskId)!.state.zones ?? []).toEqual([]);
  });

  it('renameZone/removeZone als Kommentator liefern 403 (Zone bleibt unverändert)', async () => {
    const { app, db, a, b, deskId } = await aufbau('Kommentator');
    const anlage = await app.inject({
      method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers: a.authHeaders,
      payload: { type: 'addZone', payload: ZONE },
    });
    expect(anlage.statusCode).toBe(200);

    const umbenennen = await app.inject({
      method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers: b.authHeaders,
      payload: { type: 'renameZone', payload: { id: 'z1', name: 'Manipuliert' } },
    });
    expect(umbenennen.statusCode).toBe(403);

    const entfernen = await app.inject({
      method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers: b.authHeaders,
      payload: { type: 'removeZone', payload: { id: 'z1' } },
    });
    expect(entfernen.statusCode).toBe(403);

    // Kein State-Wechsel durch die verweigerten Kommandos.
    const zone = getDeskState(db, deskId)!.state.zones![0]!;
    expect(zone.name).toBe('Beweiswürdigung');
  });
});

describe('03-01: setFreigabe-Guard (Server-Feldhoheit, EXP-03/D-05)', () => {  async function deskMitNotizVonA() {
    const ctx = await createTestAppMitZweiNutzern();
    const { app, a } = ctx;
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte A' } })
    ).json() as { id: string };
    const notiz = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: a.authHeaders,
      payload: { type: 'addNote', payload: { id: 'n-a', kind: 'notiz', text: 'von a', position: { x: 0, y: 0 } } },
    });
    expect(notiz.statusCode).toBe(200);
    return { ...ctx, deskId: desk.id };
  }

  it('Kommentator: fremdes Objekt ⇒ 403, eigenes Objekt (createdById = er) ⇒ 200', async () => {
    const { app, db, b, deskId } = await deskMitNotizVonA();
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(deskId, b.userId, 'Kommentator');
    const eigene = await app.inject({
      method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers: b.authHeaders,
      payload: { type: 'addNote', payload: { id: 'n-b', kind: 'notiz', text: 'von b', position: { x: 1, y: 1 } } },
    });
    expect(eigene.statusCode).toBe(200);

    const fremd = await app.inject({
      method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers: b.authHeaders,
      payload: { type: 'setFreigabe', payload: { objectId: 'n-a', freigabe: 'export' } },
    });
    expect(fremd.statusCode).toBe(403);

    const eigen = await app.inject({
      method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers: b.authHeaders,
      payload: { type: 'setFreigabe', payload: { objectId: 'n-b', freigabe: 'export' } },
    });
    expect(eigen.statusCode).toBe(200);
  });

  it('Objekt auf fremder Privat-Ebene ⇒ 403 für jeden Nicht-Eigentümer (hier: Bearbeiter)', async () => {
    const { app, db, a, b, deskId } = await deskMitNotizVonA();
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(deskId, b.userId, 'Bearbeiter');
    // A hängt die Notiz auf die eigene Privat-Instanz (lazy Materialisierung, 02-09).
    const privat = await app.inject({
      method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers: a.authHeaders,
      payload: { type: 'changeLayerId', payload: { objectId: 'n-a', layerId: 'privat' } },
    });
    expect(privat.statusCode).toBe(200);

    const res = await app.inject({
      method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers: b.authHeaders,
      payload: { type: 'setFreigabe', payload: { objectId: 'n-a', freigabe: 'export' } },
    });
    expect(res.statusCode).toBe(403);
  });

  it('Nur-Lesen ⇒ 403', async () => {
    const { app, db, b, deskId } = await deskMitNotizVonA();
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(deskId, b.userId, 'Nur-Lesen');
    const res = await app.inject({
      method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers: b.authHeaders,
      payload: { type: 'setFreigabe', payload: { objectId: 'n-a', freigabe: 'export' } },
    });
    expect(res.statusCode).toBe(403);
  });

  it('Eigentümer darf setFreigabe an jedem Objekt (200, Wirkung im State)', async () => {
    const { app, a, deskId } = await deskMitNotizVonA();
    const res = await app.inject({
      method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers: a.authHeaders,
      payload: { type: 'setFreigabe', payload: { objectId: 'n-a', freigabe: 'mandant' } },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json().state.notes as { freigabe?: string }[])[0]?.freigabe).toBe('mandant');
  });
});
