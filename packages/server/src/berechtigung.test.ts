import { describe, it, expect } from 'vitest';
import { findeObjekt, projectStateForActor, type ActorContext, type Rolle } from '@j-desk/core';
import { openDb, type Db } from './db';
import { createUser } from './auth';
import { createDesk, getDeskState, putDeskState } from './deskStore';
import { pruefeBerechtigung } from './berechtigung';
import { createTestAppMitZweiNutzern } from './testUtils';

/**
 * Admin-Berechtigungsdiagnose (OPS-03, 14-05). Task 1 deckt die Kernfunktion `pruefeBerechtigung`
 * über direkte Fixtures ab (Analog: app.projection.test.ts — putDeskState als Fixture-Kürzel für
 * bereits auf Ebenen verteilte Objekte). Task 2 ergänzt darunter die Routenebene.
 */

async function baueFixture(): Promise<{ db: Db; deskId: string; eigentuemerId: string; bearbeiterId: string; gastId: string }> {
  const db = openDb(':memory:');
  const eigentuemerId = await createUser(db, 'frau-meier-eigentuemerin', 'test-passwort');
  const bearbeiterId = await createUser(db, 'herr-schmidt-bearbeiter', 'test-passwort');
  const gastId = await createUser(db, 'externer-gast', 'test-passwort');
  const desk = createDesk(db, eigentuemerId, 'Akte A', { id: eigentuemerId, name: 'Frau Meier' });
  db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(desk.id, bearbeiterId, 'Bearbeiter' satisfies Rolle);
  db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(desk.id, gastId, 'externer Gast' satisfies Rolle);
  return { db, deskId: desk.id, eigentuemerId, bearbeiterId, gastId };
}

/** Fixture-Kürzel wie app.projection.test.ts: direkte State-Manipulation statt Command-Weg —
 *  hier steht die Begründungslogik im Fokus, nicht die Anlage der Objekte. */
function setzeState(db: Db, deskId: string, patch: Record<string, unknown>): void {
  const vorher = getDeskState(db, deskId)!.state;
  putDeskState(db, deskId, { ...vorher, ...patch });
}

