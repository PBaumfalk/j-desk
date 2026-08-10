import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { emptyState, isValidState, type DesktopState } from './model';
import { findeObjekt } from './stempel';
import { changeLayerId } from './layers';
import { trashObject, restoreObject } from './trash';
import { addLink } from './links';
import { applyCommand, CommandError } from './commands';
import {
  addTable, moveTable, renameTable, removeTable, expandTable, collapseTable, resizeTable,
  addTableRow, setTableCell, removeTableRow, setTableRowBeleg, addTableColumn, addTableFormulaColumn, removeTableColumn,
  findTable, tableBox, berechneFormelSpalte,
  TABELLE_OPEN_W, TABELLE_OPEN_H,
  type TableCard, type TableColumn, type FormelArt,
} from './tables';

describe('addTable', () => {
  it('erzeugt eine Karte mit genau einer leeren Platzhalterzeile und zIndex = maxZ + 1', () => {
    const alt = emptyState();
    const neu = addTable(alt, { x: 10, y: 20 }, 'tb1');
    expect(neu.tables).toHaveLength(1);
    const t = neu.tables![0];
    expect(t).toMatchObject({ id: 'tb1', titel: '', spalten: [], position: { x: 10, y: 20 } });
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0].zellen).toEqual({});
    expect(t.zIndex).toBeGreaterThan(0);
  });

  it('vergibt eine id, wenn keine mitkommt', () => {
    const s = addTable(emptyState(), { x: 0, y: 0 });
    expect(s.tables![0].id).toBeTruthy();
  });

  it('funktioniert auf alten States ohne tables-Feld', () => {
    const alt = emptyState();
    delete (alt as { tables?: unknown }).tables;
    expect(addTable(alt, { x: 0, y: 0 }).tables).toHaveLength(1);
  });
});

describe('moveTable/renameTable', () => {
  it('moveTable ändert die Position, renameTable den Titel', () => {
    let s = addTable(emptyState(), { x: 0, y: 0 }, 'tb1');
    s = moveTable(s, 'tb1', { x: 5, y: 6 });
    expect(findTable(s, 'tb1')?.position).toEqual({ x: 5, y: 6 });
    s = renameTable(s, 'tb1', 'Forderungsaufstellung');
    expect(findTable(s, 'tb1')?.titel).toBe('Forderungsaufstellung');
  });

  it('moveTable/renameTable/removeTable auf unbekannter id werfen "nicht gefunden"', () => {
    expect(() => moveTable(emptyState(), 'nix', { x: 0, y: 0 })).toThrow(/nicht gefunden/);
    expect(() => renameTable(emptyState(), 'nix', 'x')).toThrow(/nicht gefunden/);
    expect(() => removeTable(emptyState(), 'nix')).toThrow(/nicht gefunden/);
  });
});

describe('expandTable/collapseTable/resizeTable', () => {
  it('expandTable öffnet mit Vorgabemaßen, resizeTable setzt eine eigene Größe, collapseTable schließt', () => {
    let s = addTable(emptyState(), { x: 0, y: 0 }, 'tb1');
    s = expandTable(s, 'tb1');
    expect(findTable(s, 'tb1')).toMatchObject({ open: true, openSize: { w: TABELLE_OPEN_W, h: TABELLE_OPEN_H } });
    s = resizeTable(s, 'tb1', { w: 800, h: 600 });
    expect(findTable(s, 'tb1')?.openSize).toEqual({ w: 800, h: 600 });
    s = collapseTable(s, 'tb1');
    expect(findTable(s, 'tb1')?.open).toBe(false);
  });

  it('resizeTable lehnt nicht-positive Maße ab', () => {
    const s = addTable(emptyState(), { x: 0, y: 0 }, 'tb1');
    expect(() => resizeTable(s, 'tb1', { w: 0, h: 500 })).toThrow();
  });
});

