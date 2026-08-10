import {
  aktuelleSitzungsmappe,
  clipOf, collectLinkedDocs, effektiveFreigabe, findeEbene, isTaped,
  TASK_STATUSES, TASK_PRIORITIES, FORMEL_ARTEN,
  type Cutout, type Doc, type DesktopState, type Ebene, type ExternRef, type Flag, type FormelArt, type Freigabe, type LegalObject, type LegalObjectKind, type Mark, type Note, type NoteKind,
  type Rolle, type Stack, type Stamp, type TableCard, type TaskStatus, type TaskPriority, type ZeitleisteCard,
} from '@j-desk/core';
import { uid } from './uid';
import { desktop, anzeigeEbeneId, EBENE_ICON, sortierteEbenenFuerPanel, darfAktionClient } from './store.svelte';
import { fundstelleAusCutout, fundstelleAusFlag, fundstelleAusMark, fundstelleAusStamp, fundstelleAusTaskDocRef } from './jump';
import { ui, showToast, type MenuItem } from './ui.svelte';
import { getFileUrl } from './fileCache';
import { imageMime } from './thumbnails';
import { auswahlAusStapel, ergaenzeAuswahl } from './anlagenpaketAuswahl';

// ---- Task 3: Kontextmenü „Ebene ändern" + dezenter Ebenen-Chip (PERM-01/PERM-02) ----

/**
 * Flache Ebenenliste für das Zweischritt-Kontextmenü (feste Ebenen + benutzerdefinierte
 * Kanzlei-Ebenen, gleiche Reihenfolge wie das Sichtbarkeits-Panel); der aktuelle Eintrag
 * trägt das „✓ "-Präfix. Fehlende `aktuelleLayerId` gilt implizit als 'kanzlei'.
 *
 * IN-02 (02-REVIEW Iteration 3): für den Kommentator wird die Zielliste auf das serverseitig
 * erlaubte Ebenenpaar 'kanzlei' + 'privat' gefiltert (Ebenenpaar-Regel 02-09, app.ts) — alles
 * andere wäre ein garantierter 403-Toast. Der Server bleibt die Sicherheitsgrenze; der Filter
 * ist reine Komfort-Spiegelung, analog zu darfEbeneBearbeitenClient. Ohne Rollen-Argument
 * (optionaler Parameter) bleibt die Liste ungefiltert (Bestandsverhalten).
 */
export function buildEbenenMenu(
  state: DesktopState,
  aktuelleLayerId: string | undefined,
  onSelect: (layerId: string) => void,
  rolle?: Rolle | null,
): MenuItem[] {
  const aktuelle = aktuelleLayerId ?? 'kanzlei';
  return sortierteEbenenFuerPanel(state)
    .filter((ebene) => (rolle === 'Kommentator' ? ebene.typ === 'kanzlei' || ebene.typ === 'privat' : true))
    .map((ebene) => ({
      label: `${ebene.id === aktuelle ? '✓ ' : ''}${EBENE_ICON[ebene.typ]} ${ebene.name}`,
      action: () => onSelect(ebene.id),
    }));
}

/**
 * Ob der Actor das Objekt-auf-dieser-Ebene umhängen darf — steuert, ob „Ebene ändern"
 * überhaupt im Kontextmenü erscheint (fehlt vollständig statt deaktiviert, Decision).
 *
 * Kein `userId`-Vergleich nötig: der Server liefert private Fremdobjekte gar nicht erst aus
 * (projectStateForActor(), PERM-05) — ein hier überhaupt SICHTBARES Objekt auf einer
 * `privat`-Ebene MUSS also die eigene sein. Spiegelt `darfEbeneBearbeiten()` (@j-desk/core)
 * ohne den dort nötigen ActorContext, weil dessen userId-Bedingung clientseitig trivial wahr ist.
 */
export function darfEbeneBearbeitenClient(ebeneTyp: Ebene['typ'] | undefined, rolle: Rolle | null): boolean {
  if (ebeneTyp === 'ki-vorschlaege') return false;
  if (ebeneTyp === 'privat') return true;
  // rolle === null: j-lawyer-Modus, noch keine Rollenvergabe (Bestandsverhalten "erlaubt", wie desktop.kannEbenenVerwalten).
  if (rolle === null) return true;
  return rolle === 'Eigentümer' || rolle === 'Bearbeiter';
}

/**
 * Dezente Ebenen-Kennzeichnung am Objekt (UI-SPEC Icon-Tabelle): kein Chip bei Kanzlei-Standard
 * oder fehlender/unbekannter layerId (partial-Migration — reguläres Kanzlei-Verhalten ohne
 * sichtbaren Zwischenzustand); genau ein Chip sonst (privat/KI-Vorschläge/exportierbar/custom).
 * 02-11: die layerId wird zuerst über anzeigeEbeneId() auf die Panel-Zeile abgebildet — die
 * eigene Privat-Instanz (`privat-<userId>`, 02-09) zeigt so den 🔒-Chip der Zeile 'privat'.
 */
export function chipFuerEbene(layerId: string | undefined, state: DesktopState): { icon: string; label: string } | null {
  const id = anzeigeEbeneId(state, layerId);
  if (id === 'kanzlei') return null;
  const ebene = sortierteEbenenFuerPanel(state).find((e) => e.id === id);
  if (!ebene || ebene.typ === 'kanzlei') return null;
  return { icon: EBENE_ICON[ebene.typ], label: ebene.name };
}

/** Baut den Eintrag „Ebene ändern" (fehlt vollständig ohne Bearbeitungsrecht) für ein Objekt
 *  an Position x/y — Klick ersetzt `ui.menu` an derselben Stelle durch die flache Ebenenliste. */
