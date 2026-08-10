import { provenienz, CARD_W, CARD_H, type DesktopState, type Vec2, type Size, type CommandMeta } from './model';
import { removeLinksFor } from './links';
import type { Box } from './viewport';
import { uid } from './uid';
import {
  FORMEL_ARTEN, type FormelArt,
  sumColumnCents, parseEuroToCents, dateDiffDays, simpleInterestCents, recurringPaymentTotalCents,
} from './tableFormulas';

/**
 * Tabellenkarte (CALC-01): Forderungsaufstellungen, Fristketten und Zinsrechnungen. Ein
 * eigenständiges, registriertes Objekt auf dem Tisch — wie jede andere Karte mit
 * Konflikterkennung, Ebenenzuordnung, Freigabe und Papierkorb (08-RESEARCH.md Anti-Pattern).
 * Zeilen sind in der Karte VERSCHACHTELT und tragen KEINE eigene Objektidentität: sie bekommen
 * keinen eigenen VERSIONIERTE_ARTEN-Eintrag, `findeObjekt` löst eine Zeilen-id nie auf.
 */

/** Bezug einer Tabellenzeile zu Dokument/Fundstelle — ein Feld auf der Zeile, KEINE Verknüpfung
 *  im Objektgraphen (eine Zeile hat keine eigenständige Objektidentität, `findeObjekt` könnte
 *  ihre id nie auflösen). Strukturgleich zu `TaskDocRef` (08-02), aber eigenständig benannt. */
export interface BelegRef {
  docId: string;
  page?: number;
  cutoutId?: string;
}

/**
 * Spalte einer Tabellenkarte. `art: 'formel'` trägt zusätzlich `formel` (welche der vier
 * Formelarten aus tableFormulas.ts), `quelleSpalteId` (welche Spalte die Rohwerte liefert) und
 * optional `parameter` (z. B. Zinssatz/Tage/Anzahl als benannte Zahlen). Nicht-Formel-Spalten
 * (`text`/`zahl`/`datum`) tragen nur Rohwerte in den Zeilen — dieser Plan (08-06) legt die
 * Formelspalten-Mechanik fest; das Anlegen einfacher Rohwert-Spalten ist Sache der UI-Karte
 * (spätere Phase-8-Pläne).
 */
export interface TableColumn {
  id: string;
  titel: string;
  art: 'text' | 'zahl' | 'datum' | 'formel';
  formel?: FormelArt;
  quelleSpalteId?: string;
  parameter?: Record<string, number>;
}

/**
 * Eine Tabellenzeile. Zellwerte werden als Zeichenketten gespeichert — die Umwandlung nach Cent
 * oder Datum geschieht ausschließlich in den Formelfunktionen (tableFormulas.ts), so dass eine
 * unvollständige Eingabe die Zelle nicht zerstört. Geldspalten speichern die Rohschreibweise;
 * `parseEuroToCents` wandelt erst bei der Berechnung.
 */
export interface TableRow {
  id: string;
  zellen: Record<string, string>;
  belegRef?: BelegRef;
}

export interface TableCard {
  id: string;
  titel: string;
  spalten: TableColumn[];
  rows: TableRow[];
  position: Vec2;   // Weltkoordinaten, linke obere Ecke
  zIndex: number;
  open?: boolean;      // aufgeschlagen (große Karte) statt Miniatur
  openSize?: Size;     // Größe der großen Karte (Weltkoordinaten)
  taped?: boolean;       // Klebeband (08-07): Drag gesperrt, bis das Band abgezogen wird
  createdBy?: string;    // Provenienz: wer hat die Karte erzeugt; fehlt in Alt-States
  createdById?: string;  // Provenienz: stabile users.id des Erzeugers (WR-05); fehlt in Alt-States
  createdAt?: string;    // Provenienz: wann, ISO-Zeitpunkt; fehlt in Alt-States
  updatedRev?: number;   // Konflikterkennung: Schreibtisch-rev der letzten Änderung; fehlt in Alt-States
  updatedAt?: string;    // Provenienz: wann zuletzt geändert, ISO-Zeitpunkt; fehlt in Alt-States
  updatedBy?: string;    // Provenienz: wer zuletzt geändert hat; fehlt in Alt-States
  layerId?: string;      // Sichtbarkeits-/Bearbeitungsebene; fehlt in Alt-States (implizit "Kanzlei")
  freigabe?: import('./freigabe').Freigabe; // Freigabe-Override (EXP-03); fehlt in Alt-States (implizit Ebenen-Default, fail-closed 'intern', D-14)
}

