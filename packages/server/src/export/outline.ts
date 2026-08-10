/**
 * PDF-Lesezeichenbaum (KONV-02, 10-02): pdf-lib bietet keine High-Level-Outline-API — dieses
 * Modul baut den `/Outlines`-Katalogeintrag von Hand aus denselben Grundbausteinen, die
 * `scrub.ts` für Katalogmanipulation benutzt (`PDFDict`/`PDFRef`/`PDFName`/`ctx.obj`).
 *
 * SEQUENZBEDINGUNG (der Grund, warum diese Funktion überhaupt wirkt): Lesezeichen entstehen
 * strikt NACH jedem Bereinigungslauf, und nach ihrer Erzeugung darf kein Bereinigungslauf mehr
 * folgen — `scrubbePdf()` entfernt den Katalogeintrag `Outlines` bedingungslos als Schritt (4)
 * seiner Checkliste (scrub.ts:113-114). Wird diese Reihenfolge umgedreht, verschwindet der
 * Lesezeichenbaum lautlos aus den ausgelieferten Bytes.
 */
import { PDFDict, PDFHexString, PDFName, PDFNumber, type PDFRef } from 'pdf-lib';
import type { PDFDocument, PDFPage } from 'pdf-lib';

/** Lesezeichentitel werden auf diese Länge gekürzt (F-08) — Titel aus Dokumentnamen und
 *  Freitext des Dialogs können beliebig lang sein, der Baum bleibt lesbar. */
export const LESEZEICHEN_TITEL_MAX = 120;

export interface Lesezeichen {
  titel: string;
  seite: PDFPage;
}

/**
 * Setzt einen linearen Lesezeichenbaum (genau eine Ebene, F-09) in den Katalog von `pdf`. Bei
 * leerer Eintragsliste kehrt die Funktion sofort zurück, ohne den Katalog anzufassen.
 *
 * Titel werden als `PDFHexString` (UTF-16) geschrieben (F-08) — die einfache Zeichenkettenform
 * des Formats stellt Umlaute in vielen Betrachtern falsch dar, die Hexdarstellung nicht.
 */
export function fuegeLesezeichenEin(pdf: PDFDocument, eintraege: Lesezeichen[]): void {
  if (eintraege.length === 0) return;

  const ctx = pdf.context;

  // Die Wurzelreferenz wird genau EINMAL reserviert und danach überall wiederverwendet — jeder
  // erneute Registrierungsaufruf für dasselbe Objekt legt ein weiteres Objekt an, und die
  // Elterneinträge zeigten dann auf verschiedene Wurzeln. Deshalb reservieren wir Wurzel- und
  // Eintragsreferenzen einmal vorab und binden sie später per Zuweisung, statt sie über die
  // registrierende Variante erneut anzulegen.
  const wurzelRef = ctx.nextRef();
  const refs: PDFRef[] = eintraege.map(() => ctx.nextRef());

  eintraege.forEach((eintrag, i) => {
    const dict = ctx.obj({
      Title: PDFHexString.fromText(eintrag.titel.slice(0, LESEZEICHEN_TITEL_MAX)),
      Parent: wurzelRef,
      Dest: ctx.obj([eintrag.seite.ref, PDFName.of('Fit')]),
    });
    if (i > 0) dict.set(PDFName.of('Prev'), refs[i - 1]);
    if (i < eintraege.length - 1) dict.set(PDFName.of('Next'), refs[i + 1]);
    ctx.assign(refs[i], dict);
  });

  const wurzel = ctx.obj({
    Type: PDFName.of('Outlines'),
    First: refs[0],
    Last: refs[refs.length - 1],
    // Ein positiver Count bedeutet im Format "Baum ist aufgeklappt" — die gewollte Darstellung
    // für ein Anlagenverzeichnis (Betrachter zeigen die Lesezeichenleiste direkt geöffnet).
    Count: PDFNumber.of(eintraege.length),
  });
  ctx.assign(wurzelRef, wurzel);
  pdf.catalog.set(PDFName.of('Outlines'), wurzelRef);
}
