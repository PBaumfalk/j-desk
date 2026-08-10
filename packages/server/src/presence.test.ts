import { describe, it, expect } from 'vitest';
import WsClient from 'ws';
import type { DesktopState } from '@j-desk/core';
import { createTestAppMitZweiNutzern } from './testUtils';
import { createUser, login } from './auth';
import { storeFile } from './files';
import {
  registerPresence, unregisterPresence, setzeBearbeitung, loeseBearbeitung, praesenzRoster, LOCK_TTL_MS,
  aktualisierePresenzRolle,
} from './presence';

const pdf = Buffer.from('%PDF-1.4\ninhalt');

interface PraesenzNachricht {
  typ: string;
  personen: { userId: string; name: string; rolle: string; objektId?: string }[];
}

/** Wartet auf die erste Nachricht eines Sockets, die `praedikat` erfüllt — robust gegenüber
 *  mehreren Zwischen-Rostern (Connect-Reihenfolge zweier gleichzeitig verbindender Sockets ist
 *  nicht deterministisch, jeder Connect/Disconnect löst einen eigenen Rundruf aus). */
function warteAufNachricht(ws: WsClient, praedikat: (msg: PraesenzNachricht) => boolean): Promise<PraesenzNachricht> {
  return new Promise((resolve) => {
    const handler = (data: WsClient.RawData) => {
      const msg = JSON.parse(data.toString()) as PraesenzNachricht;
      if (praedikat(msg)) {
        ws.off('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
  });
}

/**
 * Task 1 (Durchstich, COLLAB-01/COLLAB-02): ein Socket signalisiert „bearbeitet", ein zweiter
 * empfängt den Präsenz-Roster — durch die echte Fastify-App, kein isolierter Registry-Test.
 */
describe('presence.ts: Präsenz-/Soft-Lock-Rückkanal', () => {
  it('Socket A signalisiert „bearbeitet", Socket B empfängt einen Präsenz-Roster mit A und dieser objektId', async () => {
    const { app, db, dataDir, a, b } = await createTestAppMitZweiNutzern();
    await app.listen({ port: 0 });
    const { port } = app.server.address() as { port: number };

    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'D' } })
    ).json();
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(desk.id, b.userId, 'Bearbeiter');
    const meta = storeFile(db, dataDir, pdf, 'a.pdf');
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: a.authHeaders,
      payload: { type: 'addDoc', payload: { fileId: meta.id, name: 'a.pdf', position: { x: 1, y: 2 }, id: 'doc-a' } },
    });

    const { ticket: ticketA } = (
      await app.inject({ method: 'POST', url: '/api/v1/ws-ticket', headers: a.authHeaders })
    ).json();
    const { ticket: ticketB } = (
      await app.inject({ method: 'POST', url: '/api/v1/ws-ticket', headers: b.authHeaders })
    ).json();
    const wsA = new WsClient(`ws://127.0.0.1:${port}/api/v1/desks/${desk.id}/ws?ticket=${ticketA}`);
    const wsB = new WsClient(`ws://127.0.0.1:${port}/api/v1/desks/${desk.id}/ws?ticket=${ticketB}`);
    await Promise.all([
      new Promise((resolve, reject) => { wsA.on('open', resolve); wsA.on('error', reject); }),
      new Promise((resolve, reject) => { wsB.on('open', resolve); wsB.on('error', reject); }),
    ]);

    const rosterMitBearbeitung = warteAufNachricht(
      wsB,
      (msg) => msg.typ === 'praesenz' && msg.personen.some((p) => p.userId === a.userId && p.objektId === 'doc-a'),
    );

    wsA.send(JSON.stringify({ typ: 'bearbeitet', objektId: 'doc-a' }));

    const msg = await rosterMitBearbeitung;
    const eintragA = msg.personen.find((p) => p.userId === a.userId);
    expect(eintragA?.objektId).toBe('doc-a');

    wsA.close();
    wsB.close();
    await app.close();
  });
});

/**
 * WR-02 (Iteration 2): Rollenänderung über die Mitglieder-Routen aktualisiert die
 * Präsenz-Registry, aber ohne einen erneuten `sendePraesenz()`-Rundruf sah ein Beobachter
 * (Nutzer C) das gelöschte `objektId`-Signal von A erst beim nächsten Connect/Disconnect statt
 * sofort. Reproduziert den vollen HTTP-Route-plus-Broadcast-Pfad (kein isolierter Registry-Test).
 */