function ebeneAendernEintrag(x: number, y: number, objektId: string, layerId: string | undefined): MenuItem[] {
  // Ebenen-Typ direkt über findeEbene mit state.layers bestimmen (02-11): die eigene
  // Privat-Instanz (id `privat-<userId>`) steht NICHT in der Panel-Liste (die enthält nur
  // SYSTEM_EBENEN + custom), wohl aber in state.layers — so liefert sie typ 'privat' und der
  // Eintrag erscheint auch für den Kommentator auf seinen eigenen Notizen (Server-Regel 02-09).
  // Der Befund aus darfEbeneBearbeitenClient bleibt zutreffend: ein hier sichtbares
  // Privatobjekt MUSS das eigene sein (Projektions-Filter, PERM-05).
  const ebene = findeEbene(layerId ?? 'kanzlei', desktop.state.layers);
  if (!darfEbeneBearbeitenClient(ebene?.typ, desktop.myRolle)) return [];
  return [{
    label: 'Ebene ändern',
    action: () => {
      // IN-01 (02-REVIEW Iteration 3): die rohe layerId liegt bei einer eigenen Privat-Instanz
      // als `privat-<userId>` vor — ohne anzeigeEbeneId()-Auflösung matcht keine Panel-Zeile
      // und der ✓-Haken fehlt, obwohl das Objekt auf „Privat" liegt (02-11-Mapping auch hier).
      // IN-02: die eigene Rolle steuert die Komfort-Filterung garantierter 403-Ziele
      // (Kommentator: nur kanzlei/privat, Ebenenpaar-Regel 02-09).
      const items = buildEbenenMenu(desktop.state, anzeigeEbeneId(desktop.state, layerId), (ziel) => {
        void desktop.command('changeLayerId', { objectId: objektId, layerId: ziel });
      }, desktop.myRolle);
      ui.menu = { x, y, items };
    },
  }];
}

// ---- 03-06: Kontextmenü „Freigabe" + Freigabe-Chip (EXP-03, D-05/D-06) ----

/** Anzeigenamen der drei Freigabe-Stufen (03-UI-SPEC Copywriting Contract) — geteilt zwischen
 *  Kontextmenü, Chip und Herkunfts-Popover, damit die Begriffe überall identisch bleiben. */
export const FREIGABE_LABEL: Record<Freigabe, string> = {
  intern: 'Intern',
  mandant: 'Mandantensichtbar',
  export: 'Exportierbar',
};

/** Flache Stufenliste für das Zweischritt-Menü; nur „Mandantensichtbar" trägt die
 *  Kurzbeschreibung — die nichttriviale Semantik (sichtbar für externe Gäste, aber NICHT
 *  im Export) wird am Punkt der Entscheidung erklärt (D-06, UI-SPEC-Copy verpflichtend). */
const FREIGABE_STUFEN: readonly { stufe: Freigabe; label: string }[] = [
  { stufe: 'intern', label: FREIGABE_LABEL.intern },
  { stufe: 'mandant', label: 'Mandantensichtbar (sichtbar für externe Gäste, nicht im Export)' },
  { stufe: 'export', label: FREIGABE_LABEL.export },
];

const FREIGABE_ICON: Record<Freigabe, string> = { intern: '🔒', mandant: '👤', export: '📤' };

/**
 * Dezente Freigabe-Kennzeichnung am Objekt (03-UI-SPEC): kein Chip im Ebenen-Default —
 * der Normalfall bleibt clean (Decision-Muster wie Referenzstatus „existiert" und
 * Kanzlei-Ebene); genau ein Chip bei explizitem `freigabe`-Override, egal in welche
 * Richtung er vom Ebenen-Default abweicht. Volltext via title-Attribut am Chip.
 * Der `state`-Parameter bleibt zur Signatur-Symmetrie mit chipFuerEbene.
 */
export function chipFuerFreigabe(objekt: { freigabe?: Freigabe; layerId?: string }, state: DesktopState): { icon: string; label: string } | null {
  if (objekt.freigabe === undefined) return null;
  return { icon: FREIGABE_ICON[objekt.freigabe], label: FREIGABE_LABEL[objekt.freigabe] };
}

// ---- 13-06: externe Referenz — permanenter 🌐-Chip (EXT-01) ----

/**
 * Permanente Externe-Referenz-Kennzeichnung am Objekt (13-UI-SPEC Copywriting Contract):
 * kein Chip ohne `extern`-Feld — genau ein Chip sonst, unabhängig von der art (Weblink,
 * Urteil, Norm, E-Mail, Foto, Medien, Textfragment tragen alle denselben Chip). Rein
 * deklarativ (13-02 extern.ts-Kopfkommentar): ändert nie Sichtbarkeit/Freigabe — dieselbe
 * Formsymmetrie wie chipFuerFreigabe (reine Ableitung, keine Mutation). Der fixierte
 * title-Volltext steht am Renderelement (DocCard/NoteCard), nicht hier.
 */
export function chipFuerExtern(objekt: { extern?: ExternRef }): { icon: string; label: string } | null {
  if (objekt.extern === undefined) return null;
  return { icon: '🌐', label: 'Externe Referenz' };
}

/** Baut den Eintrag „Freigabe" (fehlt vollständig ohne Bearbeitungsrecht — Komfort-Gate mit
 *  derselben Guard-Funktion wie „Ebene ändern"; der Server-Guard aus 03-01 bleibt die Grenze)
 *  für ein Objekt an Position x/y — Klick ersetzt `ui.menu` an derselben Stelle durch die
 *  flache Stufenliste, der effektive Wert (effektiveFreigabe, @j-desk/core — derselbe Wert
 *  wie serverseitig, keine Client-Nachrechnung) trägt das „✓ "-Präfix. Die Auswahl dispatcht
 *  den setFreigabe-Command; die Fehlerbehandlung erbt den Bestand aus store.command()
 *  (403 → präzise Server-Meldung nach WR-05, sonst generischer Fehler-Toast). */
export function freigabeEintrag(x: number, y: number, objektId: string, objekt: { freigabe?: Freigabe; layerId?: string }): MenuItem[] {
  const ebene = findeEbene(objekt.layerId ?? 'kanzlei', desktop.state.layers);
  if (!darfEbeneBearbeitenClient(ebene?.typ, desktop.myRolle)) return [];
  return [{
    label: 'Freigabe',
    action: () => {
      const effektiv = effektiveFreigabe(objekt, desktop.state.layers);
      const items = FREIGABE_STUFEN.map(({ stufe, label }) => ({
        label: `${stufe === effektiv ? '✓ ' : ''}${label}`,
        action: () => void desktop.command('setFreigabe', { objectId: objektId, freigabe: stufe }),
      }));
      ui.menu = { x, y, items };
    },
  }];
}

export const NOTE_KIND_LABELS: Record<NoteKind, string> = {
  notiz: 'Notiz',
  frage: 'Frage',
  these: 'These',
  angriffspunkt: 'Angriffspunkt',
  risiko: 'Risiko',
  behauptung: 'Behauptung',
  beweisziel: 'Beweisziel',
  idee: 'Idee',
  todo: 'To-do',
  argument: 'Argument',
  rechtsfrage: 'Rechtsfrage',
  eigen: 'Eigener',
  tafel: 'Tafel-Text',
};

