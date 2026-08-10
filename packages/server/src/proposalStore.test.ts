import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VorschlagStatusError, type Command } from '@j-desk/core';
import { openDb, type Db } from './db';
import { applyDeskCommand, createDesk, type Actor } from './deskStore';
import {
  erstelleVorschlag, findeVorschlag, genehmigeVorschlag, lehneVorschlagAb, nimmVorschlagZurueck,
  VorschlagAbgelehntError, GenehmigungVerweigertError, VorschlagGeaendertError,
} from './proposalStore';

/**
 * AI-01/AI-02 Härtung (Task 2): Idempotenz (Agenten-Retry), Statusmaschine gegen SQLite,
 * Flywheel-Zeitstempel und der atomare Status+Inverse-Commit (Rollback-Beweis) — direkt
 * gegen :memory:-SQLite, ohne HTTP.
 */

let db: Db;
let deskId: string;
const ki: Actor = { id: 'u-ki', name: 'ki-agent' };
const genehmiger: Actor = { id: 'u-anwalt', name: 'anwalt-a' };

const eingabe = (ueberschreibungen: Record<string, unknown> = {}) => ({
  art: 'addNote',
  payload: { id: `n-${Math.random().toString(36).slice(2)}`, kind: 'notiz', text: 'Fundstelle prüfen', position: { x: 10, y: 20 } },
  quellen: [],
  zusammenfassung: 'Notiz anlegen',
  ...ueberschreibungen,
});

/** Echte Anwendung wie in der Route: applyDeskCommand pro Kommando, updatedRevs sammeln. */
function echteAnwendung(kommandos: Command[], actor: Actor) {
  let rev = 0;
  const objekte: { id: string; updatedRev: number }[] = [];
  for (const cmd of kommandos) {
    const ergebnis = applyDeskCommand(db, deskId, cmd, actor);
    rev = ergebnis.rev;
    const objId = (cmd.payload as { id?: unknown } | undefined)?.id;
    if (typeof objId === 'string') {
      const notiz = (ergebnis.state.notes ?? []).find((n) => n.id === objId);
      if (notiz && typeof notiz.updatedRev === 'number') objekte.push({ id: objId, updatedRev: notiz.updatedRev });
    }
  }
  return { rev, objekte };
}

function zeileRoh(vorschlagId: string) {
  return db.prepare('SELECT * FROM vorschlaege WHERE id = ?').get(vorschlagId) as
    { status: string; inverse: string | null; genehmigte_objekte: string | null; decided_by: string | null; decided_at: number | null; created_at: number } | undefined;
}

beforeEach(() => {
  db = openDb(':memory:');
  db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)').run('u-ki', 'ki-agent', 'h', 0);
  db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)').run('u-anwalt', 'anwalt-a', 'h', 0);
  deskId = createDesk(db, 'u-anwalt', 'Gate-Desk').id;
});

describe('erstelleVorschlag — Idempotenz', () => {
  it('liefert bei demselben idempotenzKey dieselbe vorschlagId und genau EINE Datenbankzeile', () => {
    const e1 = erstelleVorschlag(db, deskId, eingabe({ idempotenzKey: 'retry-1' }), ki);
    const e2 = erstelleVorschlag(db, deskId, eingabe({ idempotenzKey: 'retry-1' }), ki);

    expect(e2.id).toBe(e1.id);
    const zeilen = db.prepare('SELECT COUNT(*) AS n FROM vorschlaege WHERE desk_id = ?').get(deskId) as { n: number };
    expect(zeilen.n).toBe(1);
  });

  it('erzeugt ohne idempotenzKey zwei Zeilen; mit verschiedenen Schlüsseln ebenfalls', () => {
    erstelleVorschlag(db, deskId, eingabe(), ki);
    erstelleVorschlag(db, deskId, eingabe(), ki);
    erstelleVorschlag(db, deskId, eingabe({ idempotenzKey: 'a' }), ki);
    erstelleVorschlag(db, deskId, eingabe({ idempotenzKey: 'b' }), ki);

    const zeilen = db.prepare('SELECT COUNT(*) AS n FROM vorschlaege WHERE desk_id = ?').get(deskId) as { n: number };
    expect(zeilen.n).toBe(4);
  });
});