describe('WR-02: Rollenänderung über /members löst einen erneuten Präsenz-Rundruf aus', () => {
  it('PUT /members/:userId löscht per WS sofort das objektId-Signal des herabgestuften Nutzers bei allen anderen Sockets, ohne weiteren Connect/Disconnect', async () => {
    const { app, db, dataDir, a: owner, b: nutzerA } = await createTestAppMitZweiNutzern();
    const cUserId = await createUser(db, 'nutzer-c', 'test-passwort');
    const cToken = (await login(db, 'nutzer-c', 'test-passwort'))!;
    const nutzerC = { userId: cUserId, authHeaders: { authorization: `Bearer ${cToken}` } };

    await app.listen({ port: 0 });
    const { port } = app.server.address() as { port: number };

    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: owner.authHeaders, payload: { name: 'D' } })
    ).json();
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(desk.id, nutzerA.userId, 'Bearbeiter');
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(desk.id, nutzerC.userId, 'Bearbeiter');
    const meta = storeFile(db, dataDir, pdf, 'a.pdf');
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: owner.authHeaders,
      payload: { type: 'addDoc', payload: { fileId: meta.id, name: 'a.pdf', position: { x: 1, y: 2 }, id: 'doc-x' } },
    });

    const { ticket: ticketA } = (
      await app.inject({ method: 'POST', url: '/api/v1/ws-ticket', headers: nutzerA.authHeaders })
    ).json();
    const { ticket: ticketC } = (
      await app.inject({ method: 'POST', url: '/api/v1/ws-ticket', headers: nutzerC.authHeaders })
    ).json();
    const wsA = new WsClient(`ws://127.0.0.1:${port}/api/v1/desks/${desk.id}/ws?ticket=${ticketA}`);
    const wsC = new WsClient(`ws://127.0.0.1:${port}/api/v1/desks/${desk.id}/ws?ticket=${ticketC}`);
    await Promise.all([
      new Promise((resolve, reject) => { wsA.on('open', resolve); wsA.on('error', reject); }),
      new Promise((resolve, reject) => { wsC.on('open', resolve); wsC.on('error', reject); }),
    ]);

    const rosterMitBearbeitung = warteAufNachricht(
      wsC,
      (msg) => msg.typ === 'praesenz' && msg.personen.some((p) => p.userId === nutzerA.userId && p.objektId === 'doc-x'),
    );
    wsA.send(JSON.stringify({ typ: 'bearbeitet', objektId: 'doc-x' }));
    await rosterMitBearbeitung;

    const rosterOhneSignal = warteAufNachricht(
      wsC,
      (msg) => msg.typ === 'praesenz' && msg.personen.some((p) => p.userId === nutzerA.userId && p.objektId === undefined),
    );
    const put = await app.inject({
      method: 'PUT', url: `/api/v1/desks/${desk.id}/members/${nutzerA.userId}`, headers: owner.authHeaders,
      payload: { rolle: 'Nur-Lesen' },
    });
    expect(put.statusCode).toBe(200);

    const msg = await rosterOhneSignal;
    const eintragA = msg.personen.find((p) => p.userId === nutzerA.userId);
    expect(eintragA?.objektId).toBeUndefined();

    wsA.close();
    wsC.close();
    await app.close();
  });
});

/** Minimaler Fake-Socket für Registry-Unit-Tests — `send` wird nie ausgewertet, `presence.ts`
 *  ruft ihn hier nie auf (nur `praesenzRoster()` selbst wird getestet, nicht `sendePraesenz()`). */
function fakeSocket(): { send(data: string): void } {
  return { send: () => {} };
}

/** Objekt ohne eigene layerId liegt implizit auf 'kanzlei' — echte Sichtbarkeitsprüfung über
 *  `istObjektSichtbarFuer` statt eines trivialen Sonderfalls: layerId wird hier immer explizit
 *  gesetzt. */
function stateMitNotiz(id: string, layerId: string | undefined, layers: DesktopState['layers']): DesktopState {
  return {
    docs: [], links: [], stacks: [],
    layers,
    notes: [{ id, kind: 'notiz', text: 'x', position: { x: 0, y: 0 }, zIndex: 1, layerId } as never],
  };
}

/**
 * Task 2 (PERM-05/T-06-01, T-06-04): Sichtbarkeitsfilter je Empfänger + Rollen-Gate fürs Senden.
 * Unit-Ebene direkt gegen die Registry, TDD-Reihenfolge: diese Tests zuerst (RED), dann die
 * Implementierung in praesenzRoster()/setzeBearbeitung() (GREEN).
 */
