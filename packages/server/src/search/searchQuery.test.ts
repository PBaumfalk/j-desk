import { describe, it, expect } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import type { DesktopState } from '@j-desk/core';
import { createTestApp, createTestAppMitZweiNutzern } from '../testUtils';
import { storeFile } from '../files';
import type { Db } from '../db';
import { warteAufLeerlauf, KONFIDENZ_SCHWELLE } from '../ocr/ocrQueue';
import { VERSIONIERTE_ARTEN } from '@j-desk/core';
import { fts5QueryAus, labelFuer, ART_ZU_TREFFERART } from './searchQuery';

const pdf = Buffer.from('%PDF-1.4\ninhalt');

/** Ein echtes, per pdf-lib erzeugtes Einseiten-PDF mit unauffälligem Text — dient als Trägerdatei
 *  für die OCR-Trefferteststs unten: der eingebettete Text darf mit keinem der dort verwendeten
 *  Suchbegriffe kollidieren, sonst würde die reale (nicht gemockte) 07-04-Textextraktion einen
 *  zweiten, unbeabsichtigten Kandidaten erzeugen. */
async function pdfOhneRelevantenText(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const seite = doc.addPage([595, 842]);
  seite.drawText('Unauffaelliger eingebetteter Seitentext ohne Bezug zu den Testbegriffen.', { x: 50, y: 700, size: 12, font });
  return Buffer.from(await doc.save());
}

/**
 * Schreibt ein OCR-Ergebnis direkt in `file_pages`/`file_pages_fts` (kein tesseract im Test,
 * CONTEXT.md-Vorgabe) — ergänzt eine bereits vorhandene Zeile (aus der vorangegangenen realen
 * PDF-Textextraktion) statt eine zweite anzulegen, exakt wie `schreibeOcrErgebnis` in
 * ocrQueue.ts, damit der Suchpfad unabhängig von der Erkennungsstufe geprüft wird.
 */
function legeOcrErgebnisAn(db: Db, fileId: string, page: number, ocrText: string, confidence: number): void {
  const vorhanden = db.prepare('SELECT 1 FROM file_pages WHERE file_id = ? AND page = ?').get(fileId, page);
  if (vorhanden) {
    db.prepare('UPDATE file_pages SET ocr_text = ?, ocr_confidence = ? WHERE file_id = ? AND page = ?').run(
      ocrText, confidence, fileId, page,
    );
    db.prepare('UPDATE file_pages_fts SET ocr_text = ? WHERE file_id = ? AND page = ?').run(ocrText, fileId, page);
  } else {
    db.prepare('INSERT INTO file_pages (file_id, page, pdf_text, ocr_text, ocr_confidence) VALUES (?, ?, NULL, ?, ?)').run(
      fileId, page, ocrText, confidence,
    );
    db.prepare('INSERT INTO file_pages_fts (file_id, page, pdf_text, ocr_text) VALUES (?, ?, NULL, ?)').run(
      fileId, page, ocrText,
    );
  }
}

/** Legt eine Akte mit genau einem Notizzettel an — Hilfsfunktion für die Schreibweisen-/
 *  Ersteller-/Datumstests unten, die alle keine Datei brauchen (Notiz statt Karte). */
async function akteMitNotiz(text: string, id = 'note-1') {
  const { app, authHeaders } = await createTestApp();
  const desk = (
    await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'Akte' } })
  ).json();
  const anlegen = await app.inject({
    method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
    payload: { type: 'addNote', payload: { id, kind: 'notiz', text, position: { x: 0, y: 0 } } },
  });
  return { app, authHeaders, desk, notiz: anlegen.json().state.notes.find((n: { id: string }) => n.id === id) };
}

async function suche(app: Awaited<ReturnType<typeof createTestApp>>['app'], authHeaders: { authorization: string }, deskId: string, q: string) {
  const res = await app.inject({ method: 'POST', url: `/api/v1/desks/${deskId}/search`, headers: authHeaders, payload: { q } });
  return (res.json() as { treffer: { objId: string; label: string }[] }).treffer;
}