describe('Task 1: pruefeBerechtigung() — Entscheidung am echten Auslieferungspfad', () => {
  it('Sichtbarer Fall: Objekt auf allgemein zugänglicher Ebene ist für einen Bearbeiter sichtbar, mit mindestens einem Grund', async () => {
    const { db, deskId, eigentuemerId, bearbeiterId } = await baueFixture();
    setzeState(db, deskId, {
      docs: [{ id: 'doc-oeffentlich', fileId: 'f1', name: 'Klageschrift.pdf', position: { x: 0, y: 0 } }],
    });

    const befund = pruefeBerechtigung(db, deskId, eigentuemerId, bearbeiterId, 'doc-oeffentlich');
    expect(befund.gefunden).toBe(true);
    if (!befund.gefunden) return;
    expect(befund.sichtbar).toBe(true);
    expect(befund.gruende.length).toBeGreaterThanOrEqual(1);
  });

  it('Ebenen-Ausschluss: Objekt auf der privaten Ebene des Eigentümers ist für einen Bearbeiter nicht sichtbar, Grund nennt die Ebene', async () => {
    const { db, deskId, eigentuemerId, bearbeiterId } = await baueFixture();
    setzeState(db, deskId, {
      layers: [{ id: `privat-${eigentuemerId}`, typ: 'privat', name: 'Privat', ownerUserId: eigentuemerId }],
      docs: [{ id: 'doc-privat', fileId: 'f2', name: 'Interner Vermerk.pdf', position: { x: 0, y: 0 }, layerId: `privat-${eigentuemerId}` }],
    });

    const befund = pruefeBerechtigung(db, deskId, eigentuemerId, bearbeiterId, 'doc-privat');
    expect(befund.gefunden).toBe(true);
    if (!befund.gefunden) return;
    expect(befund.sichtbar).toBe(false);
    expect(befund.gruende).toHaveLength(1);
    expect(befund.gruende[0].art).toBe('ebene-privat-fremd');
  });

  it('Rollen-Ausschluss: als intern geltendes Objekt auf allgemein zugänglicher Ebene ist für einen externen Gast nicht sichtbar, Grund nennt die Rolle', async () => {
    const { db, deskId, eigentuemerId, gastId } = await baueFixture();
    setzeState(db, deskId, {
      docs: [{ id: 'doc-intern', fileId: 'f3', name: 'Klageschrift.pdf', position: { x: 0, y: 0 } }],
    });

    const befund = pruefeBerechtigung(db, deskId, eigentuemerId, gastId, 'doc-intern');
    expect(befund.gefunden).toBe(true);
    if (!befund.gefunden) return;
    expect(befund.sichtbar).toBe(false);
    expect(befund.gruende).toHaveLength(1);
    expect(befund.gruende[0].art).toBe('rolle-gast-intern');
  });

  it('Beide Achsen gleichzeitig: Objekt auf fremder privater Ebene, geprüft für einen externen Gast, liefert ZWEI Gründe', async () => {
    const { db, deskId, eigentuemerId, gastId } = await baueFixture();
    setzeState(db, deskId, {
      layers: [{ id: `privat-${eigentuemerId}`, typ: 'privat', name: 'Privat', ownerUserId: eigentuemerId }],
      docs: [{ id: 'doc-privat-gast', fileId: 'f4', name: 'Klageschrift.pdf', position: { x: 0, y: 0 }, layerId: `privat-${eigentuemerId}` }],
    });

    const befund = pruefeBerechtigung(db, deskId, eigentuemerId, gastId, 'doc-privat-gast');
    expect(befund.gefunden).toBe(true);
    if (!befund.gefunden) return;
    expect(befund.sichtbar).toBe(false);
    // Die Anzahlprüfung ist die Zusicherung, die eine vorzeitige Rückgabe ausschließt: fehlte
    // sie, könnte eine Rollenkorrektur (Gast -> Bearbeiter) fälschlich als ausreichende Abhilfe
    // erscheinen, obwohl die private Ebene weiter blockiert.
    expect(befund.gruende).toHaveLength(2);
    expect(befund.gruende.map((g) => g.art).sort()).toEqual(['ebene-privat-fremd', 'rolle-gast-intern']);
  });

  it('Übereinstimmung mit der Auslieferung: die gemeldete Sichtbarkeit stimmt für alle vier Fälle mit projectStateForActor() überein', async () => {
    const { db, deskId, eigentuemerId, bearbeiterId, gastId } = await baueFixture();
    setzeState(db, deskId, {
      layers: [{ id: `privat-${eigentuemerId}`, typ: 'privat', name: 'Privat', ownerUserId: eigentuemerId }],
      docs: [
        { id: 'd-oeffentlich', fileId: 'f1', name: 'A.pdf', position: { x: 0, y: 0 } },
        { id: 'd-privat', fileId: 'f2', name: 'B.pdf', position: { x: 0, y: 0 }, layerId: `privat-${eigentuemerId}` },
      ],
    });
    const state = getDeskState(db, deskId)!.state;

    const faelle: { geprueftUserId: string; rolle: Rolle; objektId: string }[] = [
      { geprueftUserId: bearbeiterId, rolle: 'Bearbeiter', objektId: 'd-oeffentlich' },
      { geprueftUserId: bearbeiterId, rolle: 'Bearbeiter', objektId: 'd-privat' },
      { geprueftUserId: gastId, rolle: 'externer Gast', objektId: 'd-oeffentlich' },
      { geprueftUserId: gastId, rolle: 'externer Gast', objektId: 'd-privat' },
    ];

    for (const fall of faelle) {
      const befund = pruefeBerechtigung(db, deskId, eigentuemerId, fall.geprueftUserId, fall.objektId);
      expect(befund.gefunden).toBe(true);
      if (!befund.gefunden) continue;
      const ctx: ActorContext = { userId: fall.geprueftUserId, rolle: fall.rolle };
      const projiziert = projectStateForActor(state, ctx);
      const tatsaechlichSichtbar = findeObjekt(projiziert, fall.objektId) !== undefined;
      expect(befund.sichtbar).toBe(tatsaechlichSichtbar);
    }
  });

  it('Unbekanntes Objekt führt zu einem Nicht-gefunden-Ergebnis statt zu einer erfundenen Begründung', async () => {
    const { db, deskId, eigentuemerId, bearbeiterId } = await baueFixture();
    const befund = pruefeBerechtigung(db, deskId, eigentuemerId, bearbeiterId, 'gibtsnicht');
    expect(befund.gefunden).toBe(false);
  });

  it('Nutzer ohne Rolle auf diesem Schreibtisch führt zu einem Nicht-gefunden-Ergebnis', async () => {
    const { db, deskId, eigentuemerId } = await baueFixture();
    setzeState(db, deskId, {
      docs: [{ id: 'doc-x', fileId: 'f1', name: 'X.pdf', position: { x: 0, y: 0 } }],
    });
    const befund = pruefeBerechtigung(db, deskId, eigentuemerId, 'user-ohne-rolle', 'doc-x');
    expect(befund.gefunden).toBe(false);
  });

  it('Ein für den fragenden Eigentümer selbst unsichtbares Objekt liefert Nicht-gefunden statt einer Begründung (Informationssparsamkeit)', async () => {
    // Zweiter Eigentümer mit eigenem privaten Objekt — der FRAGENDE aus baueFixture() darf es
    // nicht kennen. Direkte zweite App/DB wäre hier unnötig: derselbe db-Handle, zweiter Desk.
    const { db, deskId, eigentuemerId, bearbeiterId } = await baueFixture();
    const fremdeEigentuemerinId = bearbeiterId; // Rollenname hier irrelevant, dient nur als zweite Identität
    setzeState(db, deskId, {
      layers: [{ id: `privat-${fremdeEigentuemerinId}`, typ: 'privat', name: 'Privat', ownerUserId: fremdeEigentuemerinId }],
      docs: [{ id: 'doc-fremd-privat', fileId: 'f5', name: 'Geheim.pdf', position: { x: 0, y: 0 }, layerId: `privat-${fremdeEigentuemerinId}` }],
    });

    const befund = pruefeBerechtigung(db, deskId, eigentuemerId, fremdeEigentuemerinId, 'doc-fremd-privat');
    expect(befund.gefunden).toBe(false);
  });
});

