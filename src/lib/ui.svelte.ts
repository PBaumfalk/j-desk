import type { Box, Command, DeskBackground, JournalEintragDto, Konflikt, Rolle } from '@j-desk/core';
import type { AuswahlEintrag } from './anlagenpaketAuswahl';
import type { VerlaufState } from './verlauf';
import type { Fundstelle } from './jump';

export interface MenuItem {
  label: string;
  action: () => void;
  /** Optionaler Tooltip (UX-01-Klärung, 13-08): kleinstmögliche Interface-Erweiterung, damit
   *  `papierkorbEintrag()` (menus.ts) einen fixierten Hinweistext tragen kann, ohne das Label
   *  zu ändern — am Render-Ort (ContextMenu.svelte) als `title`-Attribut durchgereicht; fehlt
   *  bei jedem anderen Bestandseintrag (kein Verhaltenswechsel dort). */
  title?: string;
}

export interface MenuInput {
  placeholder: string;
  onSubmit: (text: string) => void;
  /** Wird gerufen, wenn Escape im Eingabefeld gedrückt wird, statt das Menü nur zu schließen. */
  onEscape?: () => void;
  /** Zeichenobergrenze des Eingabefelds — Default 24 (Bestandsverhalten, ContextMenu.svelte)
   *  bleibt für bestehende Aufrufer unverändert. 13-05 Task 3 (Zonenname): 40, wie
   *  ZONEN_NAME_MAX/ANSICHT_NAME_MAX. */
  maxlength?: number;
}

/** REF-03: Sitzungs-Schlüssel für das manuelle Schließen des Versionskompatibilitäts-Banners.
    Bewusst sessionStorage statt localStorage (planner_assumption, 01-07-PLAN.md) — verschwindet
    mit dem Tab-/Fensterschluss, gilt nie dauerhaft über Sessions hinweg. */
const JL_VERSION_BANNER_KEY = 'jlVersionBannerGeschlossen';

function leseJlVersionBannerGeschlossen(): boolean {
  try {
    return typeof sessionStorage !== 'undefined' && sessionStorage.getItem(JL_VERSION_BANNER_KEY) === '1';
  } catch {
    return false; // Session-Storage evtl. gesperrt (privates Fenster) — dann eben jedes Mal zeigen
  }
}

