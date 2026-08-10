import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addUser, createTestAppMitZweiNutzern } from './testUtils';
import { register, unregister } from './broadcast';
import { openDb, type Db } from './db';
import { buildApp } from './app';
import { startFakeJLawyer, FAKE_JLAWYER_USER_B, type FakeJLawyer } from './testJLawyer';

/**
 * Erwähnungs-Benachrichtigungen end-to-end (NOTIF-01, 13-01 Task 1): neue Tabelle,
 * Auslöser-Hook im applyDeskCommand-Pfad (die einzige Stelle, durch die Browser, MCP
 * und Offline-Nachspielen laufen — U2), user-scoped REST-Routen und das inhaltsfreie
 * WS-Signal { event: 'benachrichtigungenGeaendert' } (genau ein Schlüssel, Bugklasse
 * aec4f58/fcda808). Vertraulichkeits-Doppelregel (U1): die Zeile entsteht nur, wenn
 * die referenzierte Notiz für den Empfänger sichtbar ist (fail-closed), und Lesen ist
 * strikt auf den eigenen user_id-Bestand begrenzt (ASVS V4, kein Desk-Rollen-Shortcut).
 */

interface InboxZeile {
  id: string;
  user_id: string;
  desk_id: string | null;
  art: string;
  payload: {
    notizId?: string; notizTitel?: string; vonName?: string; textStand?: string;
    aufgabeId?: string; titel?: string; variante?: string; faellig?: string; status?: string;
    deskId?: string; deskName?: string; rolle?: string;
    dokumentId?: string; dokumentName?: string;
  };
  created_at: number;
  read_at: number | null;
}

interface EinNutzer {
  userId: string;
  token: string;
  authHeaders: { authorization: string };
}

async function legeDeskAn(app: FastifyInstance, nutzer: EinNutzer): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/desks', headers: nutzer.authHeaders, payload: { name: 'Akte Notif' } });
  return (res.json() as { id: string }).id;
}

function erteileRolle(db: Db, deskId: string, userId: string, rolle: string): void {
  db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(deskId, userId, rolle);
}

async function kommando(app: FastifyInstance, nutzer: EinNutzer, deskId: string, cmd: unknown): Promise<void> {
  const res = await app.inject({
    method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers: nutzer.authHeaders, payload: cmd,
  });
  expect(res.statusCode).toBe(200);
}

async function inbox(app: FastifyInstance, nutzer: EinNutzer): Promise<InboxZeile[]> {
  const res = await app.inject({ method: 'GET', url: '/api/v1/benachrichtigungen', headers: nutzer.authHeaders });
  expect(res.statusCode).toBe(200);
  return (res.json() as { benachrichtigungen: InboxZeile[] }).benachrichtigungen;
}