describe('addTableRow/setTableCell/removeTableRow', () => {
  it('addTableRow hängt eine Zeile an', () => {
    let s = addTable(emptyState(), { x: 0, y: 0 }, 'tb1');
    s = addTableRow(s, 'tb1', 'r2');
    expect(findTable(s, 'tb1')?.rows).toHaveLength(2);
  });

  it('setTableCell setzt genau eine Zelle; alle übrigen Zeilen behalten ihre Referenz', () => {
    let s = addTable(emptyState(), { x: 0, y: 0 }, 'tb1');
    s = addTableRow(s, 'tb1', 'r2');
    const r2Vorher = findTable(s, 'tb1')!.rows.find((r) => r.id === 'r2');
    const rPlatzhalter = findTable(s, 'tb1')!.rows[0];
    s = setTableCell(s, 'tb1', rPlatzhalter.id, 'sp1', '10,00');
    const nach = findTable(s, 'tb1')!;
    expect(nach.rows.find((r) => r.id === rPlatzhalter.id)?.zellen).toEqual({ sp1: '10,00' });
    expect(nach.rows.find((r) => r.id === 'r2')).toBe(r2Vorher);
  });

  it('removeTableRow entfernt genau eine Zeile über ihre id', () => {
    let s = addTable(emptyState(), { x: 0, y: 0 }, 'tb1');
    s = addTableRow(s, 'tb1', 'r2');
    const platzhalterId = findTable(s, 'tb1')!.rows[0].id;
    s = removeTableRow(s, 'tb1', 'r2');
    const rows = findTable(s, 'tb1')!.rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(platzhalterId);
  });

  it('removeTableRow/setTableCell auf unbekannter Zeilen-id werfen', () => {
    const s = addTable(emptyState(), { x: 0, y: 0 }, 'tb1');
    expect(() => removeTableRow(s, 'tb1', 'nix')).toThrow(/nicht gefunden/);
    expect(() => setTableCell(s, 'tb1', 'nix', 'sp1', 'x')).toThrow(/nicht gefunden/);
  });
});

describe('setTableRowBeleg', () => {
  function tabelleMitZeile() {
    const s = addTable(emptyState(), { x: 0, y: 0 }, 'tb1');
    const rowId = s.tables![0].rows[0].id;
    return { s, rowId };
  }

  it('setzt einen Beleg-Bezug als Feld auf der Zeile', () => {
    const { s, rowId } = tabelleMitZeile();
    const neu = setTableRowBeleg(s, 'tb1', rowId, { docId: 'd1', page: 3 });
    expect(findTable(neu, 'tb1')?.rows.find((r) => r.id === rowId)?.belegRef).toEqual({ docId: 'd1', page: 3 });
  });

  it('ein Aufruf mit undefined entfernt den Bezug', () => {
    const { s, rowId } = tabelleMitZeile();
    let neu = setTableRowBeleg(s, 'tb1', rowId, { docId: 'd1' });
    neu = setTableRowBeleg(neu, 'tb1', rowId, undefined);
    const row = findTable(neu, 'tb1')?.rows.find((r) => r.id === rowId);
    expect(row?.belegRef).toBeUndefined();
    expect('belegRef' in row!).toBe(false);
  });

  it('ein Bezug ohne docId wirft', () => {
    const { s, rowId } = tabelleMitZeile();
    expect(() => setTableRowBeleg(s, 'tb1', rowId, { docId: '' })).toThrow();
  });

  it('zwei Zeilen können denselben Beleg-Bezug tragen', () => {
    let s = addTable(emptyState(), { x: 0, y: 0 }, 'tb1');
    s = addTableRow(s, 'tb1', 'r2');
    s = setTableRowBeleg(s, 'tb1', s.tables![0].rows[0].id, { docId: 'd1' });
    s = setTableRowBeleg(s, 'tb1', 'r2', { docId: 'd1' });
    const rows = findTable(s, 'tb1')!.rows;
    expect(rows.every((r) => r.belegRef?.docId === 'd1')).toBe(true);
  });

  it('ein Beleg-Bezug überlebt trashObject und restoreObject unverändert', () => {
    let s = addTable(emptyState(), { x: 0, y: 0 }, 'tb1');
    const rowId = s.tables![0].rows[0].id;
    s = setTableRowBeleg(s, 'tb1', rowId, { docId: 'd1', page: 3, cutoutId: 'c1' });
    s = trashObject(s, 'tb1', '2026-08-07T00:00:00.000Z', 't1');
    s = restoreObject(s, 't1');
    expect(findTable(s, 'tb1')?.rows.find((r) => r.id === rowId)?.belegRef).toEqual({ docId: 'd1', page: 3, cutoutId: 'c1' });
  });
});

