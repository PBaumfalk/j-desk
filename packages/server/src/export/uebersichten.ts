import { PDFDocument, PDFName, rgb, StandardFonts } from 'pdf-lib';
import type { PDFFont, PDFPage, PDFRef } from 'pdf-lib';
import {
  cutoutBox,
  docBox,
  freeDocs,
  noteBox,
  stackBox,
  type Box,
  type DesktopState,
  type Doc,
  type LegalObjectKind,
} from '@j-desk/core';
import { erstelleLayout, RAND, SEITE_H, SEITE_W, winansiSanitize, wrapText, type Layout } from './layout';
import { basisNachUserSpace, seitenGeometrieVon, type UserSpaceRect } from './coordinates';
import { redactiereSeite } from './redact';
import { scrubbePdf } from './scrub';
import { rasteriereSeiteFailClosed } from './raster';
import { extrahiereText } from './verify';
import { ExportFehler } from './pdfExport';

/**
 * Übersichts-PDFs (EXP-05, D-09): vier Übergabeformate aus dem freigabe-gefilterten State
 * auf dem Cursor-Flow-Layout-Helfer (layout.ts, 03-RESEARCH Pattern 4) — kein zweiter
 * Layout-Code. 03-01 lieferte die Aufgabenliste (D-11, Tracer), 03-04 die übrigen drei.
 *
 * Aufgabenliste (08-04 Task 1, LEGAL-01/TASK-01, eingelöste Vorwärtsreferenz): führende
 * Quelle sind jetzt echte Aufgaben-Objekte (state.legalObjects, kind 'aufgabe', Status
 * weder erledigt noch übergeben — fehlender Status gilt als offen) mit Verantwortlichem,
 * Fälligkeit und Priorität. Die bisherige Ableitung aus Zetteln (todo/notiz) und Fähnchen
 * bleibt als zweite, nachgelagerte Quelle erhalten — Bestandsschreibtische ohne
 * juristische Objekte liefern dadurch weiterhin eine brauchbare Liste.
 *
 * Argumentations- und Beweismittelübersicht (08-04 Task 2, LEGAL-01/LEGAL-02, eingelöste
 * Vorwärtsreferenz): führende Quelle sind jetzt die juristischen Objekttypen. Argumentation
 * = state.legalObjects mit kind 'eigene-behauptung'/'behauptung-gegenseite'/'tatsache', je
 * mit ihren Verknüpfungs-Bezügen — jede Bezugszeile trägt den Anzeigenamen der Bedeutung
 * (Link.kind, 08-03), ein Bezug ohne gesetzte Bedeutung wird als „offene Zuordnung" benannt.
 * Beweismittel = kind 'beweismittel'/'gegenbeweis', je mit den über eine 'belegt'-Verknüpfung
 * gestützten Objekten. Beide behalten ihre bisherige Ableitung (Notizen bzw. Ausschnitte) als
 * nachgelagerte zweite Quelle — Bestandsschreibtische ohne juristische Objekte liefern
 * dadurch weiterhin Inhalt (gleiche Begründung wie bei der Aufgabenliste oben). Die
 * Anzeigenamen für Objekttypen/Bedeutungen sind server-lokal definiert (LEGAL_OBJECT_KIND_LABELS/
 * LINK_MEANING_LABELS, unten) — der Server importiert bewusst NICHT src/lib/menus.ts
 * (Client-Layer); ihre Werte sind wortgleich mit den gesperrten Anzeigenamen aus
 * REQUIREMENTS.md Zeile 77/78 (T-08-17, Test sichert die Übereinstimmung ab).
 *
 * REVIEW-NOTE (D-08, Pitfall 8 / T-03-04-01): In dieses Modul gehört KEINE Statistik- oder
 * Zählinformation über gefilterte Inhalte („N interne Einträge" wäre ein Existenz-Leck).
 * Der Eingang ist der bereits projizierte UND freigabe-gefilterte State: alles, was hier
 * ankommt, darf ins Artefakt; die Funktionen filtern nichts mehr (Single-Source:
 * freigabeFilter im Core). Einzige Ausnahme: Verknüpfungs-Bezüge, deren Ziel nicht im
 * State liegt (internes Ziel eines freigegebenen Links), entfallen lautlos — ihre
 * Benennung würde die Existenz des internen Ziels verraten.
 */

const KURZ_MAX = 60;
const HERKUNFT_UNBEKANNT = 'Herkunft unbekannt';

/** Kurzform für Index-/Bezugs-Namen: erste Zeile, hart gekappt (… ist WinAnsi-kodierbar). */
function kurz(text: string, max: number = KURZ_MAX): string {
  const erste = text.split('\n')[0].trim();
  return erste.length > max ? `${erste.slice(0, max - 1)}…` : erste;
}

/** Provenienz-Ehrlichkeit (Phase-1-Konvention): fehlende Stempel werden benannt, nicht erfunden. */
function oderUnbekannt(wert: string | undefined): string {
  return wert !== undefined && wert !== '' ? wert : HERKUNFT_UNBEKANNT;
}

function datumIso(iso: string | undefined): string {
  if (!iso) return HERKUNFT_UNBEKANNT;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? HERKUNFT_UNBEKANNT : d.toLocaleDateString('de-DE');
}

function kopfZeilen(layout: Layout, untertitel: string): void {
  layout.zeile(untertitel, { groesse: 14, fett: true });
  layout.zeile(`Stand: ${new Date().toLocaleDateString('de-DE')}`, { groesse: 9 });
  layout.zeile('');
}