describe('POST /api/v1/desks/:id/search (echter Durchstich über die reale App)', () => {
  it('findet eine per Command angelegte Karte anhand ihres Titels', async () => {
    const { app, db, dataDir, authHeaders } = await createTestApp();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'Akte A' } })
    ).json();
    const meta = storeFile(db, dataDir, pdf, 'kuendigung.pdf');
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'addDoc', payload: { fileId: meta.id, name: 'Kündigungsschreiben Müller', position: { x: 0, y: 0 }, id: 'doc-1' } },
    });

    const res = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/search`, headers: authHeaders, payload: { q: 'Kündigung' },
    });
    expect(res.statusCode).toBe(200);
    const { treffer } = res.json() as { treffer: { objId: string; art: string; label: string }[] };
    expect(treffer.some((t) => t.objId === 'doc-1' && t.art === 'Karte')).toBe(true);
  });

  it('leerer Suchtext liefert eine leere Trefferliste, keinen Fehler', async () => {
    const { app, authHeaders } = await createTestApp();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'Akte A' } })
    ).json();
    const res = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/search`, headers: authHeaders, payload: { q: '   ' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ treffer: [] });
  });

  it('ein Suchtext aus reinen FTS5-Operatorzeichen liefert 200 + leere Liste, keinen 500er', async () => {
    const { app, db, dataDir, authHeaders } = await createTestApp();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'Akte A' } })
    ).json();
    const meta = storeFile(db, dataDir, pdf, 'a.pdf');
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'addDoc', payload: { fileId: meta.id, name: 'Irrelevante Karte', position: { x: 0, y: 0 }, id: 'doc-1' } },
    });

    const res = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/search`, headers: authHeaders, payload: { q: '"*() OR AND NOT' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ treffer: [] });
  });

  it('q als Nicht-String -> 400', async () => {
    const { app, authHeaders } = await createTestApp();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'Akte A' } })
    ).json();
    const res = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/search`, headers: authHeaders, payload: { q: 42 },
    });
    expect(res.statusCode).toBe(400);
  });
});

/**
 * Task-1-`<done>`-Kriterium end-to-end: ein Treffer in einem Stempel, einem Ausschnitt oder
 * einer Verknüpfungsnotiz kommt über die reale HTTP-Route an — mit korrektem Art-Badge, nicht
 * nur über den (bereits per Unit-Test abgesicherten) `indexZeileFuer`-Feldzugriff.
 */
