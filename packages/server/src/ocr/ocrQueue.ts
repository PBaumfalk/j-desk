/**
 * Serielle Hintergrund-Warteschlange für die Datei-Textextraktion UND die deutsche OCR-Stufe
 * (SEARCH-01/SEARCH-03, T-07-20/T-07-22/T-07-24/T-07-32...T-07-37). `enqueueExtraction` kehrt
 * IMMER synchron zurück, bevor die eigentliche Arbeit läuft — dasselbe "Bytes an einen teuren
 * Verarbeiter geben, ohne die Antwort zu blockieren"-Muster wie `convert.ts` (dort: externer
 * Konvertierungsdienst, hier: pdfjs-Parsing + tesseract.js im eigenen Prozess).
 *
 * Bounded auf höchstens EINEN Auftrag gleichzeitig in Arbeit: pdfjs-/tesseract-Speicherbedarf
 * pro Auftrag, und die Extraktion ist Hintergrundarbeit ohne Zeitzusage — mehrere gleichzeitige
 * Läufe würden den Speicherbedarf unnötig addieren.
 *
 * Ablauf je Auftrag (07-07): Dateiart bestimmen → bei PDF Seitentexte extrahieren (07-04,
 * unverändert) → für jede Seite mit `brauchtOcr` über `rasterisiereSeite()` (07-06) ein PNG
 * erzeugen und per tesseract.js erkennen lassen; bei Bilddateien die Bytes OHNE Rasterung direkt
 * erkennen lassen (tesseract.js verarbeitet Bilder nativ) und als Seite 1 ablegen. Fehlt die
 * Sprachdatei, bleibt der Zustand ehrlich `ocr-ausstehend` (kein Nachladen aus dem Netz, kein
 * stilles Erfolgsbuchen, T-07-37) — sobald sie bereitgestellt wird, greift der nächste
 * Ingestionsdurchlauf.
 */
import type { FileKind } from '@j-desk/core';
import { createScheduler, createWorker, type Scheduler } from 'tesseract.js';
import type { Db } from '../db';
import { rasterisiereSeite } from '../export/raster';
import { extrahiereSeitentexte } from './extract';
import { sprachdatenVorhanden, TESSERACT_OPTIONEN } from './tessdata';

/**
 * Fünf Zustände (SEARCH-03-Grundlage): `pdf-text` (eingebetteter Text gefunden, kein OCR nötig),
 * `ocr-ausstehend` (mind. eine Seite braucht OCR — dient zusätzlich als Arbeitsstand VOR
 * Abschluss des Laufs, s. `setzeStand`-Aufrufe, UND als der Zustand, der bestehen bleibt, solange
 * `deu.traineddata` fehlt), `ocr-fertig` (OCR erfolgreich gelaufen, Konfidenz vorhanden), `fehler`
 * (Extraktion oder Erkennung abgebrochen), `nicht-anwendbar` (Dateiart ohne extrahierbaren
 * Inhalt — `convertible`/`other`; `image` läuft seit 07-07 ebenfalls durch die OCR, s.
 * `enqueueExtraction`). Keine Zeile in `file_extract` bedeutet "nie extrahiert".
 */
export type ExtraktStand = 'pdf-text' | 'ocr-ausstehend' | 'ocr-fertig' | 'fehler' | 'nicht-anwendbar';

/**
 * Konfidenzschwelle (0–100-Skala) für die Unsicherheits-Kennzeichnung eines OCR-Treffers
 * (searchQuery.ts, 07-UI-SPEC.md) — Startwert dort begründet: reale Kanzlei-Scans liegen häufig
 * zwischen 60 und 85, eine zu hohe Schwelle würde den Hinweis durch Dauerpräsenz entwerten.
 */
export const KONFIDENZ_SCHWELLE = 70;

/** Anzahl paralleler tesseract-Worker im Verbund — Richtwert aus der Community (2–4), kein
 *  offizieller Konsens (07-RESEARCH.md), hier als moderater Startwert für einen
 *  1-GB-Grundausstattungs-Server gewählt. */
