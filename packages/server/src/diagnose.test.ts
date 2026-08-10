import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { openDb } from './db';
import { buildApp } from './app';
import { createUser, login } from './auth';
import { probeEuroOffice } from './diagnose';
import { createTestAppMitZweiNutzern } from './testUtils';
import { storeFile } from './files';
import { BACKUP_DIR } from './backup';

/**
 * Systemdiagnose (OPS-02, 14-01): serverseitiges Eigentümer-Gate + SYSTEM-Abschnitt (Task 1,
 * Tracer). Analog `app.roles.test.ts`: app.inject() gegen die echte App, zwei Nutzer mit
 * unterschiedlichen Rollen, 403/200/404 als Zusicherung.
 */
describe('Task 1: GET /desks/:id/diagnose — Eigentümer-Gate + SYSTEM-Abschnitt', () => {
  it('Eigentümer bekommt 200 mit den vier SYSTEM-Zeilen (Version, Schema, Node, Modus)', async () => {
    const { app, db, a } = await createTestAppMitZweiNutzern();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte A' } })
    ).json();

    const res = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/diagnose`, headers: a.authHeaders });
    expect(res.statusCode).toBe(200);
    const bericht = res.json();

    const schemaVersion = db.pragma('user_version', { simple: true });
    const zeile = (label: string): { wert?: string } | undefined =>
      bericht.system.find((z: { label: string }) => z.label === label);

    expect(zeile('J-Desk-Version')?.wert).toBeTruthy();
    expect(zeile('Datenbankschema')?.wert).toBe(String(schemaVersion));
    expect(zeile('Node-Laufzeit')?.wert).toBe(process.version);
    // Ohne j-lawyer-Basis (createTestAppMitZweiNutzern baut ohne jlawyerUrl) ist der Modus
    // 'eigenstaendig' — der Betriebsmodus liest sich am Vorhandensein der j-lawyer-Basis-URL ab.
    expect(zeile('Betriebsmodus')?.wert).toBe('eigenstaendig');
  });

  it('Kommentator bekommt 403 — Ausblenden des Toolbar-Buttons im Client ist keine Grenze', async () => {
    const { app, db, a, b } = await createTestAppMitZweiNutzern();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte A' } })
    ).json();
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(desk.id, b.userId, 'Kommentator');

    const res = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/diagnose`, headers: b.authHeaders });
    expect(res.statusCode).toBe(403);
  });

  it('unbekannter Desk bleibt 404 (nicht 403) — Guard-Semantik bleibt gewahrt', async () => {
    const { app, a } = await createTestAppMitZweiNutzern();
    const res = await app.inject({ method: 'GET', url: '/api/v1/desks/gibtsnicht/diagnose', headers: a.authHeaders });
    expect(res.statusCode).toBe(404);
  });
});

/** Baut eine eigenständige App+Desk (ein Nutzer, automatisch Eigentümer) mit wählbarer
 *  Euro-Office-Konfiguration und wählbarem Backup-Takt — createTestAppMitZweiNutzern kennt
 *  weder `convert` noch `backupIntervalHours`. Gibt `db`/`dataDir` mit zurück (Task 1/2 stellen
 *  Dateien/Backups direkt gegen dieselbe dataDir her, gegen die die Route liest).
 *  `dateibasierteDb`: die Systemdiagnose-Tests aus 14-01 laufen bewusst gegen `:memory:`
 *  (schneller, kein Backup-Bezug); die BACKUP-/„Jetzt sichern"-Tests (14-06) brauchen eine
 *  echte `desktop.sqlite`-Datei — `rotateBackup()` prüft `existsSync(dbFile)` und tut sonst
 *  nichts (backup.ts). */
async function baueEigentuemerDesk(opts?: {
  convert?: { url: string; jwtSecret: string } | null;
  backupIntervalHours?: number;
  dateibasierteDb?: boolean;
}): Promise<{
  app: Awaited<ReturnType<typeof buildApp>>;
  db: ReturnType<typeof openDb>;
  dataDir: string;
  authHeaders: { authorization: string };
  desk: { id: string };
}> {
  const dataDir = mkdtempSync(join(tmpdir(), 'dd-server-'));
  const db = openDb(opts?.dateibasierteDb ? join(dataDir, 'desktop.sqlite') : ':memory:');
  await createUser(db, 'nutzer-a', 'test-passwort');
  const token = (await login(db, 'nutzer-a', 'test-passwort'))!;
  const authHeaders = { authorization: `Bearer ${token}` };
  const app = await buildApp({
    db, dataDir,
    ...(opts?.convert !== undefined ? { convert: opts.convert } : {}),
    ...(opts?.backupIntervalHours !== undefined ? { backupIntervalHours: opts.backupIntervalHours } : {}),
  });
  const desk = (
    await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'Akte A' } })
  ).json();
  return { app, db, dataDir, authHeaders, desk };
}