/** Prioritäts-Anzeigenamen (UI-SPEC Copywriting Contract „Priorität: {Hoch/Mittel/Niedrig}"). */
const TASK_PRIORITY_LABEL: Record<string, string> = { hoch: 'Hoch', mittel: 'Mittel', niedrig: 'Niedrig' };

/** Führende Quelle der Aufgabenliste (08-04 Task 1): echte Aufgaben-Objekte, deren Status
 *  weder erledigt noch übergeben ist. Fehlender Status gilt als offen (Bestandsobjekte aus
 *  08-01, die vor 08-02 angelegt wurden — 08-02 setzt status stets bei Neuanlage). */
function offeneAufgabenObjekte(state: DesktopState): NonNullable<DesktopState['legalObjects']> {
  return (state.legalObjects ?? []).filter(
    (o) => o.kind === 'aufgabe' && o.status !== 'erledigt' && o.status !== 'uebergeben',
  );
}

/**
 * Aufgabenliste (EXP-05, D-11, 08-04 Task 1 — Einlösung der Phase-3-Vorwärtsreferenz):
 * führende Quelle sind echte Aufgaben-Objekte (state.legalObjects, kind 'aufgabe'); die
 * bisherige Ableitung aus Zetteln (kind 'todo'/'notiz', done !== true) und Fähnchen bleibt
 * als zweite, nachgelagerte Quelle erhalten (Bestandsschreibtische ohne juristische
 * Objekte, Modulkopf oben).
 */
export async function erzeugeAufgabenlistePdf(state: DesktopState, titel: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const layout = await erstelleLayout(pdf, titel);
  kopfZeilen(layout, titel);

  const aufgaben = offeneAufgabenObjekte(state);

  const bestandsEintraege: string[] = [];
  for (const n of state.notes ?? []) {
    if ((n.kind === 'todo' || n.kind === 'notiz') && n.done !== true) bestandsEintraege.push(n.text);
  }
  for (const f of state.flags ?? []) {
    bestandsEintraege.push(f.label !== undefined && f.label !== '' ? f.label : `Fahne (Seite ${f.page})`);
  }

  if (aufgaben.length === 0 && bestandsEintraege.length === 0) {
    layout.zeile('Keine offenen Aufgaben.');
  }

  aufgaben.forEach((o, i) => {
    layout.zeile(`${i + 1}. ${kurz(o.text)}`);
    // Verantwortlicher entfällt ersatzlos, wenn nicht gesetzt (fail-honest, kein Platzhalter).
    // Fälligkeit nutzt bewusst dieselbe datumIso()-Instanz wie überall im Modul — sie liefert
    // bei fehlendem Wert bereits den etablierten Unbekannt-Text.
    const detail: string[] = [];
    if (o.assignee !== undefined && o.assignee !== '') detail.push(`Verantwortlich: ${o.assignee}`);
    detail.push(`Fällig: ${datumIso(o.dueDate)}`);
    if (o.priority !== undefined) detail.push(`Priorität: ${TASK_PRIORITY_LABEL[o.priority] ?? o.priority}`);
    layout.zeile(detail.join(' · '), { groesse: 9, einzug: 16 });
  });
  bestandsEintraege.forEach((text, i) => layout.zeile(`${aufgaben.length + i + 1}. ${text}`));

  return pdf.save();
}

/** Eine Karte auf dem Tisch (Miniatur-Vorlage): Weltkoordinaten-Box plus Anzeigename. */
export interface MiniaturKarte {
  id: string;
  name: string;
  box: Box;
}

/**
 * Skaliert die Karten proportional in die Zielfläche (D-10): die Bounding-Box aller
 * Tischpositionen wird seitenverhältnistreu eingepasst und zentriert — die relative
 * Anordnung (Ordnung in x und y, Abstandsverhältnisse) bleibt dadurch exakt erhalten.
 * Reine Funktion, ohne PDF-Rendering testbar. Koordinaten wie der Tisch: Ursprung
 * links-oben, y läuft nach unten.
 */
export function berechneMiniaturen(karten: MiniaturKarte[], flaeche: Box): MiniaturKarte[] {
  if (karten.length === 0) return [];
  const minX = Math.min(...karten.map((k) => k.box.x));
  const minY = Math.min(...karten.map((k) => k.box.y));
  const maxX = Math.max(...karten.map((k) => k.box.x + k.box.w));
  const maxY = Math.max(...karten.map((k) => k.box.y + k.box.h));
  const weltW = Math.max(maxX - minX, 1);
  const weltH = Math.max(maxY - minY, 1);
  const skala = Math.min(flaeche.w / weltW, flaeche.h / weltH);
  const offX = flaeche.x + (flaeche.w - weltW * skala) / 2;
  const offY = flaeche.y + (flaeche.h - weltH * skala) / 2;
  return karten.map((k) => ({
    id: k.id,
    name: k.name,
    box: {
      x: offX + (k.box.x - minX) * skala,
      y: offY + (k.box.y - minY) * skala,
      w: k.box.w * skala,
      h: k.box.h * skala,
    },
  }));
}

/** Sammelt die sichtbaren Tisch-Karten mit denselben Maßen wie die Arbeitsansicht. */
function tischKarten(state: DesktopState): MiniaturKarte[] {
  const karten: MiniaturKarte[] = [];
  // Karten im Konvolut liegen nicht frei auf dem Tisch — das Konvolut repräsentiert sie.
  for (const d of freeDocs(state)) karten.push({ id: d.id, name: d.name, box: docBox(d) });
  for (const st of state.stacks) karten.push({ id: st.id, name: st.name, box: stackBox(st) });
  for (const n of state.notes ?? []) karten.push({ id: n.id, name: kurz(n.text), box: noteBox(n) });
  for (const c of state.cutouts ?? []) {
    karten.push({ id: c.id, name: kurz(c.textSnapshot ?? c.sourceName ?? 'Ausschnitt'), box: cutoutBox(c) });
  }
  return karten;
}