export const ui = $state({
  linkingFromId: null as string | null,
  /** Büroklammer: „Anklammern an…" wartet auf das Zielobjekt (Muster linkingFromId). */
  clippingFromId: null as string | null,
  /** Aufgaben-Dokumentbezug (TASK-01): „Bezug zu Dokument…" wartet auf eine Dokument- oder
   *  Ausschnittkarte als Ziel — gleicher Zwei-Klick-Auswahlmodus wie linkingFromId, nur mit
   *  eingeschränktem Zielobjekt-Typ (Doc/Cutout statt beliebiger Entität). */
  taskRefFromId: null as string | null,
  /** Tabellenzeilen-Belegbezug (CALC-01, 08-07): „+ Beleg verknüpfen" wartet auf eine Dokument-
   *  oder Ausschnittkarte als Ziel — gleicher Zwei-Klick-Auswahlmodus wie taskRefFromId, nur mit
   *  einer Zeilenadresse (tableId+rowId) statt einer Objekt-id. */
  tabelleBelegFuer: null as { tableId: string; rowId: string } | null,
  /** Zeitleisten-Eintragserfassung (CHRONO-01, 09-01 Task 3): „+ Eintrag" wartet auf ein
   *  Zielobjekt — gleicher Zwei-Klick-Auswahlmodus wie linkingFromId/tabelleBelegFuer. Das
   *  eigentliche Popover-Formular (Art/Zeitangabe/Datum) kommt in Plan 09-05. */
  zeitleisteEintragFuer: null as string | null,
  /** Zeitleisten-Eintragsentwurf (09-01 Task 3, Plan 09-05): der noch nicht gespeicherte
   *  Eintrag, den das Popover bearbeitet; `eintragId` gesetzt bedeutet Bearbeiten statt
   *  Neuanlage. */
  zeitleisteEintragEntwurf: null as { zeitleisteId: string; objRef: string; eintragId?: string } | null,
  /** Bildschirm-Rechtecke der Body-Fläche jeder GEÖFFNETEN Zeitleiste (Drop-Ziel für CHRONO-01,
   *  Muster trashRect) — je Zeitleisten-id, von ZeitleisteCard.svelte selbst gepflegt.
   *  `zIndex` (WR-01, 09-REVIEW.md): explizit mitgeführt statt sich auf die Objektschlüssel-
   *  Einfügereihenfolge zu verlassen — ein `bringToFront()` auf eine bereits offene, überlappende
   *  Zeitleiste ändert `z.zIndex`, aber NICHT die Position ihres Schlüssels in diesem Record (nur
   *  `delete`+Neu-`set` täte das, was hier nicht bei jeder zIndex-Änderung passiert). Ohne das
   *  Feld würde `pointerUeberZeitleiste` bei Überlappung die zuerst geöffnete statt die zuletzt
   *  nach vorn geholte Zeitleiste treffen. */
  zeitleisteRects: {} as Record<string, { x: number; y: number; w: number; h: number; zIndex: number }>,
  /** „Vergleichen mit…" (COMP-01, Plan 09-09) wartet auf das zweite Dokument. */
  compareFromId: null as string | null,
  /** „Ist neue Version von…" (COMP-03, Plan 09-09) wartet auf die ältere Fassung. */
  versionFromId: null as string | null,
  /** Offener Vergleichsviewer (COMP-01/02, Plan 09-09). */
  vergleich: null as { aId: string; bId: string } | null,
  editingStackId: null as string | null,
  editingNoteId: null as string | null,
  /** Juristisches Objekt (LEGAL-01, 08-01): Doppelklick öffnet das Textfeld — gleiche Form wie editingNoteId. */
  editingLegalObjectId: null as string | null,
  fannedStackId: null as string | null,
  menu: null as { x: number; y: number; items: MenuItem[]; columns?: number; input?: MenuInput } | null,
  toast: null as string | null,
  /** Aktive Desk-Pointer (Pan/Pinch) — Karten lassen weitere Finger dann zum Desk durch. */
  deskPointers: 0,
  /** Lupe: runder vergrößerter Ausschnitt folgt dem Zeiger. */
  lupe: false,
  /** Papierkorb: Bildschirm-Rechteck (Drop-Ziel) und geöffnetes Panel. */
  trashRect: null as { x: number; y: number; w: number; h: number } | null,
  trashOpen: false,
  /** Gestaltung: lokale Regler-Vorschau — wirkt nur auf die Darstellung, bis das Command beim Loslassen gesendet ist. */
  backgroundPreview: null as DeskBackground | null,
  /** Sprung zur Quelle: Herkunfts-Rechteck pulst kurz auf der Originalseite (Basiskoordinaten).
   *  `rect` fehlt bei Fundstellen ohne Wortkoordinaten (PDF-Text-/OCR-Treffer, 07-03): dann trägt
   *  `ganzeSeite` die Anweisung, das volle Basis-Seitenrechteck zu pulsen — SourceHighlight.svelte
   *  bildet dieses Rechteck selbst, weil nur die Viewer-Ebene die Basis-Seitengröße kennt. */
  sourceHighlight: null as { docId: string; page: number; rect?: Box; ganzeSeite?: true; until: number } | null,
  /** Sprung zur Quelle: Zentrier-Anforderung an den Desktop — dieselbe Leitung wie die Kartensuche (springe/pulsBox). */
  jumpRequest: null as { box: Box } | null,
  /** Sprung zur Quelle: docId, auf das gerade gesprungen wurde — DocViewer.svelte zeigt bei
      sourceReplacedAt kurz das Sprung-Banner, wenn diese Karte das Sprungziel war, und
      konsumiert (löscht) das Feld danach einmalig, damit spätere Rerenders nicht erneut auslösen. */
  docJumpTarget: null as string | null,
  /** Herkunfts-Popover: aktuell angezeigtes Objekt (kind-agnostisch, per id) + optionaler
      Bildschirm-Anker (Klickposition), an dem das Popover verankert wird. */
  provenancePopover: null as { id: string; anchor?: { x: number; y: number } } | null,
  /** Konflikt: dem Store vorgelegter, noch ungeklärter Konflikt — das Overlay dazu kommt in Task 6. */
  konflikt: null as { cmd: Command; konflikt: Konflikt } | null,
  /** Teilen-Dialog (02-08, PERM-03): Overlay offen? Nur der Eigentümer öffnet ihn
   *  (Desktop.svelte gated den Auslöser-Button); Reset bei Desk-Wechsel/Logout (WR-02-Muster,
   *  store.svelte.ts) — die Mitgliederliste gehört zum vorherigen Desk und darf nicht stehen bleiben. */
  teilenOffen: false,
  /** Systemdiagnose-Overlay (OPS-02, 14-01): Overlay offen? Analog teilenOffen — nur der
   *  Eigentümer öffnet ihn (Desktop.svelte gated den Auslöser-Button, der Server bleibt die
   *  eigentliche Grenze über requireDeskRolle(['Eigentümer'])). Eigenes Flag, KEINE
   *  Wiederverwendung von teilenOffen/historieOffen (Bestandsregel ui.svelte.ts). Reset im
   *  selben Bündel wie historieOffen (clearHistorieCache(), WR-02-Muster) — eine geladene
   *  Diagnose (Verbindungszustände, Systemversionen) gehört zur beendeten Sitzung. */
  systemdiagnoseOffen: false,
  /** BerechtigungsDialog (OPS-03, 14-05): Overlay-Zustand — `false` = geschlossen, sonst ein
   *  Objekt mit optionaler vorbefüllter Objektkennung (Kontextmenü-Einstieg
   *  „Sichtbarkeit prüfen…", menus.ts) bzw. ohne Objektkennung (Werkzeugleisten-Knopf
   *  „🛡 Admin", leer geöffnet — ein Feld, zwei Einstiege, kein zweiter Dialogtyp). Nur der
   *  Eigentümer öffnet ihn (Desktop.svelte/menus.ts gaten den Auslöser, der Server bleibt die
   *  eigentliche Grenze über requireDeskRolle(['Eigentümer'])). Eigenes Flag, KEINE
   *  Wiederverwendung von teilenOffen/systemdiagnoseOffen (Bestandsregel ui.svelte.ts). Reset
   *  im selben Bündel wie systemdiagnoseOffen (clearHistorieCache(), WR-02-Muster) — eine
   *  offene Prüfung über die Sicht eines anderen Nutzers gehört zur beendeten Sitzung und darf
   *  auf einem geteilten Kanzleigerät nicht stehen bleiben. */
  berechtigungDialog: false as false | { objektId?: string },
  /** Übergabe-Dialog (D-12, 03-10): Overlay offen? Analog teilenOffen — self-contained über
   *  dieses Flag statt Props; ersetzt den Tracer-Direkt-Download aus 03-01 im DeskSwitcher-Menü. */
  uebergabeOffen: false,
  /** Anlagenpaket-Dialog (KONV-01, 10-01): Overlay offen? Analog uebergabeOffen — self-contained. */
  anlagenpaketOffen: false,
  /** Anlagenpaket-Auswahl (KONV-01, 10-01): lebt bewusst im Store statt im Dialog, damit Plan
   *  10-03 sie auch aus dem Kontextmenü am Tisch befüllen kann, ohne den Dialog als
   *  Zwischenstation zu brauchen. Bleibt beim Schließen des Dialogs erhalten (Festlegung F-04
   *  aus 10-01-PLAN.md) und wird erst nach erfolgreicher Erzeugung geleert. Seit 10-03 auch aus
   *  `menus.ts` befüllt (Kontextmenü-Einträge „Zu Anlagenpaket hinzufügen"/„Anlagenpaket aus
   *  Stapel…"), nicht mehr ausschließlich aus dem Dialog selbst. */
  anlagenpaketAuswahl: [] as AuswahlEintrag[],
  /** Historie: Overlay offen? */
  historieOffen: false,
  /** Aktivitätsansicht (Phase 4, HIST-01): eigenes Overlay-Flag, bewusst NICHT historieOffen
   *  wiederverwendet, damit beide Oberflächen unabhängig voneinander geöffnet/geschlossen werden
   *  können und HistoryOverlay.svelte unangetastet bleibt (D-01, P-11). Bewusst KEIN
   *  Zwischenspeicher analog historieEintraege/historieScroll: die Aktivitätsansicht hat keine
   *  Sprung-Rückkehr, lädt bei jedem Öffnen frisch und hält ihre Zeilen in komponentenlokalem
   *  $state — damit entfällt zugleich jede Notwendigkeit, einen Zwischenspeicher beim Abmelden
   *  zu leeren. */
  aktivitaetOffen: false,
  /** Auswertungs-Panel (LEGAL-03, 08-05): eigenes Overlay-Flag, gleiche Form wie
   *  aktivitaetOffen — die drei kanonischen Abfragen laden bei jedem Öffnen frisch, kein
   *  Zwischenspeicher nötig (kein Sprung-Rückkehr-Bedürfnis, analog Aktivitätsansicht). */
  auswertungOffen: false,
  /** KI-Freigaben-Dialog (AI-01, Plan 12-06/12-07): öffnet den VorschlaegeDialog aus Plan
   *  12-07 — gesetzt vom Freigaben-Signal (Toolbar) und vom DeskSwitcher-Menüeintrag
   *  „🤖 KI-Freigaben…". Reset in BEIDEN Rücksetzblöcken (loadDesk()/stop(), WR-02-Muster):
   *  die Warteliste gehört zum Desk/zur Sitzung und darf nicht stehen bleiben (T-12-06-03). */
  vorschlaegeOffen: false,
  /** Benachrichtigungen-Panel (NOTIF-01, Plan 13-01): öffnet das Inbox-Panel am 🔔-Button
   *  der Werkzeugleiste. Reset über setzeSitzungsUiZurueck() (WR-02/P5) — die Inbox gehört
   *  zum Desk/zur Sitzung und darf auf einem geteilten Kanzleigerät nicht offen stehen
   *  bleiben. */
  inboxOffen: false,
  /** Aufnahme-Dialog (EXT-01, Plan 13-06): öffnet den AufnahmeDialog am 📥-Eintrag im
   *  DeskSwitcher-Aktions-Cluster — self-contained wie anlagenpaketOffen/sitzungsmappeOffen.
   *  Reset über setzeSitzungsUiZurueck() (WR-02/P5): auf einem geteilten Kanzleigerät darf der
   *  Dialog nicht offen stehen bleiben. Die eigene Escape-Behandlung läuft über die
   *  Dialog-Klasse (AufnahmeDialog.svelte, wie VorschlaegeDialog) — kein Eintrag im globalen
   *  Escape-Handler von Desktop.svelte nötig. */
  aufnahmeOffen: false,
  /** VorlagenDialog (TMPL-01, Plan 13-07): öffnet den Dialog „Neu aus Vorlage…" am
   *  DeskSwitcher-Eintrag direkt unter „Neuer Schreibtisch…" — self-contained wie aufnahmeOffen.
   *  Reset über setzeSitzungsUiZurueck() (WR-02/P5): auf einem geteilten Kanzleigerät darf der
   *  Dialog nicht offen stehen bleiben. Eigene Escape-Behandlung über die Dialog-Klasse
   *  (VorlagenDialog.svelte, wie AufnahmeDialog/VorschlaegeDialog) — kein Eintrag im globalen
   *  Escape-Handler von Desktop.svelte nötig. */
  vorlagenOffen: false,
  /** AufraeumenDialog (UX-02, Plan 13-08): öffnet „🧹 Schreibtisch aufräumen…" am
   *  DeskSwitcher-Eintrag — self-contained wie aufnahmeOffen/vorlagenOffen. Reset über
   *  setzeSitzungsUiZurueck() (WR-02/P5): auf einem geteilten Kanzleigerät darf der Dialog nicht
   *  offen stehen bleiben. Eigene Escape-Behandlung über die Dialog-Klasse (AufraeumenDialog.svelte,
   *  wie VorlagenDialog/AufnahmeDialog/VorschlaegeDialog) — kein Eintrag im globalen
   *  Escape-Handler von Desktop.svelte nötig. */
  aufraeumenOffen: false,
  /** Historie: bereits geladene Roh-Einträge (bleiben nach dem Schließen erhalten,
      damit ein Sprung und die Rückkehr nicht jedes Mal neu laden und die Position verlieren). */
  historieEintraege: [] as JournalEintragDto[],
  /** Historie: Scrollposition beim letzten Schließen. */
  historieScroll: 0,
  /** Historie: zu welchem Schreibtisch/welcher Akte gehören historieEintraege? Ein abweichender
      desktop.deskId beim Öffnen zeigt, dass der Zwischenspeicher vom vorherigen Schreibtisch
      stammt und verworfen werden muss, statt an eine fremde Historie anzuhängen. */
  historieDeskId: null as string | null,
  /** Historie: von springen() gesetzt, bevor es schließt und zur Fundstelle springt — der
      nächste Öffnen-Effekt konsumiert das Flag einmalig und lädt dann NICHT neu, sondern
      stellt Liste und Scrollposition wieder her (Spec: mehrere Fundstellen hintereinander
      prüfen soll keine Jagd werden). Jeder andere Öffnen-Vorgang lädt frisch (Seite 1). */
  historieNachSprung: false,
  /** REF-03: der verbundene j-lawyer-Server weicht von der getesteten Version ab
      (server-ermitteltes tri-state Ergebnis, siehe LoginScreen.svelte/api.ts login()) —
      löst das nicht blockierende Versionskompatibilitäts-Banner aus. */
  jlVersionIncompatible: false,
  /** REF-03: Banner für die LAUFENDE Verbindung manuell geschlossen — mit Session-Speicher
      gespiegelt (planner_assumption, 01-07-PLAN.md: verschwindet mit Tab-/Fensterschluss,
      erscheint bei jedem neuen Login/Verbindungsaufbau wieder, kein persistenter Client-Zustand). */
  jlVersionBannerGeschlossen: leseJlVersionBannerGeschlossen(),
  /** Präsenz-Rosette (06-03, COLLAB-01): Overlay offen? Eigenes Feld analog
   *  teilenOffen/aktivitaetOffen statt Wiederverwendung — die Rosette ist ein unabhängiges
   *  Dropdown mit eigenem Öffnen/Schließen-Lebenszyklus, keine Variante eines bestehenden
   *  Overlays. Reset bei Desk-Wechsel/Logout (WR-02-Muster, store.svelte.ts) — die Liste
   *  gehört zum vorherigen Schreibtisch und darf nicht stehen bleiben. */
  praesenzOffen: false,
  /** Sitzungsmodus (SESS-01, 11-01): Vollbild-Chrome aktiv? Reset in BEIDEN Blöcken
   *  (loadDesk()/stop(), WR-02) über setzeSitzungsUiZurueck() (Task 3) — ein geteiltes
   *  Kanzleigerät darf den Sitzungsmodus des vorherigen Desks/der vorherigen Person nicht zeigen. */
  sitzungsmodusAktiv: false,
  /** Sitzungsmodus (SESS-01/SESS-02, 11-01): id der im Sitzungsmodus geöffneten Sitzungsmappe.
   *  Reset in BEIDEN Blöcken (WR-02) über setzeSitzungsUiZurueck() (Task 3) — dieselbe Begründung
   *  wie sitzungsmodusAktiv. */
  aktiveSitzungsmappeId: null as string | null,
  /** Verschiebe-Sperre (SESS-01, 11-01 Task 2): aktiv unterbindet Tisch-Pan/-Zoom, Kartenverschieben
   *  und Datei-Drop im Sitzungsmodus (kartenBewegungGesperrt() in sitzungsmodus.ts). Reset in
   *  BEIDEN Blöcken (WR-02) über setzeSitzungsUiZurueck() (Task 3) — außerdem setzt
   *  beendeSitzungsmodus() dieses Feld zusätzlich zurück, damit eine neue Sitzung nicht mit der
   *  Sperre der vorherigen startet. */
  verschiebeSperreAktiv: false,
  /** Sprungmarken-Panel (SESS-01, 11-01): 🎯-Panel im Sitzungsmodus auf-/zugeklappt. Reset in
   *  BEIDEN Blöcken (WR-02) über setzeSitzungsUiZurueck() — dieselbe Begründung wie
   *  sitzungsmodusAktiv. */
  sprungmarkenOffen: false,
  /** Sitzungsmappe-Vorbereitungsdialog (SESS-02, Plan 11-05): Overlay offen? Analog
   *  anlagenpaketOffen. Reset in BEIDEN Blöcken (WR-02) über setzeSitzungsUiZurueck(). */
  sitzungsmappeOffen: false,
  /** Sitzungsnotiz-Textfeld (SESS-02, Plan 11-06): großes Notizfeld im Sitzungsmodus geöffnet?
   *  Reset in BEIDEN Blöcken (WR-02) über setzeSitzungsUiZurueck(). */
  sitzungsnotizOffen: false,
  /** Ansichten-Hervorhebung (VIEW-01): Ids der aktuell hervorgehobenen Objekte — reiner
   *  Client-Zustand (kann serverseitig nicht fehlschlagen, kein Command-Pfad). Reset in BEIDEN
   *  Blöcken (WR-02) über setzeSitzungsUiZurueck() — auf einem geteilten Kanzleigerät darf die
   *  Hervorhebung der vorherigen Person/des vorherigen Desks nicht stehen bleiben. */
  highlightedIds: new Set<string>() as Set<string>,
  /** Positions-Verlauf (UX-03, 13-05 Task 1): reiner Client-Sitzungszustand (Muster
   *  highlightedIds oben — kann serverseitig nicht fehlschlagen, kein Kommandopfad). Ringpuffer
   *  20 Einträge (verlauf.ts), bedient über ⌥←/⌥→ und die Palette (13-04). Reset über
   *  setzeSitzungsUiZurueck() (WR-02/P5) — auf einem geteilten Kanzleigerät darf der Verlauf der
   *  vorherigen Person/des vorherigen Desks nicht stehen bleiben. */
  verlauf: { eintraege: [], zeiger: 0 } as VerlaufState,
  /** Command Palette (UX-04, 13-09): Overlay offen? Analog vorschlaegeOffen/aufraeumenOffen —
   *  self-contained, eigene Escape-Behandlung UND Overlay-Vorrang-Einreihung in Desktop.svelte
   *  (offene Palette absorbiert ⌘F/⌥←/Pfeile, Muster ui.historieOffen/ui.konflikt). Reset über
   *  setzeSitzungsUiZurueck() (WR-02/P5) — auf einem geteilten Kanzleigerät darf die Palette
   *  nicht offen stehen bleiben. */
  paletteOffen: false,
  /** Command Palette „Quelle öffnen" (UX-04, 13-09): die zuletzt aktive Fundstelle (docId+Seite),
   *  gesetzt NEBEN dem Positions-Verlauf-Eintrag im selben ui.jumpRequest-Effect (Desktop.svelte)
   *  — VerlaufEintrag trägt bewusst nur `vp`+Label, kein docId (13-05), darum dieses eigene Feld
   *  als Ausführungsziel für den Palette-Befehl (jump.ts::desktop.jumpTo). Reset über
   *  setzeSitzungsUiZurueck() (WR-02/P5) — gehört zur Sitzung, nicht dauerhaft. */
  letzteFundstelle: null as Fundstelle | null,
});