/** Anzeigenamen der 13 juristischen Objekttypen (LEGAL-01) — wortgleich aus REQUIREMENTS.md:77,
 *  gesperrt (08-01-PLAN.md). Reihenfolge entspricht LEGAL_OBJECT_KINDS/der Menü-Reihenfolge. */
export const LEGAL_OBJECT_KIND_LABELS: Record<LegalObjectKind, string> = {
  tatsache: 'Tatsache',
  'eigene-behauptung': 'eigene Behauptung',
  'behauptung-gegenseite': 'Behauptung der Gegenseite',
  beweismittel: 'Beweismittel',
  gegenbeweis: 'Gegenbeweis',
  rechtsfrage: 'Rechtsfrage',
  tatbestandsmerkmal: 'Tatbestandsmerkmal',
  einwendung: 'Einwendung',
  risiko: 'Risiko',
  frist: 'Frist',
  aufgabe: 'Aufgabe',
  'fundstelle-zitierfaehig': 'zitierfähige Fundstelle',
  ergebnis: 'Ergebnis',
};

function papierkorbEintrag(objektId: string): MenuItem {
  return {
    label: 'In den Papierkorb',
    // UX-01-Klärung (13-08): fixierter title aus dem Copywriting Contract (13-UI-SPEC.md) — das
    // Label bleibt unverändert, der title macht die j-lawyer-Regel bereits im Kontextmenü sichtbar.
    title: 'Vom Tisch entfernen — landet im Papierkorb und ist jederzeit wiederherstellbar. In j-lawyer bleibt alles unverändert.',
    action: () => void desktop.command('trashObject', { id: objektId, trashedAt: new Date().toISOString() }),
  };
}

/**
 * VIEW-01 (11-08 Task 2): Hervorhebungs-Umschalter „In Ansicht hervorheben" /
 * „Hervorhebung entfernen" — direkt ausführend (kein Zwei-Klick-Modus, UI-SPEC), Formvorbild
 * papierkorbEintrag(). Die Beschriftung schaltet anhand von ui.highlightedIds um; die Aktion
 * ersetzt die Menge durch eine NEUE Instanz statt sie zu mutieren, damit die Reaktivität der
 * Kartenkomponenten (Ring/📌-Badge) sicher auslöst. Es wird bewusst KEIN Kommando gesendet: die
 * Hervorhebung ist reiner Client-Zustand und kann serverseitig nicht fehlschlagen (E6/error).
 *
 * Steht in den sechs Objektmenüs Dokument, Stapel, Zettel, juristisches Objekt, Tabelle und
 * Zeitleiste. Das Ausschnitt-Menü (showCutoutMenuAt) erhält den Eintrag BEWUSST nicht — die
 * UI-SPEC-Zeilengruppe E6 nennt nur diese sechs Kartenarten; ein Ausschnitt ist eine Fundstelle
 * seines Herkunftsdokuments und wird über dieses mit hervorgehoben (Abgrenzung, kein Versehen).
 */
function ansichtHervorhebenEintrag(objektId: string): MenuItem {
  const aktiv = ui.highlightedIds.has(objektId);
  return {
    label: aktiv ? 'Hervorhebung entfernen' : 'In Ansicht hervorheben',
    action: () => {
      const naechste = new Set(ui.highlightedIds);
      if (aktiv) naechste.delete(objektId);
      else naechste.add(objektId);
      ui.highlightedIds = naechste;
    },
  };
}

/**
 * COMP-01/COMP-03 (09-07, Plan 09-01 hat ui.compareFromId/ui.versionFromId bereits angelegt):
 * beide Einträge stehen ausschließlich in den Dokumentmenüs (showDocMenuAt/showViewerMenuAt) —
 * Vergleich und Fassungsgeschichte sind dokumentbezogen, die übrigen Objekttypen bekommen diese
 * Einträge nicht.
 *
 * Richtung von „Ist neue Version von…" (WICHTIG, leicht zu verdrehen): der Menüeintrag steht auf
 * der NEUEREN Fassung und setzt ui.versionFromId auf DEREN id; der nächste Klick (DocViewer.svelte
 * verbindungAngenommen()) wählt die ÄLTERE Fassung und sendet addVersionLink mit der geklickten
 * Karte als olderId und der hier gemerkten als newerId. Der Pfeil in LinkLayer.svelte zeigt danach
 * von alt nach neu, weil addVersionLink(fromId=olderId, toId=newerId) anlegt.
 */
function vergleichUndVersionEintraege(docId: string): MenuItem[] {
  return [
    { label: 'Vergleichen mit…', action: () => { ui.compareFromId = docId; } },
    { label: 'Ist neue Version von…', action: () => { ui.versionFromId = docId; } },
  ];
}

/**
 * Kontextmenü-Einträge „Zu Anlagenpaket hinzufügen" (Doc/Viewer) und „Anlagenpaket aus Stapel…"
 * (Stack) — KONV-01, 10-03. Beide führen die Aktion sofort aus (Festlegung F-10): kein neuer
 * Zwei-Klick-Auswahlmodus wie `ui.linkingFromId`, weil das Ziel der Dialog selbst ist, kein
 * zweites Tisch-Objekt. Sichtbarkeitsregel identisch zu den bestehenden Export-Pfaden
 * (EXP-03-Kontinuität, T-10-15): ohne effektive Freigabe `export` bietet die Oberfläche den
 * Eintrag gar nicht erst an, statt ihn anzubieten und serverseitig abzulehnen.
 */
function anlagenpaketDocEintrag(doc: Doc): MenuItem[] {
  if (effektiveFreigabe(doc, desktop.state.layers) !== 'export') return [];
  return [{
    label: 'Zu Anlagenpaket hinzufügen',
    action: () => {
      const { auswahl, ergaenzt } = ergaenzeAuswahl(ui.anlagenpaketAuswahl, doc.id, doc.name);
      ui.anlagenpaketAuswahl = auswahl;
      ui.anlagenpaketOffen = true;
      if (!ergaenzt) showToast(`„${doc.name}" ist bereits im Anlagenpaket.`);
    },
  }];
}

/** „Anlagenpaket aus Stapel…" (Stack) — ersetzt die laufende Auswahl durch die Stapelmitglieder
 *  (der Eintrag heißt „aus Stapel", er beginnt eine neue Zusammenstellung), Stapelreihenfolge. */