describe('Task 2: VERBINDUNGEN-Abschnitt — j-lawyer wiederverwenden, Euro-Office-Ping neu', () => {
  it('ohne j-lawyer-Basis und ohne Euro-Office-Konfiguration: Server ok, beide optionalen Verbindungen nicht-konfiguriert (E2/partial)', async () => {
    const { app, authHeaders, desk } = await baueEigentuemerDesk();
    const res = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/diagnose`, headers: authHeaders });
    expect(res.statusCode).toBe(200);
    const verbindungen = res.json().verbindungen as { status: string; label: string }[];
    // Die Zeilen fehlen nie, sie tragen nur einen anderen Zustand.
    expect(verbindungen).toHaveLength(3);
    expect(verbindungen.find((z) => z.label === 'Server')?.status).toBe('ok');
    expect(verbindungen.find((z) => z.label === 'j-lawyer')?.status).toBe('nicht-konfiguriert');
    expect(verbindungen.find((z) => z.label === 'Euro-Office-Vorschau')?.status).toBe('nicht-konfiguriert');
  });

  it('nicht erreichbare Euro-Office-URL erzeugt eine fehler-Zeile mit einzeiliger Klartextursache + Empfehlung — die Server-Zeile bleibt unberührt ok', async () => {
    // Verweigerte Verbindung statt Timeout (schnell, ECONNREFUSED) — die Timeout-Eigenschaft
    // selbst wird unten separat direkt gegen probeEuroOffice geprüft.
    const { app, authHeaders, desk } = await baueEigentuemerDesk({ convert: { url: 'http://127.0.0.1:1', jwtSecret: 'x' } });
    const res = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/diagnose`, headers: authHeaders });
    expect(res.statusCode).toBe(200);
    const verbindungen = res.json().verbindungen as { status: string; label: string; ursache?: string; empfehlung?: string }[];

    // Eine fehlgeschlagene Prüfung blockiert die anderen nicht.
    expect(verbindungen.find((z) => z.label === 'Server')?.status).toBe('ok');

    const euroOffice = verbindungen.find((z) => z.label === 'Euro-Office-Vorschau');
    expect(euroOffice?.status).toBe('fehler');
    expect(euroOffice?.ursache).toBeTruthy();
    expect(euroOffice?.ursache).not.toMatch(/\n/); // einzeilige Klartextmeldung
    expect(euroOffice?.ursache).not.toMatch(/ {4}at /); // kein roher Stacktrace
    expect(euroOffice?.empfehlung).toBeTruthy();
  });

  it('probeEuroOffice bricht nach dem übergebenen Timeout ab, statt die Antwort offen zu halten (nicht routbare Adresse)', async () => {
    const timeoutMs = 300;
    const start = Date.now();
    const ergebnis = await probeEuroOffice('http://10.255.255.1', timeoutMs);
    const dauerMs = Date.now() - start;
    expect(ergebnis.ok).toBe(false);
    expect(ergebnis.message).toBeTruthy();
    // Großzügige Toleranz nach oben (Systemlast), aber deutlich unter „hängt unbegrenzt".
    expect(dauerMs).toBeLessThan(timeoutMs + 4_000);
  }, 10_000);
});

/**
 * SPEICHER/BACKUP-Abschnitt + Route „Jetzt sichern" (Task 1, 14-06). Analog Task 1/2 oben:
 * app.inject() gegen die echte App, Eigentümer-Gate wie überall in dieser Datei.
 */
