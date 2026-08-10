/**
 * Pfeiltasten-Interpretation (UX-03, 13-05 Task 1): reine, DOM-freie Funktion nach dem Muster
 * von `views.ts`/`jump.ts` — testbar ohne Runen-Kontext (Vitest läuft mit `environment: 'node'`).
 *
 * Pflicht-Korrektur (13-RESEARCH.md Shortcut-Befund): der bestehende Pfeil-Pan-Handler in
 * Desktop.svelte (656-666, vor dieser Korrektur) prüfte KEINE Modifier — ⌥← hätte gleichzeitig
 * gepannt UND im Positions-Verlauf zurücknavigiert (Doppelfeuer-Kollision). Die UI-SPEC behauptet
 * fälschlich, der Pfeil-Handler reagiere „nur unmodifiziert" — das trifft gegen den Bestandscode
 * nicht zu. Diese Funktion ist der strukturelle Guard: sie entscheidet VOR jedem Pan/Verlaufs-
 * Sprung, welche (genau eine) Aktion ein Pfeildruck auslöst — modifizierte Pfeile erreichen den
 * Pan-Zweig im Aufrufer nie mehr.
 */

export type PfeilAktion =
  | 'pan-oben'
  | 'pan-unten'
  | 'pan-links'
  | 'pan-rechts'
  | 'verlauf-zurueck'
  | 'verlauf-vor'
  | null;

/** Minimalform eines KeyboardEvent — reicht für die Entscheidung, ohne DOM-Typen zu importieren. */
export interface PfeilEvent {
  code: string;
  altKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
}

export function pfeilAktion(e: PfeilEvent): PfeilAktion {
  // Guard: ⌘/Strg+Pfeil bleibt IMMER neutral — weder Pan noch Verlaufs-Sprung. Ohne diese Sperre
  // würde z. B. ⌘←+⌥ (Browser-„Zurück"-Konvention auf manchen Systemen) unbeabsichtigt in den
  // Tisch eingreifen.
  if (e.metaKey || e.ctrlKey) return null;

  if (e.altKey) {
    // ⌥← / ⌥→ (Positions-Verlauf) — der neue Zweig NACH dem Guard (UX-03).
    if (e.code === 'ArrowLeft') return 'verlauf-zurueck';
    if (e.code === 'ArrowRight') return 'verlauf-vor';
    // ⌥↑ / ⌥↓ belegen bewusst KEIN Bestandsverhalten (keine neue, unangekündigte Funktion).
    return null;
  }

  switch (e.code) {
    case 'ArrowUp':
      return 'pan-oben';
    case 'ArrowDown':
      return 'pan-unten';
    case 'ArrowLeft':
      return 'pan-links';
    case 'ArrowRight':
      return 'pan-rechts';
    default:
      return null;
  }
}
