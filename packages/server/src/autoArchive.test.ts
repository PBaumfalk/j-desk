import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestApp, createTestAppMitZweiNutzern } from './testUtils';
import { createDesk, putDeskState } from './deskStore';
import { readPackage } from './jdesk';
import { vielleichtArchiviere, sollArchivieren, merkeArchiv, leseArchivMerker } from './autoArchive';

vi.mock('./jlawyer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./jlawyer')>();
  return { ...actual, createDocument: vi.fn() };
});

// Kein vi.fn()-Ersatz für buildPackage — die Attrappe ruft die echte Implementierung durch
// (vi.fn(actual.buildPackage)), damit die Projektionsfälle unten reales Verhalten prüfen und
// gleichzeitig die übergebenen opts (insbesondere `rolle`) beobachtbar bleiben.
vi.mock('./jdesk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./jdesk')>();
  return { ...actual, buildPackage: vi.fn(actual.buildPackage) };
});

import { createDocument, JLawyerError } from './jlawyer';
import { buildPackage } from './jdesk';

const mockCreateDocument = vi.mocked(createDocument);
const mockBuildPackage = vi.mocked(buildPackage);

beforeEach(() => {
  mockCreateDocument.mockReset();
  mockCreateDocument.mockResolvedValue({ id: 'jl-doc-1' });
  mockBuildPackage.mockClear();
});

/**
 * SAFE-06/D-13: opportunistische .jdesk-Automatiksicherung in die j-lawyer-Akte, ausgelöst vom
 * nächsten erfolgreichen, authentifizierten Akten-Abgleich statt an rotateBackup() (05-RESEARCH
 * Open Question 1 / Pitfall 4).
 */
describe('vielleichtArchiviere (Task 2 Tracer)', () => {
  it('End-to-End: authentifizierter Abgleich erzeugt genau ein .jdesk-Paket im Modus linked in der Akte, und der Merker steht', async () => {
    const { db, dataDir, userId } = await createTestApp();
    const desk = createDesk(db, userId, 'Mandat Meier');
    putDeskState(db, desk.id, {
      docs: [], links: [], stacks: [],
      notes: [{ id: 'n1', kind: 'notiz', text: 'Notiz', position: { x: 0, y: 0 }, zIndex: 1 }],
    });

    // intervallStunden explizit (statt Modul-Default): vitest.config.ts setzt
    // JDESK_ARCHIVE_INTERVAL_HOURS global auf 0, damit andere Testsuiten (z. B.
    // jlawyer.test.ts) nicht unbeobachtet Hintergrund-Uploads auslösen — dieser Test
    // prüft das eingeschaltete Verhalten deshalb unabhängig vom Prozess-Default.
    await vielleichtArchiviere({
      db, dataDir, jlBase: 'https://jl.example', creds: { username: 'anwalt', password: 'geheim' },
      deskId: desk.id, userId, rolle: 'Eigentümer', actorName: 'anwalt', intervallStunden: 24,
    });

    expect(mockCreateDocument).toHaveBeenCalledTimes(1);
    const [, , , caseId, dateiname, bytes] = mockCreateDocument.mock.calls[0];
    expect(caseId).toBe(desk.id);
    expect(dateiname).toMatch(/\.jdesk$/);

    const gelesen = readPackage(bytes as Buffer);
    expect(gelesen.manifest.mode).toBe('linked');
    expect(gelesen.manifest.source.caseId).toBe(desk.id);
    expect(gelesen.state.notes?.map((n) => n.id)).toContain('n1');

    const merker = leseArchivMerker(db, desk.id);
    expect(merker?.lastRev).toBe(1); // createDesk startet bei rev 0, die eine putDeskState hebt auf 1
    expect(merker?.lastDocId).toBe('jl-doc-1');
  });
});

