import { describe, it, expect } from 'vitest';
import { openDb } from './db';
import { createUser } from './auth';
import { createDesk, applyDeskCommand, getDeskState } from './deskStore';
import type { ActorContext } from '@j-desk/core';
import { runLegalQuery, LEGAL_QUERIES, LEGAL_QUERY_MAX_TREFFER } from './legalQueries';
import { createTestApp, createTestAppMitZweiNutzern } from './testUtils';

/** Frischer In-Memory-Desk mit Eigentümer A — identisches Muster zu
 *  packages/server/src/search/searchSync.test.ts `neuerDesk()`. */
async function neuerDesk() {
  const db = openDb(':memory:');
  const userId = await createUser(db, 'nutzer-a', 'test-passwort');
  const desk = createDesk(db, userId, 'Akte A', { id: userId, name: 'A' });
  return { db, desk, userId };
}

const A: ActorContext = { userId: '', rolle: 'Eigentümer' }; // userId wird pro Test gesetzt

describe('runLegalQuery: facts-without-evidence', () => {
  it('liefert eine Tatsache ohne belegt-Verknüpfung', async () => {
    const { db, desk, userId } = await neuerDesk();
    applyDeskCommand(db, desk.id, { type: 'addLegalObject', payload: { id: 'ts1', kind: 'tatsache', text: 'Unbelegte Tatsache', position: { x: 0, y: 0 } } }, { id: userId, name: 'A' });

    const treffer = runLegalQuery(db, desk.id, { ...A, userId }, 'facts-without-evidence');
    expect(treffer.some((t) => t.objektId === 'ts1')).toBe(true);
  });

  it('eine Tatsache mit einer belegt-Verknüpfung fehlt im Ergebnis', async () => {
    const { db, desk, userId } = await neuerDesk();
    const actor = { id: userId, name: 'A' };
    applyDeskCommand(db, desk.id, { type: 'addLegalObject', payload: { id: 'ts1', kind: 'tatsache', text: 'Belegte Tatsache', position: { x: 0, y: 0 } } }, actor);
    applyDeskCommand(db, desk.id, { type: 'addLegalObject', payload: { id: 'bw1', kind: 'beweismittel', text: 'Beweismittel', position: { x: 10, y: 0 } } }, actor);
    applyDeskCommand(db, desk.id, { type: 'addLink', payload: { id: 'lnk1', fromId: 'ts1', toId: 'bw1' } }, actor);
    applyDeskCommand(db, desk.id, { type: 'setLinkKind', payload: { linkId: 'lnk1', kind: 'belegt' } }, actor);

    const treffer = runLegalQuery(db, desk.id, { ...A, userId }, 'facts-without-evidence');
    expect(treffer.some((t) => t.objektId === 'ts1')).toBe(false);
  });

  it('eine Tatsache, die nur über eine Verknüpfung OHNE Bedeutung verbunden ist, gilt als unbelegt', async () => {
    const { db, desk, userId } = await neuerDesk();
    const actor = { id: userId, name: 'A' };
    applyDeskCommand(db, desk.id, { type: 'addLegalObject', payload: { id: 'ts1', kind: 'tatsache', text: 'Tatsache', position: { x: 0, y: 0 } } }, actor);
    applyDeskCommand(db, desk.id, { type: 'addLegalObject', payload: { id: 'bw1', kind: 'beweismittel', text: 'Beweismittel', position: { x: 10, y: 0 } } }, actor);
    applyDeskCommand(db, desk.id, { type: 'addLink', payload: { id: 'lnk1', fromId: 'ts1', toId: 'bw1' } }, actor);
    // kein setLinkKind — Verknüpfung bleibt ohne Bedeutung

    const treffer = runLegalQuery(db, desk.id, { ...A, userId }, 'facts-without-evidence');
    expect(treffer.some((t) => t.objektId === 'ts1')).toBe(true);
  });
});