describe('addTableColumn (08-07: Rohwert-Spalte für Formel-Quellspalten)', () => {
  it('fügt eine Rohwert-Spalte hinzu — ohne formel-Feld', () => {
    let s = addTable(emptyState(), { x: 0, y: 0 }, 'tb1');
    s = addTableColumn(s, 'tb1', 'Betrag', 'zahl', 'sp1');
    expect(findTable(s, 'tb1')?.spalten).toEqual([{ id: 'sp1', titel: 'Betrag', art: 'zahl' }]);
  });

  it('eine so angelegte Spalte ist als Quellspalte einer Formel verwendbar', () => {
    let s = addTable(emptyState(), { x: 0, y: 0 }, 'tb1');
    s = addTableColumn(s, 'tb1', 'Betrag', 'zahl', 'sp1');
    const rowId = s.tables![0].rows[0].id;
    s = setTableCell(s, 'tb1', rowId, 'sp1', '10,00');
    s = addTableFormulaColumn(s, 'tb1', 'Summe', 'summe', 'sp1', undefined, 'formelSp');
    const spalte = findTable(s, 'tb1')!.spalten.find((sp) => sp.id === 'formelSp')!;
    expect(berechneFormelSpalte(findTable(s, 'tb1')!, spalte)).toBe(1000);
  });
});

describe('addTableFormulaColumn/removeTableColumn', () => {
  it('fügt eine Formelspalte hinzu', () => {
    let s = addTable(emptyState(), { x: 0, y: 0 }, 'tb1');
    s = addTableFormulaColumn(s, 'tb1', 'Summe', 'summe', 'geld', undefined, 'sp1');
    expect(findTable(s, 'tb1')?.spalten).toEqual([{ id: 'sp1', titel: 'Summe', art: 'formel', formel: 'summe', quelleSpalteId: 'geld' }]);
  });

  it('eine Art außerhalb von FORMEL_ARTEN wirft', () => {
    const s = addTable(emptyState(), { x: 0, y: 0 }, 'tb1');
    expect(() => addTableFormulaColumn(s, 'tb1', 'X', 'unbekannt' as FormelArt, 'geld')).toThrow();
  });

  it('removeTableColumn entfernt genau eine Spalte über ihre id', () => {
    let s = addTable(emptyState(), { x: 0, y: 0 }, 'tb1');
    s = addTableFormulaColumn(s, 'tb1', 'Summe', 'summe', 'geld', undefined, 'sp1');
    s = addTableFormulaColumn(s, 'tb1', 'Zinsen', 'zinsen', 'geld', undefined, 'sp2');
    s = removeTableColumn(s, 'tb1', 'sp1');
    expect(findTable(s, 'tb1')?.spalten.map((sp) => sp.id)).toEqual(['sp2']);
  });
});

describe('removeTable', () => {
  it('entfernt die Karte UND alle Verknüpfungen, an denen sie beteiligt ist', () => {
    let s = addTable(emptyState(), { x: 0, y: 0 }, 'tb1');
    s = addTable(s, { x: 100, y: 0 }, 'tb2');
    s = addLink(s, 'tb1', 'tb2', 'l1');
    s = removeTable(s, 'tb1');
    expect(findTable(s, 'tb1')).toBeUndefined();
    expect(s.links).toEqual([]);
  });
});

describe('findeObjekt/changeLayerId: Zeilen sind KEINE eigenständigen Objekte', () => {
  it('findeObjekt löst die Tabellen-id auf, eine Zeilen-id NICHT', () => {
    const s = addTable(emptyState(), { x: 0, y: 0 }, 'tb1');
    const rowId = s.tables![0].rows[0].id;
    expect(findeObjekt(s, 'tb1')?.art).toBe('tables');
    expect(findeObjekt(s, rowId)).toBeUndefined();
  });

  it('changeLayerId schlägt auf einer Zeilen-id fehl und gelingt auf der Tabellen-id', () => {
    const s = addTable(emptyState(), { x: 0, y: 0 }, 'tb1');
    const rowId = s.tables![0].rows[0].id;
    expect(() => changeLayerId(s, rowId, 'kanzlei')).toThrow(/Unbekanntes Objekt/);
    const neu = changeLayerId(s, 'tb1', 'kanzlei');
    expect(findTable(neu, 'tb1')?.layerId).toBe('kanzlei');
  });
});

