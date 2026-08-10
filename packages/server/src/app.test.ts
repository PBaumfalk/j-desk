import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestApp, createTestAppMitZweiNutzern, reservePort } from './testUtils';
import { openDb, getSetting, type Db } from './db';
import { createUser, login } from './auth';
import { createDesk, putDeskState, getDeskState } from './deskStore';
import { buildApp, type AppOptions } from './app';
import { storeFile, fileExists } from './files';
import { buildPackage, JDESK_FORMAT_VERSION } from './jdesk';
import { startFakeConvertServer, type FakeConvertServer } from './testConvertServer';
import { startFakeJLawyer } from './testJLawyer';
import { TEXT_SNAPSHOT_MAX } from '@j-desk/core';
import { zipSync, strToU8 } from 'fflate';

const pdf = Buffer.from('%PDF-1.4\ninhalt');

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Legt einen Schreibtisch für `ownerId` an. 02-04: Desk-Routen prüfen jetzt desk_roles — der
    Besitzer MUSS der tatsächlich anfragende Nutzer sein (createTestApp().userId), sonst bekäme
    jeder Test mit `authHeaders` sofort 403 statt der erwarteten Antwort. */
function deskMitBesitzer(db: Db, name: string, ownerId: string) {
  return createDesk(db, ownerId, name);
}

/** Baut eine frische App ohne Konto (needsSetup=true) — für Setup-/Betriebsmodus-Tests. */
async function noAccountApp(extra: Partial<Omit<AppOptions, 'db' | 'dataDir'>> = {}) {
  const db = openDb(':memory:');
  const dataDir = mkdtempSync(join(tmpdir(), 'dd-setup-'));
  const app = await buildApp({ db, dataDir, ...extra });
  return { app, db, dataDir };
}

/** Baut eine Standalone-App mit echtem HTTP-Listener + konfiguriertem Konverter (für Konverter-Rundläufe). */
async function convertingApp(fake: FakeConvertServer) {
  const port = await reservePort();
  const publicUrl = `http://127.0.0.1:${port}`;
  const db = openDb(':memory:');
  const dataDir = mkdtempSync(join(tmpdir(), 'dd-prev-'));
  await createUser(db, 'test', 'test-passwort');
  const token = (await login(db, 'test', 'test-passwort'))!;
  const app = await buildApp({ db, dataDir, publicUrl, convert: { url: fake.url, jwtSecret: fake.secret } });
  await app.listen({ port });
  return { app, db, dataDir, authHeaders: { authorization: `Bearer ${token}` } };
}