describe('Statusmaschine gegen SQLite', () => {
  it('genehmigeVorschlag auf einen abgelehnten Vorschlag wirft VorschlagStatusError; die Zeile bleibt unverändert', () => {
    const v = erstelleVorschlag(db, deskId, eingabe(), ki);
    lehneVorschlagAb(db, deskId, v.id, genehmiger);
    const vorher = zeileRoh(v.id);

    expect(() => genehmigeVorschlag(db, deskId, v.id, genehmiger, echteAnwendung)).toThrow(VorschlagStatusError);

    expect(zeileRoh(v.id)).toEqual(vorher);
  });

  it('stempelt decided_at + decided_by bei Ablehnung UND bei Genehmigung (Flywheel: Latenz per SQL auswertbar)', () => {
    const abgelehnt = erstelleVorschlag(db, deskId, eingabe(), ki);
    lehneVorschlagAb(db, deskId, abgelehnt.id, genehmiger);
    const genehmigt = erstelleVorschlag(db, deskId, eingabe(), ki);
    genehmigeVorschlag(db, deskId, genehmigt.id, genehmiger, echteAnwendung);

    // Latenz-Auswertung als SQL-Query (Pitfall 10: decided_at - created_at muss auswertbar sein).
    const latenzen = db.prepare(
      'SELECT id, decided_at - created_at AS latenz FROM vorschlaege WHERE decided_at IS NOT NULL AND decided_by = ?',
    ).all(genehmiger.name) as { id: string; latenz: number }[];
    expect(latenzen).toHaveLength(2);
    for (const l of latenzen) expect(l.latenz).toBeGreaterThanOrEqual(0);

    expect(zeileRoh(abgelehnt.id)!.decided_by).toBe('anwalt-a');
    expect(zeileRoh(genehmigt.id)!.decided_by).toBe('anwalt-a');
  });
});

describe('erstelleVorschlag — atomare Vor-Prüfung (vorInsert, 12-03)', () => {
  it('wirft VorschlagAbgelehntError und hinterlässt KEINE Zeile, wenn die Vor-Prüfung ablehnt', () => {
    expect(() => erstelleVorschlag(db, deskId, eingabe(), ki, () => ({
      ok: false as const,
      grund: 'zitat_nicht_auflösbar' as const,
      betroffeneQuelle: { dokumentId: 'd1', seite: 1, zitat: 'x' },
    }))).toThrow(VorschlagAbgelehntError);

    const zeilen = db.prepare('SELECT COUNT(*) AS n FROM vorschlaege WHERE desk_id = ?').get(deskId) as { n: number };
    expect(zeilen.n).toBe(0);
  });

  it('legt die Zeile an, wenn die Vor-Prüfung null liefert', () => {
    const v = erstelleVorschlag(db, deskId, eingabe(), ki, () => null);
    expect(v.status).toBe('ausstehend');
    const zeilen = db.prepare('SELECT COUNT(*) AS n FROM vorschlaege WHERE desk_id = ?').get(deskId) as { n: number };
    expect(zeilen.n).toBe(1);
  });

  it('prüft bei einem Idempotenz-Treffer NICHT erneut (Agenten-Retry nach Erfolg bleibt 200)', () => {
    const erste = erstelleVorschlag(db, deskId, eingabe({ idempotenzKey: 'retry-quelle' }), ki, () => null);
    const pruefung = vi.fn(() => ({ ok: false as const, grund: 'mandat_fremd' as const,
      betroffeneQuelle: { dokumentId: 'd1', seite: 1, zitat: 'x' } }));

    const zweite = erstelleVorschlag(db, deskId, eingabe({ idempotenzKey: 'retry-quelle' }), ki, pruefung);

    expect(zweite.id).toBe(erste.id);
    expect(pruefung).not.toHaveBeenCalled();
  });
});