/** Menüzustand, wie ihn `ui.menu` trägt — benannt, damit `menueNachAktion()` ihn führen kann. */
export type MenuState = { x: number; y: number; items: MenuItem[]; columns?: number; input?: MenuInput };

/**
 * Entscheidet, was nach dem Auslösen eines Kontextmenü-Eintrags mit dem Menü geschieht.
 *
 * Der Aufrufer merkt sich `ui.menu` VOR `item.action()` und weist das Ergebnis danach wieder
 * zu. Hat die Aktion nichts am Menü geändert, wird geschlossen (der Normalfall). Hat sie
 * selbst ein Folgemenü an dieselbe Stelle gesetzt — so arbeiten die Zweischritt-Einträge
 * „Ebene ändern" (02-04) und „Freigabe" (03-01) —, bleibt dieses stehen.
 *
 * Ohne diese Unterscheidung schloss der Handler das Folgemenü in derselben Anweisung wieder,
 * in der die Aktion es geöffnet hatte: Der zweite Schritt war nie erreichbar. Gefunden beim
 * Nachholen des UAT-Rückstands zu 02-04; das Muster stand seit dem ersten Commit der
 * Komponente, die Zweischritt-Einträge kamen erst später dazu.
 */
export function menueNachAktion(vorher: MenuState | null, jetzt: MenuState | null): MenuState | null {
  return jetzt === vorher ? null : jetzt;
}

