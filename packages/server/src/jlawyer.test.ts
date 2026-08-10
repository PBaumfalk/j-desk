import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  validateLogin, listCases, listDocuments, getDocumentMeta, getDocumentContent, createDocument, createDueDate, JLawyerError, probeJLawyer,
} from './jlawyer';
import { startFakeJLawyer, FAKE_JLAWYER_USER_B, FAKE_CALENDAR_ID, type FakeJLawyer } from './testJLawyer';
import { startFakeConvertServer, type FakeConvertServer } from './testConvertServer';
import { buildApp } from './app';
import { openDb } from './db';
import { getRolleForNutzer } from './deskStore';
import { reservePort } from './testUtils';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let fake: FakeJLawyer;
beforeAll(async () => { fake = await startFakeJLawyer(); });
afterAll(() => fake.stop());

describe('jlawyer-Adapter', () => {
  it('validateLogin: richtige Zugangsdaten ja, falsche nein', async () => {
    expect(await validateLogin(fake.url, 'anwalt', 'kanzlei123')).toBe(true);
    expect(await validateLogin(fake.url, 'anwalt', 'falsch')).toBe(false);
  });

  it('listCases liefert id, Aktenzeichen, Rubrum und „wegen"', async () => {
    const cases = await listCases(fake.url, 'anwalt', 'kanzlei123');
    expect(cases[0]).toEqual({ id: 'akte-1', fileNumber: '00001/26', name: 'Müller ./. Schmidt', reason: 'Kaufpreisklage' });
    expect(cases).toHaveLength(2);
  });

  it('listDocuments liefert die Dokumentliste einer Akte (changeDate als Millis)', async () => {
    const docs = await listDocuments(fake.url, 'anwalt', 'kanzlei123', 'akte-1');
    expect(docs).toHaveLength(2);
    expect(docs[0]).toEqual({ id: 'jdoc-1', name: 'Klageschrift.pdf', changeDate: 1750000000000, size: expect.any(Number) });
  });

  it('getDocumentMeta liefert caseId und changeDate (Berechtigungsprüfung)', async () => {
    const meta = await getDocumentMeta(fake.url, 'anwalt', 'kanzlei123', 'jdoc-1');
    expect(meta).toMatchObject({ id: 'jdoc-1', caseId: 'akte-1', name: 'Klageschrift.pdf' });
  });

  it('getDocumentContent dekodiert Base64 zu PDF-Bytes', async () => {
    const bytes = await getDocumentContent(fake.url, 'anwalt', 'kanzlei123', 'jdoc-1');
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('createDocument legt ein Dokument an und liefert die neue ID', async () => {
    const { id } = await createDocument(fake.url, 'anwalt', 'kanzlei123', 'akte-2', 'Neu.pdf', Buffer.from('%PDF-1.4 neu'));
    expect(id).toMatch(/^jdoc-/);
    const docs = await listDocuments(fake.url, 'anwalt', 'kanzlei123', 'akte-2');
    expect(docs.some((d) => d.id === id && d.name === 'Neu.pdf')).toBe(true);
  });

  it('wirft JLawyerError, wenn j-lawyer nicht erreichbar ist', async () => {
    await expect(validateLogin('http://127.0.0.1:1/j-lawyer-io', 'a', 'b')).rejects.toThrow(JLawyerError);
  });
});

describe('JLawyerError.art — Fehlerklassen unterscheidbar', () => {
  afterEach(() => fake.forceStatus.clear());

  it('403 auf Dokumentabruf -> art "verboten", status 403 (kein Logout-auslösender 401 mehr)', async () => {
    fake.forceStatus.set('jdoc-403', 403);
    await expect(getDocumentMeta(fake.url, 'anwalt', 'kanzlei123', 'jdoc-403'))
      .rejects.toMatchObject({ art: 'verboten', status: 403 });
  });

  it('401 auf Dokumentabruf -> art "auth", status 401', async () => {
    fake.forceStatus.set('jdoc-401', 401);
    await expect(getDocumentMeta(fake.url, 'anwalt', 'kanzlei123', 'jdoc-401'))
      .rejects.toMatchObject({ art: 'auth', status: 401 });
  });

  it('404 auf Dokumentabruf -> art "fehlt", status 502', async () => {
    fake.forceStatus.set('jdoc-404', 404);
    await expect(getDocumentMeta(fake.url, 'anwalt', 'kanzlei123', 'jdoc-404'))
      .rejects.toMatchObject({ art: 'fehlt', status: 502 });
  });

  it('abgebrochene Verbindung (Timeout-Simulation ohne Wartezeit) -> art "nichtErreichbar", status 502', async () => {
    fake.forceStatus.set('jdoc-hang', 'destroy');
    await expect(getDocumentMeta(fake.url, 'anwalt', 'kanzlei123', 'jdoc-hang'))
      .rejects.toMatchObject({ art: 'nichtErreichbar', status: 502 });
  });
});

describe('createDueDate (TASK-02: Wiedervorlage in j-lawyer anlegen)', () => {
  afterEach(() => { fake.forceDueDateStatus.status = null; fake.lastDueDateBody.body = null; });

  it('sendet PUT auf .../v6/cases/duedate/create mit exakt dem entschiedenen Feldsatz und liefert die Kennung', async () => {
    const id = await createDueDate(fake.url, 'anwalt', 'kanzlei123', {
      caseId: 'akte-1', calendar: FAKE_CALENDAR_ID, summary: 'Wiedervorlage: Frist prüfen',
      description: 'Klageschrift.pdf, S. 3', assignee: 'Dr. Müller', beginDate: '2026-08-20',
    });
    expect(id).toMatch(/^dd-/);
    expect(fake.lastDueDateBody.body).toBeTruthy();
    expect(Object.keys(fake.lastDueDateBody.body!).sort()).toEqual(
      ['assignee', 'beginDate', 'calendar', 'caseId', 'description', 'reminderMinutes', 'summary', 'type'].sort(),
    );
  });

  it('type trägt den festen Wiedervorlage-Wert, reminderMinutes den festen "keine Erinnerung"-Wert', async () => {
    await createDueDate(fake.url, 'anwalt', 'kanzlei123', {
      caseId: 'akte-1', calendar: FAKE_CALENDAR_ID, summary: 'Test', beginDate: '2026-08-20',
    });
    expect(fake.lastDueDateBody.body?.type).toBe('FOLLOWUP');
    expect(fake.lastDueDateBody.body?.reminderMinutes).toBe(-1);
  });

  it('fehlender Verantwortlicher führt zum Weglassen des Feldes, nicht zu einer leeren Zeichenkette', async () => {
    await createDueDate(fake.url, 'anwalt', 'kanzlei123', {
      caseId: 'akte-1', calendar: FAKE_CALENDAR_ID, summary: 'Ohne Verantwortlichen', beginDate: '2026-08-20',
    });
    expect(fake.lastDueDateBody.body).not.toHaveProperty('assignee');
  });

  it('liefert bei fehlender Kennung in der Antwort eine leere Zeichenkette statt eines Absturzes', async () => {
    fake.forceDueDateStatus.status = 'success-no-id';
    const id = await createDueDate(fake.url, 'anwalt', 'kanzlei123', {
      caseId: 'akte-1', calendar: FAKE_CALENDAR_ID, summary: 'Test', beginDate: '2026-08-20',
    });
    expect(id).toBe('');
  });

  it('Kalenderkennung stimmt nicht -> Attrappe antwortet mit Serverfehler (art "server")', async () => {
    await expect(createDueDate(fake.url, 'anwalt', 'kanzlei123', {
      caseId: 'akte-1', calendar: 'falscher-kalender', summary: 'Test', beginDate: '2026-08-20',
    })).rejects.toMatchObject({ art: 'server', status: 502 });
  });

  it('401 -> art "auth", status 401', async () => {
    fake.forceDueDateStatus.status = 401;
    await expect(createDueDate(fake.url, 'anwalt', 'kanzlei123', {
      caseId: 'akte-1', calendar: FAKE_CALENDAR_ID, summary: 'Test', beginDate: '2026-08-20',
    })).rejects.toMatchObject({ art: 'auth', status: 401 });
  });

  it('403 -> art "verboten", status 403', async () => {
    fake.forceDueDateStatus.status = 403;
    await expect(createDueDate(fake.url, 'anwalt', 'kanzlei123', {
      caseId: 'akte-1', calendar: FAKE_CALENDAR_ID, summary: 'Test', beginDate: '2026-08-20',
    })).rejects.toMatchObject({ art: 'verboten', status: 403 });
  });

  it('404 -> art "fehlt", status 502', async () => {
    fake.forceDueDateStatus.status = 404;
    await expect(createDueDate(fake.url, 'anwalt', 'kanzlei123', {
      caseId: 'akte-1', calendar: FAKE_CALENDAR_ID, summary: 'Test', beginDate: '2026-08-20',
    })).rejects.toMatchObject({ art: 'fehlt', status: 502 });
  });

  it('500 -> art "server", status 502', async () => {
    fake.forceDueDateStatus.status = 500;
    await expect(createDueDate(fake.url, 'anwalt', 'kanzlei123', {
      caseId: 'akte-1', calendar: FAKE_CALENDAR_ID, summary: 'Test', beginDate: '2026-08-20',
    })).rejects.toMatchObject({ art: 'server', status: 502 });
  });

  it('Netzwerkfehler (Verbindungsabbruch) -> art "nichtErreichbar", status 502', async () => {
    fake.forceDueDateStatus.status = 'destroy';
    await expect(createDueDate(fake.url, 'anwalt', 'kanzlei123', {
      caseId: 'akte-1', calendar: FAKE_CALENDAR_ID, summary: 'Test', beginDate: '2026-08-20',
    })).rejects.toMatchObject({ art: 'nichtErreichbar', status: 502 });
  });

});

describe('probeJLawyer', () => {
  it('meldet ok, wenn der Server 401 verlangt (erreichbar, Anmeldung nötig)', async () => {
    const fake = await startFakeJLawyer();
    try {
      const r = await probeJLawyer(fake.url);
      expect(r.ok).toBe(true);
    } finally { fake.stop(); }
  });

  it('meldet ok:false mit Meldung bei nicht erreichbarem Server', async () => {
    const r = await probeJLawyer('http://127.0.0.1:1');
    expect(r.ok).toBe(false);
    expect(r.message.length).toBeGreaterThan(0);
  });
});

describe('App im j-lawyer-Modus', () => {
  async function jlApp() {
    const db = openDb(':memory:');
    const dataDir = mkdtempSync(join(tmpdir(), 'dd-jl-'));
    const app = await buildApp({ db, dataDir, jlawyerUrl: fake.url });
    return { app, db, dataDir };
  }

  it('needsSetup ist immer false; setup ist gesperrt', async () => {
    const { app } = await jlApp();
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/status' })).json()).toEqual({ needsSetup: false, mode: 'jlawyer', needsModeChoice: false });
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/setup', payload: { username: 'x', password: 'yyyyyyyy' } });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('Login mit j-lawyer-Konto liefert Session-Token; falsches Passwort 401', async () => {
    const { app } = await jlApp();
    const ok = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'anwalt', password: 'kanzlei123' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().token).toMatch(/^[0-9a-f]{64}$/);
    const bad = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'anwalt', password: 'nö' } });
    expect(bad.statusCode).toBe(401);
    await app.close();
  });

  it('die normale Bearer-API (z. B. Desks für den MCP) funktioniert nach j-lawyer-Login', async () => {
    const { app } = await jlApp();
    const { token } = (
      await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'anwalt', password: 'kanzlei123' } })
    ).json();
    const res = await app.inject({ method: 'GET', url: '/api/v1/desks', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
    await app.close();
  });

  it('GET /api/v1/cases reicht die Aktenliste durch', async () => {
    const { app } = await jlApp();
    const { token } = (
      await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'anwalt', password: 'kanzlei123' } })
    ).json();
    const res = await app.inject({ method: 'GET', url: '/api/v1/cases', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(2);
    expect(res.json()[0]).toEqual({ id: 'akte-1', fileNumber: '00001/26', name: 'Müller ./. Schmidt', reason: 'Kaufpreisklage' });
    await app.close();
  });

  it('jl down + zuvor geöffnete Akte in der desks-Tabelle -> GET /cases liefert 200 mit der bekannten Akte, NICHT 502', async () => {
    const localFake = await startFakeJLawyer();
    const db = openDb(':memory:');
    const dataDir = mkdtempSync(join(tmpdir(), 'dd-jl-cases-down-'));
    const app = await buildApp({ db, dataDir, jlawyerUrl: localFake.url });
    const { token } = (
      await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'anwalt', password: 'kanzlei123' } })
    ).json();
    const h = { authorization: `Bearer ${token}` };
    // Akte öffnen (legt die desks-Zeile an), BEVOR j-lawyer stirbt.
    const deskRes = await app.inject({ method: 'GET', url: '/api/v1/cases/akte-1/desk', headers: h });
    expect(deskRes.statusCode).toBe(200);

    await localFake.stop();
    const res = await app.inject({ method: 'GET', url: '/api/v1/cases', headers: h });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toContainEqual({ id: 'akte-1', name: 'akte-1', fileNumber: '', reason: '' });
    await app.close();
  });

  it('jl 403 -> GET /cases bleibt 403 (kein Fallback, kein Klardaten-Array)', async () => {
    const { app } = await jlApp();
    const { token } = (
      await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'anwalt', password: 'kanzlei123' } })
    ).json();
    const h = { authorization: `Bearer ${token}` };
    fake.forceCasesList.status = 403;
    try {
      const res = await app.inject({ method: 'GET', url: '/api/v1/cases', headers: h });
      expect(res.statusCode).toBe(403);
      expect(Array.isArray(res.json())).toBe(false);
      // Sitzung bleibt gültig (kein Logout bei 'verboten').
      fake.forceCasesList.status = null;
      const folge = await app.inject({ method: 'GET', url: '/api/v1/desks', headers: h });
      expect(folge.statusCode).toBe(200);
    } finally {
      fake.forceCasesList.status = null;
    }
    await app.close();
  });

  it('jl down + leere desks-Tabelle -> GET /cases liefert 200 mit leerem Array (kein Absturz)', async () => {
    const localFake = await startFakeJLawyer();
    const db = openDb(':memory:');
    const dataDir = mkdtempSync(join(tmpdir(), 'dd-jl-cases-down-leer-'));
    const app = await buildApp({ db, dataDir, jlawyerUrl: localFake.url });
    const { token } = (
      await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'anwalt', password: 'kanzlei123' } })
    ).json();
    const h = { authorization: `Bearer ${token}` };
    await localFake.stop();
    const res = await app.inject({ method: 'GET', url: '/api/v1/cases', headers: h });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
    await app.close();
  });

  it('nach Server-Neustart (Credentials nur im RAM) verlangt /cases eine neue Anmeldung', async () => {
    const db = openDb(':memory:');
    const dataDir = mkdtempSync(join(tmpdir(), 'dd-jl-'));
    const app1 = await buildApp({ db, dataDir, jlawyerUrl: fake.url });
    const { token } = (
      await app1.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'anwalt', password: 'kanzlei123' } })
    ).json();
    await app1.close();
    const app2 = await buildApp({ db, dataDir, jlawyerUrl: fake.url }); // gleiche DB, leerer RAM
    const res = await app2.inject({ method: 'GET', url: '/api/v1/cases', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(401);
    await app2.close();
  });

  it('auth/status nennt den Modus', async () => {
    const { app } = await jlApp();
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/status' })).json()).toEqual({ needsSetup: false, mode: 'jlawyer', needsModeChoice: false });
    await app.close();
  });

  it('GET /cases/:id/desk legt den Akten-Desk an und synchronisiert Eingangskarten', async () => {
    const { app } = await jlApp();
    const { token } = (
      await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'anwalt', password: 'kanzlei123' } })
    ).json();
    const h = { authorization: `Bearer ${token}` };
    const r1 = await app.inject({ method: 'GET', url: '/api/v1/cases/akte-1/desk', headers: h });
    expect(r1.statusCode).toBe(200);
    const s1 = r1.json();
    expect(s1.state.docs).toHaveLength(2);
    expect(s1.state.docs.map((d: { fileId: string }) => d.fileId).sort()).toEqual(['jdoc-1', 'jdoc-2']);
    // zweiter Abruf: keine Duplikate, rev unverändert (nichts zu tun)
    const r2 = await app.inject({ method: 'GET', url: '/api/v1/cases/akte-1/desk', headers: h });
    expect(r2.json().state.docs).toHaveLength(2);
    expect(r2.json().rev).toBe(s1.rev);
    await app.close();
  });

  it('extern entferntes Dokument: Karte bleibt liegen (sourceGone), Annotationen unversehrt; taucht es wieder auf, verschwindet das Flag', async () => {
    const { app } = await jlApp();
    fake.documents.set('akte-verwaisen', [
      { id: 'jdoc-verwaisen', caseId: 'akte-verwaisen', name: 'Original.pdf', changeDate: 1751000000000, size: 10, bytes: Buffer.from('%PDF-v') },
    ]);
    const { token } = (
      await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'anwalt', password: 'kanzlei123' } })
    ).json();
    const h = { authorization: `Bearer ${token}` };
    const r1 = await app.inject({ method: 'GET', url: '/api/v1/cases/akte-verwaisen/desk', headers: h });
    const karte = r1.json().state.docs[0];
    expect(karte.sourceGone).toBeUndefined();

    // Annotationen anlegen: Stroke + Stempel auf der Karte
    const strokeRes = await app.inject({
      method: 'POST', url: '/api/v1/desks/akte-verwaisen/commands', headers: h,
      payload: {
        type: 'addStroke',
        payload: { stroke: { id: 'stroke-1', docId: karte.id, page: 1, tool: 'pen', color: '#000000', width: 2, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] } },
      },
    });
    expect(strokeRes.statusCode).toBe(200);
    const stampRes = await app.inject({
      method: 'POST', url: '/api/v1/desks/akte-verwaisen/commands', headers: h,
      payload: {
        type: 'addStamp',
        payload: { stamp: { id: 'stamp-1', docId: karte.id, page: 1, x: 5, y: 5, angle: 0, text: 'Original', color: 'red', baseW: 100, baseH: 40 } },
      },
    });
    expect(stampRes.statusCode).toBe(200);

    // Dokument in j-lawyer „gelöscht"
    const docs = fake.documents.get('akte-verwaisen')!;
    const entfernt = docs.pop()!;
    const r2 = await app.inject({ method: 'GET', url: '/api/v1/cases/akte-verwaisen/desk', headers: h });
    const state2 = r2.json().state;
    expect(state2.docs).toHaveLength(1); // Karte bleibt — KEIN removeDoc mehr
    const orphaned = state2.docs[0];
    expect(orphaned.id).toBe(karte.id);
    expect(orphaned.sourceGone).toBe(true);
    expect(state2.strokes).toHaveLength(1); // Annotationen unversehrt
    expect(state2.stamps).toHaveLength(1);

    // (b) Dokument taucht in j-lawyer wieder auf -> Flag verschwindet, Annotationen bleiben
    docs.push(entfernt);
    const r3 = await app.inject({ method: 'GET', url: '/api/v1/cases/akte-verwaisen/desk', headers: h });
    const state3 = r3.json().state;
    expect(state3.docs[0].sourceGone).toBeUndefined();
    expect(state3.strokes).toHaveLength(1);
    expect(state3.stamps).toHaveLength(1);
    await app.close();
  });

  it('Fake-Name geändert -> Kartenname folgt beim nächsten Abgleich', async () => {
    const { app } = await jlApp();
    fake.documents.set('akte-umbenennen', [
      { id: 'jdoc-umbenennen', caseId: 'akte-umbenennen', name: 'Alt.pdf', changeDate: 1751100000000, size: 10, bytes: Buffer.from('%PDF-u') },
    ]);
    const { token } = (
      await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'anwalt', password: 'kanzlei123' } })
    ).json();
    const h = { authorization: `Bearer ${token}` };
    const r1 = await app.inject({ method: 'GET', url: '/api/v1/cases/akte-umbenennen/desk', headers: h });
    expect(r1.json().state.docs[0].name).toBe('Alt.pdf');

    fake.documents.get('akte-umbenennen')![0].name = 'Neu.pdf';
    const r2 = await app.inject({ method: 'GET', url: '/api/v1/cases/akte-umbenennen/desk', headers: h });
    expect(r2.json().state.docs[0].name).toBe('Neu.pdf');
    await app.close();
  });

  it('Fake-changeDate geändert -> sourceReplacedAt gesetzt + sourceChangeDate aktualisiert; zweiter Abgleich ohne weitere Änderung ist stabil (rev, sourceReplacedAt bleiben)', async () => {
    const { app } = await jlApp();
    fake.documents.set('akte-ersetzen', [
      { id: 'jdoc-ersetzen', caseId: 'akte-ersetzen', name: 'Vertrag.pdf', changeDate: 1751200000000, size: 10, bytes: Buffer.from('%PDF-e') },
    ]);
    const { token } = (
      await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'anwalt', password: 'kanzlei123' } })
    ).json();
    const h = { authorization: `Bearer ${token}` };
    const r1 = await app.inject({ method: 'GET', url: '/api/v1/cases/akte-ersetzen/desk', headers: h });
    const karte1 = r1.json().state.docs[0];
    expect(karte1.sourceChangeDate).toBe(1751200000000);
    expect(karte1.sourceReplacedAt).toBeUndefined();

    fake.documents.get('akte-ersetzen')![0].changeDate = 1751200099999; // neue Fassung hochgeladen
    const r2 = await app.inject({ method: 'GET', url: '/api/v1/cases/akte-ersetzen/desk', headers: h });
    const karte2 = r2.json().state.docs[0];
    expect(karte2.sourceChangeDate).toBe(1751200099999);
    expect(karte2.sourceReplacedAt).toEqual(expect.any(String));
    const rev2 = r2.json().rev;

    // zweiter Abgleich ohne weitere Änderung: changed-Guard hält, sourceReplacedAt bleibt stehen
    const r3 = await app.inject({ method: 'GET', url: '/api/v1/cases/akte-ersetzen/desk', headers: h });
    expect(r3.json().rev).toBe(rev2);
    expect(r3.json().state.docs[0].sourceReplacedAt).toBe(karte2.sourceReplacedAt);
    await app.close();
  });

  it('Fake-j-lawyer nicht erreichbar (Server gestoppt) -> Route liefert 200 + syncFehler + letzten Stand', async () => {
    const localFake = await startFakeJLawyer();
    const db = openDb(':memory:');
    const dataDir = mkdtempSync(join(tmpdir(), 'dd-jl-down-'));
    const app = await buildApp({ db, dataDir, jlawyerUrl: localFake.url });
    const { token } = (
      await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'anwalt', password: 'kanzlei123' } })
    ).json();
    const h = { authorization: `Bearer ${token}` };
    const r1 = await app.inject({ method: 'GET', url: '/api/v1/cases/akte-1/desk', headers: h });
    expect(r1.statusCode).toBe(200);
    const vorher = r1.json();

    await localFake.stop();
    const r2 = await app.inject({ method: 'GET', url: '/api/v1/cases/akte-1/desk', headers: h });
    expect(r2.statusCode).toBe(200);
    const body = r2.json();
    expect(body.syncFehler).toBe('j-lawyer ist derzeit nicht erreichbar — Stand vom letzten Abgleich.');
    expect(body.rev).toBe(vorher.rev);
    expect(body.state.docs).toHaveLength(vorher.state.docs.length);
    await app.close();
  });

  it('Fake-j-lawyer nie geöffnete Akte + nicht erreichbar -> 200, leerer Desk + syncFehler (Erstfall)', async () => {
    const localFake = await startFakeJLawyer();
    const db = openDb(':memory:');
    const dataDir = mkdtempSync(join(tmpdir(), 'dd-jl-down-erstfall-'));
    const app = await buildApp({ db, dataDir, jlawyerUrl: localFake.url });
    const { token } = (
      await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'anwalt', password: 'kanzlei123' } })
    ).json();
    const h = { authorization: `Bearer ${token}` };
    await localFake.stop();
    const res = await app.inject({ method: 'GET', url: '/api/v1/cases/akte-nie-geoeffnet/desk', headers: h });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.state.docs).toEqual([]);
    expect(body.syncFehler).toBe('j-lawyer ist derzeit nicht erreichbar — Stand vom letzten Abgleich.');
    // Der Fallback legt für unbekannte Case-IDs KEINE Geister-Desk-Zeile mehr an —
    // die Desk-DB-Zeile entsteht erst beim ersten erfolgreichen Abgleich.
    const row = db.prepare('SELECT id FROM desks WHERE id = ?').get('akte-nie-geoeffnet');
    expect(row).toBeUndefined();
    await app.close();
  });

  it('401 vom Fake bei listDocuments -> heutiges Verhalten bleibt (kein syncFehler, Logout-Kette)', async () => {
    const { app } = await jlApp();
    const { token } = (
      await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'anwalt', password: 'kanzlei123' } })
    ).json();
    const h = { authorization: `Bearer ${token}` };
    fake.forceListStatus.set('akte-401', 401);
    try {
      const res = await app.inject({ method: 'GET', url: '/api/v1/cases/akte-401/desk', headers: h });
      expect(res.statusCode).toBe(401);
      expect(res.json()).not.toHaveProperty('syncFehler');
      // Folge-Request mit demselben Token: Session wurde abgemeldet (heutiger Login-Kette-Pfad)
      const folge = await app.inject({ method: 'GET', url: '/api/v1/desks', headers: h });
      expect(folge.statusCode).toBe(401);
    } finally {
      fake.forceListStatus.clear();
    }
    await app.close();
  });

  it('403 vom Fake bei listDocuments -> Route antwortet 403, KEIN State im Body, Session bleibt gültig (kein 200-Fallback bei verboten)', async () => {
    const { app } = await jlApp();
    const { token } = (
      await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'anwalt', password: 'kanzlei123' } })
    ).json();
    const h = { authorization: `Bearer ${token}` };
    fake.forceListStatus.set('akte-verboten', 403);
    try {
      const res = await app.inject({ method: 'GET', url: '/api/v1/cases/akte-verboten/desk', headers: h });
      expect(res.statusCode).toBe(403);
      expect(res.json()).not.toHaveProperty('state');
      expect(res.json()).not.toHaveProperty('syncFehler');
      // Folge-Request mit demselben Token: Session bleibt gültig (kein Logout wie bei 'auth')
      const folge = await app.inject({ method: 'GET', url: '/api/v1/desks', headers: h });
      expect(folge.statusCode).toBe(200);
    } finally {
      fake.forceListStatus.clear();
    }
    await app.close();
  });

  it('Abgleich legt für Dokumente im Papierkorb keine neue Karte an', async () => {
    const { app } = await jlApp();
    // eigene Akte mit genau einem Dokument, unabhängig von den anderen Tests
    fake.documents.set('akte-korb', [
      { id: 'jdoc-korb', caseId: 'akte-korb', name: 'Einzel.pdf', changeDate: 1750000200000, size: 10, bytes: Buffer.from('%PDF-x') },
    ]);
    const { token } = (
      await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'anwalt', password: 'kanzlei123' } })
    ).json();
    const h = { authorization: `Bearer ${token}` };
    // 1. Akte öffnen -> Karte für das j-lawyer-Dokument entsteht
    const r1 = await app.inject({ method: 'GET', url: '/api/v1/cases/akte-korb/desk', headers: h });
    const karte = r1.json().state.docs[0];
    // 2. Karte in den Papierkorb legen
    const trashRes = await app.inject({
      method: 'POST', url: '/api/v1/desks/akte-korb/commands', headers: h,
      payload: { type: 'trashObject', payload: { id: karte.id, trashedAt: '2026-07-18T12:00:00.000Z' } },
    });
    expect(trashRes.statusCode).toBe(200);
    // 3. Akte erneut öffnen -> Abgleich läuft, aber es entsteht KEINE neue Karte
    const r2 = await app.inject({ method: 'GET', url: '/api/v1/cases/akte-korb/desk', headers: h });
    expect(r2.json().state.docs).toHaveLength(0);
    expect(r2.json().state.trash).toHaveLength(1);
    await app.close();
  });

  it('GET /files/:id liefert im j-lawyer-Modus den Dokumentinhalt und cached ihn', async () => {
    const { app } = await jlApp();
    const { token } = (
      await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'anwalt', password: 'kanzlei123' } })
    ).json();
    const h = { authorization: `Bearer ${token}` };
    const r1 = await app.inject({ method: 'GET', url: '/api/v1/files/jdoc-1', headers: h });
    expect(r1.statusCode).toBe(200);
    expect(r1.headers['content-type']).toContain('application/pdf');
    expect(r1.body.startsWith('%PDF-')).toBe(true);
    const contentAbrufe = () => fake.requests.filter((r) => r.includes('/document/jdoc-1/content')).length;
    const vorher = contentAbrufe();
    await app.inject({ method: 'GET', url: '/api/v1/files/jdoc-1', headers: h });
    expect(contentAbrufe()).toBe(vorher); // zweiter Abruf kommt aus dem Platten-Cache
    await app.close();
  });

  it('POST /cases/:id/documents lädt in die Akte hoch und legt die Karte erst nach Bestätigung an', async () => {
    const { app } = await jlApp();
    const { token } = (
      await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'anwalt', password: 'kanzlei123' } })
    ).json();
    const h = { authorization: `Bearer ${token}` };
    const vorher = (await app.inject({ method: 'GET', url: '/api/v1/cases/akte-2/desk', headers: h })).json().state.docs.length;
    const boundary = 'X-TEST-BOUNDARY';
    const pdf = '%PDF-1.4 hochgeladen';
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="Schriftsatz.pdf"',
      'Content-Type: application/pdf',
      '',
      pdf,
      `--${boundary}--`,
      '',
    ].join('\r\n');
    const r = await app.inject({
      method: 'POST', url: '/api/v1/cases/akte-2/documents',
      headers: { ...h, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(r.statusCode).toBe(201);
    const state = r.json().state;
    expect(state.docs).toHaveLength(vorher + 1);
    expect(state.docs.some((d: { name: string }) => d.name === 'Schriftsatz.pdf')).toBe(true);
    expect(state.docs.find((d: { name: string }) => d.name === 'Schriftsatz.pdf').kind).toBe('pdf');
    // Dokument liegt wirklich in j-lawyer
    expect(fake.documents.get('akte-2')!.some((d) => d.name === 'Schriftsatz.pdf')).toBe(true);
    await app.close();
  });

  it('extern entferntes Dokument in einem gehefteten 2er-Konvolut: Karte verwaist, Stapel bleibt gehefteter Konvolut (kein removeDoc/dissolveStack mehr im Abgleich)', async () => {
    const { app } = await jlApp();
    // eigene Akte mit genau zwei Dokumenten, unabhängig von den anderen Tests
    fake.documents.set('akte-deadlock', [
      { id: 'jdoc-dl-1', caseId: 'akte-deadlock', name: 'Erste.pdf', changeDate: 1750000300000, size: 10, bytes: Buffer.from('%PDF-a') },
      { id: 'jdoc-dl-2', caseId: 'akte-deadlock', name: 'Zweite.pdf', changeDate: 1750000400000, size: 10, bytes: Buffer.from('%PDF-b') },
    ]);
    const { token } = (
      await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'anwalt', password: 'kanzlei123' } })
    ).json();
    const h = { authorization: `Bearer ${token}` };
    // 1. Akte öffnen -> zwei Karten entstehen
    const r1 = await app.inject({ method: 'GET', url: '/api/v1/cases/akte-deadlock/desk', headers: h });
    const [karte1, karte2] = r1.json().state.docs;
    // 2. zu einem Stapel zusammenführen und heften (Konvolut)
    const stackRes = await app.inject({
      method: 'POST', url: '/api/v1/desks/akte-deadlock/commands', headers: h,
      payload: { type: 'stackDocs', payload: { draggedId: karte2.id, targetId: karte1.id, id: 'st-deadlock' } },
    });
    expect(stackRes.statusCode).toBe(200);
    const stapelRes = await app.inject({
      method: 'POST', url: '/api/v1/desks/akte-deadlock/commands', headers: h,
      payload: { type: 'stapleStack', payload: { stackId: 'st-deadlock' } },
    });
    expect(stapelRes.statusCode).toBe(200);
    expect(stapelRes.json().state.stacks[0]).toMatchObject({ id: 'st-deadlock', stapled: true });
    // 3. eines der beiden Dokumente extern (in j-lawyer) entfernen
    const docs = fake.documents.get('akte-deadlock')!;
    const entferntesDoc = docs.pop()!;
    // 4. Akte erneut öffnen -> Karte verwaist (sourceGone), bleibt aber im gehefteten Konvolut liegen —
    //    der frühere Enthäften-vor-dissolveStack-Sonderfall entfällt, weil der Abgleich kein removeDoc
    //    mehr aufruft (KEIN Zerlegen mehr nötig).
    const r2 = await app.inject({ method: 'GET', url: '/api/v1/cases/akte-deadlock/desk', headers: h });
    expect(r2.statusCode).toBe(200);
    const state2 = r2.json().state;
    expect(state2.docs).toHaveLength(2);
    expect(state2.stacks).toHaveLength(1);
    expect(state2.stacks[0]).toMatchObject({ id: 'st-deadlock', stapled: true });
    const jlIdImKonvolutEntfernt = entferntesDoc.id === 'jdoc-dl-1' ? karte1.id : karte2.id;
    expect(state2.docs.find((d: { id: string }) => d.id === jlIdImKonvolutEntfernt).sourceGone).toBe(true);
    await app.close();
  });

  it('403 vom Fake auf einer Dokument-Route -> Antwort 403 UND Session bleibt gültig (kein Logout)', async () => {
    const { app } = await jlApp();
    const { token } = (
      await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'anwalt', password: 'kanzlei123' } })
    ).json();
    const h = { authorization: `Bearer ${token}` };
    fake.forceStatus.set('jdoc-verboten', 403);
    try {
      const res = await app.inject({ method: 'GET', url: '/api/v1/files/jdoc-verboten', headers: h });
      expect(res.statusCode).toBe(403);
      // Folge-Request mit demselben Token: Session ist NICHT abgemeldet worden.
      const folge = await app.inject({ method: 'GET', url: '/api/v1/desks', headers: h });
      expect(folge.statusCode).toBe(200);
    } finally {
      fake.forceStatus.clear();
    }
    await app.close();
  });

  it('ohne jlawyerUrl existiert /api/v1/cases nicht', async () => {
    const db = openDb(':memory:');
    const dataDir = mkdtempSync(join(tmpdir(), 'dd-plain-'));
    const app = await buildApp({ db, dataDir });
    const res = await app.inject({ method: 'GET', url: '/api/v1/cases' });
    expect([401, 404]).toContain(res.statusCode); // 401 vom Auth-Hook oder 404 — jedenfalls keine Aktenliste
    await app.close();
  });

  it('Abgleich setzt kind aus dem Dateinamen (odt->convertible, jpg->image)', async () => {
    const { app } = await jlApp();
    fake.documents.set('akte-kind', [
      { id: 'jdoc-kind-odt', caseId: 'akte-kind', name: 'Bericht.odt', changeDate: 1750000500000, size: 5, bytes: Buffer.from('odt-inhalt') },
      { id: 'jdoc-kind-jpg', caseId: 'akte-kind', name: 'Foto.jpg', changeDate: 1750000600000, size: 5, bytes: Buffer.from([0xff, 0xd8, 0xff]) },
    ]);
    const { token } = (
      await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'anwalt', password: 'kanzlei123' } })
    ).json();
    const h = { authorization: `Bearer ${token}` };
    const r = await app.inject({ method: 'GET', url: '/api/v1/cases/akte-kind/desk', headers: h });
    const docs = r.json().state.docs as { fileId: string; kind: string }[];
    expect(docs.find((d) => d.fileId === 'jdoc-kind-odt')?.kind).toBe('convertible');
    expect(docs.find((d) => d.fileId === 'jdoc-kind-jpg')?.kind).toBe('image');
    await app.close();
  });

  it('Vorschau: kind pdf liefert Inhalt wie /files/:id, kind image 404', async () => {
    const { app } = await jlApp();
    const { token } = (
      await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'anwalt', password: 'kanzlei123' } })
    ).json();
    const h = { authorization: `Bearer ${token}` };

    let res = await app.inject({ method: 'GET', url: '/api/v1/files/jdoc-1/preview', headers: h });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.body.startsWith('%PDF-')).toBe(true);

    fake.documents.set('akte-img', [
      { id: 'jdoc-img-1', caseId: 'akte-img', name: 'Foto.jpg', changeDate: 1750000700000, size: 5, bytes: Buffer.from([0xff, 0xd8, 0xff]) },
    ]);
    res = await app.inject({ method: 'GET', url: '/api/v1/files/jdoc-img-1/preview', headers: h });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Keine Vorschau für diese Datei-Art' });
    await app.close();
  });

  it('Vorschau: kind convertible ohne Konverter -> 409 disabled', async () => {
    const { app } = await jlApp();
    fake.documents.set('akte-conv-disabled', [
      { id: 'jdoc-cd-1', caseId: 'akte-conv-disabled', name: 'Bericht.odt', changeDate: 1750000750000, size: 5, bytes: Buffer.from('odt-inhalt') },
    ]);
    const { token } = (
      await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'anwalt', password: 'kanzlei123' } })
    ).json();
    const h = { authorization: `Bearer ${token}` };
    const res = await app.inject({ method: 'GET', url: '/api/v1/files/jdoc-cd-1/preview', headers: h });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'Vorschau-Dienst nicht konfiguriert', reason: 'disabled' });
    await app.close();
  });

  it('Vorschau: kind convertible -> 202 -> Poll -> 200, konvertiert über Fake-DS mit jl-Ticket', async () => {
    let convertServer: FakeConvertServer | undefined;
    try {
      convertServer = await startFakeConvertServer();
      const port = await reservePort();
      const publicUrl = `http://127.0.0.1:${port}`;
      const db = openDb(':memory:');
      const dataDir = mkdtempSync(join(tmpdir(), 'dd-jl-conv-'));
      const app = await buildApp({
        db, dataDir, jlawyerUrl: fake.url,
        convert: { url: convertServer.url, jwtSecret: convertServer.secret },
        publicUrl,
      });
      await app.listen({ port });

      fake.documents.set('akte-conv', [
        { id: 'jdoc-conv-1', caseId: 'akte-conv', name: 'Bericht.odt', changeDate: 1750000800000, size: 9, bytes: Buffer.from('odt-inhalt') },
      ]);
      const cacheKey = 'jdoc-conv-1-1750000800000';
      convertServer.configure(cacheKey, { pollsUntilDone: 1 });

      const { token } = (
        await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'anwalt', password: 'kanzlei123' } })
      ).json();
      const h = { authorization: `Bearer ${token}` };
      const url = '/api/v1/files/jdoc-conv-1/preview';

      let res = await app.inject({ method: 'GET', url, headers: h });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ status: 'converting' });

      let tries = 0;
      while (tries++ < 100 && res.statusCode !== 200) {
        await sleep(20);
        res = await app.inject({ method: 'GET', url, headers: h });
        expect([202, 200]).toContain(res.statusCode);
      }
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('application/pdf');
      expect(res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
      // die Quelle wurde über ein Konverter-Ticket abgerufen (Fake-DS -> convert-source -> Fake-j-lawyer)
      expect(convertServer.fetchedSourceUrls.some((u) => u.includes('/convert-source/'))).toBe(true);

      await app.close();
    } finally {
      await convertServer?.stop();
    }
  });
});

