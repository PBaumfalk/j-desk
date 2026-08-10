import { describe, expect, it } from 'vitest';
import { ALLE_ROLLEN, type Rolle } from '@j-desk/core';
import { deskAktionenFuerRolle, toast403FallFuerDeskAktion } from './deskAktionen';

/** Erwartete Sichtbarkeits-Matrix (PERM-04, Verifier-Gap 2 / 02-10): Export → 'export'
 *  (Eigentümer+Bearbeiter), Import → Bearbeiter-aufwärts (Server: requireDeskRolle,
 *  Matrix-Eintrag 'manage'), Löschen → 'delete' (nur Eigentümer). `null` (jl-Modus/
 *  unbekannt) bleibt per Bestandskonvention erlaubt — der Server bleibt die Wahrheit. */
const ERWARTET: Record<Rolle | 'null', { export: boolean; import: boolean; loeschen: boolean }> = {
  'Eigentümer':    { export: true,  import: true,  loeschen: true },
  'Bearbeiter':    { export: true,  import: true,  loeschen: false },
  'Kommentator':   { export: false, import: false, loeschen: false },
  'Nur-Lesen':     { export: false, import: false, loeschen: false },
  'externer Gast': { export: false, import: false, loeschen: false },
  'null':          { export: true,  import: true,  loeschen: true },
};

describe('deskAktionenFuerRolle (PERM-04, 02-10): Sichtbarkeit der DeskSwitcher-Aktionen', () => {
  it('export: nur Eigentümer/Bearbeiter (und null = jl-Modus/unbekannt)', () => {
    expect(deskAktionenFuerRolle('Eigentümer').export).toBe(true);
    expect(deskAktionenFuerRolle('Bearbeiter').export).toBe(true);
    expect(deskAktionenFuerRolle('Kommentator').export).toBe(false);
    expect(deskAktionenFuerRolle('Nur-Lesen').export).toBe(false);
    expect(deskAktionenFuerRolle('externer Gast').export).toBe(false);
    expect(deskAktionenFuerRolle(null).export).toBe(true);
  });

  it('import: nur Bearbeiter-aufwärts (und null) — spiegelt requireDeskRolle des Servers', () => {
    expect(deskAktionenFuerRolle('Eigentümer').import).toBe(true);
    expect(deskAktionenFuerRolle('Bearbeiter').import).toBe(true);
    expect(deskAktionenFuerRolle('Kommentator').import).toBe(false);
    expect(deskAktionenFuerRolle('Nur-Lesen').import).toBe(false);
    expect(deskAktionenFuerRolle('externer Gast').import).toBe(false);
    expect(deskAktionenFuerRolle(null).import).toBe(true);
  });

  it('loeschen: nur der Eigentümer (und null)', () => {
    expect(deskAktionenFuerRolle('Eigentümer').loeschen).toBe(true);
    expect(deskAktionenFuerRolle('Bearbeiter').loeschen).toBe(false);
    expect(deskAktionenFuerRolle('Kommentator').loeschen).toBe(false);
    expect(deskAktionenFuerRolle('Nur-Lesen').loeschen).toBe(false);
    expect(deskAktionenFuerRolle('externer Gast').loeschen).toBe(false);
    expect(deskAktionenFuerRolle(null).loeschen).toBe(true);
  });

  it('deckt die Matrix vollständig ab: jede Rolle × jede Aktion ist boolean (kein „ausgegraut")', () => {
    for (const rolle of [...ALLE_ROLLEN, null] as const) {
      const a = deskAktionenFuerRolle(rolle);
      expect(Object.keys(a).sort()).toEqual(['export', 'import', 'loeschen']);
      const erwartet = ERWARTET[rolle ?? 'null'];
      expect(a.export, `${rolle}/export`).toBe(erwartet.export);
      expect(a.import, `${rolle}/import`).toBe(erwartet.import);
      expect(a.loeschen, `${rolle}/loeschen`).toBe(erwartet.loeschen);
    }
  });

  it('ist rein: gleiche Eingabe → gleiche Ausgabe, ohne Seiteneffekte', () => {
    const a = deskAktionenFuerRolle('Kommentator');
    const b = deskAktionenFuerRolle('Kommentator');
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(deskAktionenFuerRolle('Kommentator')).toEqual({ export: false, import: false, loeschen: false });
  });
});

describe('toast403FallFuerDeskAktion (02-10 Task 2): 403-Zuordnung der Desk-Aktionen (WR-05)', () => {
  it('bildet loeschen auf den eigenen Lösch-Wortlaut ab, export/import auf den allgemeinen Fallback', () => {
    expect(toast403FallFuerDeskAktion('loeschen')).toBe('loeschen');
    expect(toast403FallFuerDeskAktion('export')).toBe('allgemein');
    expect(toast403FallFuerDeskAktion('import')).toBe('allgemein');
  });
});