describe('runLegalQuery: opposing-claims-without-rebuttal', () => {
  it('liefert eine gegnerische Behauptung ohne Verknüpfung der Familie widersprechend', async () => {
    const { db, desk, userId } = await neuerDesk();
    applyDeskCommand(db, desk.id, { type: 'addLegalObject', payload: { id: 'bg1', kind: 'behauptung-gegenseite', text: 'Unerwiderte Behauptung', position: { x: 0, y: 0 } } }, { id: userId, name: 'A' });

    const treffer = runLegalQuery(db, desk.id, { ...A, userId }, 'opposing-claims-without-rebuttal');
    expect(treffer.some((t) => t.objektId === 'bg1')).toBe(true);
  });

  it('eine gegnerische Behauptung mit einer streitig-Verknüpfung (Familie widersprechend) fehlt im Ergebnis', async () => {
    const { db, desk, userId } = await neuerDesk();
    const actor = { id: userId, name: 'A' };
    applyDeskCommand(db, desk.id, { type: 'addLegalObject', payload: { id: 'bg1', kind: 'behauptung-gegenseite', text: 'Erwiderte Behauptung', position: { x: 0, y: 0 } } }, actor);
    applyDeskCommand(db, desk.id, { type: 'addLegalObject', payload: { id: 'eb1', kind: 'eigene-behauptung', text: 'Gegenposition', position: { x: 10, y: 0 } } }, actor);
    applyDeskCommand(db, desk.id, { type: 'addLink', payload: { id: 'lnk1', fromId: 'bg1', toId: 'eb1' } }, actor);
    applyDeskCommand(db, desk.id, { type: 'setLinkKind', payload: { linkId: 'lnk1', kind: 'streitig' } }, actor);

    const treffer = runLegalQuery(db, desk.id, { ...A, userId }, 'opposing-claims-without-rebuttal');
    expect(treffer.some((t) => t.objektId === 'bg1')).toBe(false);
  });
});

