import { provenienz, type DesktopState, type CommandMeta } from './model';
import { flagsFor, type Flag } from './flags';
import { uid } from './uid';

/**
 * Sitzungsmappe (SESS-01/SESS-02, 11-01): vorbereitete Termin-Agenda aus Dokumenten, daraus
 * abgeleiteten Sprungmarken und offenen Fragen — ein eigenständiges, registriertes Objekt mit
 * Konflikterkennung und Ebenenzuordnung wie jede andere Karte (VERSIONIERTE_ARTEN, stempel.ts).
 *
 * Bewusst OHNE `position`/`zIndex`, anders als TableCard/ZeitleisteCard: eine Sitzungsmappe ist
 * kein Objekt auf der Tischfläche, sie erscheint nie als Karte und darf deshalb auch nie in
 * `maxZ()`-Aggregationen anderer Kartenarten auftauchen.
 *
 * Sprungmarken (`sprungmarkenFuerSitzungsmappe`) sind eine reine, nie gespeicherte Ableitung aus
 * den Fahnen der Agenda-Dokumente — dieselbe Lesart wie `berechneFormelSpalte()` in tables.ts:
 * es gibt keinen Setter und kein Feld dafür.
 */

export interface OffeneFrage {
  id: string;
  text: string;
  beantwortet: boolean;
}

export interface Sitzungsmappe {
  id: string;
  titel: string;
  docIds: string[];
  offeneFragen: OffeneFrage[];
  createdBy?: string;    // Provenienz: wer hat die Sitzungsmappe erzeugt; fehlt in Alt-States
  createdById?: string;  // Provenienz: stabile users.id des Erzeugers (WR-05); fehlt in Alt-States
  createdAt?: string;    // Provenienz: wann, ISO-Zeitpunkt; fehlt in Alt-States
  updatedRev?: number;   // Konflikterkennung: Schreibtisch-rev der letzten Änderung; fehlt in Alt-States
  updatedAt?: string;    // Provenienz: wann zuletzt geändert, ISO-Zeitpunkt; fehlt in Alt-States
  updatedBy?: string;    // Provenienz: wer zuletzt geändert hat; fehlt in Alt-States
  layerId?: string;      // Sichtbarkeits-/Bearbeitungsebene; fehlt in Alt-States (implizit "Kanzlei")
  freigabe?: import('./freigabe').Freigabe; // Freigabe-Override (EXP-03); fehlt in Alt-States (implizit Ebenen-Default, fail-closed 'intern', D-14)
}

function mapSitzungsmappe(s: DesktopState, id: string, fn: (m: Sitzungsmappe) => Sitzungsmappe): DesktopState {
  const sitzungsmappen = s.sitzungsmappen ?? [];
  if (!sitzungsmappen.some((m) => m.id === id)) throw new Error(`Sitzungsmappe "${id}" nicht gefunden`);
  return { ...s, sitzungsmappen: sitzungsmappen.map((m) => (m.id === id ? fn(m) : m)) };
}

/** Legt eine neue, leere Sitzungsmappe an (leere Agenda, leere offene Fragen). */
export function addSitzungsmappe(s: DesktopState, titel: string, id: string = uid(), meta?: CommandMeta): DesktopState {
  const mappe: Sitzungsmappe = { id, titel, docIds: [], offeneFragen: [], ...provenienz(meta) };
  return { ...s, sitzungsmappen: [...(s.sitzungsmappen ?? []), mappe] };
}

export function findSitzungsmappe(s: DesktopState, id: string): Sitzungsmappe | undefined {
  return (s.sitzungsmappen ?? []).find((m) => m.id === id);
}

/** Ändert nur den Titel — Agenda und offene Fragen bleiben unberührt. Unbekannte id wirft, wie
 *  `renameTable`/`renameStack`. */
export function renameSitzungsmappe(s: DesktopState, id: string, titel: string): DesktopState {
  return mapSitzungsmappe(s, id, (m) => ({ ...m, titel }));
}

/** Entfernt eine Sitzungsmappe vollständig. Unbekannte id wirft, wie `removeTable`/`removeZeitleiste`. */
export function removeSitzungsmappe(s: DesktopState, id: string): DesktopState {
  const sitzungsmappen = s.sitzungsmappen ?? [];
  if (!sitzungsmappen.some((m) => m.id === id)) throw new Error(`Sitzungsmappe "${id}" nicht gefunden`);
  return { ...s, sitzungsmappen: sitzungsmappen.filter((m) => m.id !== id) };
}

