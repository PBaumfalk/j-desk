import { createHash } from 'node:crypto';
import type { Doc } from '@j-desk/core';
import type { Db } from '../db';
import { normalisiere } from './pdfExport';

/**
 * Maßgebliche Textquelle je Seite (KONV-03, 10-04): das Erkennungsergebnis gescannter Seiten
 * steht ausschließlich in der Tabelle `file_pages` des Suchindex (packages/server/src/search/
 * searchIndex.ts) und NIE in den PDF-Bytes — eine Prüfung, die den Text nur aus den Bytes zieht,
 * hält jede erkannte Scanseite fälschlich für leer. Umgekehrt ist genau dieser Indextext der
 * UNGESCHWÄRZTE Originaltext: für eine Seite mit Schwärzung wäre er die falsche Grundlage, dort
 * zählt ausschließlich die Extraktion aus dem bereits geschwärzten Ergebnis. Aus diesen beiden
 * Sätzen folgt die Rangfolge, die `bestimmeSeitenBefunde` unten umsetzt — sie ist der einzige
 * Ort, an dem diese Entscheidung getroffen wird.
 *
 * Eine dritte, ebenso wichtige Kategorie ist `unbeurteilbar`: eine Seite, für die weder eine
 * Indexzeile noch ein brauchbares Extraktionsergebnis vorliegt, ist keine getroffene Aussage
 * über Leerheit — sie darf nie stillschweigend als "nicht leer" (Beweisverlust durch
 * Übersehen) oder als "leer" (Beweisverlust durch versehentliches Entfernen) durchgehen.
 */
export type Textautoritaet = 'index' | 'extraktion' | 'unbeurteilbar';

/** Befund für genau eine Seite einer Unterlage: Text (falls beurteilbar), die Quelle, die dafür
 *  maßgeblich war, und der Gruppierungshash (nur für nicht leere Texte gesetzt). */
export interface SeitenBefund {
  docId: string;
  lokaleSeite: number;
  text: string | null;
  autoritaet: Textautoritaet;
  hash: string | null;
}

/**
 * Liest die Indexzeile einer Seite (`file_pages`). Existiert keine Zeile, ist das Ergebnis
 * `null` — keine Aussage möglich, weder über Leerheit noch über Inhalt. Existiert eine Zeile,
 * ist das Ergebnis `pdf_text ?? ocr_text ?? ''`: eine vorhandene Zeile mit leeren Spalten ist
 * die Aussage "geprüft, kein Text gefunden", keine fehlende Prüfung.
 */
export function textAusIndex(db: Db, fileId: string, seite: number): string | null {
  const row = db
    .prepare('SELECT pdf_text, ocr_text FROM file_pages WHERE file_id = ? AND page = ?')
    .get(fileId, seite) as { pdf_text: string | null; ocr_text: string | null } | undefined;
  if (!row) return null;
  return row.pdf_text ?? row.ocr_text ?? '';
}

/**
 * SHA-256-Hexwert des weißraum-normalisierten Texts (dieselbe Regel wie das Verifikationsgate,
 * `normalisiere` aus `pdfExport.ts` — zwei Regeln wären zwei Wahrheiten über Gleichheit). Für
 * leeren normalisierten Text ist das Ergebnis die leere Zeichenkette — leere Seiten dürfen
 * niemals über den Hash miteinander gruppiert werden.
 */
export function seitenHash(text: string): string {
  const norm = normalisiere(text);
  return norm === '' ? '' : createHash('sha256').update(norm).digest('hex');
}