describe('presence.ts: Sichtbarkeitsfilter (PERM-05) und Rollen-Gate (T-06-04)', () => {
  it('Empfänger MIT Sichtrecht auf die Ebene des Objekts: objektId bleibt im Roster-Eintrag erhalten', () => {
    const desk = 'desk-sicht-kanzlei';
    const senderSocket = fakeSocket();
    registerPresence(desk, senderSocket, 'user-a', 'Frau A', 'Bearbeiter');
    setzeBearbeitung(desk, senderSocket, 'note-kanzlei');
    const state = stateMitNotiz('note-kanzlei', 'kanzlei', [{ id: 'kanzlei', typ: 'kanzlei', name: 'Kanzlei' }]);

    const roster = praesenzRoster(desk, { userId: 'user-b', rolle: 'Bearbeiter' }, state);

    expect(roster.find((p) => p.userId === 'user-a')?.objektId).toBe('note-kanzlei');
  });

  it('Empfänger OHNE Sichtrecht (fremde private Ebene): der Eintrag der Person bleibt, nur objektId fehlt', () => {
    const desk = 'desk-sicht-privat-fremd';
    const senderSocket = fakeSocket();
    registerPresence(desk, senderSocket, 'user-a', 'Frau A', 'Bearbeiter');
    setzeBearbeitung(desk, senderSocket, 'note-privat-a');
    const state = stateMitNotiz('note-privat-a', 'privat-a', [
      { id: 'privat-a', typ: 'privat', name: 'Privat', ownerUserId: 'user-a' },
    ]);

    const roster = praesenzRoster(desk, { userId: 'user-b', rolle: 'Bearbeiter' }, state);
    const eintrag = roster.find((p) => p.userId === 'user-a');

    expect(eintrag).toBeDefined();
    expect(eintrag?.objektId).toBeUndefined();
  });

  it('Objekt existiert nicht (mehr) im state: objektId wird für alle Empfänger weggelassen', () => {
    const desk = 'desk-objekt-fehlt';
    const senderSocket = fakeSocket();
    registerPresence(desk, senderSocket, 'user-a', 'Frau A', 'Bearbeiter');
    setzeBearbeitung(desk, senderSocket, 'note-geloescht');
    const state = stateMitNotiz('anderes-objekt', 'kanzlei', [{ id: 'kanzlei', typ: 'kanzlei', name: 'Kanzlei' }]);

    const roster = praesenzRoster(desk, { userId: 'user-b', rolle: 'Bearbeiter' }, state);

    expect(roster.find((p) => p.userId === 'user-a')?.objektId).toBeUndefined();
  });

  it('state ist undefined: objektId wird für alle Empfänger weggelassen (Fail-Closed)', () => {
    const desk = 'desk-state-undefined';
    const senderSocket = fakeSocket();
    registerPresence(desk, senderSocket, 'user-a', 'Frau A', 'Bearbeiter');
    setzeBearbeitung(desk, senderSocket, 'note-kanzlei');

    const roster = praesenzRoster(desk, { userId: 'user-b', rolle: 'Bearbeiter' }, undefined);

    expect(roster.find((p) => p.userId === 'user-a')?.objektId).toBeUndefined();
  });

  it('setzeBearbeitung von einem Socket mit Rolle Nur-Lesen: Eintrag bleibt ohne objektId', () => {
    const desk = 'desk-rolle-nur-lesen';
    const senderSocket = fakeSocket();
    registerPresence(desk, senderSocket, 'user-a', 'Frau A', 'Nur-Lesen');
    setzeBearbeitung(desk, senderSocket, 'note-kanzlei');
    // 06-03: der Roster wird nie über den Sender selbst geprüft (der sieht sich seit der
    // Empty-State-Änderung nie selbst) — eine zweite, unbeteiligte Person beobachtet.
    registerPresence(desk, fakeSocket(), 'user-beobachter', 'Beobachterin', 'Bearbeiter');
    const state = stateMitNotiz('note-kanzlei', 'kanzlei', [{ id: 'kanzlei', typ: 'kanzlei', name: 'Kanzlei' }]);

    const roster = praesenzRoster(desk, { userId: 'user-beobachter', rolle: 'Bearbeiter' }, state);

    expect(roster.find((p) => p.userId === 'user-a')?.objektId).toBeUndefined();
  });

  it('setzeBearbeitung von einem Socket mit Rolle externer Gast: Eintrag bleibt ohne objektId', () => {
    const desk = 'desk-rolle-gast';
    const senderSocket = fakeSocket();
    registerPresence(desk, senderSocket, 'user-a', 'Frau A', 'externer Gast');
    registerPresence(desk, fakeSocket(), 'user-beobachter', 'Beobachterin', 'Bearbeiter');
    const state = stateMitNotiz('note-kanzlei', 'kanzlei', [{ id: 'kanzlei', typ: 'kanzlei', name: 'Kanzlei' }]);
    setzeBearbeitung(desk, senderSocket, 'note-kanzlei');

    const roster = praesenzRoster(desk, { userId: 'user-beobachter', rolle: 'Bearbeiter' }, state);

    expect(roster.find((p) => p.userId === 'user-a')?.objektId).toBeUndefined();
  });

  it.each(['Eigentümer', 'Bearbeiter', 'Kommentator'] as const)(
    'setzeBearbeitung von Rolle %s: objektId wird gesetzt',
    (rolle) => {
      const desk = `desk-rolle-${rolle}`;
      const senderSocket = fakeSocket();
      registerPresence(desk, senderSocket, 'user-a', 'Frau A', rolle);
      registerPresence(desk, fakeSocket(), 'user-beobachter', 'Beobachterin', 'Bearbeiter');
      setzeBearbeitung(desk, senderSocket, 'note-kanzlei');
      const state = stateMitNotiz('note-kanzlei', 'kanzlei', [{ id: 'kanzlei', typ: 'kanzlei', name: 'Kanzlei' }]);

      const roster = praesenzRoster(desk, { userId: 'user-beobachter', rolle: 'Bearbeiter' }, state);

      expect(roster.find((p) => p.userId === 'user-a')?.objektId).toBe('note-kanzlei');
    },
  );

  // 06-03 (Deviation, Präsenz-Rosette „Empty State"): der Roster, der an einen Empfänger
  // ausgeliefert wird, darf dessen eigenen Eintrag nie enthalten — sonst zählt sich die
  // Rosette clientseitig selbst mit, sobald außer dem Betrachter niemand sonst verbunden ist.
  it('der Roster für einen Empfänger enthält NIE dessen eigenen Eintrag, andere Personen bleiben erhalten', () => {
    const desk = 'desk-kein-eigener-eintrag';
    const socketA = fakeSocket();
    const socketB = fakeSocket();
    registerPresence(desk, socketA, 'user-a', 'Frau A', 'Bearbeiter');
    registerPresence(desk, socketB, 'user-b', 'Herr B', 'Bearbeiter');

    const rosterFuerA = praesenzRoster(desk, { userId: 'user-a', rolle: 'Bearbeiter' }, undefined);

    expect(rosterFuerA.find((p) => p.userId === 'user-a')).toBeUndefined();
    expect(rosterFuerA.find((p) => p.userId === 'user-b')).toBeDefined();
  });

  it('einzige verbundene Person erhält einen leeren Roster (kein Eintrag über sich selbst)', () => {
    const desk = 'desk-nur-ich-selbst';
    const socket = fakeSocket();
    registerPresence(desk, socket, 'user-a', 'Frau A', 'Bearbeiter');

    const roster = praesenzRoster(desk, { userId: 'user-a', rolle: 'Bearbeiter' }, undefined);

    expect(roster).toEqual([]);
  });

  // CR-01 (T-06-04): ohne aktualisierePresenzRolle() bliebe die Rolle im Präsenz-Register nach
  // einem Downgrade stale und der SIGNALFAEHIGE_ROLLEN-Gate würde weiterhin gegen die alte,
  // bereits entzogene Rolle prüfen.
  it('aktualisierePresenzRolle: Downgrade unter offener Verbindung löscht ein laufendes Bearbeitungssignal sofort und sperrt weitere Signale', () => {
    const desk = 'desk-rollen-downgrade';
    const socket = fakeSocket();
    registerPresence(desk, socket, 'user-a', 'Frau A', 'Bearbeiter');
    registerPresence(desk, fakeSocket(), 'user-beobachter', 'Beobachterin', 'Bearbeiter');
    setzeBearbeitung(desk, socket, 'note-kanzlei', 1_000);
    const state = stateMitNotiz('note-kanzlei', 'kanzlei', [{ id: 'kanzlei', typ: 'kanzlei', name: 'Kanzlei' }]);

    const vorDowngrade = praesenzRoster(desk, { userId: 'user-beobachter', rolle: 'Bearbeiter' }, state, 1_000);
    expect(vorDowngrade.find((p) => p.userId === 'user-a')?.objektId).toBe('note-kanzlei');

    aktualisierePresenzRolle(desk, 'user-a', 'Nur-Lesen');

    const nachDowngrade = praesenzRoster(desk, { userId: 'user-beobachter', rolle: 'Bearbeiter' }, state, 1_000);
    expect(nachDowngrade.find((p) => p.userId === 'user-a')?.objektId).toBeUndefined();

    // Ein Downgrade-Nutzer, der (z. B. wegen einer im Client bereits laufenden Aktion) erneut
    // setzeBearbeitung aufruft, darf danach kein neues Signal mehr setzen können — der Gate
    // muss die AKTUALISIERTE, nicht die zum Verbindungszeitpunkt eingefrorene Rolle prüfen.
    setzeBearbeitung(desk, socket, 'note-kanzlei', 1_000);
    const nachErneutemVersuch = praesenzRoster(desk, { userId: 'user-beobachter', rolle: 'Bearbeiter' }, state, 1_000);
    expect(nachErneutemVersuch.find((p) => p.userId === 'user-a')?.objektId).toBeUndefined();
  });

  // CR-02: zwei Sockets desselben Nutzers (z. B. zwei Tabs) dürfen im an einen Dritten
  // ausgelieferten Roster nicht zu zwei Einträgen mit identischer userId führen — das verletzt
  // den nach userId geschlüsselten {#each} in PresenceRoster.svelte.
  it('zwei Sockets mit identischer userId liefern genau einen Roster-Eintrag für diese userId', () => {
    const desk = 'desk-mehrfachverbindung';
    const socket1 = fakeSocket();
    const socket2 = fakeSocket();
    registerPresence(desk, socket1, 'user-a', 'Frau A', 'Bearbeiter');
    registerPresence(desk, socket2, 'user-a', 'Frau A', 'Bearbeiter');
    registerPresence(desk, fakeSocket(), 'user-beobachter', 'Beobachterin', 'Bearbeiter');

    const roster = praesenzRoster(desk, { userId: 'user-beobachter', rolle: 'Bearbeiter' }, undefined);

    expect(roster.filter((p) => p.userId === 'user-a')).toHaveLength(1);
  });

  it('bei Mehrfachverbindung bevorzugt der deduplizierte Eintrag den Socket mit aktiver objektId', () => {
    const desk = 'desk-mehrfachverbindung-aktiv';
    const socketOhneSignal = fakeSocket();
    const socketMitSignal = fakeSocket();
    registerPresence(desk, socketOhneSignal, 'user-a', 'Frau A', 'Bearbeiter');
    registerPresence(desk, socketMitSignal, 'user-a', 'Frau A', 'Bearbeiter');
    registerPresence(desk, fakeSocket(), 'user-beobachter', 'Beobachterin', 'Bearbeiter');
    setzeBearbeitung(desk, socketMitSignal, 'note-kanzlei', 1_000);
    const state = stateMitNotiz('note-kanzlei', 'kanzlei', [{ id: 'kanzlei', typ: 'kanzlei', name: 'Kanzlei' }]);

    const roster = praesenzRoster(desk, { userId: 'user-beobachter', rolle: 'Bearbeiter' }, state, 1_000);
    const eintraege = roster.filter((p) => p.userId === 'user-a');

    expect(eintraege).toHaveLength(1);
    expect(eintraege[0]?.objektId).toBe('note-kanzlei');
  });
});