const MINIATUR_HOEHE = 380;
const GRAU = rgb(0.35, 0.35, 0.35);

/**
 * Schreibtisch-Snapshot (EXP-05, D-10): visueller Canvas-Abzug — Karten-Miniaturen in
 * ihrer Tisch-Anordnung (proportional zur Canvas) — plus Objekt-Index (Name, Art,
 * Ersteller, Datum). `.jdesk` bleibt der maschinelle Snapshot; dies ist der druckfähige.
 */
export async function erzeugeSnapshotPdf(state: DesktopState, titel: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const layout = await erstelleLayout(pdf, titel);
  kopfZeilen(layout, titel);

  const karten = tischKarten(state);
  if (karten.length === 0) {
    layout.zeile('Der Schreibtisch ist leer.');
    return pdf.save();
  }

  // Miniaturen: Freifläche im Fluss reservieren, Rechtecke in PDF-User-Space umrechnen
  // (berechneMiniaturen liefert Tisch-Koordinaten mit Ursprung links-oben, y-down).
  // Reihenfolge: erst Umbruch prüfen, DANN die Flächen-Oberkante vom Cursor ablesen.
  layout.ensureSpace(MINIATUR_HOEHE + 12);
  const flaechenTop = SEITE_H - layout.y; // Cursor y (y-up) → Abstand von oben (y-down)
  layout.reserviere(MINIATUR_HOEHE + 12);
  const minis = berechneMiniaturen(karten, { x: RAND, y: flaechenTop, w: SEITE_W - 2 * RAND, h: MINIATUR_HOEHE });
  const seite = layout.seite();
  seite.drawRectangle({
    x: RAND, y: SEITE_H - flaechenTop - MINIATUR_HOEHE,
    width: SEITE_W - 2 * RAND, height: MINIATUR_HOEHE,
    borderColor: GRAU, borderWidth: 0.5,
  });
  for (const m of minis) {
    seite.drawRectangle({
      x: m.box.x, y: SEITE_H - m.box.y - m.box.h,
      width: m.box.w, height: m.box.h,
      borderColor: GRAU, borderWidth: 0.75,
    });
    seite.drawText(winansiSanitize(kurz(m.name, 24)), {
      x: m.box.x + 2, y: SEITE_H - m.box.y - 8, size: 6, color: GRAU,
    });
  }

  layout.zeile('Objekt-Index', { groesse: 12, fett: true });
  layout.zeile('');
  const zeilen: string[][] = [];
  for (const d of freeDocs(state)) zeilen.push([d.name, 'Dokument', oderUnbekannt(d.createdBy), datumIso(d.createdAt)]);
  for (const st of state.stacks) zeilen.push([st.name, 'Konvolut', oderUnbekannt(st.createdBy), datumIso(st.createdAt)]);
  for (const n of state.notes ?? []) zeilen.push([kurz(n.text), 'Zettel', oderUnbekannt(n.createdBy), datumIso(n.createdAt)]);
  for (const c of state.cutouts ?? []) {
    zeilen.push([kurz(c.textSnapshot ?? c.sourceName ?? 'Ausschnitt'), 'Ausschnitt', oderUnbekannt(c.createdBy), datumIso(c.createdAt)]);
  }
  layout.tabelle(['Name', 'Art', 'Ersteller', 'Datum'], zeilen, [245, 80, 90, 80]);

  return pdf.save();
}

/**
 * Objekttyp-Anzeigenamen (LEGAL-01, 08-04 Task 2) — wortgleich mit REQUIREMENTS.md Zeile 77.
 * Der Server darf `src/lib/menus.ts` (Client-Layer) nicht importieren; eigene, gesperrte
 * Zuordnung. Als `Record<LegalObjectKind, string>` typisiert: fehlt ein Typ, meldet der
 * Compiler die Lücke (Vollständigkeitsgarantie), keine stille Auslassung möglich.
 */
export const LEGAL_OBJECT_KIND_LABELS: Record<LegalObjectKind, string> = {
  tatsache: 'Tatsache',
  'eigene-behauptung': 'eigene Behauptung',
  'behauptung-gegenseite': 'Behauptung der Gegenseite',
  beweismittel: 'Beweismittel',
  gegenbeweis: 'Gegenbeweis',
  rechtsfrage: 'Rechtsfrage',
  tatbestandsmerkmal: 'Tatbestandsmerkmal',
  einwendung: 'Einwendung',
  risiko: 'Risiko',
  frist: 'Frist',
  aufgabe: 'Aufgabe',
  'fundstelle-zitierfaehig': 'zitierfähige Fundstelle',
  ergebnis: 'Ergebnis',
};

/**
 * Verknüpfungs-Bedeutung-Anzeigenamen (LEGAL-02, 08-04 Task 2) — wortgleich mit
 * REQUIREMENTS.md Zeile 78, Slugs identisch zu `LINK_MEANINGS` aus 08-03 (paralleler Plan,
 * eigener Worktree). `Link.kind` wird unten defensiv über eine lokale Typ-Erweiterung
 * gelesen: dieser Plan darf links.ts/model.ts nicht anfassen (Merge-Isolation zwischen
 * 08-03 und 08-04); das Feld existiert strukturell, sobald beide Wellen zusammengeführt
 * sind — `Record<string, string>` statt eines Imports aus links.ts vermeidet die
 * Kopplung an eine zum Zeitpunkt dieses Plans noch nicht vorhandene Datei.
 */