describe('trashObject/restoreObject für tables', () => {
  it('legt einen TrashedItem mit kind table an; restoreObject bringt die Karte samt Zeilen zurück', () => {
    let s = addTable(emptyState(), { x: 0, y: 0 }, 'tb1');
    s = renameTable(s, 'tb1', 'Forderungsaufstellung');
    s = addTableRow(s, 'tb1', 'r2');
    s = trashObject(s, 'tb1', '2026-08-07T00:00:00.000Z', 't1');
    expect(findTable(s, 'tb1')).toBeUndefined();
    expect(s.trash?.[0]).toMatchObject({ id: 't1', kind: 'table', name: 'Forderungsaufstellung' });
    s = restoreObject(s, 't1');
    expect(findTable(s, 'tb1')?.rows).toHaveLength(2);
  });
});

describe('isValidState mit tables', () => {
  it('akzeptiert einen Zustand ohne tables-Schlüssel', () => {
    const s = emptyState();
    delete (s as { tables?: unknown }).tables;
    expect(isValidState(s)).toBe(true);
  });

  it('lehnt tables: "x" ab', () => {
    const s = { ...emptyState(), tables: 'x' as unknown };
    expect(isValidState(s)).toBe(false);
  });
});

describe('applyCommand: addTableFormulaColumn mit unbekannter Formelart', () => {
  it('wirft CommandError und lässt den Zustand unverändert', () => {
    const s = applyCommand(emptyState(), { type: 'addTable', payload: { position: { x: 0, y: 0 }, id: 'tb1' } });
    expect(() => applyCommand(s, {
      type: 'addTableFormulaColumn',
      payload: { tableId: 'tb1', titel: 'X', formel: 'wurzelziehen' },
    })).toThrow(CommandError);
    expect(findTable(s, 'tb1')?.spalten).toEqual([]);
  });
});

describe('applyCommand: der volle Tabellen-Command-Pfad', () => {
  it('addTable/addTableRow/setTableCell/addTableColumn/addTableFormulaColumn/removeTableColumn/removeTable über applyCommand', () => {
    let s = applyCommand(emptyState(), { type: 'addTable', payload: { position: { x: 0, y: 0 }, id: 'tb1' } });
    s = applyCommand(s, { type: 'addTableRow', payload: { tableId: 'tb1', id: 'r2' } });
    s = applyCommand(s, { type: 'addTableColumn', payload: { tableId: 'tb1', titel: 'Betrag', art: 'zahl', id: 'sp1' } });
    s = applyCommand(s, { type: 'setTableCell', payload: { tableId: 'tb1', rowId: 'r2', spaltenId: 'sp1', wert: '5,00' } });
    expect(findTable(s, 'tb1')?.rows.find((r) => r.id === 'r2')?.zellen).toEqual({ sp1: '5,00' });
    s = applyCommand(s, { type: 'addTableFormulaColumn', payload: { tableId: 'tb1', titel: 'Summe', formel: 'summe', quelleSpalteId: 'sp1', id: 'formelSp' } });
    expect(findTable(s, 'tb1')?.spalten).toHaveLength(2);
    s = applyCommand(s, { type: 'removeTableColumn', payload: { tableId: 'tb1', spaltenId: 'formelSp' } });
    expect(findTable(s, 'tb1')?.spalten.map((sp) => sp.id)).toEqual(['sp1']);
    s = applyCommand(s, { type: 'removeTable', payload: { id: 'tb1' } });
    expect(findTable(s, 'tb1')).toBeUndefined();
  });
});

describe('tableBox', () => {
  it('liefert die Bestands-Kartenmaße im geschlossenen Zustand und die Vorgabemaße/openSize im geöffneten', () => {
    let s = addTable(emptyState(), { x: 3, y: 4 }, 'tb1');
    expect(tableBox(findTable(s, 'tb1')!)).toEqual({ x: 3, y: 4, w: 180, h: 240 });
    s = expandTable(s, 'tb1');
    expect(tableBox(findTable(s, 'tb1')!)).toEqual({ x: 3, y: 4, w: TABELLE_OPEN_W, h: TABELLE_OPEN_H });
  });
});