/**
 * WR-02-Bündelung (11-01 Task 3): setzt alle SIEBEN in Phase 11 neu eingeführten `ui`-Felder auf
 * ihren Anfangswert — dieselbe Bündelungsform wie `clearHistorieCache()`, damit die
 * Rücksetzpflicht nicht an zwei Stellen (loadDesk()/stop() in store.svelte.ts) einzeln
 * nachgepflegt werden muss. Auf einem geteilten Kanzleigerät darf weder ein Sitzungszustand noch
 * eine Hervorhebung des vorherigen Schreibtischs oder der vorherigen Person stehen bleiben
 * (T-11-03).
 */
export function setzeSitzungsUiZurueck(): void {
  ui.sitzungsmodusAktiv = false;
  ui.aktiveSitzungsmappeId = null;
  ui.verschiebeSperreAktiv = false;
  ui.sprungmarkenOffen = false;
  ui.sitzungsmappeOffen = false;
  ui.sitzungsnotizOffen = false;
  ui.highlightedIds = new Set();
  // 13-01 (NOTIF-01, WR-02/P5): ein offenes Inbox-Panel gehört zum Desk/zur Sitzung —
  // auf einem geteilten Kanzleigerät darf es nicht stehen bleiben.
  ui.inboxOffen = false;
  // 13-06 (EXT-01, WR-02/P5): der Aufnahme-Dialog gehört zum Desk/zur Sitzung — auf einem
  // geteilten Kanzleigerät darf er nicht offen stehen bleiben.
  ui.aufnahmeOffen = false;
  // 13-07 (TMPL-01, WR-02/P5): der VorlagenDialog gehört zum Desk/zur Sitzung — auf einem
  // geteilten Kanzleigerät darf er nicht offen stehen bleiben.
  ui.vorlagenOffen = false;
  // 13-05 (UX-03, WR-02/P5): der Positions-Verlauf ist Sitzungskomfort und gehört zum
  // Desk/zur Sitzung — auf einem geteilten Kanzleigerät darf er nicht stehen bleiben.
  ui.verlauf = { eintraege: [], zeiger: 0 };
  // 13-08 (UX-02, WR-02/P5): der AufraeumenDialog gehört zum Desk/zur Sitzung — auf einem
  // geteilten Kanzleigerät darf er nicht offen stehen bleiben.
  ui.aufraeumenOffen = false;
  // 13-09 (UX-04, WR-02/P5): die Command Palette + die zuletzt aktive Fundstelle gehören zum
  // Desk/zur Sitzung — auf einem geteilten Kanzleigerät darf weder die Palette offen stehen
  // bleiben noch eine fremde Fundstelle als „Quelle öffnen"-Ziel überleben.
  ui.paletteOffen = false;
  ui.letzteFundstelle = null;
}