describe('runLegalQuery: evidence-supporting-multiple-facts', () => {
  it('ein Beweismittel mit genau einer belegt-Verknüpfung zu einer Tatsache fehlt im Ergebnis', async () => {
    const { db, desk, userId } = await neuerDesk();
    const actor = { id: userId, name: 'A' };
    applyDeskCommand(db, desk.id, { type: 'addLegalObject', payload: { id: 'bw1', kind: 'beweismittel', text: 'Beweismittel', position: { x: 0, y: 0 } } }, actor);
    applyDeskCommand(db, desk.id, { type: 'addLegalObject', payload: { id: 'ts1', kind: 'tatsache', text: 'Tatsache 1', position: { x: 10, y: 0 } } }, actor);
    applyDeskCommand(db, desk.id, { type: 'addLink', payload: { id: 'lnk1', fromId: 'bw1', toId: 'ts1' } }, actor);
    applyDeskCommand(db, desk.id, { type: 'setLinkKind', payload: { linkId: 'lnk1', kind: 'belegt' } }, actor);

    const treffer = runLegalQuery(db, desk.id, { ...A, userId }, 'evidence-supporting-multiple-facts');
    expect(treffer.some((t) => t.objektId === 'bw1')).toBe(false);
  });

  it('zwei Verknüpfungen zur selben Tatsache zählen als eine — fehlt weiterhin im Ergebnis', async () => {
    const { db, desk, userId } = await neuerDesk();
    const actor = { id: userId, name: 'A' };
    applyDeskCommand(db, desk.id, { type: 'addLegalObject', payload: { id: 'bw1', kind: 'beweismittel', text: 'Beweismittel', position: { x: 0, y: 0 } } }, actor);
    applyDeskCommand(db, desk.id, { type: 'addLegalObject', payload: { id: 'ts1', kind: 'tatsache', text: 'Tatsache 1', position: { x: 10, y: 0 } } }, actor);
    applyDeskCommand(db, desk.id, { type: 'addLegalObject', payload: { id: 'eb1', kind: 'eigene-behauptung', text: 'Keine Tatsache', position: { x: 20, y: 0 } } }, actor);
    applyDeskCommand(db, desk.id, { type: 'addLink', payload: { id: 'lnk1', fromId: 'bw1', toId: 'ts1' } }, actor);
    applyDeskCommand(db, desk.id, { type: 'setLinkKind', payload: { linkId: 'lnk1', kind: 'belegt' } }, actor);
    applyDeskCommand(db, desk.id, { type: 'addLink', payload: { id: 'lnk2', fromId: 'bw1', toId: 'eb1' } }, actor);
    applyDeskCommand(db, desk.id, { type: 'setLinkKind', payload: { linkId: 'lnk2', kind: 'belegt' } }, actor);

    const treffer = runLegalQuery(db, desk.id, { ...A, userId }, 'evidence-supporting-multiple-facts');
    expect(treffer.some((t) => t.objektId === 'bw1')).toBe(false);
  });

  it('liefert ein Beweismittel mit belegt-Verknüpfungen zu zwei VERSCHIEDENEN Tatsachen', async () => {
    const { db, desk, userId } = await neuerDesk();
    const actor = { id: userId, name: 'A' };
    applyDeskCommand(db, desk.id, { type: 'addLegalObject', payload: { id: 'bw1', kind: 'beweismittel', text: 'Beweismittel', position: { x: 0, y: 0 } } }, actor);
    applyDeskCommand(db, desk.id, { type: 'addLegalObject', payload: { id: 'ts1', kind: 'tatsache', text: 'Tatsache 1', position: { x: 10, y: 0 } } }, actor);
    applyDeskCommand(db, desk.id, { type: 'addLegalObject', payload: { id: 'ts2', kind: 'tatsache', text: 'Tatsache 2', position: { x: 20, y: 0 } } }, actor);
    applyDeskCommand(db, desk.id, { type: 'addLink', payload: { id: 'lnk1', fromId: 'bw1', toId: 'ts1' } }, actor);
    applyDeskCommand(db, desk.id, { type: 'setLinkKind', payload: { linkId: 'lnk1', kind: 'belegt' } }, actor);
    applyDeskCommand(db, desk.id, { type: 'addLink', payload: { id: 'lnk2', fromId: 'bw1', toId: 'ts2' } }, actor);
    applyDeskCommand(db, desk.id, { type: 'setLinkKind', payload: { linkId: 'lnk2', kind: 'belegt' } }, actor);

    const treffer = runLegalQuery(db, desk.id, { ...A, userId }, 'evidence-supporting-multiple-facts');
    expect(treffer.some((t) => t.objektId === 'bw1')).toBe(true);
  });
});

/** T-08-18 (kritischste Bedrohung dieses Plans): eine Verknüpfung zu einem für den Actor
 *  unsichtbaren Gegenstück (fremde Privat-Ebene) darf keinen Treffer unterdrücken und darf
 *  selbst nie als Treffer erscheinen — je ein Fall pro Abfrage. */