describe('Treffer über neue Objektarten (Stempel/Ausschnitt/Verknüpfung) — echter Durchstich', () => {
  it('findet einen Stempeltext mit korrektem Art-Badge "Stempel"', async () => {
    const { app, db, dataDir, authHeaders } = await createTestApp();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'Akte Stempel' } })
    ).json();
    const meta = storeFile(db, dataDir, pdf, 'eingang.pdf');
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'addDoc', payload: { id: 'doc-stempel', fileId: meta.id, name: 'Schreiben', position: { x: 0, y: 0 } } },
    });
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: {
        type: 'addStamp',
        payload: { stamp: { id: 'stamp-1', docId: 'doc-stempel', page: 1, x: 0, y: 0, angle: 0, text: 'SONDERFALL-EINGANG', color: 'red', baseW: 100, baseH: 100 } },
      },
    });

    const treffer = await suche(app, authHeaders, desk.id, 'SONDERFALL-EINGANG');
    const eintrag = treffer.find((t) => t.objId === 'stamp-1') as { art?: string } | undefined;
    expect(eintrag).toBeDefined();
    expect(eintrag?.art).toBe('Stempel');
  });

  it('findet einen Ausschnitt-Textsnapshot mit korrektem Art-Badge "Ausschnitt"', async () => {
    const { app, db, dataDir, authHeaders } = await createTestApp();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'Akte Ausschnitt' } })
    ).json();
    const meta = storeFile(db, dataDir, pdf, 'urteil.pdf');
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'addDoc', payload: { id: 'doc-ausschnitt', fileId: meta.id, name: 'Urteil', position: { x: 0, y: 0 } } },
    });
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: {
        type: 'addCutout',
        payload: { id: 'cutout-1', docId: 'doc-ausschnitt', page: 1, rect: { x: 0, y: 0, w: 10, h: 10 }, position: { x: 0, y: 0 }, textSnapshot: 'ZITIERTE-TENOR-FORMULIERUNG' },
      },
    });

    const treffer = await suche(app, authHeaders, desk.id, 'ZITIERTE-TENOR-FORMULIERUNG');
    const eintrag = treffer.find((t) => t.objId === 'cutout-1') as { art?: string } | undefined;
    expect(eintrag).toBeDefined();
    expect(eintrag?.art).toBe('Ausschnitt');
  });

  it('findet eine Verknüpfungsnotiz mit korrektem Art-Badge "Verknüpfung"', async () => {
    const { app, db, dataDir, authHeaders } = await createTestApp();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'Akte Verknüpfung' } })
    ).json();
    const metaA = storeFile(db, dataDir, pdf, 'a.pdf');
    const metaB = storeFile(db, dataDir, Buffer.from('%PDF-1.4\nb'), 'b.pdf');
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'addDoc', payload: { id: 'doc-link-a', fileId: metaA.id, name: 'Karte A', position: { x: 0, y: 0 } } },
    });
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'addDoc', payload: { id: 'doc-link-b', fileId: metaB.id, name: 'Karte B', position: { x: 100, y: 0 } } },
    });
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'addLink', payload: { id: 'link-1', fromId: 'doc-link-a', toId: 'doc-link-b' } },
    });
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'setLinkNote', payload: { linkId: 'link-1', note: 'Bezug zur Widerspruchsfrist' } },
    });

    const treffer = await suche(app, authHeaders, desk.id, 'Widerspruchsfrist');
    const eintrag = treffer.find((t) => t.objId === 'link-1') as { art?: string; label?: string } | undefined;
    expect(eintrag).toBeDefined();
    expect(eintrag?.art).toBe('Verknüpfung');
    expect(eintrag?.label).toBe('Bezug zur Widerspruchsfrist');
  });

  // WR-03 (09-REVIEW.md): indexZeileFuer() indiziert den Zeitleisten-Kartentitel bereits seit
  // 09-02, aber ohne einen 'zeitleisten'-Eintrag in ART_ZU_TREFFERART wurde jeder so indizierte
  // Kandidat vor der Auslieferung stillschweigend herausgefiltert (dieselbe Stelle, die `flags`
  // absichtlich verwirft) — die Indizierung hatte dadurch nie eine beobachtbare Wirkung.
  it('findet eine Zeitleiste über ihren (festen) Kartentitel mit korrektem Art-Badge "Zeitleiste"', async () => {
    const { app, authHeaders } = await createTestApp();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'Akte Zeitleiste' } })
    ).json();
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'addZeitleiste', payload: { id: 'zl-such-1', position: { x: 0, y: 0 } } },
    });

    const treffer = await suche(app, authHeaders, desk.id, 'Zeitleiste');
    const eintrag = treffer.find((t) => t.objId === 'zl-such-1') as { art?: string } | undefined;
    expect(eintrag).toBeDefined();
    expect(eintrag?.art).toBe('Zeitleiste');
  });

  // Dieselbe Lücke wie bei `zeitleisten` oben, nur für die beiden Arten, die der Kommentar in
  // searchQuery.ts als "vorbestehende Lücke aus Phase 8" ausdrücklich offen ließ:
  // indexZeileFuer() indiziert `legalObjects.text` und den `tables`-Titel seit Phase 8, aber ohne
  // Eintrag in ART_ZU_TREFFERART fiel jeder Kandidat über `if (!art) continue` lautlos heraus.
  //
  // Praktische Auswirkung, die den Fix rechtfertigt: ALLE 13 juristischen Objekttypen aus
  // LEGAL-01 (Tatsache, eigene Behauptung, Behauptung der Gegenseite, Beweismittel …) waren über
  // die Suche unauffindbar — bei einem Werkzeug, dessen Kern das Anlegen genau dieser Objekte
  // ist. Am laufenden System reproduziert: "Kaufpreis" lieferte null Treffer, obwohl eine
  // Behauptungskarte mit diesem Wort auf dem Tisch lag.
  it('findet ein juristisches Objekt über seinen Text mit korrektem Art-Badge "Objekt"', async () => {
    const { app, authHeaders } = await createTestApp();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'Akte Objekt' } })
    ).json();
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: {
        type: 'addLegalObject',
        payload: { id: 'lo-such-1', kind: 'tatsache', text: 'Der Kaufpreis war fällig', position: { x: 0, y: 0 } },
      },
    });

    const treffer = await suche(app, authHeaders, desk.id, 'Kaufpreis');
    const eintrag = treffer.find((t) => t.objId === 'lo-such-1') as { art?: string; label?: string } | undefined;
    expect(eintrag).toBeDefined();
    expect(eintrag?.art).toBe('Objekt');
    expect(eintrag?.label).toBe('Der Kaufpreis war fällig');
  });

  it('findet eine Tabellenkarte über ihren Titel mit korrektem Art-Badge "Tabelle"', async () => {
    const { app, authHeaders } = await createTestApp();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'Akte Tabelle' } })
    ).json();
    // addTable legt die Karte mit leerem Titel an; benannt wird über renameTable.
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'addTable', payload: { id: 'tb-such-1', position: { x: 0, y: 0 } } },
    });
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'renameTable', payload: { id: 'tb-such-1', titel: 'Zinsstaffel' } },
    });

    const treffer = await suche(app, authHeaders, desk.id, 'Zinsstaffel');
    const eintrag = treffer.find((t) => t.objId === 'tb-such-1') as { art?: string } | undefined;
    expect(eintrag).toBeDefined();
    expect(eintrag?.art).toBe('Tabelle');
  });

  // Wächter gegen einen Rückfall des GANZEN Musters: Jede Art, die indexZeileFuer() mit einem
  // Text versieht, MUSS einen Art-Badge haben — sonst ist die Indizierung wirkungslos, ohne dass
  // irgendetwas fehlschlägt. Genau so entstand die Lücke dreimal (flags bewusst, zeitleisten in
  // Phase 9 behoben, legalObjects/tables hier). `flags`, `strokes` und `clips` sind die bewusst
  // ausgenommenen Arten — sie tragen laut UI-SPEC keinen eigenen Badge.
  it('jede indizierbare Art hat einen Art-Badge (sonst faellt sie lautlos aus der Trefferliste)', () => {
    const OHNE_BADGE_BEWUSST = new Set(['flags', 'strokes', 'clips', 'sitzungsmappen', 'zones']);
    const fehlend = VERSIONIERTE_ARTEN.filter(
      (art) => !OHNE_BADGE_BEWUSST.has(art) && ART_ZU_TREFFERART[art] === undefined,
    );
    expect(fehlend).toEqual([]);
  });
});