export const LINK_MEANING_LABELS: Record<string, string> = {
  belegt: 'belegt',
  widerspricht: 'widerspricht',
  bestaetigt: 'bestätigt',
  widerlegt: 'widerlegt',
  'gehoert-zu': 'gehört zu',
  entkraeftet: 'entkräftet',
  'folge-von': 'Folge von',
  'voraussetzung-fuer': 'Voraussetzung für',
  'offene-frage': 'offene Frage',
  streitig: 'streitig',
  unstreitig: 'unstreitig',
};

/** Anzeigename für einen Bezug ohne gesetzte Bedeutung — KEINE Behauptung einer Beziehung. */
const OFFENE_ZUORDNUNG = 'offene Zuordnung';

/** Additive `kind`-Lesart auf `Link` ohne links.ts/model.ts anzufassen (siehe LINK_MEANING_LABELS-Kommentar). */
type LinkMitBedeutung = DesktopState['links'][number] & { kind?: string };

/** Anzeigename der Bezugs-Bedeutung; unbekannter/fehlender Wert rendert wie „offene Zuordnung". */
function bedeutungLabel(l: LinkMitBedeutung): string {
  if (l.kind === undefined) return OFFENE_ZUORDNUNG;
  return LINK_MEANING_LABELS[l.kind] ?? OFFENE_ZUORDNUNG;
}

/**
 * Benennt ein Verknüpfungs-Ziel aus dem (gefilterten) State. Liegt das Ziel nicht im
 * State — internes Ziel eines freigegebenen Links —, entfällt der Bezug lautlos (D-08,
 * T-08-14): schon seine Benennung würde die Existenz des internen Objekts verraten.
 * Deckt Dokumente, Konvolute, Ausschnitte, Zettel UND (08-04 Task 2) juristische Objekte ab.
 */
function benenneBezugsziel(state: DesktopState, id: string): string | undefined {
  const doc = state.docs.find((d) => d.id === id);
  if (doc) return `Dokument „${doc.name}"`;
  const stapel = state.stacks.find((s) => s.id === id);
  if (stapel) return `Konvolut „${stapel.name}"`;
  const cutout = (state.cutouts ?? []).find((c) => c.id === id);
  if (cutout) {
    const quelle = state.docs.find((d) => d.fileId === cutout.fileId);
    const quellName = quelle?.name ?? cutout.sourceName ?? HERKUNFT_UNBEKANNT;
    return `Ausschnitt „${kurz(cutout.textSnapshot ?? '')}" (${quellName}, Seite ${cutout.page})`;
  }
  const notiz = (state.notes ?? []).find((n) => n.id === id);
  if (notiz) return `Zettel „${kurz(notiz.text)}"`;
  const objekt = (state.legalObjects ?? []).find((o) => o.id === id);
  if (objekt) return `${LEGAL_OBJECT_KIND_LABELS[objekt.kind]} „${kurz(objekt.text)}"`;
  return undefined;
}

/** Argumentations-relevante Objekttypen (LEGAL-01, 08-04 Task 2). */
const ARGUMENTATION_KINDS = new Set<LegalObjectKind>(['tatsache', 'eigene-behauptung', 'behauptung-gegenseite']);

/**
 * Argumentationsübersicht (EXP-05, D-09, 08-04 Task 2 — eingelöste Vorwärtsreferenz):
 * führend die juristischen Objekte der Typen eigene-behauptung/behauptung-gegenseite/
 * tatsache, je mit ihren Verknüpfungs-Bezügen (Bedeutungs-Anzeigename + Ziel-Benennung).
 * Die bisherige Ableitung aus Notizen bleibt als nachgelagerte zweite Quelle erhalten
 * (Bestandsschreibtische ohne juristische Objekte, gleiche Begründung wie Aufgabenliste).
 */
export async function erzeugeArgumentationPdf(state: DesktopState, titel: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const layout = await erstelleLayout(pdf, titel);
  kopfZeilen(layout, titel);

  const objekte = (state.legalObjects ?? []).filter((o) => ARGUMENTATION_KINDS.has(o.kind));
  const notizen = state.notes ?? [];
  const links = state.links as LinkMitBedeutung[];

  if (objekte.length === 0 && notizen.length === 0) {
    layout.zeile('Keine Einträge.');
    return pdf.save();
  }

  for (const o of objekte) {
    layout.zeile(`${LEGAL_OBJECT_KIND_LABELS[o.kind]}: ${kurz(o.text)}`, { fett: true });
    const bezuege = links.filter((l) => l.fromId === o.id || l.toId === o.id);
    for (const l of bezuege) {
      const zielId = l.fromId === o.id ? l.toId : l.fromId;
      const benennung = benenneBezugsziel(state, zielId);
      if (benennung === undefined) continue; // internes Ziel: lautlos entfallen (D-08, T-08-14)
      layout.zeile(`– ${bedeutungLabel(l)}: ${benennung}`, { groesse: 10, einzug: 24 });
      if (l.note !== '') layout.zeile(l.note, { groesse: 9, einzug: 40 });
    }
    layout.absatz('', { abstand: 8 });
  }

  for (const n of notizen) {
    layout.zeile(n.text, { fett: true });
    const bezuege = links.filter((l) => l.fromId === n.id || l.toId === n.id);
    for (const l of bezuege) {
      const zielId = l.fromId === n.id ? l.toId : l.fromId;
      const benennung = benenneBezugsziel(state, zielId);
      if (benennung === undefined) continue; // internes Ziel: lautlos entfallen (D-08)
      layout.zeile(`– ${benennung}`, { groesse: 10, einzug: 24 });
      if (l.note !== '') layout.zeile(l.note, { groesse: 9, einzug: 40 });
    }
    layout.absatz('', { abstand: 8 });
  }

  return pdf.save();
}

