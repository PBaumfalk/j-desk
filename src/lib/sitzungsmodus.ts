import { ui } from './ui.svelte';

/**
 * Verschiebe-Sperre (SESS-01): reine Prädikatsfunktion ohne DOM-/window-Zugriff — unter Vitest
 * `environment: 'node'` unmittelbar testbar. `kartenBewegungGesperrt()` (Task 2) liest die beiden
 * `ui`-Felder und ruft diese Funktion mit deren aktuellen Werten auf.
 */
export function bewegungGesperrt(sitzungsmodusAktiv: boolean, verschiebeSperreAktiv: boolean): boolean {
  return sitzungsmodusAktiv && verschiebeSperreAktiv;
}

/** Ein-Zeilen-Leser über `bewegungGesperrt()` mit den aktuellen `ui`-Feldern — der Aufruf, den
 *  jeder Pan-/Zoom-/Drop-Handler in Desktop.svelte als allererste Zeile einzieht (11-01 Task 2). */
export function kartenBewegungGesperrt(): boolean {
  return bewegungGesperrt(ui.sitzungsmodusAktiv, ui.verschiebeSperreAktiv);
}

/** Schaltet die Verschiebe-Sperre um (🔒/🔓-Umschalter in SitzungsmodusShell.svelte). */
export function schalteVerschiebeSperre(): void {
  ui.verschiebeSperreAktiv = !ui.verschiebeSperreAktiv;
}

/**
 * SESS-01/E3-error: ein `fullscreenchange`, das die Sitzung ohne den „✕ Sitzung beenden"-Button
 * verlässt (Escape/OS-Geste), muss den Sitzungsmodus ebenso zuverlässig schließen — sonst bliebe
 * die Chrome hängen, ohne dass echtes Vollbild besteht. Nur TRUE, wenn die Sitzung zuvor
 * tatsächlich im Vollbild lief UND das Vollbild gerade verlassen wurde: ein Fail-open-Start ohne
 * Vollbild (requestFullscreen() abgelehnt/nicht verfügbar) beendet die Sitzung dadurch NICHT
 * sofort selbst.
 */
export function sitzungBeendenBeiVollbildwechsel(warImVollbild: boolean, imVollbild: boolean): boolean {
  return warImVollbild && !imVollbild;
}

/**
 * Startet den Sitzungsmodus: setzt die aktive Sitzungsmappe-id und den Vollbild-Chrome-Zustand,
 * versucht danach best-effort echtes Vollbild (Fail-open, UI-SPEC: eine abgelehnte oder fehlende
 * Fullscreen-API bleibt folgenlos — kein Toast, kein Fehlertext, die Chrome läuft im normalen
 * Browser-Fenster weiter). Ein zweiter Aufruf bei bereits aktiver Sitzung tut nichts und liefert
 * `false` (SESS-01/idempotency).
 */
export async function starteSitzungsmodus(mappeId: string, el?: HTMLElement | null): Promise<boolean> {
  if (ui.sitzungsmodusAktiv) return false;
  ui.aktiveSitzungsmappeId = mappeId;
  ui.sitzungsmodusAktiv = true;
  try {
    await el?.requestFullscreen?.();
  } catch {
    // Fail-open (UI-SPEC „Fullscreen-API abgelehnt/nicht verfügbar"): kein Toast, kein Fehlertext.
  }
  return true;
}

/** Beendet den Sitzungsmodus — setzt die Felder zurück und verlässt best-effort ein echtes
 *  Vollbild (leeres catch: dieselbe Fail-open-Haltung wie beim Start). Jeder Zugriff auf
 *  `document` steht hinter `typeof document !== 'undefined'`, damit dieses Modul unter Vitest
 *  `environment: 'node'` importierbar und testbar bleibt. */
export function beendeSitzungsmodus(): void {
  ui.sitzungsmodusAktiv = false;
  ui.aktiveSitzungsmappeId = null;
  // 11-01 Task 2: eine neue Sitzung darf nicht mit der Verschiebe-Sperre der vorherigen starten.
  ui.verschiebeSperreAktiv = false;
  if (typeof document !== 'undefined' && document.fullscreenElement) {
    try {
      void document.exitFullscreen();
    } catch {
      // Best-Effort, s. o.
    }
  }
}
