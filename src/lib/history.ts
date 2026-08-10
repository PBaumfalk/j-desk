import type { DesktopState, JournalEintragDto, MarkKind } from '@j-desk/core';
import { STEMPEL_SPRUNG_RECT, fundstelleAusCutout, type Fundstelle } from './jump';
import { istEchteSchwaerzung } from './markSchwaerzung';
import { zeitpunktLang } from './zeitformat';

/** Zitatlänge in der Historie — der volle Snapshot steht am Objekt (TEXT_SNAPSHOT_MAX = 2000). */
const ZITAT_MAX = 160;

export interface HistorienEintrag {
  id: number;
  akteur: string;
  zeit: number;
  text: string;
  /** Ursprünglicher Text der Fundstelle, gekürzt — erstmals sichtbar gemachte Provenienz. */
  zitat?: string;
  /** Fehlt, wenn der Vorgang keine Stelle im Dokument hat oder die Quelle fort ist. */
  ziel?: Fundstelle;
  /** Kennzeichnung genehmigungspflichtiger Vorgänge (D-04): die Oberfläche rendert das Icon
      inline vor dem Klartext und den Titel als `title`-Attribut. Nur stateRestored/exported
      setzen dieses Feld — der Normalfall bleibt schmucklos. */
  badge?: { icon: string; titel: string };
}

/** Anzeigenamen der Übergabeformate (04-UI-SPEC.md Copywriting Contract). Die ersten sechs sind
    wörtlich aus `UebergabeDialog.svelte`s FORMATE-Liste übernommen; `jdesk` deckt den separaten
    Arbeitsstand-Download ab. */
export const EXPORT_FORMAT_TITEL: Record<string, string> = {
  dokument: 'Annotierte PDF-Kopie',
  fundstellen: 'Fundstellen-PDF',
  snapshot: 'Schreibtisch-Snapshot',
  argumentation: 'Argumentationsübersicht',
  beweismittel: 'Beweismittelübersicht',
  aufgaben: 'Aufgabenliste',
  jdesk: 'Arbeitsstand (.jdesk)',
};

/** Systemereignisse tragen serverseitig ein gekürztes state-Feld und sind keine Nutzeraktion. */
const SYSTEM_TYPEN = new Set(['snapshot', 'stateReplaced', 'caseSync']);

/** Klartext je Command-Typ ohne Sprungziel. Unbekannte Typen fallen auf 'Änderung' zurück.
    Exportiert: das Konflikt-Overlay (Task 6) beschreibt damit auch den eigenen, noch nicht
    im Journal stehenden Command — keine zweite Übersetzungstabelle dafür. */
