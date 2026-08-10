import type { GefahrlicheAktion, Rolle, Zone } from '@j-desk/core';
import { darfAktionClient } from './store.svelte';
import type { VerlaufEintrag } from './verlauf';
import type { Ansicht } from './views';

/**
 * Command Palette — Befehls-Registry (UX-04, 13-09): DOM-freie, reine Aggregations-Fläche über
 * die ui-Schalter und Kommandos der Pläne 13-01 bis 13-08 — synchron aus Client-Zustand, KEIN
 * Server-Fetch beim Öffnen (E7/loading-dismissed-Bedingung, Muster views.ts:14-17: „Liegt bewusst
 * außerhalb von ui.svelte.ts, damit sie ohne Runen-Kontext getestet werden kann").
 *
 * Zweistufige Filterung (verbindlich, UI-SPEC Komponentenkontrakt CommandPalette):
 * baueBefehle() erzeugt die VOLLE, kontextabhängig zusammengestellte Liste (dynamische Zeilen wie
 * Zonen-/Ansichten-/Verlauf-Einträge entstehen nur, wenn die jeweiligen Daten vorhanden sind;
 * statische Zeilen tragen ein `recht`- bzw. `kontext`-Tag) — filtereBefehle() entfernt anschließend
 * Zeilen anhand von Rolle (darfAktionClient, PERM-04) und Kontext (Verlauf/Modus). Beide entfernen
 * Zeilen VOLLSTÄNDIG, niemals nur ein Deaktiviert-Flag (ausblenden, nie ausgrauen).
 *
 * Ausführungs-Deskriptoren zeigen auf DIESELBEN Pfade wie Menüs/Shortcuts (desktop.command,
 * ui-Schalter, jump.ts, ViewSwitcher-Anwendungslogik) — ein zweiter Ausführungspfad wäre eine
 * zweite Wahrheit (must_haves key_links, 13-09-PLAN.md). Die tatsächliche Ausführung liegt in
 * CommandPalette.svelte (Task 2) — dieses Modul liefert nur die reinen Deskriptoren.
 */

export type PaletteAbschnitt = 'aktionen' | 'zonen' | 'ansichten' | 'verlauf';

export interface PaletteBefehl {
  id: string;
  label: string;
  abschnitt: PaletteAbschnitt;
  shortcut?: string;
  icon?: string;
  aktion: { art: 'kommando' | 'ui' | 'sprung' | 'dialog'; ziel: string };
  /** PERM-04-Rollen-Gate: fehlt das Recht, entfernt filtereBefehle die Zeile vollständig. */
  recht?: { aktion: GefahrlicheAktion };
  /** Kontext-Gate (über die statische Verlauf-/Zonen-Präsenz hinaus): 'verlauf' braucht
   *  mindestens einen Verlaufseintrag, 'standalone'/'jlawyer' den passenden Desk-Modus. */
  kontext?: 'jlawyer' | 'standalone' | 'verlauf' | 'zonen';
}

export interface PaletteKontext {
  rolle: Rolle | null;
  mode: 'jlawyer' | 'standalone';
  verlauf: VerlaufEintrag[];
  zonen: Zone[];
  ansichten: Ansicht[];
}

/** Feste Abschnittsreihenfolge (UI-SPEC: Aktionen → Zonen → Ansichten → Verlauf) — sowohl für die
 *  leere-Suchtext-Sortierung (sucheBefehle) als auch als Tertiär-Sortkriterium bei Treffern. */
const ABSCHNITT_REIHENFOLGE: readonly PaletteAbschnitt[] = ['aktionen', 'zonen', 'ansichten', 'verlauf'];

export const ABSCHNITT_LABEL: Record<PaletteAbschnitt, string> = {
  aktionen: 'Aktionen',
  zonen: 'Zonen',
  ansichten: 'Ansichten',
  verlauf: 'Verlauf',
};

