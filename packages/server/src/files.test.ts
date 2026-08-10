import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { openDb, type Db } from './db';
import { storeFile, getFilePath, fileExists, getFileMeta, classify, classifyName, FileError } from './files';
import { getDeskState, putDeskState } from './deskStore';
import { createTestAppMitZweiNutzern } from './testUtils';

const pdfBytes = (inhalt: string) => Buffer.from(`%PDF-1.4\n${inhalt}`);

let db: Db;
let dataDir: string;
beforeEach(() => {
  db = openDb(':memory:');
  dataDir = mkdtempSync(join(tmpdir(), 'dd-files-'));
});

describe('classify', () => {
  it('klassifiziert nach Magic-Bytes und Endung', () => {
    expect(classify(Buffer.from('%PDF-1.4 x'), 'a.pdf')).toBe('pdf');
    expect(classify(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'foto.jpg')).toBe('image');
    expect(classify(Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'bild.png')).toBe('image');
    expect(classify(Buffer.concat([Buffer.from('RIFF1234'), Buffer.from('WEBP')]), 'x.webp')).toBe('image');
    expect(classify(Buffer.from('GIF89a...'), 'anim.gif')).toBe('image');
    expect(classify(Buffer.from('PK\x03\x04rest'), 'brief.odt')).toBe('convertible');
    expect(classify(Buffer.from('PK\x03\x04rest'), 'tabelle.xlsx')).toBe('convertible');
    expect(classify(Buffer.from('PK\x03\x04rest'), 'archiv.zip')).toBe('other');
    expect(classify(Buffer.from('nur text'), 'notiz.txt')).toBe('convertible');
    expect(classify(Buffer.from('MZ…'), 'tool.exe')).toBe('other');
  });
});

describe('classifyName', () => {
  it('klassifiziert allein nach Endung (ohne Bytes)', () => {
    expect(classifyName('a.pdf')).toBe('pdf');
    expect(classifyName('foto.JPG')).toBe('image');
    expect(classifyName('brief.docx')).toBe('convertible');
    expect(classifyName('notiz.txt')).toBe('convertible');
    expect(classifyName('archiv.zip')).toBe('other');
  });
});

describe('storeFile', () => {
  it('speichert eine PDF unter files/<sha256>.pdf und registriert sie', () => {
    const meta = storeFile(db, dataDir, pdfBytes('eins'), 'Rechnung.pdf');
    expect(meta.originalName).toBe('Rechnung.pdf');
    expect(meta.kind).toBe('pdf');
    const stored = join(dataDir, 'files', `${meta.sha256}.pdf`);
    expect(existsSync(stored)).toBe(true);
    expect(readFileSync(stored).equals(pdfBytes('eins'))).toBe(true);
    expect(readdirSync(join(dataDir, 'files')).some((f) => f.startsWith('.tmp-'))).toBe(false);
  });

  it('dedupliziert inhaltsgleiche Uploads', () => {
    const a = storeFile(db, dataDir, pdfBytes('eins'), 'a.pdf');
    const b = storeFile(db, dataDir, pdfBytes('eins'), 'kopie.pdf');
    expect(b.id).toBe(a.id);
    expect(readdirSync(join(dataDir, 'files'))).toHaveLength(1);
  });

  it('storeFile akzeptiert Nicht-PDFs und liefert kind; getFilePath findet sie', () => {
    const meta = storeFile(db, dataDir, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]), 'foto.jpg');
    expect(meta.kind).toBe('image');
    const path = getFilePath(db, dataDir, meta.id);
    expect(path).toBeTruthy();
    expect(path).toBe(join(dataDir, 'files', `${meta.sha256}.bin`));
  });

  it('klassifiziert unbekannte Endung/Signatur als "other" statt abzulehnen', () => {
    const meta = storeFile(db, dataDir, Buffer.from('kein pdf'), 'a.pdf');
    expect(meta.kind).toBe('other');
  });

  it('leere Datei und Größenlimit werfen weiterhin', () => {
    expect(() => storeFile(db, dataDir, Buffer.alloc(0), 'a.pdf')).toThrow(FileError);
  });

  it('räumt die tmp-Datei auf, wenn das Umbenennen fehlschlägt', () => {
    const bytes = pdfBytes('eins');
    const sha = createHash('sha256').update(bytes).digest('hex');
    // Zielpfad als VERZEICHNIS blockieren → renameSync wirft, writeFileSync(tmp) war erfolgreich
    mkdirSync(join(dataDir, 'files', `${sha}.pdf`), { recursive: true });
    expect(() => storeFile(db, dataDir, bytes, 'a.pdf')).toThrow();
    expect(readdirSync(join(dataDir, 'files')).some((f) => f.startsWith('.tmp-'))).toBe(false);
  });
});