describe('TASK-02: Aufgaben-Übergabe an j-lawyer (Handover-Route)', () => {
  afterEach(() => { fake.forceDueDateStatus.status = null; fake.lastDueDateBody.body = null; });

  // string | null statt eines optionalen Parameters mit Default: ein explizit übergebenes
  // `undefined` würde von JS-Default-Parametern sonst STILL durch FAKE_CALENDAR_ID ersetzt —
  // `null` ist deshalb das eindeutige "keine Kalender-Kennung konfigurieren"-Signal.
  async function appMitKalender(kalenderId: string | null = FAKE_CALENDAR_ID) {
    const db = openDb(':memory:');
    const dataDir = mkdtempSync(join(tmpdir(), 'dd-jl-handover-'));
    const app = await buildApp({
      db, dataDir, jlawyerUrl: fake.url,
      ...(kalenderId !== null ? { jlawyerTaskCalendarId: kalenderId } : {}),
    });
    return { app, db, dataDir };
  }

  async function anmelden(app: Awaited<ReturnType<typeof buildApp>>, creds = { username: 'anwalt', password: 'kanzlei123' }) {
    const { token } = (await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: creds })).json();
    return { authorization: `Bearer ${token}` };
  }

  async function aufgabeAnlegen(
    app: Awaited<ReturnType<typeof buildApp>>,
    h: { authorization: string },
    deskId: string,
    taskId: string,
    extra?: { dueDate?: string; assignee?: string; docRef?: { docId: string; page?: number } },
  ) {
    await app.inject({ method: 'GET', url: `/api/v1/cases/${deskId}/desk`, headers: h }); // legt den Desk an
    let res = await app.inject({
      method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers: h,
      payload: { type: 'addLegalObject', payload: { kind: 'aufgabe', text: 'Schriftsatz fertigstellen', position: { x: 0, y: 0 }, id: taskId } },
    });
    expect(res.statusCode).toBe(200);
    if (extra?.dueDate !== undefined) {
      res = await app.inject({ method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers: h, payload: { type: 'setTaskDueDate', payload: { id: taskId, dueDate: extra.dueDate } } });
      expect(res.statusCode).toBe(200);
    }
    if (extra?.assignee !== undefined) {
      res = await app.inject({ method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers: h, payload: { type: 'setTaskAssignee', payload: { id: taskId, assignee: extra.assignee } } });
      expect(res.statusCode).toBe(200);
    }
    if (extra?.docRef !== undefined) {
      res = await app.inject({ method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers: h, payload: { type: 'setTaskDocRef', payload: { id: taskId, docRef: extra.docRef } } });
      expect(res.statusCode).toBe(200);
    }
  }

  it('erfolgreiche Übergabe: liefert die j-lawyer-Kennung, setzt Status "uebergeben" + Übergabe-Provenienz', async () => {
    const { app } = await appMitKalender();
    const h = await anmelden(app);
    await aufgabeAnlegen(app, h, 'akte-1', 'task-erfolg', { dueDate: '2026-08-20', assignee: 'Herr Schmidt' });
    const res = await app.inject({ method: 'POST', url: '/api/v1/desks/akte-1/tasks/task-erfolg/handover', headers: h });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.jlDueDateId).toMatch(/^dd-/);
    const task = body.state.legalObjects.find((o: { id: string }) => o.id === 'task-erfolg');
    expect(task.status).toBe('uebergeben');
    expect(task.handedOverToJLawyer).toMatchObject({ jlDueDateId: body.jlDueDateId });
    expect(task.handedOverToJLawyer.at).toEqual(expect.any(String));
    await app.close();
  });

  it('Beschreibung enthält ausschließlich Dokumentname + Seitenzahl — kein Annotationstext eines verknüpften Dokuments', async () => {
    const { app } = await appMitKalender();
    const h = await anmelden(app);
    const desk = (await app.inject({ method: 'GET', url: '/api/v1/cases/akte-1/desk', headers: h })).json();
    const docId = desk.state.docs[0].id;
    const marker = 'GEHEIM-INTERNE-NOTIZ-9f21';
    await app.inject({
      method: 'POST', url: '/api/v1/desks/akte-1/commands', headers: h,
      payload: { type: 'addNote', payload: { id: 'n-geheim', kind: 'notiz', text: marker, position: { x: 0, y: 0 } } },
    });
    await aufgabeAnlegen(app, h, 'akte-1', 'task-desc', { dueDate: '2026-08-20', docRef: { docId, page: 3 } });
    const res = await app.inject({ method: 'POST', url: '/api/v1/desks/akte-1/tasks/task-desc/handover', headers: h });
    expect(res.statusCode).toBe(200);
    expect(fake.lastDueDateBody.body?.description).toBe(`Klageschrift.pdf, S. 3`);
    expect(JSON.stringify(fake.lastDueDateBody.body)).not.toContain(marker);
    await app.close();
  });

  it('Fehlschlag der Übergabe (falsche Kalender-Kennung) lässt den Aufgabenstatus unverändert — kein Command angewendet', async () => {
    const { app } = await appMitKalender('falscher-kalender');
    const h = await anmelden(app);
    await aufgabeAnlegen(app, h, 'akte-1', 'task-fail', { dueDate: '2026-08-20' });
    const res = await app.inject({ method: 'POST', url: '/api/v1/desks/akte-1/tasks/task-fail/handover', headers: h });
    expect(res.statusCode).toBe(502);
    const stateRes = await app.inject({ method: 'GET', url: '/api/v1/desks/akte-1/state', headers: h });
    const task = stateRes.json().state.legalObjects.find((o: { id: string }) => o.id === 'task-fail');
    expect(task.status).toBe('offen');
    expect(task.handedOverToJLawyer).toBeUndefined();
    await app.close();
  });

  it('fehlende Kalender-Kennung: 400 mit Klartexthinweis, j-lawyer wird NICHT aufgerufen', async () => {
    const { app } = await appMitKalender(null);
    const h = await anmelden(app);
    await aufgabeAnlegen(app, h, 'akte-1', 'task-nokal', { dueDate: '2026-08-20' });
    const vorher = fake.requests.length;
    const res = await app.inject({ method: 'POST', url: '/api/v1/desks/akte-1/tasks/task-nokal/handover', headers: h });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/JLAWYER_TASK_CALENDAR_ID/);
    expect(fake.requests.length).toBe(vorher);
    await app.close();
  });

  it('nicht im j-lawyer-Modus: 400 mit Klartexthinweis', async () => {
    const db = openDb(':memory:');
    const dataDir = mkdtempSync(join(tmpdir(), 'dd-standalone-handover-'));
    const app = await buildApp({ db, dataDir });
    await app.inject({ method: 'POST', url: '/api/v1/auth/setup', payload: { username: 'anwalt', password: 'passwort-123' } });
    const { token } = (
      await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'anwalt', password: 'passwort-123' } })
    ).json();
    const h = { authorization: `Bearer ${token}` };
    const deskRes = await app.inject({ method: 'POST', url: '/api/v1/desks', headers: h, payload: { name: 'Testschreibtisch' } });
    const deskId = deskRes.json().id;
    const cmd = await app.inject({
      method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers: h,
      payload: { type: 'addLegalObject', payload: { kind: 'aufgabe', text: 'x', position: { x: 0, y: 0 }, id: 'task-standalone' } },
    });
    expect(cmd.statusCode).toBe(200);
    const res = await app.inject({ method: 'POST', url: `/api/v1/desks/${deskId}/tasks/task-standalone/handover`, headers: h });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/j-lawyer-Modus/);
    await app.close();
  });

  it('Rolle ohne das Recht für gefährliche Aktionen -> 403', async () => {
    const { app, db } = await appMitKalender();
    const hA = await anmelden(app);
    await aufgabeAnlegen(app, hA, 'akte-1', 'task-403', { dueDate: '2026-08-20' });
    const hB = await anmelden(app, FAKE_JLAWYER_USER_B);
    await app.inject({ method: 'GET', url: '/api/v1/cases/akte-1/desk', headers: hB }); // B wird zunächst Bearbeiter
    const userIdB = (db.prepare('SELECT id FROM users WHERE username = ?').get(FAKE_JLAWYER_USER_B.username) as { id: string }).id;
    db.prepare('UPDATE desk_roles SET rolle = ? WHERE desk_id = ? AND user_id = ?').run('Kommentator', 'akte-1', userIdB);
    const res = await app.inject({ method: 'POST', url: '/api/v1/desks/akte-1/tasks/task-403/handover', headers: hB });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('unbekannte Objekt-Kennung -> 404', async () => {
    const { app } = await appMitKalender();
    const h = await anmelden(app);
    await app.inject({ method: 'GET', url: '/api/v1/cases/akte-1/desk', headers: h });
    const res = await app.inject({ method: 'POST', url: '/api/v1/desks/akte-1/tasks/gibt-es-nicht/handover', headers: h });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('Objekt existiert, ist aber keine Aufgabe -> 400', async () => {
    const { app } = await appMitKalender();
    const h = await anmelden(app);
    await app.inject({ method: 'GET', url: '/api/v1/cases/akte-1/desk', headers: h });
    await app.inject({
      method: 'POST', url: '/api/v1/desks/akte-1/commands', headers: h,
      payload: { type: 'addLegalObject', payload: { kind: 'tatsache', text: 'x', position: { x: 0, y: 0 }, id: 'lo-nichtaufgabe' } },
    });
    const res = await app.inject({ method: 'POST', url: '/api/v1/desks/akte-1/tasks/lo-nichtaufgabe/handover', headers: h });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('WR-03: zweite Übergabe derselben Aufgabe -> 409, keine zweite Wiedervorlage/kein neues jlDueDateId', async () => {
    const { app } = await appMitKalender();
    const h = await anmelden(app);
    await aufgabeAnlegen(app, h, 'akte-1', 'task-doppelt', { dueDate: '2026-08-20' });
    const erste = await app.inject({ method: 'POST', url: '/api/v1/desks/akte-1/tasks/task-doppelt/handover', headers: h });
    expect(erste.statusCode).toBe(200);
    const jlDueDateId = erste.json().jlDueDateId;
    const anzahlAnfragenNachErsterUebergabe = fake.requests.length;

    const zweite = await app.inject({ method: 'POST', url: '/api/v1/desks/akte-1/tasks/task-doppelt/handover', headers: h });
    expect(zweite.statusCode).toBe(409);
    // j-lawyer wurde für die zweite Übergabe gar nicht erst kontaktiert (Guard greift vor createDueDate).
    expect(fake.requests.length).toBe(anzahlAnfragenNachErsterUebergabe);

    const stateRes = await app.inject({ method: 'GET', url: '/api/v1/desks/akte-1/state', headers: h });
    const task = stateRes.json().state.legalObjects.find((o: { id: string }) => o.id === 'task-doppelt');
    expect(task.handedOverToJLawyer.jlDueDateId).toBe(jlDueDateId); // unveraendert, keine still ueberschriebene Provenienz
    await app.close();
  });

  it('WR-05: zwei nahezu gleichzeitige Übergabe-Anfragen für dieselbe Aufgabe -> genau ein createDueDate-Aufruf', async () => {
    const { app } = await appMitKalender();
    const h = await anmelden(app);
    await aufgabeAnlegen(app, h, 'akte-1', 'task-rennen', { dueDate: '2026-08-20' });
    const duedateAufrufeVorher = fake.requests.filter((r) => r.includes('/duedate/create')).length;

    // Beide Anfragen OHNE await gegeneinander starten (nicht sequentiell) — genau das Szenario
    // aus WR-05: zwei Anfragen, die den handedOverToJLawyer-Zustand lesen, BEVOR eine von beiden
    // ihren createDueDate-await abgeschlossen hat (Doppelklick/zwei Tabs).
    const anfrage = () => app.inject({ method: 'POST', url: '/api/v1/desks/akte-1/tasks/task-rennen/handover', headers: h });
    const [erste, zweite] = await Promise.all([anfrage(), anfrage()]);

    const statusCodes = [erste.statusCode, zweite.statusCode].sort((a, b) => a - b);
    expect(statusCodes).toEqual([200, 409]); // genau eine erfolgreich, die andere von der In-Flight-Sperre abgewiesen
    // Der eigentliche Kern des Fixes: j-lawyer wurde für den zweiten, überlappenden Aufruf NICHT
    // kontaktiert — vor dem WR-05-Fix hätten hier beide Anfragen createDueDate erreicht.
    const duedateAufrufeNachher = fake.requests.filter((r) => r.includes('/duedate/create')).length;
    expect(duedateAufrufeNachher - duedateAufrufeVorher).toBe(1);

    const stateRes = await app.inject({ method: 'GET', url: '/api/v1/desks/akte-1/state', headers: h });
    const task = stateRes.json().state.legalObjects.find((o: { id: string }) => o.id === 'task-rennen');
    expect(task.handedOverToJLawyer).toBeDefined(); // keine still ueberschriebene Provenienz durch einen zweiten Schreibvorgang
    await app.close();
  });

  it('j-lawyer nicht erreichbar: etablierter Fehlertext, kein roher Ausnahmetext', async () => {
    const { app } = await appMitKalender();
    const h = await anmelden(app);
    await aufgabeAnlegen(app, h, 'akte-1', 'task-down', { dueDate: '2026-08-20' });
    fake.forceDueDateStatus.status = 'destroy';
    const res = await app.inject({ method: 'POST', url: '/api/v1/desks/akte-1/tasks/task-down/handover', headers: h });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('j-lawyer ist nicht erreichbar');
    await app.close();
  });
});

describe('Ausfall-Fallback ist fail-closed (kein Cross-User-Leck)', () => {
  // Ohne j-lawyer können wir Rechte nicht prüfen — der Fallback darf deshalb nur Akten
  // liefern, die der ANFRAGENDE Nutzer selbst geöffnet hat (owner_id === req.userId).
  async function zweiNutzerMitGeoeffneterAkte(dirTag: string) {
    const localFake = await startFakeJLawyer();
    const db = openDb(':memory:');
    const dataDir = mkdtempSync(join(tmpdir(), `dd-jl-failclosed-${dirTag}-`));
    const app = await buildApp({ db, dataDir, jlawyerUrl: localFake.url });
    const { token: tokenA } = (
      await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'anwalt', password: 'kanzlei123' } })
    ).json();
    const { token: tokenB } = (
      await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: FAKE_JLAWYER_USER_B })
    ).json();
    const hA = { authorization: `Bearer ${tokenA}` };
    const hB = { authorization: `Bearer ${tokenB}` };
    // Nutzer A öffnet akte-1 zuerst -> desks.owner_id gehört A, BEVOR jl stirbt.
    const opened = await app.inject({ method: 'GET', url: '/api/v1/cases/akte-1/desk', headers: hA });
    expect(opened.statusCode).toBe(200);
    await localFake.stop();
    return { app, hA, hB };
  }

  it('jl down: GET /cases als B (fremde Akte nicht geöffnet) -> 200 mit LEEREM Array; als A -> enthält akte-1', async () => {
    const { app, hA, hB } = await zweiNutzerMitGeoeffneterAkte('cases');
    const resB = await app.inject({ method: 'GET', url: '/api/v1/cases', headers: hB });
    expect(resB.statusCode).toBe(200);
    expect(resB.json()).toEqual([]);

    const resA = await app.inject({ method: 'GET', url: '/api/v1/cases', headers: hA });
    expect(resA.statusCode).toBe(200);
    expect(resA.json()).toContainEqual({ id: 'akte-1', name: 'akte-1', fileNumber: '', reason: '' });
    await app.close();
  });

  it('jl down: GET /cases/akte-1/desk als B (fremde, existierende Akte) -> 403, KEIN State im Body, Session bleibt gültig', async () => {
    const { app, hB } = await zweiNutzerMitGeoeffneterAkte('desk-fremd');
    const res = await app.inject({ method: 'GET', url: '/api/v1/cases/akte-1/desk', headers: hB });
    expect(res.statusCode).toBe(403);
    expect(res.json()).not.toHaveProperty('state');
    expect(res.json()).not.toHaveProperty('syncFehler');
    // Session von B bleibt gültig (kein Logout — 'verboten' zerstört keine Sitzung).
    const folge = await app.inject({ method: 'GET', url: '/api/v1/desks', headers: hB });
    expect(folge.statusCode).toBe(200);
    await app.close();
  });

  it('jl down: GET /cases/akte-1/desk als A (eigene Akte) -> 200 + State + syncFehler (Bestandsverhalten bleibt grün)', async () => {
    const { app, hA } = await zweiNutzerMitGeoeffneterAkte('desk-eigen');
    const res = await app.inject({ method: 'GET', url: '/api/v1/cases/akte-1/desk', headers: hA });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.syncFehler).toBe('j-lawyer ist derzeit nicht erreichbar — Stand vom letzten Abgleich.');
    expect(body.state.docs.length).toBeGreaterThan(0);
    await app.close();
  });
});

