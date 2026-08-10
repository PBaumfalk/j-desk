import { uid } from './uid';
import { findDoc, findStack, provenienz, type DesktopState, type Doc, type Link, type CommandMeta } from './model';
import { CommandError } from './commands';

export function addLink(
  s: DesktopState,
  fromId: string,
  toId: string,
  id: string = uid(),
  meta?: CommandMeta,
): DesktopState {
  if (fromId === toId) return s;
  const exists = s.links.some(
    (l) => (l.fromId === fromId && l.toId === toId) || (l.fromId === toId && l.toId === fromId),
  );
  if (exists) return s;
  return {
    ...s,
    links: [...s.links, { id, fromId, toId, note: '', ...provenienz(meta) }],
  };
}

export function setLinkNote(s: DesktopState, linkId: string, note: string): DesktopState {
  return { ...s, links: s.links.map((l) => (l.id === linkId ? { ...l, note } : l)) };
}

/** Die 11 gesperrten Bedeutungswerte einer Verknüpfung (LEGAL-02, REQUIREMENTS.md Zeile 78). */
export const LINK_MEANINGS = [
  'belegt', 'widerspricht', 'bestaetigt', 'widerlegt', 'gehoert-zu', 'entkraeftet',
  'folge-von', 'voraussetzung-fuer', 'offene-frage', 'streitig', 'unstreitig',
] as const;
export type LinkMeaning = (typeof LINK_MEANINGS)[number];

/** Drei visuelle Familien für Linienfarbe/-stil (08-UI-SPEC.md „Verknüpfungs-Bedeutung") — die
 *  exakte Bedeutung steht immer zusätzlich als Text an der Linie, die Familie bestimmt nur Optik. */
export type LinkMeaningFamily = 'bestaetigend' | 'widersprechend' | 'offen';

/** Vollständige Zuordnung aller 11 Bedeutungswerte zu ihrer Familie; der Record-Typ erzwingt
 *  Vollständigkeit bereits zur Übersetzungszeit (ein fehlender Wert ist ein Typfehler). */
export const LINK_MEANING_FAMILY: Record<LinkMeaning, LinkMeaningFamily> = {
  belegt: 'bestaetigend',
  bestaetigt: 'bestaetigend',
  'gehoert-zu': 'bestaetigend',
  'folge-von': 'bestaetigend',
  'voraussetzung-fuer': 'bestaetigend',
  unstreitig: 'bestaetigend',
  widerspricht: 'widersprechend',
  widerlegt: 'widersprechend',
  entkraeftet: 'widersprechend',
  streitig: 'widersprechend',
  'offene-frage': 'offen',
};

/** Bildet eine Verknüpfungsbedeutung auf ihre Familie ab; eine fehlende Bedeutung liefert die
 *  Familie „Offen" (identisch zu 'offene-frage') — EINZIGE Stelle, an der die Abwesenheit einer
 *  Bedeutung interpretiert wird. Client (LinkLayer.svelte) und Serverabfragen (Plan 08-05)
 *  konsumieren beide diese Funktion, damit keine zweite Zuordnung entstehen kann. */
export function familieVon(kind: LinkMeaning | undefined): LinkMeaningFamily {
  if (kind === undefined) return 'offen';
  return LINK_MEANING_FAMILY[kind];
}

/** Setzt oder entfernt die Bedeutung einer Verknüpfung (LEGAL-02) — wortgleich nach dem
 *  setLinkNote-Muster (Spread über .map, kein Nicht-gefunden-Guard, stilles No-op bei
 *  unbekannter linkId). Bei kind === undefined wird das Feld aus dem Objekt entfernt, statt
 *  undefined zu speichern. */
export function setLinkKind(s: DesktopState, linkId: string, kind: LinkMeaning | undefined): DesktopState {
  return {
    ...s,
    links: s.links.map((l) => {
      if (l.id !== linkId) return l;
      if (kind === undefined) {
        const { kind: _entfernt, ...rest } = l;
        return rest;
      }
      return { ...l, kind };
    }),
  };
}

export function removeLink(s: DesktopState, linkId: string): DesktopState {
  return { ...s, links: s.links.filter((l) => l.id !== linkId) };
}

export function removeLinksFor(s: DesktopState, entityId: string): DesktopState {
  return { ...s, links: s.links.filter((l) => l.fromId !== entityId && l.toId !== entityId) };
}

/** Der einzige strukturelle Wert einer Versionsbeziehung (COMP-03) — orthogonal zu `LinkMeaning`,
 *  kein zwölfter Bedeutungswert (09-UI-SPEC.md). */
export type VersionStruktur = 'version';

/** Erkennt genau die Verknüpfungen mit der Strukturkennzeichnung; gewöhnliche Verknüpfungen
 *  (auch solche mit `kind`) liefern false. */
export function istVersionLink(l: Link): boolean {
  return l.struktur === 'version';
}

