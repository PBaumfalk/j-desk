import type { Viewport } from '@j-desk/core';

/**
 * Positions-Verlauf (UX-03, 13-05 Task 1): reiner, DOM-freier Ringpuffer nach dem Muster
 * `ui.highlightedIds` (ui.svelte.ts) — Sitzungskomfort ohne Kommandopfad, kann serverseitig nicht
 * fehlschlagen (Pattern 5, 13-RESEARCH.md). Liegt bewusst außerhalb von `ui.svelte.ts`, damit die
 * Ring-/Zeiger-Logik ohne Runen-Kontext getestet werden kann (Muster `views.ts`/`jump.ts`).
 *
 * Bewusste Abgrenzung (UI-SPEC/Copywriting Contract): der Verlauf ist Sitzungskomfort, KEIN
 * Prüfpfad — die auditierbare Historie bleibt die Aktivitätsansicht aus Phase 4. Einträge
 * entstehen NUR bei Sprüngen (Fundstelle/Ansicht/Zone/Minikarte), NIE bei freiem Pannen/Zoomen
 * (Lärm-Regel auch im Verlauf).
 */

export type VerlaufAusloeser = 'fundstelle' | 'ansicht' | 'zone' | 'minikarte';

export interface VerlaufEintrag {
  vp: Viewport;
  ausloeser: VerlaufAusloeser;
  label: string;
}

/** Ringpuffer-Obergrenze (UI-SPEC E5/overflow): der 21. Eintrag verdrängt den ältesten. Die
 *  Palette (13-04) zeigt nur die letzten 10 — die Kappung hier bleibt bei 20, damit ein paar
 *  Schritte zurück/vor über den sichtbaren Palette-Ausschnitt hinaus möglich bleiben. */
export const VERLAUF_MAX = 20;

/** `zeiger` ist der Index des aktuell „betrachteten" Eintrags in `eintraege` (0..length-1) — nach
 *  jeder Aufzeichnung zeigt er auf den soeben angehängten (neuesten) Eintrag. Bei leerem Verlauf
 *  ist der Wert bedeutungslos (Anfangswert 0, ui.svelte.ts-Vorgabe); zurueck()/vor() bleiben auf
 *  einem leeren Puffer sichere No-Ops. */
export interface VerlaufState {
  eintraege: VerlaufEintrag[];
  zeiger: number;
}

/**
 * Zeichnet einen neuen Sprung auf: hängt an, kappt den Ring bei VERLAUF_MAX und verwirft dabei die
 * „Vorwärts-Zukunft" (Standard-Verlaufssemantik, wie Browser-Historie) — ist der Zeiger nach einem
 * zurueck()-Schritt nicht mehr am aktuellen Rand, fallen alle danach liegenden Einträge weg, bevor
 * der neue Eintrag angehängt wird. Immutable: `verlauf` bleibt unverändert.
 */
export function aufzeichnen(verlauf: VerlaufState, eintrag: VerlaufEintrag): VerlaufState {
  const amRand = verlauf.eintraege.length === 0 || verlauf.zeiger >= verlauf.eintraege.length - 1;
  const sichtbar = amRand ? verlauf.eintraege : verlauf.eintraege.slice(0, verlauf.zeiger + 1);
  const erweitert = [...sichtbar, eintrag];
  const eintraege = erweitert.length > VERLAUF_MAX ? erweitert.slice(erweitert.length - VERLAUF_MAX) : erweitert;
  return { eintraege, zeiger: eintraege.length - 1 };
}

/** Bewegt den Zeiger einen Schritt zurück (ältere Einträge); am Anfang ein No-Op (identisches
 *  Objekt zurück, damit Aufrufer eine Bewegung per Referenz-/Zeiger-Vergleich erkennen können). */
export function zurueck(verlauf: VerlaufState): VerlaufState {
  if (verlauf.eintraege.length === 0 || verlauf.zeiger <= 0) return verlauf;
  return { ...verlauf, zeiger: verlauf.zeiger - 1 };
}

/** Bewegt den Zeiger einen Schritt vor (neuere Einträge); am aktuellen Rand ein No-Op. */
export function vor(verlauf: VerlaufState): VerlaufState {
  if (verlauf.eintraege.length === 0 || verlauf.zeiger >= verlauf.eintraege.length - 1) return verlauf;
  return { ...verlauf, zeiger: verlauf.zeiger + 1 };
}

/** Eingabeform für labelFuer — eine der vier im Copywriting Contract fixierten Auslöser-Formen. */
export type VerlaufLabelEingabe =
  | { ausloeser: 'fundstelle'; dokument: string; seite: number }
  | { ausloeser: 'ansicht'; name: string }
  | { ausloeser: 'zone'; name: string }
  | { ausloeser: 'minikarte' };

/** Formt die vier fixierten Label-Formen aus dem Copywriting Contract (13-UI-SPEC.md) — der
 *  einzige Ort, an dem diese Wortlaute entstehen; jeder Aufrufer (jump.ts, ViewSwitcher.svelte,
 *  ZonenOverlay.svelte, Minimap.svelte) übergibt nur seine ausloeser-spezifischen Rohdaten. */
export function labelFuer(eingabe: VerlaufLabelEingabe): string {
  switch (eingabe.ausloeser) {
    case 'fundstelle':
      return `Fundstelle: ${eingabe.dokument}, Seite ${eingabe.seite}`;
    case 'ansicht':
      return `Ansicht: ${eingabe.name}`;
    case 'zone':
      return `Zone: ${eingabe.name}`;
    case 'minikarte':
      return 'Minikarte-Sprung';
  }
}