describe('berechneFormelSpalte', () => {
  function tabelle(spalten: TableColumn[], rows: { id: string; zellen: Record<string, string> }[]): TableCard {
    return { id: 'tb1', titel: 'Test', spalten, rows, position: { x: 0, y: 0 }, zIndex: 1 };
  }

  it('summe: summiert eine Geldspalte über alle Zeilen', () => {
    const t = tabelle(
      [{ id: 'sp1', titel: 'Summe', art: 'formel', formel: 'summe', quelleSpalteId: 'geld' }],
      [
        { id: 'r1', zellen: { geld: '10,00' } },
        { id: 'r2', zellen: { geld: '20,00' } },
        { id: 'r3', zellen: { geld: '30,00' } },
      ],
    );
    expect(berechneFormelSpalte(t, t.spalten[0])).toBe(6000);
  });

  it('summe: eine nicht interpretierbare Zelle wird übersprungen statt das Ergebnis auf undefined zu ziehen', () => {
    const t = tabelle(
      [{ id: 'sp1', titel: 'Summe', art: 'formel', formel: 'summe', quelleSpalteId: 'geld' }],
      [
        { id: 'r1', zellen: { geld: '10,00' } },
        { id: 'r2', zellen: { geld: 'nicht lesbar' } },
        { id: 'r3', zellen: { geld: '20,00' } },
      ],
    );
    expect(berechneFormelSpalte(t, t.spalten[0])).toBe(3000);
  });

  it('datumsdifferenz: Differenz zwischen erster und letzter Zeile der Quellspalte', () => {
    const t = tabelle(
      [{ id: 'sp1', titel: 'Frist', art: 'formel', formel: 'datumsdifferenz', quelleSpalteId: 'datum' }],
      [
        { id: 'r1', zellen: { datum: '2026-01-01' } },
        { id: 'r2', zellen: { datum: '2026-01-06' } },
        { id: 'r3', zellen: { datum: '2026-01-11' } },
      ],
    );
    expect(berechneFormelSpalte(t, t.spalten[0])).toBe(10);
  });

  it('zinsen: liest Kapital aus der ersten Zeile, Satz und Tage aus parameter', () => {
    const t = tabelle(
      [{ id: 'sp1', titel: 'Zinsen', art: 'formel', formel: 'zinsen', quelleSpalteId: 'geld', parameter: { zinssatzProzent: 5, tage: 365 } }],
      [{ id: 'r1', zellen: { geld: '1.000,00' } }],
    );
    expect(berechneFormelSpalte(t, t.spalten[0])).toBe(5000);
  });

  it('wiederkehrende-zahlung: liest Betrag aus der ersten Zeile, Anzahl aus parameter', () => {
    const t = tabelle(
      [{ id: 'sp1', titel: 'Miete', art: 'formel', formel: 'wiederkehrende-zahlung', quelleSpalteId: 'geld', parameter: { anzahl: 12 } }],
      [{ id: 'r1', zellen: { geld: '500,00' } }],
    );
    expect(berechneFormelSpalte(t, t.spalten[0])).toBe(600_000);
  });

  it('eine Tabelle ohne Zeilen liefert 0 für die Summe und undefined für die übrigen drei Arten', () => {
    const spalten: TableColumn[] = [
      { id: 'sp1', titel: 'Summe', art: 'formel', formel: 'summe', quelleSpalteId: 'geld' },
      { id: 'sp2', titel: 'Frist', art: 'formel', formel: 'datumsdifferenz', quelleSpalteId: 'datum' },
      { id: 'sp3', titel: 'Zinsen', art: 'formel', formel: 'zinsen', quelleSpalteId: 'geld', parameter: { zinssatzProzent: 5, tage: 30 } },
      { id: 'sp4', titel: 'Miete', art: 'formel', formel: 'wiederkehrende-zahlung', quelleSpalteId: 'geld', parameter: { anzahl: 3 } },
    ];
    const t = tabelle(spalten, []);
    expect(berechneFormelSpalte(t, spalten[0])).toBe(0);
    expect(berechneFormelSpalte(t, spalten[1])).toBeUndefined();
    expect(berechneFormelSpalte(t, spalten[2])).toBeUndefined();
    expect(berechneFormelSpalte(t, spalten[3])).toBeUndefined();
  });

  it('eine Formelspalte, deren Quellspalte nicht existiert (keine quelleSpalteId konfiguriert), liefert undefined statt zu werfen', () => {
    const t = tabelle(
      [{ id: 'sp1', titel: 'Summe', art: 'formel', formel: 'summe' }],
      [{ id: 'r1', zellen: { geld: '10,00' } }],
    );
    expect(berechneFormelSpalte(t, t.spalten[0])).toBeUndefined();
  });
});