/**
 * Legt eine gerichtete Versionsbeziehung an (COMP-03): `olderId` ist die ältere, `newerId` die
 * neuere Fassung — bewusst KEINE Wiederverwendung von `addLink` (dort symmetrisch, hier
 * gerichtet). Prüfreihenfolge:
 *  1. gleiche id für beide Seiten: stilles No-op (wie addLink)
 *  2. exakt gleiche Beziehung existiert bereits: stilles No-op
 *  3. die neue Fassung hat bereits einen direkten Vorgänger: Ablehnung
 *  4. die alte Fassung hat bereits einen direkten Nachfolger: Ablehnung (Kette verzweigt nicht)
 *  5. Vorfahrenlauf von der alten Fassung aus: taucht die neue Fassung darin auf, würde die
 *     Verbindung einen Kreis schließen — Ablehnung. Die Regeln 3/4 machen einen Kreis in sauber
 *     angelegten Daten unmöglich, aber ein importierter oder von Hand veränderter Bestand ist
 *     keine saubere Annahme (09-RESEARCH.md Pitfall 2); der Lauf begrenzt sich zusätzlich über
 *     eine Menge besuchter ids, damit ein bereits verdorbener Bestand nicht in eine
 *     Endlosschleife führt.
 */
export function addVersionLink(
  s: DesktopState,
  olderId: string,
  newerId: string,
  id: string = uid(),
  meta?: CommandMeta,
): DesktopState {
  if (olderId === newerId) return s;
  const existsExact = s.links.some(
    (l) => l.struktur === 'version' && l.fromId === olderId && l.toId === newerId,
  );
  if (existsExact) return s;
  const hatVorgaenger = s.links.some((l) => l.struktur === 'version' && l.toId === newerId);
  if (hatVorgaenger) {
    throw new CommandError('Dieses Dokument hat bereits einen direkten Vorgänger in der Versionskette');
  }
  const hatNachfolger = s.links.some((l) => l.struktur === 'version' && l.fromId === olderId);
  if (hatNachfolger) {
    throw new CommandError('Diese Fassung hat bereits einen direkten Nachfolger — eine Versionskette verzweigt nicht');
  }
  const besucht = new Set<string>();
  let current: string | undefined = olderId;
  while (current !== undefined) {
    if (besucht.has(current)) break;
    besucht.add(current);
    if (current === newerId) {
      throw new CommandError('Diese Verbindung würde einen Kreis in der Versionskette schließen');
    }
    current = s.links.find((l) => l.struktur === 'version' && l.toId === current)?.fromId;
  }
  return {
    ...s,
    links: [
      ...s.links,
      { id, fromId: olderId, toId: newerId, note: '', struktur: 'version', ...provenienz(meta) },
    ],
  };
}

/** Entfernt eine Versionsbeziehung per id — nur, wenn die Verknüpfung die Strukturkennzeichnung
 *  trägt; sonst unveränderter Zustand (stilles No-op, analog removeLink). */
export function removeVersionLink(s: DesktopState, linkId: string): DesktopState {
  return { ...s, links: s.links.filter((l) => !(l.id === linkId && l.struktur === 'version')) };
}

/**
 * Liefert die vollständige Versionskette des übergebenen Dokuments als geordnete Liste von der
 * ältesten zur neuesten Fassung, inklusive des übergebenen Dokuments — unabhängig davon, an
 * welcher Fassung die Abfrage ansetzt. Läuft zuerst rückwärts zum Kettenanfang, dann vorwärts
 * bis zum Ende. Ein Dokument ohne Versionsbeziehung liefert eine einelementige Liste. Auf einem
 * projizierten Zustand (fehlende Zwischenglieder, s. projection.ts) liefert die Funktion genau
 * die zusammenhängende sichtbare Teilkette um `docId` und bricht an einer Lücke einfach ab,
 * statt abzustürzen oder die Lücke anzudeuten. Begrenzt sich über eine Menge besuchter ids
 * (Schutz gegen einen verdorbenen Bestandszustand, wie addVersionLink).
 */
export function versionKetteVon(s: DesktopState, docId: string): string[] {
  const vorgaengerVon = (id: string): string | undefined =>
    s.links.find((l) => l.struktur === 'version' && l.toId === id)?.fromId;
  const nachfolgerVon = (id: string): string | undefined =>
    s.links.find((l) => l.struktur === 'version' && l.fromId === id)?.toId;

  const rueckwaerts: string[] = [];
  {
    const besucht = new Set<string>([docId]);
    let current = vorgaengerVon(docId);
    while (current !== undefined && !besucht.has(current)) {
      besucht.add(current);
      rueckwaerts.push(current);
      current = vorgaengerVon(current);
    }
  }

  const vorwaerts: string[] = [];
  {
    const besucht = new Set<string>([docId, ...rueckwaerts]);
    let current = nachfolgerVon(docId);
    while (current !== undefined && !besucht.has(current)) {
      besucht.add(current);
      vorwaerts.push(current);
      current = nachfolgerVon(current);
    }
  }

  return [...rueckwaerts.reverse(), docId, ...vorwaerts];
}

export function linkedEntityIds(s: DesktopState, entityId: string): string[] {
  return s.links
    .filter((l) => l.fromId === entityId || l.toId === entityId)
    .map((l) => (l.fromId === entityId ? l.toId : l.fromId));
}

/** Dokumente der Entität selbst plus aller direkt verknüpften Entitäten (Stapel → enthaltene Dokumente), dedupliziert. */
export function collectLinkedDocs(s: DesktopState, entityId: string): Doc[] {
  const docs = new Map<string, Doc>();
  const addEntity = (id: string) => {
    const st = findStack(s, id);
    if (st) {
      for (const docId of st.docIds) {
        const d = findDoc(s, docId);
        if (d) docs.set(d.id, d);
      }
      return;
    }
    const d = findDoc(s, id);
    if (d) docs.set(d.id, d);
  };
  addEntity(entityId);
  for (const other of linkedEntityIds(s, entityId)) addEntity(other);
  return [...docs.values()];
}