/** Verbindliches Shortcut-Inventar (13-UI-SPEC Copywriting Contract, einzige Quelle) — jeder
 *  Eintrag MUSS mindestens eine Registry-Zeile mit diesem Shortcut-Hinweis tragen
 *  (Vollständigkeits-Wächter, palette.test.ts). Kanonische Form (⌘); die Plattform-Spiegelung
 *  auf Strg außerhalb macOS ist Anzeigeaufgabe der Komponente (CommandPalette.svelte, Task 2).*/
export const SHORTCUT_INVENTAR: readonly string[] = ['⌘F', '⌘K', '⌥⇧A', '⌥←', '⌥→', 'Leertaste', 'Esc'];

/** Werkzeugnamen-Quelle: dieselben drei Zeichenwerkzeuge wie TOOL_STYLE (InkOverlay.svelte,
 *  Zeilen 10-14) — dessen Record ist eine lokale Konstante der Komponente (keine Duplikation der
 *  Stilwerte hier, nur der Bestandsnamen/-keys als deutsche Anzeigebezeichnung). */
const WERKZEUG_LABEL: Record<'pen' | 'marker' | 'pencil', string> = {
  pen: 'Kugelschreiber',
  marker: 'Textmarker',
  pencil: 'Bleistift',
};

/** Verlauf-Abschnitt: höchstens die letzten 10 Einträge, neueste zuerst (13-05: Ringpuffer 20,
 *  die Palette zeigt nur den sichtbaren Ausschnitt) — Labels sind bereits die labelFuer()-Form
 *  aus verlauf.ts (am Aufzeichnungszeitpunkt erzeugt, hier nur gelesen). */
const VERLAUF_PALETTE_MAX = 10;

/**
 * Baut die volle, kontextabhängig zusammengestellte Befehls-Registry. Statische Aktionen sind
 * IMMER Teil der Liste (auch wenn ihr `kontext`-Tag sie später über filtereBefehle entfernen
 * lässt) — nur die dynamischen Zonen-/Ansichten-/Verlauf-Zeilen entstehen ausschließlich, wenn
 * die jeweiligen Daten vorhanden sind (E4/empty: „der Palette-Abschnitt „Zonen" fehlt dann
 * komplett" — dasselbe gilt sinngemäß für Ansichten/Verlauf).
 */
