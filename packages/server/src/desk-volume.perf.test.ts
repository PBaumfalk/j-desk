import { describe, it, expect } from 'vitest';
import { applyCommand, emptyState, projectStateForActor, type ActorContext, type DesktopState } from '@j-desk/core';
import { openDb, type Db } from './db';
import { createDesk, type Actor } from './deskStore';
import { appendJournal, vielleichtSnapshot } from './journal';
import { createTestAppMitZweiNutzern } from './testUtils';

/**
 * OPS-04 — Lasttest: beweist, dass J-DESK eine realistisch große Akte trägt. Ein Schreibtisch mit
 * mehreren hundert Dokumenten plus Objekten weiterer versionierter Arten, verteilt über drei
 * Ebenen, wird AUSSCHLIESSLICH über echte Kommandos aufgebaut — nicht per direktem Schreiben in
 * die Zustandsspalte, sonst misst der Test eine Last, die im Betrieb nie auftritt (14-RESEARCH.md
 * Pitfall 4). Analog: restore.perf.test.ts (Schwellen als benannte, kommentierte Konstanten,
 * Fixture in EINER Transaktion mit Journalzeilen im Betriebstakt, Korrektheitszusicherung neben
 * der reinen Geschwindigkeit).
 *
 * Gemessen werden die drei Pfade, die unter Volumen wirklich tragen (14-03-PLAN.md): die
 * Kommandokette selbst und die Projektion je Rolle (projectStateForActor, Task 1 unten) sowie die
 * volle Zustandsauslieferung über die echte HTTP-Route inklusive Guard und Serialisierung
 * (14-03-PLAN.md Task 2 — kommt als eigener describe-Block in dieser Datei dazu).
 */

// ---------------------------------------------------------------------------------------------
// Größen: "mehrere hundert Dokumente" (Roadmap wörtlich) plus drei weitere versionierte Arten,
// jeweils verteilt über drei Ebenen (Kanzlei implizit ohne layerId, private Ebene eines
// Zweitnutzers, exportierbare System-Ebene) — nur so leistet die Projektion echte Filterarbeit,
// statt alles durchzureichen (14-03-PLAN.md Task 1, Punkt 3).
// ---------------------------------------------------------------------------------------------
const DOC_KANZLEI = 250;
const DOC_PRIVAT = 100;
const DOC_EXPORT = 100;
const DOC_COUNT = DOC_KANZLEI + DOC_PRIVAT + DOC_EXPORT; // 450

const NOTE_KANZLEI = 90;
const NOTE_PRIVAT = 30;
const NOTE_EXPORT = 30;
const NOTE_COUNT = NOTE_KANZLEI + NOTE_PRIVAT + NOTE_EXPORT; // 150

const STAMP_KANZLEI = 60;
const STAMP_PRIVAT = 20;
const STAMP_EXPORT = 20;
const STAMP_COUNT = STAMP_KANZLEI + STAMP_PRIVAT + STAMP_EXPORT; // 100

const FLAG_KANZLEI = 60;
const FLAG_PRIVAT = 20;
const FLAG_EXPORT = 20;
const FLAG_COUNT = FLAG_KANZLEI + FLAG_PRIVAT + FLAG_EXPORT; // 100

const GESAMT_OBJEKTE = DOC_COUNT + NOTE_COUNT + STAMP_COUNT + FLAG_COUNT; // 800

// Erwartete Sichtzahlen (Korrektheit vor Geschwindigkeit, 14-03-PLAN.md Task 1 Punkt 4/5): der
// Eigentümer sieht Kanzlei + exportierbar (nicht die fremde private Ebene des Zweitnutzers, s.
// istObjektSichtbarFuer in layers.ts); der externe Gast sieht NUR exportierbar — Kanzlei-Objekte
// tragen ohne Override die effektive Freigabe 'intern' (freigabe.ts effektiveFreigabe) und
// fallen für 'externer Gast' aus der Projektion (projection.ts gastFilter).
const EIGENTUEMER_SICHTBAR =
  DOC_KANZLEI + DOC_EXPORT + NOTE_KANZLEI + NOTE_EXPORT + STAMP_KANZLEI + STAMP_EXPORT + FLAG_KANZLEI + FLAG_EXPORT; // 700
const GAST_SICHTBAR = DOC_EXPORT + NOTE_EXPORT + STAMP_EXPORT + FLAG_EXPORT; // 170

