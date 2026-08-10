import { provenienz, type DesktopState, type Vec2, type Size, type CommandMeta } from './model';
import { removeLinksFor } from './links';
import { findeObjekt } from './stempel';
import type { Box } from './viewport';
import { uid } from './uid';

/**
 * Zeitleistenkarte (CHRONO-01/02): sammelt Referenzen auf Fallereignisse in chronologischer
 * Reihenfolge. Ein eigenständiges, registriertes Objekt auf dem Tisch — wie jede andere Karte
 * mit Konflikterkennung, Ebenenzuordnung, Freigabe und Papierkorb (08-RESEARCH.md Anti-Pattern,
 * hier für die erste neue Weltkartenart nach Phase 8 fortgeschrieben).
 *
 * Einträge sind in der Karte VERSCHACHTELT und tragen KEINE eigene Objektidentität: sie bekommen
 * keinen eigenen VERSIONIERTE_ARTEN-Eintrag, `findeObjekt` löst eine Eintrags-id nie auf. Ein
 * Eintrag trägt bewusst KEIN Titel-, Namens- oder Textfeld — er speichert ausschließlich eine
 * Referenz (`objRef`) auf ein bestehendes Weltobjekt; die Beschriftung auf der Achse wird zur
 * Anzeigezeit AUSSCHLIESSLICH aus dem referenzierten (bereits sichtbarkeitsprojizierten) Objekt
 * abgeleitet. Das ist keine Bequemlichkeit, sondern die Sicherheitsgarantie hinter CHRONO-01: ein
 * Eintrag, dessen Quellobjekt für den Betrachter nicht sichtbar ist, kann so nie einen Titel oder
 * Inhalt zeigen, den die Projektion eigentlich verbirgt (T-09-02).
 *
 * WR-02 (09-REVIEW.md) — Reichweite dieser Garantie bewusst eng gefasst: sie deckt ausschließlich
 * TITEL/INHALT ab, NICHT die Existenz des Eintrags selbst. `ZeitleisteCard.eintraege` wird als
 * Ganzes mit der Karte ausgeliefert (Einträge haben keine eigene `layerId`/`findeObjekt`-Identität,
 * über die `projectStateForActor()` sie einzeln herausfiltern könnte — nur die Karte selbst wird
 * als Einheit projiziert). Ein Betrachter, der das referenzierte Objekt eines Eintrags nicht sehen
 * kann (z. B. private Ebene einer anderen Person), sieht deshalb weiterhin: dass der Eintrag
 * existiert, sein Datum/Zeitraum, seine Art (Icon) und sein `streitig`/`abgeleitet`-Flag — nur
 * Titel/Name/Text bleiben verborgen. Das ist eine bewusst dokumentierte Grenze, keine Lücke: eine
 * vollständige Aussparung nicht auflösbarer Einträge (analog zum `Link`-Verhalten in
 * `LinkLayer.svelte`, das einen Endpunkt komplett ausblendet statt einen anonymisierten Stub zu
 * zeigen) wäre eine andere, bewusst nicht getroffene Produktentscheidung.
 */

/** Sieben Eintragsarten (CHRONO-01), Reihenfolge exakt nach dem Anforderungstext. */
export const ZEITLEISTE_EINTRAG_ARTEN = [
  'ereignis', 'dokument', 'email', 'bescheid', 'frist', 'zahlung', 'zeugenaussage',
] as const;
export type ZeitleisteEintragArt = (typeof ZEITLEISTE_EINTRAG_ARTEN)[number];

/** Fünf Zeitangaben (CHRONO-02) — genau eine gilt je Eintrag, Default 'genau'. */
export const ZEITANGABE_ARTEN = ['genau', 'ungefaehr', 'zeitraum', 'streitig', 'abgeleitet'] as const;
export type ZeitangabeArt = (typeof ZEITANGABE_ARTEN)[number];

const ISO_TAG_MUSTER = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Ein Eintrag auf der Zeitleiste: ausschließlich Referenz + Klassifikation + Zeitangabe. KEIN
 * Titel-/Namens-/Textfeld (siehe Modul-Kopfkommentar) — `objRef` verweist auf die id eines
 * bestehenden, versionierten Weltobjekts.
 */
