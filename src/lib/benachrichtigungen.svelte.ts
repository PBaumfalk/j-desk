import type { ApiClient, BenachrichtigungDto } from './api';
import { showToast } from './ui.svelte';
import { noteBox, legalObjectBox, type Box, type DesktopState } from '@j-desk/core';
import type { Fundstelle } from './jump';
import { zaehler } from './freigaben.svelte';

/**
 * Clientseitiger Zustand der Benachrichtigungs-Inbox (NOTIF-01, 13-01): die einzige
 * Quelle für Zeilen und Ungelesen-Zähler — BenachrichtigungenPanel.svelte (Button-Badge
 * und Liste) liest ausschließlich hier.
 *
 * Aktualisierungs-Kette (einzige): WS-Signal 'benachrichtigungenGeaendert' (inhaltsfrei,
 * BENACHRICHTIGUNG_SIGNAL) → signalEmpfangen() → ladeBenachrichtigungen() → GET
 * /benachrichtigungen (user-scoped). Kein Polling, kein eigener Kanal; das Event wird
 * NIE als Datenquelle konsumiert (Pitfall P2 — Inbox-Inhalte dürfen nie per WS pushbar
 * sein, Broadcast-Leck-Bugklasse aec4f58/fcda808; auch ein Zähler im Event wäre ein
 * Andeutungs-Leck, T-13-01-01).
 *
 * „Alle als gelesen markieren" geht bewusst NICHT durch offlineQueue.ts: es ist eine
 * zustandsbezogene Prüfhandlung gegen den aktuellen Serverstand, keine historische
 * Mutation (Anti-Pattern „Genehmigung durch die Offline-Queue", freigaben.svelte.ts) —
 * online-only mit klarem Toast-Fehler statt späterem stillen Nachspielen. Die einzelne
 * Zeilen-Lese-Markierung darf dagegen optimistisch wirken; ein Fehler dort wird beim
 * nächsten Laden korrigiert.
 */
export const benachrichtigungen = $state({
  zeilen: [] as BenachrichtigungDto[],
  laden: false,
  fehler: null as string | null,
  /** Der zuletzt GESTARTETE Lade-Schritt (freigaben-Muster): „Erneut versuchen" ruft
   *  exakt denselben Schritt erneut auf, ohne die Argumente erneut kennen zu müssen. */
  letzterModus: null as (() => Promise<void>) | null,
});

/** Ungelesene Zeilen — interner $derived-Wert; Svelte 5 verbietet den direkten Export
 *  von Deriveds aus Modulen (derived_invalid_export), darum Funktions-Export unten
 *  (Präzedenz: zaehler/zaehlerText in freigaben.svelte.ts). */
const ungelesenWert = $derived(benachrichtigungen.zeilen.filter((z) => z.read_at === null).length);

/** E10/zero-one-many (13-UI-SPEC): ab 100 wird „99+" gerendert, sonst die Zahl als String. */
const ungelesenTextWert = $derived(ungelesenWert > 99 ? '99+' : String(ungelesenWert));

/** Ungelesene Zeilen — die einzige Zählerquelle (read_at === null). */
export function ungelesen(): number {
  return ungelesenWert;
}

/** Anzeigeform des Zählers („99+" ab 100) — gleiche Quelle wie ungelesen(), deckungsgleich per Konstruktion. */
export function ungelesenText(): string {
  return ungelesenTextWert;
}

/**
 * WR-04: Lade-Generation gegen den Desk-Wechsel-Race (freigaben-Muster). Jeder Ladevorgang
 * taggt sich mit der aktuellen Generation; eine Antwort, die nach einem Desk-Wechsel oder
 * einer Rücksetzung eintrifft, wird verworfen — sonst überschreibt die ältere Antwort die
 * Inbox des neuen Kontexts (Mandatsinhalt: Nutzernamen, Notiztitel).
 */
let ladeGeneration = 0;

/**
 * Lädt die eigene Inbox nach (einziger Ladepfad, user-scoped — ohne deskId: die Routen
 * kennen keinen Desk-Kontext, Nutzerhoheit). Bei Erfolg ersetzt die Antwort die Liste und
 * leert `fehler`; bei Fehlschlag bleibt die bisherige Liste erhalten (E10/error: letzter
 * bekannter Stand) und `fehler` trägt die Server-Meldung (WR-05). Wirft NIE nach außen
 * (Hintergrund-Sync darf keine Aufrufkette sprengen — Muster ladeVorschlaege).
 */