/** Bestimmt Text und Autorität für genau eine Seite nach der Rangfolge aus F-13. */
function befundFuerSeite(
  db: Db,
  doc: Doc,
  lokaleSeite: number,
  extraktionsText: string,
  geschwaerzt: boolean,
): { text: string | null; autoritaet: Textautoritaet } {
  // (1) Schwärzung schlägt jede andere Quelle — der Indextext ist hier der ungeschwärzte
  // Originaltext und darf nicht verwendet werden, auch wenn eine Indexzeile existiert.
  if (geschwaerzt) {
    return normalisiere(extraktionsText) === ''
      ? { text: extraktionsText, autoritaet: 'unbeurteilbar' }
      : { text: extraktionsText, autoritaet: 'extraktion' };
  }
  // (2) Bild: keine Textquelle existiert für diese Dateiart — immer unbeurteilbar.
  if (doc.kind === 'image') {
    return { text: null, autoritaet: 'unbeurteilbar' };
  }
  // (3) Office-Umwandlung: entsteht nie eine Indexzeile (per Konstruktion, s. ocrQueue.ts
  // ExtraktStand 'nicht-anwendbar'); das umgewandelte PDF trägt immer echten Text — die
  // Extraktion ist maßgeblich, auch wenn sie leer ausfällt (dann ist die Seite leer, nicht
  // unbeurteilbar: die Umwandlung selbst ist die Prüfung).
  if (doc.kind === 'convertible') {
    return { text: extraktionsText, autoritaet: 'extraktion' };
  }
  // (4) PDF mit Indexzeile: die Zeile beweist, dass ein Extraktions- oder Erkennungslauf
  // stattgefunden hat — auch eine leere Zeile ist die Aussage "geprüft, kein Text".
  const indexText = textAusIndex(db, doc.fileId, lokaleSeite);
  if (indexText !== null) {
    return { text: indexText, autoritaet: 'index' };
  }
  // (5) PDF ohne Indexzeile: ohne Indexzeile ist "kein Text gefunden" keine Aussage über die
  // Seite — ein leeres Extraktionsergebnis ist deshalb unbeurteilbar, kein Leerseitenbefund.
  return normalisiere(extraktionsText) === ''
    ? { text: extraktionsText, autoritaet: 'unbeurteilbar' }
    : { text: extraktionsText, autoritaet: 'extraktion' };
}

/**
 * Bestimmt für jede Seite einer Auswahl den maßgeblichen Textbefund (KONV-03). `seitenTexte`
 * ist das Ergebnis der seitenweisen Extraktion aus dem bereits geschwärzten Dokument (Index 0
 * entspricht `lokaleSeiten[0]`); `seitenMitSchwaerzung` enthält die 1-basierten lokalen Seiten,
 * auf denen mindestens eine Markierung der Art `redact` oder `tippex` liegt.
 */
export function bestimmeSeitenBefunde(
  db: Db,
  doc: Doc,
  lokaleSeiten: number[],
  seitenTexte: string[],
  seitenMitSchwaerzung: Set<number>,
): SeitenBefund[] {
  return lokaleSeiten.map((lokaleSeite, i) => {
    const extraktionsText = seitenTexte[i] ?? '';
    const geschwaerzt = seitenMitSchwaerzung.has(lokaleSeite);
    const { text, autoritaet } = befundFuerSeite(db, doc, lokaleSeite, extraktionsText, geschwaerzt);
    // hash wird nur für nicht leere Texte gesetzt — leere Seiten dürfen nicht als Dubletten
    // voneinander gelten (Leerheit und Inhaltsgleichheit sind getrennte Aussagen).
    const hashWert = text !== null ? seitenHash(text) : '';
    return { docId: doc.id, lokaleSeite, text, autoritaet, hash: hashWert === '' ? null : hashWert };
  });
}

/**
 * Gruppiert Befunde nach `hash` (überspringt `null`, also leere und unbeurteilbare Seiten). Je
 * Gruppe wird der erste Befund zur Fundstelle, jeder weitere ergibt einen Eintrag, der auf ihn
 * verweist — die Reihenfolge der Ergebnisse folgt der Reihenfolge der Befunde.
 */
export function findeDubletten(
  befunde: SeitenBefund[],
): { docId: string; lokaleSeite: number; gleichWieDocId: string; gleichWieLokaleSeite: number }[] {
  const ersteFundstelle = new Map<string, SeitenBefund>();
  const ergebnis: { docId: string; lokaleSeite: number; gleichWieDocId: string; gleichWieLokaleSeite: number }[] = [];
  for (const b of befunde) {
    if (b.hash === null) continue;
    const erste = ersteFundstelle.get(b.hash);
    if (erste === undefined) {
      ersteFundstelle.set(b.hash, b);
    } else {
      ergebnis.push({
        docId: b.docId,
        lokaleSeite: b.lokaleSeite,
        gleichWieDocId: erste.docId,
        gleichWieLokaleSeite: erste.lokaleSeite,
      });
    }
  }
  return ergebnis;
}

/** Alle Befunde mit Autorität ungleich `unbeurteilbar` und leerem normalisiertem Text. */
export function findeLeerseiten(befunde: SeitenBefund[]): { docId: string; lokaleSeite: number }[] {
  return befunde
    .filter((b) => b.autoritaet !== 'unbeurteilbar' && normalisiere(b.text ?? '') === '')
    .map((b) => ({ docId: b.docId, lokaleSeite: b.lokaleSeite }));
}

/** Alle Befunde mit Autorität `unbeurteilbar`. */
export function findeUnbeurteilbare(befunde: SeitenBefund[]): { docId: string; lokaleSeite: number }[] {
  return befunde.filter((b) => b.autoritaet === 'unbeurteilbar').map((b) => ({ docId: b.docId, lokaleSeite: b.lokaleSeite }));
}