describe('getFilePath / fileExists', () => {
  it('liefert den Pfad einer gespeicherten Datei und null für Unbekanntes', () => {
    const meta = storeFile(db, dataDir, pdfBytes('eins'), 'a.pdf');
    expect(getFilePath(db, dataDir, meta.id)).toBe(join(dataDir, 'files', `${meta.sha256}.pdf`));
    expect(getFilePath(db, dataDir, 'gibtsnicht')).toBeNull();
    expect(fileExists(db, meta.id)).toBe(true);
    expect(fileExists(db, 'gibtsnicht')).toBe(false);
  });

  it('findet Bestandsdateien auch wenn die kind-Spalte vom tatsächlichen Suffix abweicht (Fallback)', () => {
    const meta = storeFile(db, dataDir, pdfBytes('eins'), 'a.pdf');
    // simuliert einen Bestandsfall: DB-kind stimmt nicht (mehr) mit dem abgelegten Suffix überein
    db.prepare('UPDATE files SET kind = ? WHERE id = ?').run('other', meta.id);
    expect(getFilePath(db, dataDir, meta.id)).toBe(join(dataDir, 'files', `${meta.sha256}.pdf`));
  });
});

describe('getFileMeta', () => {
  it('liefert Metadaten inkl. kind oder null für Unbekanntes', () => {
    const meta = storeFile(db, dataDir, pdfBytes('eins'), 'a.pdf');
    expect(getFileMeta(db, meta.id)).toEqual(meta);
    expect(getFileMeta(db, 'gibtsnicht')).toBeNull();
  });
});

/**
 * AR-02-04 (02-SECURITY.md, 14-07): Regression für die drei desk-losen Lese-Routen des
 * eigenständigen Modus (Inhalt, Vorschau, Metadaten) — istDateiSichtbarFuer() (dateiSichtbarkeit.ts)
 * muss VOR jeder Auslieferung greifen, ohne einen bestehenden legitimen Zugriffsweg zu brechen.
 */