describe('Auth-Routen', () => {
  it('status/setup/login-Ablauf', async () => {
    const { app: freshApp } = await (async () => {
      const { openDb } = await import('./db');
      const { buildApp } = await import('./app');
      const { mkdtempSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      return { app: await buildApp({ db: openDb(':memory:'), dataDir: mkdtempSync(join(tmpdir(), 'dd-')) }) };
    })();

    let res = await freshApp.inject({ method: 'GET', url: '/api/v1/auth/status' });
    expect(res.json()).toEqual({ needsSetup: true, mode: 'standalone', needsModeChoice: true });

    res = await freshApp.inject({
      method: 'POST', url: '/api/v1/auth/setup',
      payload: { username: 'patrick', password: 'geheim-genug' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().token).toMatch(/^[0-9a-f]{64}$/);

    res = await freshApp.inject({
      method: 'POST', url: '/api/v1/auth/setup',
      payload: { username: 'zweiter', password: 'geheim-genug' },
    });
    expect(res.statusCode).toBe(403);

    res = await freshApp.inject({
      method: 'POST', url: '/api/v1/auth/login',
      payload: { username: 'patrick', password: 'falsch-falsch' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('ohne Token: 401 auf geschützten Routen', async () => {
    const { app } = await createTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/desks' });
    expect(res.statusCode).toBe(401);
  });

  it('logout macht das Token ungültig', async () => {
    const { app, authHeaders } = await createTestApp();
    await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: authHeaders });
    const res = await app.inject({ method: 'GET', url: '/api/v1/desks', headers: authHeaders });
    expect(res.statusCode).toBe(401);
  });
});

describe('Desk-Routen', () => {
  it('CRUD und Zustand', async () => {
    const { app, authHeaders } = await createTestApp();
    let res = await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'Projekte' } });
    expect(res.statusCode).toBe(201);
    const desk = res.json();

    res = await app.inject({ method: 'GET', url: '/api/v1/desks', headers: authHeaders });
    expect(res.json()).toHaveLength(1);

    res = await app.inject({ method: 'PATCH', url: `/api/v1/desks/${desk.id}`, headers: authHeaders, payload: { name: 'Neu' } });
    expect(res.statusCode).toBe(200);

    res = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/state`, headers: authHeaders });
    // rolle (02-07): der anlegende Nutzer ist automatisch Eigentümer (02-03) — der Client
    // braucht das Feld, um Ebenen-/Rollenverwaltung rollengebunden auszublenden (PERM-02).
    expect(res.json()).toEqual({
      rev: 0,
      state: { docs: [], links: [], stacks: [], strokes: [], notes: [], cutouts: [], marks: [], stamps: [], flags: [], clips: [], trash: [], legalObjects: [], tables: [], zeitleisten: [], sitzungsmappen: [] },
      rolle: 'Eigentümer',
    });

    res = await app.inject({ method: 'DELETE', url: `/api/v1/desks/${desk.id}`, headers: authHeaders });
    expect(res.statusCode).toBe(200);
    res = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/state`, headers: authHeaders });
    expect(res.statusCode).toBe(404);
  });
});

describe('Kommandos', () => {
  it('führt gültige Kommandos aus, weist ungültige mit 400 ab', async () => {
    const { app, db, dataDir, authHeaders } = await createTestApp();
    const { storeFile } = await import('./files');
    const meta = storeFile(db, dataDir, pdf, 'a.pdf');
    const desk = (await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'D' } })).json();

    let res = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'addDoc', payload: { fileId: meta.id, name: 'a.pdf', position: { x: 1, y: 2 }, id: 'id-a' } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().rev).toBe(1);

    res = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'addDoc', payload: { fileId: 'gibtsnicht', name: 'x.pdf', position: { x: 0, y: 0 } } },
    });
    expect(res.statusCode).toBe(400); // unbekannte fileId

    res = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'kaputt', payload: {} },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('Unbekanntes Kommando');

    res = await app.inject({
      method: 'POST', url: '/api/v1/desks/gibtsnicht/commands', headers: authHeaders,
      payload: { type: 'moveDoc', payload: { id: 'id-a', position: { x: 0, y: 0 } } },
    });
    expect(res.statusCode).toBe(404);
  });

  it('PUT /state ersetzt den Zustand, validiert die Struktur', async () => {
    const { app, authHeaders } = await createTestApp();
    const desk = (await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'D' } })).json();
    let res = await app.inject({
      method: 'PUT', url: `/api/v1/desks/${desk.id}/state`, headers: authHeaders,
      payload: { docs: [], links: [], stacks: [] },
    });
    expect(res.json().rev).toBe(1);
    res = await app.inject({
      method: 'PUT', url: `/api/v1/desks/${desk.id}/state`, headers: authHeaders,
      payload: { docs: 5 },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('Sprung zur Quelle: fileSha256-Anreicherung + /files/:id/meta', () => {
  it('Standalone: addCutout ohne fileSha256 bekommt den Hash der Quelldatei (Gegenprobe: Upload-Hash)', async () => {
    const { app, db, dataDir, authHeaders } = await createTestApp();
    const meta = storeFile(db, dataDir, pdf, 'a.pdf');
    const desk = (await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'D' } })).json();
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'addDoc', payload: { fileId: meta.id, name: 'a.pdf', position: { x: 1, y: 2 }, id: 'doc-a' } },
    });
    const res = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'addCutout', payload: { docId: 'doc-a', page: 1, rect: { x: 0, y: 0, w: 10, h: 10 }, position: { x: 0, y: 0 }, id: 'cut-1' } },
    });
    expect(res.statusCode).toBe(200);
    const cutout = res.json().state.cutouts.find((c: { id: string }) => c.id === 'cut-1');
    expect(cutout.fileSha256).toBe(meta.sha256);
  });

  it('Standalone: ein vom Client gesendetes (gefälschtes) fileSha256 wird überschrieben', async () => {
    const { app, db, dataDir, authHeaders } = await createTestApp();
    const meta = storeFile(db, dataDir, pdf, 'a.pdf');
    const desk = (await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'D' } })).json();
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'addDoc', payload: { fileId: meta.id, name: 'a.pdf', position: { x: 1, y: 2 }, id: 'doc-a' } },
    });
    const res = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: {
        type: 'addCutout',
        payload: { docId: 'doc-a', page: 1, rect: { x: 0, y: 0, w: 10, h: 10 }, position: { x: 0, y: 0 }, id: 'cut-1', fileSha256: 'geschummelt' },
      },
    });
    expect(res.statusCode).toBe(200);
    const cutout = res.json().state.cutouts.find((c: { id: string }) => c.id === 'cut-1');
    expect(cutout.fileSha256).toBe(meta.sha256);
    expect(cutout.fileSha256).not.toBe('geschummelt');
  });

  it('Standalone: Cutout auf einem Doc mit unbekannter fileId bekommt kein fileSha256', async () => {
    const { app, authHeaders } = await createTestApp();
    const desk = (await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'D' } })).json();
    // Zustand direkt gesetzt (statt über addDoc), um eine fileId zu erzeugen, die es in der files-Tabelle nicht gibt.
    await app.inject({
      method: 'PUT', url: `/api/v1/desks/${desk.id}/state`, headers: authHeaders,
      payload: {
        docs: [{ id: 'doc-x', fileId: 'nichtvorhanden', name: 'x.pdf', position: { x: 0, y: 0 }, rotation: 0, zIndex: 1 }],
        links: [], stacks: [],
      },
    });
    const res = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'addCutout', payload: { docId: 'doc-x', page: 1, rect: { x: 0, y: 0, w: 10, h: 10 }, position: { x: 0, y: 0 }, id: 'cut-1' } },
    });
    expect(res.statusCode).toBe(200);
    const cutout = res.json().state.cutouts.find((c: { id: string }) => c.id === 'cut-1');
    expect(cutout).not.toHaveProperty('fileSha256');
  });

  it('GET /files/:id/meta (Standalone): 200 mit Metadaten, 404 für unbekannte Datei', async () => {
    const { app, db, dataDir, authHeaders } = await createTestApp();
    const meta = storeFile(db, dataDir, pdf, 'a.pdf');
    const desk = (await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'D' } })).json();
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'addDoc', payload: { fileId: meta.id, name: 'a.pdf', position: { x: 1, y: 2 }, id: 'doc-a' } },
    });
    let res = await app.inject({ method: 'GET', url: `/api/v1/files/${meta.id}/meta`, headers: authHeaders });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: meta.id, name: 'a.pdf', kind: 'pdf', sha256: meta.sha256 });

    res = await app.inject({ method: 'GET', url: '/api/v1/files/gibtsnicht/meta', headers: authHeaders });
    expect(res.statusCode).toBe(404);
  });

  it('j-lawyer-Modus: addCutout bekommt kein fileSha256; /files/:id/meta liefert Namen aus dem Fake', async () => {
    const fake = await startFakeJLawyer();
    try {
      const db = openDb(':memory:');
      const dataDir = mkdtempSync(join(tmpdir(), 'dd-jl-sha-'));
      const app = await buildApp({ db, dataDir, jlawyerUrl: fake.url });
      const { token } = (
        await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'anwalt', password: 'kanzlei123' } })
      ).json();
      const headers = { authorization: `Bearer ${token}` };
      const deskRes = await app.inject({ method: 'GET', url: '/api/v1/cases/akte-1/desk', headers });
      const doc = deskRes.json().state.docs[0]; // fileId = jdoc-1 ("Klageschrift.pdf")

      const res = await app.inject({
        method: 'POST', url: '/api/v1/desks/akte-1/commands', headers,
        payload: {
          type: 'addCutout',
          payload: { docId: doc.id, page: 1, rect: { x: 0, y: 0, w: 10, h: 10 }, position: { x: 0, y: 0 }, id: 'cut-1', fileSha256: 'geschummelt' },
        },
      });
      expect(res.statusCode).toBe(200);
      const cutout = res.json().state.cutouts.find((c: { id: string }) => c.id === 'cut-1');
      expect(cutout).not.toHaveProperty('fileSha256');

      const metaRes = await app.inject({ method: 'GET', url: `/api/v1/files/${doc.fileId}/meta`, headers });
      expect(metaRes.statusCode).toBe(200);
      expect(metaRes.json()).toEqual({ id: doc.fileId, name: 'Klageschrift.pdf', kind: 'pdf', sha256: null });
      await app.close();
    } finally {
      await fake.stop();
    }
  });

  it('j-lawyer-Modus: nach einem Dokumentabruf enthält jl_file_hashes eine Zeile mit nicht-leerem sha256', async () => {
    const fake = await startFakeJLawyer();
    try {
      const db = openDb(':memory:');
      const dataDir = mkdtempSync(join(tmpdir(), 'dd-jl-hash-'));
      const app = await buildApp({ db, dataDir, jlawyerUrl: fake.url });
      const { token } = (
        await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'anwalt', password: 'kanzlei123' } })
      ).json();
      const headers = { authorization: `Bearer ${token}` };
      const deskRes = await app.inject({ method: 'GET', url: '/api/v1/cases/akte-1/desk', headers });
      const doc = deskRes.json().state.docs[0]; // fileId = jdoc-1, sourceChangeDate vom Abgleich gesetzt

      const res = await app.inject({ method: 'GET', url: `/api/v1/files/${doc.fileId}`, headers });
      expect(res.statusCode).toBe(200);

      const row = db.prepare('SELECT sha256 FROM jl_file_hashes WHERE doc_id = ? AND change_date = ?').get(doc.fileId, doc.sourceChangeDate) as
        { sha256: string } | undefined;
      expect(row?.sha256).toBeTruthy();

      // zweiter Abruf (Cache-Treffer): kein Fehler, derselbe Hash bleibt bestehen (Idempotenz).
      const res2 = await app.inject({ method: 'GET', url: `/api/v1/files/${doc.fileId}`, headers });
      expect(res2.statusCode).toBe(200);
      const row2 = db.prepare('SELECT sha256 FROM jl_file_hashes WHERE doc_id = ? AND change_date = ?').get(doc.fileId, doc.sourceChangeDate) as
        { sha256: string } | undefined;
      expect(row2?.sha256).toBe(row?.sha256);
      await app.close();
    } finally {
      await fake.stop();
    }
  });

  it('j-lawyer-Modus: addCutout bekommt nach vorherigem Dokumentabruf einen echten fileSha256 (Invariante); ein gefälschter Client-Wert wird überschrieben (Tampering)', async () => {
    const fake = await startFakeJLawyer();
    try {
      const db = openDb(':memory:');
      const dataDir = mkdtempSync(join(tmpdir(), 'dd-jl-cutout-hash-'));
      const app = await buildApp({ db, dataDir, jlawyerUrl: fake.url });
      const { token } = (
        await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'anwalt', password: 'kanzlei123' } })
      ).json();
      const headers = { authorization: `Bearer ${token}` };
      const deskRes = await app.inject({ method: 'GET', url: '/api/v1/cases/akte-1/desk', headers });
      const doc = deskRes.json().state.docs[0];

      // löst den Cache-Befüllungspfad (cachedDocBytes -> getOrComputeJlHash) aus, BEVOR der Ausschnitt entsteht.
      await app.inject({ method: 'GET', url: `/api/v1/files/${doc.fileId}`, headers });
      const echterHash = (
        db.prepare('SELECT sha256 FROM jl_file_hashes WHERE doc_id = ? AND change_date = ?').get(doc.fileId, doc.sourceChangeDate) as { sha256: string }
      ).sha256;

      const res = await app.inject({
        method: 'POST', url: '/api/v1/desks/akte-1/commands', headers,
        payload: {
          type: 'addCutout',
          payload: { docId: doc.id, page: 1, rect: { x: 0, y: 0, w: 10, h: 10 }, position: { x: 0, y: 0 }, id: 'cut-hash', fileSha256: 'geschummelt' },
        },
      });
      expect(res.statusCode).toBe(200);
      const cutout = res.json().state.cutouts.find((c: { id: string }) => c.id === 'cut-hash');
      expect(cutout.fileSha256).toBe(echterHash);
      expect(cutout.fileSha256).not.toBe('geschummelt');
      await app.close();
    } finally {
      await fake.stop();
    }
  });

  it('j-lawyer-Modus: addMark bekommt nach vorherigem Dokumentabruf einen echten fileSha256 (Invariante); ein gefälschter Client-Wert wird überschrieben (Tampering)', async () => {
    const fake = await startFakeJLawyer();
    try {
      const db = openDb(':memory:');
      const dataDir = mkdtempSync(join(tmpdir(), 'dd-jl-mark-hash-'));
      const app = await buildApp({ db, dataDir, jlawyerUrl: fake.url });
      const { token } = (
        await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'anwalt', password: 'kanzlei123' } })
      ).json();
      const headers = { authorization: `Bearer ${token}` };
      const deskRes = await app.inject({ method: 'GET', url: '/api/v1/cases/akte-1/desk', headers });
      const doc = deskRes.json().state.docs[0];

      await app.inject({ method: 'GET', url: `/api/v1/files/${doc.fileId}`, headers });
      const echterHash = (
        db.prepare('SELECT sha256 FROM jl_file_hashes WHERE doc_id = ? AND change_date = ?').get(doc.fileId, doc.sourceChangeDate) as { sha256: string }
      ).sha256;

      const res = await app.inject({
        method: 'POST', url: '/api/v1/desks/akte-1/commands', headers,
        payload: {
          type: 'addMark',
          payload: { mark: { id: 'mark-hash', docId: doc.id, page: 1, rect: { x: 0, y: 0, w: 5, h: 5 }, kind: 'redact', fileSha256: 'geschummelt' } },
        },
      });
      expect(res.statusCode).toBe(200);
      const mark = res.json().state.marks.find((m: { id: string }) => m.id === 'mark-hash');
      expect(mark.fileSha256).toBe(echterHash);
      expect(mark.fileSha256).not.toBe('geschummelt');
      await app.close();
    } finally {
      await fake.stop();
    }
  });

  it('Standalone: addMark ermittelt fileSha256 serverseitig aus files.sha256; ein gefälschter Client-Wert wird überschrieben', async () => {
    const { app, db, dataDir, authHeaders } = await createTestApp();
    const meta = storeFile(db, dataDir, pdf, 'a.pdf');
    const desk = (await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'D' } })).json();
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'addDoc', payload: { fileId: meta.id, name: 'a.pdf', position: { x: 1, y: 2 }, id: 'doc-a' } },
    });
    const res = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: {
        type: 'addMark',
        payload: { mark: { id: 'mark-hash', docId: 'doc-a', page: 1, rect: { x: 0, y: 0, w: 5, h: 5 }, kind: 'redact', fileSha256: 'geschummelt' } },
      },
    });
    expect(res.statusCode).toBe(200);
    const mark = res.json().state.marks.find((m: { id: string }) => m.id === 'mark-hash');
    expect(mark.fileSha256).toBe(meta.sha256);
    expect(mark.fileSha256).not.toBe('geschummelt');
  });

  it('addCutout mit überlangem textSnapshot: der Journal-Eintrag trägt den bereits gekappten Payload (nicht den rohen)', async () => {
    const { app, db, dataDir, authHeaders } = await createTestApp();
    const meta = storeFile(db, dataDir, pdf, 'a.pdf');
    const desk = (await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'D' } })).json();
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'addDoc', payload: { fileId: meta.id, name: 'a.pdf', position: { x: 1, y: 2 }, id: 'doc-a' } },
    });
    const langerText = 'x'.repeat(3000);
    const res = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: {
        type: 'addCutout',
        payload: { docId: 'doc-a', page: 1, rect: { x: 0, y: 0, w: 10, h: 10 }, position: { x: 0, y: 0 }, id: 'cut-1', textSnapshot: langerText },
      },
    });
    expect(res.statusCode).toBe(200);
    const journalRes = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/journal`, headers: authHeaders });
    const entry = journalRes.json().entries.find((e: { type: string }) => e.type === 'addCutout');
    expect(entry.payload.textSnapshot).toHaveLength(TEXT_SNAPSHOT_MAX);
    expect(entry.payload.textSnapshot).toBe('x'.repeat(TEXT_SNAPSHOT_MAX));
  });

  it('addMark mit überlangem mark.textSnapshot: der Journal-Eintrag trägt den bereits gekappten Payload', async () => {
    const { app, db, dataDir, authHeaders } = await createTestApp();
    const meta = storeFile(db, dataDir, pdf, 'a.pdf');
    const desk = (await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'D' } })).json();
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'addDoc', payload: { fileId: meta.id, name: 'a.pdf', position: { x: 1, y: 2 }, id: 'doc-a' } },
    });
    const langerText = 'y'.repeat(3000);
    const res = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: {
        type: 'addMark',
        payload: { mark: { id: 'mark-1', docId: 'doc-a', page: 1, rect: { x: 0, y: 0, w: 10, h: 10 }, kind: 'tippex', textSnapshot: langerText } },
      },
    });
    expect(res.statusCode).toBe(200);
    const journalRes = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/journal`, headers: authHeaders });
    const entry = journalRes.json().entries.find((e: { type: string }) => e.type === 'addMark');
    expect(entry.payload.mark.textSnapshot).toHaveLength(TEXT_SNAPSHOT_MAX);
    expect(entry.payload.mark.textSnapshot).toBe('y'.repeat(TEXT_SNAPSHOT_MAX));
  });

  it('j-lawyer-Modus: addDoc (Sprung-anlegen-Pfad) wird NICHT am files-Guard abgewiesen — die files-Tabelle ist im jl-Modus immer leer', async () => {
    const fake = await startFakeJLawyer();
    try {
      const db = openDb(':memory:');
      const dataDir = mkdtempSync(join(tmpdir(), 'dd-jl-adddoc-'));
      const app = await buildApp({ db, dataDir, jlawyerUrl: fake.url });
      const { token } = (
        await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'anwalt', password: 'kanzlei123' } })
      ).json();
      const headers = { authorization: `Bearer ${token}` };
      await app.inject({ method: 'GET', url: '/api/v1/cases/akte-1/desk', headers }); // legt den Desk an (Abgleich hängt jdoc-1/jdoc-2 bereits an)

      // fileId beliebig (auch keine im Fake-jlawyer bekannte jdoc-…-id) — die files-Tabelle
      // existiert im jl-Modus schlicht nicht, der Guard darf hier nie greifen.
      const res = await app.inject({
        method: 'POST', url: '/api/v1/desks/akte-1/commands', headers,
        payload: {
          type: 'addDoc',
          payload: { fileId: 'irgendeine-jl-file-id', name: 'Nachtrag.pdf', position: { x: 0, y: 0 }, id: 'doc-nachtrag' },
        },
      });
      expect(res.statusCode).toBe(200); // NICHT 400 — files-Tabelle ist im jl-Modus leer, der nächste Akten-Abgleich ist die Wahrheit
      expect(res.json().state.docs.find((d: { id: string }) => d.id === 'doc-nachtrag')).toBeTruthy();
      await app.close();
    } finally {
      await fake.stop();
    }
  });
});