describe('genehmigeVorschlag — Genehmigungs-Guard (vorAnwendung, 12-03 Task 2)', () => {
  it('rollt bei verweigernder vorAnwendung-Prüfung zurück: Status bleibt ausstehend, inverse bleibt NULL, Desk unberührt', () => {
    const v = erstelleVorschlag(db, deskId, eingabe(), ki);
    const revVorher = db.prepare('SELECT rev FROM desks WHERE id = ?').get(deskId) as { rev: number };

    expect(() => genehmigeVorschlag(db, deskId, v.id, genehmiger, echteAnwendung,
      () => 'Kein Bearbeitungsrecht auf der Ebene des Objekts.')).toThrow(GenehmigungVerweigertError);

    const zeile = zeileRoh(v.id)!;
    expect(zeile.status).toBe('ausstehend');
    expect(zeile.inverse).toBeNull();
    expect(zeile.genehmigte_objekte).toBeNull();
    expect(zeile.decided_at).toBeNull();
    const revNachher = db.prepare('SELECT rev FROM desks WHERE id = ?').get(deskId) as { rev: number };
    expect(revNachher.rev).toBe(revVorher.rev);
  });

  it('Guard-Reihenfolge: ein entschiedener Vorschlag löst KEINE erneute Rechteprüfung aus (409 vor 403)', () => {
    const v = erstelleVorschlag(db, deskId, eingabe(), ki);
    lehneVorschlagAb(db, deskId, v.id, genehmiger);
    const pruefung = vi.fn(() => 'würde verweigern');

    expect(() => genehmigeVorschlag(db, deskId, v.id, genehmiger, echteAnwendung, pruefung))
      .toThrow(VorschlagStatusError);
    expect(pruefung).not.toHaveBeenCalled();
  });

  it('lässt die Genehmigung durch, wenn die vorAnwendung-Prüfung null liefert', () => {
    const v = erstelleVorschlag(db, deskId, eingabe({ payload: { id: 'n-guard-ok', kind: 'notiz', text: 't', position: { x: 1, y: 1 } } }), ki);

    const ergebnis = genehmigeVorschlag(db, deskId, v.id, genehmiger, echteAnwendung, () => null);

    expect(ergebnis.vorschlag.status).toBe('genehmigt');
    expect(zeileRoh(v.id)!.status).toBe('genehmigt');
  });
});

describe('nimmVorschlagZurueck (AI-02, 12-04)', () => {
  /** Spielt die Inverse wie die Route ab: applyDeskCommand pro Kommando mit dem Rücknehmenden. */
  function echtesAbspielen(kommandos: Command[], actor: Actor) {
    let rev = 0;
    for (const cmd of kommandos) rev = applyDeskCommand(db, deskId, cmd, actor).rev;
    return { rev };
  }

  it('spielt die persistierte Inverse ab, setzt status zurückgenommen und journaliert den Marker', () => {
    const v = erstelleVorschlag(db, deskId, eingabe({ payload: { id: 'n-zurueck', kind: 'notiz', text: 't', position: { x: 1, y: 1 } } }), ki);
    genehmigeVorschlag(db, deskId, v.id, genehmiger, echteAnwendung);

    const ergebnis = nimmVorschlagZurueck(db, deskId, v.id, genehmiger, echtesAbspielen);

    expect(ergebnis.vorschlag.status).toBe('zurückgenommen');
    expect(zeileRoh(v.id)!.status).toBe('zurückgenommen');
    // Desk: die Notiz ist wieder weg.
    const desk = db.prepare('SELECT state FROM desks WHERE id = ?').get(deskId) as { state: string };
    expect((JSON.parse(desk.state).notes ?? []).some((n: { id: string }) => n.id === 'n-zurueck')).toBe(false);
    // Marker mit Doppelstempel.
    const marker = db.prepare(
      "SELECT payload, actor_name AS actorName FROM command_journal WHERE desk_id = ? AND type = 'vorschlagZurueckgenommen'",
    ).get(deskId) as { payload: string; actorName: string };
    expect(JSON.parse(marker.payload)).toMatchObject({ vorschlagId: v.id, kiAkteur: 'ki-agent', approvedBy: 'anwalt-a' });
    expect(marker.actorName).toBe('anwalt-a');
  });

  it('wirft VorschlagGeaendertError bei updatedRev-Abweichung und rollt vollständig zurück (Menschenarbeit bleibt)', () => {
    const v = erstelleVorschlag(db, deskId, eingabe({ payload: { id: 'n-zwischen', kind: 'notiz', text: 'original', position: { x: 1, y: 1 } } }), ki);
    genehmigeVorschlag(db, deskId, v.id, genehmiger, echteAnwendung);
    // Menschliche Zwischenarbeit am selben Objekt.
    applyDeskCommand(db, deskId, { type: 'editNote', payload: { id: 'n-zwischen', text: 'von Mensch geändert' } }, genehmiger);

    expect(() => nimmVorschlagZurueck(db, deskId, v.id, genehmiger, echtesAbspielen))
      .toThrow(VorschlagGeaendertError);

    // Rollback: Status bleibt 'genehmigt', der Text des Menschen bleibt unangetastet.
    expect(zeileRoh(v.id)!.status).toBe('genehmigt');
    const desk = db.prepare('SELECT state FROM desks WHERE id = ?').get(deskId) as { state: string };
    const notiz = (JSON.parse(desk.state).notes ?? []).find((n: { id: string }) => n.id === 'n-zwischen');
    expect(notiz.text).toBe('von Mensch geändert');
    // Kein Marker entstanden.
    const marker = db.prepare(
      "SELECT COUNT(*) AS n FROM command_journal WHERE desk_id = ? AND type = 'vorschlagZurueckgenommen'",
    ).get(deskId) as { n: number };
    expect(marker.n).toBe(0);
  });

  it('wirft VorschlagStatusError auf ausstehend/abgelehnt und nach erfolgreicher Rücknahme (terminal)', () => {
    const ausstehend = erstelleVorschlag(db, deskId, eingabe(), ki);
    expect(() => nimmVorschlagZurueck(db, deskId, ausstehend.id, genehmiger, echtesAbspielen))
      .toThrow(VorschlagStatusError);

    const abgelehnt = erstelleVorschlag(db, deskId, eingabe(), ki);
    lehneVorschlagAb(db, deskId, abgelehnt.id, genehmiger);
    expect(() => nimmVorschlagZurueck(db, deskId, abgelehnt.id, genehmiger, echtesAbspielen))
      .toThrow(VorschlagStatusError);

    const terminal = erstelleVorschlag(db, deskId, eingabe(), ki);
    genehmigeVorschlag(db, deskId, terminal.id, genehmiger, echteAnwendung);
    nimmVorschlagZurueck(db, deskId, terminal.id, genehmiger, echtesAbspielen);
    expect(() => nimmVorschlagZurueck(db, deskId, terminal.id, genehmiger, echtesAbspielen))
      .toThrow(VorschlagStatusError);
  });
});