/**
 * Deutsche Schreibweisen (Umlaute, ß, Komposita) — ein realistischer deutscher Testdatensatz.
 * Das tatsächliche FTS5-`unicode61`-Verhalten für Umlaute/ß war laut 07-RESEARCH.md vorab NICHT
 * abschließend geklärt; die folgenden Erwartungen sind daher der TATSÄCHLICHE, empirisch
 * geprüfte Testlauf (nicht geraten) — inklusive der beiden Negativfälle, die als bewusst
 * akzeptiertes Verhalten festgeschrieben werden, statt offenzubleiben.
 */
describe('Deutsche Schreibweisen (Umlaute, ß, Komposita) — echter Testdatensatz', () => {
  it('"Müller" wird unabhängig von Groß-/Kleinschreibung UND Umlaut-Schreibweise gefunden (Müller/müller/MÜLLER)', async () => {
    const { app, authHeaders, desk } = await akteMitNotiz('Rückruf bei Herrn Müller erledigt', 'note-mueller');
    for (const q of ['Müller', 'müller', 'MÜLLER']) {
      const treffer = await suche(app, authHeaders, desk.id, q);
      expect(treffer.some((t) => t.objId === 'note-mueller')).toBe(true);
    }
  });

  it('"Straße" wird über die exakte Schreibweise gefunden, aber NICHT über "strasse" — unicode61 faltet ß nicht zu ss (empirisch geprüft, bewusst akzeptierte Grenze)', async () => {
    const { app, authHeaders, desk } = await akteMitNotiz('Die Straße ist wegen Bauarbeiten gesperrt', 'note-strasse');
    expect((await suche(app, authHeaders, desk.id, 'Straße')).some((t) => t.objId === 'note-strasse')).toBe(true);
    expect((await suche(app, authHeaders, desk.id, 'strasse')).some((t) => t.objId === 'note-strasse')).toBe(false);
  });

  it('"Kündigungsschutzklage" wird per Präfix über "Kündigungs" gefunden, aber NICHT über den Wortbestandteil "schutzklage" (kein Kompositum-Zerleger, empirisch geprüft)', async () => {
    const { app, authHeaders, desk } = await akteMitNotiz('Mandant reicht Kündigungsschutzklage ein', 'note-kuendigung');
    expect((await suche(app, authHeaders, desk.id, 'Kündigungs')).some((t) => t.objId === 'note-kuendigung')).toBe(true);
    expect((await suche(app, authHeaders, desk.id, 'schutzklage')).some((t) => t.objId === 'note-kuendigung')).toBe(false);
  });
});