export function showToast(message: string): void {
  ui.toast = message;
  setTimeout(() => {
    if (ui.toast === message) ui.toast = null;
  }, 4000);
}

let sourceHighlightTimer: ReturnType<typeof setTimeout> | undefined;
/**
 * Laufende Nummer statt Objekt-Identität: `ui` ist ein $state-Proxy, deshalb liefert das Lesen
 * von `ui.sourceHighlight` einen Proxy UM das gesetzte Objekt — ein `=== h` ist nie wahr. Der
 * Timer feuerte pünktlich und tat nichts, der Puls blieb nach jedem Sprung dauerhaft stehen
 * (E2E-Befund). Der Sichtbarkeitszähler in SourceHighlight.svelte half nicht: `Date.now()` ist
 * keine reaktive Abhängigkeit, das $derived wurde nie neu ausgewertet.
 */
let sourceHighlightLauf = 0;

/** Setzt (oder löscht) das Herkunfts-Highlight; blendet sich nach `until` selbst wieder aus. */
export function setSourceHighlight(h: { docId: string; page: number; rect?: Box; ganzeSeite?: true; until: number } | null): void {
  clearTimeout(sourceHighlightTimer);
  ui.sourceHighlight = h;
  const meiner = ++sourceHighlightLauf;
  if (h) {
    sourceHighlightTimer = setTimeout(() => {
      // Nur löschen, wenn seither kein neuer Sprung gesetzt wurde.
      if (sourceHighlightLauf === meiner) ui.sourceHighlight = null;
    }, Math.max(0, h.until - Date.now()));
  }
}