export function baueBefehle(kontext: PaletteKontext): PaletteBefehl[] {
  const aktionen: PaletteBefehl[] = [
    { id: 'suche-oeffnen', label: 'Suche öffnen', abschnitt: 'aktionen', shortcut: '⌘F', aktion: { art: 'ui', ziel: 'sucheOffen' } },
    { id: 'befehle-palette', label: 'Befehle…', abschnitt: 'aktionen', shortcut: '⌘K', aktion: { art: 'ui', ziel: 'palette-schliessen' } },
    { id: 'werkzeug-pen', label: `Werkzeug: ${WERKZEUG_LABEL.pen}`, abschnitt: 'aktionen', aktion: { art: 'ui', ziel: 'werkzeug:pen' } },
    { id: 'werkzeug-marker', label: `Werkzeug: ${WERKZEUG_LABEL.marker}`, abschnitt: 'aktionen', aktion: { art: 'ui', ziel: 'werkzeug:marker' } },
    { id: 'werkzeug-pencil', label: `Werkzeug: ${WERKZEUG_LABEL.pencil}`, abschnitt: 'aktionen', aktion: { art: 'ui', ziel: 'werkzeug:pencil' } },
    { id: 'ansicht-speichern', label: 'Ansicht speichern…', abschnitt: 'aktionen', aktion: { art: 'dialog', ziel: 'ansicht-speichern' } },
    { id: 'quelle-oeffnen', label: 'Quelle öffnen', abschnitt: 'aktionen', aktion: { art: 'sprung', ziel: 'letzte-fundstelle' }, kontext: 'verlauf' },
    { id: 'verlauf-zurueck', label: 'Zurück zur letzten Position', abschnitt: 'aktionen', shortcut: '⌥←', aktion: { art: 'ui', ziel: 'verlauf-zurueck' }, kontext: 'verlauf' },
    { id: 'verlauf-vor', label: 'Wieder vor', abschnitt: 'aktionen', shortcut: '⌥→', aktion: { art: 'ui', ziel: 'verlauf-vor' }, kontext: 'verlauf' },
    { id: 'auswertung-oeffnen', label: 'Auswertung öffnen', abschnitt: 'aktionen', shortcut: '⌥⇧A', aktion: { art: 'ui', ziel: 'auswertungOffen' } },
    { id: 'pan-hinweis', label: 'Schwenken (Leertaste halten)', abschnitt: 'aktionen', shortcut: 'Leertaste', aktion: { art: 'ui', ziel: 'noop' } },
    { id: 'oberste-ebene-schliessen', label: 'Oberste Ebene schließen', abschnitt: 'aktionen', shortcut: 'Esc', aktion: { art: 'ui', ziel: 'palette-schliessen' } },
    { id: 'ki-freigaben-oeffnen', label: '🤖 KI-Freigaben öffnen', abschnitt: 'aktionen', aktion: { art: 'ui', ziel: 'vorschlaegeOffen' } },
    { id: 'papierkorb-oeffnen', label: 'Papierkorb öffnen', abschnitt: 'aktionen', aktion: { art: 'ui', ziel: 'trashOpen' } },
    { id: 'aufraeumen-oeffnen', label: '🧹 Schreibtisch aufräumen…', abschnitt: 'aktionen', aktion: { art: 'ui', ziel: 'aufraeumenOffen' }, recht: { aktion: 'manage' } },
    { id: 'aufnahme-oeffnen', label: '📥 Inhalt aufnehmen…', abschnitt: 'aktionen', aktion: { art: 'ui', ziel: 'aufnahmeOffen' } },
    { id: 'zone-anlegen', label: 'Zone anlegen…', abschnitt: 'aktionen', aktion: { art: 'dialog', ziel: 'zone-anlegen' }, recht: { aktion: 'manage' } },
    { id: 'inbox-oeffnen', label: '🔔 Benachrichtigungen öffnen', abschnitt: 'aktionen', aktion: { art: 'ui', ziel: 'inboxOffen' } },
    { id: 'minimap-toggle', label: '🗺 Minikarte ein-/ausblenden', abschnitt: 'aktionen', aktion: { art: 'ui', ziel: 'minimap-toggle' } },
    { id: 'sitzungsmappe-oeffnen', label: '🎓 Sitzungsmappe…', abschnitt: 'aktionen', aktion: { art: 'ui', ziel: 'sitzungsmappeOffen' } },
    { id: 'anlagenpaket-oeffnen', label: '📑 Anlagenpaket…', abschnitt: 'aktionen', aktion: { art: 'ui', ziel: 'anlagenpaketOffen' }, recht: { aktion: 'export' } },
    { id: 'uebergabe-oeffnen', label: 'Übergabe…', abschnitt: 'aktionen', aktion: { art: 'ui', ziel: 'uebergabeOffen' }, recht: { aktion: 'export' } },
    { id: 'export-desk', label: 'Arbeitsstand exportieren…', abschnitt: 'aktionen', aktion: { art: 'dialog', ziel: 'export' }, recht: { aktion: 'export' } },
    { id: 'vorlagen-oeffnen', label: 'Neu aus Vorlage…', abschnitt: 'aktionen', aktion: { art: 'ui', ziel: 'vorlagenOffen' }, kontext: 'standalone' },
  ];

  const zonenZeilen: PaletteBefehl[] = kontext.zonen.map((z) => ({
    id: `zone-springen-${z.id}`,
    label: `Zu „${z.name}" springen`,
    abschnitt: 'zonen',
    aktion: { art: 'sprung', ziel: `zone:${z.id}` },
  }));

  const ansichtenZeilen: PaletteBefehl[] = kontext.ansichten.map((a) => ({
    id: `ansicht-anwenden-${a.id}`,
    label: `Ansicht „${a.name}" anwenden`,
    abschnitt: 'ansichten',
    aktion: { art: 'sprung', ziel: `ansicht:${a.id}` },
  }));

  const letzteIndizes: number[] = [];
  for (let i = kontext.verlauf.length - 1; i >= 0 && letzteIndizes.length < VERLAUF_PALETTE_MAX; i--) {
    letzteIndizes.push(i);
  }
  const verlaufZeilen: PaletteBefehl[] = letzteIndizes.map((idx) => ({
    id: `verlauf-eintrag-${idx}`,
    label: kontext.verlauf[idx].label,
    abschnitt: 'verlauf',
    aktion: { art: 'sprung', ziel: `verlauf:${idx}` },
  }));

  return [...aktionen, ...zonenZeilen, ...ansichtenZeilen, ...verlaufZeilen];
}

