import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from './app';
import { openDb } from './db';
import { startFakeJLawyer, type FakeJLawyer } from './testJLawyer';
import { extrahiereText } from './export/verify';

/**
 * EXT-01 (13-06 Task 1): POST /api/v1/cases/:id/aufnahme gegen die gefakte j-lawyer-
 * Außenstelle (jlawyer.test.ts-Muster) — bewiesen wird die Sequenz „erst j-lawyer
 * bestätigen, dann die Karte" (kein Optimismus), die art-Whitelist und die Pflichtfeld-
 * Validierung VOR jedem Außenstellen-Aufruf.
 */

let fake: FakeJLawyer;
beforeAll(async () => { fake = await startFakeJLawyer(); });
afterAll(() => fake.stop());

async function jlApp() {
  const db = openDb(':memory:');
  const dataDir = mkdtempSync(join(tmpdir(), 'dd-aufnahme-'));
  const app = await buildApp({ db, dataDir, jlawyerUrl: fake.url });
  return { app, db, dataDir };
}

async function login(app: Awaited<ReturnType<typeof buildApp>>) {
  const { token } = (
    await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'anwalt', password: 'kanzlei123' } })
  ).json();
  return { authorization: `Bearer ${token}` };
}

describe('POST /api/v1/cases/:id/aufnahme', () => {
  it('art urteil: 201, PDF an der Außenstelle (Magic-Bytes + Metazeilen), echte Doc-Karte ohne extern-Feld', async () => {
    const { app } = await jlApp();
    const h = await login(app);
    const vorherDocs = fake.documents.get('akte-2')!.length;
    const r = await app.inject({
      method: 'POST', url: '/api/v1/cases/akte-2/aufnahme',
      headers: h,
      payload: { art: 'urteil', felder: { gericht: 'Amtsgericht Musterstadt', aktenzeichen: '12 C 345/26', datum: '2026-01-15' }, name: 'BGH-Urteil' },
    });
    expect(r.statusCode).toBe(201);
    const body = r.json();
    expect(body.state.docs.some((d: { name: string }) => d.name === 'BGH-Urteil.pdf')).toBe(true);
    const karte = body.state.docs.find((d: { name: string }) => d.name === 'BGH-Urteil.pdf');
    expect(karte.extern).toBeUndefined();
    expect(karte.kind).toBe('pdf');

    // Die gefakte Außenstelle wurde tatsächlich mit einem echten PDF aufgerufen.
    const jlDocs = fake.documents.get('akte-2')!;
    expect(jlDocs).toHaveLength(vorherDocs + 1);
    const jlDoc = jlDocs[jlDocs.length - 1];
    expect(jlDoc.bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(karte.fileId).toBe(jlDoc.id);
    // Metazeilen enthalten Gericht/Aktenzeichen — normatives Orakel ist die pdfjs-Extraktion
    // (Rohtext-Suche auf PDF-Bytes ist ein dokumentiertes Anti-Pattern, export/verify.ts).
    const text = await extrahiereText(new Uint8Array(jlDoc.bytes));
    expect(text).toContain('Amtsgericht Musterstadt');
    expect(text).toContain('12 C 345/26');
    await app.close();
  });

  it('art norm: synthetisiert ein PDF mit Gesetz/Paragraf', async () => {
    const { app } = await jlApp();
    const h = await login(app);
    const r = await app.inject({
      method: 'POST', url: '/api/v1/cases/akte-2/aufnahme',
      headers: h,
      payload: { art: 'norm', felder: { gesetz: 'BGB', paragraf: '§ 433' } },
    });
    expect(r.statusCode).toBe(201);
    const jlDocs = fake.documents.get('akte-2')!;
    const jlDoc = jlDocs[jlDocs.length - 1];
    const text = await extrahiereText(new Uint8Array(jlDoc.bytes));
    expect(text).toContain('BGB');
    expect(text).toContain('§ 433');
    await app.close();
  });

  it('art textfragment: synthetisiert ein PDF mit dem Fließtext', async () => {
    const { app } = await jlApp();
    const h = await login(app);
    const r = await app.inject({
      method: 'POST', url: '/api/v1/cases/akte-2/aufnahme',
      headers: h,
      payload: { art: 'textfragment', felder: { text: 'Ein wichtiges Zitat aus einem Telefonat.', quelle: 'Mandant Handy' } },
    });
    expect(r.statusCode).toBe(201);
    const jlDocs = fake.documents.get('akte-2')!;
    const jlDoc = jlDocs[jlDocs.length - 1];
    const text = await extrahiereText(new Uint8Array(jlDoc.bytes));
    expect(text).toContain('Ein wichtiges Zitat aus einem Telefonat.');
    expect(text).toContain('Mandant Handy');
    await app.close();
  });

  it('unbekannte art lehnt mit 400 ab', async () => {
    const { app } = await jlApp();
    const h = await login(app);
    const r = await app.inject({
      method: 'POST', url: '/api/v1/cases/akte-2/aufnahme',
      headers: h,
      payload: { art: 'sonstiges', felder: {} },
    });
    expect(r.statusCode).toBe(400);
    await app.close();
  });

  it.each(['email', 'foto', 'medien', 'weblink'])('Datei-/Weblink-Art "%s" lehnt diese Route strukturell mit 400 ab', async (art) => {
    const { app } = await jlApp();
    const h = await login(app);
    const r = await app.inject({
      method: 'POST', url: '/api/v1/cases/akte-2/aufnahme',
      headers: h,
      payload: { art, felder: {} },
    });
    expect(r.statusCode).toBe(400);
    await app.close();
  });

  it('fehlende Pflichtfelder (urteil ohne gericht/aktenzeichen) -> 400 mit deutschem Feldnamen, Außenstelle NICHT aufgerufen', async () => {
    const { app } = await jlApp();
    const h = await login(app);
    const vorher = fake.documents.get('akte-2')!.length;
    const r = await app.inject({
      method: 'POST', url: '/api/v1/cases/akte-2/aufnahme',
      headers: h,
      payload: { art: 'urteil', felder: {} },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toContain('gericht');
    expect(fake.documents.get('akte-2')).toHaveLength(vorher);
    await app.close();
  });

  it('fehlende Pflichtfelder (norm ohne gesetz/paragraf) -> 400, Außenstelle NICHT aufgerufen', async () => {
    const { app } = await jlApp();
    const h = await login(app);
    const vorher = fake.documents.get('akte-2')!.length;
    const r = await app.inject({
      method: 'POST', url: '/api/v1/cases/akte-2/aufnahme',
      headers: h,
      payload: { art: 'norm', felder: { gesetz: 'BGB' } },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toContain('paragraf');
    expect(fake.documents.get('akte-2')).toHaveLength(vorher);
    await app.close();
  });

  it('fehlende Pflichtfelder (textfragment ohne text) -> 400, Außenstelle NICHT aufgerufen', async () => {
    const { app } = await jlApp();
    const h = await login(app);
    const vorher = fake.documents.get('akte-2')!.length;
    const r = await app.inject({
      method: 'POST', url: '/api/v1/cases/akte-2/aufnahme',
      headers: h,
      payload: { art: 'textfragment', felder: {} },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toContain('text');
    expect(fake.documents.get('akte-2')).toHaveLength(vorher);
    await app.close();
  });

  it('WR-01: zu langes Pflichtfeld (felder.text) -> 400, Außenstelle NICHT aufgerufen (keine PDF-Synthese)', async () => {
    const { app } = await jlApp();
    const h = await login(app);
    const vorher = fake.documents.get('akte-2')!.length;
    const r = await app.inject({
      method: 'POST', url: '/api/v1/cases/akte-2/aufnahme',
      headers: h,
      payload: { art: 'textfragment', felder: { text: 'x'.repeat(5001) } },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toContain('text');
    expect(fake.documents.get('akte-2')).toHaveLength(vorher);
    await app.close();
  });

  it('WR-01: zu langes optionales Feld (felder.quelle) wird gekappt statt abgelehnt', async () => {
    const { app } = await jlApp();
    const h = await login(app);
    const r = await app.inject({
      method: 'POST', url: '/api/v1/cases/akte-2/aufnahme',
      headers: h,
      payload: { art: 'textfragment', felder: { text: 'Kurzes Zitat.', quelle: 'q'.repeat(5001) } },
    });
    expect(r.statusCode).toBe(201);
    const jlDocs = fake.documents.get('akte-2')!;
    const jlDoc = jlDocs[jlDocs.length - 1];
    const text = await extrahiereText(new Uint8Array(jlDoc.bytes));
    expect(text).toContain('q'.repeat(50)); // gekappter Wert wurde trotzdem übernommen
    await app.close();
  });

  it('j-lawyer-Fehler -> kein Karten-Optimismus: state.docs und rev bleiben unverändert', async () => {
    const { app } = await jlApp();
    const h = await login(app);
    // Desk öffnen (materialisiert rev=0 + Baseline) — akte-1 hat zwei Bestandsdokumente.
    const baseline = (await app.inject({ method: 'GET', url: '/api/v1/cases/akte-1/desk', headers: h })).json();
    // Außenstelle für akte-1 "kaputt machen": document/create UND die Sync-Liste scheitern
    // serverseitig mit 500 (testJLawyer.ts: documents.get() liefert undefined -> json(500,{})).
    const echt = fake.documents.get('akte-1')!;
    fake.documents.delete('akte-1');
    try {
      const r = await app.inject({
        method: 'POST', url: '/api/v1/cases/akte-1/aufnahme',
        headers: h,
        payload: { art: 'urteil', felder: { gericht: 'Landgericht', aktenzeichen: '1 O 2/26' } },
      });
      expect(r.statusCode).toBeGreaterThanOrEqual(400);
      // Ausfall-Fallback liefert den letzten bekannten Stand — unverändert gegenüber der Baseline.
      const danach = (await app.inject({ method: 'GET', url: '/api/v1/cases/akte-1/desk', headers: h })).json();
      expect(danach.rev).toBe(baseline.rev);
      expect(danach.state.docs).toHaveLength(baseline.state.docs.length);
    } finally {
      fake.documents.set('akte-1', echt);
    }
    await app.close();
  });
});
