import type { Doc } from '@j-desk/core';

/**
 * Referenzstatus (j-lawyer-Modus): genau ein Zustand je Dokument, feste Priorität
 * gone > entzogen > nicht erreichbar > ersetzt > umbenannt > archiviert (01-06 Plan) —
 * ein verwaistes/entzogenes Dokument ist nicht zugleich „neu gefasst"/„umbenannt". Annotationen
 * bleiben in allen sechs Zuständen unangetastet erhalten.
 *
 * Vormals dreifach dupliziert in DocCard.svelte, DocViewer.svelte und ProvenancePopover.svelte
 * (IN-01) — WR-04 zeigte, wie diese Duplikation real auseinanderdriftet (DocViewer kannte nur
 * 2 von 6 Zuständen). DocCard und DocViewer beziehen Kurz-Badge/Tooltip-Text jetzt von hier;
 * ProvenancePopover.svelte übernimmt nur die Priorität/`kind` (die eigene, ausführlichere
 * Popover-Formulierung bleibt dort lokal, da sie fachlich mehr Kontext liefert als ein
 * Karten-Tooltip).
 */
export type ReferenzstatusKind =
  | 'gone'
  | 'entzogen'
  | 'nichtErreichbar'
  | 'neueFassung'
  | 'umbenannt'
  | 'archiviert';

export interface ReferenzstatusInfo {
  kind: ReferenzstatusKind;
  /** Kurzform für Badge/aria-label (z. B. "Zugriff entzogen"). */
  kurz: string;
  /** Ein bis zwei Sätze für Tooltip/aria-label-Ergänzung. */
  erklaerung: string;
}

/** Liefert den aktuellen Referenzstatus eines Dokuments, oder `null`, wenn keiner der sechs
 *  Zustände zutrifft (Normalfall: Quelle unverändert vorhanden). */
export function referenzstatusVon(doc: Doc | undefined): ReferenzstatusInfo | null {
  if (!doc) return null;
  if (doc.sourceGone === true) {
    return {
      kind: 'gone',
      kurz: 'In j-lawyer gelöscht',
      erklaerung: 'Ihre Annotationen bleiben erhalten. Inhalt ggf. nicht mehr abrufbar.',
    };
  }
  if (doc.sourceAccessDenied === true) {
    return {
      kind: 'entzogen',
      kurz: 'Zugriff entzogen',
      erklaerung: 'Zugriff entzogen. Ihre Annotationen bleiben sichtbar, der Originalinhalt ist derzeit nicht einsehbar.',
    };
  }
  if (doc.sourceNotReachable === true) {
    return {
      kind: 'nichtErreichbar',
      kurz: 'Nicht erreichbar',
      erklaerung: 'Quelle derzeit nicht erreichbar. Ihre Annotationen bleiben erhalten.',
    };
  }
  if (doc.sourceReplacedAt !== undefined) {
    const datum = new Date(doc.sourceReplacedAt).toLocaleDateString('de-DE');
    return { kind: 'neueFassung', kurz: 'Neue Fassung', erklaerung: `In j-lawyer aktualisiert am ${datum}` };
  }
  if (doc.sourceRenamedAt !== undefined) {
    return {
      kind: 'umbenannt',
      kurz: 'Umbenannt',
      erklaerung: 'In j-lawyer umbenannt. Der Inhalt ist unverändert, Ihre Annotationen bleiben gültig.',
    };
  }
  if (doc.sourceArchived === true) {
    return {
      kind: 'archiviert',
      kurz: 'Archiviert',
      erklaerung: 'Die Akte wurde in j-lawyer archiviert. Ihre Annotationen bleiben unverändert gültig.',
    };
  }
  return null;
}