export const TABELLE_OPEN_W = 640;
export const TABELLE_OPEN_H = 420;

function maxZ(s: DesktopState): number {
  return Math.max(
    0,
    ...s.docs.map((d) => d.zIndex),
    ...s.stacks.map((st) => st.zIndex),
    ...(s.notes ?? []).map((n) => n.zIndex),
    ...(s.cutouts ?? []).map((c) => c.zIndex),
    ...(s.legalObjects ?? []).map((o) => o.zIndex),
    ...(s.tables ?? []).map((t) => t.zIndex),
    // 09-01: eine neu angelegte Tabelle darf nicht unter eine bereits vorhandene Zeitleiste
    // fallen — derselbe Reihenfolge-Bug wie der 08-07-Kommentar in documents.ts/copy.ts.
    ...(s.zeitleisten ?? []).map((z) => z.zIndex),
  );
}

function mapTable(s: DesktopState, id: string, fn: (t: TableCard) => TableCard): DesktopState {
  const tables = s.tables ?? [];
  if (!tables.some((t) => t.id === id)) throw new Error(`Tabelle "${id}" nicht gefunden`);
  return { ...s, tables: tables.map((t) => (t.id === id ? fn(t) : t)) };
}

function mapTableRow(s: DesktopState, tableId: string, rowId: string, fn: (r: TableRow) => TableRow): DesktopState {
  return mapTable(s, tableId, (t) => {
    if (!t.rows.some((r) => r.id === rowId)) throw new Error(`Tabellenzeile "${rowId}" nicht gefunden`);
    return { ...t, rows: t.rows.map((r) => (r.id === rowId ? fn(r) : r)) };
  });
}

/** Legt eine neue Tabellenkarte mit genau einer leeren Platzhalterzeile an. */
export function addTable(s: DesktopState, position: Vec2, id: string = uid(), meta?: CommandMeta): DesktopState {
  const table: TableCard = {
    id,
    titel: '',
    spalten: [],
    rows: [{ id: uid(), zellen: {} }],
    position,
    zIndex: maxZ(s) + 1,
    ...provenienz(meta),
  };
  return { ...s, tables: [...(s.tables ?? []), table] };
}

export function moveTable(s: DesktopState, id: string, position: Vec2): DesktopState {
  return mapTable(s, id, (t) => ({ ...t, position }));
}

export function renameTable(s: DesktopState, id: string, titel: string): DesktopState {
  return mapTable(s, id, (t) => ({ ...t, titel }));
}

export function removeTable(s: DesktopState, id: string): DesktopState {
  const tables = s.tables ?? [];
  if (!tables.some((t) => t.id === id)) throw new Error(`Tabelle "${id}" nicht gefunden`);
  const next = removeLinksFor(s, id);
  return { ...next, tables: tables.filter((t) => t.id !== id) };
}

export function expandTable(s: DesktopState, id: string): DesktopState {
  return mapTable(s, id, (t) => ({ ...t, open: true, openSize: t.openSize ?? { w: TABELLE_OPEN_W, h: TABELLE_OPEN_H } }));
}

export function collapseTable(s: DesktopState, id: string): DesktopState {
  return mapTable(s, id, (t) => ({ ...t, open: false }));
}

export function resizeTable(s: DesktopState, id: string, size: Size): DesktopState {
  if (!(size.w > 0) || !(size.h > 0)) throw new Error(`Ungültige Größe: ${size.w}×${size.h}`);
  return mapTable(s, id, (t) => ({ ...t, openSize: { w: size.w, h: size.h } }));
}