export interface ZeitleistenEintrag {
  id: string;
  objRef: string;         // id des referenzierten Weltobjekts (Doc/Note/LegalObject/Cutout/…)
  art: ZeitleisteEintragArt;
  zeitangabe: ZeitangabeArt;
  datum: string;           // ISO-Kalendertag (JJJJ-MM-TT)
  datumBis?: string;       // nur bei zeitangabe === 'zeitraum'; sonst nie gespeichert
}

export interface ZeitleisteCard {
  id: string;
  titel: string;           // fest 'Zeitleiste' — keine Umbenennung in dieser Ausbaustufe
  eintraege: ZeitleistenEintrag[];
  position: Vec2;   // Weltkoordinaten, linke obere Ecke
  zIndex: number;
  open?: boolean;      // aufgeschlagen (große Karte) statt Miniatur
  openSize?: Size;     // Größe der großen Karte (Weltkoordinaten)
  taped?: boolean;       // Klebeband: Drag gesperrt, bis das Band abgezogen wird
  createdBy?: string;    // Provenienz: wer hat die Karte erzeugt; fehlt in Alt-States
  createdById?: string;  // Provenienz: stabile users.id des Erzeugers (WR-05); fehlt in Alt-States
  createdAt?: string;    // Provenienz: wann, ISO-Zeitpunkt; fehlt in Alt-States
  updatedRev?: number;   // Konflikterkennung: Schreibtisch-rev der letzten Änderung; fehlt in Alt-States
  updatedAt?: string;    // Provenienz: wann zuletzt geändert, ISO-Zeitpunkt; fehlt in Alt-States
  updatedBy?: string;    // Provenienz: wer zuletzt geändert hat; fehlt in Alt-States
  layerId?: string;      // Sichtbarkeits-/Bearbeitungsebene; fehlt in Alt-States (implizit "Kanzlei")
  freigabe?: import('./freigabe').Freigabe; // Freigabe-Override (EXP-03); fehlt in Alt-States (implizit Ebenen-Default, fail-closed 'intern', D-14)
}

// Elongiertes Format statt Dokumentformat (09-UI-SPEC.md Spacing Exceptions): eine Zeitleiste ist
// inhaltlich horizontal, deshalb NICHT CARD_W/CARD_H wie jede andere Miniatur.
export const ZEITLEISTE_W = 220;
export const ZEITLEISTE_H = 96;
export const ZEITLEISTE_OPEN_W = 880;
export const ZEITLEISTE_OPEN_H = 320;
export const ZEITLEISTE_MIN_W = 220;
export const ZEITLEISTE_MIN_H = 280;

function maxZ(s: DesktopState): number {
  return Math.max(
    0,
    ...s.docs.map((d) => d.zIndex),
    ...s.stacks.map((st) => st.zIndex),
    ...(s.notes ?? []).map((n) => n.zIndex),
    ...(s.cutouts ?? []).map((c) => c.zIndex),
    ...(s.legalObjects ?? []).map((o) => o.zIndex),
    ...(s.tables ?? []).map((t) => t.zIndex),
    ...(s.zeitleisten ?? []).map((z) => z.zIndex),
  );
}

function mapZeitleiste(s: DesktopState, id: string, fn: (z: ZeitleisteCard) => ZeitleisteCard): DesktopState {
  const zeitleisten = s.zeitleisten ?? [];
  if (!zeitleisten.some((z) => z.id === id)) throw new Error(`Zeitleiste "${id}" nicht gefunden`);
  return { ...s, zeitleisten: zeitleisten.map((z) => (z.id === id ? fn(z) : z)) };
}

/**
 * Prüft/normalisiert das Tripel aus Zeitangabe/Datum/Enddatum an GENAU dieser einen Stelle —
 * `addZeitleisteEintrag` und `setZeitleisteEintrag` rufen ausschließlich diesen Helfer auf und
 * enthalten selbst keine eigene Datumsprüfung (zwei Kopien der Regel wären zwei Wahrheiten,
 * 09-01-PLAN.md). Der Default 'genau' lebt ebenfalls hier, nicht im Client — die Oberfläche darf
 * den Default vorbelegen, aber die Wahrheit über den Default liegt im Kern.
 */