describe('j-lawyer-Modus: Versionskompatibilität beim Verbinden (REF-03, 01-07)', () => {
  async function jlApp(fake: Awaited<ReturnType<typeof startFakeJLawyer>>) {
    const db = openDb(':memory:');
    const dataDir = mkdtempSync(join(tmpdir(), 'dd-jl-version-'));
    const app = await buildApp({ db, dataDir, jlawyerUrl: fake.url });
    return { app, db };
  }

  it('passende apiLevel (getestete Spanne) -> jlVersion "kompatibel"', async () => {
    const fake = await startFakeJLawyer();
    try {
      const { app } = await jlApp(fake); // fake.metadata.apiLevel ist standardmäßig 8 (getestete Ebene)
      const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'anwalt', password: 'kanzlei123' } });
      expect(res.statusCode).toBe(200);
      expect(res.json().jlVersion).toBe('kompatibel');
      await app.close();
    } finally {
      await fake.stop();
    }
  });

  it('abweichende apiLevel -> jlVersion "inkompatibel", Login bleibt trotzdem erfolgreich', async () => {
    const fake = await startFakeJLawyer();
    fake.metadata.apiLevel = 9; // außerhalb der getesteten Spanne (8)
    try {
      const { app } = await jlApp(fake);
      const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'anwalt', password: 'kanzlei123' } });
      expect(res.statusCode).toBe(200);
      expect(res.json().token).toBeTruthy();
      expect(res.json().jlVersion).toBe('inkompatibel');
      await app.close();
    } finally {
      await fake.stop();
    }
  });

  it('Versionsermittlung schlägt fehl (kein Endpunkt/500) -> Login gelingt trotzdem, jlVersion "unbestimmt"', async () => {
    const fake = await startFakeJLawyer();
    fake.metadata.status = 500;
    try {
      const { app } = await jlApp(fake);
      const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'anwalt', password: 'kanzlei123' } });
      expect(res.statusCode).toBe(200);
      expect(res.json().token).toBeTruthy();
      expect(res.json().jlVersion).toBe('unbestimmt');
      await app.close();
    } finally {
      await fake.stop();
    }
  });

  it('Versionsermittlung nicht erreichbar (Netzfehler) -> Login gelingt trotzdem, jlVersion "unbestimmt"', async () => {
    const fake = await startFakeJLawyer();
    fake.metadata.status = 'destroy';
    try {
      const { app } = await jlApp(fake);
      const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'anwalt', password: 'kanzlei123' } });
      expect(res.statusCode).toBe(200);
      expect(res.json().token).toBeTruthy();
      expect(res.json().jlVersion).toBe('unbestimmt');
      await app.close();
    } finally {
      await fake.stop();
    }
  });

  it('unerwartete Antwort ohne apiLevel-Feld -> Login gelingt trotzdem, jlVersion "unbestimmt"', async () => {
    const fake = await startFakeJLawyer();
    fake.metadata.status = 'malformed';
    try {
      const { app } = await jlApp(fake);
      const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'anwalt', password: 'kanzlei123' } });
      expect(res.statusCode).toBe(200);
      expect(res.json().jlVersion).toBe('unbestimmt');
      await app.close();
    } finally {
      await fake.stop();
    }
  });

  it('Standalone-Modus: Login-Response enthält kein jlVersion-Feld (kein j-lawyer angebunden)', async () => {
    const db = openDb(':memory:');
    const dataDir = mkdtempSync(join(tmpdir(), 'dd-standalone-version-'));
    await createUser(db, 'standalone-nutzer', 'geheim-genug');
    const app = await buildApp({ db, dataDir });
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'standalone-nutzer', password: 'geheim-genug' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).not.toHaveProperty('jlVersion');
    await app.close();
  });

  it('WR-03: Session-Wiederherstellung (GET /auth/status MIT Token, ohne erneuten Login) liefert jlVersion erneut', async () => {
    const fake = await startFakeJLawyer();
    fake.metadata.apiLevel = 9; // außerhalb der getesteten Spanne -> "inkompatibel"
    try {
      const { app } = await jlApp(fake);
      const loginRes = await app.inject({
        method: 'POST', url: '/api/v1/auth/login', payload: { username: 'anwalt', password: 'kanzlei123' },
      });
      const { token } = loginRes.json();

      // Simuliert einen Tab-/Seiten-Reload: kein erneuter /auth/login, nur der gespeicherte Token.
      const res = await app.inject({
        method: 'GET', url: '/api/v1/auth/status', headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().jlVersion).toBe('inkompatibel');
      await app.close();
    } finally {
      await fake.stop();
    }
  });

  it('WR-03: GET /auth/status OHNE Token liefert weiterhin kein jlVersion-Feld (Erstbesuch/Login-Screen)', async () => {
    const fake = await startFakeJLawyer();
    try {
      const { app } = await jlApp(fake);
      const res = await app.inject({ method: 'GET', url: '/api/v1/auth/status' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).not.toHaveProperty('jlVersion');
      await app.close();
    } finally {
      await fake.stop();
    }
  });
});

