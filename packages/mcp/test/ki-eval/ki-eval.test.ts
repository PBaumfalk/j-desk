import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestSetup, type TestSetup } from '../../src/testServer';
import { fahreFall, ladeFaelle, maskiereDokumentId, type EvalFall, type EvalErgebnis } from './harness';

/**
 * ki-eval — Referenzdatensatz-Suite über die echte MCP-Protokollfläche (Plan 12-09,
 * AI-SPEC Section 5). Zweck: die drei Release-Blocker-Dimensionen der AI-SPEC werden hier
 * zu einem in JEDEM Standard-Testlauf mitlaufenden Beweis statt einer einmaligen Behauptung:
 *   Dimension 1 (Gate-Integrität):      AA-1 (kein Genehmigungs-Tool), AA-2/AA-3 (Strenge/Replay)
 *   Dimension 2 (harte Fundstellentreue): KP-1..5, EC-1..4, FM-1..3, FM-6
 *   Dimension 6 (Vertraulichkeit):      FM-4/FM-5 (mandat_fremd, generisch + identisch)
 * Jeder Fall fährt über einen echten MCP-Client (StreamableHTTP) gegen den Test-Server —
 * kein Mock der Vertrauensgrenze (Batch-Ausnahme dokumentiert in harness.ts).
 *
 * FLYWHEEL-REGEL: jeder neue reale Fehler aus der Produktivnutzung wird als zusätzlicher
 * Fall in diese Dateien aufgenommen — ANONYMISIERT (Fixture-Texte sind synthetische
 * Kanzlei-Fiktion: Klägerin Berger / Beklagter Sommer; niemals echte Mandantsdaten im Repo).
 *
 * GRENZE: die Suite prüft die HARTE Hälfte der Fundstellentreue (steht das Zitat wörtlich
 * auf der genannten Seite?). Die WEICHE Hälfte — TRÄGT das Zitat die Behauptung fachlich? —
 * ist AI-SPEC Dimension 3 und bleibt bewusst menschliche Prüfung (12-UAT.md U2).
 */

let ts: TestSetup;
beforeAll(async () => {
  ts = await startTestSetup();
});
afterAll(async () => {
  await ts.stop();
});

const gruppen = ladeFaelle();
const alleFaelle = gruppen.flatMap((g) => g.faelle);

/** Erwartungsvergleich — ein FAIL hier ist ein Produktionsbefund an der Vertrauensgrenze. */
function pruefeErwartung(fall: EvalFall, erg: EvalErgebnis): void {
  expect(erg.ausgang, `${fall.id}: Ausgang`).toBe(fall.erwartung.ausgang);
  if (fall.erwartung.grund !== undefined) {
    expect(erg.grund, `${fall.id}: grund`).toBe(fall.erwartung.grund);
  }
  if (fall.erwartung.ausgang === 'akzeptieren') {
    expect(erg.vorschlagId, `${fall.id}: vorschlagId`).toBeTruthy();
    expect(erg.registerZeilen, `${fall.id}: genau eine Registerzeile`).toBe(1);
  }
  if (fall.erwartung.ausgang === 'ablehnen') {
    expect(erg.registerZeilen, `${fall.id}: Ablehnung ist persistenzfrei`).toBe(0);
  }
}

describe('Referenzdatensatz: Komposition und Labeling', () => {
  it('umfasst exakt 18 Fälle in der AI-SPEC-Komposition 5/4/6/3 mit eindeutigen ids', () => {
    expect(gruppen.map((g) => [g.datei, g.faelle.length])).toEqual([
      ['kritische-pfade', 5],
      ['edge-cases', 4],
      ['failure-modes', 6],
      ['adversarial', 3],
    ]);
    expect(alleFaelle).toHaveLength(18);
    expect(new Set(alleFaelle.map((f) => f.id)).size).toBe(18);
  });

  it('jeder Fall trägt ein Label (erwarteter Ausgang; ablehnen-Fälle zusätzlich einen grund)', () => {
    for (const fall of alleFaelle) {
      expect(['akzeptieren', 'ablehnen', 'kein_tool'], fall.id).toContain(fall.erwartung.ausgang);
      if (fall.erwartung.ausgang === 'ablehnen') {
        expect(fall.erwartung.grund, `${fall.id}: ablehnen ohne grund`).toBeTruthy();
      }
    }
  });
});

describe('Referenzdatensatz: Ausführung über die echte Vertrauensgrenze', () => {
  const rohAntworten = new Map<string, unknown>();

  it.each(alleFaelle)('$id ($beschreibung)', async (fall) => {
    const erg = await fahreFall(ts, fall);
    pruefeErwartung(fall, erg);
    if (fall.erwartung.identischMit !== undefined) {
      const referenz = rohAntworten.get(fall.erwartung.identischMit);
      expect(referenz, `${fall.id}: Vergleichsfall ${fall.erwartung.identischMit} lief noch nicht`).toBeDefined();
      // Vertraulichkeits-Assertion (T-12-02-01/T-12-03-05): fremdmandatig und privat-
      // unsichtbar erzeugen BYTE-identische generische Antworten — dokumentId ist das
      // bewusste Eingabe-Echo (Retry-Kanal) und wird maskiert verglichen.
      expect(maskiereDokumentId(erg.rohAntwort)).toBe(maskiereDokumentId(referenz));
    }
    rohAntworten.set(fall.id, erg.rohAntwort);
  });
});

describe('Zähne der Suite (Mutations-Meta-Test, T-12-09-02)', () => {
  it('ein korrumpiertes Zitat eines akzeptieren-Falls MUSS die Suite rot machen', async () => {
    // KP-2 ist ein sauberer akzeptieren-Fall; mutiert man das Zitat zur Laufzeit, darf der
    // Fall sein Label NICHT mehr erfüllen — sonst wäre die Suite tautologisch grün.
    const original = alleFaelle.find((f) => f.id === 'KP-2')!;
    const mutiert: EvalFall = JSON.parse(JSON.stringify(original)) as EvalFall;
    (mutiert.argumente.quelle as { zitat: string }).zitat += ' (korrumpiert)';

    const erg = await fahreFall(ts, mutiert);
    // Der Negativ-Nachweis: der mutierte Fall erfüllt sein ursprüngliches Label NICHT …
    expect(erg.ausgang).not.toBe(original.erwartung.ausgang);
    // … und zwar aus dem richtigen Grund: die harte Fundstellentreue greift.
    expect(erg.ausgang).toBe('ablehnen');
    expect(erg.grund).toBe('zitat_nicht_auflösbar');
    expect(erg.registerZeilen).toBe(0);
  });
});