describe('AR-02-04: desk-lose Datei-Leserouten prüfen Sichtbarkeit vor der Auslieferung', () => {
  const LESE_PFADE = ['', '/preview', '/meta'] as const;

  function referenziereDatei(zielDb: Db, deskId: string, fileId: string, docId: string): void {
    const vorher = getDeskState(zielDb, deskId)!.state;
    putDeskState(zielDb, deskId, {
      ...vorher,
      docs: [...vorher.docs, { id: docId, fileId, name: 'Klageschrift.pdf', position: { x: 0, y: 0 } }],
    });
  }

  it('berechtigter Zugriff bleibt an allen drei Routen unverändert (200)', async () => {
    const { app, db: appDb, dataDir: appDataDir, a } = await createTestAppMitZweiNutzern();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte A' } })
    ).json();
    const meta = storeFile(appDb, appDataDir, pdfBytes('sichtbar'), 'sichtbar.pdf');
    referenziereDatei(appDb, desk.id, meta.id, 'doc-sichtbar');

    for (const pfad of LESE_PFADE) {
      const res = await app.inject({ method: 'GET', url: `/api/v1/files/${meta.id}${pfad}`, headers: a.authHeaders });
      expect(res.statusCode, `Pfad ${pfad || '/'}: erwartete 200`).toBe(200);
    }
  });

  it('unberechtigter Zugriff bekommt an JEDER der drei Routen eine Nicht-gefunden-Antwort, obwohl die Dateikennung bekannt ist', async () => {
    const { app, db: appDb, dataDir: appDataDir, a, b } = await createTestAppMitZweiNutzern();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte A' } })
    ).json();
    const meta = storeFile(appDb, appDataDir, pdfBytes('privat'), 'privat.pdf');
    // Nutzer B hat keine Rolle an diesem Schreibtisch — kennt die fileId aber (z. B. aus einem
    // früheren Export), s. Plan-Objective.
    referenziereDatei(appDb, desk.id, meta.id, 'doc-privat');

    for (const pfad of LESE_PFADE) {
      const res = await app.inject({ method: 'GET', url: `/api/v1/files/${meta.id}${pfad}`, headers: b.authHeaders });
      expect(res.statusCode, `Pfad ${pfad || '/'}: erwartete 404`).toBe(404);
      expect(res.json().error).toBe('Datei nicht gefunden');
    }
  });

  it('dieselbe Nicht-gefunden-Antwort wie bei einer wirklich unbekannten Datei (keine Existenzauskunft)', async () => {
    const { app, db: appDb, dataDir: appDataDir, a, b } = await createTestAppMitZweiNutzern();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte A' } })
    ).json();
    const meta = storeFile(appDb, appDataDir, pdfBytes('privat2'), 'privat2.pdf');
    referenziereDatei(appDb, desk.id, meta.id, 'doc-privat2');

    const unberechtigt = await app.inject({ method: 'GET', url: `/api/v1/files/${meta.id}`, headers: b.authHeaders });
    const unbekannt = await app.inject({ method: 'GET', url: '/api/v1/files/gibtsnicht', headers: b.authHeaders });
    expect(unberechtigt.statusCode).toBe(unbekannt.statusCode);
    expect(unberechtigt.json()).toEqual(unbekannt.json());
  });

  it('Regression Mehrfachbezug: dieselbe Datei über zwei Schreibtische desselben Nutzers bleibt über beide erreichbar', async () => {
    const { app, db: appDb, dataDir: appDataDir, a } = await createTestAppMitZweiNutzern();
    const deskEins = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte 1' } })
    ).json();
    const deskZwei = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte 2' } })
    ).json();
    const meta = storeFile(appDb, appDataDir, pdfBytes('mehrfach'), 'mehrfach.pdf');
    referenziereDatei(appDb, deskEins.id, meta.id, 'doc-eins');
    referenziereDatei(appDb, deskZwei.id, meta.id, 'doc-zwei');

    const resEins = await app.inject({ method: 'GET', url: `/api/v1/files/${meta.id}`, headers: a.authHeaders });
    const resZwei = await app.inject({ method: 'GET', url: `/api/v1/files/${meta.id}/meta`, headers: a.authHeaders });
    expect(resEins.statusCode).toBe(200);
    expect(resZwei.statusCode).toBe(200);
  });

  it('eine nicht angemeldete Anfrage verhält sich unverändert (401, vor jeder Sichtbarkeitsprüfung)', async () => {
    const { app, db: appDb, dataDir: appDataDir, a } = await createTestAppMitZweiNutzern();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte A' } })
    ).json();
    const meta = storeFile(appDb, appDataDir, pdfBytes('ohne-auth'), 'ohne-auth.pdf');
    referenziereDatei(appDb, desk.id, meta.id, 'doc-ohne-auth');

    const res = await app.inject({ method: 'GET', url: `/api/v1/files/${meta.id}` });
    expect(res.statusCode).toBe(401);
  });
});