describe('Sichtbarkeitsgrenze (T-08-18): fremde Privat-Ebene wirkt in keiner der drei Abfragen', () => {
  it('facts-without-evidence: eine belegt-Verknüpfung zu einem unsichtbaren Beweismittel unterdrückt den Treffer NICHT', async () => {
    const { db, desk, userId: ownerId } = await neuerDesk();
    const bUserId = await createUser(db, 'nutzer-b', 'test-passwort');
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(desk.id, bUserId, 'Bearbeiter');
    const actor = { id: bUserId, name: 'B' };
    applyDeskCommand(db, desk.id, { type: 'addLegalObject', payload: { id: 'ts1', kind: 'tatsache', text: 'Tatsache', position: { x: 0, y: 0 } } }, actor);
    applyDeskCommand(db, desk.id, { type: 'addLegalObject', payload: { id: 'bw1', kind: 'beweismittel', text: 'Privates Beweismittel', position: { x: 10, y: 0 } } }, actor);
    applyDeskCommand(db, desk.id, { type: 'addLink', payload: { id: 'lnk1', fromId: 'ts1', toId: 'bw1' } }, actor);
    applyDeskCommand(db, desk.id, { type: 'setLinkKind', payload: { linkId: 'lnk1', kind: 'belegt' } }, actor);
    applyDeskCommand(db, desk.id, { type: 'changeLayerId', payload: { objectId: 'bw1', layerId: 'privat' } }, actor);

    // Eigentümer sieht das private Objekt nicht (nutzer-b's eigene Privat-Instanz).
    const trefferOwner = runLegalQuery(db, desk.id, { userId: ownerId, rolle: 'Eigentümer' }, 'facts-without-evidence');
    expect(trefferOwner.some((t) => t.objektId === 'ts1')).toBe(true);
    expect(trefferOwner.some((t) => t.objektId === 'bw1')).toBe(false);

    // Der Eigentümer der privaten Ebene selbst sieht sie weiterhin belegt.
    const trefferB = runLegalQuery(db, desk.id, { userId: bUserId, rolle: 'Bearbeiter' }, 'facts-without-evidence');
    expect(trefferB.some((t) => t.objektId === 'ts1')).toBe(false);
  });

  it('opposing-claims-without-rebuttal: eine streitig-Verknüpfung zu einer unsichtbaren Gegenposition unterdrückt den Treffer NICHT', async () => {
    const { db, desk, userId: ownerId } = await neuerDesk();
    const bUserId = await createUser(db, 'nutzer-b', 'test-passwort');
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(desk.id, bUserId, 'Bearbeiter');
    const actor = { id: bUserId, name: 'B' };
    applyDeskCommand(db, desk.id, { type: 'addLegalObject', payload: { id: 'bg1', kind: 'behauptung-gegenseite', text: 'Behauptung', position: { x: 0, y: 0 } } }, actor);
    applyDeskCommand(db, desk.id, { type: 'addLegalObject', payload: { id: 'eb1', kind: 'eigene-behauptung', text: 'Private Gegenposition', position: { x: 10, y: 0 } } }, actor);
    applyDeskCommand(db, desk.id, { type: 'addLink', payload: { id: 'lnk1', fromId: 'bg1', toId: 'eb1' } }, actor);
    applyDeskCommand(db, desk.id, { type: 'setLinkKind', payload: { linkId: 'lnk1', kind: 'streitig' } }, actor);
    applyDeskCommand(db, desk.id, { type: 'changeLayerId', payload: { objectId: 'eb1', layerId: 'privat' } }, actor);

    const trefferOwner = runLegalQuery(db, desk.id, { userId: ownerId, rolle: 'Eigentümer' }, 'opposing-claims-without-rebuttal');
    expect(trefferOwner.some((t) => t.objektId === 'bg1')).toBe(true);
  });

  it('evidence-supporting-multiple-facts: eine belegt-Verknüpfung zu einer unsichtbaren Tatsache zählt NICHT mit', async () => {
    const { db, desk, userId: ownerId } = await neuerDesk();
    const bUserId = await createUser(db, 'nutzer-b', 'test-passwort');
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(desk.id, bUserId, 'Bearbeiter');
    const actor = { id: bUserId, name: 'B' };
    applyDeskCommand(db, desk.id, { type: 'addLegalObject', payload: { id: 'bw1', kind: 'beweismittel', text: 'Beweismittel', position: { x: 0, y: 0 } } }, actor);
    applyDeskCommand(db, desk.id, { type: 'addLegalObject', payload: { id: 'ts1', kind: 'tatsache', text: 'Sichtbare Tatsache', position: { x: 10, y: 0 } } }, actor);
    applyDeskCommand(db, desk.id, { type: 'addLegalObject', payload: { id: 'ts2', kind: 'tatsache', text: 'Private Tatsache', position: { x: 20, y: 0 } } }, actor);
    applyDeskCommand(db, desk.id, { type: 'addLink', payload: { id: 'lnk1', fromId: 'bw1', toId: 'ts1' } }, actor);
    applyDeskCommand(db, desk.id, { type: 'setLinkKind', payload: { linkId: 'lnk1', kind: 'belegt' } }, actor);
    applyDeskCommand(db, desk.id, { type: 'addLink', payload: { id: 'lnk2', fromId: 'bw1', toId: 'ts2' } }, actor);
    applyDeskCommand(db, desk.id, { type: 'setLinkKind', payload: { linkId: 'lnk2', kind: 'belegt' } }, actor);
    applyDeskCommand(db, desk.id, { type: 'changeLayerId', payload: { objectId: 'ts2', layerId: 'privat' } }, actor);

    // Nur EINE sichtbare belegt-Verknüpfung zu einer Tatsache — kein Treffer für den Eigentümer.
    const trefferOwner = runLegalQuery(db, desk.id, { userId: ownerId, rolle: 'Eigentümer' }, 'evidence-supporting-multiple-facts');
    expect(trefferOwner.some((t) => t.objektId === 'bw1')).toBe(false);

    // Der Eigentümer der privaten Tatsache sieht beide — Treffer erscheint.
    const trefferB = runLegalQuery(db, desk.id, { userId: bUserId, rolle: 'Bearbeiter' }, 'evidence-supporting-multiple-facts');
    expect(trefferB.some((t) => t.objektId === 'bw1')).toBe(true);
  });
});