/** Beweismittel-relevante Objekttypen (LEGAL-01, 08-04 Task 2). */
const BEWEISMITTEL_KINDS = new Set<LegalObjectKind>(['beweismittel', 'gegenbeweis']);

/**
 * Beweismittelübersicht (EXP-05, D-09, 08-04 Task 2 — eingelöste Vorwärtsreferenz): führend
 * die juristischen Objekte der Typen beweismittel/gegenbeweis, je mit Provenienz-Block
 * (Bestandsformat) und den über eine 'belegt'-Verknüpfung gestützten Objekten. Die bisherige
 * Ableitung aus Ausschnitten bleibt als nachgelagerte zweite Quelle erhalten (gleiche
 * Begründung wie Aufgabenliste/Argumentation). Fehlende Provenienz wird ehrlich benannt
 * („Herkunft unbekannt", Phase-1-Konvention), niemals erfunden.
 */
export async function erzeugeBeweismittelPdf(state: DesktopState, titel: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const layout = await erstelleLayout(pdf, titel);
  kopfZeilen(layout, titel);

  const objekte = (state.legalObjects ?? []).filter((o) => BEWEISMITTEL_KINDS.has(o.kind));
  const cutouts = state.cutouts ?? [];
  const links = state.links as LinkMitBedeutung[];

  if (objekte.length === 0 && cutouts.length === 0) {
    layout.zeile('Keine Einträge.');
    return pdf.save();
  }

  objekte.forEach((o, i) => {
    layout.zeile(`${i + 1}. ${LEGAL_OBJECT_KIND_LABELS[o.kind]} — ${kurz(o.text)}`, { fett: true });
    layout.zeile(`Erstellt von: ${oderUnbekannt(o.createdBy)}, ${datumIso(o.createdAt)}`, { groesse: 10, einzug: 16 });
    const bezuege = links.filter((l) => l.kind === 'belegt' && (l.fromId === o.id || l.toId === o.id));
    for (const l of bezuege) {
      const zielId = l.fromId === o.id ? l.toId : l.fromId;
      const benennung = benenneBezugsziel(state, zielId);
      if (benennung === undefined) continue; // internes Ziel: lautlos entfallen (D-08, T-08-14)
      layout.zeile(`– stützt: ${benennung}`, { groesse: 10, einzug: 24 });
    }
    layout.absatz('', { abstand: 8 });
  });

  cutouts.forEach((c, i) => {
    const quelle = state.docs.find((d) => d.fileId === c.fileId);
    const quellName = quelle?.name ?? c.sourceName ?? HERKUNFT_UNBEKANNT;
    layout.zeile(`${objekte.length + i + 1}. Ausschnitt — ${quellName}, Seite ${c.page}`, { fett: true });
    layout.zeile(`Dokument: ${quellName}`, { groesse: 10, einzug: 16 });
    layout.zeile(`Seite: ${c.page}`, { groesse: 10, einzug: 16 });
    layout.zeile(`Ursprungstext: ${c.textSnapshot ?? 'nicht gespeichert'}`, { groesse: 10, einzug: 16 });
    layout.zeile(`Erstellt von: ${oderUnbekannt(c.createdBy)}, ${datumIso(c.createdAt)}`, { groesse: 10, einzug: 16 });
    layout.absatz('', { abstand: 8 });
  });

  return pdf.save();
}

/**
 * Fundstellen-PDF (EXP-02, D-04, 03-08): Inhaltsverzeichnis mit Sprungzielen + je Fundstelle
 * ein Seitenausschnitt (Vektor-Crop der Originalseite, Research Pattern 5) mit vollständigem
 * Provenienz-Nachweis. Fundstellen sind Ausschnitte (cutouts) — siehe sammleFundstellenKandidaten
 * für die Abweichung von der ursprünglichen Planner-Annahme („… sowie Markierungen mit
 * textSnapshot"): marks (redact/tippex) bleiben bewusst außen vor (Rule 2, Sicherheitskorrektheit).
 *
 * Zweipass-Aufbau (Research Pattern 4): Pass 1 kopiert je Fundstelle die Quellseite, redigiert
 * ECHT (redactiereSeite VOR dem Crop — T-03-08-01: der Crop ist ein reiner Display-Crop, NIE
 * eine Vertraulichkeitsgrenze, Pattern 5) und setzt CropBox + Provenienz-Textblock; danach EIN
 * scrubbePdf-Gesamtlauf über alle kopierten Seiten (T-03-08-03: entfernt Annots/Metadaten der
 * QUELLSEITEN). Pass 2 stellt die TOC-Seite(n) MIT FRISCHEN Link-Annotationen voran — zwingend
 * NACH dem Scrub, weil scrubbePdf Annots löscht (Reihenfolge-Kommentar, Research Pattern 4).
 */

/** DoS-Schutz (T-03-08-04): Deckel je Fundstellen-Export — Quell-PDFs werden pro Fundstelle
 *  geladen (mit Cache je Dokument), kein kumulierter Riesen-Export. */
export const FUNDSTELLEN_LIMIT = 100;

const FUNDSTELLE_ZEILEN_H = 13;
const FUNDSTELLE_GROESSE = 9;
/** Rand um den visuellen Ausschnitt UND um den Provenienz-Block darunter — beides zusammen
 *  bildet die per setCropBox gesetzte Region (Display-Crop, Research Pattern 5). */