describe('13-01 Task 1: Erwähnungs-Benachrichtigung (Tabelle, Hook, REST, WS-Signal)', () => {
  it('addNote mit „@nutzer-b“ erzeugt genau eine erwaehnung-Zeile für B (read_at NULL)', async () => {
    const { app, db, a, b } = await createTestAppMitZweiNutzern();
    const deskId = await legeDeskAn(app, a);
    erteileRolle(db, deskId, b.userId, 'Bearbeiter');

    await kommando(app, a, deskId, {
      type: 'addNote',
      payload: { id: 'n-1', kind: 'notiz', text: 'Bitte prüfen @nutzer-b', position: { x: 0, y: 0 } },
    });

    const zeilen = await inbox(app, b);
    expect(zeilen).toHaveLength(1);
    const z = zeilen[0];
    expect(z.art).toBe('erwaehnung');
    expect(z.user_id).toBe(b.userId);
    expect(z.desk_id).toBe(deskId);
    expect(z.read_at).toBeNull();
    expect(z.payload.notizId).toBe('n-1');
    expect(z.payload.vonName).toBe('nutzer-a');
    // Andeutungs-Bremse: der Titel ist gekappt (≤ 60 Zeichen), kein Volltext-Feld am Titel.
    expect(z.payload.notizTitel!.length).toBeLessThanOrEqual(60);
    // keine Selbst-Benachrichtigung des Auslösers
    expect(await inbox(app, a)).toHaveLength(0);
  });

  it('Erwähnung auf der Privat-Ebene des Auslösers erzeugt KEINE Zeile (fail-closed, istObjektSichtbarFuer)', async () => {
    const { app, db, a, b } = await createTestAppMitZweiNutzern();
    const deskId = await legeDeskAn(app, a);
    erteileRolle(db, deskId, b.userId, 'Bearbeiter');

    await kommando(app, a, deskId, {
      type: 'addNote',
      payload: { id: 'n-priv', kind: 'notiz', text: 'intern', position: { x: 0, y: 0 } },
    });
    // Platzhalter 'privat' materialisiert lazy die Pro-Nutzer-Instanz privat-<a.userId> (02-09).
    await kommando(app, a, deskId, { type: 'changeLayerId', payload: { objectId: 'n-priv', layerId: 'privat' } });
    await kommando(app, a, deskId, { type: 'editNote', payload: { id: 'n-priv', text: 'Bitte prüfen @nutzer-b' } });

    expect(await inbox(app, b)).toHaveLength(0);
  });

  it('Dedupe: zweimal dasselbe editNote mit unverändertem Textstand erzeugt keine zweite Zeile', async () => {
    const { app, db, a, b } = await createTestAppMitZweiNutzern();
    const deskId = await legeDeskAn(app, a);
    erteileRolle(db, deskId, b.userId, 'Bearbeiter');

    await kommando(app, a, deskId, {
      type: 'addNote',
      payload: { id: 'n-1', kind: 'notiz', text: 'Bitte prüfen @nutzer-b', position: { x: 0, y: 0 } },
    });
    await kommando(app, a, deskId, { type: 'editNote', payload: { id: 'n-1', text: 'Bitte prüfen @nutzer-b' } });
    await kommando(app, a, deskId, { type: 'editNote', payload: { id: 'n-1', text: 'Bitte prüfen @nutzer-b' } });

    expect(await inbox(app, b)).toHaveLength(1);
  });

  it('editNote, das einen NEUEN Namen hinzufügt, erzeugt nur für den neuen Namen eine Zeile', async () => {
    const { app, db, a, b } = await createTestAppMitZweiNutzern();
    const c = await addUser(db, 'nutzer-c');
    const deskId = await legeDeskAn(app, a);
    erteileRolle(db, deskId, b.userId, 'Bearbeiter');
    erteileRolle(db, deskId, c.userId, 'Bearbeiter');
    const cNutzer: EinNutzer = { userId: c.userId, token: c.token, authHeaders: { authorization: `Bearer ${c.token}` } };

    await kommando(app, a, deskId, {
      type: 'addNote',
      payload: { id: 'n-1', kind: 'notiz', text: 'Bitte prüfen @nutzer-b', position: { x: 0, y: 0 } },
    });
    await kommando(app, a, deskId, { type: 'editNote', payload: { id: 'n-1', text: 'Bitte prüfen @nutzer-b und @nutzer-c' } });

    expect(await inbox(app, b)).toHaveLength(1);
    const zeilenC = await inbox(app, cNutzer);
    expect(zeilenC).toHaveLength(1);
    expect(zeilenC[0].payload.notizId).toBe('n-1');
  });

  it('GET ist strikt user-scoped: A sieht niemals Zeilen mit user_id von B (Inhalts-Assertion)', async () => {
    const { app, db, a, b } = await createTestAppMitZweiNutzern();
    const deskId = await legeDeskAn(app, a);
    erteileRolle(db, deskId, b.userId, 'Bearbeiter');

    await kommando(app, a, deskId, {
      type: 'addNote',
      payload: { id: 'n-1', kind: 'notiz', text: 'Bitte prüfen @nutzer-b', position: { x: 0, y: 0 } },
    });

    const zeilenA = await inbox(app, a);
    for (const z of zeilenA) expect(z.user_id).toBe(a.userId);
    expect(zeilenA.some((z) => z.user_id === b.userId)).toBe(false);
  });

  it('POST /:id/gelesen setzt read_at nur für eigene Zeilen (fremde id → 404, fail-closed ohne Existenz-Auskunft)', async () => {
    const { app, db, a, b } = await createTestAppMitZweiNutzern();
    const deskId = await legeDeskAn(app, a);
    erteileRolle(db, deskId, b.userId, 'Bearbeiter');

    await kommando(app, a, deskId, {
      type: 'addNote',
      payload: { id: 'n-1', kind: 'notiz', text: 'Bitte prüfen @nutzer-b', position: { x: 0, y: 0 } },
    });
    const [zeile] = await inbox(app, b);

    const fremd = await app.inject({
      method: 'POST', url: `/api/v1/benachrichtigungen/${zeile.id}/gelesen`, headers: a.authHeaders,
    });
    expect(fremd.statusCode).toBe(404);
    // unverändert ungelesen nach dem fremden Zugriff
    expect((await inbox(app, b))[0].read_at).toBeNull();

    const eigen = await app.inject({
      method: 'POST', url: `/api/v1/benachrichtigungen/${zeile.id}/gelesen`, headers: b.authHeaders,
    });
    expect(eigen.statusCode).toBe(200);
    const nachher = (await inbox(app, b))[0];
    expect(nachher.read_at).not.toBeNull();
  });

  it('POST /alle-gelesen markiert nur eigene Zeilen (Nutzerhoheit)', async () => {
    const { app, db, a, b } = await createTestAppMitZweiNutzern();
    const deskId = await legeDeskAn(app, a);
    erteileRolle(db, deskId, b.userId, 'Bearbeiter');

    await kommando(app, a, deskId, {
      type: 'addNote',
      payload: { id: 'n-1', kind: 'notiz', text: 'Bitte prüfen @nutzer-b', position: { x: 0, y: 0 } },
    });
    const res = await app.inject({ method: 'POST', url: '/api/v1/benachrichtigungen/alle-gelesen', headers: b.authHeaders });
    expect(res.statusCode).toBe(200);
    expect((await inbox(app, b)).every((z) => z.read_at !== null)).toBe(true);
  });

  it('Das gebroadcastete Signal serialisiert zu JSON mit GENAU einem Schlüssel (event) — kein Zähler, kein Payload', async () => {
    const { app, db, a, b } = await createTestAppMitZweiNutzern();
    const deskId = await legeDeskAn(app, a);
    erteileRolle(db, deskId, b.userId, 'Bearbeiter');

    const gesendet: unknown[] = [];
    const sockel = { send: (data: string) => { gesendet.push(JSON.parse(data) as unknown); } };
    register(deskId, sockel, b.userId, 'Bearbeiter');
    try {
      await kommando(app, a, deskId, {
        type: 'addNote',
        payload: { id: 'n-1', kind: 'notiz', text: 'Bitte prüfen @nutzer-b', position: { x: 0, y: 0 } },
      });
    } finally {
      unregister(deskId, sockel);
    }

    const signale = gesendet.filter(
      (m) => m !== null && typeof m === 'object' && (m as { event?: unknown }).event === 'benachrichtigungenGeaendert',
    );
    expect(signale).toHaveLength(1);
    expect(Object.keys(signale[0] as object)).toEqual(['event']);
  });

  it('moveNote (kein Textbezug) erzeugt keine Zeile (Lärm-Regel)', async () => {
    const { app, db, a, b } = await createTestAppMitZweiNutzern();
    const deskId = await legeDeskAn(app, a);
    erteileRolle(db, deskId, b.userId, 'Bearbeiter');

    await kommando(app, a, deskId, {
      type: 'addNote',
      payload: { id: 'n-1', kind: 'notiz', text: 'Bitte prüfen @nutzer-b', position: { x: 0, y: 0 } },
    });
    await kommando(app, a, deskId, { type: 'moveNote', payload: { id: 'n-1', position: { x: 200, y: 200 } } });

    // genau die eine Erwähnungs-Zeile aus dem addNote — moveNote hat nichts hinzugefügt
    expect(await inbox(app, b)).toHaveLength(1);
  });
});