describe('j-lawyer-Modus: granularer Referenzstatus (Runde 2 — Umbenennung/403/404/nicht erreichbar/REF-02)', () => {
  /** Baut eine jl-App, meldet sich an und liefert die Login-Header — Bestandsmuster dieser Datei. */
  async function angemeldeteJlApp(fake: Awaited<ReturnType<typeof startFakeJLawyer>>) {
    const db = openDb(':memory:');
    const dataDir = mkdtempSync(join(tmpdir(), 'dd-jl-refstatus-'));
    const app = await buildApp({ db, dataDir, jlawyerUrl: fake.url });
    const { token } = (
      await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'anwalt', password: 'kanzlei123' } })
    ).json();
    return { app, db, headers: { authorization: `Bearer ${token}` } };
  }

  it('Umbenennung bei gleicher changeDate: sourceRenamedAt gesetzt, sourceReplacedAt bleibt ungesetzt', async () => {
    const fake = await startFakeJLawyer();
    try {
      const { app, headers } = await angemeldeteJlApp(fake);
      const erst = await app.inject({ method: 'GET', url: '/api/v1/cases/akte-1/desk', headers });
      const vorDoc = erst.json().state.docs.find((d: { fileId: string }) => d.fileId === 'jdoc-1');
      expect(vorDoc.name).toBe('Klageschrift.pdf');
      expect(vorDoc.sourceRenamedAt).toBeUndefined();

      // Umbenennung in j-lawyer: gleiche changeDate, neuer Name.
      fake.documents.get('akte-1')![0] = { ...fake.documents.get('akte-1')![0], name: 'Klageschrift-berichtigt.pdf' };

      const zweit = await app.inject({ method: 'GET', url: '/api/v1/cases/akte-1/desk', headers });
      const nachDoc = zweit.json().state.docs.find((d: { fileId: string }) => d.fileId === 'jdoc-1');
      expect(nachDoc.name).toBe('Klageschrift-berichtigt.pdf');
      expect(nachDoc.sourceRenamedAt).toEqual(expect.any(String));
      expect(nachDoc.sourceReplacedAt).toBeUndefined();
      await app.close();
    } finally {
      await fake.stop();
    }
  });

  it('403 beim gezielten Einzelabruf eines neu verschwundenen Dokuments -> sourceAccessDenied statt sourceGone (Pitfall 2)', async () => {
    const fake = await startFakeJLawyer();
    try {
      const { app, headers } = await angemeldeteJlApp(fake);
      await app.inject({ method: 'GET', url: '/api/v1/cases/akte-1/desk', headers });

      const docs = fake.documents.get('akte-1')!;
      docs.splice(docs.findIndex((d) => d.id === 'jdoc-1'), 1); // verschwindet aus der Bulk-Liste
      fake.forceStatus.set('jdoc-1', 403); // Einzelabruf: Recht entzogen

      const res = await app.inject({ method: 'GET', url: '/api/v1/cases/akte-1/desk', headers });
      const doc = res.json().state.docs.find((d: { fileId: string }) => d.fileId === 'jdoc-1');
      expect(doc.sourceAccessDenied).toBe(true);
      expect(doc.sourceGone).toBeUndefined();
      await app.close();
    } finally {
      await fake.stop();
    }
  });

  it('404 beim gezielten Einzelabruf eines neu verschwundenen Dokuments -> sourceGone (kein sourceAccessDenied)', async () => {
    const fake = await startFakeJLawyer();
    try {
      const { app, headers } = await angemeldeteJlApp(fake);
      await app.inject({ method: 'GET', url: '/api/v1/cases/akte-1/desk', headers });

      const docs = fake.documents.get('akte-1')!;
      docs.splice(docs.findIndex((d) => d.id === 'jdoc-2'), 1);
      fake.forceStatus.set('jdoc-2', 404);

      const res = await app.inject({ method: 'GET', url: '/api/v1/cases/akte-1/desk', headers });
      const doc = res.json().state.docs.find((d: { fileId: string }) => d.fileId === 'jdoc-2');
      expect(doc.sourceGone).toBe(true);
      expect(doc.sourceAccessDenied).toBeUndefined();
      await app.close();
    } finally {
      await fake.stop();
    }
  });

  it('nicht erreichbarer Einzelabruf eines neu verschwundenen Dokuments -> sourceNotReachable NUR live in der Antwort, NICHT persistiert', async () => {
    const fake = await startFakeJLawyer();
    try {
      const { app, db, headers } = await angemeldeteJlApp(fake);
      await app.inject({ method: 'GET', url: '/api/v1/cases/akte-1/desk', headers });

      const docs = fake.documents.get('akte-1')!;
      docs.splice(docs.findIndex((d) => d.id === 'jdoc-1'), 1);
      fake.forceStatus.set('jdoc-1', 'destroy');

      const res = await app.inject({ method: 'GET', url: '/api/v1/cases/akte-1/desk', headers });
      const doc = res.json().state.docs.find((d: { fileId: string }) => d.fileId === 'jdoc-1');
      expect(doc.sourceNotReachable).toBe(true);
      expect(doc.sourceGone).toBeUndefined();

      // Nicht persistiert: der gespeicherte Desk-Zustand kennt sourceNotReachable/sourceGone nicht.
      const gespeichert = getDeskState(db, 'akte-1')!;
      const persistDoc = gespeichert.state.docs.find((d) => d.fileId === 'jdoc-1')!;
      expect(persistDoc.sourceNotReachable).toBeUndefined();
      expect(persistDoc.sourceGone).toBeUndefined();

      // Zweiter Abgleich: der Einzelabruf wird erneut versucht (kein dauerhaftes Überspringen,
      // da weder sourceGone noch sourceAccessDenied persistiert wurden).
      const res2 = await app.inject({ method: 'GET', url: '/api/v1/cases/akte-1/desk', headers });
      expect(res2.json().state.docs.find((d: { fileId: string }) => d.fileId === 'jdoc-1').sourceNotReachable).toBe(true);
      await app.close();
    } finally {
      await fake.stop();
    }
  });

  it('REF-02: ein Mark am betroffenen Doc bleibt nach entzogenem Recht (403) unversehrt erhalten', async () => {
    const fake = await startFakeJLawyer();
    try {
      const { app, headers } = await angemeldeteJlApp(fake);
      const erst = await app.inject({ method: 'GET', url: '/api/v1/cases/akte-1/desk', headers });
      const doc = erst.json().state.docs.find((d: { fileId: string }) => d.fileId === 'jdoc-1');

      const markRes = await app.inject({
        method: 'POST', url: '/api/v1/desks/akte-1/commands', headers,
        payload: {
          type: 'addMark',
          payload: { mark: { id: 'mark-ref02', docId: doc.id, page: 1, rect: { x: 0, y: 0, w: 5, h: 5 }, kind: 'redact' } },
        },
      });
      expect(markRes.statusCode).toBe(200);

      const docs = fake.documents.get('akte-1')!;
      docs.splice(docs.findIndex((d) => d.id === 'jdoc-1'), 1);
      fake.forceStatus.set('jdoc-1', 403);

      const res = await app.inject({ method: 'GET', url: '/api/v1/cases/akte-1/desk', headers });
      const state = res.json().state;
      expect(state.docs.find((d: { fileId: string }) => d.fileId === 'jdoc-1').sourceAccessDenied).toBe(true);
      const mark = state.marks.find((m: { id: string }) => m.id === 'mark-ref02');
      expect(mark).toBeTruthy();
      expect(mark.docId).toBe(doc.id);
      await app.close();
    } finally {
      await fake.stop();
    }
  });

  it('Fall archiviert (v2 archived=1) -> alle Karten der Akte erhalten sourceArchived (01-SPIKE-FINDINGS.md: Fall-Feld, kein Dokument-Feld)', async () => {
    const fake = await startFakeJLawyer();
    try {
      fake.cases[0] = { ...fake.cases[0], archived: 0 };
      const { app, headers } = await angemeldeteJlApp(fake);
      const erst = await app.inject({ method: 'GET', url: '/api/v1/cases/akte-1/desk', headers });
      expect(erst.json().state.docs[0].sourceArchived).toBeUndefined();

      fake.cases[0] = { ...fake.cases[0], archived: 1 };
      const zweit = await app.inject({ method: 'GET', url: '/api/v1/cases/akte-1/desk', headers });
      const state = zweit.json().state;
      expect(state.docs.every((d: { sourceArchived?: true }) => d.sourceArchived === true)).toBe(true);
      await app.close();
    } finally {
      await fake.stop();
    }
  });

  it('Fall entarchiviert (v2 archived=1 -> 0) -> sourceArchived wird von allen Karten wieder entfernt (WR-01)', async () => {
    const fake = await startFakeJLawyer();
    try {
      fake.cases[0] = { ...fake.cases[0], archived: 1 };
      const { app, headers } = await angemeldeteJlApp(fake);
      const erst = await app.inject({ method: 'GET', url: '/api/v1/cases/akte-1/desk', headers });
      expect(erst.json().state.docs.every((d: { sourceArchived?: true }) => d.sourceArchived === true)).toBe(true);

      fake.cases[0] = { ...fake.cases[0], archived: 0 };
      const zweit = await app.inject({ method: 'GET', url: '/api/v1/cases/akte-1/desk', headers });
      const state = zweit.json().state;
      expect(state.docs.every((d: { sourceArchived?: true }) => d.sourceArchived === undefined)).toBe(true);
      await app.close();
    } finally {
      await fake.stop();
    }
  });
});

describe('Konverter-Ticket-Quelle', () => {
  it('convert-source: Einmal-Ticket liefert Originalbytes genau einmal, ohne Auth-Header', async () => {
    const { app, db, dataDir } = await createTestApp();
    const { storeFile } = await import('./files');
    const meta = storeFile(db, dataDir, pdf, 'a.pdf');
    const ticket = app.fileTickets.issue({ fileId: meta.id });

    const res1 = await app.inject({ method: 'GET', url: `/api/v1/convert-source/${ticket}` });
    expect(res1.statusCode).toBe(200);
    expect(res1.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');

    const res2 = await app.inject({ method: 'GET', url: `/api/v1/convert-source/${ticket}` });
    expect(res2.statusCode).toBe(404); // verbraucht

    const res3 = await app.inject({ method: 'GET', url: '/api/v1/convert-source/quatsch' });
    expect(res3.statusCode).toBe(404);
  });
});

/** AR-02-04 (14-07): die Datei-Leserouten liefern nur noch für Dateien, auf die mindestens ein
 *  für den Nutzer sichtbares Objekt verweist — Fixture-Helfer für die bestehenden Roundtrip-Tests
 *  unten, die zuvor bewusst ohne Desk-Bezug lasen (das genau war die geschlossene Lücke). */
async function referenziereAufDesk(
  app: Awaited<ReturnType<typeof createTestApp>>['app'],
  authHeaders: { authorization: string },
  fileId: string,
): Promise<void> {
  const desk = (await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'D' } })).json();
  await app.inject({
    method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
    payload: { type: 'addDoc', payload: { fileId, name: 'x', position: { x: 0, y: 0 } } },
  });
}

describe('Vorschau-Route (Standalone, ohne Konverter)', () => {
  it('kind pdf: liefert die Originalbytes wie /files/:id', async () => {
    const { app, db, dataDir, authHeaders } = await createTestApp();
    const meta = storeFile(db, dataDir, pdf, 'a.pdf');
    await referenziereAufDesk(app, authHeaders, meta.id);
    const res = await app.inject({ method: 'GET', url: `/api/v1/files/${meta.id}/preview`, headers: authHeaders });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.rawPayload.equals(pdf)).toBe(true);
  });

  it('kind image/other: 404 mit Meldung', async () => {
    const { app, db, dataDir, authHeaders } = await createTestApp();
    const img = storeFile(db, dataDir, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]), 'foto.jpg');
    const other = storeFile(db, dataDir, Buffer.from('zufaelliger inhalt'), 'irgendwas.exe');
    await referenziereAufDesk(app, authHeaders, img.id);
    await referenziereAufDesk(app, authHeaders, other.id);
    for (const id of [img.id, other.id]) {
      const res = await app.inject({ method: 'GET', url: `/api/v1/files/${id}/preview`, headers: authHeaders });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Keine Vorschau für diese Datei-Art' });
    }
  });

  it('unbekannte fileId: 404', async () => {
    const { app, authHeaders } = await createTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/files/gibtsnicht/preview', headers: authHeaders });
    expect(res.statusCode).toBe(404);
  });

  it('kind convertible ohne konfigurierten Konverter: 409 disabled', async () => {
    const { app, db, dataDir, authHeaders } = await createTestApp();
    const meta = storeFile(db, dataDir, Buffer.from('bericht-inhalt'), 'Bericht.odt');
    await referenziereAufDesk(app, authHeaders, meta.id);
    const res = await app.inject({ method: 'GET', url: `/api/v1/files/${meta.id}/preview`, headers: authHeaders });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'Vorschau-Dienst nicht konfiguriert', reason: 'disabled' });
  });

  it('ohne Login: 401', async () => {
    const { app } = await createTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/files/irgendwas/preview' });
    expect(res.statusCode).toBe(401);
  });
});