const FUNDSTELLE_CROP_RAND = 16;
const TOC_ZEILEN_H = 22;
const TOC_START_OFFSET = 70; // Platz für Titel + Zwischentitel auf der TOC-Seite

export interface FundstellenEintrag {
  id: string;
  doc: Doc;
  page: number;
  rect: { x: number; y: number; w: number; h: number };
  textSnapshot?: string;
  createdBy?: string;
  createdAt?: string;
  fileSha256?: string;
}

/**
 * Kandidaten-Fundstellen: NUR Ausschnitte (cutouts). Der State ist beim Aufruf bereits
 * freigabe-gefiltert (freigabeFilter, Route) — die Schnittmenge mit den im State VERBLIEBENEN
 * docs erledigt den Doc-Gate lautlos mit (D-08): ein effektiv internes Doc ist aus state.docs
 * bereits entfernt, seine Fundstellen finden hier keinen Treffer und fallen restlos weg.
 * Exportiert, damit die Route (pdfExport.ts) dieselbe Kandidatenmenge für die ids-Validierung
 * und den Leermeldungs-Gate nutzt — keine zweite, driftende Definition von „Fundstelle".
 *
 * ABWEICHUNG von der Planner-Annahme im Objective („cutouts sowie Markierungen mit
 * textSnapshot"), Rule 2 (Sicherheitskorrektheit): marks (redact/tippex) sind KEINE
 * eigenständigen Fundstellen. Ihr textSnapshot ist der URSPRÜNGLICH ÜBERDECKTE (zu
 * verbergende) Text (marks.ts-Kommentar: „ursprünglicher (überdeckter) Text") — dieselbe
 * Bedeutung wie bei redactiereSeite (T-03-05-01) und pdfExport.ts D-01 ("redact UND tippex
 * schwärzen echt"). Würde ein solcher Mark selbst zur Fundstelle, druckte sein eigener
 * Provenienz-Block genau den Text, den die Redaktion verbergen soll — ein direkter
 * Vertraulichkeitsbruch, sobald seine Ebene/sein Override versehentlich auf 'export' steht
 * (T-03-08-02). marks bleiben ausschließlich das, was sie in der Pipeline unten schon sind:
 * die Quelle der Schwärzungs-Rects für dieselbe Quellseite.
 */
export function sammleFundstellenKandidaten(state: DesktopState): FundstellenEintrag[] {
  const ergebnis: FundstellenEintrag[] = [];
  for (const c of state.cutouts ?? []) {
    const doc = state.docs.find((d) => d.fileId === c.fileId);
    if (!doc) continue; // Quell-Doc nicht (mehr) im gefilterten State — lautlos weg (D-08)
    ergebnis.push({
      id: c.id, doc, page: c.page, rect: c.rect,
      textSnapshot: c.textSnapshot, createdBy: c.createdBy, createdAt: c.createdAt, fileSha256: c.fileSha256,
    });
  }
  return ergebnis;
}

/**
 * Stand-Hinweis (D-15): eigenständige, knappe Serverformulierung. Der Export-Server importiert
 * bewusst NICHT src/lib/referenzstatus.ts (Client-Layer, andere Verantwortungsebene, siehe
 * Architektur-Schichten) — die dortige Kurz-/Erklärungstext-Konvention ist hier sinngemäß
 * nachgebildet. Nur die beiden Zustände, die den ANNOTIERTEN URSPRUNGSTEXT ehrlich einordnen
 * (gelöscht/ersetzt); reines Umbenennen/entzogener Zugriff ändert am Ursprungstext nichts und
 * bleibt hier ohne Stand-Hinweis (kein Live-Nachladen, kein Blockieren — D-15).
 */
function standHinweisFuerDoc(doc: Doc): string | undefined {
  if (doc.sourceGone === true) {
    return 'Stand-Hinweis: Das Quelldokument ist in j-lawyer inzwischen gelöscht — Ursprungstext zeigt den zuletzt gespeicherten Stand.';
  }
  if (doc.sourceReplacedAt !== undefined) {
    return `Stand-Hinweis: In j-lawyer am ${datumIso(doc.sourceReplacedAt)} durch eine neue Fassung ersetzt — Ursprungstext zeigt den zuletzt gespeicherten Stand.`;
  }
  return undefined;
}

/** Provenienz-Textzeilen einer Fundstelle: Dokumentname, Seite, Ersteller+Zeitpunkt, ggf.
 *  Stand-Hinweis bei ersetztem/gelöschtem jl-Quelldokument, Ursprungstext, Hash-Fingerabdruck. */
function fundstellenProvenienzZeilen(f: FundstellenEintrag): string[] {
  const zeilen = [
    `Dokument: ${f.doc.name}`,
    `Seite: ${f.page}`,
    `Erstellt von: ${oderUnbekannt(f.createdBy)}, ${datumIso(f.createdAt)}`,
  ];
  const stand = standHinweisFuerDoc(f.doc);
  if (stand !== undefined) zeilen.push(stand);
  zeilen.push(`Ursprungstext: ${f.textSnapshot ?? 'nicht gespeichert'}`);
  if (f.fileSha256 !== undefined) zeilen.push(`Fingerabdruck: ${f.fileSha256}`);
  return zeilen;
}

/**
 * Zeichnet den Provenienz-Block unterhalb des Seitenausschnitts und setzt die CropBox so, dass
 * Ausschnitt UND Block als EINE sichtbare Einheit erscheinen (Research Pattern 5: Display-Crop,
 * keine Vertraulichkeitsgrenze — die Sicherheit trägt redactiereSeite, nicht dieser Crop).
 */