export const TEXTE: Record<string, string> = {
  addDoc: 'Dokument auf den Tisch gelegt',
  moveDoc: 'Dokument verschoben',
  bringToFront: 'Dokument nach vorn geholt',
  removeDoc: 'Dokument vom Tisch genommen',
  setDocLandscape: 'Karte gedreht',
  addLink: 'Verknüpfung gezogen',
  setLinkNote: 'Verknüpfung beschriftet',
  removeLink: 'Verknüpfung gelöst',
  stackDocs: 'Dokumente gestapelt',
  removeFromStack: 'aus dem Stapel genommen',
  dissolveStack: 'Stapel aufgelöst',
  renameStack: 'Stapel umbenannt',
  moveStack: 'Stapel verschoben',
  removeStack: 'Stapel entfernt',
  expandDoc: 'Dokument aufgeschlagen',
  collapseDoc: 'Dokument zugeklappt',
  setDocPage: 'Seite gewechselt',
  resizeDoc: 'Ansicht vergrößert',
  extractPage: 'Seite herausgelöst',
  addStroke: 'gezeichnet',
  removeStroke: 'Strich entfernt',
  addNote: 'Zettel geschrieben',
  setNoteDone: 'Zettel abgehakt',
  editNote: 'Zettel bearbeitet',
  moveNote: 'Zettel verschoben',
  removeNote: 'Zettel entfernt',
  moveCutout: 'Ausschnitt verschoben',
  removeCutout: 'Ausschnitt entfernt',
  removeMark: 'Abdeckung entfernt',
  addStamp: 'Stempel gesetzt',
  removeStamp: 'Stempel entfernt',
  addFlag: 'Fahne gesetzt',
  removeFlag: 'Fahne entfernt',
  addClip: 'zusammengeklammert',
  removeClip: 'Klammer gelöst',
  tapeObject: 'festgeklebt',
  untapeObject: 'Klebeband gelöst',
  stapleStack: 'Stapel geheftet',
  unstapleStack: 'Heftung gelöst',
  expandStack: 'Konvolut aufgeschlagen',
  collapseStack: 'Konvolut zugeklappt',
  setStackPage: 'Konvolut-Seite gewechselt',
  resizeStack: 'Konvolut-Ansicht vergrößert',
  trashObject: 'in den Papierkorb gelegt',
  restoreObject: 'aus dem Papierkorb geholt',
  shredTrashItem: 'endgültig geschreddert',
  emptyTrash: 'Papierkorb geleert',
  copyObject: 'Kopie angelegt',
  setBackground: 'Tisch umgestaltet',
  snapshot: 'Stand gesichert',
  stateReplaced: 'Stand ersetzt',
  caseSync: 'Akte abgeglichen',
};