/**
 * Löscht den Historie-Zwischenspeicher — beim Abmelden, damit die nächste Person an diesem
 * Gerät nicht die Journal-Einträge der Vorgängerin sieht (Akteurnamen, Zeitpunkte, Dokumentnamen
 * und `zitat` — verbatim Text aus deren Akte). `ui` ist modulweiter State und überlebt den Logout,
 * da dieser die Seite nicht neu lädt; ohne diesen Reset bliebe die Historie einfach stehen.
 */
export function clearHistorieCache(): void {
  ui.historieEintraege = [];
  ui.historieScroll = 0;
  ui.historieOffen = false;
  ui.historieDeskId = null;
  ui.historieNachSprung = false;
  // 14-01 (OPS-02, WR-02-Muster): dieselbe Begründung wie oben — ein offenes Systemdiagnose-
  // Overlay (Verbindungszustände, Systemversionen) gehört zur beendeten Sitzung und darf auf
  // einem geteilten Kanzleigerät nicht stehen bleiben.
  ui.systemdiagnoseOffen = false;
  // 14-05 (OPS-03, WR-02-Muster): dieselbe Begründung — eine offene Berechtigungsdiagnose
  // (Sicht eines ANDEREN Nutzers auf ein Objekt) gehört zur beendeten Sitzung.
  ui.berechtigungDialog = false;
}