describe('Vorschau-Route (Standalone, mit Konverter)', () => {
  it('kind convertible: 202 -> Poll -> 200 mit PDF-Bytes, danach aus dem Cache', async () => {
    const fake = await startFakeConvertServer();
    try {
      const { app, db, dataDir, authHeaders } = await convertingApp(fake);
      const meta = storeFile(db, dataDir, Buffer.from('bericht-inhalt'), 'Bericht.odt');
      await referenziereAufDesk(app, authHeaders, meta.id);
      fake.configure(meta.id, { pollsUntilDone: 1 });
      const url = `/api/v1/files/${meta.id}/preview`;

      let res = await app.inject({ method: 'GET', url, headers: authHeaders });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ status: 'converting' });

      let tries = 0;
      while (tries++ < 100 && res.statusCode !== 200) {
        await sleep(20);
        res = await app.inject({ method: 'GET', url, headers: authHeaders });
        expect([202, 200]).toContain(res.statusCode);
      }
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('application/pdf');
      expect(res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');

      // aus dem Plattencache: kein weiterer DS-Kontakt
      const callsVorher = fake.convertCalls.filter((k) => k === meta.id).length;
      res = await app.inject({ method: 'GET', url, headers: authHeaders });
      expect(res.statusCode).toBe(200);
      expect(fake.convertCalls.filter((k) => k === meta.id).length).toBe(callsVorher);

      await app.close();
    } finally {
      await fake.stop();
    }
  });

  it('DS-Fehler: 409 mit Meldung + reason; nächster Aufruf versucht erneut', async () => {
    const fake = await startFakeConvertServer();
    try {
      const { app, db, dataDir, authHeaders } = await convertingApp(fake);
      const meta = storeFile(db, dataDir, Buffer.from('fehler-inhalt'), 'Fehler.docx');
      await referenziereAufDesk(app, authHeaders, meta.id);
      fake.configure(meta.id, { errorCode: '-3', errorWithoutEndConvert: true });
      const url = `/api/v1/files/${meta.id}/preview`;

      let res = await app.inject({ method: 'GET', url, headers: authHeaders });
      expect(res.statusCode).toBe(202); // Anstoß

      let tries = 0;
      while (tries++ < 100 && res.statusCode !== 409) {
        await sleep(20);
        res = await app.inject({ method: 'GET', url, headers: authHeaders });
      }
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ reason: 'failed' });
      expect(res.json().error).toContain('-3');

      // Fehler-Merker wurde zurückgesetzt -> nächster Aufruf stößt erneut an
      res = await app.inject({ method: 'GET', url, headers: authHeaders });
      expect(res.statusCode).toBe(202);

      await app.close();
    } finally {
      await fake.stop();
    }
  });
});

describe('Dateien (echter HTTP-Server für multipart)', () => {
  it('Upload, Dedup, Ablehnung und Download', async () => {
    const { app, authHeaders } = await createTestApp();
    // WR-03: Upload erfordert eine Schreibtisch-Mitgliedschaft — wie im echten Client-Fluss
    // (Desk anlegen, dann Dateien hochladen) erst einen Desk erstellen.
    const uploadDesk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'Upload-Desk' } })
    ).json();
    await app.listen({ port: 0 });
    const { port } = app.server.address() as { port: number };
    const base = `http://127.0.0.1:${port}/api/v1`;

    const upload = async (bytes: Buffer, name: string) => {
      const fd = new FormData();
      fd.append('file', new Blob([bytes], { type: 'application/pdf' }), name);
      return fetch(`${base}/files`, { method: 'POST', headers: authHeaders, body: fd });
    };

    let res = await upload(pdf, 'a.pdf');
    expect(res.status).toBe(201);
    const { fileId, kind } = (await res.json()) as { fileId: string; kind: string };
    expect(kind).toBe('pdf');

    res = await upload(pdf, 'kopie.pdf');
    expect(((await res.json()) as { fileId: string }).fileId).toBe(fileId); // Dedup

    // kein Endungs-/Magic-Zwang mehr: unbekannter Inhalt wird klassifiziert statt abgelehnt
    res = await upload(Buffer.from('kein pdf'), 'a.pdf');
    expect(res.status).toBe(201);
    expect(((await res.json()) as { kind: string }).kind).toBe('other');

    res = await upload(Buffer.alloc(0), 'leer.pdf');
    expect(res.status).toBe(400); // Größe/Leer-Ablehnung bleibt

    // AR-02-04 (14-07): der Download-Roundtrip braucht jetzt ein für den Nutzer sichtbares
    // referenzierendes Objekt — genau der Fall, den der echte Client-Fluss erzeugt (Upload,
    // dann addDoc auf demselben Desk).
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${uploadDesk.id}/commands`, headers: authHeaders,
      payload: { type: 'addDoc', payload: { fileId, name: 'a.pdf', position: { x: 0, y: 0 } } },
    });

    res = await fetch(`${base}/files/${fileId}`, { headers: authHeaders });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(Buffer.from(await res.arrayBuffer()).equals(pdf)).toBe(true);

    res = await fetch(`${base}/files/gibtsnicht`, { headers: authHeaders });
    expect(res.status).toBe(404);

    await app.close();
  });
});

describe('Provenienz: Actor an Schreibpfaden + Journal', () => {
  it('addNote-Kommando: Antwort-State trägt createdBy = Username', async () => {
    const { app, authHeaders } = await createTestApp();
    const desk = (await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'D' } })).json();
    const res = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'addNote', payload: { kind: 'notiz', text: 'Hallo', position: { x: 1, y: 2 }, id: 'note-1' } },
    });
    expect(res.statusCode).toBe(200);
    const note = res.json().state.notes.find((n: { id: string }) => n.id === 'note-1');
    expect(note.createdBy).toBe('test');
  });

  it('GET /journal liefert deskCreated- und addNote-Eintrag mit Actor-Name und passender rev', async () => {
    const { app, authHeaders } = await createTestApp();
    const desk = (await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'D' } })).json();
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'addNote', payload: { kind: 'notiz', text: 'Hallo', position: { x: 1, y: 2 }, id: 'note-1' } },
    });
    const res = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/journal`, headers: authHeaders });
    expect(res.statusCode).toBe(200);
    const { entries } = res.json();
    const addNoteEntry = entries.find((e: { type: string }) => e.type === 'addNote');
    expect(addNoteEntry).toMatchObject({ type: 'addNote', actorName: 'test', rev: 1 });
    const createdEntry = entries.find((e: { type: string }) => e.type === 'deskCreated');
    expect(createdEntry).toMatchObject({ type: 'deskCreated', actorName: 'test', rev: 0 });
  });

  it('PUT /state erzeugt einen stateReplaced-Journal-Eintrag', async () => {
    const { app, authHeaders } = await createTestApp();
    const desk = (await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'D' } })).json();
    await app.inject({
      method: 'PUT', url: `/api/v1/desks/${desk.id}/state`, headers: authHeaders,
      payload: { docs: [], links: [], stacks: [] },
    });
    const res = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/journal`, headers: authHeaders });
    const { entries } = res.json();
    expect(entries.find((e: { type: string }) => e.type === 'stateReplaced')).toMatchObject({ type: 'stateReplaced', actorName: 'test', rev: 1 });
  });

  it('GET /journal: unbekannter Desk -> 404', async () => {
    const { app, authHeaders } = await createTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/desks/gibtsnicht/journal', headers: authHeaders });
    expect(res.statusCode).toBe(404);
  });

  it('GET /journal: leere/ungültige Query-Parameter werden ignoriert (nicht als 0 durchgereicht)', async () => {
    const { app, authHeaders } = await createTestApp();
    const desk = (await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'D' } })).json();
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'addNote', payload: { kind: 'notiz', text: 'Hallo', position: { x: 1, y: 2 }, id: 'note-1' } },
    });
    // limit='' (geleertes Formularfeld) darf nicht als gültige 0 durchgehen -> Default (50), Einträge kommen
    let res = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/journal?limit=`, headers: authHeaders });
    expect(res.statusCode).toBe(200);
    expect(res.json().entries.length).toBeGreaterThan(0);

    // before='' muss ebenso ignoriert werden statt zu id < 0 (-> für immer leer) zu führen
    res = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/journal?before=`, headers: authHeaders });
    expect(res.statusCode).toBe(200);
    expect(res.json().entries.length).toBeGreaterThan(0);

    // nicht-numerischer Müll wird ebenfalls ignoriert (Default statt Fehler)
    res = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/journal?limit=abc`, headers: authHeaders });
    expect(res.statusCode).toBe(200);
    expect(res.json().entries.length).toBeGreaterThan(0);
  });

  it('GET /journal: limit=2.5 (Float) führt nicht zum 500er, sondern liefert Einträge', async () => {
    const { app, authHeaders } = await createTestApp();
    const desk = (await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'D' } })).json();
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'addNote', payload: { kind: 'notiz', text: 'Hallo', position: { x: 1, y: 2 }, id: 'note-1' } },
    });
    // better-sqlite3 wirft bei Float-Bind an LIMIT ? ("datatype mismatch") — muss abgerundet statt durchgereicht werden.
    const res = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/journal?limit=2.5`, headers: authHeaders });
    expect(res.statusCode).toBe(200);
    expect(res.json().entries.length).toBeGreaterThan(0);
  });

  it('GET /journal: limit=%20 (nur Leerzeichen) wird wie fehlender Parameter behandelt (Default statt 0)', async () => {
    const { app, authHeaders } = await createTestApp();
    const desk = (await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'D' } })).json();
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'addNote', payload: { kind: 'notiz', text: 'Hallo', position: { x: 1, y: 2 }, id: 'note-1' } },
    });
    // Number(' ') === 0 -> ohne trim() würde das als gültige 0 durchgehen und die Liste leeren.
    const res = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/journal?limit=%20`, headers: authHeaders });
    expect(res.statusCode).toBe(200);
    expect(res.json().entries.length).toBeGreaterThan(0);
  });

  it('j-lawyer-Modus: Abgleich legt Karte mit createdBy j-lawyer-Abgleich an und journaliert caseSync', async () => {
    const fake = await startFakeJLawyer();
    try {
      const db = openDb(':memory:');
      const dataDir = mkdtempSync(join(tmpdir(), 'dd-jl-prov-'));
      const app = await buildApp({ db, dataDir, jlawyerUrl: fake.url });
      const { token } = (
        await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'anwalt', password: 'kanzlei123' } })
      ).json();
      const headers = { authorization: `Bearer ${token}` };
      const res = await app.inject({ method: 'GET', url: '/api/v1/cases/akte-1/desk', headers });
      expect(res.statusCode).toBe(200);
      const doc = res.json().state.docs[0];
      expect(doc.createdBy).toBe('j-lawyer-Abgleich');

      const journalRes = await app.inject({ method: 'GET', url: '/api/v1/desks/akte-1/journal', headers });
      const { entries } = journalRes.json();
      const syncEntry = entries.find((e: { type: string }) => e.type === 'caseSync');
      expect(syncEntry).toMatchObject({ type: 'caseSync', actorName: 'anwalt' });
      await app.close();
    } finally {
      await fake.stop();
    }
  });
});