describe('Sonderfälle', () => {
  it('ein unbekannter Abfragename liefert ein leeres Ergebnis statt einer Ausnahme', async () => {
    const { db, desk, userId } = await neuerDesk();
    expect(() => runLegalQuery(db, desk.id, { ...A, userId }, 'nicht-existent')).not.toThrow();
    expect(runLegalQuery(db, desk.id, { ...A, userId }, 'nicht-existent')).toEqual([]);
  });

  it('ein Ergebnis mit 31 passenden Objekten wird auf 30 Einträge gekappt', async () => {
    const { db, desk, userId } = await neuerDesk();
    const actor = { id: userId, name: 'A' };
    for (let i = 0; i < 31; i++) {
      applyDeskCommand(db, desk.id, { type: 'addLegalObject', payload: { id: `ts${i}`, kind: 'tatsache', text: `Tatsache ${i}`, position: { x: i, y: 0 } } }, actor);
    }
    const treffer = runLegalQuery(db, desk.id, { ...A, userId }, 'facts-without-evidence');
    expect(treffer).toHaveLength(LEGAL_QUERY_MAX_TREFFER);
  });

  it('ein nicht existierender Schreibtisch liefert ein leeres Ergebnis', async () => {
    const { db, userId } = await neuerDesk();
    expect(runLegalQuery(db, 'kein-desk', { ...A, userId }, 'facts-without-evidence')).toEqual([]);
  });

  it('LEGAL_QUERIES enthält exakt die drei gesperrten Kennungen/Labels', () => {
    expect(LEGAL_QUERIES).toEqual([
      { kind: 'facts-without-evidence', label: 'Tatsachen ohne Beweismittel' },
      { kind: 'opposing-claims-without-rebuttal', label: 'Behauptungen der Gegenseite ohne Erwiderung' },
      { kind: 'evidence-supporting-multiple-facts', label: 'Beweismittel, die mehrere Tatsachen stützen' },
    ]);
  });

  it('getDeskState() bleibt unverändert nutzbar — runLegalQuery liest nicht destruktiv', async () => {
    const { db, desk, userId } = await neuerDesk();
    applyDeskCommand(db, desk.id, { type: 'addLegalObject', payload: { id: 'ts1', kind: 'tatsache', text: 'x', position: { x: 0, y: 0 } } }, { id: userId, name: 'A' });
    runLegalQuery(db, desk.id, { ...A, userId }, 'facts-without-evidence');
    expect(getDeskState(db, desk.id)?.state.legalObjects).toHaveLength(1);
  });
});