/**
 * Vorgehen für die Schwellenwahl (14-03-PLAN.md Task 3): erst gemessen (mehrere Läufe, s.
 * docs/deployment/lasttest-befunde.md für die Ausgangswerte), dann mit deutlicher Reserve über
 * dem beobachteten Höchstwert gesetzt, damit Maschinenstreuung und langsamere Ausführungs-
 * umgebungen den Test nicht rot färben. Gemessene Höchstwerte über mehrere lokale Läufe:
 * Kommandokette ~42 ms, Projektion je Rolle ~0.7 ms, Auslieferung über die echte HTTP-Route
 * (Eigentümer) ~4.3 ms. Reserve variiert je Pfad: die Kommandokette schreibt ~1.140 Journalzeilen
 * synchron nach SQLite und ist damit am empfindlichsten für I/O-Streuung (Faktor ~5); die reinen
 * In-Memory-/HTTP-Pfade (Projektion, Auslieferung) bekommen absolute Untergrenzen mit
 * großzügigem Puffer statt eines reinen Vielfachen von Sub-Millisekunden-Werten, sonst würde ein
 * einzelner GC-Tick den Test rot färben.
 */
const KOMMANDOKETTE_SCHWELLE_MS = 200;
const PROJEKTION_SCHWELLE_MS = 25;
// Liegt naturgemäß über PROJEKTION_SCHWELLE_MS: Guard-Auswertung, Datenbanklesung (SELECT +
// JSON.parse des vollen, unprojizierten Zustands) und HTTP-Serialisierung kommen zur reinen
// Projektionsarbeit hinzu (14-03-PLAN.md Task 2, Punkt 2).
const AUSLIEFERUNG_SCHWELLE_MS = 100;

function dbMitZweiBenutzern(): { db: Db; owner: { id: string; name: string }; zweitnutzer: { id: string; name: string } } {
  const db = openDb(':memory:');
  db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)').run('u-eigentuemer', 'eigentuemer', 'h', 0);
  db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)').run('u-zweitnutzer', 'zweitnutzer', 'h', 0);
  return { db, owner: { id: 'u-eigentuemer', name: 'Frau Müller' }, zweitnutzer: { id: 'u-zweitnutzer', name: 'Herr Schmidt' } };
}

/**
 * Baut einen realistisch großen Schreibtisch AUSSCHLIESSLICH über echte Kommandos auf (RESEARCH
 * Pitfall 4) — ALLES in EINER db.transaction() (sonst dominiert der Transaktions-Overhead die
 * Messung, Analog restore.perf.test.ts baueJournal): der Zustand wird über applyCommand
 * fortlaufend mitgeführt, jede Revision bekommt eine Journalzeile plus — im selben Takt wie im
 * echten Betrieb — eine automatische snapshot-Zeile über vielleichtSnapshot() bei jedem
 * SNAPSHOT_INTERVAL-ten rev. Verteilt DOC/NOTE/STAMP/FLAG-Objekte über drei Ebenen: die ersten
 * *_KANZLEI bleiben ohne layerId (implizit Kanzlei), die nächsten *_PRIVAT wandern per
 * changeLayerId auf die private Ebene des Zweitnutzers (lazy materialisiert beim ersten Aufruf,
 * s. layers.ts ensurePrivateLayer), die letzten *_EXPORT auf die exportierbare System-Ebene.
 */