/** Liegt der Zeiger über dem Papierkorb? (Drop-Erkennung beim Karten-Loslassen) */
export function pointerUeberKorb(clientX: number, clientY: number): boolean {
  const r = ui.trashRect;
  return !!r && clientX >= r.x && clientX <= r.x + r.w && clientY >= r.y && clientY <= r.y + r.h;
}

/**
 * Liefert die id der Zeitleiste, über deren Body-Fläche der Zeiger liegt — sonst `null`
 * (CHRONO-01, 09-01 Task 3; Muster pointerUeberKorb). Bei überlappenden Rechtecken gewinnt die mit
 * dem höchsten `zIndex` — also die zuletzt nach vorn geholte (oberste) Karte, wie bei jeder
 * anderen Kartenart (WR-01, 09-REVIEW.md: die Objektschlüssel-Reihenfolge von `zeitleisteRects`
 * folgt NICHT zuverlässig `bringToFront()`, deshalb der explizite Vergleich statt Iterationsreihenfolge).
 */
export function pointerUeberZeitleiste(clientX: number, clientY: number): string | null {
  let treffer: { id: string; zIndex: number } | null = null;
  for (const [id, r] of Object.entries(ui.zeitleisteRects)) {
    if (clientX < r.x || clientX > r.x + r.w || clientY < r.y || clientY > r.y + r.h) continue;
    if (!treffer || r.zIndex > treffer.zIndex) treffer = { id, zIndex: r.zIndex };
  }
  return treffer?.id ?? null;
}