function anlagenpaketStackEintrag(stack: Stack): MenuItem[] {
  if (effektiveFreigabe(stack, desktop.state.layers) !== 'export') return [];
  return [{
    label: 'Anlagenpaket aus Stapel…',
    action: () => {
      const auswahl = auswahlAusStapel(desktop.state, stack);
      if (auswahl.length === 0) {
        showToast('In diesem Stapel ist kein für den Export freigegebenes Dokument.');
        return;
      }
      ui.anlagenpaketAuswahl = auswahl;
      ui.anlagenpaketOffen = true;
    },
  }];
}

/**
 * Kontextmenü-Eintrag „Zur Sitzungsmappe hinzufügen" / „Aus Sitzungsmappe entfernen" (SESS-02,
 * 11-01/11-05) — derselbe Doppelweg wie die Verfügbar-Liste des Vorbereitungsdialogs: steht das
 * Dokument bereits in der Agenda der aktuellen Sitzungsmappe, schaltet die Beschriftung auf
 * „Aus Sitzungsmappe entfernen" um und der Klick sendet `removeSitzungsmappeDoc`; sonst legt der
 * Klick bei Bedarf über aktuelleSitzungsmappe() eine Sitzungsmappe an und hängt die docId über
 * `addSitzungsmappeDoc` an (idempotent, ein zweiter Klick verlängert die Agenda nicht). Beide
 * Wege — Kontextmenü und Dialog-Liste — schreiben ausschließlich über denselben Kommandopfad
 * in dieselbe docIds-Agenda. Kein Freigabe-Gate wie beim Anlagenpaket — eine Sitzungsmappe ist
 * kein Exportartefakt, sondern geteilter Schreibtisch-Inhalt (Planner-Annahme A2, 11-01-PLAN.md).
 *
 * Bewusst NICHT in den Stapel-, Zettel- und Ausschnitt-Menüs ergänzt: die Agenda führt
 * Dokumente, keine anderen Objektarten — ein Stapel-Eintrag müsste erst auf Mitglieds-Dokumente
 * aufgelöst werden und Zettel/Ausschnitte haben keine docId für die Agenda.
 */
function sitzungsmappeDocEintrag(doc: Doc): MenuItem[] {
  const bestehende = aktuelleSitzungsmappe(desktop.state);
  if (bestehende?.docIds.includes(doc.id)) {
    return [{
      label: 'Aus Sitzungsmappe entfernen',
      action: () => {
        void desktop.command('removeSitzungsmappeDoc', { id: bestehende.id, docId: doc.id });
      },
    }];
  }
  return [{
    label: 'Zur Sitzungsmappe hinzufügen',
    action: () => {
      const bestehende = aktuelleSitzungsmappe(desktop.state);
      const id = bestehende?.id ?? uid();
      if (!bestehende) void desktop.command('addSitzungsmappe', { titel: 'Termin', id });
      void desktop.command('addSitzungsmappeDoc', { id, docId: doc.id });
    },
  }];
}

function befestigungsEintraege(objektId: string): MenuItem[] {
  const items: MenuItem[] = [];
  items.push(
    isTaped(desktop.state, objektId)
      ? { label: 'Band abziehen', action: () => void desktop.command('untapeObject', { id: objektId }) }
      : { label: 'Festkleben', action: () => void desktop.command('tapeObject', { id: objektId }) },
  );
  const clip = clipOf(desktop.state, objektId);
  items.push({ label: 'Anklammern an…', action: () => { ui.clippingFromId = objektId; } });
  if (clip) items.push({ label: 'Klammer entfernen', action: () => void desktop.command('removeClip', { clipId: clip.id }) });
  return items;
}

export async function openDoc(doc: Doc): Promise<void> {
  if (!desktop.api) return;
  // Fenster synchron zur Nutzergeste öffnen, sonst greift der Popup-Blocker.
  const win = window.open('', '_blank');
  try {
    const url = await getFileUrl(desktop.api, doc.fileId, doc.kind === 'image' ? imageMime(doc.name) : undefined);
    if (win) win.location.href = url;
    else window.open(url, '_blank');
  } catch (e) {
    win?.close();
    showToast(e instanceof Error ? e.message : 'Öffnen fehlgeschlagen');
  }
}

export function openWithLinked(entityId: string): void {
  for (const d of collectLinkedDocs(desktop.state, entityId)) void openDoc(d);
}

export async function downloadDoc(doc: Doc): Promise<void> {
  if (!desktop.api) return;
  try {
    const a = document.createElement('a');
    a.href = await getFileUrl(desktop.api, doc.fileId, doc.kind === 'image' ? imageMime(doc.name) : undefined);
    a.download = doc.name;
    a.click();
    showToast(`Heruntergeladen: ${doc.name}`);
  } catch (e) {
    showToast(e instanceof Error ? e.message : 'Herunterladen fehlgeschlagen');
  }
}

export function showDocMenuAt(x: number, y: number, doc: Doc): void {
  const kind = doc.kind ?? 'pdf';
  ui.menu = {
    x, y,
    items: [
      { label: 'Herkunft', action: () => { ui.provenancePopover = { id: doc.id, anchor: { x, y } }; } },
      ...ebeneAendernEintrag(x, y, doc.id, doc.layerId),
      ...freigabeEintrag(x, y, doc.id, doc),
      ...(kind !== 'other'
        ? [{ label: 'Aufschlagen', action: () => void desktop.command('expandDoc', { id: doc.id }) }]
        : []),
      { label: 'In neuem Tab öffnen', action: () => void openDoc(doc) },
      { label: 'Mit allen Verknüpften öffnen', action: () => openWithLinked(doc.id) },
      { label: 'Verknüpfen…', action: () => { ui.linkingFromId = doc.id; } },
      ...anlagenpaketDocEintrag(doc),
      ...sitzungsmappeDocEintrag(doc),
      ...vergleichUndVersionEintraege(doc.id),
      { label: 'Kopieren', action: () => void desktop.command('copyObject', { id: doc.id }) },
      { label: 'Herunterladen…', action: () => void downloadDoc(doc) },
      ansichtHervorhebenEintrag(doc.id),
      ...befestigungsEintraege(doc.id),
      ...berechtigungPruefenEintrag(doc.id),
      papierkorbEintrag(doc.id),
    ],
  };
}

/**
 * Kontextmenüpunkt „Sichtbarkeit prüfen…" (OPS-03, 14-05) — zweiter Einstieg in den
 * BerechtigungsDialog, öffnet ihn mit bereits gewähltem Objekt (ein Feld, zwei Einstiege, kein
 * zweiter Dialogtyp). Bedingt eingefügt (Ausblendemuster PERM-04, identisch zu „Schreddern" in
 * TrashCan): nur für den Eigentümer sichtbar, nie ausgegraut — der Server bleibt die Grenze
 * über requireDeskRolle(['Eigentümer']) auf GET /desks/:id/berechtigung.
 */