describe('Forderungsaufstellung und Zinsrechnung: Ende-zu-Ende gegen hartkodierte Cent-Werte (CALC-01)', () => {
  it('Forderungsaufstellung mit fünf Geldzeilen liefert exakt den handgerechneten Cent-Gesamtbetrag', () => {
    let s = addTable(emptyState(), { x: 0, y: 0 }, 'tb1');
    const platzhalterId = s.tables![0].rows[0].id;
    s = setTableCell(s, 'tb1', platzhalterId, 'geld', '111,11');
    s = addTableRow(s, 'tb1', 'r2');
    s = setTableCell(s, 'tb1', 'r2', 'geld', '222,22');
    s = addTableRow(s, 'tb1', 'r3');
    s = setTableCell(s, 'tb1', 'r3', 'geld', '333,33');
    s = addTableRow(s, 'tb1', 'r4');
    s = setTableCell(s, 'tb1', 'r4', 'geld', '10,00');
    s = addTableRow(s, 'tb1', 'r5');
    s = setTableCell(s, 'tb1', 'r5', 'geld', '20,00');
    s = addTableFormulaColumn(s, 'tb1', 'Gesamt', 'summe', 'geld', undefined, 'summeSp');
    const table = findTable(s, 'tb1')!;
    const spalte = table.spalten.find((sp) => sp.id === 'summeSp')!;
    // Handrechnung: 111,11 + 222,22 + 333,33 + 10,00 + 20,00 = 696,66 € = 69666 Cent
    expect(berechneFormelSpalte(table, spalte)).toBe(69_666);
  });

  it('Zinsrechnung über Kapital, Satz und einer Datumsdifferenz-Spalte liefert den handgerechneten Cent-Wert', () => {
    let s = addTable(emptyState(), { x: 0, y: 0 }, 'tb1');
    const platzhalterId = s.tables![0].rows[0].id;
    s = setTableCell(s, 'tb1', platzhalterId, 'kapital', '2.500,00');
    s = setTableCell(s, 'tb1', platzhalterId, 'fristbeginn', '2026-01-01');
    s = addTableRow(s, 'tb1', 'r2');
    s = setTableCell(s, 'tb1', 'r2', 'fristbeginn', '2026-04-01');
    // Datumsdifferenz-Spalte: 01.01. bis 01.04.2026 = 31 (Jan) + 28 (Feb) + 31 (Mär) = 90 Tage.
    s = addTableFormulaColumn(s, 'tb1', 'Fristdauer', 'datumsdifferenz', 'fristbeginn', undefined, 'fristSp');
    const tageErgebnis = berechneFormelSpalte(findTable(s, 'tb1')!, findTable(s, 'tb1')!.spalten[0]);
    expect(tageErgebnis).toBe(90);

    // Handrechnung: 2500 € * 4,5 % * 90 Tage / 365 Tage = 27,74 € (kaufmännisch gerundet) = 2774 Cent
    s = addTableFormulaColumn(s, 'tb1', 'Zinsen', 'zinsen', 'kapital', { zinssatzProzent: 4.5, tage: tageErgebnis! }, 'zinsSp');
    const table = findTable(s, 'tb1')!;
    const spalte = table.spalten.find((sp) => sp.id === 'zinsSp')!;
    expect(berechneFormelSpalte(table, spalte)).toBe(2774);
  });
});

describe('Quellprüfung: TableCard/TableRow tragen kein Formelergebnis-Feld', () => {
  it('tables.ts enthält keinen Setter für ein Ergebnisfeld und die Interfaces tragen keins', () => {
    const pfad = fileURLToPath(new URL('./tables.ts', import.meta.url));
    const quelle = readFileSync(pfad, 'utf-8');
    expect(quelle).not.toMatch(/ergebnis(Cents)?\s*[:?]/i);
    expect(quelle).not.toMatch(/setTableFormula(Ergebnis|Result)/i);
  });
});