describe('Suche über Ersteller/Datum (SEARCH-01)', () => {
  it('ein Suchbegriff, der ausschließlich im createdBy eines Objekts vorkommt, liefert genau dieses Objekt mit dem Objektinhalt als Label (nicht dem Erstellernamen)', async () => {
    const { app, db, a, b } = await createTestAppMitZweiNutzern();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte Ersteller' } })
    ).json();
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(desk.id, b.userId, 'Bearbeiter');
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: b.authHeaders,
      payload: { type: 'addNote', payload: { id: 'note-von-b', kind: 'notiz', text: 'Frist prüfen', position: { x: 0, y: 0 } } },
    });

    // 'nutzer-b' kommt in KEINEM Objekttext vor — ein Treffer kann hier nur über das
    // ersteller-Feld zustande kommen.
    const treffer = await suche(app, a.authHeaders, desk.id, 'nutzer-b');
    const eintrag = treffer.find((t) => t.objId === 'note-von-b');
    expect(eintrag).toBeDefined();
    expect(eintrag?.label).toBe('Frist prüfen');
  });

  it('ein Suchbegriff in deutscher Datumsschreibweise (TT.MM.JJJJ) liefert dasselbe Objekt wie die ISO-Schreibweise', async () => {
    const { app, authHeaders, desk, notiz } = await akteMitNotiz('Fristnotiz ohne erkennbares Datumswort im Text', 'note-datum');
    const iso = String(notiz.createdAt).slice(0, 10); // YYYY-MM-DD
    const [jahr, monat, tag] = iso.split('-');
    const deutsch = `${tag}.${monat}.${jahr}`;

    expect((await suche(app, authHeaders, desk.id, iso)).some((t) => t.objId === 'note-datum')).toBe(true);
    expect((await suche(app, authHeaders, desk.id, deutsch)).some((t) => t.objId === 'note-datum')).toBe(true);
  });
});

