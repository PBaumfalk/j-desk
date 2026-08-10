/**
 * Scrub-Checkliste (EXP-04, T-03-05-02, 03-RESEARCH Pattern 2 + Pitfall 3): räumt alle
 * Nicht-Content-Stream-Textverstecke in FESTER Reihenfolge leer. Läuft IMMER nach der
 * Redaktion (redact.ts) und VOR dem Setzen frischer TOC-Links (Pattern 4 — der Scrub
 * löscht Annots). Die Reihenfolge ist verbindlich und hier als Kommentar-Kopf festgehalten:
 *
 *   (1) pro Seite: Annots, Metadata, PieceInfo, AA löschen
 *   (2) catalog StructTreeRoot (getaggte PDFs duplizieren Text in der Struktur — Pitfall 3)
 *   (3) catalog AcroForm (Formularfeldwerte + Widget-Appearances können Text enthalten)
 *   (4) catalog Outlines (Lesezeichen-Titel können Text enthalten)
 *   (5) catalog Names (EmbeddedFiles = Dateianhänge + JavaScript)
 *   (6) catalog Metadata (XMP-Stream)
 *   (7) Page-Metadata/PieceInfo — bereits in (1) erledigt (Zusammengehörigkeit: Seiten-Metadaten)
 *   (8) Info-Dict per Setter neutralisieren + mit J-DESK-Kennung frisch setzen
 *   (9) catalog OpenAction + AA (Auto-Actions können Text/JavaScript tragen)
 *
 * WICHTIG (empirisch belegt, scrub.test.ts Rohtext-Smoke): pdf-lib hat KEINE Garbage
 * Collection — alle jemals registrierten Indirect Objects landen beim save() in den Bytes,
 * auch wenn der letzte Verweis gelöscht wurde. Schlüssel-Löschung allein ließe den Geheim-
 * Text als „Waise" im Artefakt stehen. Deshalb neutralisiert der Scrub die Inhalte der
 * entfernten Teilbäume (Strings leeren, Streams durch leere Streams ersetzen) BEVOR die
 * Verweise gelöst werden. Objekte werden dabei NICHT aus dem Context gelöscht: Seiten und
 * Fonts werden über die Teilbäume hinaus referenziert (Outlines → Dest, AcroForm → DR,
 * StructTree → Pg) und dürften nicht mitgerissen werden.
 */
import { PDFArray, PDFDict, PDFHexString, PDFName, PDFRawStream, PDFRef, PDFString } from 'pdf-lib';
import type { PDFContext, PDFDocument, PDFObject } from 'pdf-lib';

/**
 * Geteilte Ressourcen, in die der Neutralisierer NICHT hineinlaufen darf — sie gehören den
 * Seiten (Inhalte) oder werden mehrfach referenziert. Alles andere im entfernten Teilbaum
 * (Outlines-Einträge, Annots-Dicts, AcroForm-Felder, Name-Trees, StructElems) ist privat.
 */
const GESCHUETZTE_DICT_TYPEN = new Set(['Page', 'Pages', 'Font', 'FontDescriptor', 'XObject', 'Catalog']);

/**
 * Leert alle Strings und ersetzt alle Stream-Inhalte im Teilbaum rekursiv (zyklenfest).
 * Geschützte Typen (Seiten, Fonts, Form-/Image-XObjects) werden übersprungen — ihre Inhalte
 * gehören dem Seiten-Rendering, nicht den Verstecken.
 */