describe('WR-02: Zweitnutzer einer Akte im j-lawyer-Modus (desk_roles aus jl-Berechtigung)', () => {
  it('bekommt beim Öffnen die Bearbeiter-Rolle (NICHT Eigentümer) und kann state/commands nutzen; Löschen bleibt 403', async () => {
    const localFake = await startFakeJLawyer();
    const db = openDb(':memory:');
    const dataDir = mkdtempSync(join(tmpdir(), 'dd-jl-wr02-'));
    const app = await buildApp({ db, dataDir, jlawyerUrl: localFake.url });
    const { token: tokenA } = (
      await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'anwalt', password: 'kanzlei123' } })
    ).json();
    const { token: tokenB } = (
      await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: FAKE_JLAWYER_USER_B })
    ).json();
    const hA = { authorization: `Bearer ${tokenA}` };
    const hB = { authorization: `Bearer ${tokenB}` };

    // A öffnet die Akte zuerst, B danach — beide jl-seitig berechtigt.
    expect((await app.inject({ method: 'GET', url: '/api/v1/cases/akte-1/desk', headers: hA })).statusCode).toBe(200);
    const deskB = await app.inject({ method: 'GET', url: '/api/v1/cases/akte-1/desk', headers: hB });
    expect(deskB.statusCode).toBe(200);
    expect(deskB.json().state.docs.length).toBeGreaterThan(0);

    // Rollenfestzurren: Erst-Öffner = Eigentümer, Folge-Öffner = Bearbeiter — bis zur Review
    // wurde der Folge-Öffner still zweiter 'Eigentümer' (Lösch-/Verwaltungsrecht auf fremde Akte).
    const userIdA = (db.prepare('SELECT id FROM users WHERE username = ?').get('anwalt') as { id: string }).id;
    const userIdB = (db.prepare('SELECT id FROM users WHERE username = ?').get(FAKE_JLAWYER_USER_B.username) as { id: string }).id;
    expect(getRolleForNutzer(db, 'akte-1', userIdA)).toBe('Eigentümer');
    expect(getRolleForNutzer(db, 'akte-1', userIdB)).toBe('Bearbeiter');

    // Die Guard-geschützten Pfade funktionieren für B jetzt (vorher 403 überall bzw. still Eskalation):
    expect((await app.inject({ method: 'GET', url: '/api/v1/desks/akte-1/state', headers: hB })).statusCode).toBe(200);
    const cmd = await app.inject({
      method: 'POST', url: '/api/v1/desks/akte-1/commands', headers: hB,
      payload: { type: 'addNote', payload: { id: 'n-b', kind: 'notiz', text: 'Vermerk B', position: { x: 1, y: 1 } } },
    });
    expect(cmd.statusCode).toBe(200);
    // B sieht die Akte auch in der Desk-Liste (rollenbasiert).
    expect((await app.inject({ method: 'GET', url: '/api/v1/desks', headers: hB })).json()).toContainEqual(
      expect.objectContaining({ id: 'akte-1' }),
    );
    // … aber Bearbeiter darf die Akte nicht löschen (gefährliche Aktion = Eigentümer).
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/desks/akte-1', headers: hB })).statusCode).toBe(403);

    // jl-Ausfall danach: B ist ein erwiesenermaßen berechtigtes Mitglied und bekommt den
    // zwischengespeicherten Stand (statt 403 wie ein Nutzer ganz ohne desk_roles-Zeile).
    await localFake.stop();
    const down = await app.inject({ method: 'GET', url: '/api/v1/cases/akte-1/desk', headers: hB });
    expect(down.statusCode).toBe(200);
    expect(down.json().syncFehler).toBe('j-lawyer ist derzeit nicht erreichbar — Stand vom letzten Abgleich.');
    expect(down.json().state.docs.length).toBeGreaterThan(0);
    await app.close();
  });
});