/**
 * Task 3 (T-06-06, Pitfall 4): Ablauf der Soft Locks per TTL — lazy ausgewertet beim Lesen,
 * unabhängig vom close-Ereignis. TDD-Reihenfolge: diese Tests zuerst (RED), dann die
 * Ablaufauswertung in praesenzRoster() (GREEN).
 */
describe('presence.ts: TTL-Ablauf der Soft Locks (T-06-06)', () => {
  const kanzleiLayers = [{ id: 'kanzlei', typ: 'kanzlei' as const, name: 'Kanzlei' }];
  const kanzleiState = (objektId: string): DesktopState => stateMitNotiz(objektId, 'kanzlei', kanzleiLayers);

  it('jetzt < sperreLaeuftAbUm: objektId ist enthalten', () => {
    const desk = 'desk-ttl-aktiv';
    const socket = fakeSocket();
    registerPresence(desk, socket, 'user-a', 'Frau A', 'Bearbeiter');
    setzeBearbeitung(desk, socket, 'note-kanzlei', 1_000);

    const roster = praesenzRoster(desk, { userId: 'user-b', rolle: 'Bearbeiter' }, kanzleiState('note-kanzlei'), 1_000 + LOCK_TTL_MS - 1);

    expect(roster.find((p) => p.userId === 'user-a')?.objektId).toBe('note-kanzlei');
  });

  it('jetzt >= sperreLaeuftAbUm: objektId fehlt, der Eintrag der Person bleibt', () => {
    const desk = 'desk-ttl-abgelaufen';
    const socket = fakeSocket();
    registerPresence(desk, socket, 'user-a', 'Frau A', 'Bearbeiter');
    setzeBearbeitung(desk, socket, 'note-kanzlei', 1_000);

    const roster = praesenzRoster(desk, { userId: 'user-b', rolle: 'Bearbeiter' }, kanzleiState('note-kanzlei'), 1_000 + LOCK_TTL_MS + 1);

    const eintrag = roster.find((p) => p.userId === 'user-a');
    expect(eintrag).toBeDefined();
    expect(eintrag?.objektId).toBeUndefined();
  });

  it('Grenzfall jetzt === sperreLaeuftAbUm gilt als abgelaufen', () => {
    const desk = 'desk-ttl-grenzfall';
    const socket = fakeSocket();
    registerPresence(desk, socket, 'user-a', 'Frau A', 'Bearbeiter');
    setzeBearbeitung(desk, socket, 'note-kanzlei', 1_000);

    const roster = praesenzRoster(desk, { userId: 'user-b', rolle: 'Bearbeiter' }, kanzleiState('note-kanzlei'), 1_000 + LOCK_TTL_MS);

    expect(roster.find((p) => p.userId === 'user-a')?.objektId).toBeUndefined();
  });

  it('erneutes setzeBearbeitung mit späterem jetzt verlängert sperreLaeuftAbUm auf jetzt + LOCK_TTL_MS', () => {
    const desk = 'desk-ttl-verlaengert';
    const socket = fakeSocket();
    registerPresence(desk, socket, 'user-a', 'Frau A', 'Bearbeiter');
    setzeBearbeitung(desk, socket, 'note-kanzlei', 1_000);
    // Ohne Erneuerung wäre die Sperre hier bereits abgelaufen (1_000 + LOCK_TTL_MS < 1_000 + LOCK_TTL_MS + 5_000).
    setzeBearbeitung(desk, socket, 'note-kanzlei', 1_000 + LOCK_TTL_MS - 1);

    const roster = praesenzRoster(
      desk, { userId: 'user-b', rolle: 'Bearbeiter' }, kanzleiState('note-kanzlei'),
      1_000 + LOCK_TTL_MS - 1 + LOCK_TTL_MS - 1,
    );

    expect(roster.find((p) => p.userId === 'user-a')?.objektId).toBe('note-kanzlei');
  });

  it('nach loeseBearbeitung fehlt objektId unabhängig von jetzt', () => {
    const desk = 'desk-ttl-geloest';
    const socket = fakeSocket();
    registerPresence(desk, socket, 'user-a', 'Frau A', 'Bearbeiter');
    setzeBearbeitung(desk, socket, 'note-kanzlei', 1_000);
    loeseBearbeitung(desk, socket);

    const roster = praesenzRoster(desk, { userId: 'user-b', rolle: 'Bearbeiter' }, kanzleiState('note-kanzlei'), 1_000);

    expect(roster.find((p) => p.userId === 'user-a')?.objektId).toBeUndefined();
  });

  it('nach unregisterPresence erscheint die Person überhaupt nicht mehr im Roster (auch ohne close-Ereignis)', () => {
    const desk = 'desk-ttl-unregistered';
    const socket = fakeSocket();
    registerPresence(desk, socket, 'user-a', 'Frau A', 'Bearbeiter');
    setzeBearbeitung(desk, socket, 'note-kanzlei', 1_000);
    // Simuliert einen Socket, dessen close-Handler nie feuerte, aber dessen Verbindung durch
    // eine andere Stelle (z. B. trenneNutzer) ausgetragen wurde.
    unregisterPresence(desk, socket);

    const roster = praesenzRoster(
      desk, { userId: 'user-b', rolle: 'Bearbeiter' }, kanzleiState('note-kanzlei'), 1_000 + LOCK_TTL_MS + 999_999,
    );

    expect(roster.find((p) => p.userId === 'user-a')).toBeUndefined();
  });
});