describe('13-01 Task 3: Zwei-Nutzer-Vertraulichkeitsbeweis und Rollen-Vollständigkeit', () => {
  it('Privat-Ebene des Auslösers: B bekommt keine Zeile; A’s eigene Inbox bleibt unverändert (keine Selbst-Benachrichtigung)', async () => {
    const { app, db, a, b } = await createTestAppMitZweiNutzern();
    const deskId = await legeDeskAn(app, a);
    erteileRolle(db, deskId, b.userId, 'Bearbeiter');

    // Echter Kommandopfad: addNote → changeLayerId auf die lazy Privat-Instanz (Platzhalter
    // 'privat' materialisiert privat-<a.userId> über meta.createdById, 02-09) → editNote.
    await kommando(app, a, deskId, {
      type: 'addNote',
      payload: { id: 'n-priv', kind: 'notiz', text: 'intern', position: { x: 0, y: 0 } },
    });
    await kommando(app, a, deskId, { type: 'changeLayerId', payload: { objectId: 'n-priv', layerId: 'privat' } });
    await kommando(app, a, deskId, { type: 'editNote', payload: { id: 'n-priv', text: 'Bitte prüfen @nutzer-b' } });

    expect(await inbox(app, b)).toHaveLength(0);
    // Der Auslöser benachrichtigt sich nie selbst — seine Inbox bleibt leer.
    expect(await inbox(app, a)).toHaveLength(0);
  });

  it('Kanzlei-Ebene: B bekommt genau eine Zeile und sieht sie per GET; das dritte Mitglied C (nicht erwähnt) sieht sie nicht', async () => {
    const { app, db, a, b } = await createTestAppMitZweiNutzern();
    const c = await addUser(db, 'nutzer-c');
    const deskId = await legeDeskAn(app, a);
    erteileRolle(db, deskId, b.userId, 'Bearbeiter');
    erteileRolle(db, deskId, c.userId, 'Bearbeiter');
    const cNutzer: EinNutzer = { userId: c.userId, token: c.token, authHeaders: { authorization: `Bearer ${c.token}` } };

    await kommando(app, a, deskId, {
      type: 'addNote',
      payload: { id: 'n-1', kind: 'notiz', text: 'Bitte prüfen @nutzer-b', position: { x: 0, y: 0 } },
    });

    const zeilenB = await inbox(app, b);
    expect(zeilenB).toHaveLength(1);
    expect(zeilenB[0].art).toBe('erwaehnung');
    expect(zeilenB[0].payload.notizId).toBe('n-1');
    // Mitglied, aber nicht erwähnt: keine Zeile, keine Andeutung.
    expect(await inbox(app, cNutzer)).toHaveLength(0);
  });

  it('Kommentator als Auslöser und Nur-Lesen-Nutzer als Empfänger: die Zeile entsteht (Rollen-Vollständigkeit, U1)', async () => {
    // Genau die Rollen, für die eine Journal-Ableitung strukturell versagt hätte: die
    // Journal-Route ist Eigentümer/Bearbeiter-gegatet — Kommentator/Nur-Lesen bekämen über
    // eine Ableitung leere Inboxen (U1-Begründung 1, 13-RESEARCH.md).
    const { app, db, a, b } = await createTestAppMitZweiNutzern();
    const c = await addUser(db, 'nutzer-c');
    const deskId = await legeDeskAn(app, a);
    erteileRolle(db, deskId, b.userId, 'Nur-Lesen');
    erteileRolle(db, deskId, c.userId, 'Kommentator');
    const cNutzer: EinNutzer = { userId: c.userId, token: c.token, authHeaders: { authorization: `Bearer ${c.token}` } };

    await kommando(app, cNutzer, deskId, {
      type: 'addNote',
      payload: { id: 'n-k', kind: 'notiz', text: 'Bitte prüfen @nutzer-b', position: { x: 0, y: 0 } },
    });

    const zeilenB = await inbox(app, b);
    expect(zeilenB).toHaveLength(1);
    expect(zeilenB[0].art).toBe('erwaehnung');
    expect(zeilenB[0].payload.vonName).toBe('nutzer-c');
    expect(zeilenB[0].payload.notizId).toBe('n-k');
  });
});