function berechtigungPruefenEintrag(objektId: string): MenuItem[] {
  return desktop.currentRolle === 'Eigentümer'
    ? [{ label: 'Sichtbarkeit prüfen…', action: () => { ui.berechtigungDialog = { objektId }; } }]
    : [];
}

export function showDocMenu(e: MouseEvent, doc: Doc): void {
  showDocMenuAt(e.clientX, e.clientY, doc);
}

/** Kontextmenü am AUFGESCHLAGENEN Dokument (Wunsch A3.4): wie das Karten-Menü,
    nur „Zuklappen" statt „Aufschlagen". */
export function showViewerMenuAt(x: number, y: number, doc: Doc): void {
  ui.menu = {
    x, y,
    items: [
      { label: 'Herkunft', action: () => { ui.provenancePopover = { id: doc.id, anchor: { x, y } }; } },
      ...ebeneAendernEintrag(x, y, doc.id, doc.layerId),
      ...freigabeEintrag(x, y, doc.id, doc),
      { label: 'Zuklappen', action: () => void desktop.command('collapseDoc', { id: doc.id }) },
      { label: 'In neuem Tab öffnen', action: () => void openDoc(doc) },
      { label: 'Mit allen Verknüpften öffnen', action: () => openWithLinked(doc.id) },
      { label: 'Verknüpfen…', action: () => { ui.linkingFromId = doc.id; } },
      ...anlagenpaketDocEintrag(doc),
      ...sitzungsmappeDocEintrag(doc),
      ...vergleichUndVersionEintraege(doc.id),
      { label: 'Kopieren', action: () => void desktop.command('copyObject', { id: doc.id }) },
      { label: 'Herunterladen…', action: () => void downloadDoc(doc) },
      ...befestigungsEintraege(doc.id),
      papierkorbEintrag(doc.id),
    ],
  };
}

export function showStackMenuAt(x: number, y: number, stack: Stack): void {
  const basis: MenuItem[] = stack.stapled
    ? [
        { label: 'Aufschlagen', action: () => void desktop.command('expandStack', { id: stack.id }) },
        { label: 'Entheften', action: () => void desktop.command('unstapleStack', { stackId: stack.id }) },
      ]
    : [
        { label: 'Auffächern', action: () => { ui.fannedStackId = ui.fannedStackId === stack.id ? null : stack.id; } },
        { label: 'Heften', action: () => void desktop.command('stapleStack', { stackId: stack.id }) },
        { label: 'Stapel auflösen', action: () => void desktop.command('dissolveStack', { stackId: stack.id }) },
      ];
  ui.menu = {
    x, y,
    items: [
      { label: 'Herkunft', action: () => { ui.provenancePopover = { id: stack.id, anchor: { x, y } }; } },
      ...ebeneAendernEintrag(x, y, stack.id, stack.layerId),
      ...freigabeEintrag(x, y, stack.id, stack),
      ...basis,
      { label: 'Mit allen Verknüpften öffnen', action: () => openWithLinked(stack.id) },
      { label: 'Benennen…', action: () => { ui.editingStackId = stack.id; } },
      { label: 'Verknüpfen…', action: () => { ui.linkingFromId = stack.id; } },
      ...anlagenpaketStackEintrag(stack),
      ansichtHervorhebenEintrag(stack.id),
      ...befestigungsEintraege(stack.id),
      papierkorbEintrag(stack.id),
    ],
  };
}

export function showStackMenu(e: MouseEvent, stack: Stack): void {
  showStackMenuAt(e.clientX, e.clientY, stack);
}

export function showNoteMenuAt(x: number, y: number, note: Note): void {
  ui.menu = {
    x, y,
    items: [
      { label: 'Herkunft', action: () => { ui.provenancePopover = { id: note.id, anchor: { x, y } }; } },
      ...ebeneAendernEintrag(x, y, note.id, note.layerId),
      ...freigabeEintrag(x, y, note.id, note),
      { label: 'Bearbeiten', action: () => { ui.editingNoteId = note.id; } },
      { label: 'Verknüpfen…', action: () => { ui.linkingFromId = note.id; } },
      { label: 'Kopieren', action: () => void desktop.command('copyObject', { id: note.id }) },
      ansichtHervorhebenEintrag(note.id),
      ...befestigungsEintraege(note.id),
      papierkorbEintrag(note.id),
    ],
  };
}

export function showNoteMenu(e: MouseEvent, note: Note): void {
  showNoteMenuAt(e.clientX, e.clientY, note);
}

// ---- Task 3: Aufgaben-Kontextmenüblock (TASK-01) ----

/** Klartext der vier Aufgaben-Statuswerte (08-UI-SPEC.md Copywriting Contract) — hier statt in
 *  LegalObjectCard.svelte definiert und von dort importiert (ein Wortlaut, wie FREIGABE_LABEL). */
export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  offen: 'Offen',
  'in-arbeit': 'In Arbeit',
  erledigt: 'Erledigt',
  uebergeben: 'An j-lawyer übergeben',
};

/** Klartext der drei Aufgaben-Prioritätsstufen (08-UI-SPEC.md Copywriting Contract). */
export const TASK_PRIORITY_LABELS: Record<TaskPriority, string> = {
  hoch: 'Hoch',
  mittel: 'Mittel',
  niedrig: 'Niedrig',
};

/**
 * TT.MM.JJJJ -> ISO-Kalendertag (YYYY-MM-DD); `undefined` bei nicht parsbarer Eingabe (kein
 * Datum im erwarteten Format, oder ein rechnerisch überlaufendes Datum wie 31.02.). Der
 * Rückrechnungs-Vergleich fängt genau den Überlauf ab, den `new Date(2026, 1, 31)` sonst still
 * auf den 3. März korrigieren würde.
 */
export function parseDatumEingabe(eingabe: string): string | undefined {
  const treffer = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(eingabe.trim());
  if (!treffer) return undefined;
  const [, ttStr, mmStr, jjjjStr] = treffer;
  const tag = Number(ttStr);
  const monat = Number(mmStr);
  const jahr = Number(jjjjStr);
  const d = new Date(Date.UTC(jahr, monat - 1, tag));
  if (d.getUTCFullYear() !== jahr || d.getUTCMonth() !== monat - 1 || d.getUTCDate() !== tag) return undefined;
  return `${jjjjStr}-${String(monat).padStart(2, '0')}-${String(tag).padStart(2, '0')}`;
}