describe('genehmigeVorschlag — atomarer Status+Inverse-Commit', () => {
  it('persistiert inverse und genehmigte_objekte in derselben Transaktion (nach Erfolg NOT NULL)', () => {
    const v = erstelleVorschlag(db, deskId, eingabe({ payload: { id: 'n-atomar', kind: 'notiz', text: 't', position: { x: 1, y: 1 } } }), ki);

    const ergebnis = genehmigeVorschlag(db, deskId, v.id, genehmiger, echteAnwendung);

    const zeile = zeileRoh(v.id)!;
    expect(zeile.status).toBe('genehmigt');
    expect(zeile.inverse).not.toBeNull();
    expect(JSON.parse(zeile.inverse!)).toEqual([{ type: 'removeNote', payload: { id: 'n-atomar' } }]);
    expect(zeile.genehmigte_objekte).not.toBeNull();
    expect(JSON.parse(zeile.genehmigte_objekte!)).toEqual([{ id: 'n-atomar', updatedRev: ergebnis.rev }]);

    // Der gelesene Vorschlag spiegelt die persistierte Entscheidung.
    const gelesen = findeVorschlag(db, deskId, v.id)!;
    expect(gelesen.status).toBe('genehmigt');
    expect(gelesen.inverse).toHaveLength(1);
    expect(gelesen.genehmigteObjekte).toHaveLength(1);
  });

  it('rollt bei werfender Anwendung vollständig zurück: Zeile bleibt ausstehend ohne inverse', () => {
    const v = erstelleVorschlag(db, deskId, eingabe(), ki);

    expect(() => genehmigeVorschlag(db, deskId, v.id, genehmiger, () => {
      throw new Error('Anwendung explodiert absichtlich');
    })).toThrow('Anwendung explodiert absichtlich');

    const zeile = zeileRoh(v.id)!;
    expect(zeile.status).toBe('ausstehend');
    expect(zeile.inverse).toBeNull();
    expect(zeile.genehmigte_objekte).toBeNull();
    expect(zeile.decided_at).toBeNull();
  });
});
