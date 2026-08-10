import type { Rolle } from '@j-desk/core';
import { darfAktionClient, desktop } from './store.svelte';
import { ApiError } from './api';
import { showToast, toast403, type Toast403Fall } from './ui.svelte';

/** Sichtbarkeit der DeskSwitcher-Aktionen „Arbeitsstand exportieren/importieren…" und
 *  „Löschen…" pro Rolle (PERM-04, Verifier-Gap 2 / 02-10). Komfort-Ausblenden, KEINE
 *  Sicherheitsgrenze (T-02-10-01): die Server-Guards (requireDeskAktion 'export'/'delete',
 *  requireDeskRolle Bearbeiter-aufwärts für Import) bleiben die Wahrheit und erzwingen
 *  die Rolle unabhängig — hier wird nur entschieden, ob der Eintrag überhaupt gerendert
 *  wird („ausgeblendet, nicht ausgegraut"). `null` (jl-Modus/Rolle unbekannt) bleibt per
 *  Bestandskonvention erlaubt. */
export function deskAktionenFuerRolle(rolle: Rolle | null): { export: boolean; import: boolean; loeschen: boolean } {
  return {
    export: darfAktionClient(rolle, 'export'),
    // Der Server erzwingt den Import als Bearbeiter-aufwärts per requireDeskRolle;
    // 'manage' ist der PERM-04-Matrix-Eintrag mit exakt dieser Rollengruppe
    // (Eigentümer+Bearbeiter) — kein semantischer Eigenbau, nur die bestehende Matrix.
    import: darfAktionClient(rolle, 'manage'),
    loeschen: darfAktionClient(rolle, 'delete'),
  };
}

/** Zuordnung Desk-Aktion → toast403-Fall für den 403-Fehlerpfad (WR-05-Konvention:
 *  toast403 für Routen ohne eigenen Fehlertext). Die Export-/Import-Routen liefern nur
 *  den generischen Guard-Text, darum setzt die UI hier bewusst den rollen-interpolierten
 *  allgemeinen Wortlaut; Desk-Löschen hat einen eigenen Copywriting-Contract-Text.
 *  Achtung Spiegelstelle: store.svelte.ts deleteDesk() nutzt denselben 'loeschen'-Fall
 *  als Literal (kein Import von hier — store ↔ deskAktionen wäre zirkulär). */
export function toast403FallFuerDeskAktion(aktion: 'export' | 'import' | 'loeschen'): Toast403Fall {
  return aktion === 'loeschen' ? 'loeschen' : 'allgemein';
}

/**
 * Deviation (Rule 3 — blocking): „Arbeitsstand exportieren…" braucht denselben Ausführungspfad
 * in DeskSwitcher.svelte (Task-Dateiliste) UND in CommandPalette.svelte (13-09) — ein zweiter
 * Ausführungspfad wäre eine zweite Wahrheit (must_haves key_links). `exportieren()` lag bisher
 * als lokale Funktion in DeskSwitcher.svelte's Instanz-Script (nicht importierbar ohne
 * `<script module>`); extrahiert nach deskAktionen.ts, wortgleiches Verhalten (Blob-Download,
 * 403-Fallback über denselben toast403FallFuerDeskAktion-Fall wie zuvor).
 */
export async function exportAktuellenDesk(deskId: string, name: string): Promise<void> {
  let url: string | undefined;
  try {
    const blob = await desktop.api!.exportDesk(deskId);
    url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name.replace(/[/\\:*?"<>|]/g, '-')}.jdesk`;
    a.click();
  } catch (e) {
    if (e instanceof ApiError && e.status === 403) toast403(toast403FallFuerDeskAktion('export'), desktop.currentRolle);
    else showToast(e instanceof Error ? e.message : 'Der Export ist fehlgeschlagen.');
  } finally {
    if (url) URL.revokeObjectURL(url);
  }
}

/**
 * Diagnosepaket-Export (OPS-02/OPS-05, 14-06): Bestandsmuster wie exportAktuellenDesk() oben
 * (Objekt-URL, Klick, Freigabe im Abschlusszweig, gesonderte 403-Behandlung). Der Dateiname
 * trägt einen Zeitstempel, KEINEN Schreibtischnamen — das Paket ist instanzweit, nicht
 * schreibtischbezogen (14-UI-SPEC.md Komponentenkontrakt). Erfolg/Fehlschlag melden sich über
 * die vorhandenen Kurzmeldungen, exakt nach Copywriting Contract.
 */
export async function exportiereDiagnosepaket(deskId: string): Promise<void> {
  let url: string | undefined;
  try {
    const blob = await desktop.api!.getDiagnosepaket(deskId);
    url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    a.download = `j-desk-diagnosepaket-${stamp}.json`;
    a.click();
    showToast('Diagnosepaket heruntergeladen.');
  } catch (e) {
    if (e instanceof ApiError && e.status === 403) toast403('allgemein', desktop.currentRolle);
    else showToast(`Diagnosepaket konnte nicht erstellt werden. ${e instanceof Error ? e.message : 'Unbekannter Fehler'}`);
  } finally {
    if (url) URL.revokeObjectURL(url);
  }
}