describe('WR-04: jl-Antworten liefern die ermittelte Rolle mit (Client-Gating greift)', () => {
  async function jlAppMitZweiNutzern() {
    const localFake = await startFakeJLawyer();
    const db = openDb(':memory:');
    const dataDir = mkdtempSync(join(tmpdir(), 'dd-jl-wr04-'));
    const app = await buildApp({ db, dataDir, jlawyerUrl: localFake.url });
    const { token: tokenA } = (
      await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'anwalt', password: 'kanzlei123' } })
    ).json();
    const { token: tokenB } = (
      await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: FAKE_JLAWYER_USER_B })
    ).json();
    return { app, localFake, hA: { authorization: `Bearer ${tokenA}` }, hB: { authorization: `Bearer ${tokenB}` } };
  }

  it('GET /cases/:id/desk: Erst-Öffner bekommt rolle Eigentümer, Zweitnutzer rolle Bearbeiter', async () => {
    const { app, localFake, hA, hB } = await jlAppMitZweiNutzern();
    const deskA = await app.inject({ method: 'GET', url: '/api/v1/cases/akte-1/desk', headers: hA });
    expect(deskA.statusCode).toBe(200);
    expect(deskA.json().rolle).toBe('Eigentümer');

    const deskB = await app.inject({ method: 'GET', url: '/api/v1/cases/akte-1/desk', headers: hB });
    expect(deskB.statusCode).toBe(200);
    // Bis zum Fix fehlte das Feld — der Client hielt myRolle auf null („unbekannt" =
    // fail-open) und zeigte dem jl-Bearbeiter Eigentümer-Aktionen an (Schreddern,
    // Ebenen-Verwaltung, Export-Checkboxen), die erst am Server mit 403 scheiterten.
    expect(deskB.json().rolle).toBe('Bearbeiter');
    await localFake.stop();
    await app.close();
  });

  it('POST /cases/:id/documents liefert die Rolle des Hochladenden mit; Ausfall-Fallback ebenfalls', async () => {
    const { app, localFake, hA, hB } = await jlAppMitZweiNutzern();
    await app.inject({ method: 'GET', url: '/api/v1/cases/akte-1/desk', headers: hA });
    await app.inject({ method: 'GET', url: '/api/v1/cases/akte-1/desk', headers: hB });

    const boundary = '----jlwr04';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="Neu.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
      Buffer.from('%PDF-1.4\nneu'),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const upload = await app.inject({
      method: 'POST', url: '/api/v1/cases/akte-1/documents',
      headers: { ...hB, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: body,
    });
    expect(upload.statusCode).toBe(201);
    expect(upload.json().rolle).toBe('Bearbeiter');

    // Ausfall-Fallback (jl down): die bekannte desk_roles-Rolle geht ebenfalls mit.
    await localFake.stop();
    const down = await app.inject({ method: 'GET', url: '/api/v1/cases/akte-1/desk', headers: hB });
    expect(down.statusCode).toBe(200);
    expect(down.json().rolle).toBe('Bearbeiter');
    expect(down.json().syncFehler).toBeTruthy();
    await app.close();
  });
});

