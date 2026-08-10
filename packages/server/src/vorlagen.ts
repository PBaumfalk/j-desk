import {
  addNote, addZone, emptyState, normalisiereZonenName, uid,
  type Box, type CommandMeta, type DesktopState, type Vec2,
} from '@j-desk/core';
import type { Actor } from './deskStore';

/**
 * Fester Grundstock der Mandatsvorlagen (U5, TMPL-01, 13-07) — Server-Konstantenmodul nach dem
 * SYSTEM_EBENEN-Muster (packages/core/src/layers.ts:31-37): readonly, keine Nutzer-Eigenkreationen.
 * Vorentscheidung U5 (13-RESEARCH.md): weder j-lawyer (dessen API-Slice kennt keine
 * Vorlagen-Endpunkte) noch Datei-Konfiguration (Erweiterbarkeit um kanzlei-eigene Vorlagen ist
 * deklariertes Phase-14-/Betriebs-Thema) — ein späterer Vorlagen-Loader ersetzt additiv diese
 * Konstante, Route und Anlage bleiben unverändert.
 *
 * A3 (13-RESEARCH.md Assumptions Log): Vorlageninhalt = Zonen + einleitende Hinweis-Notizen
 * (kind 'eigen') — KEINE Vorlagen-Dokumente (gäbe leere Dateiverweise/tote Fundstellen) und keine
 * Rechts-Objekt-Vorbelegung über Hinweise hinaus.
 */
export interface MandatsVorlage {
  id: string;
  name: string;
  beschreibung: string;
  zonen: readonly { name: string; rect: Box }[];
  hinweise: readonly { text: string; position: Vec2 }[];
}

/** Öffentliche Sicht einer Vorlage (GET /api/v1/vorlagen) — id/name/beschreibung + konkrete
 *  Inhalts-Aufzählung für die VorlagenDialog-Vorschau ("Enthält: {Zonen} · {Objekttypen} ·
 *  {Beispiel-Inhalte}", UI-SPEC): der Client generiert den Aufzählungstext aus zonen/hinweise. */
export interface VorlagenUebersicht {
  id: string;
  name: string;
  beschreibung: string;
  zonen: string[];
  hinweise: string[];
}

export const MANDATS_VORLAGEN: readonly MandatsVorlage[] = [
  {
    id: 'kuendigungsschutz',
    name: 'Kündigungsschutz',
    beschreibung: 'Bereiche für Fristen, Kündigung und Sozialauswahl.',
    zonen: [
      { name: 'Fristen', rect: { x: 0, y: 0, w: 600, h: 420 } },
      { name: 'Kündigung', rect: { x: 640, y: 0, w: 600, h: 420 } },
      { name: 'Sozialauswahl', rect: { x: 0, y: 460, w: 600, h: 420 } },
    ],
    hinweise: [
      { text: 'Klagefrist § 4 KSchG prüfen: 3 Wochen nach Zugang der Kündigung.', position: { x: 20, y: 20 } },
      { text: 'Kündigungsgrund und -art erfassen (betriebs-, verhaltens- oder personenbedingt).', position: { x: 660, y: 20 } },
      { text: 'Sozialauswahl-Kriterien dokumentieren: Alter, Betriebszugehörigkeit, Unterhaltspflichten, Schwerbehinderung.', position: { x: 20, y: 480 } },
    ],
  },
  {
    id: 'strafverfahren',
    name: 'Strafverfahren',
    beschreibung: 'Bereiche für Anklage, Beweismittel und Verteidigungsstrategie.',
    zonen: [
      { name: 'Anklage', rect: { x: 0, y: 0, w: 600, h: 420 } },
      { name: 'Beweismittel', rect: { x: 640, y: 0, w: 600, h: 420 } },
      { name: 'Verteidigungsstrategie', rect: { x: 0, y: 460, w: 600, h: 420 } },
    ],
    hinweise: [
      { text: 'Anklageschrift auf Tatvorwurf, Rechtsgrundlage und Beweismittel prüfen.', position: { x: 20, y: 20 } },
      { text: 'Beweismittel nach Belastung/Entlastung sortieren, Herkunft und Verwertbarkeit vermerken.', position: { x: 660, y: 20 } },
      { text: 'Verteidigungslinie skizzieren: Einlassung, Beweisanträge, Plädoyer-Ansatzpunkte.', position: { x: 20, y: 480 } },
    ],
  },
  {
    id: 'vertragspruefung',
    name: 'Vertragsprüfung',
    beschreibung: 'Bereiche für Klauseln, Risiken und Verhandlungspunkte.',
    zonen: [
      { name: 'Klauseln', rect: { x: 0, y: 0, w: 600, h: 420 } },
      { name: 'Risiken', rect: { x: 640, y: 0, w: 600, h: 420 } },
      { name: 'Verhandlungspunkte', rect: { x: 0, y: 460, w: 600, h: 420 } },
    ],
    hinweise: [
      { text: 'Klauseln auf AGB-Kontrolle (§§ 305 ff. BGB) und Wirksamkeit prüfen.', position: { x: 20, y: 20 } },
      { text: 'Risikoklauseln markieren: Haftung, Kündigung, Wettbewerbsverbot, Vertragsstrafe.', position: { x: 660, y: 20 } },
      { text: 'Verhandlungspunkte für die Gegenseite vorbereiten, Alternativformulierungen notieren.', position: { x: 20, y: 480 } },
    ],
  },
];

/** Öffentliche Liste aller Vorlagen (GET /api/v1/vorlagen) — konkrete Inhalts-Aufzählung statt
 *  abstrakter Beschreibung (Blind-Anlagen-Verbot, UI-SPEC E11/populated). */
export function listeVorlagen(): VorlagenUebersicht[] {
  return MANDATS_VORLAGEN.map((v) => ({
    id: v.id,
    name: v.name,
    beschreibung: v.beschreibung,
    zonen: v.zonen.map((z) => z.name),
    hinweise: v.hinweise.map((h) => h.text),
  }));
}

export function findeVorlage(id: string): MandatsVorlage | undefined {
  return MANDATS_VORLAGEN.find((v) => v.id === id);
}

/** Badge-Text der aus Vorlagen instanziierten Hinweis-Notizen (kind 'eigen', NOTE_BADGE_MAX = 24). */
const HINWEIS_BADGE = 'Hinweis';

/**
 * Baut den initialen Desk-State aus einer Vorlage (createDesk-Variante, T-02-06-Präzedenz):
 * Zonen und Hinweis-Notizen werden je Anlage FRISCH instanziiert (eigene uid()s) — zwei Anlagen
 * aus derselben Vorlage teilen keine Objekt-ids (T-13-07-02). Zonen-Namen laufen durch den
 * 13-02-Feldvertrag (normalisiereZonenName), damit spätere renameZone/removeZone-Operationen
 * greifen. Provenienz kommt vom anlegenden Nutzer (actor), nicht aus der Vorlage.
 */
export function initialerStateAusVorlage(vorlage: MandatsVorlage, actor?: Actor): DesktopState {
  const jetzt = new Date().toISOString();
  const meta: CommandMeta | undefined = actor
    ? { createdBy: actor.name, createdAt: jetzt, ...(actor.id ? { createdById: actor.id } : {}) }
    : undefined;
  let state = emptyState();
  for (const zone of vorlage.zonen) {
    state = addZone(state, normalisiereZonenName(zone.name), zone.rect, uid(), meta);
  }
  for (const hinweis of vorlage.hinweise) {
    state = addNote(state, 'eigen', hinweis.text, hinweis.position, uid(), HINWEIS_BADGE, meta);
  }
  return state;
}