export function addTableRow(s: DesktopState, tableId: string, id: string = uid()): DesktopState {
  return mapTable(s, tableId, (t) => ({ ...t, rows: [...t.rows, { id, zellen: {} }] }));
}

export function setTableCell(s: DesktopState, tableId: string, rowId: string, spaltenId: string, wert: string): DesktopState {
  return mapTableRow(s, tableId, rowId, (r) => ({ ...r, zellen: { ...r.zellen, [spaltenId]: wert } }));
}

export function removeTableRow(s: DesktopState, tableId: string, rowId: string): DesktopState {
  return mapTable(s, tableId, (t) => {
    if (!t.rows.some((r) => r.id === rowId)) throw new Error(`Tabellenzeile "${rowId}" nicht gefunden`);
    return { ...t, rows: t.rows.filter((r) => r.id !== rowId) };
  });
}

/**
 * Setzt oder entfernt den Beleg-Bezug einer Zeile. Der Bezug bleibt ein FELD auf der Zeile — er
 * wird ausdrücklich nicht als `Link` angelegt, weil eine Zeile keine eigenständige
 * Objektidentität hat und `findeObjekt` ihre id nie auflösen könnte. `belegRef === undefined`
 * entfernt den Bezug; ein Bezug ohne `docId` wirft.
 */
export function setTableRowBeleg(s: DesktopState, tableId: string, rowId: string, belegRef: BelegRef | undefined): DesktopState {
  return mapTableRow(s, tableId, rowId, (r) => {
    if (belegRef === undefined) {
      const { belegRef: _entfernt, ...rest } = r;
      return rest as TableRow;
    }
    if (typeof belegRef.docId !== 'string' || belegRef.docId === '') {
      throw new Error('Beleg-Bezug benötigt eine docId');
    }
    return { ...r, belegRef };
  });
}

/**
 * Fügt eine Rohwert-Spalte hinzu (Text/Zahl/Datum) — je Zeile über `setTableCell()` befüllt.
 * 08-06 lieferte nur `addTableFormulaColumn()`; eine Formelspalte referenziert aber zwingend
 * eine QUELLSPALTE, und ohne diese Funktion gäbe es keinen Weg, eine solche Spalte in der UI
 * überhaupt anzulegen (08-06-SUMMARY.md „Next Phase Readiness"). Anders als `TableColumn.art:
 * 'formel'` trägt eine Rohwert-Spalte kein `formel`-Feld.
 */
export function addTableColumn(
  s: DesktopState,
  tableId: string,
  titel: string,
  art: 'text' | 'zahl' | 'datum',
  id: string = uid(),
): DesktopState {
  const spalte: TableColumn = { id, titel, art };
  return mapTable(s, tableId, (t) => ({ ...t, spalten: [...t.spalten, spalte] }));
}

/** Fügt eine Formelspalte hinzu. Eine Art außerhalb von `FORMEL_ARTEN` wirft — Verteidigung auf
 *  Core-Ebene, zusätzlich zum Literal-Union-Validator im Command-Pfad (commands.ts). */
export function addTableFormulaColumn(
  s: DesktopState,
  tableId: string,
  titel: string,
  formel: FormelArt,
  quelleSpalteId?: string,
  parameter?: Record<string, number>,
  id: string = uid(),
): DesktopState {
  if (!FORMEL_ARTEN.includes(formel)) throw new Error(`Unbekannte Formelart: ${String(formel)}`);
  const spalte: TableColumn = {
    id,
    titel,
    art: 'formel',
    formel,
    ...(quelleSpalteId !== undefined ? { quelleSpalteId } : {}),
    ...(parameter !== undefined ? { parameter } : {}),
  };
  return mapTable(s, tableId, (t) => ({ ...t, spalten: [...t.spalten, spalte] }));
}

export function removeTableColumn(s: DesktopState, tableId: string, spaltenId: string): DesktopState {
  return mapTable(s, tableId, (t) => {
    if (!t.spalten.some((sp) => sp.id === spaltenId)) throw new Error(`Spalte "${spaltenId}" nicht gefunden`);
    return { ...t, spalten: t.spalten.filter((sp) => sp.id !== spaltenId) };
  });
}