describe('Setup Betriebsmodus', () => {
  it('status meldet needsModeChoice bei leerer DB ohne j-lawyer', async () => {
    const { app } = await noAccountApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/auth/status' });
    expect(res.json()).toMatchObject({ needsSetup: true, needsModeChoice: true, mode: 'standalone' });
  });

  it('needsModeChoice erlischt, sobald ein Konto existiert', async () => {
    const { app } = await noAccountApp();
    await app.inject({ method: 'POST', url: '/api/v1/auth/setup', payload: { username: 'a', password: 'passwort-123' } });
    const res = await app.inject({ method: 'GET', url: '/api/v1/auth/status' });
    expect(res.json().needsModeChoice).toBe(false);
  });

  it('setup/jlawyer speichert die URL und ruft onModeConfigured', async () => {
    let konfiguriert = 0;
    const { app, db } = await noAccountApp({ onModeConfigured: () => { konfiguriert++; } });
    const fake = await startFakeJLawyer();
    try {
      const res = await app.inject({ method: 'POST', url: '/api/v1/setup/jlawyer', payload: { url: fake.url } });
      expect(res.statusCode).toBe(200);
      expect(getSetting(db, 'jlawyer_url')).toBe(fake.url.replace(/\/+$/, ''));
      expect(konfiguriert).toBe(1);
    } finally {
      await fake.stop();
    }
  });

  it('setup/jlawyer lehnt tote URLs ab und speichert nichts', async () => {
    const { app, db } = await noAccountApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/setup/jlawyer', payload: { url: 'http://127.0.0.1:1' } });
    expect(res.statusCode).toBe(400);
    expect(getSetting(db, 'jlawyer_url')).toBeNull();
  });

  it('Setup-Routen sind nach Kontoanlage gesperrt (403)', async () => {
    const { app } = await noAccountApp();
    await app.inject({ method: 'POST', url: '/api/v1/auth/setup', payload: { username: 'a', password: 'passwort-123' } });
    const res = await app.inject({ method: 'POST', url: '/api/v1/setup/jlawyer', payload: { url: 'http://x' } });
    expect(res.statusCode).toBe(403);
  });

  // Zwischen Check (setupGesperrt) und Schreiben liegt der Probe-Await — ein weites Fenster,
  // in dem ein zweiter Erststart-POST denselben Check passiert. Ohne atomaren Anspruch
  // schreiben beide, beide bekommen 200, und der Server läuft am Ende womöglich gegen eine
  // andere Instanz als die, die dem antwortenden Client bestätigt wurde.
  it('zwei gleichzeitige setup/jlawyer-POSTs: genau einer gewinnt', async () => {
    let konfiguriert = 0;
    const { app, db } = await noAccountApp({ onModeConfigured: () => { konfiguriert++; } });
    const eins = await startFakeJLawyer();
    const zwei = await startFakeJLawyer();
    try {
      const antworten = await Promise.all([eins, zwei].map((f) =>
        app.inject({ method: 'POST', url: '/api/v1/setup/jlawyer', payload: { url: f.url } })
          .then((res) => ({ res, url: f.url.replace(/\/+$/, '') })),
      ));
      const gewonnen = antworten.filter((a) => a.res.statusCode === 200);
      expect(gewonnen).toHaveLength(1);
      expect(antworten.filter((a) => a.res.statusCode === 403)).toHaveLength(1);
      // Gespeichert ist genau die URL, die dem erfolgreichen Client bestätigt wurde.
      expect(getSetting(db, 'jlawyer_url')).toBe(gewonnen[0].url);
      expect(konfiguriert).toBe(1);
    } finally {
      await eins.stop();
      await zwei.stop();
    }
  });

  // Dasselbe Muster in der Kontoanlage: das Fenster ist hier das await argon2.hash.
  // Zwei durchgelassene Anlagen brechen den „erster Benutzer = Admin"-Vertrag.
  it('zwei gleichzeitige auth/setup-POSTs legen nur ein Erstkonto an', async () => {
    const { app, db } = await noAccountApp();
    const antworten = await Promise.all(['anna', 'bert'].map((username) =>
      app.inject({ method: 'POST', url: '/api/v1/auth/setup', payload: { username, password: 'passwort-123' } }),
    ));
    expect(antworten.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(antworten.filter((r) => r.statusCode === 403)).toHaveLength(1);
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
    expect(n).toBe(1);
  });

  it('Setup-Routen sind im j-lawyer-Modus gesperrt (403)', async () => {
    const { app } = await noAccountApp({ jlawyerUrl: 'http://jl:8080/j-lawyer-io' });
    const res = await app.inject({ method: 'POST', url: '/api/v1/setup/jlawyer-test', payload: { url: 'http://x' } });
    expect(res.statusCode).toBe(403);
  });
});

describe('.jdesk-Export', () => {
    it('liefert ein ZIP mit Dateinamen aus dem Schreibtischnamen', async () => {
    const { app, db, userId, authHeaders } = await createTestApp();
    const desk = deskMitBesitzer(db, 'Mandat Meier', userId);
    const res = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/export`, headers: authHeaders });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toContain('Mandat Meier.jdesk');
    expect(res.rawPayload.subarray(0, 4)).toEqual(Buffer.from('PK\x03\x04', 'latin1'));
  });

  it('reinigt problematische Zeichen aus dem Dateinamen', async () => {
    const { app, db, userId, authHeaders } = await createTestApp();
    const desk = deskMitBesitzer(db, 'Meier / Müller: 12', userId);
    const res = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/export`, headers: authHeaders });
    expect(res.headers['content-disposition']).not.toContain('/');
  });

  it('meldet 404 für einen unbekannten Schreibtisch', async () => {
    const { app, authHeaders } = await createTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/desks/gibtsnicht/export', headers: authHeaders });
    expect(res.statusCode).toBe(404);
  });

  it('verlangt eine Anmeldung', async () => {
    const { app, db, userId } = await createTestApp();
    const desk = deskMitBesitzer(db, 'X', userId);
    const res = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/export` });
    expect(res.statusCode).toBe(401);
  });

  it('stürzt bei einem Schreibtischnamen mit eingebettetem Zeilenumbruch nicht ab', async () => {
    const { app, db, userId, authHeaders } = await createTestApp();
    const desk = deskMitBesitzer(db, 'Meier\r\nX-Injected: 1', userId);
    const res = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/export`, headers: authHeaders });
    expect(res.statusCode).toBe(200);
  });

  it('liefert bei Zeichen außerhalb Latin-1 einen filename*=UTF-8\'\'-Teil im Header', async () => {
    const { app, db, userId, authHeaders } = await createTestApp();
    const desk = deskMitBesitzer(db, 'Kanzlei – Müller €', userId);
    const res = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/export`, headers: authHeaders });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toContain(`filename*=UTF-8''${encodeURIComponent('Kanzlei – Müller €.jdesk')}`);
  });

  it('greift auf einen ASCII-sicheren Rückfallnamen zurück, wenn nur problematische Zeichen übrig bleiben', async () => {
    const { app, db, userId, authHeaders } = await createTestApp();
    const desk = deskMitBesitzer(db, '日本語', userId);
    const res = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/export`, headers: authHeaders });
    expect(res.statusCode).toBe(200);
    const header = res.headers['content-disposition'] as string;
    expect(header).toMatch(/filename="[\x20-\x7e]*"/);
    expect(header).toContain(`filename*=UTF-8''${encodeURIComponent('日本語.jdesk')}`);
  });

  it('kodiert ein wohlgeformtes Emoji-Surrogatpaar korrekt im filename*-Teil (Nicht-Filterungs-Invarianz über den ganzen Pfad)', async () => {
    const { app, db, userId, authHeaders } = await createTestApp();
    const desk = deskMitBesitzer(db, 'Akte 📎 Meier', userId);
    const res = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/export`, headers: authHeaders });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toContain(`filename*=UTF-8''${encodeURIComponent('Akte 📎 Meier.jdesk')}`);
  });

  // HIST-04: ein erfolgreicher .jdesk-Download hinterlässt genau eine eigene Journal-Zeile
  // (P-06) — die Grundlage für das 📤-Badge in der Aktivitätsansicht (04-05/04-06).
  it('journaliert genau eine exported-Zeile mit Akteurname, Format und unverändertem rev', async () => {
    const { app, db, userId, authHeaders } = await createTestApp();
    const desk = deskMitBesitzer(db, 'Mandat Export', userId);
    const vorher = getDeskState(db, desk.id)!;

    const res = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/export`, headers: authHeaders });
    expect(res.statusCode).toBe(200);

    const zeilen = db.prepare(
      "SELECT rev, actor_name AS actorName, payload FROM command_journal WHERE desk_id = ? AND type = 'exported'",
    ).all(desk.id) as { rev: number; actorName: string; payload: string }[];
    expect(zeilen).toHaveLength(1);
    expect(zeilen[0].actorName).toBe('test');
    expect(JSON.parse(zeilen[0].payload)).toEqual({ format: 'jdesk' });
    expect(zeilen[0].rev).toBe(vorher.rev); // Export ist kein Zustands-Write (desks.rev unverändert)
  });

  it('Rolle ohne Export-Recht (Nur-Lesen) ⇒ 403, KEINE exported-Zeile', async () => {
    const { app, db, a, b } = await createTestAppMitZweiNutzern();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Mandat Fremd' } })
    ).json() as { id: string };
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(desk.id, b.userId, 'Nur-Lesen');

    const res = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/export`, headers: b.authHeaders });
    expect(res.statusCode).toBe(403);

    const zeilen = db.prepare(
      "SELECT id FROM command_journal WHERE desk_id = ? AND type = 'exported'",
    ).all(desk.id);
    expect(zeilen).toHaveLength(0);
  });

  // HIST-04 (Aufgabe 3): Command → Export → Command darf keine rev-Lücke reißen — der Export
  // verbraucht keinen rev, die exported-Zeile trägt den rev des VORANGEGANGENEN Commands.
  it('Command→Export→Command: rev-Folge bleibt lückenlos, exported-Zeile trägt den vorangegangenen rev', async () => {
    const { app, db, dataDir, userId, authHeaders } = await createTestApp();
    const desk = deskMitBesitzer(db, 'Mandat Folge', userId);
    const metaA = storeFile(db, dataDir, pdf, 'a.pdf');
    const metaB = storeFile(db, dataDir, Buffer.from('%PDF-1.4\nzweite Datei'), 'b.pdf');

    const erst = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'addDoc', payload: { fileId: metaA.id, name: 'a.pdf', position: { x: 1, y: 2 }, id: 'id-a' } },
    });
    expect(erst.statusCode).toBe(200);
    expect(erst.json().rev).toBe(1);

    const exportRes = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/export`, headers: authHeaders });
    expect(exportRes.statusCode).toBe(200);

    const zweit = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'addDoc', payload: { fileId: metaB.id, name: 'b.pdf', position: { x: 3, y: 4 }, id: 'id-b' } },
    });
    expect(zweit.statusCode).toBe(200);
    expect(zweit.json().rev).toBe(2); // lückenlos — der Export dazwischen hat keinen rev verbraucht

    const zeile = db.prepare(
      "SELECT rev FROM command_journal WHERE desk_id = ? AND type = 'exported'",
    ).get(desk.id) as { rev: number };
    expect(zeile.rev).toBe(1); // trägt den rev des vorangegangenen (ersten) Commands, nicht des Folge-Commands
  });
});