export async function ladeBenachrichtigungen(api: ApiClient): Promise<void> {
  const generation = ++ladeGeneration;
  benachrichtigungen.laden = true;
  benachrichtigungen.letzterModus = () => ladeBenachrichtigungen(api);
  try {
    const { benachrichtigungen: zeilen } = await api.listBenachrichtigungen();
    if (generation !== ladeGeneration) return; // Desk inzwischen gewechselt/zurückgesetzt
    benachrichtigungen.zeilen = zeilen;
    benachrichtigungen.fehler = null;
  } catch (e) {
    if (generation !== ladeGeneration) return; // stale Fehlermeldung nicht übernehmen
    benachrichtigungen.fehler = e instanceof Error ? e.message : 'Benachrichtigungen konnten nicht geladen werden';
  } finally {
    if (generation === ladeGeneration) benachrichtigungen.laden = false;
  }
}

/**
 * Reaktion auf das inhaltsfreie WS-Signal 'benachrichtigungenGeaendert': AUSSCHLIESSLICH
 * ein REST-Nachladen (Pitfall P2). Das Event wird als reiner Trigger behandelt — es trägt
 * weder Zähler noch Inhalte, und es werden hier auch keine Felder daraus gelesen;
 * bewusst nimmt die Signatur das Event nicht einmal entgegen.
 */
export function signalEmpfangen(api: ApiClient): Promise<void> {
  return ladeBenachrichtigungen(api);
}

/**
 * Einzelne Zeile als gelesen markieren — optimistisch (die Zeile kippt sofort um), die
 * API bestätigt hinterher. Ein API-Fehler wirft NICHT nach außen (Toast-Pfad, WR-05):
 * der nächste Ladevorgang (WS-Signal, Desk-Laden) korrigiert den Stand vom Server.
 */
export async function markiereGelesen(api: ApiClient, id: string): Promise<void> {
  benachrichtigungen.zeilen = benachrichtigungen.zeilen.map((z) =>
    z.id === id && z.read_at === null ? { ...z, read_at: Date.now() } : z,
  );
  try {
    await api.markiereBenachrichtigungGelesen(id);
  } catch (e) {
    showToast(e instanceof Error ? e.message : 'Lesen konnte nicht markiert werden');
  }
}

/**
 * „Alle als gelesen markieren" — ONLINE-ONLY mit klarem Fehler (zustandsbezogen, nicht
 * historisch): kein Eintrag in die Offline-Queue, kein stilles Nachspielen. Erst nach
 * der Server-Bestätigung kippen die Zeilen um (kein Optimismus im Erfolgsweg dieser
 * Sammelaktion — der Zähler ist das einzige Signal und darf nie lügen).
 */
export async function markiereAlleGelesen(api: ApiClient): Promise<void> {
  try {
    await api.markiereAlleBenachrichtigungenGelesen();
    const jetzt = Date.now();
    benachrichtigungen.zeilen = benachrichtigungen.zeilen.map((z) => (z.read_at === null ? { ...z, read_at: jetzt } : z));
  } catch (e) {
    showToast(e instanceof Error ? e.message : 'Alle als gelesen markieren fehlgeschlagen');
  }
}

/** WR-02-Rücksetzung: der Inbox-Zustand gehört zur Sitzung/zum Desk und überlebt weder
 *  Schreibtischwechsel noch Abmeldung — Aufruf in BEIDEN Rücksetzblöcken (loadDesk()/
 *  stop() in store.svelte.ts, geteilte Kanzleigeräte). Schaltet zusätzlich die Lade-
 *  Generation weiter (WR-04): ein noch unterwegs gewesener Ladevorgang verwirft sofort. */
export function setzeBenachrichtigungenZurueck(): void {
  ladeGeneration++;
  benachrichtigungen.zeilen = [];
  benachrichtigungen.laden = false;
  benachrichtigungen.fehler = null;
  benachrichtigungen.letzterModus = null;
}

/**
 * KI-Sammelzeile (13-04, T-13-04-04): eine SYNTHETISCHE Anzeige-Zeile für wartende
 * KI-Vorschläge — lebt NICHT im Server-Register (keine Tabellen-id, wird nie an den
 * Server gemeldet, nie gelesen-markiert). Der Zähler kommt AUSSCHLIESSLICH aus
 * freigaben.svelte.ts::zaehler() — dieselbe Quelle wie das Freigaben-Signal
 * (FreigabenSignal.svelte), keine zweite Zählung (Andeutungs-Konsistenz).
 */
