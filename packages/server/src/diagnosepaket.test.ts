import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { openDb } from './db';
import { buildApp } from './app';
import { createUser, login } from './auth';
import { storeFile } from './files';
import { baueDiagnosepaket } from './diagnosepaket';
import { createTestAppMitZweiNutzern } from './testUtils';

/**
 * Diagnosepaket (OPS-02/OPS-05, 14-06): Feldliste + Geheimnis-Gegenprobe (Task 2). Die
 * Gegenprobe ist der Kern dieses Tasks — sie ist der Grund, warum das Paket überhaupt
 * herausgegeben werden darf (T-14-06-01).
 */
describe('Task 2: baueDiagnosepaket() — zugesagte Felder', () => {
  it('enthält Versionen, Laufzeitangaben, Betriebsmodus, Verbindungszustände, Speicher-/Sicherungskennzahlen, Zählwerte und einen Erstellungszeitpunkt', async () => {
    const db = openDb(':memory:');
    const dataDir = mkdtempSync(join(tmpdir(), 'dd-server-'));
    await createUser(db, 'nutzer-a', 'test-passwort');

    const paket = await baueDiagnosepaket({ db, dataDir, jlBase: undefined, convert: null, backupTaktStunden: 6 });

    expect(paket.erstelltAm).toBeTruthy();
    expect(new Date(paket.erstelltAm).toString()).not.toBe('Invalid Date');
    expect(paket.anwendungsVersion).toBeTruthy();
    expect(typeof paket.schemaVersion).toBe('number');
    expect(paket.nodeVersion).toBe(process.version);
    expect(paket.plattform).toBeTruthy();
    expect(paket.architektur).toBeTruthy();
    expect(paket.laufzeitSekunden).toBeGreaterThanOrEqual(0);
    expect(paket.betriebsmodus).toBe('eigenstaendig');
    expect(paket.verbindungen.length).toBeGreaterThan(0);
    expect(paket.speicher.length).toBeGreaterThan(0);
    expect(paket.backup.length).toBeGreaterThan(0);
    expect(paket.zaehlwerte).toEqual({ schreibtische: 0, dateien: 0, journalzeilen: 0, nutzer: 1 });
  });

  it('Betriebsmodus/j-lawyer-Verbindungszeile spiegeln den j-lawyer-Modus, ohne die Basis-URL selbst preiszugeben', async () => {
    const db = openDb(':memory:');
    const dataDir = mkdtempSync(join(tmpdir(), 'dd-server-'));
    // Schnell verweigernde Adresse (ECONNREFUSED, kein DNS-Roundtrip) — Bestandsmuster wie in
    // diagnose.test.ts, hält den Test schnell und deterministisch.
    const paket = await baueDiagnosepaket({
      db, dataDir, jlBase: 'http://127.0.0.1:1/j-lawyer-io', convert: null, backupTaktStunden: 6,
    });
    expect(paket.betriebsmodus).toBe('j-lawyer');
    const jlawyerZeile = paket.verbindungen.find((z) => z.label === 'j-lawyer');
    expect(jlawyerZeile).toBeTruthy();
    expect(JSON.stringify(jlawyerZeile)).not.toContain('127.0.0.1:1');
  });
});

describe('Task 2: Geheimnis-Gegenprobe — keine Mandanten-/Zugangsdaten im Paket', () => {
  it('eingeschleuste Zugangsmerkmale (Convert-JWT-Secret + Adresse), Dateiname/-inhalt und Nutzername/Passwort-Hash tauchen im erzeugten Paket an keiner Stelle als Zeichenkette auf', async () => {
    const db = openDb(':memory:');
    const dataDir = mkdtempSync(join(tmpdir(), 'dd-server-'));
    const GEHEIMES_JWT_SECRET = 'geheimes-jwt-secret-9f3a7c21';
    // Schnell verweigernde Adresse (ECONNREFUSED, kein DNS-Roundtrip, deterministisch/schnell —
    // Bestandsmuster diagnose.test.ts); der ungewöhnliche Port macht sie im Paket eindeutig
    // wiedererkennbar, falls sie doch (versehentlich) durchsickern würde.
    const GEHEIME_CONVERT_ADRESSE = '127.0.0.1:1';
    const GEHEIMER_DATEIINHALT = 'MANDANT-VERTRAULICH-INHALT-1a2b3c';
    const GEHEIMER_DATEINAME = 'Mandant-Mustermann-Scheidungsklage.pdf';
    const GEHEIMER_NUTZERNAME = 'anwaeltin-geheim';
    const GEHEIMES_PASSWORT = 'ein-sehr-geheimes-passwort-xyz789';

    const userId = await createUser(db, GEHEIMER_NUTZERNAME, GEHEIMES_PASSWORT);
    storeFile(db, dataDir, Buffer.from(GEHEIMER_DATEIINHALT), GEHEIMER_DATEINAME);

    const paket = await baueDiagnosepaket({
      db, dataDir,
      jlBase: undefined,
      convert: { url: `http://${GEHEIME_CONVERT_ADRESSE}`, jwtSecret: GEHEIMES_JWT_SECRET },
      backupTaktStunden: 6,
    });
    const paketText = JSON.stringify(paket);

    expect(paketText).not.toContain(GEHEIMES_JWT_SECRET);
    expect(paketText).not.toContain(GEHEIME_CONVERT_ADRESSE);
    expect(paketText).not.toContain(GEHEIMER_DATEIINHALT);
    expect(paketText).not.toContain(GEHEIMER_DATEINAME);
    expect(paketText).not.toContain(GEHEIMER_NUTZERNAME);
    expect(paketText).not.toContain(GEHEIMES_PASSWORT);

    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId) as { password_hash: string };
    expect(paketText).not.toContain(row.password_hash);

    // Positiv-Probe: die Aussage „eingerichtet" (Zustand statt Wert) bleibt sichtbar.
    const euroOfficeZeile = paket.verbindungen.find((z) => z.label === 'Euro-Office-Vorschau');
    expect(euroOfficeZeile?.status).not.toBe('nicht-konfiguriert');
  });
});

describe('Task 2: GET /desks/:id/diagnosepaket — Eigentümer-Gate + Download', () => {
  it('Eigentümer bekommt einen Download mit passendem Inhaltstyp und Dateinamen', async () => {
    const db = openDb(':memory:');
    const dataDir = mkdtempSync(join(tmpdir(), 'dd-server-'));
    await createUser(db, 'nutzer-a', 'test-passwort');
    const token = (await login(db, 'nutzer-a', 'test-passwort'))!;
    const authHeaders = { authorization: `Bearer ${token}` };
    const app = await buildApp({ db, dataDir });
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'Akte A' } })
    ).json();

    const res = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/diagnosepaket`, headers: authHeaders });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['content-disposition']).toContain('j-desk-diagnosepaket-');
    expect(res.headers['content-disposition']).toContain('.json');
    const paket = res.json();
    expect(paket.zaehlwerte.schreibtische).toBe(1);
  });

  it('Kommentator bekommt 403', async () => {
    const { app, db, a, b } = await createTestAppMitZweiNutzern();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte A' } })
    ).json();
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(desk.id, b.userId, 'Kommentator');

    const res = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/diagnosepaket`, headers: b.authHeaders });
    expect(res.statusCode).toBe(403);
  });
});