/**
 * TASK-02 (08-08): Aufgabe an j-lawyer übergeben — bestätigungspflichtig (wörtlicher Text aus
 * dem Copywriting Contract, 08-UI-SPEC.md), kein optimistischer Statuswechsel. Der Server bleibt
 * die Sicherheitsgrenze (requireDeskAktion 'upload'); das Ausblenden des Menüeintrags (Aufrufer,
 * s. aufgabeEintraege) ist reiner Komfort. Schlägt der Aufruf fehl, erscheint die Server-Meldung
 * als Toast — bei 403 hat sie Vorrang vor jedem Client-Wortlaut, exakt wie im Bestand
 * (store.svelte.ts command()). Der Status kommt NICHT aus dem Rückgabewert dieser Funktion,
 * sondern über den WebSocket-Broadcast des serverseitig angewendeten Commands zurück — nach dem
 * Routenaufruf folgt hier bewusst KEIN eigener desktop.command()/setTaskStatus-Aufruf.
 */
async function uebergebeAufgabe(obj: LegalObject): Promise<void> {
  const api = desktop.api;
  const deskId = desktop.deskId;
  if (!api || !deskId) return;
  const grundtext = 'Aufgabe an j-lawyer übergeben? Verantwortliche/r, Fälligkeit und Bezug zu Dokument/Fundstelle werden dorthin übertragen.';
  // Bereits übergeben: ein vorangestellter Hinweis, damit eine zweite Wiedervorlage nicht
  // versehentlich entsteht (T-08-40) — kein Rot, kein Destructive-Ton (kein Datenverlust).
  const text = obj.handedOverToJLawyer
    ? `Diese Aufgabe wurde bereits an j-lawyer übergeben. ${grundtext}`
    : grundtext;
  if (!confirm(text)) return;
  try {
    await api.uebergebeAufgabe(deskId, obj.id);
  } catch (e) {
    showToast(e instanceof Error ? e.message : 'Übergabe an j-lawyer fehlgeschlagen.');
  }
}

/**
 * Aufgaben-Kontextmenüblock (TASK-01) — nur bei kind 'aufgabe' eingehängt (Task 3, 08-UI-SPEC.md).
 * Status/Priorität folgen dem Zweischritt-Menümuster aus ebeneAendernEintrag()/freigabeEintrag()
 * (ui.menu wird an derselben Stelle synchron ersetzt); Verantwortliche/r…/Fällig am… folgen dem
 * ui.menu.input-Muster aus Desktop.svelte zettelTypAuswahl() ("Eigener…", queueMicrotask nötig,
 * weil ContextMenu.svelte ui.menu nach jedem Klick synchron auf null setzt).
 */
function aufgabeEintraege(x: number, y: number, obj: LegalObject): MenuItem[] {
  if (obj.kind !== 'aufgabe') return [];
  const items: MenuItem[] = [
    {
      label: 'Status',
      action: () => {
        const items = TASK_STATUSES.map((s) => ({
          label: `${s === obj.status ? '✓ ' : ''}${TASK_STATUS_LABELS[s]}`,
          action: () => void desktop.command('setTaskStatus', { id: obj.id, status: s }),
        }));
        ui.menu = { x, y, items };
      },
    },
    {
      label: 'Priorität',
      action: () => {
        const items = TASK_PRIORITIES.map((p) => ({
          label: `${p === obj.priority ? '✓ ' : ''}${TASK_PRIORITY_LABELS[p]}`,
          action: () => void desktop.command('setTaskPriority', { id: obj.id, priority: p }),
        }));
        ui.menu = { x, y, items };
      },
    },
    {
      label: 'Verantwortliche/r…',
      action: () => queueMicrotask(() => {
        ui.menu = {
          x, y, items: [],
          input: {
            placeholder: 'Name',
            onSubmit: (t) => void desktop.command('setTaskAssignee', { id: obj.id, assignee: t }),
          },
        };
      }),
    },
    {
      label: 'Fällig am…',
      action: () => queueMicrotask(() => {
        ui.menu = {
          x, y, items: [],
          input: {
            placeholder: 'TT.MM.JJJJ',
            onSubmit: (t) => {
              const iso = parseDatumEingabe(t);
              if (iso === undefined) {
                showToast('Datum nicht erkannt — bitte im Format TT.MM.JJJJ eingeben.');
                return;
              }
              void desktop.command('setTaskDueDate', { id: obj.id, dueDate: iso });
            },
          },
        };
      }),
    },
    { label: 'Bezug zu Dokument…', action: () => { ui.taskRefFromId = obj.id; } },
  ];
  if (obj.docRef) {
    const docRef = obj.docRef;
    items.push(
      { label: 'Zum Bezug springen', action: () => void desktop.jumpTo(fundstelleAusTaskDocRef(desktop.state, docRef)) },
      { label: 'Bezug entfernen', action: () => void desktop.command('removeTaskDocRef', { id: obj.id }) },
    );
  }
  // TASK-02 (08-08): entfällt VOLLSTÄNDIG (nicht ausgegraut) außerhalb des j-lawyer-Modus oder
  // ohne das Recht für gefährliche Aktionen — dasselbe Muster wie ebeneAendernEintrag/
  // freigabeEintrag oben. Der Server bleibt die Sicherheitsgrenze (requireDeskAktion 'upload').
  if (desktop.mode === 'jlawyer' && darfAktionClient(desktop.currentRolle, 'upload')) {
    items.push({ label: 'An j-lawyer übergeben', action: () => void uebergebeAufgabe(obj) });
  }
  return items;
}

/** Kontextmenü der juristischen Objekttyp-Karte (LEGAL-01, 08-01) — nach dem exakten Vorbild
 *  von showNoteMenuAt: Ebenen-/Freigabe-/Papierkorb-Verhalten identisch zu Zetteln. Der
 *  Aufgabenblock (Task 3) hängt zwischen „Bearbeiten" und „Verknüpfen…" ein — nur bei kind
 *  'aufgabe' nicht leer. */
export function showLegalObjectMenuAt(x: number, y: number, obj: LegalObject): void {
  ui.menu = {
    x, y,
    items: [
      { label: 'Herkunft', action: () => { ui.provenancePopover = { id: obj.id, anchor: { x, y } }; } },
      ...ebeneAendernEintrag(x, y, obj.id, obj.layerId),
      ...freigabeEintrag(x, y, obj.id, obj),
      { label: 'Bearbeiten', action: () => { ui.editingLegalObjectId = obj.id; } },
      ...aufgabeEintraege(x, y, obj),
      { label: 'Verknüpfen…', action: () => { ui.linkingFromId = obj.id; } },
      { label: 'Kopieren', action: () => void desktop.command('copyObject', { id: obj.id }) },
      ansichtHervorhebenEintrag(obj.id),
      ...befestigungsEintraege(obj.id),
      papierkorbEintrag(obj.id),
    ],
  };
}