function baueVolumen(
  db: Db,
  deskId: string,
  owner: { id: string; name: string },
  zweitnutzer: { id: string; name: string },
): DesktopState {
  let state = emptyState();
  let rev = 0;

  const txn = db.transaction((): void => {
    const wende = (type: string, payload: Record<string, unknown>, actor: Actor): void => {
      rev += 1;
      const meta = { createdBy: actor.name, createdAt: '2026-01-01T00:00:00.000Z', ...(actor.id ? { createdById: actor.id } : {}) };
      state = applyCommand(state, { type, payload }, meta);
      appendJournal(db, { deskId, rev, type, payload, actorId: actor.id, actorName: actor.name });
      vielleichtSnapshot(db, deskId, rev, state);
    };

    // Verteilt eine bereits erzeugte id-Liste einer Objektart über die private und die
    // exportierbare Ebene — der verbleibende, führende Anteil bleibt implizit auf Kanzlei.
    const verteile = (ids: string[], kanzleiAnteil: number, privatAnteil: number): void => {
      for (let i = kanzleiAnteil; i < kanzleiAnteil + privatAnteil; i += 1) {
        wende('changeLayerId', { objectId: ids[i], layerId: 'privat' }, zweitnutzer);
      }
      for (let i = kanzleiAnteil + privatAnteil; i < ids.length; i += 1) {
        wende('changeLayerId', { objectId: ids[i], layerId: 'exportierbar' }, owner);
      }
    };

    const docIds: string[] = [];
    for (let i = 0; i < DOC_COUNT; i += 1) {
      const docId = `doc-${i}`;
      wende('addDoc', { fileId: `file-${i}`, name: `${i}.pdf`, position: { x: i, y: i }, id: docId }, owner);
      docIds.push(docId);
    }
    verteile(docIds, DOC_KANZLEI, DOC_PRIVAT);

    const noteIds: string[] = [];
    for (let i = 0; i < NOTE_COUNT; i += 1) {
      const noteId = `note-${i}`;
      wende('addNote', { kind: 'notiz', text: `Notiz ${i}`, position: { x: i, y: i + 1 }, id: noteId }, owner);
      noteIds.push(noteId);
    }
    verteile(noteIds, NOTE_KANZLEI, NOTE_PRIVAT);

    const stampIds: string[] = [];
    for (let i = 0; i < STAMP_COUNT; i += 1) {
      const stampId = `stamp-${i}`;
      const docId = docIds[i % docIds.length];
      wende(
        'addStamp',
        { stamp: { id: stampId, docId, page: 1, x: 10, y: 10, angle: 0, text: 'GEPRÜFT', color: 'blue', baseW: 600, baseH: 800 } },
        owner,
      );
      stampIds.push(stampId);
    }
    verteile(stampIds, STAMP_KANZLEI, STAMP_PRIVAT);

    const flagIds: string[] = [];
    for (let i = 0; i < FLAG_COUNT; i += 1) {
      const flagId = `flag-${i}`;
      const docId = docIds[i % docIds.length];
      wende('addFlag', { flag: { id: flagId, docId, page: 1, offset: 0.5, color: '#e5484d' } }, owner);
      flagIds.push(flagId);
    }
    verteile(flagIds, FLAG_KANZLEI, FLAG_PRIVAT);
  });
  txn();

  // Endzustand EINMAL zurückschreiben (wie im echten Betrieb der letzte applyDeskCommand-Schreib-
  // punkt) — der Fixture-Aufbau selbst läuft über Kommandos, nicht über wiederholtes Schreiben.
  db.prepare('UPDATE desks SET state = ?, rev = ? WHERE id = ?').run(JSON.stringify(state), rev, deskId);
  return state;
}

function zaehleObjekte(state: DesktopState, art: 'docs' | 'notes' | 'stamps' | 'flags'): number {
  return (state as unknown as Record<string, unknown[]>)[art].length;
}

function sichtbareObjekte(state: DesktopState): number {
  return zaehleObjekte(state, 'docs') + zaehleObjekte(state, 'notes') + zaehleObjekte(state, 'stamps') + zaehleObjekte(state, 'flags');
}

describe(`Performance: realistisch große Akte (${GESAMT_OBJEKTE} Objekte über 4 Arten, OPS-04)`, () => {
  it(`Kommandokette baut ${GESAMT_OBJEKTE} Objekte in unter ${KOMMANDOKETTE_SCHWELLE_MS} ms auf — Objektzahl je Art exakt`, () => {
    const { db, owner, zweitnutzer } = dbMitZweiBenutzern();
    const desk = createDesk(db, owner.id, 'Große Akte');

    const start = performance.now();
    const state = baueVolumen(db, desk.id, owner, zweitnutzer);
    const dauerMs = performance.now() - start;
    // eslint-disable-next-line no-console
    console.log(`[OPS-04] Kommandokette (${GESAMT_OBJEKTE} Objekte, ${DOC_COUNT} docs): ${dauerMs.toFixed(1)} ms`);

    expect(dauerMs).toBeLessThan(KOMMANDOKETTE_SCHWELLE_MS);
    expect(zaehleObjekte(state, 'docs')).toBe(DOC_COUNT);
    expect(zaehleObjekte(state, 'notes')).toBe(NOTE_COUNT);
    expect(zaehleObjekte(state, 'stamps')).toBe(STAMP_COUNT);
    expect(zaehleObjekte(state, 'flags')).toBe(FLAG_COUNT);
  }, 30_000);

  it(`Projektion für Eigentümer bleibt unter ${PROJEKTION_SCHWELLE_MS} ms und enthält alle sichtbaren Objekte`, () => {
    const { db, owner, zweitnutzer } = dbMitZweiBenutzern();
    const desk = createDesk(db, owner.id, 'Große Akte');
    const state = baueVolumen(db, desk.id, owner, zweitnutzer);
    const ctx: ActorContext = { userId: owner.id, rolle: 'Eigentümer' };

    const start = performance.now();
    const projiziert = projectStateForActor(state, ctx);
    const dauerMs = performance.now() - start;
    console.log(`[OPS-04] Projektion Eigentümer: ${dauerMs.toFixed(1)} ms`);

    expect(dauerMs).toBeLessThan(PROJEKTION_SCHWELLE_MS);
    expect(sichtbareObjekte(projiziert)).toBe(EIGENTUEMER_SICHTBAR);
  }, 30_000);

  it(`Projektion für externen Gast bleibt unter ${PROJEKTION_SCHWELLE_MS} ms und ist echt kleiner als die des Eigentümers`, () => {
    const { db, owner, zweitnutzer } = dbMitZweiBenutzern();
    const desk = createDesk(db, owner.id, 'Große Akte');
    const state = baueVolumen(db, desk.id, owner, zweitnutzer);
    const gastCtx: ActorContext = { userId: 'u-gast-ohne-privatebene', rolle: 'externer Gast' };

    const start = performance.now();
    const projiziert = projectStateForActor(state, gastCtx);
    const dauerMs = performance.now() - start;
    console.log(`[OPS-04] Projektion externer Gast: ${dauerMs.toFixed(1)} ms`);

    expect(dauerMs).toBeLessThan(PROJEKTION_SCHWELLE_MS);
    expect(sichtbareObjekte(projiziert)).toBe(GAST_SICHTBAR);
    expect(sichtbareObjekte(projiziert)).toBeLessThan(EIGENTUEMER_SICHTBAR);
  }, 30_000);
});

