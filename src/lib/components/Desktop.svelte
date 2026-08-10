<script lang="ts">
  import { onMount } from 'svelte';
  import {
    freeDocs, screenToWorld, zoomAt, zoomToFit, allBoxes, panBy, docBox, stackBox, noteBox, cutoutBox, legalObjectBox, tableBox, zeitleisteBox, CARD_W,
    NOTE_KINDS, NOTE_W, NOTE_H, LEGAL_OBJECT_KINDS, LEGAL_W, LEGAL_H, deskBackground,
    type Box, type LegalObjectKind, type NoteKind, type Vec2, type Viewport,
  } from '@j-desk/core';
  import { deskCss, isLight } from '../deskThemes';
  import { uid } from '../uid';
  import { desktop, darfAktionClient, EBENE_ICON, filterByVisibleLayers, sortierteEbenenFuerPanel } from '../store.svelte';
  import { NOTE_KIND_LABELS, LEGAL_OBJECT_KIND_LABELS } from '../menus';
  import { clearSession } from '../session';
  import { revokeFileUrls } from '../fileCache';
  import { ui, clearHistorieCache, schliesseJlVersionBanner, setJlVersionIncompatible } from '../ui.svelte';
  import { ladeDateiHoch, aufAktiveEbeneSetzen } from '../upload';
  import type { SucheTreffer, VorschlagDto } from '../api';
  import { freigaben } from '../freigaben.svelte';
  import { debounce } from '../debounce';
  import { bannerText, bannerSichtbar, bannerBlockiert } from '../banner';
  import {
    fundstelleAusMark, fundstelleAusStamp, fundstelleAusCutout, fundstelleAusPdfTreffer, fundstelleAusOcrTreffer,
    zeichneFundstelleAuf,
  } from '../jump';
  import { pfeilAktion } from '../tastatur';
  import { zurueck, vor } from '../verlauf';
  import { kartenBewegungGesperrt } from '../sitzungsmodus';
  import DocCard from './DocCard.svelte';
  import StackCard from './StackCard.svelte';
  import NoteCard from './NoteCard.svelte';
  import LegalObjectCard from './LegalObjectCard.svelte';
  import TableCard from './TableCard.svelte';
  import ZeitleisteCard from './ZeitleisteCard.svelte';
  import CutoutCard from './CutoutCard.svelte';
  import LinkLayer from './LinkLayer.svelte';
  import ContextMenu from './ContextMenu.svelte';
  import DeskSwitcher from './DeskSwitcher.svelte';
  import DeskControls from './DeskControls.svelte';
  import TrashCan from './TrashCan.svelte';
  import LayerVisibilityPanel from './LayerVisibilityPanel.svelte';
  import HistoryOverlay from './HistoryOverlay.svelte';
  import ActivityOverlay from './ActivityOverlay.svelte';
  import AuswertungsPanel from './AuswertungsPanel.svelte';
  import KonfliktOverlay from './KonfliktOverlay.svelte';
  import ShareDialog from './ShareDialog.svelte';
  import SystemdiagnoseOverlay from './SystemdiagnoseOverlay.svelte';
  import BerechtigungsDialog from './BerechtigungsDialog.svelte';
  import UebergabeDialog from './UebergabeDialog.svelte';
  import AnlagenpaketDialog from './AnlagenpaketDialog.svelte';
  import SitzungsmappeDialog from './SitzungsmappeDialog.svelte';
  import VorschlaegeDialog from './VorschlaegeDialog.svelte';
  import SitzungsmodusShell from './SitzungsmodusShell.svelte';
  import ProvenancePopover from './ProvenancePopover.svelte';
  import PresenceRoster from './PresenceRoster.svelte';
  import VergleichsViewer from './VergleichsViewer.svelte';
  import ViewSwitcher from './ViewSwitcher.svelte';
  import FreigabenSignal from './FreigabenSignal.svelte';
  import BenachrichtigungenPanel from './BenachrichtigungenPanel.svelte';
  import EntwurfKarte from './EntwurfKarte.svelte';
  import Minimap from './Minimap.svelte';
  import ZonenOverlay from './ZonenOverlay.svelte';
  import AufnahmeDialog from './AufnahmeDialog.svelte';
  import VorlagenDialog from './VorlagenDialog.svelte';
  import AufraeumenDialog from './AufraeumenDialog.svelte';
  import CommandPalette from './CommandPalette.svelte';

  let { onlogout }: { onlogout: () => void } = $props();

  let vp = $state<Viewport>({ x: 0, y: 0, scale: 1 });
  let el: HTMLDivElement;
  let panning = $state(false);
  let spaceDown = $state(false);
  let fileInput: HTMLInputElement;
  let viewW = $state(0);
  let viewH = $state(0);

  // Erscheinungsbild des Schreibtischs (Farbe/Material/Regler) — Regler-Vorschau vor gespeichertem Zustand.
  const hintergrund = $derived(ui.backgroundPreview ?? deskBackground(desktop.state));
  const hintergrundStil = $derived(deskCss(hintergrund));

  // Ebenen-Umschalter (PERM-01): aktive Zeichen-Ebene neuer Objekte. „standard" ist das einzige
  // Werkzeug dieser Phase — die Pro-Werkzeug-Merkfähigkeit im Store steht für künftige,
  // feinere Werkzeugkontexte (z. B. je Zeichenwerkzeug im Radial-Menü) bereit.
  let ebenenMenuOffen = $state(false);
  let ebenenPanelOffen = $state(false);
  // VIEW-01 (11-08): Ansichten-Umschalter — eigener Öffnen-Zustand neben dem Ebenen-Umschalter,
  // damit der globale Escape-Handler das Dropdown mit den übrigen Menüs schließt.
  let ansichtenMenuOffen = $state(false);
  // Minikarte (UX-03, 13-05 Task 2): Sichtbarkeits-PRÄFERENZ als Browser-Anzeigeeinstellung in
  // localStorage (Schlüssel jdesk.minimapAn, Muster jdesk.deviceProfile) — bewusste Abweichung
  // von P5 (WR-02-Rücksetzbündel): eine reine Anzeige-Präferenz ohne personenbezogene Desk-
  // Information ist kein Sitzungszustand (anders als ui.verlauf, der geteilte Orientierung
  // TRÄGT und deshalb im Bündel steht — Precedent jdesk.deviceProfile, kein Desk-Bezug,
  // Planner-Annahme, Abnahme im UAT).
  const MINIMAP_KEY = 'jdesk.minimapAn';
  function leseMinimapAn(): boolean {
    try {
      return localStorage.getItem(MINIMAP_KEY) === '1';
    } catch {
      return false; // Speicher evtl. gesperrt (privates Fenster) — Minikarte startet geschlossen.
    }
  }
  let minimapAn = $state(leseMinimapAn());
  function toggleMinimap(): void {
    minimapAn = !minimapAn;
    try { localStorage.setItem(MINIMAP_KEY, minimapAn ? '1' : '0'); } catch { /* Best-Effort */ }
  }
  const ebenenFuerUmschalter = $derived(sortierteEbenenFuerPanel(desktop.state));
  const aktiveEbene = $derived(
    ebenenFuerUmschalter.find((e) => e.id === desktop.currentLayerId) ?? ebenenFuerUmschalter[0],
  );

  // Sichtbarkeits-Culling: Karten weit außerhalb des Fensters verlassen das DOM.
  // Der Puffer sorgt dafür, dass beim Schwenken nichts sichtbar „aufpoppt".
  const CULL_MARGIN = 300;
  const sichtfenster = $derived.by(() => ({
    x0: -vp.x / vp.scale - CULL_MARGIN,
    y0: -vp.y / vp.scale - CULL_MARGIN,
    x1: (viewW - vp.x) / vp.scale + CULL_MARGIN,
    y1: (viewH - vp.y) / vp.scale + CULL_MARGIN,
  }));
  function imSichtfenster(b: Box): boolean {
    if (viewW === 0) return true; // vor der ersten Messung nichts verstecken
    return b.x + b.w >= sichtfenster.x0 && b.x <= sichtfenster.x1
      && b.y + b.h >= sichtfenster.y0 && b.y <= sichtfenster.y1;
  }

  // Sichtbarkeits-Panel (PERM-01/PERM-02): reiner Anzeigefilter über bereits vom Server
  // projizierte Daten — KEINE Sicherheitsgrenze (siehe filterByVisibleLayers-Kommentar).
  const sichtbareDocs = $derived(filterByVisibleLayers(freeDocs(desktop.state), desktop.visibleLayers, desktop.state));
  const sichtbareStacks = $derived(filterByVisibleLayers(desktop.state.stacks, desktop.visibleLayers, desktop.state));
  const sichtbareNotes = $derived(filterByVisibleLayers(desktop.state.notes ?? [], desktop.visibleLayers, desktop.state));
  const sichtbareCutouts = $derived(filterByVisibleLayers(desktop.state.cutouts ?? [], desktop.visibleLayers, desktop.state));
  const sichtbareLegalObjects = $derived(filterByVisibleLayers(desktop.state.legalObjects ?? [], desktop.visibleLayers, desktop.state));
  const sichtbareTables = $derived(filterByVisibleLayers(desktop.state.tables ?? [], desktop.visibleLayers, desktop.state));
  const sichtbareZeitleisten = $derived(filterByVisibleLayers(desktop.state.zeitleisten ?? [], desktop.visibleLayers, desktop.state));

  // Virtuelle Entwurfs-Karten ausstehender KI-Vorschläge (12-07, AI-01): Entwürfe kommen
  // bewusst NICHT aus dem DesktopState (Register-Entscheidung A2, 12-RESEARCH.md Pattern 1) —
  // sie leben ausschließlich im freigaben-Zustand und verschwinden mit dem Nachladen nach
  // einer Entscheidung von allein. Montage auf derselben Tischebene wie die regulären Karten
  // (kein neuer Layer-Mechanismus); smartphone-frei strukturell über die MOBILE-02-Weiche in
  // +page.svelte (dort wird SmartphoneSchnellzugriff statt dieser Komponente gemountet).
  const entwurfVorschlaege = $derived(freigaben.vorschlaege.filter((v) => v.status === 'ausstehend'));

  /** Tischposition einer Entwurfs-Karte je Vorschlags-art (payload-Formen aus
   *  packages/core/src/vorschlagAnwenden.ts): trägt das payload eine eigene Flächenposition
   *  (addNote/extractPage/moveDoc/moveStack/removeFromStack), zeigt die Karte exakt dorthin
   *  (der Entwurf markiert die Zielposition); Ordnungs-arten ohne eigene Flächenposition
   *  werden NEBEN dem zuerst betroffenen Objekt gerendert. Ohne auflösbaren Positionsbezug
   *  (Objekt zwischenzeitlich weg) entsteht keine Karte — der Vorschlag bleibt im Dialog. */
  function entwurfPosition(v: VorschlagDto): Vec2 | null {
    const p = v.payload;
    const s = desktop.state;
    const pos = p.position as { x?: unknown; y?: unknown } | undefined;
    if (pos && typeof pos.x === 'number' && typeof pos.y === 'number') return { x: pos.x, y: pos.y };
    const vonObjekt = (id: unknown): Vec2 | null => {
      if (typeof id !== 'string' || id === '') return null;
      const doc = s.docs.find((d) => d.id === id);
      if (doc) return doc.position;
      const stack = s.stacks.find((st) => st.id === id);
      if (stack) return stack.position;
      const note = (s.notes ?? []).find((n) => n.id === id);
      if (note) return note.position;
      return null;
    };
    let basis: Vec2 | null = null;
    switch (v.art) {
      case 'stackDocs':
        basis = vonObjekt(p.targetId) ?? vonObjekt(p.draggedId);
        break;
      case 'addLink':
        basis = vonObjekt(p.fromId) ?? vonObjekt(p.toId);
        break;
      case 'addClip':
        basis = vonObjekt(p.aId) ?? vonObjekt(p.bId);
        break;
      case 'dissolveStack':
      case 'renameStack':
      case 'stapleStack':
      case 'unstapleStack':
        basis = vonObjekt(p.stackId);
        break;
      case 'addStamp':
      case 'addFlag':
        // CR-01: flache Register-Form — die docId liegt auf Top-Ebene (kanonische
        // Register-Wahrheit, verschachtelt ist nur die Kommando-Form).
        basis = vonObjekt(p.docId);
        break;
      case 'trashObject':
        basis = vonObjekt(p.objectId);
        break;
      case 'editNote':
      case 'setNoteDone':
        basis = vonObjekt(p.id);
        break;
      case 'setLinkNote': {
        const link = s.links.find((l) => l.id === p.linkId);
        basis = link ? (vonObjekt(link.fromId) ?? vonObjekt(link.toId)) : null;
        break;
      }
      case 'restoreObject': {
        // Das betroffene Objekt liegt im Papierkorb — Position aus dem gesicherten Payload.
        const eintrag = (s.trash ?? []).find((t) => t.id === p.trashId);
        const payload = eintrag?.payload;
        basis = payload?.docs[0]?.position ?? payload?.notes[0]?.position
          ?? payload?.stacks[0]?.position ?? payload?.cutouts[0]?.position ?? null;
        break;
      }
    }
    if (!basis) return null;
    // Neben das betroffene Objekt gerückt (Karte = Vorschau am Objekt, keine Überdeckung).
    return { x: basis.x + CARD_W + 24, y: basis.y };
  }

  // Mausrad zoomt zum Cursor (statt zu schwenken).
  function onWheel(e: WheelEvent) {
    // SESS-01 (11-01 Task 2): Rücksprung VOR preventDefault(), damit der Browser bei aktiver
    // Verschiebe-Sperre sein Standardverhalten (z. B. Seiten-Scroll) behält statt eine
    // unterdrückte Geste ins Leere laufen zu lassen.
    if (kartenBewegungGesperrt()) return;
    e.preventDefault();
    vp = zoomAt(vp, { x: e.clientX, y: e.clientY }, Math.exp(-e.deltaY * 0.0015));
  }

  // Pointer-Verfolgung: Ein Finger/Maus schwenkt, zwei Finger pinchen+schwenken.
  const pointers = new Map<number, { x: number; y: number }>();
  let panLast: { x: number; y: number } | null = null;
  let pinchLast = 0;

  function onPointerDown(e: PointerEvent) {
    if (kartenBewegungGesperrt()) return; // SESS-01 (11-01 Task 2): Tisch-Pan/Pinch-Start unterbunden
    if (e.button !== 0) return;
    // Erster Finger nur auf freier Fläche; weitere Finger dürfen von Karten kommen
    // (die Karte reicht sie durch, solange der Desk schon pannt — Pinch-Beitritt).
    if (e.target !== el && pointers.size === 0) return;
    el.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    ui.deskPointers = pointers.size;
    if (pointers.size === 1) { panning = true; panLast = { x: e.clientX, y: e.clientY }; }
  }
  // Lupe folgt dem Zeiger (auch ohne gedrückte Taste)
  const LUPE = 260;
  let lupePos = $state<{ x: number; y: number } | null>(null);
  const lupenVp = $derived.by(() => {
    if (!lupePos) return null;
    const z = vp.scale * 2.5;
    const w = screenToWorld(vp, lupePos);
    return { x: LUPE / 2 - w.x * z, y: LUPE / 2 - w.y * z, scale: z };
  });

  function onPointerMove(e: PointerEvent) {
    if (kartenBewegungGesperrt()) return; // SESS-01 (11-01 Task 2): Tisch-Pan/Pinch unterbunden
    if (ui.lupe) lupePos = { x: e.clientX, y: e.clientY };
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1 && panLast) {
      vp = panBy(vp, e.clientX - panLast.x, e.clientY - panLast.y);
      panLast = { x: e.clientX, y: e.clientY };
    } else if (pointers.size === 2) {
      const p = Array.from(pointers.values());
      const dist = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
      const mid = { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 };
      if (pinchLast) vp = zoomAt(vp, mid, dist / pinchLast);
      pinchLast = dist;
      panLast = null;
    }
  }
  // SESS-01 (11-01 Task 2): bewusst OHNE Verschiebe-Sperre-Prüfung — endPointer räumt nur Zeiger
  // auf (pointerup/pointercancel) und darf nie hängen bleiben, auch wenn die Sperre während
  // eines laufenden Pans aktiviert würde.
  function endPointer(e: PointerEvent) {
    pointers.delete(e.pointerId);
    ui.deskPointers = pointers.size;
    if (pointers.size < 2) pinchLast = 0;
    if (pointers.size === 0) { panning = false; panLast = null; }
    else if (pointers.size === 1) { const p = Array.from(pointers.values())[0]; panLast = { x: p.x, y: p.y }; }
  }

  function fitAll() {
    vp = zoomToFit(allBoxes(desktop.state), { w: el.clientWidth, h: el.clientHeight });
  }

  function onFilesPicked(): void {
    const files = Array.from(fileInput.files ?? []);
    fileInput.value = '';
    const center = screenToWorld(vp, { x: el.clientWidth / 2, y: el.clientHeight / 2 });
    // Nebeneinander statt fast deckungsgleich — mehrere Uploads sollen sofort unterscheidbar sein (UAT A1.2).
    files.forEach((f, i) => void ladeDateiHoch(f, { x: center.x + i * (CARD_W + 24), y: center.y + i * 8 }));
  }

  function onDragOver(e: DragEvent): void {
    // SESS-01 (11-01 Task 2): Rücksprung VOR preventDefault(), damit der Browser bei aktiver
    // Verschiebe-Sperre sein Standardverhalten behält statt eine unterdrückte Geste ins Leere
    // laufen zu lassen (dieselbe Begründung wie bei onWheel).
    if (kartenBewegungGesperrt()) return;
    e.preventDefault();
  }

  /** Zettel anlegen (am Weltpunkt, sonst Bildschirmmitte) und sofort in den Bearbeiten-Modus gehen. */
  function zettelAnlegen(kind: NoteKind, customLabel?: string, weltPunkt?: Vec2): void {
    const mitte = weltPunkt ?? screenToWorld(vp, { x: el.clientWidth / 2, y: el.clientHeight / 2 });
    const id = uid();
    void desktop
      .command('addNote', {
        kind, text: '', position: { x: mitte.x - NOTE_W / 2, y: mitte.y - NOTE_H / 2 }, id,
        ...(customLabel !== undefined ? { customLabel } : {}),
      })
      .then(() => {
        ui.editingNoteId = id;
        aufAktiveEbeneSetzen(id);
      });
  }

  /** Juristisches Objekt anlegen (LEGAL-01) — dünnster Pfad (Task 1): kein sofortiges
   *  Bearbeiten-Öffnen wie bei Zetteln, die Karte trägt hier noch keine Bearbeitungsfunktion. */
  function legalObjectAnlegen(kind: LegalObjectKind, weltPunkt: Vec2): void {
    const id = uid();
    void desktop
      .command('addLegalObject', {
        kind, text: '', position: { x: weltPunkt.x - LEGAL_W / 2, y: weltPunkt.y - LEGAL_H / 2 }, id,
      })
      .then(() => {
        aufAktiveEbeneSetzen(id);
      });
  }

  /** Juristisches-Objekt-Typ wählen (zweispaltig, eigener Namensraum getrennt vom
   *  Zettel-Untermenü, 08-UI-SPEC.md Kernentscheidung) — Auswahl legt die Karte an der
   *  Position an, die den ＋-Menü-Klick auslöste (x, y in Bildschirmkoordinaten). */
  function juristischesObjektAuswahl(x: number, y: number): void {
    const welt = screenToWorld(vp, { x, y });
    ui.menu = {
      x, y, columns: 2,
      items: LEGAL_OBJECT_KINDS.map((kind: LegalObjectKind) => ({
        label: LEGAL_OBJECT_KIND_LABELS[kind],
        action: () => legalObjectAnlegen(kind, welt),
      })),
    };
  }

  /** Tabellenkarte anlegen (CALC-01, 08-07) — Sofortverhalten wie der bestehende Datei-Upload:
   *  kein Zwischendialog, die Karte erscheint sofort an der Klickposition mit einer leeren
   *  Platzhalterzeile (bereits in addTable() aus 08-06 angelegt). */
  function tabelleAnlegen(x: number, y: number): void {
    const welt = screenToWorld(vp, { x, y });
    const id = uid();
    void desktop.command('addTable', { position: welt, id }).then(() => aufAktiveEbeneSetzen(id));
  }

  /** Zeitleistenkarte anlegen (CHRONO-01, 09-01) — Sofortverhalten wie die Tabellenkarte: kein
   *  Zwischendialog, die Karte erscheint sofort geöffnet an der Klickposition (addZeitleiste()
   *  legt sie bereits geöffnet an, da eine leere Zeitleiste ohne sichtbare Achse nichts aussagt). */
  function zeitleisteAnlegen(x: number, y: number): void {
    const welt = screenToWorld(vp, { x, y });
    const id = uid();
    void desktop.command('addZeitleiste', { position: welt, id }).then(() => aufAktiveEbeneSetzen(id));
  }

  /** Doppelklick/Doppeltipp auf freie Tischfläche → Notizzettel an Ort und Stelle (Quickwin F4). */
  function onDeskDblClick(e: MouseEvent): void {
    const t = e.target as HTMLElement;
    if (t.closest('.card, .viewer, .note, .stack, .cutout, .abbild, .entwurf, button, input, textarea, .menu, .panel')) return;
    zettelAnlegen('notiz', undefined, screenToWorld(vp, { x: e.clientX, y: e.clientY }));
  }

  // Volltextsuche (SEARCH-01/04, 07-01 — ersetzt die frühere rein-clientseitige Kartensuche
  // aus Quickwin F5): Suchfeld oben mittig bleibt unverändert, die Trefferliste kommt jetzt
  // debounced vom Server (bereits sichtbarkeitsgefiltert über projectStateForActor).
  let sucheOffen = $state(false);
  let suchText = $state('');
  let pulsBox = $state<Box | null>(null);
  let pulsTimer: ReturnType<typeof setTimeout> | undefined;

  type Treffer = SucheTreffer;
  let treffer = $state<Treffer[]>([]);
  // Race-Schutz: nur die Antwort der ZULETZT ABGESENDETEN Anfrage darf die Liste ersetzen —
  // der Wert wird beim tatsächlichen Absenden festgehalten, nicht beim Debounce-Trigger.
  let sucheAnfrageZaehler = 0;
  // Zustände unter dem Suchfeld (07-UI-SPEC.md Copywriting Contract): laufen nur, solange keine
  // neuere Anfrage gestartet wurde (Zähler-Guard), damit eine veraltete Antwort weder die Liste
  // noch diese Flags mehr verändert.
  let suchLaeuft = $state(false);
  let suchFehler = $state(false);
  // Für den Retry-Button unten: derselbe Text, der beim letzten (fehlgeschlagenen) Versuch galt —
  // ein erneuter Klick soll exakt diese Anfrage wiederholen, nicht den evtl. seither geänderten suchText.
  let letzterSuchText = '';

  async function fuehreSucheAus(text: string): Promise<void> {
    const api = desktop.api;
    const deskId = desktop.deskId;
    letzterSuchText = text;
    // Fail-honest (07-UI-SPEC.md): ohne Verbindung wird gar nicht erst versucht — das Suchfeld
    // ist in diesem Fall bereits deaktiviert, ein evtl. noch offener Debounce darf trotzdem
    // keine stille Anfrage mehr auslösen.
    if (!api || !deskId || desktop.status !== 'online') return;
    const eigeneAnfrageId = ++sucheAnfrageZaehler;
    suchLaeuft = true;
    suchFehler = false;
    try {
      const { treffer: serverTreffer } = await api.suche(deskId, text);
      if (eigeneAnfrageId !== sucheAnfrageZaehler) return; // veraltete Antwort verwerfen
      treffer = serverTreffer;
    } catch {
      if (eigeneAnfrageId !== sucheAnfrageZaehler) return; // veraltete Antwort verwerfen
      suchFehler = true;
    } finally {
      if (eigeneAnfrageId === sucheAnfrageZaehler) suchLaeuft = false;
    }
  }

  function sucheWiederholen(): void {
    void fuehreSucheAus(letzterSuchText);
  }

  const sucheDebounced = debounce(250, (text: string) => void fuehreSucheAus(text));

  $effect(() => {
    const text = suchText.trim();
    if (text === '') {
      // Kein leerer/nur-Leerzeichen-Text löst eine Serveranfrage aus; eine noch laufende
      // Anfrage wird durch den Zähler-Sprung ungültig, sobald sie zurückkommt.
      sucheDebounced.cancel();
      sucheAnfrageZaehler += 1;
      treffer = [];
      suchLaeuft = false;
      suchFehler = false;
      return;
    }
    sucheDebounced(text);
  });

  // WR-02-Muster (CR-01, 07-Review): das Such-Panel gehört zum jeweiligen Desk, nicht zur
  // Sitzung — <Desktop> wird nur beim Logout unmountet, nie bei einem Desk-Wechsel. Ohne diesen
  // Reset blieben Suchtext und Treffer (Snippet-Text, Labels, Ersteller) von Desk A nach dem
  // Wechsel zu Desk B sichtbar stehen (SEARCH-04-Verstoß).
  $effect(() => {
    void desktop.deskId; // Abhängigkeit: jeder Desk-Wechsel setzt das Panel zurück
    sucheDebounced.cancel();
    sucheAnfrageZaehler += 1;
    sucheOffen = false;
    suchText = '';
    treffer = [];
    suchFehler = false;
    suchLaeuft = false;
  });

  /** Badge-Text der Trefferzeile: Art, optional „· Seite N" bei Fundstellen-Treffern (die einen
   *  page-Wert tragen), optional „· unsicher" bei einem OCR-Treffer auf einer niedrig-konfidenten
   *  Seite (Feld wird erst in 07-06 tatsächlich befüllt — die Darstellung nimmt das vorweg). */
  function artBadge(t: Treffer): string {
    let text: string = t.art;
    if (t.page !== undefined) text += ` · Seite ${t.page}`;
    if (t.art === 'OCR' && t.ocrUnsicher) text += ' · unsicher';
    return text;
  }

  /** Metazeile „Ersteller · Datum" (macht Ersteller-/Datums-Treffer nachvollziehbar, SEARCH-01) —
   *  fehlt ein Feld, erscheint nur das vorhandene ohne Ersatztext und ohne einsamen Trennpunkt;
   *  fehlen beide, bleibt die Zeile leer (kein Rendern, siehe Markup unten). */
  function metaZeile(t: Treffer): string {
    const teile: string[] = [];
    if (t.ersteller) teile.push(t.ersteller);
    if (t.datum) teile.push(formatDatum(t.datum));
    return teile.join(' · ');
  }

  /** Datum in deutscher Punktschreibweise (TT.MM.JJJJ) — gleiches Muster wie tag()/uhrzeit() in HistoryOverlay.svelte. */
  function formatDatum(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }

  /** Zentriert die Ansicht auf eine Weltbox und lässt sie kurz pulsieren (Kartensuche + Sprung zur Quelle teilen sich diese Leitung). */
  function springeZuBox(box: Box): void {
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    const s = vp.scale < 0.5 ? 0.8 : vp.scale;
    vp = { scale: s, x: viewW / 2 - cx * s, y: viewH / 2 - cy * s };
    pulsBox = box;
    clearTimeout(pulsTimer);
    pulsTimer = setTimeout(() => (pulsBox = null), 2000);
  }

  /** Box für Karten-/Stapel-/Zettel-Treffer weiterhin lokal aus dem geladenen State aufgelöst
   *  (der Server liefert nur objId, kein Rect). */
  function boxFuerTreffer(t: Treffer): Box | null {
    if (t.objId === undefined) return null;
    const s = desktop.state;
    if (t.art === 'Karte') {
      const d = s.docs.find((x) => x.id === t.objId);
      return d ? docBox(d) : null;
    }
    if (t.art === 'Stapel') {
      const st = s.stacks.find((x) => x.id === t.objId);
      return st ? stackBox(st) : null;
    }
    if (t.art === 'Zettel') {
      const n = (s.notes ?? []).find((x) => x.id === t.objId);
      return n ? noteBox(n) : null;
    }
    // WR-03 (09-REVIEW.md): 'Zeitleiste' fehlte hier — ein Sprungziel für die Suche über den
    // fest indizierten Kartentitel (indexZeileFuer, searchSync.ts), sonst bliebe ein Zeitleisten-
    // Treffer trotz sichtbarem Badge ohne Klickwirkung.
    if (t.art === 'Zeitleiste') {
      const z = (s.zeitleisten ?? []).find((x) => x.id === t.objId);
      return z ? zeitleisteBox(z) : null;
    }
    return null;
  }

  /** Box einer Karte oder eines Stapels über eine Objekt-id (Link.fromId/toId können beides sein). */
  function boxFuerObjektId(id: string): Box | null {
    const s = desktop.state;
    const d = s.docs.find((x) => x.id === id);
    if (d) return docBox(d);
    const st = s.stacks.find((x) => x.id === id);
    return st ? stackBox(st) : null;
  }

  /** Verknüpfungs-Treffer: Box der fromId-Karte/-Stapels, sonst der toId-Karte/-Stapels — existiert
   *  keins mehr, bleibt der Klick ohne Sprung (T-07-15: keine Existenzaussage über ein für den
   *  Betrachter unsichtbares Zielobjekt, kein Toast, kein Hinweis). */
  function boxFuerLinkTreffer(t: Treffer): Box | null {
    const link = desktop.state.links.find((x) => x.id === t.objId);
    if (!link) return null;
    return boxFuerObjektId(link.fromId) ?? boxFuerObjektId(link.toId);
  }

  /** Klick-Weiche nach Treffer-Art (07-UI-SPEC.md Navigations-Kontrakt): Karte/Stapel/Zettel/
   *  Verknüpfung zentrieren+pulsen die Karte (bestehendes springeZuBox()); Markierung/Stempel/
   *  Ausschnitt/PDF-Text/OCR pulsen die exakte (bzw. bei PDF-Text/OCR: die ganze) Fundstelle über
   *  desktop.jumpTo(). Das Panel schließt in jedem Fall — auch wenn das Zielobjekt nicht mehr
   *  auflösbar ist (kein Toast in diesem Fall: T-07-15). */
  function springe(t: Treffer): void {
    schliesseSuche();
    switch (t.art) {
      case 'Karte':
      case 'Stapel':
      case 'Zettel':
      case 'Zeitleiste': {
        const box = boxFuerTreffer(t);
        if (box) springeZuBox(box);
        return;
      }
      case 'Verknüpfung': {
        const box = boxFuerLinkTreffer(t);
        if (box) springeZuBox(box);
        return;
      }
      case 'Markierung': {
        const m = (desktop.state.marks ?? []).find((x) => x.id === t.objId);
        if (m) void desktop.jumpTo(fundstelleAusMark(m));
        return;
      }
      case 'Stempel': {
        const s = (desktop.state.stamps ?? []).find((x) => x.id === t.objId);
        if (s) void desktop.jumpTo(fundstelleAusStamp(s));
        return;
      }
      case 'Ausschnitt': {
        const c = (desktop.state.cutouts ?? []).find((x) => x.id === t.objId);
        if (c) void desktop.jumpTo(fundstelleAusCutout(c));
        return;
      }
      case 'PDF-Text':
        void desktop.jumpTo(fundstelleAusPdfTreffer({ docId: t.docId, fileId: t.fileId, page: t.page ?? 1 }));
        return;
      case 'OCR':
        void desktop.jumpTo(fundstelleAusOcrTreffer({ docId: t.docId, fileId: t.fileId, page: t.page ?? 1 }));
        return;
    }
  }

  // Sprung zur Quelle (store.svelte.ts::jumpTo): dieselbe Zentrier-Leitung wie die Kartensuche.
  $effect(() => {
    const req = ui.jumpRequest;
    if (!req) return;
    springeZuBox(req.box);
    // Positions-Verlauf (UX-03, 13-05 Task 1): NUR dieser Pfad (ui.jumpRequest, gesetzt von
    // desktop.jumpTo()) ist ein „Fundstelle"-Sprung — die Kartensuche (springe(), Zeile oben) ruft
    // springeZuBox() für Karten/Stapel/Zettel direkt auf, ohne über ui.jumpRequest zu gehen, und
    // zeichnet bewusst nicht auf (kein Fundstellen-Sprung im UI-SPEC-Sinn). `vp` ist hier bereits
    // der frisch zentrierte Wert aus springeZuBox() — jump.ts/store.svelte.ts kennen viewW/viewH
    // nicht und können ihn nicht selbst berechnen.
    const docId = ui.docJumpTarget;
    const doc = docId ? desktop.state.docs.find((d) => d.id === docId) : undefined;
    if (doc) {
      zeichneFundstelleAuf(vp, doc.name, doc.page ?? 1);
      // 13-09 (UX-04): „Quelle öffnen" braucht das docId+Seite-Ausführungsziel — VerlaufEintrag
      // trägt bewusst nur vp+Label (13-05), kein docId, darum dieses eigene ui-Feld direkt neben
      // dem Verlaufseintrag gesetzt (derselbe Sprung-Auslöser, zwei Konsumenten).
      ui.letzteFundstelle = { docId: doc.id, page: doc.page ?? 1 };
    }
    ui.jumpRequest = null;
  });

  function schliesseSuche(): void {
    sucheOffen = false;
    suchText = '';
  }

  /** Zettel-Typ wählen (zweispaltig); „Eigener…" fragt das Badge im Menü ab. */
  function zettelTypAuswahl(x: number, y: number): void {
    ui.menu = {
      x, y, columns: 2,
      items: NOTE_KINDS.map((kind: NoteKind) => ({
        label: kind === 'eigen' ? 'Eigener…' : NOTE_KIND_LABELS[kind],
        action: kind === 'eigen'
          ? () => queueMicrotask(() => {
              ui.menu = { x, y, items: [], input: { placeholder: 'Bezeichnung (z. B. Zeugenfrage)', onSubmit: (t) => zettelAnlegen('eigen', t), onEscape: () => zettelTypAuswahl(x, y) } };
            })
          : () => zettelAnlegen(kind),
      })),
    };
  }

  /** „＋"-Menü: Datei-Upload oder Zettel anlegen. Das Zettel-Untermenü ersetzt den Menüinhalt
   *  erst, nachdem ContextMenu.svelte den Klick verarbeitet (und ui.menu synchron auf null setzt) —
   *  daher die Verzögerung auf den nächsten Tick statt einer echten Verschachtelung. */
  function plusMenu(e: MouseEvent): void {
    const x = e.clientX;
    const y = e.clientY;
    const items = [
      // 02-08 (PERM-04): Upload ist eine gefährliche/rollengebundene Aktion (Eigentümer+Bearbeiter,
      // roles.ts MATRIX) — fehlt bei fehlendem Recht vollständig statt nur deaktiviert zu sein.
      ...(darfAktionClient(desktop.currentRolle, 'upload') ? [{ label: 'Datei…', action: () => fileInput.click() }] : []),
      { label: 'Zettel…', action: () => queueMicrotask(() => zettelTypAuswahl(x, y)) },
      { label: 'Juristisches Objekt…', action: () => queueMicrotask(() => juristischesObjektAuswahl(x, y)) },
      // CALC-01 (08-07): kein Untermenü — Sofort-Erzeugung wie beim Datei-Upload.
      { label: 'Tabelle…', action: () => tabelleAnlegen(x, y) },
      // CHRONO-01 (09-01): dieselbe Sofort-Erzeugung wie „Tabelle…".
      { label: 'Zeitleiste…', action: () => zeitleisteAnlegen(x, y) },
    ];
    ui.menu = { x, y, items };
  }

  async function abmelden(): Promise<void> {
    if (!confirm('Wirklich abmelden?')) return; // Nutzerentscheidung UAT A1.9
    // Server-Invalidierung ist Best-Effort — lokal wird die Sitzung in jedem Fall beendet.
    await desktop.api?.logout().catch(() => {});
    clearSession();
    revokeFileUrls();
    clearHistorieCache();
    setJlVersionIncompatible(false); // REF-03: Banner ist an DIESE Verbindung gebunden, nicht dauerhaft
    await desktop.stop();
    onlogout();
  }

  function onDrop(e: DragEvent): void {
    if (kartenBewegungGesperrt()) return; // SESS-01 (11-01 Task 2): kein Datei-Drop bei aktiver Sperre
    e.preventDefault();
    const files = Array.from(e.dataTransfer?.files ?? []);
    const world = screenToWorld(vp, { x: e.clientX, y: e.clientY });
    files.forEach((f, i) => void ladeDateiHoch(f, { x: world.x + i * (CARD_W + 24), y: world.y + i * 8 }));
  }

  onMount(() => {
    desktop.wechsleWerkzeug('standard'); // lädt die zuletzt gewählte Ebene für dieses Werkzeug
    const down = (e: KeyboardEvent) => {
      // Bei offenem Historie-, Konflikt- oder Palette-Overlay gehören die Tasten dem Overlay:
      // Pfeile scrollten sonst den Tisch DAHINTER statt die Liste, Cmd-F öffnete die Kartensuche
      // hinter dem Modal. Escape bleibt bewusst durchlässig — das jeweilige Overlay schließt
      // sich selbst, und die Zeilen darunter räumen nebenbei Lupe/Kontextmenü auf. 13-09
      // (UX-04): ui.paletteOffen reiht sich in dieselbe Vorrang-Bedingung ein — die offene
      // Palette absorbiert ⌘F/⌥←/Pfeile (13-RESEARCH.md Shortcut-Befund).
      if ((ui.historieOffen || ui.konflikt || ui.paletteOffen) && e.code !== 'Escape') return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault(); // Desk-Suche statt Browser-Suche
        sucheOffen = true;
        return;
      }
      // UX-04 (13-09): ⌘K öffnet die Command Palette — nachweislich frei (kein KeyK-Handler im
      // Bestand, 13-RESEARCH.md Shortcut-Tabelle), Form identisch zum ⌘F-Zweig oben. Im
      // Sitzungsmodus wirkungslos (kein Fehler — die Phase-11-Chrome bleibt bestehen); auf dem
      // Smartphone-Profil montiert +page.svelte Desktop.svelte gar nicht, der Zweig ist dort
      // strukturell unerreichbar.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (!ui.sitzungsmodusAktiv) ui.paletteOffen = true;
        return;
      }
      // LEGAL-03 (08-05): ⌥⇧A öffnet das Auswertungs-Panel — kollisionsfrei geprüft (kein
      // bestehender altKey-Handler in src/lib, s. 08-05-PLAN.md Annahme A3).
      if (e.altKey && e.shiftKey && e.code === 'KeyA') {
        e.preventDefault();
        ui.auswertungOffen = true;
        return;
      }
      if (e.code === 'Space') spaceDown = true;
      if (e.code === 'Escape') {
        ui.linkingFromId = null;
        ui.clippingFromId = null;
        ui.taskRefFromId = null; // TASK-01, Task 3: „Bezug zu Dokument…"-Auswahlmodus abbrechen
        ui.tabelleBelegFuer = null; // CALC-01, 08-07 Task 3: „+ Beleg verknüpfen"-Auswahlmodus abbrechen
        // CHRONO-01/COMP-01/COMP-03 (09-01 Task 3): jeder neue Zwei-Klick-/Entwurfs-Modus steht
        // hier — ein hier fehlender Modus überlebt einen Escape-Druck.
        ui.zeitleisteEintragFuer = null;
        ui.zeitleisteEintragEntwurf = null;
        ui.compareFromId = null;
        ui.versionFromId = null;
        // 13-05 (UX-03, P5): das Zonen-Kontextmenü/die Inline-Umbenennen-Eingabe (ZonenOverlay.svelte)
        // führt KEINEN neuen ui-Modus ein — beides läuft über ui.menu, das hier bereits zurückgesetzt
        // wird. Geprüft, kein neuer Modus außerhalb von ui.menu.
        ui.menu = null;
        ui.lupe = false; // Lupe auch per Escape ausschalten (Nutzerwunsch)
        schliesseSuche();
        ebenenMenuOffen = false;
        ebenenPanelOffen = false;
        ansichtenMenuOffen = false; // VIEW-01 (11-08): Ansichten-Dropdown schließt per Escape mit
        ui.auswertungOffen = false; // LEGAL-03 (08-05): Auswertungs-Panel schließt per Escape mit
        // 06-03: Präsenz-Rosette schließt per Escape identisch zum Ebenen-Umschalter oben —
        // ui.praesenzOffen statt lokalem State, da PresenceRoster.svelte eine eigene
        // Komponente ist und dieser globale Tastatur-Listener hier in Desktop.svelte lebt.
        ui.praesenzOffen = false;
        // 13-01 (NOTIF-01): das Inbox-Panel schließt per Escape identisch zur Rosette oben
        // (BenachrichtigungenPanel.svelte ist eine eigene Komponente, UI-SPEC „Escape/
        // Backdrop schließt") — P5: ein hier fehlender Modus überlebt einen Escape-Druck.
        ui.inboxOffen = false;
        // 13-09 (UX-04): die Command Palette hat zusätzlich ihre EIGENE Escape-Behandlung
        // (svelte:window in CommandPalette.svelte, Dialog-Klasse) — dieser Eintrag hier deckt
        // den Fall ab, dass Escape woanders im Bestand ausgelöst wird, während die Palette
        // offen ist (P5: kein hier fehlender Modus überlebt einen Escape-Druck).
        ui.paletteOffen = false;
      }
      if (e.code === 'ArrowUp' || e.code === 'ArrowDown' || e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
        // Ein fokussierter Viewer blättert mit den Pfeilen selbst; Eingabefelder behalten ihre
        // Cursor-Tasten — dieser Guard gilt für ALLE Pfeil-Aktionen (auch ⌥←/⌥→-Verlaufssprünge:
        // in einem Textfeld darf ⌥← nicht navigieren).
        const a = document.activeElement;
        if (a instanceof HTMLElement && (a.closest('.viewer') || a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')) return;
        // Modifier-Guard (Pflicht-Korrektur, 13-RESEARCH.md Shortcut-Befund, T-13-05-02): pfeilAktion
        // entscheidet VOR jedem Pan/Verlaufs-Sprung strukturell, welche (genau eine) Aktion greift —
        // ohne diesen Guard würden ⌥← gleichzeitig pannen UND im Verlauf zurücknavigieren.
        const aktion = pfeilAktion(e);
        if (aktion === 'verlauf-zurueck' || aktion === 'verlauf-vor') {
          e.preventDefault();
          const naechster = aktion === 'verlauf-zurueck' ? zurueck(ui.verlauf) : vor(ui.verlauf);
          if (naechster.zeiger !== ui.verlauf.zeiger) {
            ui.verlauf = naechster;
            vp = naechster.eintraege[naechster.zeiger].vp; // instant, kein Tween (Bestandskonvention)
          }
          return;
        }
        if (aktion !== null) {
          e.preventDefault();
          const step = 120; // wie das Pfeilpad im Bedienfeld
          if (aktion === 'pan-oben') vp = panBy(vp, 0, step);
          if (aktion === 'pan-unten') vp = panBy(vp, 0, -step);
          if (aktion === 'pan-links') vp = panBy(vp, step, 0);
          if (aktion === 'pan-rechts') vp = panBy(vp, -step, 0);
        }
        // aktion === null (⌘/Strg+Pfeil bzw. ⌥+Hoch/Runter): weder Pan noch Verlaufs-Sprung — bewusst
        // kein return, damit ein hier fehlender Fall andere Handler nicht blockiert (Bestandsmuster).
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') spaceDown = false;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  });

  // ---- Verbindungsbanner (D-03, SAFE-02): Wortlaut und Bedingungen liegen im geteilten
  //      Modul ../banner (SESS-03) — identisches Element auch in der Sitzungsmodus-Chrome ----
</script>

<div class="desk" role="application" aria-label="Schreibtisch" bind:this={el} style={hintergrundStil}
     bind:clientWidth={viewW} bind:clientHeight={viewH} class:grabbing={spaceDown || panning}
     class:hell={isLight(hintergrund.themeId)}
     onwheel={onWheel} onpointerdown={onPointerDown} onpointermove={onPointerMove}
     onpointerup={endPointer} onpointercancel={endPointer} ondblclick={onDeskDblClick}
     ondragover={onDragOver} ondrop={onDrop}>
  {#snippet weltInhalt(v: Viewport, inLupe: boolean)}
    <LinkLayer />
    {#each sichtbareDocs.filter((d) => imSichtfenster(docBox(d))) as doc (doc.id)}
      <DocCard {doc} vp={v} lupe={inLupe} />
    {/each}
    {#each sichtbareStacks.filter((st) => imSichtfenster(stackBox(st))) as stack (stack.id)}
      <StackCard {stack} vp={v} />
    {/each}
    {#each sichtbareNotes.filter((n) => imSichtfenster(noteBox(n))) as note (note.id)}
      <NoteCard {note} vp={v} />
    {/each}
    {#each sichtbareLegalObjects.filter((o) => imSichtfenster(legalObjectBox(o))) as obj (obj.id)}
      <LegalObjectCard {obj} vp={v} />
    {/each}
    {#each sichtbareTables.filter((tb) => imSichtfenster(tableBox(tb))) as tb (tb.id)}
      <TableCard t={tb} vp={v} />
    {/each}
    {#each sichtbareZeitleisten.filter((zl) => imSichtfenster(zeitleisteBox(zl))) as zl (zl.id)}
      <ZeitleisteCard z={zl} vp={v} />
    {/each}
    {#each sichtbareCutouts.filter((c) => imSichtfenster(cutoutBox(c))) as cutout (cutout.id)}
      <CutoutCard {cutout} vp={v} />
    {/each}
    <!-- Virtuelle Entwurfs-Karten (12-07): aus freigaben.vorschlaege, NICHT aus state.notes
         o. ä. — Register-Entscheidung A2, siehe entwurfPosition-Kommentar oben. -->
    {#each entwurfVorschlaege as vorschlag (vorschlag.id)}
      {@const entwurfPos = entwurfPosition(vorschlag)}
      {#if entwurfPos && imSichtfenster({ x: entwurfPos.x, y: entwurfPos.y, w: NOTE_W, h: NOTE_H })}
        <EntwurfKarte {vorschlag} position={entwurfPos} />
      {/if}
    {/each}
  {/snippet}

  <div class="world" style:transform="translate({vp.x}px, {vp.y}px) scale({vp.scale})">
    {@render weltInhalt(vp, false)}
    <!-- 13-05 (UX-03) Task 3: Zonen-Overlay — über den Karten (DOM-Reihenfolge + z-index 500),
         unter Dialogen/Popovern (99998+). Bewusst AUSSERHALB des weltInhalt-Snippets (Muster
         .puls unten): keine Dopplung in der Lupen-Ansicht. -->
    <ZonenOverlay bind:vp {viewW} {viewH} />
    {#if pulsBox}
      <div class="puls" style:left="{pulsBox.x - 8}px" style:top="{pulsBox.y - 8}px"
           style:width="{pulsBox.w + 16}px" style:height="{pulsBox.h + 16}px" aria-hidden="true"></div>
    {/if}
  </div>
  {#if ui.lupe && lupePos && lupenVp}
    <div class="lupe" style={hintergrundStil}
         style:left="{lupePos.x - LUPE / 2}px" style:top="{lupePos.y - LUPE / 2}px"
         style:width="{LUPE}px" style:height="{LUPE}px" aria-hidden="true">
      <div class="lupenwelt" style:transform="translate({lupenVp.x}px, {lupenVp.y}px) scale({lupenVp.scale})">
        {@render weltInhalt(lupenVp, true)}
      </div>
    </div>
  {/if}
  <DeskSwitcher />
  <DeskControls
    onzoom={(f) => (vp = zoomAt(vp, { x: el.clientWidth / 2, y: el.clientHeight / 2 }, f))}
    onpan={(dx, dy) => (vp = panBy(vp, dx, dy))}
    onfit={fitAll}
    onsuche={() => (sucheOffen = true)}
    onauswertung={() => (ui.auswertungOffen = true)}
  />
  {#if sucheOffen}
    <div class="suche-panel" role="search">
      <!-- svelte-ignore a11y_autofocus -- das Suchfeld ist der einzige Zweck des Panels -->
      <input autofocus class="suche-feld"
             placeholder={desktop.status === 'online' ? 'Volltext, Notizen, OCR …' : 'Suche benötigt eine Verbindung'}
             disabled={desktop.status !== 'online'}
             bind:value={suchText} aria-label="Auf dem Schreibtisch suchen"
             onkeydown={(e) => {
               e.stopPropagation();
               if (e.key === 'Escape') schliesseSuche();
               if (e.key === 'Enter' && treffer.length > 0) springe(treffer[0]);
             }} />
      {#if suchText.trim() !== ''}
        <div class="suche-liste">
          {#if suchFehler}
            <div class="fehler">
              <span>Suche fehlgeschlagen.</span>
              <button onclick={sucheWiederholen}>Erneut versuchen</button>
            </div>
          {:else if suchLaeuft && treffer.length === 0}
            <div class="keine">Sucht …</div>
          {:else if treffer.length > 0}
            {#each treffer as t (t.id)}
              <button class="treffer" onclick={() => springe(t)}>
                <div class="zeile1"><span class="art">{artBadge(t)}</span><span class="name">{t.label}</span></div>
                {#if t.snippet}<div class="zitat" title={t.snippet}>„{t.snippet}"</div>{/if}
                {#if metaZeile(t)}<div class="meta">{metaZeile(t)}</div>{/if}
              </button>
            {/each}
          {:else}
            <div class="keine">Keine Treffer</div>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
  <TrashCan />
  <!-- 13-05 (UX-03): Minikarte — links unten, Spiegelung des Papierkorbs (TrashCan.svelte).
       Gerendert nur bei aktiver Präferenz UND außerhalb des Sitzungsmodus (UI-SPEC-Profilregel;
       Smartphone-Ausschluss ist strukturell, s. Toolbar-Kommentar oben). -->
  {#if minimapAn && !ui.sitzungsmodusAktiv}
    <Minimap bind:vp {viewW} {viewH} />
  {/if}
  <HistoryOverlay />
  <ActivityOverlay />
  <AuswertungsPanel />
  <KonfliktOverlay />
  <SystemdiagnoseOverlay />
  <BerechtigungsDialog />
  <ShareDialog />
  <UebergabeDialog />
  <AnlagenpaketDialog />
  <SitzungsmappeDialog />
  <!-- VorschlaegeDialog (12-07, AI-01): die Genehmigungs-Prüffläche der KI-Vertrauensschicht.
       Smartphone-frei strukturell — die MOBILE-02-Weiche in +page.svelte mountet dort die
       SmartphoneSchnellzugriff-Shell statt dieser Komponente (E5/overflow, Genehmigungen sind
       eine Prüfhandlung auf Desktop/iPad). -->
  <VorschlaegeDialog />
  <!-- AufnahmeDialog (EXT-01, 13-06): dieselbe Dialog-Ebene wie die übrigen Desk-Dialoge oben
       (Anlagenpaket/Sitzungsmappe/KI-Freigaben) — Montage-Stelle dokumentiert im 13-06-SUMMARY. -->
  <AufnahmeDialog />
  <!-- VorlagenDialog (TMPL-01, 13-07): dieselbe Dialog-Ebene wie AufnahmeDialog/AnlagenpaketDialog
       oben — eigene Escape-Behandlung über die Dialog-Klasse, kein Eintrag im globalen
       Escape-Handler nötig. -->
  <VorlagenDialog />
  <!-- AufraeumenDialog (UX-02, Plan 13-08): dieselbe Dialog-Ebene wie AufnahmeDialog/VorlagenDialog
       oben (Montage-Stelle nicht im 13-08-Plan-Dateiumfang gelistet, notwendige Konsequenz — sonst
       öffnet der DeskSwitcher-Eintrag nur ui.aufraeumenOffen, ohne dass etwas rendert; dokumentiert
       im 13-08-SUMMARY) — eigene Escape-Behandlung über die Dialog-Klasse, kein Eintrag im
       globalen Escape-Handler nötig. -->
  <AufraeumenDialog />
  <!-- CommandPalette (UX-04, Plan 13-09): dieselbe Dialog-Ebene wie AufraeumenDialog/
       VorlagenDialog/AufnahmeDialog oben — eigene Escape-Behandlung über die Dialog-Klasse UND
       Overlay-Vorrang-Einreihung im down-Handler oben. bind:vp/suchText/sucheOffen wie
       ViewSwitcher (component-lokal, 11-RESEARCH.md Pitfall 1); onMinimapToggle spiegelt den
       Toolbar-Umschalter (minimapAn bleibt component-lokale Anzeige-Präferenz, s. Kommentar
       oben). -->
  <CommandPalette bind:vp bind:suchText bind:sucheOffen {viewW} {viewH} onMinimapToggle={toggleMinimap} />
  <SitzungsmodusShell />
  {#if ui.provenancePopover}
    <ProvenancePopover
      id={ui.provenancePopover.id}
      anchor={ui.provenancePopover.anchor}
      onclose={() => (ui.provenancePopover = null)}
    />
  {/if}
  {#if ui.vergleich}
    <VergleichsViewer
      aId={ui.vergleich.aId}
      bId={ui.vergleich.bId}
      onclose={() => (ui.vergleich = null)}
    />
  {/if}
  <div class="toolbar">
    <input
      bind:this={fileInput}
      type="file"
      multiple
      hidden
      onchange={onFilesPicked}
    />
    <div class="ebenen-wrap">
      <button class="ebenen-current" onclick={() => (ebenenMenuOffen = !ebenenMenuOffen)}
              aria-label={`Aktive Ebene: ${aktiveEbene?.name ?? '…'} — Ebene wechseln`}>
        {#if aktiveEbene}{EBENE_ICON[aktiveEbene.typ]} {aktiveEbene.name}{:else}…{/if}
      </button>
      {#if ebenenMenuOffen}
        <div class="backdrop" role="presentation"
             onpointerdown={(e) => { e.stopPropagation(); ebenenMenuOffen = false; }}></div>
        <div class="ebenen-menu" role="menu" tabindex="-1" onpointerdown={(e) => e.stopPropagation()}>
          <div class="abschnitt">Neue Objekte anlegen auf</div>
          {#each ebenenFuerUmschalter as ebene (ebene.id)}
            <button class="item" class:aktiv={ebene.id === desktop.currentLayerId}
                    onclick={() => { desktop.setActiveLayer(ebene.id); ebenenMenuOffen = false; }}>
              {EBENE_ICON[ebene.typ]} {ebene.name}
            </button>
          {/each}
        </div>
      {/if}
    </div>
    <!-- VIEW-01 (11-08): Ansichten-Umschalter — unmittelbar nach dem Ebenen-Umschalter und vor
         der Präsenz-Rosette (beides „aktueller Zustand + Wechsel"-Kontrollen, UI-SPEC). vp,
         suchText und sucheOffen sind komponentenlokal und nur per bind: erreichbar (11-RESEARCH.md
         Pitfall 1). -->
    <ViewSwitcher bind:vp bind:suchText bind:sucheOffen bind:offen={ansichtenMenuOffen}
                  deskId={desktop.deskId} />
    <!-- 12-06 (AI-01): Freigaben-Signal — Fortsetzung des Clusters „aktueller Zustand +
         Wechsel" (Ebenen-, Ansichten-Umschalter, Präsenz): direkt NACH dem 📌-Ansichten-
         Umschalter und VOR PresenceRoster. Es rendert sich nur bei ≥ 1 wartendem Vorschlag
         (Lärm-Regel, fail-quiet). E5/overflow (MOBILE-02): auf dem Smartphone-Profil fehlt
         die Komponente strukturell — +page.svelte mountet dort SmartphoneSchnellzugriff
         statt Desktop.svelte; Genehmigungen bleiben Prüfhandlungen auf Desktop/iPad. -->
    <FreigabenSignal />
    <!-- 13-01 (NOTIF-01): Benachrichtigungen — UI-SPEC-Positionsauftrag: direkt NACH dem
         🤖-Freigaben-Signal und VOR PresenceRoster (Fortsetzung des Clusters „aktueller
         Zustand + Wechsel"). Der 🔔-Button ist immer gerendert (Desktop/iPad), der Badge
         nur bei > 0 ungelesen (Lärm-Regel: das einzige Signal, keine Toasts). Auf dem
         Smartphone-Profil fehlt die Komponente strukturell — +page.svelte mountet dort
         SmartphoneSchnellzugriff statt Desktop.svelte (Phase-11-Entscheidung); im
         Sitzungsmodus rendert die Komponente selbst nichts (kein 🔔 während des Termins). -->
    <BenachrichtigungenPanel />
    <!-- 13-05 (UX-03): Minikarten-Umschalter — UI-SPEC-Positionsauftrag direkt NACH dem
         🔔-Benachrichtigungen und VOR PresenceRoster (Fortsetzung desselben Clusters). Auf dem
         Smartphone-Profil fehlt der Button strukturell — Desktop.svelte wird dort nicht gemountet
         (+page.svelte mountet SmartphoneSchnellzugriff, Phase-11-Entscheidung); im Sitzungsmodus
         bleibt der Umschalter ausgeblendet (Muster BenachrichtigungenPanel/FreigabenSignal). -->
    {#if !ui.sitzungsmodusAktiv}
      <button onclick={toggleMinimap} aria-pressed={minimapAn}
              aria-label="Minikarte ein-/ausblenden" title="🗺 Minikarte">🗺 Minikarte</button>
    {/if}
    <!-- 06-03 (COLLAB-01): Präsenz ist wie Sichtbarkeit ein reiner Anzeigeschalter — gehört laut
         UI-SPEC an den Anfang der Werkzeugleiste, unmittelbar VOR den Sichtbarkeits-Button,
         nicht zwischen die ändernden Aktionen (＋, 🕘, Teilen). -->
    <PresenceRoster eigeneUserId={null} />
    <button onclick={() => (ebenenPanelOffen = !ebenenPanelOffen)}
            aria-label="Ebenen" title="Ebenen ein-/ausblenden" aria-expanded={ebenenPanelOffen}>👁 Ebenen</button>
    <button onclick={plusMenu} title="Hinzufügen">＋ Hinzufügen</button>
    <button onclick={() => (ui.historieOffen = true)} title="Historie">🕘 Historie</button>
    {#if desktop.currentRolle === 'Eigentümer'}
      <!-- 14-01 (OPS-02): dieselbe Eigentümer-Ausblendung wie „Teilen" direkt darunter —
           Komfort-Ausblenden, KEINE Sicherheitsgrenze (der Server gated
           GET /desks/:id/diagnose ohnehin erneut über requireDeskRolle(['Eigentümer'])).
           Position laut UI-SPEC direkt VOR „Teilen" (Eigentümer-Aktions-Cluster). -->
      <button onclick={() => (ui.systemdiagnoseOffen = true)} title="Verbindungen, Speicher und Backup-Status prüfen">🩺 Systemdiagnose</button>
    {/if}
    {#if desktop.currentRolle === 'Eigentümer'}
      <!-- 14-05 (OPS-03): dieselbe Eigentümer-Ausblendung wie „🩺 Systemdiagnose" direkt darüber
           — Komfort-Ausblenden, KEINE Sicherheitsgrenze (der Server gated
           GET /desks/:id/berechtigung ohnehin erneut über requireDeskRolle(['Eigentümer'])).
           Position laut UI-SPEC direkt NACH „🩺 Systemdiagnose", VOR „Teilen". Öffnet den
           Dialog leer (ohne Objekt-Vorauswahl) — der zweite Einstieg ist der Kontextmenüpunkt
           an der Karte (menus.ts). -->
      <button onclick={() => (ui.berechtigungDialog = {})} title="Sichtbarkeit eines Dokuments für einen Nutzer prüfen">🛡 Admin</button>
    {/if}
    {#if desktop.currentRolle === 'Eigentümer'}
      <!-- 02-08 (PERM-03): der Teilen-Dialog öffnet nur für den Eigentümer (Bestandsregel
           aus TP3-Vorarbeit, unverändert) — im j-lawyer-Modus (currentRolle === null) fehlt
           dieser Button vollständig, da das dortige Zugriffsmodell keine Desk-Rollen kennt. -->
      <button onclick={() => (ui.teilenOffen = true)} title="Teilen">🤝 Teilen</button>
    {/if}
    <button onclick={() => void abmelden()} title="Abmelden">🚪 Abmelden</button>
  </div>
  {#if ebenenPanelOffen}
    <LayerVisibilityPanel />
  {/if}
  {#if ui.linkingFromId}
    <div class="hint">Verknüpfen: Ziel anklicken (Esc bricht ab)</div>
  {/if}
  {#if ui.clippingFromId}
    <div class="hint">Anklammern: Ziel anklicken (Esc bricht ab)</div>
  {/if}
  {#if ui.zeitleisteEintragFuer}
    <div class="hint">Zeitleiste: Objekt anklicken (Esc bricht ab)</div>
  {/if}
  {#if ui.compareFromId}
    <div class="hint">Vergleichen: zweites Dokument anklicken (Esc bricht ab)</div>
  {/if}
  {#if ui.versionFromId}
    <div class="hint">Versionskette: vorherige Fassung anklicken (Esc bricht ab)</div>
  {/if}
  {#if bannerSichtbar(desktop.status, desktop.pendingCount)}
    <!-- D-03 (SAFE-02): dasselbe Bannerelement zeigt zusätzlich den Wartestand der Offline-
         Warteschlange an — kein neues UI-Element, kein Ladebalken. Der Blocker (modal) gilt
         weiterhin ausschließlich für offline/connecting, NICHT für den online+pendingCount-Fall
         (der Drain läuft automatisch im Hintergrund, ohne die Bedienung zu sperren). -->
    <div class="banner" role="status" aria-live="polite">{bannerText(desktop.status, desktop.pendingCount)}</div>
    {#if bannerBlockiert(desktop.status)}
      <div class="blocker"></div>
    {/if}
  {/if}
  {#if desktop.syncFehler}
    <!-- j-lawyer-Erreichbarkeit: dezenter Hinweis, nicht modal — verschwindet beim nächsten
         erfolgreichen Abgleich von selbst, daher kein Schließen-Knopf. -->
    <div class="sync-banner" role="status" aria-live="polite">{desktop.syncFehler}</div>
  {/if}
  {#if ui.jlVersionIncompatible && !ui.jlVersionBannerGeschlossen}
    <!-- REF-03: Versionskompatibilität — dritte Stufe der Banner-Familie (.banner top:12px,
         .sync-banner top:52px), nicht blockierend (kein .blocker), neutraler Ton, ✕ schließt
         nur für die laufende Verbindung (Session-Speicher, siehe ui.svelte.ts). -->
    <div class="jl-version-banner" role="status" aria-live="polite">
      <span>J-DESK wurde mit einer anderen j-lawyer-Version getestet als Ihre Kanzlei-Installation. Die meisten Funktionen sollten trotzdem funktionieren.</span>
      <button class="schliessen" onclick={schliesseJlVersionBanner} aria-label="Versionshinweis schließen">✕</button>
    </div>
  {/if}
  {#if ui.toast}
    <div class="toast">{ui.toast}</div>
  {/if}
  <ContextMenu />
</div>

<style>
  .desk { position: fixed; inset: 0; overflow: hidden; touch-action: none;
          background: radial-gradient(1200px 800px at 40% 30%, #3a5c4e, #27423a 70%, #1d332d); }
  .desk.grabbing { cursor: grabbing; }
  /* Helle Tischflächen: Papier setzt sich per Kontur + kräftigerem Schlagschatten ab (Vision). */
  .desk.hell :global(:is(.card, .stack, .cutout)) {
    box-shadow: 0 0 0 1px rgba(0, 0, 0, .22), 0 8px 22px rgba(0, 0, 0, .4);
  }
  /* Tafel-Text: auf hellen Tischflächen schwarze statt weißer Filzstift-Tinte (Nutzerwunsch). */
  .desk.hell :global(.note.kind-tafel .text),
  .desk.hell :global(.note.kind-tafel textarea) {
    color: #26241d;
    text-shadow: 0 1px 2px rgba(255, 255, 255, .45);
  }
  .desk.hell :global(.note.kind-tafel textarea) { outline-color: rgba(38, 36, 29, .45); }
  .world { position: absolute; top: 0; left: 0; transform-origin: 0 0; }
  /* Such-Treffer: pulsierender Umriss in Weltkoordinaten (keine Änderungen an den Karten nötig). */
  .puls { position: absolute; border: 3px solid rgba(242, 226, 184, .95); border-radius: 12px;
          pointer-events: none; z-index: 99997; animation: pulsieren 1s ease-in-out infinite;
          box-shadow: 0 0 24px rgba(242, 226, 184, .55); }
  @keyframes pulsieren { 50% { opacity: .35; } }
  @media (prefers-reduced-motion: reduce) { .puls { animation: none; } }
  .suche-panel { position: fixed; top: 14px; left: 50%; transform: translateX(-50%); z-index: 9600;
                 width: min(420px, calc(100vw - 32px)); display: flex; flex-direction: column; gap: 6px;
                 background: var(--glass-panel-bg); border: 1px solid var(--glass-border);
                 backdrop-filter: var(--glass-blur-panel); -webkit-backdrop-filter: var(--glass-blur-panel);
                 border-radius: 12px; padding: 10px; box-shadow: var(--glass-shadow-lg); }
  .suche-feld { border: 1px solid var(--glass-separator); border-radius: 8px; padding: 8px 10px;
                background: var(--glass-input-bg); color: var(--glass-text); font: inherit; font-size: 14px; }
  .suche-feld::placeholder { color: var(--glass-text-secondary); }
  .suche-feld:focus-visible { outline: 2px solid var(--brand-blue); outline-offset: 0; }
  .suche-liste { display: flex; flex-direction: column; gap: 2px; max-height: 40vh; overflow-y: auto; }
  /* Trefferzeile (07-03): drei Zeilen im Button — Zeile 1 (Art+Label) unverändert aus dem
     Bestand, neu Zeile 2 (Zitat, nur bei Text-Treffern) und Zeile 3 (Ersteller/Datum, immer). */
  .treffer { display: flex; flex-direction: column; gap: 4px; width: 100%; text-align: left; border: none;
             background: none; color: var(--glass-text); padding: 7px 8px; border-radius: 8px;
             cursor: pointer; font-size: 13px; }
  .treffer:hover { background: var(--glass-hover); }
  .treffer .zeile1 { display: flex; gap: 8px; align-items: baseline; }
  .treffer .art { flex: none; font-size: 10px; text-transform: uppercase; letter-spacing: .05em;
                  background: var(--brand-blue-soft); border-radius: 5px; padding: 2px 6px; }
  .treffer .name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  /* Zitat: Klassenname/Stil wortgleich aus .zitat in HistoryOverlay.svelte übernommen, hier
     zusätzlich einzeilig mit Auslassung (das .name-Kürzungsmuster auf das Zitat übertragen). */
  .treffer .zitat { font-size: 12px; font-style: italic; color: var(--glass-text-secondary);
                     white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  /* Metazeile: Stil wie .wer/.zeit in HistoryOverlay.svelte. */
  .treffer .meta { font-size: 12px; color: var(--glass-text-secondary);
                    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .keine { padding: 8px; font-size: 12px; color: var(--glass-text-secondary); }
  /* Fehlerzustand: Wortlaut/Interaktionsmuster analog .fehler in HistoryOverlay.svelte. */
  .fehler { display: flex; align-items: center; gap: 8px; padding: 8px; font-size: 12px; color: var(--glass-text-secondary); }
  .fehler button { border: 1px solid var(--glass-separator); background: transparent; color: var(--glass-text);
                    border-radius: 6px; padding: 3px 8px; cursor: pointer; font: inherit; font-size: 12px; }
  .lupe { position: fixed; z-index: 9500; border-radius: 50%; overflow: hidden; pointer-events: none;
          border: 3px solid rgba(242, 226, 184, .85); box-shadow: 0 10px 34px rgba(0, 0, 0, .5), inset 0 0 20px rgba(0, 0, 0, .15);
          background: radial-gradient(1200px 800px at 40% 30%, #3a5c4e, #27423a 70%, #1d332d); }
  .lupenwelt { position: absolute; top: 0; left: 0; transform-origin: 0 0; }
  .toolbar { position: fixed; top: 12px; right: 12px; display: flex; gap: 8px; z-index: 9000; }
  .toolbar button { font-size: 13px; padding: 6px 12px; border-radius: 8px;
                    border: 1px solid var(--glass-border);
                    background: var(--glass-card-bg); color: var(--glass-text);
                    backdrop-filter: var(--glass-blur-card); -webkit-backdrop-filter: var(--glass-blur-card);
                    cursor: pointer; box-shadow: var(--glass-shadow); }
  .toolbar button:hover { background: var(--glass-elevated-bg); }
  /* Ebenen-Umschalter (02-07): .ebenen-current erbt bewusst die .toolbar-button-Optik (identisch
     zu DeskSwitcher.svelte .current) — kein eigener Stil nötig. Nur das Dropdown braucht eigene
     Regeln, sonst würde .toolbar button auch die Menü-Einträge treffen. */
  .ebenen-wrap { position: relative; }
  .backdrop { position: fixed; inset: 0; z-index: 9001; }
  .ebenen-menu { position: absolute; top: 40px; right: 0; z-index: 9002; min-width: 220px; padding: 4px;
                 border-radius: 10px; background: var(--glass-elevated-bg); color: var(--glass-text);
                 border: 1px solid var(--glass-border);
                 backdrop-filter: var(--glass-blur-elevated); -webkit-backdrop-filter: var(--glass-blur-elevated);
                 box-shadow: var(--glass-shadow-lg);
                 display: flex; flex-direction: column; gap: 2px;
                 max-height: calc(100vh - 56px); overflow-y: auto; }
  .ebenen-menu .abschnitt { padding: 4px 10px 2px; font-size: 11px; text-transform: uppercase; letter-spacing: .04em;
                            color: var(--glass-text-secondary); }
  .ebenen-menu .item { text-align: left; padding: 7px 10px; border: 1px solid transparent; background: none;
                        border-radius: 6px; font-size: 13px; color: inherit; cursor: pointer; box-shadow: none; }
  .ebenen-menu .item:hover { background: var(--glass-hover); }
  .ebenen-menu .item.aktiv { border-color: var(--brand-blue); box-shadow: 0 0 0 2px var(--glass-active); }
  .hint { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); padding: 6px 14px;
          border-radius: 999px; background: rgba(8, 31, 57, .88); color: #fff; font-size: 13px; z-index: 9999; }
  .banner { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); padding: 6px 14px;
            border-radius: 999px; background: rgba(140, 60, 20, .9); color: #fff; font-size: 13px; z-index: 99000; }
  .blocker { position: fixed; inset: 0; z-index: 98000; cursor: wait; }
  /* Erreichbarkeits-Banner (j-lawyer-Modus): dezentes Glas statt kräftiger Warnfarbe — nicht
     modal (kein .blocker, pointer-events: none), sitzt unterhalb des Verbindungs-Banners. */
  .sync-banner { position: fixed; top: 52px; left: 50%; transform: translateX(-50%); padding: 6px 14px;
                 max-width: min(560px, calc(100vw - 32px)); text-align: center;
                 border-radius: 999px; background: var(--glass-panel-bg); border: 1px solid var(--glass-border);
                 backdrop-filter: var(--glass-blur-panel); -webkit-backdrop-filter: var(--glass-blur-panel);
                 color: var(--glass-text); font-size: 12.5px; box-shadow: var(--glass-shadow);
                 pointer-events: none; z-index: 9700; }
  /* Versionskompatibilitäts-Banner (REF-03): dritte Stufe der Banner-Familie, s. o. — im
     Unterschied zu .sync-banner interaktiv (Schließen-Knopf), daher pointer-events normal. */
  .jl-version-banner { position: fixed; top: 92px; left: 50%; transform: translateX(-50%);
                        display: flex; align-items: center; gap: 8px; padding: 6px 14px;
                        max-width: min(560px, calc(100vw - 32px));
                        border-radius: 999px; background: var(--glass-panel-bg); border: 1px solid var(--glass-border);
                        backdrop-filter: var(--glass-blur-panel); -webkit-backdrop-filter: var(--glass-blur-panel);
                        color: var(--glass-text); font-size: 13px; box-shadow: var(--glass-shadow); z-index: 9700; }
  .jl-version-banner .schliessen { border: 0; background: transparent; color: inherit; font-size: 13px;
                                    line-height: 1; cursor: pointer; padding: 2px 4px; flex: none; }
  .toast { position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%); padding: 8px 16px;
           border-radius: 10px; background: rgba(20, 20, 20, .88); color: #fff; font-size: 13px; z-index: 99500; }
</style>