/**
 * 13-04 Task 1: Aufgaben-Auslöser (setTaskAssignee/setTaskStatus, O2-Vorentscheidung) und
 * Mitglieder-Auslöser (POST /desks/:id/members, O3-Vorentscheidung) — dasselbe fail-closed
 * Sichtprüfungs- und Dedupe-Skelett wie die Erwähnungs-Zeile aus 13-01, an drei zusätzlichen
 * Hook-Punkten (Kommandopfad, Mitglieder-Route).
 */
describe('13-04 Task 1: Aufgaben-Auslöser (setTaskAssignee/setTaskStatus) und Mitglieder-Auslöser (POST /members)', () => {
  async function legeAufgabeAn(app: FastifyInstance, nutzer: EinNutzer, deskId: string, taskId: string): Promise<void> {
    await kommando(app, nutzer, deskId, {
      type: 'addLegalObject',
      payload: { id: taskId, kind: 'aufgabe', text: 'Schriftsatz fertigstellen', position: { x: 0, y: 0 } },
    });
  }

  it('setTaskAssignee { assignee: "nutzer-b" } durch A erzeugt genau eine aufgabe/zuweisung-Zeile für B; Selbst-Zuweisung ist still', async () => {
    const { app, db, a, b } = await createTestAppMitZweiNutzern();
    const deskId = await legeDeskAn(app, a);
    erteileRolle(db, deskId, b.userId, 'Bearbeiter');
    await legeAufgabeAn(app, a, deskId, 't-1');

    await kommando(app, a, deskId, { type: 'setTaskAssignee', payload: { id: 't-1', assignee: 'nutzer-b' } });

    const zeilenB = await inbox(app, b);
    expect(zeilenB).toHaveLength(1);
    expect(zeilenB[0].art).toBe('aufgabe');
    expect(zeilenB[0].payload).toMatchObject({
      aufgabeId: 't-1', titel: 'Schriftsatz fertigstellen', variante: 'zuweisung', vonName: 'nutzer-a',
    });

    // Selbst-Zuweisung: A weist sich selbst zu -> keine Zeile für A.
    await kommando(app, a, deskId, { type: 'setTaskAssignee', payload: { id: 't-1', assignee: 'nutzer-a' } });
    expect(await inbox(app, a)).toHaveLength(0);
  });

  it('faellig landet im Payload, wenn die Aufgabe eine Fälligkeit trägt', async () => {
    const { app, db, a, b } = await createTestAppMitZweiNutzern();
    const deskId = await legeDeskAn(app, a);
    erteileRolle(db, deskId, b.userId, 'Bearbeiter');
    await legeAufgabeAn(app, a, deskId, 't-faellig');
    await kommando(app, a, deskId, { type: 'setTaskDueDate', payload: { id: 't-faellig', dueDate: '2026-08-20' } });

    await kommando(app, a, deskId, { type: 'setTaskAssignee', payload: { id: 't-faellig', assignee: 'nutzer-b' } });

    const [zeile] = await inbox(app, b);
    expect(zeile.payload.faellig).toBe('2026-08-20');
  });

  it('Aufgaben-Zeile entsteht NICHT, wenn die Aufgabe für den Empfänger unsichtbar ist (fremde Privat-Ebene, fail-closed)', async () => {
    const { app, db, a, b } = await createTestAppMitZweiNutzern();
    const deskId = await legeDeskAn(app, a);
    erteileRolle(db, deskId, b.userId, 'Bearbeiter');
    await legeAufgabeAn(app, a, deskId, 't-priv');
    await kommando(app, a, deskId, { type: 'changeLayerId', payload: { objectId: 't-priv', layerId: 'privat' } });

    await kommando(app, a, deskId, { type: 'setTaskAssignee', payload: { id: 't-priv', assignee: 'nutzer-b' } });

    expect(await inbox(app, b)).toHaveLength(0);
  });

  it('setTaskStatus durch den NICHT-Zuweisenden erzeugt eine Statuszeile an den Zuweisenden (O2); der Zuweisende selbst erzeugt keine', async () => {
    const { app, db, a, b } = await createTestAppMitZweiNutzern();
    const deskId = await legeDeskAn(app, a);
    erteileRolle(db, deskId, b.userId, 'Bearbeiter');
    await legeAufgabeAn(app, a, deskId, 't-status');
    // A weist sich selbst zu (A ist damit der "Zuweisende" — Empfänger einer künftigen Statuszeile).
    await kommando(app, a, deskId, { type: 'setTaskAssignee', payload: { id: 't-status', assignee: 'nutzer-a' } });

    // B (Ausführender, ≠ Zuweisender A) ändert den Status -> A bekommt die Statuszeile.
    await kommando(app, b, deskId, { type: 'setTaskStatus', payload: { id: 't-status', status: 'in-arbeit' } });
    const zeilenA = await inbox(app, a);
    expect(zeilenA.some((z) => z.art === 'aufgabe' && z.payload.variante === 'status' && z.payload.status === 'in-arbeit')).toBe(true);

    // A selbst ändert den Status -> keine Zeile für sich selbst (Lärm-Regel).
    await kommando(app, a, deskId, { type: 'setTaskStatus', payload: { id: 't-status', status: 'erledigt' } });
    expect(zeilenA.filter((z) => z.payload.status === 'erledigt')).toHaveLength(0);
  });

  it('POST /members mit { username, rolle } erzeugt genau eine geteilt-Zeile an den neuen Nutzer; PUT/DELETE erzeugen keine (O3)', async () => {
    const { app, db, a } = await createTestAppMitZweiNutzern();
    const c = await addUser(db, 'nutzer-c');
    const cNutzer: EinNutzer = { userId: c.userId, token: c.token, authHeaders: { authorization: `Bearer ${c.token}` } };
    const deskId = await legeDeskAn(app, a);

    const post = await app.inject({
      method: 'POST', url: `/api/v1/desks/${deskId}/members`, headers: a.authHeaders,
      payload: { username: 'nutzer-c', rolle: 'Kommentator' },
    });
    expect(post.statusCode).toBe(201);

    const zeilenC = await inbox(app, cNutzer);
    expect(zeilenC).toHaveLength(1);
    expect(zeilenC[0].art).toBe('geteilt');
    expect(zeilenC[0].payload).toMatchObject({ deskId, deskName: 'Akte Notif', rolle: 'Kommentator', vonName: 'nutzer-a' });

    // PUT (Rollenwechsel) -> keine weitere Zeile.
    await app.inject({
      method: 'PUT', url: `/api/v1/desks/${deskId}/members/${c.userId}`, headers: a.authHeaders,
      payload: { rolle: 'Bearbeiter' },
    });
    expect(await inbox(app, cNutzer)).toHaveLength(1);

    // DELETE (Entzug) -> keine weitere Zeile.
    await app.inject({ method: 'DELETE', url: `/api/v1/desks/${deskId}/members/${c.userId}`, headers: a.authHeaders });
    expect(await inbox(app, cNutzer)).toHaveLength(1);
  });

  it('Zuweisungs-Dedupe: zweimal derselbe assignee ohne Zwischenänderung erzeugt keine zweite Zeile', async () => {
    const { app, db, a, b } = await createTestAppMitZweiNutzern();
    const deskId = await legeDeskAn(app, a);
    erteileRolle(db, deskId, b.userId, 'Bearbeiter');
    await legeAufgabeAn(app, a, deskId, 't-dedupe');

    await kommando(app, a, deskId, { type: 'setTaskAssignee', payload: { id: 't-dedupe', assignee: 'nutzer-b' } });
    await kommando(app, a, deskId, { type: 'setTaskAssignee', payload: { id: 't-dedupe', assignee: 'nutzer-b' } });

    expect(await inbox(app, b)).toHaveLength(1);
  });

  it('Nach jedem Schreiben feuert das inhaltsfreie Signal (genau ein Schlüssel — Regressionssicherung 13-01)', async () => {
    const { app, db, a, b } = await createTestAppMitZweiNutzern();
    const deskId = await legeDeskAn(app, a);
    erteileRolle(db, deskId, b.userId, 'Bearbeiter');
    await legeAufgabeAn(app, a, deskId, 't-signal');

    const gesendet: unknown[] = [];
    const sockel = { send: (data: string) => { gesendet.push(JSON.parse(data) as unknown); } };
    register(deskId, sockel, b.userId, 'Bearbeiter');
    try {
      await kommando(app, a, deskId, { type: 'setTaskAssignee', payload: { id: 't-signal', assignee: 'nutzer-b' } });
    } finally {
      unregister(deskId, sockel);
    }

    const signale = gesendet.filter(
      (m) => m !== null && typeof m === 'object' && (m as { event?: unknown }).event === 'benachrichtigungenGeaendert',
    );
    expect(signale).toHaveLength(1);
    expect(Object.keys(signale[0] as object)).toEqual(['event']);
  });
});