function pruefeZeitangabe(
  zeitangabe: ZeitangabeArt | undefined,
  datum: string,
  datumBis: string | undefined,
): { zeitangabe: ZeitangabeArt; datum: string; datumBis?: string } {
  if (typeof datum !== 'string' || !ISO_TAG_MUSTER.test(datum)) {
    throw new Error(`Datum "${String(datum)}" ist kein gültiger Kalendertag (JJJJ-MM-TT)`);
  }
  const art = zeitangabe ?? 'genau';
  if (!ZEITANGABE_ARTEN.includes(art)) throw new Error(`Unbekannte Zeitangabe: ${String(art)}`);
  if (art !== 'zeitraum') {
    // Bei jeder anderen Zeitangabe wird ein mitgeliefertes datumBis verworfen statt gespeichert —
    // kein stiller Rückfall auf eine andere Zeitangabe.
    return { zeitangabe: art, datum };
  }
  if (typeof datumBis !== 'string' || !ISO_TAG_MUSTER.test(datumBis)) {
    throw new Error('Zeitangabe "zeitraum" benötigt ein gültiges Enddatum (JJJJ-MM-TT)');
  }
  if (datumBis < datum) throw new Error('Enddatum darf nicht vor dem Startdatum liegen');
  return { zeitangabe: art, datum, datumBis };
}

/** Legt eine neue Zeitleistenkarte an — sofort GEÖFFNET, weil eine leere Zeitleiste ohne
 *  sichtbare Achse nichts aussagt (09-UI-SPEC.md Komponentenkontrakt). */
export function addZeitleiste(s: DesktopState, position: Vec2, id: string = uid(), meta?: CommandMeta): DesktopState {
  const zeitleiste: ZeitleisteCard = {
    id,
    titel: 'Zeitleiste',
    eintraege: [],
    position,
    zIndex: maxZ(s) + 1,
    open: true,
    openSize: { w: ZEITLEISTE_OPEN_W, h: ZEITLEISTE_OPEN_H },
    ...provenienz(meta),
  };
  return { ...s, zeitleisten: [...(s.zeitleisten ?? []), zeitleiste] };
}

export function moveZeitleiste(s: DesktopState, id: string, position: Vec2): DesktopState {
  return mapZeitleiste(s, id, (z) => ({ ...z, position }));
}

export function removeZeitleiste(s: DesktopState, id: string): DesktopState {
  const zeitleisten = s.zeitleisten ?? [];
  if (!zeitleisten.some((z) => z.id === id)) throw new Error(`Zeitleiste "${id}" nicht gefunden`);
  const next = removeLinksFor(s, id);
  return { ...next, zeitleisten: zeitleisten.filter((z) => z.id !== id) };
}

export function expandZeitleiste(s: DesktopState, id: string): DesktopState {
  return mapZeitleiste(s, id, (z) => ({ ...z, open: true, openSize: z.openSize ?? { w: ZEITLEISTE_OPEN_W, h: ZEITLEISTE_OPEN_H } }));
}

export function collapseZeitleiste(s: DesktopState, id: string): DesktopState {
  return mapZeitleiste(s, id, (z) => ({ ...z, open: false }));
}

/** Größe wird auf ZEITLEISTE_MIN_W/ZEITLEISTE_MIN_H geklemmt statt abgelehnt (09-01-PLAN.md). */
export function resizeZeitleiste(s: DesktopState, id: string, size: Size): DesktopState {
  if (!Number.isFinite(size.w) || !Number.isFinite(size.h)) throw new Error(`Ungültige Größe: ${size.w}×${size.h}`);
  const w = Math.max(ZEITLEISTE_MIN_W, size.w);
  const h = Math.max(ZEITLEISTE_MIN_H, size.h);
  return mapZeitleiste(s, id, (z) => ({ ...z, openSize: { w, h } }));
}

/** Fügt einen Eintrag hinzu. `objRef` muss auf ein bestehendes, versioniertes Objekt zeigen —
 *  sonst Error (T-09-04: ein Eintrag ohne gültiges Zielobjekt könnte die Ebenen-/Freigabe-Prüfung
 *  auf `objRef` nie greifen lassen). */
export function addZeitleisteEintrag(
  s: DesktopState,
  zeitleisteId: string,
  objRef: string,
  art: ZeitleisteEintragArt,
  zeitangabe: ZeitangabeArt | undefined,
  datum: string,
  datumBis?: string,
  id: string = uid(),
): DesktopState {
  if (!(ZEITLEISTE_EINTRAG_ARTEN as readonly string[]).includes(art)) {
    throw new Error(`Unbekannte Eintragsart: ${String(art)}`);
  }
  if (!findeObjekt(s, objRef)) throw new Error(`Objekt "${objRef}" nicht gefunden`);
  const geprueft = pruefeZeitangabe(zeitangabe, datum, datumBis);
  const eintrag: ZeitleistenEintrag = { id, objRef, art, ...geprueft };
  return mapZeitleiste(s, zeitleisteId, (z) => ({ ...z, eintraege: [...z.eintraege, eintrag] }));
}