export interface SammelzeileZeile {
  readonly id: '__ki-sammelzeile__';
  readonly art: 'ki-sammelzeile';
  readonly anzahl: number;
}

export type AnzeigeZeile = BenachrichtigungDto | SammelzeileZeile;

export function istSammelzeile(z: AnzeigeZeile): z is SammelzeileZeile {
  return z.art === 'ki-sammelzeile';
}

/**
 * Zeilen inklusive der KI-Sammelzeile: bei zaehler() === 0 fehlt sie komplett; bei
 * zaehler() ≥ 1 erscheint sie GENAU EINMAL — unabhängig von der Zahl der echten
 * Tabellenzeilen, nie als eigene Tabellenzeile dupliziert. Position: am Ende der Liste
 * (die Sammelzeile trägt keinen eigenen Zeitstempel, die Server-Zeilen bleiben
 * chronologisch — neueste zuerst — an ihrem Platz).
 */
export function zeilenMitSammelzeile(): AnzeigeZeile[] {
  const n = zaehler();
  const zeilen: AnzeigeZeile[] = [...benachrichtigungen.zeilen];
  if (n >= 1) zeilen.push({ id: '__ki-sammelzeile__', art: 'ki-sammelzeile', anzahl: n });
  return zeilen;
}

/**
 * Prüft, ob das Ziel einer Zeile im geladenen State noch auflösbar ist — fehlt es
 * (gelöscht/unsichtbar geworden), wird die Zeile inert (UI-SPEC: „nie ein toter
 * Sprung"). Die Sammelzeile hat kein Server-Ziel und gilt hier immer als auflösbar
 * (ihr Klickziel ist der VorschlaegeDialog, kein Objekt-Sprung).
 */
export function loeseZielAuf(z: AnzeigeZeile, state: DesktopState): boolean {
  if (istSammelzeile(z)) return true;
  switch (z.art) {
    case 'erwaehnung':
      return typeof z.payload.notizId === 'string' && (state.notes ?? []).some((n) => n.id === z.payload.notizId);
    case 'aufgabe':
      return typeof z.payload.aufgabeId === 'string'
        && (state.legalObjects ?? []).some((o) => o.id === z.payload.aufgabeId && o.kind === 'aufgabe');
    case 'ersetzt':
    case 'quelle':
      return typeof z.payload.dokumentId === 'string' && state.docs.some((d) => d.id === z.payload.dokumentId);
    case 'geteilt':
      // Das Klickziel liegt außerhalb des geladenen States (ein ANDERER Desk) — die einzige
      // hier prüfbare Bedingung ist, dass die Zeile eine deskId trägt.
      return typeof z.payload.deskId === 'string';
    default:
      return false;
  }
}

/** Klickziel-Deskriptor je Zeilenart — die Ausführung (Sprung/Öffnen/Wechsel/Dialog,
 *  Lesen-Markierung) bleibt in der Komponente (BenachrichtigungenPanel.svelte). */
export type KlickZiel =
  | { art: 'sprung'; box: Box }
  | { art: 'dokument'; ziel: Fundstelle }
  | { art: 'desk'; deskId: string }
  | { art: 'sammelzeile' };

/** Liefert das Klickziel einer Zeile, oder `null` — dann ist die Zeile inert (kein
 *  Klickziel, UI-SPEC-Zusatz „(Ziel nicht mehr vorhanden)"). */
export function klickZiel(z: AnzeigeZeile, state: DesktopState): KlickZiel | null {
  if (istSammelzeile(z)) return { art: 'sammelzeile' };
  if (!loeseZielAuf(z, state)) return null;
  switch (z.art) {
    case 'erwaehnung': {
      const notiz = (state.notes ?? []).find((n) => n.id === z.payload.notizId);
      return notiz ? { art: 'sprung', box: noteBox(notiz) } : null;
    }
    case 'aufgabe': {
      const aufgabe = (state.legalObjects ?? []).find((o) => o.id === z.payload.aufgabeId);
      return aufgabe ? { art: 'sprung', box: legalObjectBox(aufgabe) } : null;
    }
    case 'ersetzt':
    case 'quelle':
      return { art: 'dokument', ziel: { docId: z.payload.dokumentId!, page: 1 } };
    case 'geteilt':
      return { art: 'desk', deskId: z.payload.deskId! };
    default:
      return null;
  }
}