describe('Performance: Zustandsauslieferung über die HTTP-Schicht unter Volumen (OPS-04, Task 2)', () => {
  it(`GET /desks/:id/state bleibt für den Eigentümer unter ${AUSLIEFERUNG_SCHWELLE_MS} ms (Guard + Projektion + Serialisierung, echte App)`, async () => {
    const { app, db, a } = await createTestAppMitZweiNutzern();
    const deskRes = await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Große Akte' } });
    const desk = deskRes.json() as { id: string };
    baueVolumen(db, desk.id, { id: a.userId, name: 'Nutzer A' }, { id: 'u-zweitnutzer-http', name: 'Nutzer B' });

    const start = performance.now();
    const res = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/state`, headers: a.authHeaders });
    const dauerMs = performance.now() - start;
    const groesseBytes = Buffer.byteLength(res.payload, 'utf8');
    console.log(`[OPS-04] Auslieferung Eigentümer: ${dauerMs.toFixed(1)} ms, ${groesseBytes} Bytes`);

    expect(res.statusCode).toBe(200);
    expect(dauerMs).toBeLessThan(AUSLIEFERUNG_SCHWELLE_MS);
    const body = res.json() as { state: DesktopState };
    expect(sichtbareObjekte(body.state)).toBe(EIGENTUEMER_SICHTBAR);
  }, 30_000);

  it(`GET /desks/:id/state bleibt für eine eingeschränkte Rolle (externer Gast) unter ${AUSLIEFERUNG_SCHWELLE_MS} ms und liefert weniger Objekte als die Eigentümer-Antwort`, async () => {
    const { app, db, a, b } = await createTestAppMitZweiNutzern();
    const deskRes = await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Große Akte' } });
    const desk = deskRes.json() as { id: string };
    // Zweitnutzer bekommt eine eingeschränkte Rolle (dasselbe Muster wie app.roles.test.ts) —
    // seine private Ebene ist die, gegen die baueVolumen() die *_PRIVAT-Objekte verteilt.
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(desk.id, b.userId, 'externer Gast');
    baueVolumen(db, desk.id, { id: a.userId, name: 'Nutzer A' }, { id: b.userId, name: 'Nutzer B' });

    const eigentuemerRes = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/state`, headers: a.authHeaders });
    const eigentuemerSichtbar = sichtbareObjekte((eigentuemerRes.json() as { state: DesktopState }).state);

    const start = performance.now();
    const res = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/state`, headers: b.authHeaders });
    const dauerMs = performance.now() - start;
    const groesseBytes = Buffer.byteLength(res.payload, 'utf8');
    console.log(`[OPS-04] Auslieferung externer Gast: ${dauerMs.toFixed(1)} ms, ${groesseBytes} Bytes`);

    expect(res.statusCode).toBe(200);
    expect(dauerMs).toBeLessThan(AUSLIEFERUNG_SCHWELLE_MS);
    const body = res.json() as { state: DesktopState };
    expect(sichtbareObjekte(body.state)).toBe(GAST_SICHTBAR);
    expect(sichtbareObjekte(body.state)).toBeLessThan(eigentuemerSichtbar);
  }, 30_000);
});
