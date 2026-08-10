<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import {
    moveDoc, setDocPage, uid, DEFAULT_OPEN_SIZE, FLAG_COLORS, docBox, findDoc, versionKetteVon,
    type Doc, type Size, type Viewport,
  } from '@j-desk/core';
  import { debounce } from '../debounce';
  import { pagePointIn } from '../inkMath';
  import { bytesFor } from '../pageCounts';
  import { textInRect } from '../pdfText';
  import { desktop } from '../store.svelte';
  import { ui, showToast } from '../ui.svelte';
  import { showViewerMenuAt } from '../menus';
  import { referenzstatusVon } from '../referenzstatus';
  import { bearbeitetJetzt, ruhtJetzt, personFuerObjekt } from '../presence.svelte';
  import PageRenderer from './PageRenderer.svelte';
  import ImagePage from './ImagePage.svelte';
  import InkOverlay, { type InkTool } from './InkOverlay.svelte';
  import MarkLayer from './MarkLayer.svelte';
  import StampPopover from './StampPopover.svelte';
  import StampLayer from './StampLayer.svelte';
  import SourceHighlight from './SourceHighlight.svelte';
  import FlagRail from './FlagRail.svelte';
  import RadialMenu, { type RadialGroup } from './RadialMenu.svelte';
  import { STABILO_COLORS, PEN_COLORS, loadInkColor, saveInkColor } from '../inkColors';

  let { doc, vp }: { doc: Doc; vp: Viewport } = $props();

  let pageCount = $state<number | null>(null);
  let wrapEl = $state<HTMLDivElement | null>(null);
  let bodyH = $state(0);
  const kind = $derived(doc.kind ?? 'pdf');
  // Bild-Dokument: eine "Seite" (die Bildpixel selbst) — kein Blättern, kein Herauslösen.
  const bildmodus = $derived(kind === 'image');
  const seitenQuelle = $derived(kind === 'convertible' ? 'preview' : 'original');
  const seitenfix = $derived(doc.pageOnly !== undefined || bildmodus); // kein Blättern
  const page = $derived(bildmodus ? 1 : (doc.pageOnly ?? doc.page ?? 1));
  const size = $derived(doc.openSize ?? DEFAULT_OPEN_SIZE);
  const pageWidth = $derived(Math.round(size.w - 20));

  // Referenzstatus (j-lawyer-Modus): gleiche Priorität wie auf der Karte (DocCard.svelte) — alle
  // sechs Zustände, nicht nur gone/neueFassung (WR-04). Priorität + Texte kommen aus der
  // gemeinsamen Hilfsfunktion (IN-01).
  const referenzstatus = $derived(referenzstatusVon(doc));
  const quelleWeg = $derived(referenzstatus?.kind === 'gone');
  const entzogen = $derived(referenzstatus?.kind === 'entzogen');
  const nichtErreichbar = $derived(referenzstatus?.kind === 'nichtErreichbar');
  const neueFassung = $derived(referenzstatus?.kind === 'neueFassung');
  const umbenannt = $derived(referenzstatus?.kind === 'umbenannt');
  const archiviert = $derived(referenzstatus?.kind === 'archiviert');
  // Erklärtext des Kurz-Badges (Review-Fix): das Badge selbst bleibt pointer-events:none +
  // aria-hidden (Kopf-Drag darf nicht gestört werden) — Tooltip/Screenreader-Text wandert auf
  // Elemente, die Pointer-Events regulär empfangen (Titel-Span + der Viewer-Wurzel-aria-label).
  const statusKurz = $derived(referenzstatus?.kurz ?? null);
  const statusErklaerung = $derived(referenzstatus?.erklaerung ?? null);

  // Versionskette (COMP-03, 09-07 Task 3): versionKetteVon arbeitet AUSSCHLIESSLICH auf dem
  // bereits projizierten Client-Zustand (desktop.state) — es gibt keinen zweiten, ungefilterten
  // Weg an die Kette. Die Zählung "Version n von N" weiter unten liest ausschließlich aus dieser
  // Liste; eine zweite Zahlenquelle wäre ein Leck über nicht sichtbare Fassungen (T-09-27).
  const versionKette = $derived(versionKetteVon(desktop.state, doc.id));
  let versionKettePopoverOffen = $state(false);
  let versionKettePopoverAnchor = $state<{ x: number; y: number } | null>(null);
  let versionKetteAuswahl = $state<string[]>([]);

  function versionKettePopoverOeffnen(e: MouseEvent): void {
    versionKettePopoverAnchor = { x: e.clientX, y: e.clientY };
    versionKetteAuswahl = [];
    versionKettePopoverOffen = true;
  }

  function versionKettePopoverSchliessen(): void {
    versionKettePopoverOffen = false;
    versionKetteAuswahl = [];
  }

  function versionAuswahlUmschalten(id: string): void {
    versionKetteAuswahl = versionKetteAuswahl.includes(id)
      ? versionKetteAuswahl.filter((x) => x !== id)
      : [...versionKetteAuswahl, id];
  }

  /** Öffnet die geklickte Fassung: schlägt sie bei Bedarf auf und zentriert den Tisch darauf
   *  (Muster AuswertungsPanel.svelte springe() — dieselbe ui.jumpRequest-Leitung). */
  function versionOeffnen(id: string): void {
    const d = findDoc(desktop.state, id);
    if (!d) return;
    if (!d.open) void desktop.command('expandDoc', { id });
    ui.jumpRequest = { box: docBox(d) };
    versionKettePopoverSchliessen();
  }

  /** „Fassungen vergleichen": nur bei genau zwei ausgewählten Zeilen aktiv (siehe Markup). */
  function versionenVergleichen(): void {
    if (versionKetteAuswahl.length !== 2) return;
    const [aId, bId] = versionKetteAuswahl;
    ui.vergleich = { aId, bId };
    versionKettePopoverSchliessen();
  }

  // Sprung-Banner (01-06): erscheint, wenn ein Sprung gerade auf DIESES Dokument gelandet ist
  // und die Quelle inzwischen ersetzt wurde — verschwindet automatisch bei Seitenwechsel oder
  // per ✕-Knopf, ohne die aktuelle Anzeige (Stand von damals) zu verändern.
  let ersetztBannerSichtbar = $state(false);
  let ersetztBannerSeite: number | null = null;
  $effect(() => {
    if (ui.docJumpTarget !== doc.id) return;
    ui.docJumpTarget = null; // einmalig konsumieren
    if (neueFassung) {
      ersetztBannerSichtbar = true;
      ersetztBannerSeite = page;
    }
  });
  $effect(() => {
    if (ersetztBannerSichtbar && ersetztBannerSeite !== null && page !== ersetztBannerSeite) {
      ersetztBannerSichtbar = false;
    }
  });

  // Querformat-Seiten (UAT A2.7): Der Standard-Viewer ist hochformatig — sobald die echte
  // Seitengröße bekannt ist und der Nutzer die Größe nie angepasst hat, übernimmt der Viewer
  // einmalig das Seitenformat (Chrom = Kopf + Ränder wird über die Rail-Höhe gemessen).
  let formatAngepasst = false;
  $effect(() => {
    if (formatAngepasst || !baseSize || bodyH <= 0) return;
    if (baseSize.w <= baseSize.h) { formatAngepasst = true; return; }
    const unveraendert = !doc.openSize ||
      (doc.openSize.w === DEFAULT_OPEN_SIZE.w && doc.openSize.h === DEFAULT_OPEN_SIZE.h);
    formatAngepasst = true;
    if (!unveraendert) return;
    const w = 760;
    const chrom = size.h - bodyH;
    const seitenH = Math.round((w - 20) * (baseSize.h / baseSize.w));
    void desktop.command('resizeDoc', { id: doc.id, size: { w, h: seitenH + chrom } });
  });

  // Lichttisch: Viewer wird durchscheinend — Seiten lassen sich zum Vergleich übereinanderlegen
  let lichttisch = $state(false);

  // Zeichen-/Schneidwerkzeuge: aktives Werkzeug gilt pro Viewer
  let inkTool = $state<InkTool | 'scissors' | 'tippex' | 'redact' | null>(null);
  let baseSize = $state<Size | null>(null);
  const rectTool = $derived(inkTool === 'scissors' || inkTool === 'tippex' || inkTool === 'redact' ? inkTool : null);
  function toggleTool(t: InkTool | 'scissors' | 'tippex' | 'redact') {
    inkTool = inkTool === t ? null : t;
    // Zeichnen/Schneiden/Abdecken beendet Stempel- und Fahnenmodus — sonst fängt deren
    // ganzseitige Setzfläche die Klicks ab und das gewählte Werkzeug wirkt "kaputt".
    stampChoice = null;
    flagColor = null;
    if (inkTool === 'redact' && !localStorage.getItem('dd-redact-hinweis')) {
      localStorage.setItem('dd-redact-hinweis', '1');
      showToast('Hinweis: Die Schwärzung deckt nur sichtbar ab — der Text bleibt im PDF erhalten.');
    }
  }

  // Stempel: Auswahl "klebt" am Werkzeug — jeder Seitenklick setzt einen Abdruck
  let stampMenu = $state(false);
  let stampChoice = $state<{ text: string; color: 'red' | 'blue'; withDate?: boolean } | null>(null);

  function pickStamp(wahl: { text: string; color: 'red' | 'blue'; withDate?: boolean }) {
    stampMenu = false;
    stampChoice = wahl;
    inkTool = null; // Stempeln ist ein eigener Modus, Zeichnen aus
    flagColor = null; // Fahnen-Werkzeug schließt sich mit Stempeln gegenseitig aus
  }

  // Notizfahnen: Farbwahl "klebt" bis zum nächsten Seitenklick — danach ist das Werkzeug wieder aus.
  let flagColor = $state<string | null>(null); // gewählte Farbe = Werkzeug aktiv

  // Bearbeitungssignal (06-04, COLLAB-02): "Annotieren-Kontext" = irgendein Zeichen-/Schneid-/
  // Stempel-/Fahnenwerkzeug ist gerade aktiv — reines Blättern/Betrachten ohne aktives Werkzeug
  // löst KEIN Signal aus (ein Betrachter blockiert niemanden). inkTool/stampChoice/flagColor sind
  // laut toggleTool()/pickStamp()/radialPick() bereits gegenseitig exklusiv (siehe oben); diese
  // Ableitung kombiniert sie nur zu einem einzigen Bearbeiten-Zustand.
  const annotierend = $derived(inkTool !== null || stampChoice !== null || flagColor !== null);
  // 06-03-SUMMARY: der Server schließt den eigenen Eintrag bereits aus JEDER Präsenzmeldung aus
  // — eine eigene userId ist clientseitig nirgends bekannt und wird durch den serverseitigen
  // Selbst-Ausschluss auch nicht benötigt (identisches Vorgehen wie PresenceRoster.svelte).
  // Nur für den Soft-Deterrent-Toast (Task 3) gebraucht — DocViewer selbst zeigt keinen Ring/
  // keine Pille (das übernimmt ausschließlich DocCard.svelte, siehe UI-SPEC Scope-Entscheidung).
  const fremdeBearbeitung = $derived(personFuerObjekt(doc.id, null));
  /** Bauteil-lokale Merker: annotierteSignalisiert verhindert doppeltes bearbeitetJetzt() bei
   *  Re-Läufen des Effekts, solange annotierend unverändert true bleibt; hinweisGezeigt (Task 3)
   *  stellt sicher, dass der Soft-Deterrent-Toast höchstens einmal je Annotieren-Versuch
   *  erscheint — beide werden beim Verlassen des Annotieren-Kontexts zurückgesetzt. */
  let annotierteSignalisiert = false;
  let hinweisGezeigt = false;
  $effect(() => {
    if (annotierend && !annotierteSignalisiert) {
      // Soft-Deterrent-Toast: einmalig je Annotieren-Versuch, kein Blocker — das Werkzeug
      // bleibt regulär aktiv, das Bearbeitungssignal wird trotzdem gesendet.
      if (fremdeBearbeitung && !hinweisGezeigt) {
        hinweisGezeigt = true;
        showToast(`Wird gerade von ${fremdeBearbeitung.name} bearbeitet.`);
      }
      bearbeitetJetzt(doc.id);
      annotierteSignalisiert = true;
    } else if (!annotierend && annotierteSignalisiert) {
      ruhtJetzt();
      annotierteSignalisiert = false;
      hinweisGezeigt = false;
    }
  });

  // Radial-Werkzeugmenü (ersetzt die Werkzeugleiste; Spec 2026-07-19)
  let radial = $state<{ x: number; y: number } | null>(null);
  let flagPicking = $state(false); // „Fahne" gewählt → Fahnenfarben-Bogen offen
  let penColor = $state(loadInkColor('pen'));
  let markerColor = $state(loadInkColor('marker'));

  function openRadialCentered() {
    const r = wrapEl?.getBoundingClientRect();
    radial = r
      ? { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 280) }
      : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  }

  const radialGroups = $derived.by((): RadialGroup[] => [
    {
      id: 'zeichnen', icon: '✏', label: 'Zeichnen',
      items: [
        { id: 'pencil', icon: '✏', label: 'Bleistift', active: inkTool === 'pencil' },
        { id: 'pen', icon: '✎', label: 'Kuli', active: inkTool === 'pen' },
        { id: 'marker', icon: '', chip: markerColor, label: 'Marker', active: inkTool === 'marker' },
        { id: 'line', icon: '⟍', label: 'Lineal', active: inkTool === 'line' },
        { id: 'eraser', icon: '⌫', label: 'Radierer', active: inkTool === 'eraser' },
      ],
      colors: inkTool === 'marker' ? { list: STABILO_COLORS, active: markerColor }
        : inkTool === 'pen' || inkTool === 'line' ? { list: PEN_COLORS, active: penColor }
        : null,
    },
    {
      id: 'abdecken', icon: '◻', label: 'Abdecken',
      items: [
        { id: 'tippex', icon: '', chip: '#ffffff', label: 'Tipp-Ex', active: inkTool === 'tippex' },
        { id: 'redact', icon: '■', label: 'Schwärzen', active: inkTool === 'redact' },
      ],
    },
    {
      id: 'anbringen', icon: '⚑', label: 'Anbringen',
      items: [
        { id: 'stempel', icon: '✪', label: 'Stempel', active: stampChoice !== null },
        { id: 'fahne', icon: '⚑', label: 'Fahne', active: flagColor !== null || flagPicking },
      ],
      colors: flagPicking ? { list: FLAG_COLORS, active: flagColor } : null,
    },
    {
      id: 'seite', icon: '✄', label: 'Seite',
      items: [
        ...(!seitenfix ? [{ id: 'extract', icon: '⧉', label: 'Seite lösen' }] : []),
        { id: 'scissors', icon: '✄', label: 'Schere', active: inkTool === 'scissors' },
        { id: 'kopie', icon: '⎘', label: 'Kopie' },
        { id: 'licht', icon: '◐', label: 'Lichttisch', active: lichttisch },
      ],
    },
  ]);

  function radialPick(id: string) {
    flagPicking = false;
    if (id === 'pen' || id === 'marker' || id === 'line') {
      const warAktiv = inkTool === id;
      toggleTool(id);
      // Einschalten lässt das Menü für die Farbwahl offen; Ausschalten schließt.
      if (warAktiv) radial = null;
      return;
    }
    if (id === 'pencil' || id === 'eraser' || id === 'tippex' || id === 'redact' || id === 'scissors') {
      toggleTool(id);
    } else if (id === 'stempel') {
      if (stampChoice) stampChoice = null;
      else { stampMenu = true; flagColor = null; inkTool = null; }
    } else if (id === 'fahne') {
      if (flagColor) flagColor = null;
      else { flagPicking = true; stampChoice = null; inkTool = null; return; } // Farbbogen zeigen, offen lassen
    } else if (id === 'extract') {
      void desktop.command('extractPage', { docId: doc.id, page, position: { x: doc.position.x + size.w + 24, y: doc.position.y } });
    } else if (id === 'kopie') {
      void desktop.command('copyObject', { id: doc.id });
    } else if (id === 'licht') {
      lichttisch = !lichttisch;
    }
    radial = null;
  }

  function radialColor(groupId: string, farbe: string) {
    if (groupId === 'anbringen') {
      flagColor = farbe; flagPicking = false; stampChoice = null; inkTool = null;
    } else if (inkTool === 'marker') {
      markerColor = farbe; saveInkColor('marker', farbe);
    } else {
      penColor = farbe; saveInkColor('pen', farbe);
    }
    radial = null;
  }

  function radialClose() { flagPicking = false; radial = null; }

  function setFlagAt(e: PointerEvent) {
    if (!flagColor || !baseSize) return;
    e.stopPropagation();
    const p = pagePoint(e);
    if (!p) return;
    const offset = Math.min(1, Math.max(0, p.y / baseSize.h));
    void desktop.command('addFlag', { flag: { id: uid(), docId: doc.id, page, offset, color: flagColor } });
    flagColor = null; // eine Fahne pro Aktivierung — bewusst, kein Dauer-Modus
  }

  function stampAt(e: PointerEvent) {
    if (!stampChoice) return;
    e.stopPropagation();
    const p = pagePoint(e);
    if (!p || !baseSize) return;
    const heute = new Date().toISOString().slice(0, 10);
    void desktop.command('addStamp', {
      stamp: {
        id: uid(), docId: doc.id, page, x: p.x, y: p.y,
        angle: Math.random() * 12 - 6,
        text: stampChoice.text, color: stampChoice.color,
        ...(stampChoice.withDate ? { date: heute } : {}),
        baseW: baseSize.w, baseH: baseSize.h,
      },
    });
  }

  // Schere: Rechteck auf der Seite aufziehen -> Ausschnitt als eigenes Objekt daneben
  let schnitt = $state<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  let schnittPointer: number | null = null;
  function pagePoint(e: PointerEvent): { x: number; y: number } | null {
    const wrap = (e.currentTarget as HTMLElement).closest('.pagewrap');
    if (!wrap) return null;
    // Echte Bildschirmbreite statt nomineller pageWidth — der Viewer liegt in der
    // gezoomten Welt-Ebene (UAT-Befund: Schnitt/Stempel neben dem Cursor).
    return pagePointIn({ x: e.clientX, y: e.clientY }, wrap.getBoundingClientRect(), baseSize);
  }
  function schnittDown(e: PointerEvent) {
    if (e.button !== 0 || schnittPointer !== null) return;
    e.stopPropagation();
    const p = pagePoint(e);
    if (!p) return;
    schnittPointer = e.pointerId;
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* Komfort */ }
    schnitt = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
  }
  function schnittMove(e: PointerEvent) {
    if (e.pointerId !== schnittPointer || !schnitt) return;
    const p = pagePoint(e);
    if (p) schnitt = { ...schnitt, x1: p.x, y1: p.y };
  }
  function wartezeit(ms: number): Promise<''> {
    return new Promise((resolve) => setTimeout(() => resolve(''), ms));
  }
  /**
   * Fundstellen-Provenienz: Text im Rect holen (dieselben Bytes/Cache wie PageRenderer).
   * Alle Parameter kommen als Locals vom Aufrufer (eingefroren VOR dem await dort) — die
   * Funktion selbst liest keine reaktiven Felder (doc/kind/page/seitenQuelle sind $derived
   * und könnten sich während der bis zu 1,5 s laufenden Extraktion ändern). image/other sind
   * kein PDF -> gar nicht erst versuchen. Die GESAMTE Arbeit (Bytes-Beschaffung UND
   * Textsuche) läuft im Timeout-Race: bytesFor kann im Vorschau-Pfad (Konverter-Polling)
   * selbst bis zu 90 s dauern — allein textInRect zu befristen reichte nicht, Schneiden/
   * Abdecken durfte NIE auf einen hakenden Snapshot warten. Fehler/Zeitüberschreitung
   * liefern '', das Command wird trotzdem gesendet.
   */
  async function holeTextSnapshot(
    fileId: string, quelle: 'original' | 'preview', kindWert: string, seite: number,
    rect: { x: number; y: number; w: number; h: number },
  ): Promise<string> {
    if (kindWert === 'image' || kindWert === 'other' || !desktop.api) return '';
    const api = desktop.api;
    try {
      return await Promise.race([
        (async () => textInRect(await bytesFor(api, fileId, quelle), seite, rect))(),
        wartezeit(1500),
      ]);
    } catch {
      return '';
    }
  }
  async function schnittUp(e: PointerEvent) {
    if (e.pointerId !== schnittPointer) return;
    schnittPointer = null;
    const sn = schnitt;
    // Schnittrahmen sofort ausblenden (einfachere Variante) — das Command folgt bis zu 1,5 s
    // später, sobald der Text-Snapshot da ist oder der Timeout greift.
    schnitt = null;
    if (!sn) return;
    const rect = {
      x: Math.min(sn.x0, sn.x1), y: Math.min(sn.y0, sn.y1),
      w: Math.abs(sn.x1 - sn.x0), h: Math.abs(sn.y1 - sn.y0),
    };
    if (rect.w < 12 || rect.h < 12) return; // Mini-Wischer verwerfen
    // Alles Payload-Relevante SOFORT einfrieren — Blättern (Pager/Pfeiltasten, nicht durch
    // rectTool gesperrt), Werkzeugwechsel (Tipp-Ex ↔ Schwärzung) oder ein Kartenzug dürfen
    // Seite/Kind/Ablageort während der bis zu 1,5 s laufenden Extraktion nicht rückwirkend
    // ändern (Race sonst: Cutout/Mark trägt Rect der alten, aber Nummer der neuen Seite).
    const docId = doc.id;
    const seite = page;
    const fileId = doc.fileId;
    const quelle = seitenQuelle;
    const kindWert = kind;
    const werkzeug = rectTool;
    const ablagePosition = { x: doc.position.x + size.w + 24, y: doc.position.y + 40 };
    // Ebenso den Schreibtisch einfrieren: ein Desk-Wechsel während der Extraktion (bis 1,5 s)
    // darf das Command nicht am inzwischen falschen Schreibtisch abliefern (400, Schnitt
    // verloren) — desktop.command() liest die deskId erst beim Senden, nicht beim Aufruf hier.
    const deskBeimSchnitt = desktop.deskId;
    if (werkzeug === 'scissors') {
      inkTool = null;
      const textSnapshot = await holeTextSnapshot(fileId, quelle, kindWert, seite, rect);
      if (desktop.deskId !== deskBeimSchnitt) return; // Nutzer ist inzwischen woanders — still verwerfen
      void desktop.command('addCutout', {
        docId, page: seite, rect,
        position: ablagePosition,
        ...(textSnapshot ? { textSnapshot } : {}),
      });
    } else if (werkzeug) {
      // Tipp-Ex/Schwärzung: Werkzeug bleibt aktiv (mehrere Flächen nacheinander)
      const textSnapshot = await holeTextSnapshot(fileId, quelle, kindWert, seite, rect);
      if (desktop.deskId !== deskBeimSchnitt) return; // Nutzer ist inzwischen woanders — still verwerfen
      void desktop.command('addMark', {
        mark: { id: uid(), docId, page: seite, rect, kind: werkzeug, ...(textSnapshot ? { textSnapshot } : {}) },
      });
    }
  }
  const schnittCss = $derived.by(() => {
    if (!schnitt || !baseSize) return null;
    const f = pageWidth / baseSize.w; // Basiskoordinaten -> Overlay-Pixel
    return {
      left: Math.min(schnitt.x0, schnitt.x1) * f,
      top: Math.min(schnitt.y0, schnitt.y1) * f,
      w: Math.abs(schnitt.x1 - schnitt.x0) * f,
      h: Math.abs(schnitt.y1 - schnitt.y0) * f,
    };
  });

  // Aufgeschlagene Karte direkt fokussieren, damit die Pfeiltasten sofort blättern.
  onMount(() => wrapEl?.focus({ preventScroll: true }));

  let dragging = false, moved = false;
  let headLast = { x: 0, y: 0 };
  /** Wartende Verknüpfung/Klammer zum offenen Viewer vervollständigen (Wunsch A5.5). */
  function verbindungAngenommen(): boolean {
    if (ui.linkingFromId && ui.linkingFromId !== doc.id) {
      const from = ui.linkingFromId;
      ui.linkingFromId = null;
      void desktop.command('addLink', { fromId: from, toId: doc.id, id: uid() });
      return true;
    }
    if (ui.linkingFromId === doc.id) { ui.linkingFromId = null; return true; }
    if (ui.clippingFromId && ui.clippingFromId !== doc.id) {
      const from = ui.clippingFromId;
      ui.clippingFromId = null;
      desktop.command('addClip', { aId: from, bId: doc.id, id: uid() })
        .catch((err) => showToast(err instanceof Error ? err.message : 'Anklammern fehlgeschlagen'));
      return true;
    }
    if (ui.clippingFromId === doc.id) { ui.clippingFromId = null; return true; }
    // COMP-03 (09-07): „Ist neue Version von…" steht auf der NEUEREN Fassung (ui.versionFromId
    // merkt deren id), der nächste Klick wählt die ÄLTERE — addVersionLink erhält die geklickte
    // Karte als olderId und die gemerkte als newerId (Richtung siehe menus.ts-Kommentar). Die
    // Ablehnung (zweiter Vorgänger, Zyklus) kommt vom Server als Toast — bewusst keine
    // Client-Vorprüfung, die bei nebenläufiger Bearbeitung eine falsche Zusage geben könnte.
    if (ui.versionFromId && ui.versionFromId !== doc.id) {
      const newerId = ui.versionFromId;
      ui.versionFromId = null;
      void desktop.command('addVersionLink', { olderId: doc.id, newerId, id: uid() });
      return true;
    }
    if (ui.versionFromId === doc.id) { ui.versionFromId = null; return true; }
    // COMP-01 (09-07): „Vergleichen mit…" wartet auf das zweite Dokument — der nächste Klick
    // öffnet den Vergleichsviewer direkt (ui.vergleich, Plan 09-09).
    if (ui.compareFromId && ui.compareFromId !== doc.id) {
      const aId = ui.compareFromId;
      ui.compareFromId = null;
      ui.vergleich = { aId, bId: doc.id };
      return true;
    }
    if (ui.compareFromId === doc.id) { ui.compareFromId = null; return true; }
    return false;
  }

  let pressTimer: ReturnType<typeof setTimeout> | undefined;
  function onHeaderPointerDown(e: PointerEvent) {
    if ((e.target as HTMLElement).closest('button')) return; // Klicks auf ‹ › ✕ nicht als Drag verschlucken
    if (e.button !== 0) return;
    e.stopPropagation();
    if (verbindungAngenommen()) return;
    if (doc.taped) {
      // Festgeklebt: kein Drag — aber das Lang-Druck-Menü bleibt erreichbar (Muster Karten/A9.8)
      clearTimeout(pressTimer);
      pressTimer = undefined;
      headLast = { x: e.clientX, y: e.clientY };
      if (e.pointerType !== 'mouse') {
        pressTimer = setTimeout(() => { showViewerMenuAt(headLast.x + 16, headLast.y + 12, doc); }, 500);
      }
      return;
    }
    dragging = true; moved = false;
    headLast = { x: e.clientX, y: e.clientY };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    void desktop.command('bringToFront', { id: doc.id });
    clearTimeout(pressTimer);
    pressTimer = undefined;
    if (e.pointerType !== 'mouse') {
      // Lang-Druck auf die Kopfzeile öffnet das Kontextmenü (Muster DocCard, Wunsch A3.4)
      pressTimer = setTimeout(() => { dragging = false; showViewerMenuAt(headLast.x + 16, headLast.y + 12, doc); }, 500);
    }
  }
  function onHeaderPointerMove(e: PointerEvent) {
    if (!dragging) return;
    if (pressTimer) {
      // Lang-Druck toleriert leichtes Zittern; echte Bewegung bricht ihn ab und zieht.
      if (Math.hypot(e.clientX - headLast.x, e.clientY - headLast.y) <= 8) return;
      clearTimeout(pressTimer);
      pressTimer = undefined;
    }
    moved = true;
    const dx = (e.clientX - headLast.x) / vp.scale;
    const dy = (e.clientY - headLast.y) / vp.scale;
    headLast = { x: e.clientX, y: e.clientY };
    desktop.applyLocal((s) => moveDoc(s, doc.id, { x: doc.position.x + dx, y: doc.position.y + dy }));
  }
  function onHeaderPointerUp() {
    clearTimeout(pressTimer);
    pressTimer = undefined;
    if (!dragging) return;
    dragging = false;
    if (moved) void desktop.command('moveDoc', { id: doc.id, position: { x: doc.position.x, y: doc.position.y } });
  }

  // Blättern wirkt sofort lokal; der Server bekommt gebündelt nur die letzte Seite.
  let pendingPage: number | null = null;
  const sendPage = debounce(350, (p: number) => {
    pendingPage = null;
    void desktop.command('setDocPage', { id: doc.id, page: p });
  });
  onDestroy(() => {
    sendPage.cancel();
    clearTimeout(pressTimer);
    clearTimeout(bodyPress);
    if (pendingPage !== null && desktop.status === 'online') {
      void desktop.command('setDocPage', { id: doc.id, page: pendingPage });
    }
    // Viewer wird geschlossen/zerstört, während noch annotiert wurde — ohne diesen Aufräumpfad
    // bliebe das Bearbeitungssignal bis zum serverseitigen TTL-Ablauf stehen (06-04, COLLAB-02).
    if (annotierteSignalisiert) ruhtJetzt();
  });

  function turn(delta: number) {
    if (seitenfix) return;
    const next = page + delta;
    if (next < 1 || (pageCount !== null && next > pageCount)) return;
    desktop.applyLocal((s) => setDocPage(s, doc.id, next));
    pendingPage = next;
    sendPage(next);
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === 'ArrowLeft') { e.preventDefault(); turn(-1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); turn(1); }
  }

  // Wischen zum Blättern (horizontal) — bei aktivem Zeichenwerkzeug deaktiviert.
  // Lang-Druck (Touch, 500 ms, <8 px Bewegung) öffnet das Radial-Menü.
  let swipeX = 0, swiping = false;
  let bodyPress: ReturnType<typeof setTimeout> | undefined;
  let bodyPressStart = { x: 0, y: 0 };
  function onBodyPointerDown(e: PointerEvent) {
    if (verbindungAngenommen()) { e.stopPropagation(); return; }
    if (inkTool) return;
    if (e.pointerType === 'touch') {
      swiping = true; swipeX = e.clientX;
      if (!stampChoice && !flagColor) {
        bodyPressStart = { x: e.clientX, y: e.clientY };
        clearTimeout(bodyPress);
        bodyPress = setTimeout(() => { swiping = false; radial = { x: bodyPressStart.x, y: bodyPressStart.y }; }, 500);
      }
    }
  }
  function onBodyPointerMove(e: PointerEvent) {
    if (bodyPress && Math.hypot(e.clientX - bodyPressStart.x, e.clientY - bodyPressStart.y) > 8) {
      clearTimeout(bodyPress); bodyPress = undefined;
    }
  }
  function onBodyPointerUp(e: PointerEvent) {
    clearTimeout(bodyPress); bodyPress = undefined;
    if (!swiping) return; swiping = false;
    const dx = e.clientX - swipeX;
    if (Math.abs(dx) > 50) turn(dx < 0 ? 1 : -1);
  }

  // Größe ziehen (Anfasser unten rechts)
  let resizing = false;
  let gripLast = { x: 0, y: 0 };
  function onResizeDown(e: PointerEvent) {
    e.stopPropagation(); e.preventDefault();
    resizing = true;
    gripLast = { x: e.clientX, y: e.clientY };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onResizeMove(e: PointerEvent) {
    if (!resizing) return;
    const dx = (e.clientX - gripLast.x) / vp.scale;
    const dy = (e.clientY - gripLast.y) / vp.scale;
    gripLast = { x: e.clientX, y: e.clientY };
    const w = Math.max(220, size.w + dx);
    const h = Math.max(280, size.h + dy);
    desktop.applyLocal((s) => ({ ...s, docs: s.docs.map((d) => d.id === doc.id ? { ...d, openSize: { w, h } } : d) }));
  }
  function onResizeUp() {
    if (!resizing) return;
    resizing = false;
    void desktop.command('resizeDoc', { id: doc.id, size: { w: size.w, h: size.h } });
  }

  // Versionsketten-Popover: Kollisions-Clamping im Viewport (Muster ProvenancePopover.svelte).
  const VK_RAND = 12;
  const VK_POP_W = 300;
  const VK_POP_H = 340;
  const versionKettePopoverPos = $derived.by(() => {
    const ax = versionKettePopoverAnchor?.x ?? window.innerWidth / 2;
    const ay = versionKettePopoverAnchor?.y ?? window.innerHeight / 2;
    const maxX = Math.max(VK_RAND, window.innerWidth - VK_POP_W - VK_RAND);
    const maxY = Math.max(VK_RAND, window.innerHeight - VK_POP_H - VK_RAND);
    return { x: Math.min(Math.max(ax, VK_RAND), maxX), y: Math.min(Math.max(ay, VK_RAND), maxY) };
  });
</script>

<svelte:window onkeydown={(e) => {
  if (versionKettePopoverOffen && e.key === 'Escape') { versionKettePopoverSchliessen(); return; }
  if (document.activeElement === wrapEl) onKey(e);
}} />

<!-- svelte-ignore a11y_no_noninteractive_tabindex -- der Viewer ist bewusst fokussierbar: Pfeiltasten blättern -->
<div class="viewer" class:licht={lichttisch} role="group"
     aria-label={statusKurz ? `${doc.name} — ${statusKurz}, ${statusErklaerung}` : doc.name}
     bind:this={wrapEl} tabindex="0"
     style:left="{doc.position.x}px" style:top="{doc.position.y}px" style:z-index={doc.zIndex}
     style:width="{size.w}px" style:height="{size.h}px">
  <div class="head" role="toolbar" tabindex="-1" aria-label="Dokumentleiste" onpointerdown={onHeaderPointerDown} onpointermove={onHeaderPointerMove} onpointerup={onHeaderPointerUp} onpointercancel={onHeaderPointerUp}
       oncontextmenu={(e) => { e.preventDefault(); e.stopPropagation(); showViewerMenuAt(e.clientX, e.clientY, doc); }}>
    <span class="title" title={statusKurz ? `${statusKurz} — ${statusErklaerung}` : undefined}>{doc.name}</span>
    {#if quelleWeg}
      <span class="status-badge gone" aria-hidden="true">In j-lawyer gelöscht</span>
    {:else if entzogen}
      <span class="status-badge entzogen" aria-hidden="true">Zugriff entzogen</span>
    {:else if nichtErreichbar}
      <span class="status-badge unerreichbar" aria-hidden="true">Nicht erreichbar</span>
    {:else if neueFassung}
      <span class="status-badge neu" aria-hidden="true">Neue Fassung</span>
    {:else if umbenannt}
      <span class="status-badge umbenannt" aria-hidden="true">Umbenannt</span>
    {:else if archiviert}
      <span class="status-badge archiviert" aria-hidden="true">Archiviert</span>
    {/if}
    <button class="werkzeuge" onclick={openRadialCentered} aria-label="Werkzeuge" title="Werkzeuge">🧰</button>
    {#if versionKette.length > 1}
      <!-- Nur sichtbar, wenn dieses Dokument Teil einer (für diesen Betrachter sichtbaren)
           Versionskette ist — ein Dokument ohne Kette bekommt keinen Knopf, der nichts zeigt. -->
      <button class="versionskette" onclick={versionKettePopoverOeffnen}
              aria-label="Versionskette anzeigen" title="Versionskette anzeigen">🔗</button>
    {/if}
    <button class="info" onclick={(e) => { ui.provenancePopover = { id: doc.id, anchor: { x: e.clientX, y: e.clientY } }; }}
            aria-label="Herkunft anzeigen" title="Herkunft anzeigen">ⓘ</button>
    {#if bildmodus}
      <span class="pos">Bild</span>
    {:else if seitenfix}
      <span class="pos">S. {page}</span>
    {:else}
      <span class="pager">
        <button onclick={() => turn(-1)} disabled={page <= 1} aria-label="Zurück">‹</button>
        <span class="pos">{page}{#if pageCount} / {pageCount}{/if}</span>
        <button onclick={() => turn(1)} disabled={pageCount !== null && page >= pageCount} aria-label="Weiter">›</button>
      </span>
    {/if}
    <button class="close" onclick={() => void desktop.command('collapseDoc', { id: doc.id })} aria-label="Schließen">✕</button>
  </div>
  {#if ersetztBannerSichtbar}
    <div class="sprung-banner" role="status">
      <span>Dokument wurde seither ersetzt — Anzeige entspricht dem Stand von damals.</span>
      <button class="schliessen" onclick={() => (ersetztBannerSichtbar = false)} aria-label="Hinweis schließen" title="Schließen">✕</button>
    </div>
  {/if}
  {#if stampMenu}<StampPopover onpick={pickStamp} onclose={() => (stampMenu = false)} />{/if}
  <div class="body" role="presentation" onwheel={(e) => { if (!e.ctrlKey && !e.metaKey) e.stopPropagation(); }} onpointerdown={onBodyPointerDown} onpointermove={onBodyPointerMove} onpointerup={onBodyPointerUp}
       oncontextmenu={(e) => { e.preventDefault(); e.stopPropagation(); radial = { x: e.clientX, y: e.clientY }; }}>
    {#if desktop.api}
      <div class="pagewrap">
        {#if bildmodus}
          <ImagePage api={desktop.api} fileId={doc.fileId} name={doc.name} targetWidth={pageWidth}
            onbasesize={(s) => (baseSize = s)} />
        {:else}
          <PageRenderer api={desktop.api} fileId={doc.fileId} {page} targetWidth={pageWidth} source={seitenQuelle}
            onpagecount={(n) => (pageCount = n)} onbasesize={(s) => (baseSize = s)} />
        {/if}
        <InkOverlay docId={doc.id} {page} base={baseSize} renderedWidth={pageWidth}
          colors={{ pen: penColor, marker: markerColor }}
          tool={inkTool === 'scissors' || inkTool === 'tippex' || inkTool === 'redact' ? null : inkTool} />
        {#if rectTool && baseSize}
          <div class="schnittflaeche" role="presentation"
               onpointerdown={schnittDown} onpointermove={schnittMove} onpointerup={schnittUp}
               onpointercancel={() => { schnittPointer = null; schnitt = null; }}>
            {#if schnittCss}
              <div class="schnittrahmen" class:tippex={rectTool === 'tippex'} class:redact={rectTool === 'redact'}
                   style:left="{schnittCss.left}px" style:top="{schnittCss.top}px"
                   style:width="{schnittCss.w}px" style:height="{schnittCss.h}px"></div>
            {/if}
          </div>
        {/if}
        <MarkLayer docId={doc.id} {page} base={baseSize} renderedWidth={pageWidth}
                   active={inkTool === 'tippex' || inkTool === 'redact' ? inkTool : null} />
        {#if stampChoice && baseSize}
          <div class="stempelflaeche" role="presentation" onpointerdown={stampAt}></div>
        {/if}
        {#if flagColor && baseSize}
          <div class="stempelflaeche" role="presentation" onpointerdown={setFlagAt}></div>
        {/if}
        <StampLayer docId={doc.id} {page} base={baseSize} renderedWidth={pageWidth} active={stampChoice !== null} />
        <!-- Sprung zur Quelle: eigene Sichtbarkeit, daher ganz ans Ende des Stapels (Lehre Werkzeugkasten-Runde). -->
        <SourceHighlight docId={doc.id} {page} base={baseSize} renderedWidth={pageWidth} />
      </div>
    {/if}
  </div>
  <div class="rail" bind:clientHeight={bodyH} aria-hidden={false}>
    <FlagRail {doc} height={bodyH} active={flagColor !== null}
              onjump={(p) => { if (!seitenfix) { desktop.applyLocal((s) => setDocPage(s, doc.id, p)); pendingPage = p; sendPage(p); } }} />
  </div>
  <div class="grip" onpointerdown={onResizeDown} onpointermove={onResizeMove} onpointerup={onResizeUp} onpointercancel={onResizeUp} aria-hidden="true"></div>
  {#if radial}
    <RadialMenu x={radial.x} y={radial.y} groups={radialGroups}
                onpick={radialPick} oncolor={radialColor} onclose={radialClose} />
  {/if}
</div>

{#if versionKettePopoverOffen}
  <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -- Backdrop schließt nur -->
  <div class="vk-backdrop" onpointerdown={versionKettePopoverSchliessen}></div>
  <div class="vk-pop" role="dialog" tabindex="-1" aria-label="Versionskette"
       style:left="{versionKettePopoverPos.x}px" style:top="{versionKettePopoverPos.y}px"
       onpointerdown={(e) => e.stopPropagation()}>
    <h2>Versionskette</h2>
    <ul class="vk-liste">
      {#each versionKette as vId, i (vId)}
        {@const vDoc = findDoc(desktop.state, vId)}
        <li class="vk-zeile" class:aktiv={vId === doc.id}>
          <input type="checkbox" checked={versionKetteAuswahl.includes(vId)}
                 onchange={() => versionAuswahlUmschalten(vId)}
                 aria-label={`Version ${i + 1} für Vergleich auswählen`} />
          <button class="vk-oeffnen" onclick={() => versionOeffnen(vId)}>
            <!-- Die Zählung "Version n von N" liest ausschließlich aus versionKette (oben,
                 versionKetteVon auf dem projizierten Client-Zustand) — i/versionKette.length,
                 keine zweite Zahlenquelle (T-09-27). -->
            <span class="vk-index">Version {i + 1} von {versionKette.length}</span>
            <span class="vk-name">{vDoc?.name ?? 'Unbekanntes Dokument'}</span>
          </button>
        </li>
      {/each}
    </ul>
    <div class="vk-row">
      <button class="vk-vergleichen" disabled={versionKetteAuswahl.length !== 2} onclick={versionenVergleichen}>Fassungen vergleichen</button>
      <button class="vk-schliessen" onclick={versionKettePopoverSchliessen}>Schließen</button>
    </div>
  </div>
{/if}

<style>
  .viewer { position: absolute; display: flex; flex-direction: column; background: #fff; border-radius: 6px;
            box-shadow: 0 10px 34px rgba(0, 0, 0, .45); overflow: hidden; touch-action: none; }
  .viewer:focus { outline: 2px solid var(--brand-blue); }
  /* Lichttisch: Papier wird durchscheinend, darunterliegende Seiten schimmern durch */
  .viewer.licht { opacity: .58; }
  .viewer.licht .body { background: transparent; }
  .head { display: flex; align-items: center; gap: 8px; padding: 6px 8px;
          background: rgba(255, 255, 255, .78);
          backdrop-filter: var(--glass-blur-card); -webkit-backdrop-filter: var(--glass-blur-card);
          border-bottom: 1px solid rgba(8, 31, 57, .10); cursor: grab; user-select: none; }
  .title { flex: 1; font-size: 12px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  /* Referenzstatus-Kurzbadge — gleiche Priorität/Farben wie auf der Karte (DocCard); pointer-events: none,
     das Ziehen der Kopfleiste bleibt unangetastet. */
  .status-badge { flex: none; pointer-events: none; font-size: 9px; font-weight: 700; text-transform: uppercase;
                   letter-spacing: .04em; color: #fff; padding: 2px 7px; border-radius: 999px;
                   white-space: nowrap; max-width: 140px; overflow: hidden; text-overflow: ellipsis; }
  .status-badge.gone { background: rgba(122, 32, 32, .88); }
  .status-badge.neu { background: rgba(21, 92, 62, .88); }
  .status-badge.umbenannt { background: rgba(13, 74, 130, .88); }
  .status-badge.unerreichbar { background: rgba(150, 92, 10, .88); }
  .status-badge.entzogen { background: rgba(107, 30, 84, .88); }
  .status-badge.archiviert { background: rgba(70, 70, 78, .88); }
  /* Sprung-Banner (01-06): lokal im Viewer verankert (nicht global fixiert wie .sync-banner),
     neutraler/informativer Ton — kein Fehlerzustand, sondern eine Einordnung. */
  .sprung-banner { position: absolute; top: 40px; left: 8px; right: 8px; z-index: 40;
                   display: flex; align-items: center; gap: 10px;
                   background: var(--glass-panel-bg); border: 1px solid var(--glass-border);
                   backdrop-filter: var(--glass-blur-panel); -webkit-backdrop-filter: var(--glass-blur-panel);
                   border-radius: 10px; padding: 8px 14px; color: var(--glass-text);
                   font-size: 12.5px; line-height: 1.4; }
  .sprung-banner span { flex: 1; }
  .sprung-banner .schliessen { flex: none; border: none; background: transparent; cursor: pointer;
                                font-size: 13px; line-height: 1; color: var(--glass-text-secondary);
                                padding: 2px; }
  .pager { display: flex; align-items: center; gap: 6px; }
  .werkzeuge, .info, .versionskette { border: none; background: #e7ebf2; border-radius: 5px; cursor: pointer;
               width: 24px; height: 24px; font-size: 13px; line-height: 1; }
  .pagewrap { position: relative; width: fit-content; }
  .pager button, .close { border: none; background: #e7ebf2; border-radius: 5px; cursor: pointer;
          width: 24px; height: 24px; font-size: 15px; line-height: 1; }
  .pager button:disabled { opacity: .4; cursor: default; }
  .pos { font-size: 12px; font-variant-numeric: tabular-nums; min-width: 44px; text-align: center; }
  .body { flex: 1; overflow: auto; display: flex; justify-content: center; align-items: flex-start;
          background: #52616b; padding: 10px; }
  .grip { position: absolute; right: 0; bottom: 0; width: 18px; height: 18px; cursor: nwse-resize;
          background: linear-gradient(135deg, transparent 50%, #b8c0cc 50%); }
  .schnittflaeche { position: absolute; inset: 0; cursor: crosshair; touch-action: none; }
  .stempelflaeche { position: absolute; inset: 0; cursor: crosshair; touch-action: none; }
  .schnittrahmen { position: absolute; border: 2px dashed var(--brand-red); background: var(--brand-red-soft);
                   pointer-events: none; }
  .schnittrahmen.tippex { border-color: #8a94a3; background: rgba(255, 255, 255, .35); }
  .schnittrahmen.redact { border-color: #111; background: rgba(0, 0, 0, .18); }
  /* Notizfahnen-Rail: Geschwister nach .body, damit die Laschen an der Viewer-Kante stehenbleiben,
     auch wenn der Seiteninhalt im .body scrollt. 36px ≈ Kopfzeilenhöhe; width: 0 hält die Rail aus
     dem Layoutfluss, die Laschen positionieren sich innerhalb absolut. */
  .rail { position: absolute; top: 36px; right: 0; bottom: 0; width: 0; overflow: visible; }

  /* Versionsketten-Popover (COMP-03, Task 3): Vorlage AuswertungsPanel.svelte-Zeilenliste,
     deutlich kompakter, kein Vollbild-Overlay (09-UI-SPEC.md Komponentenkontrakt). */
  .vk-backdrop { position: fixed; inset: 0; z-index: 9600; }
  .vk-pop { position: fixed; z-index: 9700; width: min(300px, 92vw); max-height: min(360px, 70vh);
            box-sizing: border-box; display: flex; flex-direction: column;
            background: var(--glass-elevated-bg); border: 1px solid var(--glass-border);
            backdrop-filter: var(--glass-blur-elevated); -webkit-backdrop-filter: var(--glass-blur-elevated);
            border-radius: 12px; box-shadow: var(--glass-shadow-lg); padding: 14px 16px 16px; color: var(--glass-text); }
  .vk-pop h2 { margin: 0 0 8px; font-size: 15px; font-weight: 600; line-height: 1.3; }
  /* sm-Gap (8px, 09-UI-SPEC.md Spacing Scale) zwischen den Zeilen der Versionsketten-Liste;
     overflow-y: auto statt Abschneiden bei einer langen Kette (09-UI-SPEC.md UI Considerations). */
  .vk-liste { list-style: none; margin: 0; padding: 0; flex: 1; overflow-y: auto;
              display: flex; flex-direction: column; gap: 8px; }
  .vk-zeile { display: flex; align-items: center; gap: 6px; }
  .vk-zeile input[type='checkbox'] { flex: none; }
  .vk-oeffnen { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: flex-start; gap: 1px;
                border: 1px solid transparent; background: none; text-align: left; cursor: pointer;
                padding: 5px 6px; border-radius: 8px; color: var(--glass-text); font: inherit; }
  .vk-oeffnen:hover { background: var(--glass-hover); }
  /* Aktuell geöffnete Fassung hervorgehoben — Bestandsmuster .abfrage-knopf.aktiv (AuswertungsPanel.svelte). */
  .vk-zeile.aktiv .vk-oeffnen { background: var(--brand-blue-soft); border-color: var(--brand-blue); }
  .vk-index { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em;
              color: var(--glass-text-secondary); }
  .vk-name { max-width: 100%; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .vk-row { display: flex; justify-content: space-between; gap: 8px; margin-top: 10px; }
  .vk-row button { font-size: 12px; cursor: pointer; border: 1px solid var(--glass-separator); background: transparent;
                    color: var(--glass-text); border-radius: 8px; padding: 6px 10px; font: inherit; }
  .vk-vergleichen:disabled { opacity: .5; cursor: default; }
</style>