describe('sollArchivieren', () => {
  it('liefert false, wenn intervallStunden <= 0 ist (Automatik abgeschaltet)', async () => {
    const { db, userId } = await createTestApp();
    const desk = createDesk(db, userId, 'Akte');
    expect(sollArchivieren(db, desk.id, 5, Date.now(), 0)).toBe(false);
  });

  it('liefert true, wenn noch kein Merker existiert', async () => {
    const { db, userId } = await createTestApp();
    const desk = createDesk(db, userId, 'Akte');
    expect(sollArchivieren(db, desk.id, 1, Date.now(), 24)).toBe(true);
  });

  it('liefert false ohne Zustandsänderung, auch nach verstrichenem Mindestabstand', async () => {
    const { db, userId } = await createTestApp();
    const desk = createDesk(db, userId, 'Akte');
    const jetzt = Date.now();
    merkeArchiv(db, desk.id, 3, jetzt, 'doc-1');
    expect(sollArchivieren(db, desk.id, 3, jetzt + 25 * 3_600_000, 24)).toBe(false);
  });

  it('liefert false bei Zustandsänderung innerhalb des Mindestabstands', async () => {
    const { db, userId } = await createTestApp();
    const desk = createDesk(db, userId, 'Akte');
    const jetzt = Date.now();
    merkeArchiv(db, desk.id, 3, jetzt, 'doc-1');
    expect(sollArchivieren(db, desk.id, 4, jetzt + 1 * 3_600_000, 24)).toBe(false);
  });

  it('liefert true bei Zustandsänderung UND verstrichenem Mindestabstand', async () => {
    const { db, userId } = await createTestApp();
    const desk = createDesk(db, userId, 'Akte');
    const jetzt = Date.now();
    merkeArchiv(db, desk.id, 3, jetzt, 'doc-1');
    expect(sollArchivieren(db, desk.id, 4, jetzt + 25 * 3_600_000, 24)).toBe(true);
  });
});