export const OCR_POOL_GROESSE = 2;

/**
 * Nach dieser Anzahl innerhalb EINES Auftrags verarbeiteter Seiten wird der Worker-Verbund
 * beendet und neu erzeugt (07-RESEARCH Pitfall 2, T-07-33): der WASM-Speicher eines Workers
 * wächst, gibt aber nie zurück — ein Dauerbetriebs-Serverprozess mit 1 GB Grundausstattung darf
 * davon nicht langsam aufgefressen werden. Neuerzeugung hat selbst Overhead, deshalb nicht nach
 * jeder einzelnen Seite.
 */
export const SEITEN_PRO_WORKER_LEBEN = 25;

interface Auftrag {
  db: Db;
  fileId: string;
  kind: FileKind;
  bytes: () => Promise<Uint8Array>;
}

// Modul-lokale, serielle Warteschlange: ein Array von Aufträgen plus ein Kennzeichen, ob gerade
// gearbeitet wird. `enqueueExtraction` stellt ein und startet die Abarbeitung, ohne auf sie zu
// warten (kein `await` im Aufruferpfad — s. Modul-Doku oben).
const warteschlange: Auftrag[] = [];
let arbeitetGerade = false;
// Nur für `warteAufLeerlauf()` (Tests): wird aufgelöst, sobald die Warteschlange leer und kein
// Auftrag mehr in Arbeit ist.
let leerlaufResolvers: (() => void)[] = [];

// T-07-32/T-07-37: die Meldung "Sprachdaten fehlen" soll den Betrieb sichtbar machen, ohne bei
// jeder betroffenen Datei erneut die Konsole zu fluten — ein Server ohne bereitgestellte
// deu.traineddata verarbeitet potenziell hunderte Dateien, bevor jemand das Setup korrigiert.
let sprachdatenWarnungAusgegeben = false;
function warnFehlendeSprachdaten(): void {
  if (sprachdatenWarnungAusgegeben) return;
  sprachdatenWarnungAusgegeben = true;
  console.error(
    'ocrQueue: deu.traineddata fehlt (s. packages/server/tessdata/README.md) — OCR bleibt ' +
      'abgeschaltet, betroffene Dateien behalten den Zustand ocr-ausstehend, bis die Sprachdatei ' +
      'bereitgestellt wird. Es wird nichts von einem Netzdienst nachgeladen.',
  );
}

function hatFileExtractZeile(db: Db, fileId: string): boolean {
  return db.prepare('SELECT 1 FROM file_extract WHERE file_id = ?').get(fileId) !== undefined;
}

function setzeStand(db: Db, fileId: string, stand: ExtraktStand, seiten?: number, fehler?: string): void {
  db.prepare(
    `INSERT INTO file_extract (file_id, stand, seiten, fehler, aktualisiert_am)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(file_id) DO UPDATE SET
       stand = excluded.stand, seiten = excluded.seiten, fehler = excluded.fehler,
       aktualisiert_am = excluded.aktualisiert_am`,
  ).run(fileId, stand, seiten ?? null, fehler ?? null, Date.now());
}

/**
 * Schreibt ein OCR-Ergebnis für eine Seite: ergänzt eine bereits vorhandene `file_pages`-Zeile
 * (PDF-Seite, die zuvor schon mit `pdf_text` angelegt wurde) statt eine zweite anzulegen, oder
 * legt für Bilddateien (keine vorherige PDF-Text-Stufe) eine neue Zeile an. `file_pages_fts`
 * wird auf demselben Weg nachgezogen, damit der Text sofort durchsuchbar ist.
 */