describe('.jdesk-Import', () => {
    /** Baut einen Multipart-Body mit genau einer Datei (kein externes Paket nötig). */
  function multipart(bytes: Buffer, filename = 'paket.jdesk') {
    const grenze = '----jdesktest';
    const kopf = Buffer.from(
      `--${grenze}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      'Content-Type: application/octet-stream\r\n\r\n',
    );
    const fuss = Buffer.from(`\r\n--${grenze}--\r\n`);
    return {
      payload: Buffer.concat([kopf, bytes, fuss]),
      headers: { 'content-type': `multipart/form-data; boundary=${grenze}` },
    };
  }

  it('ersetzt den Schreibtisch und schreibt Dateien neu', async () => {
    const { app, db, dataDir, userId, authHeaders } = await createTestApp();
    const quelle = deskMitBesitzer(db, 'Quelle', userId);
    const meta = storeFile(db, dataDir, pdf, 'Akte.pdf');
    putDeskState(db, quelle.id, {
      docs: [{ id: 'd1', fileId: meta.id, name: 'Akte.pdf', position: { x: 5, y: 5 }, rotation: 0, zIndex: 1 }],
      links: [], stacks: [],
    });
    const paket = buildPackage(db, dataDir, quelle.id, { createdBy: 'a', jlawyer: false });

    const ziel = deskMitBesitzer(db, 'Ziel', userId);
    const m = multipart(paket);
    const res = await app.inject({
      method: 'POST', url: `/api/v1/desks/${ziel.id}/import`,
      headers: { ...authHeaders, ...m.headers }, payload: m.payload,
    });
    expect(res.statusCode).toBe(200);
    const zustand = getDeskState(db, ziel.id)!;
    expect(zustand.state.docs).toHaveLength(1);
    expect(zustand.state.docs[0].name).toBe('Akte.pdf');
    // Dedup über sha256: dieselben Bytes -> dieselbe fileId, Verweis bleibt gültig
    expect(fileExists(db, zustand.state.docs[0].fileId)).toBe(true);
  });

  it('journaliert den alten Zustand als snapshot, bevor er ersetzt wird', async () => {
    const { app, db, dataDir, userId, authHeaders } = await createTestApp();
    const quelle = deskMitBesitzer(db, 'Quelle', userId);
    const paket = buildPackage(db, dataDir, quelle.id, { createdBy: 'a', jlawyer: false });
    const ziel = deskMitBesitzer(db, 'Ziel', userId);
    putDeskState(db, ziel.id, {
      docs: [{ id: 'alt', fileId: 'f-alt', name: 'Alt.pdf', position: { x: 0, y: 0 }, rotation: 0, zIndex: 1 }],
      links: [], stacks: [],
    });
    const m = multipart(paket);
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${ziel.id}/import`,
      headers: { ...authHeaders, ...m.headers }, payload: m.payload,
    });
    const journal = await app.inject({ method: 'GET', url: `/api/v1/desks/${ziel.id}/journal`, headers: authHeaders });
    const typen = journal.json().entries.map((e: { type: string }) => e.type);
    expect(typen).toContain('snapshot');
    expect(typen).toContain('stateReplaced');
  });

  it('weist ein kaputtes Paket ab und lässt den Schreibtisch unberührt', async () => {
    const { app, db, userId, authHeaders } = await createTestApp();
    const ziel = deskMitBesitzer(db, 'Ziel', userId);
    putDeskState(db, ziel.id, {
      docs: [{ id: 'alt', fileId: 'f-alt', name: 'Alt.pdf', position: { x: 0, y: 0 }, rotation: 0, zIndex: 1 }],
      links: [], stacks: [],
    });
    const vorher = getDeskState(db, ziel.id)!.rev;
    const m = multipart(Buffer.from('kein zip'));
    const res = await app.inject({
      method: 'POST', url: `/api/v1/desks/${ziel.id}/import`,
      headers: { ...authHeaders, ...m.headers }, payload: m.payload,
    });
    expect(res.statusCode).toBe(400);
    expect(getDeskState(db, ziel.id)!.rev).toBe(vorher);
    expect(getDeskState(db, ziel.id)!.state.docs[0].id).toBe('alt');
  });

  it('meldet 404 für einen unbekannten Schreibtisch', async () => {
    const { app, db, dataDir, userId, authHeaders } = await createTestApp();
    const quelle = deskMitBesitzer(db, 'Quelle', userId);
    const m = multipart(buildPackage(db, dataDir, quelle.id, { createdBy: 'a', jlawyer: false }));
    const res = await app.inject({
      method: 'POST', url: '/api/v1/desks/gibtsnicht/import',
      headers: { ...authHeaders, ...m.headers }, payload: m.payload,
    });
    expect(res.statusCode).toBe(404);
  });

  /** Baut ein Roh-Paket ohne Umweg über buildPackage — für Zustände, die eine echte
      Exportfahrt nie erzeugen würde (kaputte Verknüpfung, leere eingebettete Datei). */
  function rohesPaket(
    state: unknown,
    dateien: Record<string, Uint8Array> = {},
    filesJson?: Record<string, { name: string }>,
  ): Buffer {
    const manifest = {
      format: 'jdesk',
      formatVersion: JDESK_FORMAT_VERSION,
      createdAt: Date.now(),
      createdBy: 'test',
      instanceId: 'inst',
      mode: filesJson ? 'self-contained' : 'linked',
      source: { kind: 'standalone', deskName: 'Kaputt' },
      rev: 1,
      counts: {},
    };
    const eintraege: Record<string, Uint8Array> = {
      'manifest.json': strToU8(JSON.stringify(manifest)),
      'workspace.json': strToU8(JSON.stringify(state)),
      ...dateien,
    };
    if (filesJson) eintraege['files.json'] = strToU8(JSON.stringify(filesJson));
    return Buffer.from(zipSync(eintraege));
  }

  it('weist ein Paket mit ungültigem Zustand (Verknüpfung ins Leere) ab und lässt den Schreibtisch unberührt', async () => {
    const { app, db, userId, authHeaders } = await createTestApp();
    const ziel = deskMitBesitzer(db, 'Ziel', userId);
    putDeskState(db, ziel.id, {
      docs: [{ id: 'alt', fileId: 'f-alt', name: 'Alt.pdf', position: { x: 0, y: 0 }, rotation: 0, zIndex: 1 }],
      links: [], stacks: [],
    });
    const vorher = getDeskState(db, ziel.id)!.rev;
    const kaputtesPaket = rohesPaket({
      docs: [], links: [{ id: 'l1', fromId: 'weg1', toId: 'weg2' }], stacks: [],
    });

    const m = multipart(kaputtesPaket);
    const res = await app.inject({
      method: 'POST', url: `/api/v1/desks/${ziel.id}/import`,
      headers: { ...authHeaders, ...m.headers }, payload: m.payload,
    });
    expect(res.statusCode).toBe(400);
    expect(getDeskState(db, ziel.id)!.rev).toBe(vorher);
    expect(getDeskState(db, ziel.id)!.state.docs[0].id).toBe('alt');
  });

  it('j-lawyer-Betrieb: Paket aus einer fremden Akte wird mit 409 abgelehnt, Ziel-Schreibtisch bleibt unberührt', async () => {
    const fake = await startFakeJLawyer();
    try {
      const db = openDb(':memory:');
      const dataDir = mkdtempSync(join(tmpdir(), 'dd-jl-import-fremd-'));
      const app = await buildApp({ db, dataDir, jlawyerUrl: fake.url });
      const { token } = (
        await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'anwalt', password: 'kanzlei123' } })
      ).json();
      const headers = { authorization: `Bearer ${token}` };
      // Beide Akten-Schreibtische anlegen (der Abgleich legt sie beim ersten Zugriff an).
      await app.inject({ method: 'GET', url: '/api/v1/cases/akte-1/desk', headers });
      await app.inject({ method: 'GET', url: '/api/v1/cases/akte-2/desk', headers });
      // Paket stammt aus akte-2, Ziel ist akte-1.
      const paketFremd = buildPackage(db, dataDir, 'akte-2', { createdBy: 'a', jlawyer: true });

      const vorher = getDeskState(db, 'akte-1')!;
      const m = multipart(paketFremd);
      const res = await app.inject({
        method: 'POST', url: '/api/v1/desks/akte-1/import',
        headers: { ...headers, ...m.headers }, payload: m.payload,
      });
      expect(res.statusCode).toBe(409);
      const nachher = getDeskState(db, 'akte-1')!;
      expect(nachher.rev).toBe(vorher.rev);
      expect(nachher.state.docs).toEqual(vorher.state.docs);
      await app.close();
    } finally {
      await fake.stop();
    }
  });

  it('j-lawyer-Betrieb: Paket aus derselben Akte (Wiederherstellung) geht durch', async () => {
    const fake = await startFakeJLawyer();
    try {
      const db = openDb(':memory:');
      const dataDir = mkdtempSync(join(tmpdir(), 'dd-jl-import-gleich-'));
      const app = await buildApp({ db, dataDir, jlawyerUrl: fake.url });
      const { token } = (
        await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'anwalt', password: 'kanzlei123' } })
      ).json();
      const headers = { authorization: `Bearer ${token}` };
      await app.inject({ method: 'GET', url: '/api/v1/cases/akte-1/desk', headers });
      const paket = buildPackage(db, dataDir, 'akte-1', { createdBy: 'a', jlawyer: true });

      const m = multipart(paket);
      const res = await app.inject({
        method: 'POST', url: '/api/v1/desks/akte-1/import',
        headers: { ...headers, ...m.headers }, payload: m.payload,
      });
      expect(res.statusCode).toBe(200);
      await app.close();
    } finally {
      await fake.stop();
    }
  });

  it('weist ein Paket mit einer leeren eingebetteten Datei ab und lässt den Schreibtisch samt files-Tabelle unberührt', async () => {
    const { app, db, userId, authHeaders } = await createTestApp();
    const ziel = deskMitBesitzer(db, 'Ziel', userId);
    putDeskState(db, ziel.id, {
      docs: [{ id: 'alt', fileId: 'f-alt', name: 'Alt.pdf', position: { x: 0, y: 0 }, rotation: 0, zIndex: 1 }],
      links: [], stacks: [],
    });
    const vorher = getDeskState(db, ziel.id)!.rev;
    const { n: dateienVorher } = db.prepare('SELECT COUNT(*) AS n FROM files').get() as { n: number };

    // fileA hat frischen, bisher unbekannten Inhalt (kein Dedup-Treffer möglich) — landete er
    // trotzdem in der files-Tabelle, wäre das ein sichtbarer Beweis für einen Teil-Import, weil
    // die Schleife erst bei fileB (leer) scheitert.
    const kaputtesPaket = rohesPaket(
      { docs: [{ id: 'd1', fileId: 'fileA', name: 'A.pdf', position: { x: 0, y: 0 }, rotation: 0, zIndex: 1 }], links: [], stacks: [] },
      {
        'files/fileA': strToU8('brandneuer, bisher unbekannter Inhalt'),
        'files/fileB': new Uint8Array(0),
      },
      { fileA: { name: 'A.pdf' }, fileB: { name: 'B.pdf' } },
    );

    const m = multipart(kaputtesPaket);
    const res = await app.inject({
      method: 'POST', url: `/api/v1/desks/${ziel.id}/import`,
      headers: { ...authHeaders, ...m.headers }, payload: m.payload,
    });
    expect(res.statusCode).toBe(400);
    expect(getDeskState(db, ziel.id)!.rev).toBe(vorher);
    expect(getDeskState(db, ziel.id)!.state.docs[0].id).toBe('alt');
    const { n: dateienNachher } = db.prepare('SELECT COUNT(*) AS n FROM files').get() as { n: number };
    expect(dateienNachher).toBe(dateienVorher);
  });

  it('j-lawyer-Betrieb: Paket ohne source wird mit 400 (nicht 500) abgelehnt', async () => {
    const fake = await startFakeJLawyer();
    try {
      const db = openDb(':memory:');
      const dataDir = mkdtempSync(join(tmpdir(), 'dd-jl-import-ohne-source-'));
      const app = await buildApp({ db, dataDir, jlawyerUrl: fake.url });
      const { token } = (
        await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'anwalt', password: 'kanzlei123' } })
      ).json();
      const headers = { authorization: `Bearer ${token}` };
      await app.inject({ method: 'GET', url: '/api/v1/cases/akte-1/desk', headers });

      // Strukturell gültig (Format, Version), aber ohne source — genau die Lücke, die
      // readPackage jetzt schließt. Vorher lief das bis app.ts:625 durch und krachte dort mit
      // einem rohen TypeError (500) statt mit dem sauberen 400 dieser Route.
      const manifestOhneSource = {
        format: 'jdesk', formatVersion: JDESK_FORMAT_VERSION, createdAt: Date.now(), createdBy: 'test',
        instanceId: 'inst', mode: 'linked', rev: 1, counts: {},
      };
      const paketOhneSource = Buffer.from(zipSync({
        'manifest.json': strToU8(JSON.stringify(manifestOhneSource)),
        'workspace.json': strToU8(JSON.stringify({ docs: [], links: [], stacks: [] })),
      }));

      const m = multipart(paketOhneSource);
      const res = await app.inject({
        method: 'POST', url: '/api/v1/desks/akte-1/import',
        headers: { ...headers, ...m.headers }, payload: m.payload,
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    } finally {
      await fake.stop();
    }
  });

  it('Eigenständig-Betrieb: Paket aus dem j-lawyer-Betrieb wird mit 409 abgelehnt, Ziel-Schreibtisch bleibt unberührt', async () => {
    const { app, db, userId, authHeaders } = await createTestApp();
    const ziel = deskMitBesitzer(db, 'Ziel', userId);
    putDeskState(db, ziel.id, {
      docs: [{ id: 'alt', fileId: 'f-alt', name: 'Alt.pdf', position: { x: 0, y: 0 }, rotation: 0, zIndex: 1 }],
      links: [], stacks: [],
    });
    const vorher = getDeskState(db, ziel.id)!;

    // Paket stammt aus einer j-lawyer-Betrieb-Instanz (source.kind: 'jlawyer').
    const paketJlawyer = Buffer.from(zipSync({
      'manifest.json': strToU8(JSON.stringify({
        format: 'jdesk', formatVersion: JDESK_FORMAT_VERSION, createdAt: Date.now(), createdBy: 'anwalt',
        instanceId: 'fremd', mode: 'linked', source: { kind: 'jlawyer', caseId: 'akte-9', deskName: 'Akte X' },
        rev: 1, counts: {},
      })),
      'workspace.json': strToU8(JSON.stringify({ docs: [], links: [], stacks: [] })),
    }));

    const m = multipart(paketJlawyer);
    const res = await app.inject({
      method: 'POST', url: `/api/v1/desks/${ziel.id}/import`,
      headers: { ...authHeaders, ...m.headers }, payload: m.payload,
    });
    expect(res.statusCode).toBe(409);
    const nachher = getDeskState(db, ziel.id)!;
    expect(nachher.rev).toBe(vorher.rev);
    expect(nachher.state.docs).toEqual(vorher.state.docs);
  });
});