describe('vielleichtArchiviere (Task 3: Projektionstreue, Fehlerpfad, Wiederholungssperre, Nebenläufigkeit)', () => {
  it('Projektion greift: das automatisch erzeugte Paket enthält kein Objekt aus der privaten Ebene eines anderen Nutzers, und die übergebene Rolle wird unverändert an buildPackage durchgereicht', async () => {
    const { db, dataDir, a, b } = await createTestAppMitZweiNutzern();
    const desk = createDesk(db, a.userId, 'Akte AB');
    putDeskState(db, desk.id, {
      docs: [], links: [], stacks: [],
      layers: [{ id: 'privat-a', typ: 'privat', name: 'Privat', ownerUserId: a.userId }],
      notes: [
        { id: 'n-privat', kind: 'notiz', text: 'geheim', position: { x: 0, y: 0 }, zIndex: 1, layerId: 'privat-a' },
        { id: 'n-oeffentlich', kind: 'notiz', text: 'für alle', position: { x: 1, y: 1 }, zIndex: 2 },
      ],
    });

    await vielleichtArchiviere({
      db, dataDir, jlBase: 'https://jl.example', creds: { username: 'nutzer-b', password: 'test-passwort' },
      deskId: desk.id, userId: b.userId, rolle: 'Bearbeiter', actorName: 'nutzer-b', intervallStunden: 24,
    });

    expect(mockCreateDocument).toHaveBeenCalledTimes(1);
    const [, , , , , bytes] = mockCreateDocument.mock.calls[0];
    const gelesen = readPackage(bytes as Buffer);
    expect(gelesen.state.notes?.map((n) => n.id)).not.toContain('n-privat');
    expect(gelesen.state.notes?.map((n) => n.id)).toContain('n-oeffentlich');

    // Belegt, dass die übergebene rolle unverändert durchgereicht wird — kein konstanter
    // Ersatzwert (z. B. immer 'Eigentümer').
    expect(mockBuildPackage).toHaveBeenCalledWith(
      db, dataDir, desk.id,
      expect.objectContaining({ userId: b.userId, rolle: 'Bearbeiter', jlawyer: true }),
    );
  });

  it('Upload-Fehlschlag ist folgenlos: kein abgelehntes Versprechen, ein Protokolleintrag, Merker bleibt null (D-12)', async () => {
    const { db, dataDir, userId } = await createTestApp();
    const desk = createDesk(db, userId, 'Akte');
    putDeskState(db, desk.id, { docs: [], links: [], stacks: [] });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockCreateDocument.mockRejectedValueOnce(new JLawyerError('j-lawyer ist nicht erreichbar', 502, 'nichtErreichbar'));

    await expect(
      vielleichtArchiviere({
        db, dataDir, jlBase: 'https://jl.example', creds: { username: 'a', password: 'b' },
        deskId: desk.id, userId, rolle: 'Eigentümer', actorName: 'a', intervallStunden: 24,
      }),
    ).resolves.toBeUndefined();

    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(leseArchivMerker(db, desk.id)).toBeNull();
    consoleErrorSpy.mockRestore();
  });

  it('keine Wiederholung ohne Änderung; verändert aber innerhalb des Mindestabstands ebenfalls keine Wiederholung; erst Änderung UND verstrichener Abstand lösen den zweiten Upload aus', async () => {
    const { db, dataDir, userId } = await createTestApp();
    const desk = createDesk(db, userId, 'Akte');
    putDeskState(db, desk.id, { docs: [], links: [], stacks: [] }); // rev 1
    const t0 = Date.now();
    const aufruf = (jetzt: number) =>
      vielleichtArchiviere({
        db, dataDir, jlBase: 'https://jl.example', creds: { username: 'a', password: 'b' },
        deskId: desk.id, userId, rolle: 'Eigentümer', actorName: 'a', jetzt, intervallStunden: 24,
      });

    await aufruf(t0);
    expect(mockCreateDocument).toHaveBeenCalledTimes(1);

    // Stufe 1: unverändert, weit nach dem Mindestabstand — kein zweiter Upload (rev unverändert).
    await aufruf(t0 + 25 * 3_600_000);
    expect(mockCreateDocument).toHaveBeenCalledTimes(1);

    // Stufe 2: echte Zustandsänderung, aber INNERHALB des Mindestabstands seit dem letzten
    // erfolgreichen Upload (t0) — kein Upload.
    putDeskState(db, desk.id, {
      docs: [], links: [], stacks: [],
      notes: [{ id: 'n1', kind: 'notiz', text: 'neu', position: { x: 0, y: 0 }, zIndex: 1 }],
    }); // rev 2
    await aufruf(t0 + 1 * 3_600_000);
    expect(mockCreateDocument).toHaveBeenCalledTimes(1);

    // Stufe 3: Änderung (weiterhin rev 2 > lastRev 1) UND verstrichener Mindestabstand
    // (gemessen ab dem letzten erfolgreichen Upload bei t0) — zweiter Upload.
    await aufruf(t0 + 25 * 3_600_000);
    expect(mockCreateDocument).toHaveBeenCalledTimes(2);
  });

  it('Automatik abschaltbar: intervallStunden 0 verhindert jeden Upload', async () => {
    const { db, dataDir, userId } = await createTestApp();
    const desk = createDesk(db, userId, 'Akte');
    putDeskState(db, desk.id, { docs: [], links: [], stacks: [] });

    await vielleichtArchiviere({
      db, dataDir, jlBase: 'https://jl.example', creds: { username: 'a', password: 'b' },
      deskId: desk.id, userId, rolle: 'Eigentümer', actorName: 'a', intervallStunden: 0,
    });

    expect(mockCreateDocument).toHaveBeenCalledTimes(0);
  });

  it('Nebenläufigkeit: zwei gleichzeitige Aufrufe für dieselbe deskId lösen höchstens eine Automatiksicherung aus (D-22)', async () => {
    const { db, dataDir, userId } = await createTestApp();
    const desk = createDesk(db, userId, 'Akte');
    putDeskState(db, desk.id, { docs: [], links: [], stacks: [] });

    let resolveUpload!: (v: { id: string }) => void;
    mockCreateDocument.mockImplementationOnce(
      () => new Promise((resolve) => { resolveUpload = resolve; }),
    );

    const opts = {
      db, dataDir, jlBase: 'https://jl.example', creds: { username: 'a', password: 'b' },
      deskId: desk.id, userId, rolle: 'Eigentümer' as const, actorName: 'a', intervallStunden: 24,
    };
    const p1 = vielleichtArchiviere(opts);
    const p2 = vielleichtArchiviere(opts);

    resolveUpload({ id: 'doc-x' });
    await Promise.all([p1, p2]);

    expect(mockCreateDocument).toHaveBeenCalledTimes(1);
  });
});