function schreibeOcrErgebnis(db: Db, fileId: string, page: number, text: string, confidence: number): void {
  const vorhanden = db.prepare('SELECT 1 FROM file_pages WHERE file_id = ? AND page = ?').get(fileId, page);
  if (vorhanden) {
    db.prepare('UPDATE file_pages SET ocr_text = ?, ocr_confidence = ? WHERE file_id = ? AND page = ?').run(
      text, confidence, fileId, page,
    );
    db.prepare('UPDATE file_pages_fts SET ocr_text = ? WHERE file_id = ? AND page = ?').run(text, fileId, page);
  } else {
    db.prepare(
      'INSERT INTO file_pages (file_id, page, pdf_text, ocr_text, ocr_confidence) VALUES (?, ?, NULL, ?, ?)',
    ).run(fileId, page, text, confidence);
    db.prepare('INSERT INTO file_pages_fts (file_id, page, pdf_text, ocr_text) VALUES (?, ?, NULL, ?)').run(
      fileId, page, text,
    );
  }
}

/** Erzeugt einen frischen Worker-Verbund mit `OCR_POOL_GROESSE` Workern, jeder mit dem deutschen
 *  Sprachmodell und ausschließlich lokalen Pfaden (`TESSERACT_OPTIONEN`, tessdata.ts). */
async function baueScheduler(): Promise<Scheduler> {
  const scheduler = createScheduler();
  try {
    for (let i = 0; i < OCR_POOL_GROESSE; i += 1) {
      const worker = await createWorker('deu', 1, TESSERACT_OPTIONEN);
      scheduler.addWorker(worker);
    }
  } catch (e) {
    // WR-01 (07-Review): scheitert ein späterer Worker, dürfen die bereits im Verbund
    // hängenden nicht verwaist zurückbleiben — sonst leakt ihr WASM-Speicher genau wie der
    // Dauerbetriebs-Fall, den SEITEN_PRO_WORKER_LEBEN oben eigentlich verhindern soll.
    await scheduler.terminate();
    throw e;
  }
  return scheduler;
}

interface OcrSeite {
  page: number;
  bild: () => Promise<Uint8Array>;
}

interface OcrErgebnisZeile {
  page: number;
  text: string;
  confidence: number;
}

/**
 * Führt die Erkennung für eine Liste von Seiten aus. Ein einzelner Auftrag ist durch die äußere
 * Warteschlange ohnehin schon auf höchstens einen gleichzeitig begrenzt, deshalb werden die
 * Seiten hier seriell über denselben Verbund geschickt. Der Verbund wird nach
 * `SEITEN_PRO_WORKER_LEBEN` verarbeiteten Seiten beendet und neu erzeugt (T-07-33) und in einem
 * `finally` in JEDEM Fall beendet — auch wenn eine Seite wirft oder die Schleife selbst einen
 * unerwarteten Fehler auslöst.
 *
 * Eine geworfene Seite bricht den Lauf NICHT ab (fachliche Entscheidung: ein Teilergebnis ist für
 * die Suche wertvoller als ein verworfener Lauf, solange der Endzustand ehrlich `fehler` heißt) —
 * sie wird übersprungen, die Fehlermeldung gesammelt und am Ende zurückgegeben; bereits erkannte
 * Seiten bleiben im Ergebnis erhalten.
 */
async function fuehreOcrAus(seiten: OcrSeite[]): Promise<{ ergebnisse: OcrErgebnisZeile[]; fehlermeldungen: string[] }> {
  const ergebnisse: OcrErgebnisZeile[] = [];
  const fehlermeldungen: string[] = [];
  let scheduler = await baueScheduler();
  let seitenSeitErzeugung = 0;
  try {
    for (const seite of seiten) {
      if (seitenSeitErzeugung >= SEITEN_PRO_WORKER_LEBEN) {
        await scheduler.terminate();
        scheduler = await baueScheduler();
        seitenSeitErzeugung = 0;
      }
      try {
        const bild = await seite.bild();
        const { data } = await scheduler.addJob('recognize', bild);
        ergebnisse.push({ page: seite.page, text: data.text, confidence: Math.round(data.confidence) });
      } catch (e) {
        const meldung = e instanceof Error ? e.message : String(e);
        fehlermeldungen.push(`Seite ${seite.page}: ${meldung}`);
      }
      seitenSeitErzeugung += 1;
    }
  } finally {
    await scheduler.terminate();
  }
  return { ergebnisse, fehlermeldungen };
}