export function showLegalObjectMenu(e: MouseEvent, obj: LegalObject): void {
  showLegalObjectMenuAt(e.clientX, e.clientY, obj);
}

// ---- Task 1/2 (08-07): Kontextmenü und Formelspalten-Anlage der Tabellenkarte (CALC-01) ----

/** Anzeigenamen der vier Formelarten (CALC-01, 08-UI-SPEC.md Copywriting Contract) — Menü,
 *  ƒ-Badge-title und Spaltenkopf verwenden denselben Wortlaut, damit sie nie auseinanderlaufen. */
export const FORMEL_ART_LABELS: Record<FormelArt, string> = {
  summe: 'Summe',
  datumsdifferenz: 'Datumsdifferenz',
  zinsen: 'Zinsen',
  'wiederkehrende-zahlung': 'Wiederkehrende Zahlung',
};

/**
 * Dritter Schritt (nur Zinsen/Wiederkehrende Zahlung): fragt die noch fehlenden Formelparameter
 * über das bestehende ui.menu.input-Muster ab, dann dispatcht addTableFormulaColumn. Zinsen
 * braucht Zinssatz UND Tage (simpleInterestCents-Signatur, tableFormulas.ts), Wiederkehrende
 * Zahlung nur die Anzahl — ohne diese Parameter bliebe berechneFormelSpalte() dauerhaft
 * undefined (Strich statt Ergebnis), obwohl die Spalte augenscheinlich angelegt wäre (Rule 2 —
 * 08-07-PLAN.md nennt für die Zinsformel nur den Zinssatz-Schritt explizit, die Formel selbst
 * verlangt aber zwingend beide Parameter).
 */
function formelParameterAbfragen(x: number, y: number, tableId: string, formel: FormelArt, quelleSpalteId: string, titel: string): void {
  const dispatchen = (parameter?: Record<string, number>) => {
    void desktop.command('addTableFormulaColumn', {
      tableId, titel, formel, quelleSpalteId, id: uid(), ...(parameter ? { parameter } : {}),
    });
  };
  if (formel === 'zinsen') {
    queueMicrotask(() => {
      ui.menu = {
        x, y, items: [],
        input: {
          placeholder: 'Zinssatz in % (z. B. 5)',
          onSubmit: (satzText) => {
            const zinssatzProzent = Number(satzText.replace(',', '.'));
            if (!Number.isFinite(zinssatzProzent)) { showToast('Zinssatz nicht erkannt — bitte eine Zahl eingeben.'); return; }
            queueMicrotask(() => {
              ui.menu = {
                x, y, items: [],
                input: {
                  placeholder: 'Zinstage (z. B. 90)',
                  onSubmit: (tageText) => {
                    const tage = Number(tageText.replace(',', '.'));
                    if (!Number.isFinite(tage)) { showToast('Anzahl Tage nicht erkannt — bitte eine Zahl eingeben.'); return; }
                    dispatchen({ zinssatzProzent, tage });
                  },
                },
              };
            });
          },
        },
      };
    });
    return;
  }
  if (formel === 'wiederkehrende-zahlung') {
    queueMicrotask(() => {
      ui.menu = {
        x, y, items: [],
        input: {
          placeholder: 'Anzahl Zahlungen (z. B. 12)',
          onSubmit: (anzahlText) => {
            const anzahl = Number(anzahlText);
            if (!Number.isInteger(anzahl) || anzahl < 0) { showToast('Anzahl nicht erkannt — bitte eine ganze Zahl eingeben.'); return; }
            dispatchen({ anzahl });
          },
        },
      };
    });
    return;
  }
  dispatchen(undefined);
}

/**
 * Zweiter Schritt des „+ Formel"-Menüs: Quellspalte auswählen. Nur addTableFormulaColumn() aus
 * 08-06 existierte bisher — ohne eine Rohwert-Spalte gäbe es aber nie eine Quellspalte, die eine
 * Formel referenzieren könnte (08-06-SUMMARY.md „Next Phase Readiness"). „Neue Spalte…" legt sie
 * bei Bedarf über addTableColumn() (08-07-Deviation) an; die Spaltenart wird aus der Formelart
 * abgeleitet (datumsdifferenz -> datum, sonst zahl), ein weiterer Auswahlschritt ist nicht nötig,
 * weil jede der vier Formeln nur EINE Quellspalte referenziert.
 */
function quelleSpalteMenu(x: number, y: number, t: TableCard, formel: FormelArt): void {
  const titel = FORMEL_ART_LABELS[formel];
  const rohSpalten = t.spalten.filter((sp) => sp.art !== 'formel');
  ui.menu = {
    x, y,
    items: [
      ...rohSpalten.map((sp) => ({
        label: sp.titel,
        action: () => formelParameterAbfragen(x, y, t.id, formel, sp.id, titel),
      })),
      {
        label: 'Neue Spalte…',
        action: () => queueMicrotask(() => {
          ui.menu = {
            x, y, items: [],
            input: {
              placeholder: 'Spaltentitel (z. B. Betrag)',
              onSubmit: (spaltenTitel) => {
                const spaltenId = uid();
                const art = formel === 'datumsdifferenz' ? 'datum' : 'zahl';
                void desktop.command('addTableColumn', { tableId: t.id, titel: spaltenTitel, art, id: spaltenId })
                  .then(() => formelParameterAbfragen(x, y, t.id, formel, spaltenId, titel));
              },
            },
          };
        }),
      },
    ],
  };
}

/** Öffnet den „+ Formel"-Ablauf (Task 2, CALC-01): erster Schritt — Formelart wählen. */
export function formelMenuOeffnen(x: number, y: number, t: TableCard): void {
  ui.menu = {
    x, y,
    items: FORMEL_ARTEN.map((formel) => ({
      label: FORMEL_ART_LABELS[formel],
      action: () => quelleSpalteMenu(x, y, t, formel),
    })),
  };
}

/** Kontextmenü der Tabellenkarte — nach dem exakten Vorbild von showDocMenuAt/showViewerMenuAt:
 *  Herkunft, Ebenen-/Freigabe-Verwaltung, Aufschlagen/Zuklappen je nach Zustand, Benennen…
 *  (ui.menu.input-Muster wie „Eigener…"), Verknüpfen…, Befestigungseinträge, Papierkorb. */
