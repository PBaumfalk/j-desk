/** Feste Rolle eines Nutzers an einem Schreibtisch. Wörtlich PERM-03 — keine Eigenkreationen. */
export type Rolle = 'Eigentümer' | 'Bearbeiter' | 'Kommentator' | 'Nur-Lesen' | 'externer Gast';
export const ALLE_ROLLEN: readonly Rolle[] = ['Eigentümer', 'Bearbeiter', 'Kommentator', 'Nur-Lesen', 'externer Gast'];

/**
 * Gefährliche Aktion (PERM-04): endgültiges Löschen/Schreddern, Export/.jdesk-Download,
 * Upload in die Akte, Rollen-/Ebenenverwaltung.
 *
 * WR-04 (02-REVIEW): eine frühere 'mcp'-Aktion (KI-Verarbeitung nur Eigentümer) wurde
 * entfernt — kein Guard und kein MCP-seitiger Mechanismus hat sie je durchgesetzt (MCP
 * läuft über die normalen REST-Routen mit dem Nutzer-Token), der Matrix-Eintrag suggerierte
 * also eine Schutzwirkung, die nicht existierte. MCP-Zugriff unterliegt denselben
 * REST-Rollenprüfungen wie Browser-Zugriff; eine darüber hinausgehende MCP-spezifische
 * Schranke bräuchte einen eigenen Token-Typ und ist Phase-3+-Thema.
 */
export type GefahrlicheAktion = 'delete' | 'shred' | 'export' | 'upload' | 'manage';

/**
 * Fail-closed Rechte-Matrix (PERM-04): unbekannte Rolle oder unbekannte Aktion liefert
 * nie `true`. Bewusst eine feste Lookup-Tabelle statt einer Policy-Engine/DSL (Research
 * „Don't Hand-Roll") — die fünf Rollen und fünf Aktionen dieser Phase sind abschließend.
 */
const MATRIX: Readonly<Record<Rolle, ReadonlySet<GefahrlicheAktion>>> = {
  'Eigentümer': new Set(['delete', 'shred', 'export', 'upload', 'manage']),
  'Bearbeiter': new Set(['export', 'upload', 'manage']),
  'Kommentator': new Set([]),
  'Nur-Lesen': new Set([]),
  'externer Gast': new Set([]),
};

export function darfAktion(rolle: Rolle, aktion: GefahrlicheAktion): boolean {
  return MATRIX[rolle]?.has(aktion) ?? false;
}