describe('WR-07: jl-Auslieferungspfade projizieren den State für den anfragenden Actor (PERM-05)', () => {
  it('GET /cases/:id/desk und POST /cases/:id/documents liefern kein privates Fremdobjekt aus', async () => {
    const MARKER = 'JL-MARKER-GEHEIM-4d7c';
    const localFake = await startFakeJLawyer();
    const db = openDb(':memory:');
    const dataDir = mkdtempSync(join(tmpdir(), 'dd-jl-wr07-'));
    const app = await buildApp({ db, dataDir, jlawyerUrl: localFake.url });
    const { token: tokenA } = (
      await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'anwalt', password: 'kanzlei123' } })
    ).json();
    const { token: tokenB } = (
      await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: FAKE_JLAWYER_USER_B })
    ).json();
    const hA = { authorization: `Bearer ${tokenA}` };
    const hB = { authorization: `Bearer ${tokenB}` };

    // Beide öffnen die Akte (A = Eigentümer, B = Bearbeiter, WR-02).
    await app.inject({ method: 'GET', url: '/api/v1/cases/akte-1/desk', headers: hA });
    await app.inject({ method: 'GET', url: '/api/v1/cases/akte-1/desk', headers: hB });

    // Geheime Notiz von A über echte Commands (02-09 — derselbe Weg wie die UI): addNote mit
    // MARKER, danach changeLayerId auf die Platzhalter-id 'privat'; die Pro-Nutzer-Instanz
    // entsteht dabei produktiv im selben Command.
    const notiz = await app.inject({
      method: 'POST', url: '/api/v1/desks/akte-1/commands', headers: hA,
      payload: { type: 'addNote', payload: { id: 'n-jl-geheim', kind: 'notiz', text: MARKER, position: { x: 0, y: 0 } } },
    });
    expect(notiz.statusCode).toBe(200);
    const privat = await app.inject({
      method: 'POST', url: '/api/v1/desks/akte-1/commands', headers: hA,
      payload: { type: 'changeLayerId', payload: { objectId: 'n-jl-geheim', layerId: 'privat' } },
    });
    expect(privat.statusCode).toBe(200);

    // GET /cases/:id/desk: B bekommt die projizierte Fassung (Marker fehlt), A die volle.
    const resB = await app.inject({ method: 'GET', url: '/api/v1/cases/akte-1/desk', headers: hB });
    expect(resB.statusCode).toBe(200);
    expect(JSON.stringify(resB.json())).not.toContain(MARKER);
    const resA = await app.inject({ method: 'GET', url: '/api/v1/cases/akte-1/desk', headers: hA });
    expect(JSON.stringify(resA.json())).toContain(MARKER);

    // POST /cases/:id/documents: auch die addDoc-Antwort an B ist projiziert.
    const boundary = '----jlupload';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="Neu.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
      Buffer.from('%PDF-1.4\nneu'),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const upload = await app.inject({
      method: 'POST', url: '/api/v1/cases/akte-1/documents',
      headers: { ...hB, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: body,
    });
    expect(upload.statusCode).toBe(201);
    expect(JSON.stringify(upload.json())).not.toContain(MARKER);

    // Ausfall-Fallback (jl down): B bekommt den zwischengespeicherten Stand ebenfalls projiziert.
    await localFake.stop();
    const down = await app.inject({ method: 'GET', url: '/api/v1/cases/akte-1/desk', headers: hB });
    expect(down.statusCode).toBe(200);
    expect(JSON.stringify(down.json())).not.toContain(MARKER);
    await app.close();
  });
});
