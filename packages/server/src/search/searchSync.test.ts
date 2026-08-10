import { describe, it, expect } from 'vitest';
import { VERSIONIERTE_ARTEN } from '@j-desk/core';
import { openDb } from '../db';
import { createUser } from '../auth';
import { createDesk, applyDeskCommand, putDeskState, getDeskState } from '../deskStore';
import { indexZeileFuer } from './searchSync';

function suchZeilen(db: ReturnType<typeof openDb>, deskId: string) {
  return db
    .prepare('SELECT obj_type AS objType, obj_id AS objId, text FROM search_fts WHERE desk_id = ?')
    .all(deskId) as { objType: string; objId: string; text: string }[];
}

async function neuerDesk() {
  const db = openDb(':memory:');
  const userId = await createUser(db, 'nutzer-a', 'test-passwort');
  const desk = createDesk(db, userId, 'Akte A', { id: userId, name: 'A' });
  return { db, desk, userId };
}

describe('syncSearchIndex über applyDeskCommand (T-07-07)', () => {
  it('ein neu angelegtes Objekt ist unmittelbar nach dem Command auffindbar', async () => {
    const { db, desk, userId } = await neuerDesk();
    applyDeskCommand(
      db, desk.id,
      { type: 'addDoc', payload: { fileId: 'f1', name: 'Frisch Angelegte Karte', position: { x: 0, y: 0 } } },
      { id: userId, name: 'A' },
    );
    const zeilen = suchZeilen(db, desk.id);
    expect(zeilen.some((z) => z.text === 'Frisch Angelegte Karte')).toBe(true);
  });

  it('ein gelöschtes Objekt ist unmittelbar danach nicht mehr auffindbar', async () => {
    const { db, desk, userId } = await neuerDesk();
    applyDeskCommand(
      db, desk.id,
      { type: 'addDoc', payload: { id: 'doc-1', fileId: 'f1', name: 'Zu Löschende Karte', position: { x: 0, y: 0 } } },
      { id: userId, name: 'A' },
    );
    expect(suchZeilen(db, desk.id).some((z) => z.objId === 'doc-1')).toBe(true);

    applyDeskCommand(db, desk.id, { type: 'removeDoc', payload: { id: 'doc-1' } }, { id: userId, name: 'A' });
    expect(suchZeilen(db, desk.id).some((z) => z.objId === 'doc-1')).toBe(false);
  });

  it('ein umbenanntes/geändertes Objekt ist nur noch unter dem neuen Text auffindbar', async () => {
    const { db, desk, userId } = await neuerDesk();
    applyDeskCommand(
      db, desk.id,
      { type: 'addNote', payload: { id: 'note-1', kind: 'notiz', text: 'Alter Text', position: { x: 0, y: 0 } } },
      { id: userId, name: 'A' },
    );
    applyDeskCommand(db, desk.id, { type: 'editNote', payload: { id: 'note-1', text: 'Neuer Text' } }, { id: userId, name: 'A' });

    const zeile = suchZeilen(db, desk.id).find((z) => z.objId === 'note-1');
    expect(zeile?.text).toBe('Neuer Text');
  });
});

describe('syncSearchIndex über putDeskState (j-lawyer-Abgleich-/Import-Pfad)', () => {
  it('führt zu demselben Indexstand wie derselbe Inhalt über Commands', async () => {
    const { db: dbUeberCommands, desk: deskA, userId } = await neuerDesk();
    applyDeskCommand(
      dbUeberCommands, deskA.id,
      { type: 'addDoc', payload: { id: 'doc-x', fileId: 'f1', name: 'Vergleichsdokument', position: { x: 0, y: 0 } } },
      { id: userId, name: 'A' },
    );
    const ueberCommands = suchZeilen(dbUeberCommands, deskA.id).map((z) => ({ objType: z.objType, objId: z.objId, text: z.text }));

    const db2 = openDb(':memory:');
    const userId2 = await createUser(db2, 'nutzer-b', 'test-passwort');
    const deskB = createDesk(db2, userId2, 'Akte B', { id: userId2, name: 'B' });
    const state = getDeskState(dbUeberCommands, deskA.id)!.state;
    putDeskState(db2, deskB.id, state);

    const ueberPut = suchZeilen(db2, deskB.id).map((z) => ({ objType: z.objType, objId: z.objId, text: z.text }));
    expect(ueberPut).toEqual(ueberCommands);
  });
});