/**
 * Idempotenz (T-07-24): prüft VOR dem Einstellen, ob für die `fileId` schon eine
 * `file_extract`-Zeile existiert; wenn ja, kehrt es wirkungslos zurück — der Bytes-Zulieferer
 * wird nicht aufgerufen, deshalb ist er eine Funktion, kein Puffer: bei bereits extrahierten
 * Dateien darf nicht einmal gelesen/heruntergeladen werden (kein unnötiger Netzabruf von
 * Mandantendokumenten im j-lawyer-Pfad).
 *
 * Planer-Entscheidung 07-07 (07-RESEARCH Open Question 2): Bild-Karten (`kind === 'image'`)
 * laufen seit diesem Plan EBENFALLS durch die OCR — ohne Rasterungsschritt, weil tesseract.js
 * Bilder nativ verarbeitet. `stand = 'nicht-anwendbar'` gilt jetzt nur noch für `convertible` und
 * `other`.
 *
 * Vor dem eigentlichen Lauf wird die `file_extract`-Zeile mit einem Arbeitsstand geschrieben —
 * `'ocr-ausstehend'`, derselbe Vokabel-Wert, der einem PDF-/Bild-Lauf vorausgehen kann, bevor das
 * tatsächliche Ergebnis feststeht — damit ein zweiter Aufruf WÄHREND des Laufs ebenfalls
 * wirkungslos zurückkehrt (der `hatFileExtractZeile`-Check oben greift dann schon). Diese Zeile
 * ist das Sperrmittel; sie wird nach Abschluss des Laufs mit dem tatsächlichen Ergebnis
 * überschrieben (s. `bearbeite`).
 */
export function enqueueExtraction(db: Db, fileId: string, kind: FileKind, bytes: () => Promise<Uint8Array>): void {
  if (hatFileExtractZeile(db, fileId)) return;

  if (kind !== 'pdf' && kind !== 'image') {
    setzeStand(db, fileId, 'nicht-anwendbar');
    return;
  }

  setzeStand(db, fileId, 'ocr-ausstehend'); // Sperrmittel — s. Kommentar oben.
  warteschlange.push({ db, fileId, kind, bytes });
  // Fire-and-forget: kein await hier, damit enqueueExtraction synchron zurückkehrt. Ein
  // unerwarteter Fehler in `arbeite` selbst (außerhalb des try/catch je Auftrag in `bearbeite`)
  // würde sonst eine unbehandelte Promise-Ablehnung auslösen — abgefangen und protokolliert.
  arbeite().catch((e) => {
    console.error('ocrQueue: unerwarteter Fehler in der Warteschlangen-Abarbeitung:', e);
  });
}

async function arbeite(): Promise<void> {
  if (arbeitetGerade) return; // Bounded: höchstens ein Auftrag gleichzeitig in Arbeit.
  arbeitetGerade = true;
  try {
    while (warteschlange.length > 0) {
      const auftrag = warteschlange.shift()!;
      await bearbeite(auftrag);
    }
  } finally {
    arbeitetGerade = false;
    if (warteschlange.length === 0) {
      const resolvers = leerlaufResolvers;
      leerlaufResolvers = [];
      resolvers.forEach((resolve) => resolve());
    }
  }
}

/**
 * Der gesamte Auftrag läuft in try/catch: ein unerwarteter Fehler (z. B. unlesbare Bytes) landet
 * als `stand = 'fehler'` plus Meldung in `file_extract` und zusätzlich auf der Fehlerkonsole
 * (dieselbe Protokollierungsart wie im übrigen Serverpaket, z. B. backup.ts) — kein Fehler
 * verlässt diese Funktion.
 *
 * PDF: Seitentexte extrahieren (07-04, unverändert) → für Seiten mit `brauchtOcr` über
 * `rasterisiereSeite()` (07-06) rastern und erkennen lassen. Bild: OHNE Rasterung direkt
 * erkennen, Ergebnis als Seite 1. Vor jedem OCR-Anteil wird `sprachdatenVorhanden()` geprüft —
 * fehlt die Sprachdatei, bleibt der Stand `ocr-ausstehend` (T-07-37, s. `warnFehlendeSprachdaten`).
 */