/**
 * Vorschau-Disziplin (T-07-09/T-07-11): Schwärzungen liefern nie ein Zitat, andere Arten mit
 * langem Textinhalt bekommen eines mit harter 80-Zeichen-Obergrenze. Getestet über einen
 * Notizzettel statt einer „normalen" (nicht schwärzenden) Markierung — `MarkKind` kennt nur
 * `redact` und `tippex`, und BEIDE gelten laut der etablierten, bereits zweimal (CR-02/CR-03)
 * gegen eine engere Lesart verteidigten Projektkonvention (`istEchteSchwaerzung`,
 * `src/lib/markSchwaerzung.ts`) als echte Schwärzung — es gibt in diesem Datenmodell keine
 * „normale" Markierung, deren Textsnapshot gefahrlos zitiert werden dürfte. Ein Notizzettel hat
 * keine Vertraulichkeits-Unterdrückung und eignet sich daher, um die reine Kürzungsmechanik
 * (unabhängig von der Schwärzungsfrage) zu belegen.
 */
describe('Snippet-Kürzung auf 80 Zeichen (T-07-11)', () => {
  it('ein Treffer mit langem Textinhalt bekommt ein Snippet von maximal 80 Zeichen', async () => {
    const langerText = 'Vertragsklausel '.repeat(20) + 'Kernbegriff ' + 'weiterer Text '.repeat(20);
    const { app, authHeaders, desk } = await akteMitNotiz(langerText, 'note-lang');
    const treffer = await suche(app, authHeaders, desk.id, 'Kernbegriff');
    const eintrag = treffer.find((t) => t.objId === 'note-lang') as { snippet?: string } | undefined;
    expect(eintrag).toBeDefined();
    expect(eintrag?.snippet).toBeDefined();
    expect(eintrag!.snippet!.length).toBeLessThanOrEqual(80);
  });
});

/**
 * T-07-10: `labelFuer` löst `fromId`/`toId` einer notizlosen Verknüpfung NUR im projizierten
 * State auf — ein für den Betrachter unsichtbares Zielobjekt liefert keinen Ersatztext/
 * Platzhalter, sonst ließe sich aus dem Platzhalter allein schon die Existenz eines unsichtbaren
 * Objekts ableiten. Reine Unit-Tests der exportierten Funktion (unabhängig vom aktuellen
 * `indexZeileFuer`-Verhalten, das eine notizlose Verknüpfung gar nicht erst indiziert — diese
 * Fallback-Regel greift, sobald eine künftige Erweiterung notizlose Verknüpfungen z. B. über
 * Ersteller/Datum auffindbar macht).
 */
describe('labelFuer — Verknüpfungen ohne Notiz (T-07-10)', () => {
  const state: DesktopState = {
    docs: [
      { id: 'doc-a', fileId: 'f1', name: 'Kartei A', position: { x: 0, y: 0 }, rotation: 0, zIndex: 1 },
    ],
    stacks: [],
    links: [],
  };

  it('zeigt die Namen der beiden verbundenen Objekte, wenn die Notiz leer ist', () => {
    const label = labelFuer('links', { fromId: 'doc-a', toId: 'doc-a', note: '' }, state);
    expect(label).toBe('Kartei A ↔ Kartei A');
  });

  it('ein nicht auflösbares Ziel (für den Betrachter unsichtbar) erzeugt KEINEN Platzhalter — nur der auflösbare Teil bleibt', () => {
    const label = labelFuer('links', { fromId: 'doc-unsichtbar', toId: 'doc-a', note: '' }, state);
    expect(label).toBe('Kartei A');
    expect(label).not.toContain('unsichtbar');
  });

  it('sind beide Enden unauflösbar, liefert die Funktion einen leeren String, keinen Platzhalter', () => {
    const label = labelFuer('links', { fromId: 'weg-1', toId: 'weg-2', note: '' }, state);
    expect(label).toBe('');
  });
});