describe('Task 1 (14-06): SPEICHER-Abschnitt — DB-Aggregation statt Dateisystem-Scan', () => {
  it('meldet Dateianzahl/-gesamtgröße passend zu den tatsächlich abgelegten Dateien und eine Datenbankgröße größer 0', async () => {
    const { app, db, dataDir, authHeaders, desk } = await baueEigentuemerDesk({ dateibasierteDb: true });
    storeFile(db, dataDir, Buffer.from('a'.repeat(1000)), 'a.pdf');
    const res = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/diagnose`, headers: authHeaders });
    expect(res.statusCode).toBe(200);
    const speicher = res.json().speicher as { status: string; label: string; bytes?: number; anzahl?: number }[];

    const datenbank = speicher.find((z) => z.label === 'Datenbank');
    expect(datenbank?.bytes).toBeGreaterThan(0);

    const dateispeicher = speicher.find((z) => z.label === 'Dateispeicher');
    expect(dateispeicher?.anzahl).toBe(1);
    expect(dateispeicher?.bytes).toBe(1000);
    expect(dateispeicher?.status).toBe('ok'); // weit über der Warnschwelle im Testverzeichnis
  });
});

describe('Task 1 (14-06): BACKUP-Abschnitt — instanzweite Rotation, errechnete nächste Sicherung', () => {
  it('ohne vorhandene Sicherung meldet der Abschnitt ehrlich, dass noch keine vorliegt — ohne erfundenen Zeitpunkt, ohne Fehlerzustand', async () => {
    const { app, authHeaders, desk } = await baueEigentuemerDesk({ dateibasierteDb: true });
    const res = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/diagnose`, headers: authHeaders });
    expect(res.statusCode).toBe(200);
    const backup = res.json().backup as { status: string; label: string; zeitpunkt?: string }[];
    expect(backup).toHaveLength(1);
    expect(backup[0].label).toBe('Letzte Sicherung');
    expect(backup[0].status).toBe('nicht-konfiguriert');
    expect(backup[0].zeitpunkt).toBeUndefined();
  });

  it('nach einer ausgelösten Sicherung meldet der Abschnitt einen Zeitpunkt, und die errechnete nächste Sicherung liegt um den konfigurierten Takt später', async () => {
    const { app, authHeaders, desk } = await baueEigentuemerDesk({ backupIntervalHours: 6, dateibasierteDb: true });
    const backupRes = await app.inject({ method: 'POST', url: `/api/v1/desks/${desk.id}/backup-jetzt`, headers: authHeaders });
    expect(backupRes.statusCode).toBe(200);

    const res = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/diagnose`, headers: authHeaders });
    const backup = res.json().backup as {
      status: string; label: string; zeitpunkt?: string; errechnet?: boolean;
    }[];
    expect(backup).toHaveLength(2);

    const letzte = backup.find((z) => z.label === 'Letzte Sicherung')!;
    expect(letzte.zeitpunkt).toBeTruthy();
    const naechste = backup.find((z) => z.label === 'Nächste geplante Sicherung')!;
    expect(naechste.errechnet).toBe(true);
    const differenzStunden = (new Date(naechste.zeitpunkt!).getTime() - new Date(letzte.zeitpunkt!).getTime()) / (60 * 60 * 1000);
    expect(differenzStunden).toBeCloseTo(6, 5);
  });

  it('bei abgeschaltetem Takt (0) entfällt die Angabe zur nächsten Sicherung statt einen Zeitpunkt zu erfinden', async () => {
    const { app, authHeaders, desk } = await baueEigentuemerDesk({ backupIntervalHours: 0, dateibasierteDb: true });
    await app.inject({ method: 'POST', url: `/api/v1/desks/${desk.id}/backup-jetzt`, headers: authHeaders });

    const res = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/diagnose`, headers: authHeaders });
    const backup = res.json().backup as { label: string }[];
    expect(backup).toHaveLength(1);
    expect(backup[0].label).toBe('Letzte Sicherung');
  });
});

describe('Task 1 (14-06): POST /desks/:id/backup-jetzt — Eigentümer-Gate + zusätzliche Sicherungsdatei', () => {
  it('Eigentümer bekommt 200 mit dem neuen Sicherungszeitpunkt; im Sicherungsverzeichnis liegt eine zusätzliche Datei', async () => {
    const { app, dataDir, authHeaders, desk } = await baueEigentuemerDesk({ dateibasierteDb: true });
    // Noch keine Sicherung in diesem frischen Test-dataDir — backup/ existiert noch gar nicht.
    const vorher = 0;

    const res = await app.inject({ method: 'POST', url: `/api/v1/desks/${desk.id}/backup-jetzt`, headers: authHeaders });
    expect(res.statusCode).toBe(200);
    expect(res.json().zeitpunkt).toBeTruthy();

    const nachher = readdirSync(join(dataDir, BACKUP_DIR)).filter((f) => f.endsWith('.sqlite'));
    expect(nachher.length).toBe(vorher + 1);
  });

  it('Kommentator bekommt 403 — Ausblenden des „Jetzt sichern"-Knopfs im Client ist keine Grenze', async () => {
    const { app, db, a, b } = await createTestAppMitZweiNutzern();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte A' } })
    ).json();
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(desk.id, b.userId, 'Kommentator');

    const res = await app.inject({ method: 'POST', url: `/api/v1/desks/${desk.id}/backup-jetzt`, headers: b.authHeaders });
    expect(res.statusCode).toBe(403);
  });
});