describe('Task 2: Route GET /desks/:id/berechtigung', () => {
  it('Der Eigentümer bekommt für eine gültige Kombination Statuscode 200 und die Ergebnisform', async () => {
    const { app, db, a, b } = await createTestAppMitZweiNutzern();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte A' } })
    ).json();
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(desk.id, b.userId, 'Bearbeiter');
    const vorher = getDeskState(db, desk.id)!.state;
    putDeskState(db, desk.id, { ...vorher, docs: [{ id: 'doc-1', fileId: 'f1', name: 'Klageschrift.pdf', position: { x: 0, y: 0 } }] });

    const res = await app.inject({
      method: 'GET', url: `/api/v1/desks/${desk.id}/berechtigung?userId=${b.userId}&objektId=doc-1`, headers: a.authHeaders,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.gefunden).toBe(true);
    expect(body.sichtbar).toBe(true);
    expect(Array.isArray(body.gruende)).toBe(true);
  });

  it('Ein Nutzer in einer anderen Rolle bekommt 403; ein unbekannter Schreibtisch 404', async () => {
    const { app, db, a, b } = await createTestAppMitZweiNutzern();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte A' } })
    ).json();
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(desk.id, b.userId, 'Bearbeiter');

    const res403 = await app.inject({
      method: 'GET', url: `/api/v1/desks/${desk.id}/berechtigung?userId=${a.userId}&objektId=doc-1`, headers: b.authHeaders,
    });
    expect(res403.statusCode).toBe(403);

    const res404 = await app.inject({
      method: 'GET', url: `/api/v1/desks/gibtsnicht/berechtigung?userId=${b.userId}&objektId=doc-1`, headers: a.authHeaders,
    });
    expect(res404.statusCode).toBe(404);
  });

  it('Fehlende oder leere Nutzer- bzw. Objektkennung führen zu Statuscode 400 mit deutscher Meldung', async () => {
    const { app, a } = await createTestAppMitZweiNutzern();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte A' } })
    ).json();

    const ohneUserId = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/berechtigung?objektId=doc-1`, headers: a.authHeaders });
    expect(ohneUserId.statusCode).toBe(400);
    expect(ohneUserId.json().error).toMatch(/userId/);

    const ohneObjektId = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/berechtigung?userId=${a.userId}`, headers: a.authHeaders });
    expect(ohneObjektId.statusCode).toBe(400);
    expect(ohneObjektId.json().error).toMatch(/objektId/);

    const leererUserId = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/berechtigung?userId=&objektId=doc-1`, headers: a.authHeaders });
    expect(leererUserId.statusCode).toBe(400);
  });

  it('Eine Objektkennung, die der fragende Eigentümer selbst nicht sehen darf, liefert das Nicht-gefunden-Ergebnis und keine Begründung', async () => {
    const { app, db, a, b } = await createTestAppMitZweiNutzern();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte A' } })
    ).json();
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(desk.id, b.userId, 'Bearbeiter');
    const vorher = getDeskState(db, desk.id)!.state;
    putDeskState(db, desk.id, {
      ...vorher,
      layers: [{ id: `privat-${b.userId}`, typ: 'privat', name: 'Privat', ownerUserId: b.userId }],
      docs: [{ id: 'doc-fremd', fileId: 'f9', name: 'Geheim.pdf', position: { x: 0, y: 0 }, layerId: `privat-${b.userId}` }],
    });

    const res = await app.inject({
      method: 'GET', url: `/api/v1/desks/${desk.id}/berechtigung?userId=${b.userId}&objektId=doc-fremd`, headers: a.authHeaders,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().gruende).toBeUndefined();
  });
});