describe('indexZeileFuer über VERSIONIERTE_ARTEN (Vollständigkeitslauf)', () => {
  /** Ein plausibles Mindest-Fixture je Art — nur die Felder, die indexZeileFuer/typische
   *  Objekte dieser Art tatsächlich tragen. Fahnen tragen hier bewusst ein `label`, damit der
   *  Vollständigkeitslauf unten auch den „gesetzt"-Zweig von `flags` abdeckt, nicht nur den
   *  „fehlt"-Zweig. */
  const fixturePro: Record<(typeof VERSIONIERTE_ARTEN)[number], unknown> = {
    docs: { id: 'd1', fileId: 'f1', name: 'Testkarte', position: { x: 0, y: 0 }, rotation: 0, zIndex: 1 },
    stacks: { id: 's1', name: 'Teststapel', docIds: ['d1'], position: { x: 0, y: 0 }, zIndex: 1 },
    links: { id: 'l1', fromId: 'd1', toId: 's1', note: 'Verknüpfungstext' },
    strokes: { id: 'st1', docId: 'd1', page: 1, tool: 'pen', color: '#000', width: 2, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
    notes: { id: 'n1', kind: 'notiz', text: 'Notiztext', position: { x: 0, y: 0 }, zIndex: 1 },
    cutouts: { id: 'c1', fileId: 'f1', page: 1, rect: { x: 0, y: 0, w: 1, h: 1 }, position: { x: 0, y: 0 }, zIndex: 1, textSnapshot: 'Ausschnitttext' },
    marks: { id: 'm1', docId: 'd1', page: 1, rect: { x: 0, y: 0, w: 1, h: 1 }, kind: 'redact', textSnapshot: 'Geschwärzter Text' },
    stamps: { id: 'sm1', docId: 'd1', page: 1, x: 0, y: 0, angle: 0, text: 'Eingang', color: 'red', baseW: 100, baseH: 100 },
    flags: { id: 'f1', docId: 'd1', page: 1, offset: 0.5, color: '#f5c518', label: 'Wichtig' },
    clips: { id: 'cl1', memberIds: ['d1', 's1'] },
    legalObjects: { id: 'lo1', kind: 'tatsache', text: 'Fristablauf am 15.03.', position: { x: 0, y: 0 }, zIndex: 1 },
    tables: { id: 'tb1', titel: 'Forderungsaufstellung', spalten: [], rows: [], position: { x: 0, y: 0 }, zIndex: 1 },
    zeitleisten: { id: 'zt1', titel: 'Zeitleiste', eintraege: [], position: { x: 0, y: 0 }, zIndex: 1 },
    sitzungsmappen: { id: 'sm1', titel: 'Termin 14.08.', docIds: [], offeneFragen: [] },
    zones: { id: 'z1', name: 'Orientierungszone', rect: { x: 0, y: 0, w: 100, h: 100 } },
  };

  it.each(VERSIONIERTE_ARTEN)('liefert für Art "%s" entweder eine Zeile oder bewusst null', (art) => {
    const ergebnis = indexZeileFuer(art, fixturePro[art]);
    // 07-02 indiziert docs/stacks/notes/links/marks/stamps/cutouts/flags(mit Label) — strokes und
    // clips (07-02) müssen BEWUSST null liefern (kein undefined, kein Wurf), damit eine spätere,
    // vergessene Erweiterung auffällt. zeitleisten (CHRONO-01, 09-02) indiziert den Kartentitel
    // wie tables — also NICHT in dieser Ausschlussliste. sitzungsmappen (SESS-02, 11-01, T-11-04)
    // ist eine BEWUSSTE Vertraulichkeits-Entscheidung, keine fehlende Textquelle wie bei
    // strokes/clips — steht aber aus demselben technischen Grund (früher Ausschlusszweig) hier.
    // zones (UX-03, 13-02) ist ebenfalls eine bewusste Entscheidung: Zonen sind reine
    // Orientierungsstruktur ohne Fundstellen-Fachlichkeit — Sprünge zu Zonen laufen über die
    // Palette (13-04), nicht über die Volltextsuche.
    if (art === 'strokes' || art === 'clips' || art === 'sitzungsmappen' || art === 'zones') {
      expect(ergebnis).toBeNull();
    } else {
      expect(ergebnis).not.toBeNull();
      expect(ergebnis?.text.length).toBeGreaterThan(0);
    }
  });

  it('marks ohne textSnapshot liefert TROTZDEM eine Zeile mit leerem Text (Ersteller/Datum bleiben auffindbar)', () => {
    const ergebnis = indexZeileFuer('marks', { id: 'm2', docId: 'd1', page: 1, rect: { x: 0, y: 0, w: 1, h: 1 }, kind: 'tippex', createdBy: 'A' });
    expect(ergebnis).not.toBeNull();
    expect(ergebnis?.text).toBe('');
    expect(ergebnis?.ersteller).toBe('A');
  });

  it('flags ohne label liefert null (kein Kurzlabel ohne fachliche Textaussage)', () => {
    expect(indexZeileFuer('flags', { id: 'f2', docId: 'd1', page: 1, offset: 0.5, color: '#f5c518' })).toBeNull();
  });

  it('stamps.text landet unverändert in der Indexzeile', () => {
    const ergebnis = indexZeileFuer('stamps', { id: 'sm2', docId: 'd1', page: 1, x: 0, y: 0, angle: 0, text: 'FRIST!', color: 'red', baseW: 100, baseH: 100 });
    expect(ergebnis?.text).toBe('FRIST!');
  });

  it('cutouts.textSnapshot + cutouts.sourceName landen gemeinsam in der Indexzeile', () => {
    const ergebnis = indexZeileFuer('cutouts', {
      id: 'c2', fileId: 'f1', page: 1, rect: { x: 0, y: 0, w: 1, h: 1 }, position: { x: 0, y: 0 }, zIndex: 1,
      textSnapshot: 'Zitierter Ausschnitt', sourceName: 'urteil.pdf',
    });
    expect(ergebnis?.text).toContain('Zitierter Ausschnitt');
    expect(ergebnis?.text).toContain('urteil.pdf');
  });

  it('links.note landet unverändert in der Indexzeile', () => {
    const ergebnis = indexZeileFuer('links', { id: 'l2', fromId: 'd1', toId: 's1', note: 'Bezug zur Kündigung' });
    expect(ergebnis?.text).toBe('Bezug zur Kündigung');
  });

  it('tables.titel landet in der Indexzeile, Zellinhalte bleiben unberücksichtigt (CALC-01)', () => {
    const ergebnis = indexZeileFuer('tables', {
      id: 'tb2', titel: 'Zinsrechnung Mandant Müller', spalten: [], position: { x: 0, y: 0 }, zIndex: 1,
      rows: [{ id: 'r1', zellen: { sp1: '1.234,56' } }],
    });
    expect(ergebnis?.text).toBe('Zinsrechnung Mandant Müller');
  });

  it('tables ohne Titel liefert null (kein indizierbarer Text)', () => {
    expect(indexZeileFuer('tables', { id: 'tb3', titel: '', spalten: [], rows: [], position: { x: 0, y: 0 }, zIndex: 1 })).toBeNull();
  });

  it('zeitleisten.titel landet in der Indexzeile, Einträge bleiben unberücksichtigt (CHRONO-01, 09-02)', () => {
    const ergebnis = indexZeileFuer('zeitleisten', {
      id: 'zt2', titel: 'Zeitleiste', position: { x: 0, y: 0 }, zIndex: 1,
      eintraege: [
        { id: 'e1', objRef: 'd1', art: 'ereignis', zeitangabe: 'genau', datum: '2026-01-01' },
        { id: 'e2', objRef: 'd1', art: 'frist', zeitangabe: 'genau', datum: '2026-02-01' },
      ],
    });
    expect(ergebnis?.text).toBe('Zeitleiste');
  });

  it('zeitleisten ohne Titel liefert null (kein indizierbarer Text)', () => {
    expect(indexZeileFuer('zeitleisten', { id: 'zt3', titel: '', eintraege: [], position: { x: 0, y: 0 }, zIndex: 1 })).toBeNull();
  });
});

describe('syncSearchIndex: Zeitleiste erzeugt genau eine Indexzeile, nicht eine pro Eintrag (09-02)', () => {
  it('eine Zeitleiste mit mehreren Einträgen ist genau einmal im Index vertreten', async () => {
    const { db, desk, userId } = await neuerDesk();
    applyDeskCommand(
      db, desk.id,
      { type: 'addDoc', payload: { id: 'doc-zt', fileId: 'f1', name: 'Referenziertes Dokument', position: { x: 0, y: 0 } } },
      { id: userId, name: 'A' },
    );
    applyDeskCommand(
      db, desk.id,
      { type: 'addZeitleiste', payload: { id: 'zt-idx', position: { x: 0, y: 0 } } },
      { id: userId, name: 'A' },
    );
    applyDeskCommand(
      db, desk.id,
      { type: 'addZeitleisteEintrag', payload: { zeitleisteId: 'zt-idx', objRef: 'doc-zt', art: 'ereignis', zeitangabe: 'genau', datum: '2026-01-01', id: 'e1' } },
      { id: userId, name: 'A' },
    );
    applyDeskCommand(
      db, desk.id,
      { type: 'addZeitleisteEintrag', payload: { zeitleisteId: 'zt-idx', objRef: 'doc-zt', art: 'frist', zeitangabe: 'genau', datum: '2026-02-01', id: 'e2' } },
      { id: userId, name: 'A' },
    );

    const zeitleistenZeilen = suchZeilen(db, desk.id).filter((z) => z.objType === 'zeitleisten');
    expect(zeitleistenZeilen).toHaveLength(1);
    expect(zeitleistenZeilen[0]).toMatchObject({ objId: 'zt-idx', text: 'Zeitleiste' });
  });
});