function neutralisiereTeilbaum(ctx: PDFContext, wurzel: PDFObject | undefined): void {
  const gesehen = new Set<string>();
  // PDFName.asString() liefert den ENCODED Namen MIT fuehrendem Slash ('/Page') — normalisieren
  const nameText = (n: PDFName | undefined): string | undefined => n?.asString().replace(/^\//, '');
  const besuche = (obj: PDFObject | undefined): void => {
    if (!obj) return;
    if (obj instanceof PDFRef) {
      if (gesehen.has(obj.tag)) return;
      gesehen.add(obj.tag);
      const ziel = ctx.lookup(obj);
      if (ziel instanceof PDFRawStream) {
        const typ = nameText(ziel.dict.lookupMaybe(PDFName.of('Type'), PDFName));
        const subtype = nameText(ziel.dict.lookupMaybe(PDFName.of('Subtype'), PDFName));
        // Form-/Image-XObjects können auch Seiten-Ressourcen sein — nicht anfassen
        if (typ !== 'XObject' && subtype !== 'Form' && subtype !== 'Image') {
          ctx.assign(obj, ctx.stream(new Uint8Array(0)));
        }
        return;
      }
      if (ziel instanceof PDFDict) {
        const typ = nameText(ziel.lookupMaybe(PDFName.of('Type'), PDFName));
        if (typ && GESCHUETZTE_DICT_TYPEN.has(typ)) return;
      }
      besuche(ziel);
      return;
    }
    if (obj instanceof PDFDict) {
      for (const [key, value] of obj.entries()) {
        if (value instanceof PDFString || value instanceof PDFHexString) obj.set(key, PDFString.of(''));
        else besuche(value);
      }
      return;
    }
    if (obj instanceof PDFArray) {
      for (let i = 0; i < obj.size(); i++) {
        const value = obj.get(i);
        if (value instanceof PDFString || value instanceof PDFHexString) obj.set(i, PDFString.of(''));
        else besuche(value);
      }
    }
  };
  besuche(wurzel);
}

/** Entfernt einen Katalog-/Seiten-Schlüssel: erst Inhalte neutralisieren, dann Verweis lösen. */
function entferne(ctx: PDFContext, dict: PDFDict, schluessel: string): void {
  const key = PDFName.of(schluessel);
  neutralisiereTeilbaum(ctx, dict.get(key));
  dict.delete(key);
}

/**
 * Führt die komplette Scrub-Checkliste in fester Reihenfolge aus (Kommentar-Kopf oben).
 * Idempotent: fehlende Verstecke werden übersprungen. Nach dem Aufruf sind die Schlüssel
 * gelöscht und die früher dahinterliegenden Inhalte neutralisiert — der Rohtext-Smoke in
 * scrub.test.ts belegt, dass danach kein Geheim-String mehr in den Bytes steht.
 */
export function scrubbePdf(pdfDoc: PDFDocument): void {
  const ctx = pdfDoc.context;
  const catalog = pdfDoc.catalog;

  // (1) Pro Seite: Annots, Metadata, PieceInfo, AA — seiten-verankerte Verstecke zuerst
  for (const page of pdfDoc.getPages()) {
    for (const schluessel of ['Annots', 'Metadata', 'PieceInfo', 'AA']) {
      entferne(ctx, page.node, schluessel);
    }
  }

  // (2) StructTreeRoot — getaggte PDFs (Word/Euro-Office!) duplizieren Text in der Struktur
  entferne(ctx, catalog, 'StructTreeRoot');
  // (3) AcroForm — Feldwerte, Tooltips und Widget-Appearance-Streams können Text enthalten
  entferne(ctx, catalog, 'AcroForm');
  // (4) Outlines — Lesezeichen-Titel können Text enthalten
  entferne(ctx, catalog, 'Outlines');
  // (5) Names — EmbeddedFiles (Dateianhänge samt Inhalt) + JavaScript-Aktionen
  entferne(ctx, catalog, 'Names');
  // (6) Catalog-Metadata — XMP-Stream (dc:title, dc:creator, benutzerdefinierte Felder)
  entferne(ctx, catalog, 'Metadata');
  // (7) Page-Metadata/PieceInfo — bereits in Schritt (1) erledigt; die Schritte gehören
  //     zusammen (Seiten-Metadaten), die Research zählt sie getrennt
  // (8) Info-Dict: erst alle Werte neutralisieren (auch benutzerdefinierte Schlüssel),
  //     dann per Setter mit J-DESK-Kennung frisch setzen
  neutralisiereTeilbaum(ctx, pdfDoc.getInfoDict());
  pdfDoc.setTitle('');
  pdfDoc.setAuthor('');
  pdfDoc.setSubject('');
  pdfDoc.setKeywords([]);
  pdfDoc.setCreator('J-DESK');
  pdfDoc.setProducer('J-DESK');
  pdfDoc.setCreationDate(new Date());
  pdfDoc.setModificationDate(new Date());
  // (9) OpenAction + AA am Katalog — Auto-Actions können Text/JavaScript tragen
  entferne(ctx, catalog, 'OpenAction');
  entferne(ctx, catalog, 'AA');
}
