import type { ApiClient, VorschlagDto } from './api';

/**
 * Clientseitiger Zustand der KI-Freigaben (Phase 12, AI-01, Plan 12-06): die einzige Quelle
 * für den Freigaben-Zähler — FreigabenSignal.svelte (dieser Plan) und der Dialog-CTA aus
 * Plan 12-07 lesen beide `zaehler`, deckungsgleich per Konstruktion.
 *
 * Aktualisierungs-Kette (einzige): WS-Signal 'vorschlaegeGeaendert' (inhaltsfrei) →
 * signalEmpfangen() → ladeVorschlaege() → GET /vorschlaege (projiziert). Kein Polling, kein
 * eigener Kanal; das Event wird NIE als Datenquelle konsumiert (Pitfall 3 — Vorschlagsinhalte
 * dürfen nie per WS pushbar sein, Broadcast-Leck-Bugklasse aec4f58/fcda808; auch ein Zähler im
 * Event wäre ein Andeutungs-Leck, T-12-06-01).
 *
 * Genehmigungen gehen bewusst NICHT durch offlineQueue.ts: eine Freigabe ist eine Prüfhandlung
 * gegen den aktuellen Serverstand (12-RESEARCH.md Anti-Pattern „Genehmigung durch die
 * Offline-Queue") — online-only mit klarem Fehler statt späterem stillen Nachspielen.
 */
export const freigaben = $state({
  vorschlaege: [] as VorschlagDto[],
  laden: false,
  fehler: null as string | null,
  /** Der zuletzt GESTARTETE Lade-Schritt (ActivityOverlay-Muster): „Erneut versuchen" ruft
   *  exakt denselben Schritt erneut auf, ohne die Argumente erneut kennen zu müssen. */
  letzterModus: null as (() => Promise<void>) | null,
  /** Scrollziel/Hervorhebung im VorschlaegeDialog (12-07): die EntwurfKarte setzt das Feld
   *  beim Öffnen des Dialogs; der Dialog scrollt nach dem Laden zur Karte und leert das Feld
   *  danach selbst — kein zweiter Kanal neben ui.vorschlaegeOffen. */
  fokussierterVorschlagId: null as string | null,
});

/** Wartende Vorschläge — interner $derived-Wert; Svelte 5 verbietet den direkten Export
 *  von Deriveds aus Modulen (derived_invalid_export), darum Funktions-Export unten
 *  (Präzedenz: anderePersonen() in presence.svelte.ts, Getter auf `desktop` in store.svelte.ts). */
const zaehlerWert = $derived(freigaben.vorschlaege.filter((v) => v.status === 'ausstehend').length);

/** E1/overflow (12-UI-SPEC): ab 100 wird „99+" gerendert, sonst die Zahl als String. */
const zaehlerTextWert = $derived(zaehlerWert > 99 ? '99+' : String(zaehlerWert));

/** Wartende Vorschläge — die einzige Zählerquelle (Status 'ausstehend'; entschiedene zählen nicht). */
export function zaehler(): number {
  return zaehlerWert;
}

/** Anzeigeform des Zählers („99+" ab 100) — gleiche Quelle wie zaehler(), deckungsgleich per Konstruktion. */
export function zaehlerText(): string {
  return zaehlerTextWert;
}

/**
 * WR-04: Lade-Generation gegen den Desk-Wechsel-Race (WR-02-Bugklasse). Jeder Ladevorgang
 * taggt sich mit der aktuellen Generation; eine Antwort, die nach einem Desk-Wechsel oder
 * einer Rücksetzung (Generation wurde weitergeschaltet) eintrifft, wird verworfen — sonst
 * überschreibt die ältere Antwort des ALTEN Desks die Liste des neuen und Zähler,
 * EntwurfKarten und Dialog zeigen Vorschläge (Zusammenfassungen, Zitate, Akteurnamen) des
 * alten Mandats.
 */
let ladeGeneration = 0;

/**
 * Lädt die projizierte Vorschlagsliste nach (einziger Ladepfad). Bei Erfolg ersetzt die
 * Antwort die Liste und leert `fehler`; bei Fehlschlag bleibt die bisherige Liste erhalten
 * und `fehler` trägt die Server-Meldung (WR-05) — der Schritt bleibt über `letzterModus`
 * für „Erneut versuchen" gemerkt. Wirft NIE nach außen (Hintergrund-Sync darf keine
 * Aufrufkette sprengen — Muster ladeOcrStatus in store.svelte.ts).
 */
export async function ladeVorschlaege(api: ApiClient, deskId: string): Promise<void> {
  const generation = ++ladeGeneration;
  freigaben.laden = true;
  freigaben.letzterModus = () => ladeVorschlaege(api, deskId);
  try {
    const { vorschlaege } = await api.listVorschlaege(deskId);
    if (generation !== ladeGeneration) return; // Desk inzwischen gewechselt/zurückgesetzt
    freigaben.vorschlaege = vorschlaege;
    freigaben.fehler = null;
  } catch (e) {
    if (generation !== ladeGeneration) return; // stale Fehlermeldung nicht übernehmen
    freigaben.fehler = e instanceof Error ? e.message : 'Vorschläge konnten nicht geladen werden';
  } finally {
    if (generation === ladeGeneration) freigaben.laden = false;
  }
}

/**
 * Reaktion auf das inhaltsfreie WS-Signal 'vorschlaegeGeaendert': AUSSCHLIESSLICH ein
 * REST-Nachladen (Pitfall 3). Das Event wird als reiner Trigger behandelt — es trägt weder
 * Zähler noch Inhalte (VORSCHLAG_SIGNAL, 12-03), und es werden hier auch keine Felder daraus
 * gelesen; bewusst nimmt die Signatur das Event nicht einmal entgegen.
 */
export function signalEmpfangen(api: ApiClient, deskId: string): Promise<void> {
  return ladeVorschlaege(api, deskId);
}

/**
 * Lokales Nachzeichnen einer (fremden oder eigenen) Entscheidung, bis das projizierte
 * Nachladen eintrifft (T-12-06-02): der Dialog (Plan 12-07) zeigt dann „Bereits übernommen/
 * abgelehnt von {Name}" statt einer stale Aktion anzubieten; der Zähler sinkt sofort.
 */
export function aktualisiereNachEntscheidung(
  vorschlagId: string,
  entscheidung: 'genehmigt' | 'abgelehnt',
  name: string,
): void {
  freigaben.vorschlaege = freigaben.vorschlaege.map((v) =>
    v.id === vorschlagId ? { ...v, status: entscheidung, decidedBy: name, decidedAt: Date.now() } : v,
  );
}

/** WR-02-Rücksetzung (T-12-06-03): der Vorschlagszustand gehört zum Desk/zur Sitzung und
 *  überlebt weder Schreibtischwechsel noch Abmeldung — Aufruf in BEIDEN Rücksetzblöcken
 *  (loadDesk()/stop() in store.svelte.ts). Schaltet zusätzlich die Lade-Generation weiter
 *  (WR-04): ein noch unterwegs gewesener Ladevorgang verwirft seine Antwort sofort. */
export function setzeFreigabenZurueck(): void {
  ladeGeneration++;
  freigaben.vorschlaege = [];
  freigaben.laden = false;
  freigaben.fehler = null;
  freigaben.letzterModus = null;
  freigaben.fokussierterVorschlagId = null;
}