/** Letzte angelegte Sitzungsmappe — Grundlage für „🎓 Sitzungsmappe…" (DeskSwitcher) und das
 *  Kontextmenü „Zur Sitzungsmappe hinzufügen": es gibt in dieser Ausbaustufe genau eine aktive
 *  Sitzungsmappe je Desk, keine Auswahlliste. */
export function aktuelleSitzungsmappe(s: DesktopState): Sitzungsmappe | undefined {
  const liste = s.sitzungsmappen ?? [];
  return liste.length > 0 ? liste[liste.length - 1] : undefined;
}

/**
 * Fügt ein Dokument zur Agenda hinzu — idempotent: enthält `docIds` die `docId` bereits, wird
 * genau derselbe State (Referenzgleichheit) zurückgegeben, `docIds` verlängert sich nicht.
 * Dieselbe Idempotenz-Haltung wie `ergaenzeAuswahl` (src/lib/anlagenpaketAuswahl.ts).
 */
export function addSitzungsmappeDoc(s: DesktopState, id: string, docId: string): DesktopState {
  const mappe = findSitzungsmappe(s, id);
  if (!mappe) throw new Error(`Sitzungsmappe "${id}" nicht gefunden`);
  if (mappe.docIds.includes(docId)) return s;
  return mapSitzungsmappe(s, id, (m) => ({ ...m, docIds: [...m.docIds, docId] }));
}

/**
 * Entfernt eine docId aus der Agenda — bewusst ein No-op mit Referenzgleichheit (kein Wurf),
 * wenn die docId nicht (mehr) in der Agenda steht: anders als die werfenden Entfernen-Funktionen
 * der Objektregister (`removeTable`, `removeNote`, …) ist die Agenda eine reine Referenzliste,
 * und die Offline-Warteschlange (SAFE-02) kann ein Kommando erneut abspielen, ohne dass ein
 * zweiter Versuch als Fehler erscheinen darf.
 */
export function removeSitzungsmappeDoc(s: DesktopState, id: string, docId: string): DesktopState {
  const mappe = findSitzungsmappe(s, id);
  if (!mappe) throw new Error(`Sitzungsmappe "${id}" nicht gefunden`);
  if (!mappe.docIds.includes(docId)) return s;
  return mapSitzungsmappe(s, id, (m) => ({ ...m, docIds: m.docIds.filter((d) => d !== docId) }));
}

/**
 * Vertauscht eine docId mit ihrem Vorgänger (`richtung: -1`) oder Nachfolger (`richtung: 1`) in
 * der Agenda-Reihenfolge. Ein Schritt über ein Ende hinaus (erster Eintrag nach oben, letzter
 * nach unten) oder eine docId, die nicht in der Agenda steht, ist derselbe bewusste No-op wie bei
 * `removeSitzungsmappeDoc` — Referenzgleichheit statt Wurf oder stillschweigendem Umbruch.
 */
export function verschiebeSitzungsmappeDoc(s: DesktopState, id: string, docId: string, richtung: -1 | 1): DesktopState {
  const mappe = findSitzungsmappe(s, id);
  if (!mappe) throw new Error(`Sitzungsmappe "${id}" nicht gefunden`);
  const index = mappe.docIds.indexOf(docId);
  if (index === -1) return s;
  const zielIndex = index + richtung;
  if (zielIndex < 0 || zielIndex >= mappe.docIds.length) return s;
  return mapSitzungsmappe(s, id, (m) => {
    const docIds = [...m.docIds];
    [docIds[index], docIds[zielIndex]] = [docIds[zielIndex], docIds[index]];
    return { ...m, docIds };
  });
}

/** Hängt eine offene Frage mit eigener id an — auch mit leerem Text (leere Zeile zum späteren
 *  Befüllen). Zwei Zeilen mit identischem Text bleiben zwei Einträge: die Identität einer Zeile
 *  hängt allein an ihrer id, nie an ihrem Text. */
export function addOffeneFrage(s: DesktopState, id: string, text: string, frageId: string = uid()): DesktopState {
  const frage: OffeneFrage = { id: frageId, text, beantwortet: false };
  return mapSitzungsmappe(s, id, (m) => ({ ...m, offeneFragen: [...m.offeneFragen, frage] }));
}

function mapOffeneFrage(s: DesktopState, id: string, frageId: string, fn: (f: OffeneFrage) => OffeneFrage): DesktopState {
  return mapSitzungsmappe(s, id, (m) => {
    if (!m.offeneFragen.some((f) => f.id === frageId)) throw new Error(`Offene Frage "${frageId}" nicht gefunden`);
    return { ...m, offeneFragen: m.offeneFragen.map((f) => (f.id === frageId ? fn(f) : f)) };
  });
}