function alsObjekt(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

function alsText(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function alsZahl(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Wie alsObjekt/alsText/alsZahl, aber für ein Rechteck: nur bei vier endlichen Zahlen ein
    valides Box-Objekt, sonst undefined — statt eines bloßen typeof-Objekt-Checks, der
    undefined/NaN durchließe und den Highlight-Puls auf NaN-Koordinaten rendern würde. */
function alsBox(v: unknown): Fundstelle['rect'] | undefined {
  const o = alsObjekt(v);
  const x = alsZahl(o.x);
  const y = alsZahl(o.y);
  const w = alsZahl(o.w);
  const h = alsZahl(o.h);
  return x !== undefined && y !== undefined && w !== undefined && h !== undefined ? { x, y, w, h } : undefined;
}

/**
 * Löst den aktuellen Dokumentnamen auf — zuerst auf dem Tisch, sonst im Papierkorb (Befund
 * E2E-Runde: eine Karte, die NUR getrasht (nicht endgültig weg) ist, blieb sonst ohne Namen und
 * damit ohne `ziel` liegen — der Eintrag wurde stumm unanklickbar statt über springen()/
 * planeSprung() den Papierkorb-Hinweis zu zeigen. Erst wenn der Name auch im Papierkorb nicht
 * mehr auffindbar ist (endgültig gelöscht/geschreddert), bleibt es beim erklärenden Text ohne Ziel.
 */
function docName(state: DesktopState, docId: string | undefined): string | undefined {
  if (docId === undefined) return undefined;
  const aktuell = state.docs.find((d) => d.id === docId)?.name;
  if (aktuell) return aktuell;
  for (const eintrag of state.trash ?? []) {
    const imKorb = eintrag.payload.docs.find((d) => d.id === docId);
    if (imKorb) return imKorb.name;
  }
  return undefined;
}

/**
 * Übersetzt einen Journal-Eintrag in Klartext und — wo es eine Stelle im Dokument gibt —
 * ein Sprungziel. Reine Funktion: kein DOM, kein Netz, damit vollständig testbar.
 *
 * Dokumentnamen werden gegen den AKTUELLEN Stand aufgelöst (Spec-Entscheidung): Alt-Einträge
 * werden dadurch rückwirkend lesbar, zeigen aber den heutigen Namen, nicht den von damals.
 */
export function beschreibe(eintrag: JournalEintragDto, state: DesktopState): HistorienEintrag {
  const basis = { id: eintrag.id, akteur: eintrag.actorName, zeit: eintrag.at };
  const p = alsObjekt(eintrag.payload);

  // --- Genehmigungspflichtige Vorgänge (D-04): dynamischer Text, deshalb VOR SYSTEM_TYPEN/TEXTE —
  // beide Tabellen liefern nur statische Wortlaute und würden den dynamischen Anteil verschlucken.
  // Weder Zitat noch Sprungziel (P-09): stateRestored/exported lesen ausschließlich targetAt bzw.
  // format aus dem Payload, nie Quelltext oder sonstige Fremdinhalte.

  if (eintrag.type === 'stateRestored') {
    const targetAt = alsZahl(p.targetAt);
    return {
      ...basis,
      text:
        targetAt !== undefined
          ? `Stand vom ${zeitpunktLang(targetAt)} wiederhergestellt`
          : 'Stand von einem früheren Zeitpunkt wiederhergestellt',
      badge: { icon: '↺', titel: `Wiederhergestellt von ${eintrag.actorName}` },
    };
  }

  if (eintrag.type === 'exported') {
    const format = alsText(p.format);
    const anzeige = format !== undefined ? (EXPORT_FORMAT_TITEL[format] ?? format) : 'Übergabe';
    return {
      ...basis,
      text: `Übergabe erzeugt — ${anzeige}`,
      badge: { icon: '📤', titel: `Übergabe erzeugt von ${eintrag.actorName}` },
    };
  }

  // --- KI-Vertrauensschicht (AI-02, Phase 12): beide Vorgänge sind eigene, unveränderliche
  // Zeilen — die Historie erzählt die Sequenz Genehmigung → Rücknahme, nichts wird nachträglich
  // umgeschrieben (AI-SPEC Dimension 4/5). Der 🤖-Badge steht wie bei stateRestored/exported
  // strukturell VOR dem Klartext; die Doppelstempelung (KI-Akteur + Genehmiger) trägt der
  // Badge-title, der Zeilentext nennt die Akteure nicht doppelt (12-UI-SPEC Copywriting Contract,
  // löst die 04-UI-SPEC-Reservierung ein).

  if (eintrag.type === 'vorschlagGenehmigt') {
    // CR-02: das Marker-Payload ist inhaltsfrei (kein Register-zusammenfassung-Schnipsel
    // mehr — Vertraulichkeits-Bugklasse); der Zeilentext wird ausschließlich aus der art
    // generiert (byte-genau generisch über TEXTE, mandat_fremd-Muster), niemals aus
    // Register-Inhalten. Alt-Marker (mit zusammenfassung) werden bewusst NICHT mehr
    // ausgespielt: der Schnipsel kann Privatinhalt tragen.
    const art = alsText(p.art);
    return {
      ...basis,
      text: `KI-Vorschlag übernommen — ${(art !== undefined ? TEXTE[art] : undefined) ?? 'Änderung'}`,
      badge: {
        icon: '🤖',
        titel: `KI-Vorschlag von ${alsText(p.kiAkteur) ?? 'unbekannt'}, übernommen von ${eintrag.actorName}`,
      },
    };
  }

  if (eintrag.type === 'vorschlagZurueckgenommen') {
    // Bewusst KEIN eigenes Glyphen (12-UI-SPEC Design System): der 🤖-Badge mit erklärendem
    // Zeilentext ist die Entscheidung; der title benennt die Rücknahme als journalierten Vorgang.
    // CR-02: Text aus der art (s. vorschlagGenehmigt oben), kein zusammenfassung-Schnipsel.
    const art = alsText(p.art);
    return {
      ...basis,
      text: `${eintrag.actorName} nahm die KI-Übernahme zurück: ${(art !== undefined ? TEXTE[art] : undefined) ?? 'Änderung'}`,
      badge: { icon: '🤖', titel: 'Rücknahme einer KI-Aktion — journalierter Vorgang' },
    };
  }

  if (SYSTEM_TYPEN.has(eintrag.type)) {
    return { ...basis, text: TEXTE[eintrag.type] ?? 'Systemereignis' };
  }

  // --- Vorgänge mit Stelle im Dokument ---

  if (eintrag.type === 'addMark') {
    const m = alsObjekt(p.mark);
    const docId = alsText(m.docId);
    const page = alsZahl(m.page) ?? 1;
    const name = docName(state, docId);
    const was = m.kind === 'redact' ? 'geschwärzt' : 'abgedeckt';
    const rect = alsBox(m.rect);
    // CR-03: redact UND tippex decken echt ab (istEchteSchwaerzung) — der ursprüngliche
    // Text darf für keine der beiden Arten in der Historie auftauchen, sonst unterläuft
    // die Journal-Ansicht dieselbe Vertraulichkeitsgarantie, die CR-02 im ProvenancePopover
    // bereits schließen musste.
    const geschwaerzt = istEchteSchwaerzung(m.kind as MarkKind);
    return {
      ...basis,
      text: name ? `${was} — ${name}, S. ${page}` : `${was} — entferntes Dokument`,
      ...(!geschwaerzt && alsText(m.textSnapshot) ? { zitat: String(m.textSnapshot).slice(0, ZITAT_MAX) } : {}),
      ...(name && docId ? { ziel: { docId, page, ...(rect ? { rect } : {}) } } : {}),
    };
  }

  if (eintrag.type === 'addStamp') {
    const st = alsObjekt(p.stamp);
    const docId = alsText(st.docId);
    const page = alsZahl(st.page) ?? 1;
    const name = docName(state, docId);
    const beschriftung = alsText(st.text) ?? 'Stempel';
    const x = alsZahl(st.x);
    const y = alsZahl(st.y);
    return {
      ...basis,
      text: name ? `gestempelt „${beschriftung}" — ${name}, S. ${page}` : `gestempelt „${beschriftung}" — entferntes Dokument`,
      ...(name && docId
        ? { ziel: { docId, page, ...(x !== undefined && y !== undefined ? { rect: STEMPEL_SPRUNG_RECT(x, y) } : {}) } }
        : {}),
    };
  }

  if (eintrag.type === 'addFlag') {
    const f = alsObjekt(p.flag);
    const docId = alsText(f.docId);
    const page = alsZahl(f.page) ?? 1;
    const name = docName(state, docId);
    return {
      ...basis,
      text: name ? `Fahne gesetzt — ${name}, S. ${page}` : 'Fahne gesetzt — entferntes Dokument',
      ...(name && docId ? { ziel: { docId, page } } : {}),
    };
  }

  if (eintrag.type === 'addCutout') {
    const page = alsZahl(p.page) ?? 1;
    const cutoutId = alsText(p.id);
    // Bevorzugt der fileId-Anker des tatsächlichen Ausschnitts: nur er überlebt das
    // Entfernen der Karte und erlaubt das Neuanlegen der Quelle.
    const cutout = cutoutId ? (state.cutouts ?? []).find((c) => c.id === cutoutId) : undefined;
    const name = docName(state, alsText(p.docId));
    if (cutout) {
      return {
        ...basis,
        text: name ? `ausgeschnitten — ${name}, S. ${page}` : `ausgeschnitten — S. ${page}`,
        ...(cutout.textSnapshot ? { zitat: cutout.textSnapshot.slice(0, ZITAT_MAX) } : {}),
        ziel: fundstelleAusCutout(cutout),
      };
    }
    return { ...basis, text: name ? `ausgeschnitten — ${name}, S. ${page}` : 'ausgeschnitten — entferntes Dokument' };
  }

  // --- Vorgänge ohne Stelle im Dokument ---

  return { ...basis, text: TEXTE[eintrag.type] ?? 'Änderung' };
}