/**
 * Zweite Filterstufe (Rollen- + Kontext-Filter, UI-SPEC Komponentenkontrakt CommandPalette) —
 * entfernt Zeilen vollständig, flaggt nie (PERM-04). `rolle: null` bleibt per darfAktionClient-
 * Konvention erlaubt (Bestandsverhalten, s. Kopfkommentar store.svelte.ts).
 */
export function filtereBefehle(befehle: PaletteBefehl[], kontext: PaletteKontext): PaletteBefehl[] {
  return befehle.filter((b) => {
    if (b.recht && !darfAktionClient(kontext.rolle, b.recht.aktion)) return false;
    if (b.kontext === 'verlauf' && kontext.verlauf.length === 0) return false;
    if (b.kontext === 'jlawyer' && kontext.mode !== 'jlawyer') return false;
    if (b.kontext === 'standalone' && kontext.mode !== 'standalone') return false;
    if (b.kontext === 'zonen' && kontext.zonen.length === 0) return false;
    return true;
  });
}

function normalisiere(text: string): string {
  return text.normalize('NFC').toLocaleLowerCase('de');
}

/**
 * Teilfolgen-Match (< 50 feste deutsche Befehlsnamen, ~15 Zeilen — keine externe Bibliothek
 * nötig, 13-RESEARCH.md Standard Stack). NFC-normalisiert + case-insensitiv-de (Muster
 * normalisiereName, views.ts). Liefert Start und Spannweite des frühesten/engsten Treffers für
 * die Scoring-Sortierung in sucheBefehle, oder `null` ohne Treffer.
 */
export function teilfolgenMatch(nadel: string, heuhaufen: string): { start: number; spanne: number } | null {
  const n = normalisiere(nadel);
  const h = normalisiere(heuhaufen);
  if (n === '') return { start: 0, spanne: 0 };
  let start = -1;
  let ab = 0;
  for (const zeichen of n) {
    const pos = h.indexOf(zeichen, ab);
    if (pos === -1) return null;
    if (start === -1) start = pos;
    ab = pos + 1;
  }
  return { start, spanne: ab - start };
}

/**
 * Fuzzy-Filter der Palette: leerer Suchtext liefert die volle (bereits rollen-/kontextgefilterte)
 * Liste in fixierter Abschnittsreihenfolge — die Palette ist auch ein Entdeckungsweg, nie ein
 * leeres Eingabefeld (E7/empty). Nicht-leerer Suchtext filtert auf Teilfolgen-Treffer und
 * sortiert nach frühester, dann engster Fundstelle, danach Abschnittsreihenfolge.
 */
export function sucheBefehle(befehle: PaletteBefehl[], suchText: string): PaletteBefehl[] {
  const text = suchText.trim();
  if (text === '') {
    return [...befehle].sort(
      (a, b) => ABSCHNITT_REIHENFOLGE.indexOf(a.abschnitt) - ABSCHNITT_REIHENFOLGE.indexOf(b.abschnitt),
    );
  }
  const treffer = befehle
    .map((b) => ({ b, m: teilfolgenMatch(text, b.label) }))
    .filter((x): x is { b: PaletteBefehl; m: { start: number; spanne: number } } => x.m !== null);
  treffer.sort((x, y) => (
    x.m.start - y.m.start
    || x.m.spanne - y.m.spanne
    || ABSCHNITT_REIHENFOLGE.indexOf(x.b.abschnitt) - ABSCHNITT_REIHENFOLGE.indexOf(y.b.abschnitt)
  ));
  return treffer.map((x) => x.b);
}