export function findTable(s: DesktopState, id: string): TableCard | undefined {
  return (s.tables ?? []).find((t) => t.id === id);
}

export function tableBox(t: TableCard): Box {
  if (t.open) {
    const size = t.openSize ?? { w: TABELLE_OPEN_W, h: TABELLE_OPEN_H };
    return { x: t.position.x, y: t.position.y, w: size.w, h: size.h };
  }
  return { x: t.position.x, y: t.position.y, w: CARD_W, h: CARD_H };
}

/**
 * Die Brücke zwischen Kartendaten und den reinen Funktionen aus tableFormulas.ts. Das Ergebnis
 * wird NIE im Zustand abgelegt — es gibt keinen Setter und kein Feld dafür; jede Anzeige rechnet
 * aus den Rohzeilen neu (T-08-25). Eine Spalte ohne konfigurierte Quellspalte (`quelleSpalteId`
 * fehlt — "die Quellspalte existiert nicht") liefert `undefined` statt zu werfen; Zellwerte sind
 * ein freies `Record<string, string>` ohne eigene Spalten-Registrierung, daher ist eine fehlende
 * `quelleSpalteId` die einzig prüfbare Form von "Quellspalte existiert nicht". Bei 'summe' werden
 * nicht interpretierbare Zellen übersprungen (eine einzelne Tippfehler-Zeile darf nicht die ganze
 * Aufstellung unbrauchbar machen) — bei den übrigen drei Arten ergibt eine unbrauchbare Eingabe
 * `undefined` (dort gibt es nichts zu überspringen, das Ergebnis hinge an genau dieser einen
 * Eingabe).
 *
 * 'datumsdifferenz' vergleicht die ERSTE und die LETZTE Zeile der Quellspalte (Fristketten sind
 * chronologische Listen); 'zinsen'/'wiederkehrende-zahlung' lesen Kapital/Betrag aus der ERSTEN
 * Zeile der Quellspalte und Satz/Tage/Anzahl aus `spalte.parameter`.
 */
export function berechneFormelSpalte(table: TableCard, spalte: TableColumn): number | undefined {
  if (spalte.art !== 'formel' || spalte.formel === undefined) return undefined;
  const quelleId = spalte.quelleSpalteId;
  if (quelleId === undefined) return undefined;

  if (spalte.formel === 'summe') {
    const werte: number[] = [];
    for (const row of table.rows) {
      const wert = parseEuroToCents(row.zellen[quelleId] ?? '');
      if (wert !== undefined) werte.push(wert);
    }
    return sumColumnCents(werte);
  }

  if (spalte.formel === 'datumsdifferenz') {
    if (table.rows.length === 0) return undefined;
    const erste = table.rows[0].zellen[quelleId];
    const letzte = table.rows[table.rows.length - 1].zellen[quelleId];
    if (erste === undefined || letzte === undefined) return undefined;
    return dateDiffDays(erste, letzte);
  }

  if (spalte.formel === 'zinsen') {
    if (table.rows.length === 0) return undefined;
    const kapitalRoh = table.rows[0].zellen[quelleId];
    if (kapitalRoh === undefined) return undefined;
    const kapitalCents = parseEuroToCents(kapitalRoh);
    if (kapitalCents === undefined) return undefined;
    const zinssatzProzent = spalte.parameter?.zinssatzProzent;
    const tage = spalte.parameter?.tage;
    if (zinssatzProzent === undefined || tage === undefined) return undefined;
    return simpleInterestCents(kapitalCents, zinssatzProzent, tage);
  }

  // 'wiederkehrende-zahlung'
  if (table.rows.length === 0) return undefined;
  const betragRoh = table.rows[0].zellen[quelleId];
  if (betragRoh === undefined) return undefined;
  const betragCents = parseEuroToCents(betragRoh);
  if (betragCents === undefined) return undefined;
  const anzahl = spalte.parameter?.anzahl;
  if (anzahl === undefined) return undefined;
  return recurringPaymentTotalCents(betragCents, anzahl);
}