describe('Konflikt beim Command', () => {
  it('antwortet 409 mit beschreibendem Koerper', async () => {
    const { app, db, userId, authHeaders } = await createTestApp();
    const desk = deskMitBesitzer(db, 'Test', userId);
    const deskId = desk.id;
    try {
      const erste = await app.inject({
        method: 'POST', url: `/api/v1/desks/${deskId}/commands`,
        headers: authHeaders,
        payload: { type: 'addNote', payload: { id: 'n1', kind: 'notiz', text: 'Erst', position: { x: 1, y: 1 } } },
      });
      expect(erste.statusCode).toBe(200);

      const res = await app.inject({
        method: 'POST', url: `/api/v1/desks/${deskId}/commands`,
        headers: authHeaders,
        payload: { type: 'editNote', payload: { id: 'n1', text: 'Danach' }, erwartet: { n1: 999 } },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().konflikt).toMatchObject({ objektId: 'n1', typ: 'notes', art: 'geaendert' });
    } finally {
      await app.close();
    }
  });

  it('nimmt einen Command ohne Erwartung weiterhin an', async () => {
    const { app, db, userId, authHeaders } = await createTestApp();
    const desk = deskMitBesitzer(db, 'Test', userId);
    const deskId = desk.id;
    try {
      const res = await app.inject({
        method: 'POST', url: `/api/v1/desks/${deskId}/commands`,
        headers: authHeaders,
        payload: { type: 'addNote', payload: { kind: 'notiz', text: 'Ohne Erwartung', position: { x: 1, y: 1 } } },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});

describe('WR-05: Auto-Archiv-Rolle fail-closed statt fail-open', () => {
  it('GET /cases/:id/desk liefert die Rolle des Nutzers weiterhin für die Antwort/Projektion (Bestandsverhalten)', async () => {
    const fake = await startFakeJLawyer();
    try {
      const db = openDb(':memory:');
      const dataDir = mkdtempSync(join(tmpdir(), 'dd-jl-wr05-'));
      const app = await buildApp({ db, dataDir, jlawyerUrl: fake.url });
      const { token } = (
        await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'anwalt', password: 'kanzlei123' } })
      ).json();
      const headers = { authorization: `Bearer ${token}` };

      const res = await app.inject({ method: 'GET', url: '/api/v1/cases/akte-1/desk', headers });
      expect(res.statusCode).toBe(200);
      expect(res.json().rolle).toBe('Eigentümer'); // erstmaliger Abgleich legt den Eigentümer an (ensureBearbeiterRolle)

      await app.close();
    } finally {
      await fake.stop();
    }
  });

  it('eine im selben Moment unauflösbare Rolle überspringt NUR die Automatiksicherung (protokolliert), lässt die Antwort selbst aber unverändert bei 200 mit rolle \'Eigentümer\'', async () => {
    const fake = await startFakeJLawyer();
    const deskStoreNs = await import('./deskStore');
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const db = openDb(':memory:');
      const dataDir = mkdtempSync(join(tmpdir(), 'dd-jl-wr05-'));
      const app = await buildApp({ db, dataDir, jlawyerUrl: fake.url });
      const { token } = (
        await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'anwalt', password: 'kanzlei123' } })
      ).json();
      const headers = { authorization: `Bearer ${token}` };

      // Erster Abgleich: normaler Erfolgspfad, legt die Rolle über ensureBearbeiterRolle an.
      await app.inject({ method: 'GET', url: '/api/v1/cases/akte-1/desk', headers });
      consoleErrorSpy.mockClear();

      // Die Rolle ist laut Code-Kommentar in app.ts "nach dem erfolgreichen Abgleich garantiert
      // gesetzt" — aber NICHT durch einen lokalen Check erzwungen (genau die WR-05-Lücke). Ein
      // vi.spyOn simuliert exakt diesen (laut Reviewer nur durch Konvention verhinderten) Fall:
      // getRolleForNutzer() liefert null, obwohl der Abgleich selbst erfolgreich durchläuft.
      const spy = vi.spyOn(deskStoreNs, 'getRolleForNutzer').mockReturnValue(null);
      try {
        const res = await app.inject({ method: 'GET', url: '/api/v1/cases/akte-1/desk', headers });
        // Die AUSGELIEFERTE Antwort bleibt unverändert (Bestandsverhalten, WR-04/PERM-05: der
        // Client braucht die Rolle für die UI) — WR-05 betrifft ausschliesslich, OB die
        // Automatiksicherung mit dieser Rolle läuft.
        expect(res.statusCode).toBe(200);
        expect(res.json().rolle).toBe('Eigentümer');
      } finally {
        spy.mockRestore();
      }

      // Die Automatiksicherung wurde übersprungen und protokolliert — fail-closed statt
      // still mit der meistprivilegierten Rolle 'Eigentümer' zu archivieren.
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Automatische .jdesk-Sicherung übersprungen'),
      );

      await app.close();
    } finally {
      consoleErrorSpy.mockRestore();
      await fake.stop();
    }
  });
});