/**
 * 13-04 Task 2: Sync-Auslöser (ersetzte annotierte Dokumente — A5, verlorene Quellen —
 * REF-01). Der j-lawyer-Abgleich (app.ts::syncCaseDesk) ist der EINZIGE Produzent dieser
 * beiden Zeilenarten (Transitions-gesteuert, kein Zustands-Diff im Nachhinein); der
 * Standalone-Modus (kein jlawyerUrl) bleibt strukturell lautlos — es gibt dort keinen
 * Abgleich, also keine Transitionen.
 */
describe('13-04 Task 2: Sync-Auslöser (ersetzt/quelle, A5-Lärmbremse)', () => {
  let fake: FakeJLawyer;
  beforeAll(async () => { fake = await startFakeJLawyer(); });
  afterAll(() => fake.stop());

  interface JlNutzer { userId: string; authHeaders: { authorization: string } }

  /** Zwei unterschiedliche j-lawyer-Konten gegen dieselbe App/DB (FAKE_JLAWYER_USER_B —
   *  Präzedenz jlawyer.test.ts-Kopfkommentar). */
  async function jlAppMitZweiNutzern(): Promise<{ app: FastifyInstance; db: Db; a: JlNutzer; b: JlNutzer }> {
    const db = openDb(':memory:');
    const dataDir = mkdtempSync(join(tmpdir(), 'dd-jl-notif-'));
    const app = await buildApp({ db, dataDir, jlawyerUrl: fake.url });
    const aLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'anwalt', password: 'kanzlei123' } });
    const bLogin = await app.inject({
      method: 'POST', url: '/api/v1/auth/login',
      payload: { username: FAKE_JLAWYER_USER_B.username, password: FAKE_JLAWYER_USER_B.password },
    });
    const aToken = (aLogin.json() as { token: string }).token;
    const bToken = (bLogin.json() as { token: string }).token;
    const aUserId = (db.prepare('SELECT id FROM users WHERE username = ?').get('anwalt') as { id: string }).id;
    const bUserId = (db.prepare('SELECT id FROM users WHERE username = ?').get(FAKE_JLAWYER_USER_B.username) as { id: string }).id;
    return {
      app, db,
      a: { userId: aUserId, authHeaders: { authorization: `Bearer ${aToken}` } },
      b: { userId: bUserId, authHeaders: { authorization: `Bearer ${bToken}` } },
    };
  }

  async function jlInbox(app: FastifyInstance, nutzer: JlNutzer): Promise<InboxZeile[]> {
    const res = await app.inject({ method: 'GET', url: '/api/v1/benachrichtigungen', headers: nutzer.authHeaders });
    expect(res.statusCode).toBe(200);
    return (res.json() as { benachrichtigungen: InboxZeile[] }).benachrichtigungen;
  }

  it('sourceReplacedAt-Transition an einem Dokument MIT Annotation erzeugt „ersetzt"-Zeilen an alle Sichtberechtigten (inklusive des Auslösers)', async () => {
    const { app, db, a, b } = await jlAppMitZweiNutzern();
    fake.documents.set('akte-notif-ersetzt', [
      { id: 'jdoc-ne-1', caseId: 'akte-notif-ersetzt', name: 'Vertrag.pdf', changeDate: 1751300000000, size: 10, bytes: Buffer.from('%PDF-e') },
    ]);
    const r1 = await app.inject({ method: 'GET', url: '/api/v1/cases/akte-notif-ersetzt/desk', headers: a.authHeaders });
    const karte = r1.json().state.docs[0];
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run('akte-notif-ersetzt', b.userId, 'Bearbeiter');

    // Annotation auf der Karte (Mark) — sonst greift die A5-Lärmbremse.
    await app.inject({
      method: 'POST', url: '/api/v1/desks/akte-notif-ersetzt/commands', headers: a.authHeaders,
      payload: { type: 'addMark', payload: { mark: { id: 'mark-1', docId: karte.id, page: 1, kind: 'redact', rect: { x: 0, y: 0, w: 10, h: 10 } } } },
    });

    fake.documents.get('akte-notif-ersetzt')![0].changeDate = 1751300099999; // neue Fassung -> "ersetzt"-Transition
    await app.inject({ method: 'GET', url: '/api/v1/cases/akte-notif-ersetzt/desk', headers: a.authHeaders });

    const zeilenB = await jlInbox(app, b);
    expect(zeilenB.some((z) => z.art === 'ersetzt' && z.payload.dokumentId === karte.id)).toBe(true);
    // Der Auslöser des Abgleichs bekommt die Zeile ebenfalls (die Änderung kommt von außen).
    const zeilenA = await jlInbox(app, a);
    expect(zeilenA.some((z) => z.art === 'ersetzt' && z.payload.dokumentId === karte.id)).toBe(true);
  });

  it('dieselbe Transition an einem Dokument OHNE Annotation erzeugt KEINE Zeile (A5-Lärmbremse)', async () => {
    const { app, db, a, b } = await jlAppMitZweiNutzern();
    fake.documents.set('akte-notif-unannotiert', [
      { id: 'jdoc-nu-1', caseId: 'akte-notif-unannotiert', name: 'Schreiben.pdf', changeDate: 1751400000000, size: 10, bytes: Buffer.from('%PDF-u') },
    ]);
    await app.inject({ method: 'GET', url: '/api/v1/cases/akte-notif-unannotiert/desk', headers: a.authHeaders });
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run('akte-notif-unannotiert', b.userId, 'Bearbeiter');

    fake.documents.get('akte-notif-unannotiert')![0].changeDate = 1751400099999;
    await app.inject({ method: 'GET', url: '/api/v1/cases/akte-notif-unannotiert/desk', headers: a.authHeaders });

    const zeilenB = await jlInbox(app, b);
    expect(zeilenB.filter((z) => z.art === 'ersetzt')).toHaveLength(0);
  });

  it('Zeile fehlt für Mitglieder ohne Sichtrecht auf das Dokument (Privat-Ebene, fail-closed)', async () => {
    const { app, db, a, b } = await jlAppMitZweiNutzern();
    fake.documents.set('akte-notif-privat', [
      { id: 'jdoc-np-1', caseId: 'akte-notif-privat', name: 'Intern.pdf', changeDate: 1751500000000, size: 10, bytes: Buffer.from('%PDF-p') },
    ]);
    const r1 = await app.inject({ method: 'GET', url: '/api/v1/cases/akte-notif-privat/desk', headers: a.authHeaders });
    const karte = r1.json().state.docs[0];
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run('akte-notif-privat', b.userId, 'Bearbeiter');

    await app.inject({
      method: 'POST', url: '/api/v1/desks/akte-notif-privat/commands', headers: a.authHeaders,
      payload: { type: 'addMark', payload: { mark: { id: 'mark-p1', docId: karte.id, page: 1, kind: 'redact', rect: { x: 0, y: 0, w: 10, h: 10 } } } },
    });
    await app.inject({
      method: 'POST', url: '/api/v1/desks/akte-notif-privat/commands', headers: a.authHeaders,
      payload: { type: 'changeLayerId', payload: { objectId: karte.id, layerId: 'privat' } },
    });

    fake.documents.get('akte-notif-privat')![0].changeDate = 1751500099999;
    await app.inject({ method: 'GET', url: '/api/v1/cases/akte-notif-privat/desk', headers: a.authHeaders });

    const zeilenB = await jlInbox(app, b);
    expect(zeilenB.filter((z) => z.art === 'ersetzt')).toHaveLength(0);
  });

  it('sourceGone-Transition erzeugt „quelle"-Zeilen mit derselben Sichtprüfung', async () => {
    const { app, db, a, b } = await jlAppMitZweiNutzern();
    fake.documents.set('akte-notif-quelle', [
      { id: 'jdoc-nq-1', caseId: 'akte-notif-quelle', name: 'Original.pdf', changeDate: 1751600000000, size: 10, bytes: Buffer.from('%PDF-q') },
    ]);
    const r1 = await app.inject({ method: 'GET', url: '/api/v1/cases/akte-notif-quelle/desk', headers: a.authHeaders });
    const karte = r1.json().state.docs[0];
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run('akte-notif-quelle', b.userId, 'Bearbeiter');

    fake.documents.get('akte-notif-quelle')!.pop(); // in j-lawyer "gelöscht"
    await app.inject({ method: 'GET', url: '/api/v1/cases/akte-notif-quelle/desk', headers: a.authHeaders });

    const zeilenB = await jlInbox(app, b);
    expect(zeilenB.some((z) => z.art === 'quelle' && z.payload.dokumentId === karte.id)).toBe(true);
  });

  it('Wiederholter Abgleich ohne neue Transition erzeugt keine weiteren Zeilen', async () => {
    const { app, db, a, b } = await jlAppMitZweiNutzern();
    fake.documents.set('akte-notif-stabil', [
      { id: 'jdoc-ns-1', caseId: 'akte-notif-stabil', name: 'Vertrag.pdf', changeDate: 1751700000000, size: 10, bytes: Buffer.from('%PDF-s') },
    ]);
    const r1 = await app.inject({ method: 'GET', url: '/api/v1/cases/akte-notif-stabil/desk', headers: a.authHeaders });
    const karte = r1.json().state.docs[0];
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run('akte-notif-stabil', b.userId, 'Bearbeiter');
    await app.inject({
      method: 'POST', url: '/api/v1/desks/akte-notif-stabil/commands', headers: a.authHeaders,
      payload: { type: 'addMark', payload: { mark: { id: 'mark-s1', docId: karte.id, page: 1, kind: 'redact', rect: { x: 0, y: 0, w: 10, h: 10 } } } },
    });
    fake.documents.get('akte-notif-stabil')![0].changeDate = 1751700099999;
    await app.inject({ method: 'GET', url: '/api/v1/cases/akte-notif-stabil/desk', headers: a.authHeaders });

    const nachErstemAbgleich = await jlInbox(app, b);
    expect(nachErstemAbgleich.filter((z) => z.art === 'ersetzt')).toHaveLength(1);

    // Zweiter Abgleich ohne weitere Änderung -> keine weitere Zeile (changed bleibt false).
    await app.inject({ method: 'GET', url: '/api/v1/cases/akte-notif-stabil/desk', headers: a.authHeaders });
    const nachZweitemAbgleich = await jlInbox(app, b);
    expect(nachZweitemAbgleich.filter((z) => z.art === 'ersetzt')).toHaveLength(1);
  });
});