/**
 * REF-03: setzt das Versionskompatibilitäts-Flag bei jedem Login/Verbindungsaufbau (aufgerufen
 * aus LoginScreen.svelte, wenn api.login()/api.setup() ein jlVersion-Ergebnis liefert). Ein neuer
 * Verbindungsaufbau hebt ein für die VORHERIGE Verbindung geschlossenes Banner wieder auf —
 * Session-Speicher gilt nur "pro Verbindungsaufbau" (planner_assumption, 01-07-PLAN.md), nicht
 * dauerhaft über Sessions hinweg.
 */
export function setJlVersionIncompatible(inkompatibel: boolean): void {
  ui.jlVersionIncompatible = inkompatibel;
  ui.jlVersionBannerGeschlossen = false;
  try {
    sessionStorage.removeItem(JL_VERSION_BANNER_KEY);
  } catch {
    // Session-Storage evtl. gesperrt — der In-Memory-Zustand oben reicht für diese Sitzung.
  }
}

/** Blendet das Versionskompatibilitäts-Banner für die laufende Verbindung aus (✕-Knopf). */
export function schliesseJlVersionBanner(): void {
  ui.jlVersionBannerGeschlossen = true;
  try {
    sessionStorage.setItem(JL_VERSION_BANNER_KEY, '1');
  } catch {
    // Best-Effort — bleibt zumindest für den Rest dieser Sitzung im In-Memory-State geschlossen.
  }
}

// ---- 403-Fallback-Toast (PERM-04, 02-08 Task 2) ----
// Die primäre Verteidigungslinie ist das Ausblenden gefährlicher Aktionen (darfAktionClient,
// store.svelte.ts) — dieser Toast ist ausschließlich der Fallback für Race Conditions (Rolle
// wurde serverseitig geändert, während die UI die Aktion noch anbot). Keine neue Toast-Variante,
// keine rote Fläche — dieselbe showToast()-Pipeline wie überall sonst (UI-SPEC).

/** Bekannte 403-Fälle (Copywriting Contract) — jeder unbekannte/nicht antizipierte Fall fällt
 *  auf denselben allgemeinen Wortlaut zurück wie 'allgemein' (fail-closed, kein Sonderfall vergessen).
 *  'fremdesObjekt'/'privateEbene' gab es hier einmal als Texte — seit WR-05 zeigt der
 *  Command-Pfad die präzise deutsche Server-Meldung (body.error) statt einer clientseitigen
 *  Zuordnung; die beiden toten Texte sind entfernt. Übrig bleiben die Fälle, deren Routen
 *  keinen eigenen Fehlertext liefern bzw. bei denen die UI bewusst einen eigenen Wortlaut
 *  setzt (Löschen, Upload, Verwaltung). */
export type Toast403Fall = 'allgemein' | 'loeschen' | 'upload' | 'verwaltung';

const TOAST_403_TEXT: Partial<Record<Toast403Fall, string>> = {
  loeschen: 'Endgültiges Löschen ist nur dem Eigentümer vorbehalten.',
  upload: 'Hochladen ist mit Ihrer Rolle nicht möglich.',
  verwaltung: 'Nur Eigentümer und Bearbeiter dürfen Rollen oder Ebenen verwalten.',
};

/** Zeigt den passenden 403-Fallback-Toast; `rolle` wird nur für den allgemeinen/unbekannten
 *  Fall interpoliert (Copywriting: „Ihre Rolle „{Rolle}" erlaubt das nicht."). */
export function toast403(fall: Toast403Fall | string, rolle?: Rolle | null): void {
  const text = TOAST_403_TEXT[fall as Toast403Fall];
  showToast(text ?? `Aktion nicht erlaubt — Ihre Rolle „${rolle ?? 'unbekannt'}" erlaubt das nicht.`);
}