function zeichneAusschnittUndProvenienz(
  seite: PDFPage,
  font: PDFFont,
  rectUser: UserSpaceRect,
  zeilen: string[],
): void {
  const breite = Math.max(rectUser.w + 2 * FUNDSTELLE_CROP_RAND, 260);
  const textBreite = breite - 2 * FUNDSTELLE_CROP_RAND;
  const gewrapt = zeilen.flatMap((z) => wrapText(z, font, FUNDSTELLE_GROESSE, textBreite));
  const textHoehe = gewrapt.length * FUNDSTELLE_ZEILEN_H;

  const cropX = rectUser.x - FUNDSTELLE_CROP_RAND;
  const cropTop = rectUser.y + rectUser.h + FUNDSTELLE_CROP_RAND;
  const cropBottom = rectUser.y - FUNDSTELLE_CROP_RAND - textHoehe - FUNDSTELLE_CROP_RAND;
  seite.setCropBox(cropX, cropBottom, breite, cropTop - cropBottom);

  let y = rectUser.y - FUNDSTELLE_CROP_RAND - FUNDSTELLE_ZEILEN_H + 4;
  for (const zeile of gewrapt) {
    seite.drawText(winansiSanitize(zeile), { x: cropX + FUNDSTELLE_CROP_RAND / 2, y, size: FUNDSTELLE_GROESSE, font });
    y -= FUNDSTELLE_ZEILEN_H;
  }
}

/** Kurzlabel für den TOC-Eintrag: Dokumentname, hart gekappt (kurz(), Modulkopf oben). */
function fundstellenKurzlabel(f: FundstellenEintrag): string {
  return `${kurz(f.doc.name, 40)} — Seite ${f.page}`;
}

/** Weißraum-Normalisierung für den Gate-Vergleich (dieselbe Regel wie pdfExport.ts): pdfjs-
 *  Extraktionen brechen Zeilen/Leerräume unterschiedlich auf — verglichen wird auf Wortebene. */