/**
 * Teilaktualisierung eines Eintrags: nicht mitgelieferte Felder bleiben unverändert; ein
 * ausdrücklich mit `datumBis: undefined` mitgeliefertes (aber als Schlüssel VORHANDENES) Feld
 * entfernt den Wert — Unterscheidung über `in`, nicht über einen Vergleich mit `undefined`
 * (Muster wie `setLinkKind` in links.ts, hier auf mehrere optionale Felder erweitert). Die
 * Zeitraum-Regel selbst lebt ausschließlich in `pruefeZeitangabe` — dieser Setter enthält keine
 * eigene Datumsprüfung.
 */
export function setZeitleisteEintrag(
  s: DesktopState,
  zeitleisteId: string,
  eintragId: string,
  felder: { art?: ZeitleisteEintragArt; zeitangabe?: ZeitangabeArt; datum?: string; datumBis?: string },
): DesktopState {
  return mapZeitleiste(s, zeitleisteId, (z) => {
    if (!z.eintraege.some((e) => e.id === eintragId)) throw new Error(`Zeitleisten-Eintrag "${eintragId}" nicht gefunden`);
    return {
      ...z,
      eintraege: z.eintraege.map((e) => {
        if (e.id !== eintragId) return e;
        const art = felder.art ?? e.art;
        if (!(ZEITLEISTE_EINTRAG_ARTEN as readonly string[]).includes(art)) {
          throw new Error(`Unbekannte Eintragsart: ${String(art)}`);
        }
        const zeitangabe = felder.zeitangabe ?? e.zeitangabe;
        const datum = felder.datum ?? e.datum;
        const datumBis = 'datumBis' in felder ? felder.datumBis : e.datumBis;
        const geprueft = pruefeZeitangabe(zeitangabe, datum, datumBis);
        // `e` ohne sein ALTES datumBis verwenden, sonst überlebte ein Zeitraum-Enddatum die
        // Spread-Reihenfolge, wenn pruefeZeitangabe es bewusst wegließ (Wechsel weg von
        // 'zeitraum') — { ...e, ...geprueft } allein hätte das alte Feld nicht entfernt, weil
        // ein FEHLENDER Schlüssel in geprueft ein VORHANDENES Feld aus e nicht überschreibt.
        const { datumBis: _altesDatumBis, ...eOhneDatumBis } = e;
        return { ...eOhneDatumBis, art, ...geprueft };
      }),
    };
  });
}

export function removeZeitleisteEintrag(s: DesktopState, zeitleisteId: string, eintragId: string): DesktopState {
  return mapZeitleiste(s, zeitleisteId, (z) => {
    if (!z.eintraege.some((e) => e.id === eintragId)) throw new Error(`Zeitleisten-Eintrag "${eintragId}" nicht gefunden`);
    return { ...z, eintraege: z.eintraege.filter((e) => e.id !== eintragId) };
  });
}

export function findZeitleiste(s: DesktopState, id: string): ZeitleisteCard | undefined {
  return (s.zeitleisten ?? []).find((z) => z.id === id);
}

/** Geschlossen: liegendes ZEITLEISTE_W×ZEITLEISTE_H-Format — bewusst NICHT CARD_W/CARD_H, die
 *  Miniatur ist liegend statt im Dokumentformat. */
export function zeitleisteBox(z: ZeitleisteCard): Box {
  if (z.open) {
    const size = z.openSize ?? { w: ZEITLEISTE_OPEN_W, h: ZEITLEISTE_OPEN_H };
    return { x: z.position.x, y: z.position.y, w: size.w, h: size.h };
  }
  return { x: z.position.x, y: z.position.y, w: ZEITLEISTE_W, h: ZEITLEISTE_H };
}

/** Einträge nach Datum aufsteigend, bei Gleichstand nach id — deterministisch statt nur
 *  einfügereihenfolge-stabil. */
export function sortierteEintraege(z: ZeitleisteCard): ZeitleistenEintrag[] {
  return [...z.eintraege].sort((a, b) => {
    if (a.datum !== b.datum) return a.datum < b.datum ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