/** Ersetzt den Text unverändert und ohne Kürzung — auch bei sehr langem Text oder Text mit
 *  Zeilenumbrüchen/Sonderzeichen (Inhalt, kein Etikett). Unbekannte Frage-id wirft. */
export function setOffeneFrageText(s: DesktopState, id: string, frageId: string, text: string): DesktopState {
  return mapOffeneFrage(s, id, frageId, (f) => ({ ...f, text }));
}

/** Setzt/hebt das Häkchen „beantwortet" — zweimal denselben Wert zu setzen ändert am Ergebnis
 *  nichts (aber wirft nicht, anders als removeSitzungsmappeDoc kein Referenzgleichheits-Anspruch,
 *  weil `setNoteDone` dasselbe unbedingte Zuweisungsmuster vorführt). Unbekannte Frage-id wirft. */
export function setOffeneFrageBeantwortet(s: DesktopState, id: string, frageId: string, beantwortet: boolean): DesktopState {
  return mapOffeneFrage(s, id, frageId, (f) => ({ ...f, beantwortet }));
}

/** Entfernt genau die Zeile mit der übergebenen id. Unbekannte Frage-id wirft — anders als
 *  `removeSitzungsmappeDoc`: eine offene Frage ist ein tatsächlich existierendes Unterobjekt mit
 *  eigener id, kein Referenzlisten-Eintrag, den eine erneut abgespielte Offline-Warteschlange
 *  harmlos noch einmal senden könnte. */
export function removeOffeneFrage(s: DesktopState, id: string, frageId: string): DesktopState {
  return mapSitzungsmappe(s, id, (m) => {
    if (!m.offeneFragen.some((f) => f.id === frageId)) throw new Error(`Offene Frage "${frageId}" nicht gefunden`);
    return { ...m, offeneFragen: m.offeneFragen.filter((f) => f.id !== frageId) };
  });
}

/**
 * Agenda-Zeilen für den Vorbereitungsdialog: je docId Name und Verfügbarkeit, in
 * Agenda-Reihenfolge, ohne den State zu verändern (reine Ableitung, wie
 * `sprungmarkenFuerSitzungsmappe`). Der Name wird zuerst über `state.docs` aufgelöst; ist das
 * Dokument dort nicht (mehr) zu finden, liefert die Volltextkopie im Papierkorb (`TrashPayload.docs`)
 * Name und „im Papierkorb"-Status; ist es auch dort nicht zu finden, gilt es als vollständig
 * verschwunden — weder verfügbar noch im Papierkorb (kein stilles Verschwinden aus der Zeile,
 * siehe E2/partial in der UI-SPEC).
 */
export function agendaZeilen(
  s: DesktopState,
  mappe: Sitzungsmappe,
): { docId: string; name: string; verfuegbar: boolean; imPapierkorb: boolean }[] {
  return mappe.docIds.map((docId) => {
    const doc = s.docs.find((d) => d.id === docId);
    if (doc) return { docId, name: doc.name, verfuegbar: true, imPapierkorb: false };
    for (const item of s.trash ?? []) {
      const imKorb = item.payload.docs.find((d) => d.id === docId);
      if (imKorb) return { docId, name: imKorb.name, verfuegbar: false, imPapierkorb: true };
    }
    return { docId, name: 'Entferntes Dokument', verfuegbar: false, imPapierkorb: false };
  });
}

/**
 * Sprungmarken einer Sitzungsmappe: alle Fahnen (`Flag`) der Agenda-Dokumente, in
 * Agenda-Reihenfolge der Dokumente, innerhalb eines Dokuments nach Seite aufsteigend und bei
 * gleicher Seite stabil nach Flag-id (deterministisch statt nur einfügereihenfolge-stabil,
 * dieselbe Lesart wie `sortierteEintraege()` in zeitleiste.ts). Rein abgeleitet, nie gespeichert.
 */
export function sprungmarkenFuerSitzungsmappe(s: DesktopState, mappe: Sitzungsmappe): Flag[] {
  const ergebnis: Flag[] = [];
  for (const docId of mappe.docIds) {
    const sortiert = flagsFor(s, docId).slice().sort((a, b) => {
      if (a.page !== b.page) return a.page - b.page;
      return a.id.localeCompare(b.id);
    });
    ergebnis.push(...sortiert);
  }
  return ergebnis;
}
