import { provenienz, type DesktopState, type CommandMeta } from './model';
import type { Box } from './viewport';
import { uid } from './uid';

/**
 * Zonen (UX-03, 13-02, Vorentscheidung U4): benannte, synchronisierte Orientierungsbereiche
 * auf dem Schreibtisch — Palette-Sprünge, Minimap-Outlines und Labels sind für ALLE
 * Desk-Mitglieder identisch (geteilte Orientierung, keine Privatansicht).
 *
 * Die Zone trägt BEWUSST KEIN layerId-Feld und KEINE Objekt-Referenzen (kein Mitglieder-
 * Array): das dokumentierte Projektions-Leck aus src/lib/views.ts:6-13 (Ebenen-ids als
 * Objektdaten verraten private Strukturen) greift nur, wenn ein Objekt Ebenen-ids speichert.
 * Zone = Name + Rechteck + Provenienz, sonst nichts — die Projektion hat nichts zu filtern,
 * Zonenamen verraten keine privaten Strukturen (T-13-02-01). Die Namen sind Freitext und
 * werden serverseitig normalisiert (Trim + NFC + 40, T-13-02-06).
 *
 * Zonen stehen in VERSIONIERTE_ARTEN (Planner-Entscheidung 13-02): nur so lösen findeObjekt,
 * die Journal-CR-03-Projektion und die Offline-Dublettenerkennung (istBereitsAngewendet über
 * erzeugendeCommandTypen) Zonen auf. updatedRev/updatedAt/updatedBy kommen dadurch als
 * Stempel-Nebenprodukt hinzu — Konflikterkennung ist möglich, aber nicht eingeführt.
 */

export interface Zone {
  id: string;
  name: string;         // normalisiert (Trim + NFC + ≤ ZONEN_NAME_MAX), serverseitig erzwungen
  rect: Box;            // Weltkoordinaten des erfassten Ausschnitts bei Anlage
  createdBy?: string;   // Provenienz: wer hat die Zone erzeugt; fehlt in Alt-States
  createdById?: string; // Provenienz: stabile users.id des Erzeugers (WR-05); fehlt in Alt-States
  createdAt?: string;   // Provenienz: wann, ISO-Zeitpunkt; fehlt in Alt-States
  updatedRev?: number;  // Konflikterkennung (Stempel-Nebenprodukt der VERSIONIERTE_ARTEN-Mitgliedschaft)
  updatedAt?: string;   // Provenienz: wann zuletzt geändert, ISO-Zeitpunkt; fehlt in Alt-States
  updatedBy?: string;   // Provenienz: wer zuletzt geändert hat; fehlt in Alt-States
}

/** Namens-Höchstlänge in UTF-16-Codeeinheiten — deckungsgleich mit ANSICHT_NAME_MAX (views.ts). */
export const ZONEN_NAME_MAX = 40;

/**
 * Trim + Unicode-Normalisierung NFC, gekürzt auf ZONEN_NAME_MAX UTF-16-Codeeinheiten —
 * wortgleich zu `normalisiereName` aus src/lib/views.ts:43-45, aber bewusst IM CORE dupliziert:
 * der Core darf keinen Client-Code importieren (Schichtregel des Monorepos), und die
 * Normalisierung muss serverseitig greifen, weil der Zonenname über den Kommandopfad auch
 * von MCP- und Offline-Queue-Clients kommen kann.
 */
export function normalisiereZonenName(name: string): string {
  return name.trim().normalize('NFC').slice(0, ZONEN_NAME_MAX);
}

/**
 * Legt eine Zone an (immutable, Spread-Muster des Bestands). `name` wird hier NICHT erneut
 * normalisiert — die Normalisierung ist Kommandopfad-Pflicht (commands.ts zonesName), damit
 * die Trennung Payload-Validierung vs. Domänenlogik erhalten bleibt; direkte Aufrufer
 * (Tests, Vorlagen in 13-07) übergeben bereits normalisierte Namen.
 */
export function addZone(
  s: DesktopState,
  name: string,
  rect: Box,
  id: string = uid(),
  meta?: CommandMeta,
): DesktopState {
  const zone: Zone = { id, name, rect, ...provenienz(meta) };
  return { ...s, zones: [...(s.zones ?? []), zone] };
}

function mapZone(s: DesktopState, id: string, fn: (z: Zone) => Zone): DesktopState {
  const zones = s.zones ?? [];
  if (!zones.some((z) => z.id === id)) throw new Error(`Zone "${id}" nicht gefunden`);
  return { ...s, zones: zones.map((z) => (z.id === id ? fn(z) : z)) };
}

export function renameZone(s: DesktopState, id: string, name: string): DesktopState {
  return mapZone(s, id, (z) => ({ ...z, name }));
}

/**
 * Entfernt die Zone direkt — bewusst KEIN Papierkorb-Weg (trash.ts): Zonen haben keine
 * Objekt-Mitgliedschaft, es gibt nichts mitzulöschen; die Anlage ist durch Neuanlage mit
 * derselben id jederzeit reversibel (Muster „Löschen einer Ansicht"). Keine Kaskade:
 * der übrige State bleibt referenzidentisch.
 */
export function removeZone(s: DesktopState, id: string): DesktopState {
  const zones = s.zones ?? [];
  if (!zones.some((z) => z.id === id)) throw new Error(`Zone "${id}" nicht gefunden`);
  return { ...s, zones: zones.filter((z) => z.id !== id) };
}

export function findZone(s: DesktopState, id: string): Zone | undefined {
  return (s.zones ?? []).find((z) => z.id === id);
}