/**
 * POST /api/v1/desks/:id/legal-queries — echter Durchstich über die reale App (Task 2).
 */
describe('POST /api/v1/desks/:id/legal-queries', () => {
  it('gültiger Abfragename liefert { treffer: [...] }', async () => {
    const { app, authHeaders } = await createTestApp();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'Akte' } })
    ).json() as { id: string };
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'addLegalObject', payload: { id: 'ts1', kind: 'tatsache', text: 'Unbelegt', position: { x: 0, y: 0 } } },
    });

    const res = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/legal-queries`, headers: authHeaders,
      payload: { query: 'facts-without-evidence' },
    });
    expect(res.statusCode).toBe(200);
    const { treffer } = res.json() as { treffer: { objektId: string; art: string }[] };
    expect(treffer.some((t) => t.objektId === 'ts1' && t.art === 'Tatsache')).toBe(true);
  });

  it('ein fehlender query-Wert liefert 400 mit deutscher Klartextmeldung', async () => {
    const { app, authHeaders } = await createTestApp();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'Akte' } })
    ).json() as { id: string };

    const res = await app.inject({ method: 'POST', url: `/api/v1/desks/${desk.id}/legal-queries`, headers: authHeaders, payload: {} });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toMatch(/[a-zäöü]/);
  });

  it('ein nicht-string query-Wert liefert 400', async () => {
    const { app, authHeaders } = await createTestApp();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'Akte' } })
    ).json() as { id: string };

    const res = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/legal-queries`, headers: authHeaders, payload: { query: 42 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('ein unbekannter Abfragename liefert 400 statt eines leeren 200', async () => {
    const { app, authHeaders } = await createTestApp();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'Akte' } })
    ).json() as { id: string };

    const res = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/legal-queries`, headers: authHeaders, payload: { query: 'tippfehler' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('ein Aufruf ohne gültiges Token liefert 401', async () => {
    const { app, authHeaders } = await createTestApp();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'Akte' } })
    ).json() as { id: string };

    const res = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/legal-queries`, payload: { query: 'facts-without-evidence' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('ein Nutzer ohne Rolle auf diesem Schreibtisch erhält 403', async () => {
    const { app, a, b } = await createTestAppMitZweiNutzern();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte' } })
    ).json() as { id: string };

    const res = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/legal-queries`, headers: b.authHeaders,
      payload: { query: 'facts-without-evidence' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('die Rolle Nur-Lesen darf auswerten (Lesevorgang, keine gefährliche Aktion)', async () => {
    const { app, db, a, b } = await createTestAppMitZweiNutzern();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte' } })
    ).json() as { id: string };
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(desk.id, b.userId, 'Nur-Lesen');

    const res = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/legal-queries`, headers: b.authHeaders,
      payload: { query: 'facts-without-evidence' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('eine Ausnahme in der Auswertung liefert 500 mit generischer Meldung, ohne Ausnahmedetails/Stacktrace/SQLite-Fehlercode', async () => {
    const { app, db, authHeaders } = await createTestApp();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'Akte' } })
    ).json() as { id: string };
    // Beschädigt den gespeicherten Zustand (kein valides JSON) — getDeskState()'s JSON.parse
    // wirft, runLegalQuery() gibt die Ausnahme durch, die Route muss sie schweigend abfangen.
    db.prepare('UPDATE desks SET state = ? WHERE id = ?').run('{ kein valides json', desk.id);

    const res = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/legal-queries`, headers: authHeaders,
      payload: { query: 'facts-without-evidence' },
    });
    expect(res.statusCode).toBe(500);
    const body = res.json() as { error: string };
    expect(body.error).toBe('Auswertung fehlgeschlagen.');
    expect(body.error).not.toMatch(/JSON|SQLITE|Error:|at Object|\.ts:\d/i);
  });
});
