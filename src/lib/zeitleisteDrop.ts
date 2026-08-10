import { ui, pointerUeberKorb, pointerUeberZeitleiste } from './ui.svelte';

/**
 * Abwurfziel eines gezogenen Objekts (Doc/Note/Cutout/LegalObject/Stack) beim Loslassen —
 * CHRONO-01, Plan 09-06. Reiner Helfer ohne Svelte-Abhängigkeit außer dem `ui`-Store und ohne
 * jeden Command-Aufruf: die Abwurfentscheidung selbst hat keine Seiteneffekte. Fünf
 * Kartenkomponenten rufen `abwurfZielFuer` auf, statt je eine eigene Trefferprüfung
 * mitzuführen — fünf Kopien derselben Entscheidung wären fünf Wahrheiten.
 */
export type AbwurfZiel =
  | { art: 'korb' }
  | { art: 'zeitleiste'; zeitleisteId: string }
  | { art: 'tisch' };

/**
 * Entscheidet beim Loslassen einer Karte, wohin sie fällt — fester Vorrang: zuerst der
 * Papierkorb (Wegwerfen ist die eindeutigere Absicht, außerdem ein ortsfestes, kleines Ziel),
 * dann eine geöffnete Zeitleiste, sonst der Tisch (09-06-PLAN.md Task 1, T-09-24).
 *
 * Zieht der Nutzer eine Zeitleiste über sich selbst (oder über eine andere Zeitleiste, die
 * zufällig dieselbe id trägt wie das gezogene Objekt), liefert diese Funktion bewusst das
 * Tischziel statt eines Selbsteintrags — eine Zeitleiste referenziert sich nie selbst.
 *
 * Nur GEÖFFNETE Zeitleisten tragen ein Rechteck in `ui.zeitleisteRects` ein
 * (ZeitleisteCard.svelte, Plan 09-01) — eine geschlossene Miniatur ist deshalb hier bereits
 * strukturell kein Ablageziel, ohne dass diese Funktion selbst zwischen offen/geschlossen
 * unterscheiden müsste. Diese Bedingung lebt bewusst NUR dort (wo das Rechteck gepflegt wird) —
 * nicht hier verdoppeln, sonst könnte eine künftige Änderung an `ZeitleisteCard.svelte` diese
 * Datei unbemerkt zurücklassen.
 */
export function abwurfZielFuer(clientX: number, clientY: number, gezogeneId: string): AbwurfZiel {
  if (pointerUeberKorb(clientX, clientY)) return { art: 'korb' };
  const zeitleisteId = pointerUeberZeitleiste(clientX, clientY);
  if (zeitleisteId && zeitleisteId !== gezogeneId) return { art: 'zeitleiste', zeitleisteId };
  return { art: 'tisch' };
}

/**
 * Setzt den Zeitleisten-Eintragsentwurf (Ziel-Zeitleiste + referenziertes Objekt) und räumt den
 * Zwei-Klick-Auswahlmodus `ui.zeitleisteEintragFuer` ab. Legt selbst KEINEN Eintrag an und
 * sendet KEIN Command — der Eintrag entsteht erst, wenn das Popover-Formular (Plan 09-05) den
 * Entwurf bestätigt. Ein abgebrochenes Formular hinterlässt deshalb nichts (T-09-26).
 */
export function starteZeitleisteEintrag(zeitleisteId: string, objRef: string): void {
  ui.zeitleisteEintragFuer = null;
  ui.zeitleisteEintragEntwurf = { zeitleisteId, objRef };
}