function normalisiere(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Quellen-Zugriff für die Fundstellen-Pipeline: die Route reicht denselben Cache-/Datei-
 *  Wahlweg wie die annotierte Kopie (03-07) über diesen Callback herein. */
export interface FundstellenQuellen {
  ladeDocBytes(docId: string): Promise<Uint8Array>;
}

export async function erzeugeFundstellenPdf(
  state: DesktopState,
  quellen: FundstellenQuellen,
  titel: string,
  ids?: string[],
): Promise<Uint8Array> {
  const kandidaten = sammleFundstellenKandidaten(state);
  const fundstellen = ids !== undefined ? kandidaten.filter((f) => ids.includes(f.id)) : kandidaten;
  if (fundstellen.length > FUNDSTELLEN_LIMIT) {
    throw new ExportFehler(
      'limit',
      `Zu viele Fundstellen für den Export (${fundstellen.length} von ${FUNDSTELLEN_LIMIT})`,
    );
  }

  const out = await PDFDocument.create();
  const font = await out.embedFont(StandardFonts.Helvetica);
  const fett = await out.embedFont(StandardFonts.HelveticaBold);

  // Quell-PDFs werden je Dokument EINMAL geladen, auch wenn mehrere Fundstellen davon stammen.
  const quellCache = new Map<string, PDFDocument>();
  async function ladeQuelle(docId: string): Promise<PDFDocument | undefined> {
    const cached = quellCache.get(docId);
    if (cached) return cached;
    try {
      const bytes = await quellen.ladeDocBytes(docId);
      const geladen = await PDFDocument.load(bytes, { ignoreEncryption: true });
      quellCache.set(docId, geladen);
      return geladen;
    } catch {
      return undefined; // fehlende/unlesbare Quelle ⇒ Fundstelle fällt lautlos weg (D-15)
    }
  }

  const aufbau: Array<{ seite: PDFPage; label: string }> = [];
  // Angewendete Schwärzungs-Snapshots über ALLE Fundstellen — Grundlage für das
  // Verifikationsgate am Ende (mirrors registriereDokumentRoute, T-03-07-01).
  const angewendeteSnapshots: string[] = [];

  for (const f of fundstellen) {
    const quellDoc = await ladeQuelle(f.doc.id);
    if (!quellDoc) continue;
    const quellSeiten = quellDoc.getPages();
    const seitenIndex = f.page - 1;
    if (seitenIndex < 0 || seitenIndex >= quellSeiten.length) continue; // Seite existiert nicht (mehr) — lautlos weg

    const [kopie] = await out.copyPages(quellDoc, [seitenIndex]);
    out.addPage(kopie);
    const geo = seitenGeometrieVon(quellSeiten[seitenIndex]);

    // Redaktion VOR Crop (Pattern 5, T-03-08-01): ALLE freigegebenen Schwärzungs-Rects DIESER
    // Quellseite — unabhängig davon, ob sie den Crop-Bereich überlappen. Der Crop entfernt
    // nichts aus dem Content-Stream; nur redactiereSeite tut das.
    const schwaerzungen = (state.marks ?? []).filter(
      (m) => m.docId === f.doc.id && m.page === f.page && (m.kind === 'redact' || m.kind === 'tippex'),
    );
    if (schwaerzungen.length > 0) {
      const rects = schwaerzungen.map((m) => basisNachUserSpace(m.rect, geo));
      const erg = redactiereSeite(out, kopie, rects, geo);
      if (erg.rotationsAbgelehnt || erg.xobjectTextVerdacht > 0) {
        // Fail-closed (mirrors registriereDokumentRoute, T-03-07-01): NIE eine Seite ausliefern,
        // als wäre sie redigiert, wenn der Rewriter das nicht garantieren konnte. Ohne
        // installierten Rasterer bricht rasterisiereSeite den gesamten Export ab (die Route
        // fängt die ExportFehler als 422) — eine einzelne unsicher redigierbare Fundstelle darf
        // niemals eine ungeprüft "geschwärzte" Seite ins Artefakt schleusen.
        //
        // WR-04: ladeQuelle() oben cacht nur das geparste PDFDocument, nicht die Rohbytes —
        // dieser zweite ladeDocBytes-Aufruf braucht daher sein eigenes try/catch (anders als
        // ladeQuelle, das Fehler bereits lautlos abfängt, D-15). Ohne Guard würde ein
        // transienter Lesefehler hier (statt eines sauberen 422) als unbehandelter 500
        // durchschlagen, obwohl das Ergebnis (kein Artefakt) fachlich identisch bliebe.
        let rasterQuelle: Uint8Array;
        try {
          rasterQuelle = await quellen.ladeDocBytes(f.doc.id);
        } catch {
          throw new ExportFehler('quelle-fehlt', 'Die Originaldatei wurde nicht gefunden');
        }
        await rasteriereSeiteFailClosed(rasterQuelle, seitenIndex);
      }
      for (const m of schwaerzungen) {
        if (m.textSnapshot !== undefined && m.textSnapshot !== '') angewendeteSnapshots.push(m.textSnapshot);
      }
    }

    const rectUser = basisNachUserSpace(f.rect, geo);
    zeichneAusschnittUndProvenienz(kopie, font, rectUser, fundstellenProvenienzZeilen(f));
    aufbau.push({ seite: kopie, label: fundstellenKurzlabel(f) });
  }

  // EIN Scrub-Gesamtlauf über alle kopierten Seiten (T-03-08-03) — danach erst die frischen
  // TOC-Links setzen (scrubbePdf würde sie sonst mitlöschen, Research Pattern 4).
  scrubbePdf(out);

  const nutzbareHoehe = SEITE_H - RAND - TOC_START_OFFSET - RAND;
  const eintraegeProSeite = Math.max(1, Math.floor(nutzbareHoehe / TOC_ZEILEN_H));
  const tocSeitenAnzahl = aufbau.length > 0 ? Math.ceil(aufbau.length / eintraegeProSeite) : 1;

  const tocSeiten: PDFPage[] = [];
  for (let i = 0; i < tocSeitenAnzahl; i++) tocSeiten.push(out.insertPage(i, [SEITE_W, SEITE_H]));

  let cursor = 0;
  for (let s = 0; s < tocSeitenAnzahl; s++) {
    const seite = tocSeiten[s];
    seite.drawText(winansiSanitize(titel), { x: RAND, y: SEITE_H - RAND, size: 14, font: fett });
    seite.drawText(
      winansiSanitize(tocSeitenAnzahl > 1 ? `Inhaltsverzeichnis (${s + 1}/${tocSeitenAnzahl})` : 'Inhaltsverzeichnis'),
      { x: RAND, y: SEITE_H - RAND - 24, size: 11, font: fett },
    );
    let y = SEITE_H - TOC_START_OFFSET;
    const linkRefs: PDFRef[] = [];
    for (let n = 0; n < eintraegeProSeite && cursor < aufbau.length; n++, cursor++) {
      const eintrag = aufbau[cursor];
      const seitenNr = tocSeitenAnzahl + cursor + 1;
      seite.drawText(winansiSanitize(`${cursor + 1}. ${eintrag.label} — Seite ${seitenNr}`), {
        x: RAND, y, size: 10, font,
      });
      // Frische Link-Annotation je Eintrag (kein High-Level-API in pdf-lib, Research Pattern 4):
      // GoTo-Ziel per Dest-Array auf die Zielseiten-Referenz.
      linkRefs.push(
        out.context.register(
          out.context.obj({
            Type: 'Annot',
            Subtype: 'Link',
            Rect: [RAND, y - 4, SEITE_W - RAND, y + 12],
            Border: [0, 0, 0],
            Dest: [eintrag.seite.ref, 'XYZ', null, null, null],
          }),
        ),
      );
      y -= TOC_ZEILEN_H;
    }
    seite.node.set(PDFName.of('Annots'), out.context.obj(linkRefs));
  }

  const ergebnisBytes = await out.save();

  // Verifikationsgate (fail-closed, mirrors registriereDokumentRoute, T-03-07-01): die
  // ERGEBNIS-Bytes werden erneut per pdfjs gelesen und gegen JEDEN angewendeten textSnapshot
  // geprüft. Ein Treffer heißt: Rest-Text hat überlebt — dann gibt es kein Artefakt.
  // KOPIE: pdfjs übernimmt den übergebenen Buffer als Transferable (detach) — ohne slice()
  // wären ergebnisBytes nach dem Gate leer und die Route läge ein 0-Byte-PDF bei.
  const extraktion = normalisiere(await extrahiereText(ergebnisBytes.slice()));
  for (const snapshot of angewendeteSnapshots) {
    if (extraktion.includes(normalisiere(snapshot))) {
      throw new ExportFehler(
        'verifikation-fehlgeschlagen',
        'Die Schwärzung konnte nicht verifiziert werden; der Export wurde abgebrochen, damit kein ungeprüftes Dokument entsteht'
      );
    }
  }

  return ergebnisBytes;
}