export function showTableMenuAt(x: number, y: number, t: TableCard): void {
  ui.menu = {
    x, y,
    items: [
      { label: 'Herkunft', action: () => { ui.provenancePopover = { id: t.id, anchor: { x, y } }; } },
      ...ebeneAendernEintrag(x, y, t.id, t.layerId),
      ...freigabeEintrag(x, y, t.id, t),
      t.open
        ? { label: 'Zuklappen', action: () => void desktop.command('collapseTable', { id: t.id }) }
        : { label: 'Aufschlagen', action: () => void desktop.command('expandTable', { id: t.id }) },
      {
        label: 'Benennen…',
        action: () => queueMicrotask(() => {
          ui.menu = {
            x, y, items: [],
            input: { placeholder: 'Titel der Tabelle', onSubmit: (titel) => void desktop.command('renameTable', { id: t.id, titel }) },
          };
        }),
      },
      { label: 'Verknüpfen…', action: () => { ui.linkingFromId = t.id; } },
      ansichtHervorhebenEintrag(t.id),
      ...befestigungsEintraege(t.id),
      papierkorbEintrag(t.id),
    ],
  };
}

export function showTableMenu(e: MouseEvent, t: TableCard): void {
  showTableMenuAt(e.clientX, e.clientY, t);
}

/** Kontextmenü der Zeitleistenkarte (CHRONO-01, 09-01) — nach dem exakten Vorbild von
 *  showTableMenuAt, ohne „Benennen…": der Titel ist fest 'Zeitleiste' (kein Umbenennen in
 *  dieser Ausbaustufe, 09-01-PLAN.md). */
export function showZeitleisteMenuAt(x: number, y: number, z: ZeitleisteCard): void {
  ui.menu = {
    x, y,
    items: [
      { label: 'Herkunft', action: () => { ui.provenancePopover = { id: z.id, anchor: { x, y } }; } },
      ...ebeneAendernEintrag(x, y, z.id, z.layerId),
      ...freigabeEintrag(x, y, z.id, z),
      z.open
        ? { label: 'Zuklappen', action: () => void desktop.command('collapseZeitleiste', { id: z.id }) }
        : { label: 'Aufschlagen', action: () => void desktop.command('expandZeitleiste', { id: z.id }) },
      { label: 'Verknüpfen…', action: () => { ui.linkingFromId = z.id; } },
      ansichtHervorhebenEintrag(z.id),
      ...befestigungsEintraege(z.id),
      papierkorbEintrag(z.id),
    ],
  };
}

export function showZeitleisteMenu(e: MouseEvent, z: ZeitleisteCard): void {
  showZeitleisteMenuAt(e.clientX, e.clientY, z);
}

export function showCutoutMenuAt(x: number, y: number, cutout: Cutout): void {
  ui.menu = {
    x, y,
    items: [
      { label: 'Zur Originalstelle', action: () => void desktop.jumpTo(fundstelleAusCutout(cutout)) },
      { label: 'Herkunft', action: () => { ui.provenancePopover = { id: cutout.id, anchor: { x, y } }; } },
      ...ebeneAendernEintrag(x, y, cutout.id, cutout.layerId),
      ...freigabeEintrag(x, y, cutout.id, cutout),
      { label: 'Verknüpfen…', action: () => { ui.linkingFromId = cutout.id; } },
      { label: 'Kopieren', action: () => void desktop.command('copyObject', { id: cutout.id }) },
      ...befestigungsEintraege(cutout.id),
      papierkorbEintrag(cutout.id),
    ],
  };
}

export function showCutoutMenu(e: MouseEvent, cutout: Cutout): void {
  showCutoutMenuAt(e.clientX, e.clientY, cutout);
}

/** Markierungen/Schwärzungen haben keine Position auf dem Tisch (Festkleben/Anklammern/Papierkorb
    passen fachlich nicht) — Entfernen läuft über den eigenen removeMark-Command. */
export function showMarkMenuAt(x: number, y: number, mark: Mark): void {
  ui.menu = {
    x, y,
    items: [
      { label: 'Zur Originalstelle', action: () => void desktop.jumpTo(fundstelleAusMark(mark)) },
      { label: 'Herkunft', action: () => { ui.provenancePopover = { id: mark.id, anchor: { x, y } }; } },
      ...ebeneAendernEintrag(x, y, mark.id, mark.layerId),
      ...freigabeEintrag(x, y, mark.id, mark),
      { label: 'Entfernen', action: () => void desktop.command('removeMark', { markId: mark.id }) },
    ],
  };
}

export function showMarkMenu(e: MouseEvent, mark: Mark): void {
  showMarkMenuAt(e.clientX, e.clientY, mark);
}

/** Stempel haben ebenfalls keine eigene Tisch-Position — analog zu showMarkMenuAt. */
export function showStampMenuAt(x: number, y: number, stamp: Stamp): void {
  ui.menu = {
    x, y,
    items: [
      { label: 'Zur Originalstelle', action: () => void desktop.jumpTo(fundstelleAusStamp(stamp)) },
      { label: 'Herkunft', action: () => { ui.provenancePopover = { id: stamp.id, anchor: { x, y } }; } },
      ...ebeneAendernEintrag(x, y, stamp.id, stamp.layerId),
      ...freigabeEintrag(x, y, stamp.id, stamp),
      { label: 'Entfernen', action: () => void desktop.command('removeStamp', { stampId: stamp.id }) },
    ],
  };
}

export function showStampMenu(e: MouseEvent, stamp: Stamp): void {
  showStampMenuAt(e.clientX, e.clientY, stamp);
}

/** Fahnen haben ebenfalls keine eigene Tisch-Position — analog zu showMarkMenuAt. */
export function showFlagMenuAt(x: number, y: number, flag: Flag): void {
  ui.menu = {
    x, y,
    items: [
      { label: 'Zur Originalstelle', action: () => void desktop.jumpTo(fundstelleAusFlag(flag)) },
      { label: 'Herkunft', action: () => { ui.provenancePopover = { id: flag.id, anchor: { x, y } }; } },
      ...ebeneAendernEintrag(x, y, flag.id, flag.layerId),
      ...freigabeEintrag(x, y, flag.id, flag),
      { label: 'Entfernen', action: () => void desktop.command('removeFlag', { flagId: flag.id }) },
    ],
  };
}

export function showFlagMenu(e: MouseEvent, flag: Flag): void {
  showFlagMenuAt(e.clientX, e.clientY, flag);
}
