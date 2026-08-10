import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Wächtertest (SESS-01, 11-04-PLAN.md Task 1): quelltextbasiert statt komponentenbasiert, weil
 * Vitest hier mit `environment: 'node'` läuft — kein DOM, keine mount()-Fähigkeit für eine
 * Svelte-Komponente in diesem Projekt. Die Vollständigkeit der Sperr-Verdrahtung über sieben
 * Kartendateien ist damit nur so automatisiert prüfbar, und genau diese Vollständigkeit ist der
 * eigentliche Regressionsschutz: fehlt einer Kartenart der Sperr-Zweig, bleibt sie im Termin
 * ziehbar — genau das Risiko, gegen das SESS-01 schützt (T-11-11).
 *
 * Kommt eine neue, ziehbare Kartenart hinzu, MUSS sie hier in KARTEN_DATEIEN ergänzt werden —
 * sonst prüft dieser Test die Vollständigkeit nur noch scheinbar.
 */
const KOMPONENTEN_VERZEICHNIS = fileURLToPath(new URL('./components/', import.meta.url));

const KARTEN_DATEIEN = [
  'DocCard.svelte',
  'StackCard.svelte',
  'NoteCard.svelte',
  'CutoutCard.svelte',
  'LegalObjectCard.svelte',
  'TableCard.svelte',
  'ZeitleisteCard.svelte',
] as const;

function lies(datei: string): string {
  return readFileSync(`${KOMPONENTEN_VERZEICHNIS}${datei}`, 'utf8');
}

describe('Waechtertest: Verschiebe-Sperre in jeder Kartenart verdrahtet (SESS-01)', () => {
  it.each(KARTEN_DATEIEN)('%s importiert kartenBewegungGesperrt aus ../sitzungsmodus', (datei) => {
    const quelle = lies(datei);
    expect(quelle).toContain("from '../sitzungsmodus'");
    expect(quelle).toContain('kartenBewegungGesperrt');
  });

  it.each(KARTEN_DATEIEN)('%s leitet dragGesperrt aus taped UND kartenBewegungGesperrt() ab', (datei) => {
    const quelle = lies(datei);
    expect(quelle).toContain('dragGesperrt');
    expect(quelle).toContain('taped');
    // Die Ableitung muss BEIDE Bedingungen im selben Ausdruck verknüpfen — sonst wäre entweder
    // das Klebeband oder die Sitzungssperre folgenlos.
    expect(quelle).toMatch(/dragGesperrt\s*=\s*\$derived\([^)]*taped[^)]*kartenBewegungGesperrt\(\)[^)]*\)/);
  });

  it.each(KARTEN_DATEIEN)('%s verzweigt im Zeigerdruck-Handler auf dragGesperrt statt allein auf taped', (datei) => {
    const quelle = lies(datei);
    expect(quelle).toContain('if (dragGesperrt) {');
    // Kein Zweig darf mehr allein auf `if (taped) {` verzweigen — sonst hätte dragGesperrt keine
    // Wirkung, obwohl die abgeleitete Variable existiert (Alibi-Ableitung).
    expect(quelle).not.toContain('if (taped) {');
  });

  it.each(KARTEN_DATEIEN)('%s zeichnet das Klebeband-Bildelement weiterhin ausschliesslich bei taped', (datei) => {
    const quelle = lies(datei);
    expect(quelle).toContain('{#if taped}<div class="tape"');
  });

  it('TableCard.svelte stellt BEIDE Zeigerdruck-Zweige um (Kartenkörper und Kopfzeile)', () => {
    // Task 3: die Tabellenkarte hat zwei Zieh-Einstiegspunkte (Körper + Kopfzeile der geöffneten
    // Ansicht) — beide müssen auf dragGesperrt verzweigen, sonst bliebe die geöffnete
    // Tabellenkarte an ihrer Kopfzeile weiterhin ziehbar.
    const quelle = lies('TableCard.svelte');
    const treffer = quelle.match(/if \(dragGesperrt\) \{/g) ?? [];
    expect(treffer.length).toBeGreaterThanOrEqual(2);
  });
});