async function bearbeite(auftrag: Auftrag): Promise<void> {
  const { db, fileId, kind } = auftrag;
  try {
    const bytes = await auftrag.bytes();

    if (kind === 'pdf') {
      const seiten = await extrahiereSeitentexte(bytes);

      db.prepare('DELETE FROM file_pages WHERE file_id = ?').run(fileId);
      db.prepare('DELETE FROM file_pages_fts WHERE file_id = ?').run(fileId);
      const insertPage = db.prepare(
        'INSERT INTO file_pages (file_id, page, pdf_text, ocr_text, ocr_confidence) VALUES (?, ?, ?, NULL, NULL)',
      );
      const insertFts = db.prepare('INSERT INTO file_pages_fts (file_id, page, pdf_text, ocr_text) VALUES (?, ?, ?, NULL)');

      const ocrSeiten: number[] = [];
      for (const seite of seiten) {
        insertPage.run(fileId, seite.page, seite.text);
        insertFts.run(fileId, seite.page, seite.text);
        if (seite.brauchtOcr) ocrSeiten.push(seite.page);
      }

      if (ocrSeiten.length === 0) {
        setzeStand(db, fileId, 'pdf-text', seiten.length);
        return;
      }
      if (!sprachdatenVorhanden()) {
        setzeStand(db, fileId, 'ocr-ausstehend', seiten.length);
        warnFehlendeSprachdaten();
        return;
      }

      const { ergebnisse, fehlermeldungen } = await fuehreOcrAus(
        ocrSeiten.map((page) => ({ page, bild: () => rasterisiereSeite(bytes, page - 1) })),
      );
      for (const ergebnis of ergebnisse) {
        schreibeOcrErgebnis(db, fileId, ergebnis.page, ergebnis.text, ergebnis.confidence);
      }
      setzeStand(
        db, fileId,
        fehlermeldungen.length > 0 ? 'fehler' : 'ocr-fertig',
        seiten.length,
        fehlermeldungen.length > 0 ? fehlermeldungen.join('; ') : undefined,
      );
      return;
    }

    // kind === 'image' (Planer-Entscheidung 07-07, s. enqueueExtraction): kein Rasterungsschritt,
    // direkte Erkennung der Bilddatei, Ergebnis als Seite 1 dieser Datei.
    if (!sprachdatenVorhanden()) {
      setzeStand(db, fileId, 'ocr-ausstehend');
      warnFehlendeSprachdaten();
      return;
    }
    const { ergebnisse, fehlermeldungen } = await fuehreOcrAus([{ page: 1, bild: async () => bytes }]);
    for (const ergebnis of ergebnisse) {
      schreibeOcrErgebnis(db, fileId, ergebnis.page, ergebnis.text, ergebnis.confidence);
    }
    setzeStand(
      db, fileId,
      fehlermeldungen.length > 0 ? 'fehler' : 'ocr-fertig',
      1,
      fehlermeldungen.length > 0 ? fehlermeldungen.join('; ') : undefined,
    );
  } catch (e) {
    const meldung = e instanceof Error ? e.message : String(e);
    console.error(`ocrQueue: Extraktion fehlgeschlagen für Datei ${fileId}:`, e);
    setzeStand(db, fileId, 'fehler', undefined, meldung);
  }
}

/** Löst auf, wenn die Warteschlange leer und kein Auftrag mehr in Arbeit ist — ausschließlich
 *  für Tests, damit sie die Queue deterministisch abwarten können. */
export function warteAufLeerlauf(): Promise<void> {
  if (!arbeitetGerade && warteschlange.length === 0) return Promise.resolve();
  return new Promise((resolve) => leerlaufResolvers.push(resolve));
}