/**
 * 07-07 Task 3 — OCR-Treffer in der Suche, mit Unsicherheits-Kennzeichnung. Die OCR-Daten werden
 * direkt in file_pages/file_pages_fts geschrieben (kein tesseract im Test, CONTEXT.md-Vorgabe),
 * damit der Suchpfad unabhängig von der Erkennungsstufe (Task 2) geprüft wird.
 */
describe('OCR-Treffer in der Suche (Task 3, SEARCH-01/03)', () => {
  it('ein Begriff, der nur im OCR-Text einer Seite steht, liefert einen Treffer mit art=OCR, korrekter page und gesetztem docId', async () => {
    const { app, db, dataDir, authHeaders } = await createTestApp();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'Akte OCR' } })
    ).json();
    const bytes = await pdfOhneRelevantenText();
    const meta = storeFile(db, dataDir, bytes, 'scan.pdf');
    await warteAufLeerlauf();
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'addDoc', payload: { id: 'doc-ocr', fileId: meta.id, name: 'Scan', position: { x: 0, y: 0 } } },
    });
    legeOcrErgebnisAn(db, meta.id, 1, 'EINZIGARTIGEROCRTEXTMARKER im erkannten Text', 91);

    const res = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/search`, headers: authHeaders, payload: { q: 'EINZIGARTIGEROCRTEXTMARKER' },
    });
    expect(res.statusCode).toBe(200);
    const { treffer } = res.json() as { treffer: { art: string; fileId?: string; docId?: string; page?: number; ocrUnsicher?: boolean }[] };
    const eintrag = treffer.find((t) => t.fileId === meta.id);
    expect(eintrag).toBeDefined();
    expect(eintrag?.art).toBe('OCR');
    expect(eintrag?.page).toBe(1);
    expect(eintrag?.docId).toBe('doc-ocr');
    expect(eintrag?.ocrUnsicher).not.toBe(true); // Konfidenz 91 liegt über der Schwelle
  });

  it(`liegt die Konfidenz der Seite unter KONFIDENZ_SCHWELLE (${KONFIDENZ_SCHWELLE}), trägt der Treffer ocrUnsicher=true`, async () => {
    const { app, db, dataDir, authHeaders } = await createTestApp();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'Akte OCR unsicher' } })
    ).json();
    const bytes = await pdfOhneRelevantenText();
    const meta = storeFile(db, dataDir, bytes, 'scan-schlecht.pdf');
    await warteAufLeerlauf();
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'addDoc', payload: { id: 'doc-ocr-unsicher', fileId: meta.id, name: 'Schlechter Scan', position: { x: 0, y: 0 } } },
    });
    legeOcrErgebnisAn(db, meta.id, 1, 'UNSICHERERKANNTERBEGRIFF schwer lesbar', KONFIDENZ_SCHWELLE - 1);

    const res = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/search`, headers: authHeaders, payload: { q: 'UNSICHERERKANNTERBEGRIFF' },
    });
    const { treffer } = res.json() as { treffer: { fileId?: string; ocrUnsicher?: boolean }[] };
    const eintrag = treffer.find((t) => t.fileId === meta.id);
    expect(eintrag?.ocrUnsicher).toBe(true);
  });

  it('steht ein Begriff sowohl im eingebetteten Text als auch im OCR-Text derselben Seite, entsteht nur EIN Treffer — mit art=PDF-Text (die zuverlässigere Quelle)', async () => {
    const { app, db, dataDir, authHeaders } = await createTestApp();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'Akte Doppeltreffer' } })
    ).json();
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const seite = doc.addPage([595, 842]);
    seite.drawText('DOPPELTERTREFFERBEGRIFF steht eingebettet auf dieser Seite.', { x: 50, y: 700, size: 12, font });
    const bytes = Buffer.from(await doc.save());
    const meta = storeFile(db, dataDir, bytes, 'doppelt.pdf');
    await warteAufLeerlauf();
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'addDoc', payload: { id: 'doc-doppelt', fileId: meta.id, name: 'Doppelt erkannt', position: { x: 0, y: 0 } } },
    });
    // Dieselbe Seite trägt zusätzlich denselben Begriff im OCR-Text (Normalfall bei
    // nachträglich mit Textebene versehenen Scans).
    legeOcrErgebnisAn(db, meta.id, 1, 'DOPPELTERTREFFERBEGRIFF auch im OCR-Text erkannt', 80);

    const res = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/search`, headers: authHeaders, payload: { q: 'DOPPELTERTREFFERBEGRIFF' },
    });
    const { treffer } = res.json() as { treffer: { fileId?: string; art: string; page?: number }[] };
    const treffserDieserDatei = treffer.filter((t) => t.fileId === meta.id);
    expect(treffserDieserDatei).toHaveLength(1);
    expect(treffserDieserDatei[0].art).toBe('PDF-Text');
  });

  it('OCR-Treffer für eine Datei, deren Karte für den Nutzer unsichtbar ist (fremde private Ebene), erscheinen nicht — dieselbe Erlaubnisliste wie PDF-Text-Treffer', async () => {
    const { app, db, dataDir, a, b } = await createTestAppMitZweiNutzern();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte OCR privat' } })
    ).json();
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(desk.id, b.userId, 'Bearbeiter');
    const bytes = await pdfOhneRelevantenText();
    const meta = storeFile(db, dataDir, bytes, 'privater-scan.pdf');
    await warteAufLeerlauf();
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: a.authHeaders,
      payload: { type: 'addDoc', payload: { id: 'doc-ocr-privat', fileId: meta.id, name: 'Privater Scan', position: { x: 0, y: 0 } } },
    });
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: a.authHeaders,
      payload: { type: 'changeLayerId', payload: { objectId: 'doc-ocr-privat', layerId: 'privat' } },
    });
    legeOcrErgebnisAn(db, meta.id, 1, 'PRIVATEROCRTEXTMARKERGEHEIM erkannt', 85);

    const resB = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/search`, headers: b.authHeaders, payload: { q: 'PRIVATEROCRTEXTMARKERGEHEIM' },
    });
    expect(resB.json()).toEqual({ treffer: [] });

    const resA = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/search`, headers: a.authHeaders, payload: { q: 'PRIVATEROCRTEXTMARKERGEHEIM' },
    });
    expect((resA.json().treffer as { fileId?: string }[]).some((t) => t.fileId === meta.id)).toBe(true);
  });
});

describe('fts5QueryAus', () => {
  it('liefert null für Text ohne Wortzeichen', () => {
    expect(fts5QueryAus('   ')).toBeNull();
    expect(fts5QueryAus('***')).toBeNull();
  });

  it('quotet Tokens und hängt an das letzte Token ein Präfix-* an', () => {
    expect(fts5QueryAus('Kündigung Müller')).toBe('"Kündigung" "Müller"*');
  });

  it('trennt an Anführungszeichen (kein Tokenzeichen) statt sie in ein Token zu übernehmen', () => {
    // Der Tokenizer fasst nur Buchstaben/Ziffern/Bindestriche zu einem Token zusammen — ein
    // rohes " im Nutzertext trennt daher wie jedes andere Nicht-Wortzeichen; das Escaping
    // (Verdopplung enthaltener Anführungszeichen) ist defensiv für den Fall, dass ein Token
    // selbst ein " enthält, was mit dieser Tokenmenge nie vorkommt.
    expect(fts5QueryAus('a"b')).toBe('"a" "b"*');
  });
});
