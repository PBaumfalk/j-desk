import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DIFF_MAX_WOERTER } from '@j-desk/core';
import { markierungenAus, vergleicheSeite, seiteEingabeFuer, type SeiteEingabe, type SeiteEingabeQuellen } from './vergleichSeite';
import type { Rect, WortMitPosition } from './pdfText';

/** Baut eine Wortliste mit Position aus einfachen Wörtern — je Wort ein 10px breites Rechteck,
 *  nebeneinander in einer Zeile (Index * 10 als x), damit Rechtecke eindeutig zuordenbar bleiben. */
function positionen(woerter: string[]): SeiteEingabe {
  return {
    art: 'positionen',
    woerter: woerter.map((text, i): WortMitPosition => ({ text, rect: { x: i * 10, y: 0, w: 8, h: 12 } })),
  };
}

function text(t: string): SeiteEingabe {
  return { art: 'text', text: t };
}

const KEIN_TEXT: SeiteEingabe = { art: 'kein-text' };
const GESCHWAERZT: SeiteEingabe = { art: 'geschwaerzt' };

describe('vergleicheSeite — markiert (beide Seiten mit Positionen)', () => {
  it('erzeugt Markierungsrechtecke für entfernte Wörter links und hinzugefügte Wörter rechts', () => {
    const alt = positionen(['a', 'b', 'X', 'd']);
    const neu = positionen(['a', 'b', 'Y', 'd']);
    const ergebnis = vergleicheSeite(alt, neu);
    expect(ergebnis.art).toBe('markiert');
    if (ergebnis.art !== 'markiert') throw new Error('unreachable');
    expect(ergebnis.entferntRects).toEqual([{ x: 20, y: 0, w: 8, h: 12 }]); // 'X', Index 2 in alt
    expect(ergebnis.hinzugefuegtRects).toEqual([{ x: 20, y: 0, w: 8, h: 12 }]); // 'Y', Index 2 in neu
  });

  it('unveränderte Wörter erzeugen kein Rechteck', () => {
    const alt = positionen(['a', 'b', 'c']);
    const neu = positionen(['a', 'b', 'c']);
    const ergebnis = vergleicheSeite(alt, neu);
    expect(ergebnis.art).toBe('markiert');
    if (ergebnis.art !== 'markiert') throw new Error('unreachable');
    expect(ergebnis.entferntRects).toEqual([]);
    expect(ergebnis.hinzugefuegtRects).toEqual([]);
    expect(ergebnis.entferntAnzahl).toBe(0);
    expect(ergebnis.hinzugefuegtAnzahl).toBe(0);
  });

  it('jedes Rechteck trägt die Basiskoordinaten seines Wortes unverändert — keine Skalierung findet statt', () => {
    const altWoerter: WortMitPosition[] = [
      { text: 'gelöscht', rect: { x: 123.5, y: 44.25, w: 30, h: 11 } },
    ];
    const neuWoerter: WortMitPosition[] = [
      { text: 'neu', rect: { x: 5, y: 200, w: 12, h: 11 } },
    ];
    const ergebnis = vergleicheSeite({ art: 'positionen', woerter: altWoerter }, { art: 'positionen', woerter: neuWoerter });
    expect(ergebnis.art).toBe('markiert');
    if (ergebnis.art !== 'markiert') throw new Error('unreachable');
    expect(ergebnis.entferntRects).toEqual([altWoerter[0].rect]);
    expect(ergebnis.hinzugefuegtRects).toEqual([neuWoerter[0].rect]);
  });

  it('die Zählungen entsprechen der Anzahl der entfernten und hinzugefügten Vergleichsschritte', () => {
    const alt = positionen(['a', 'b', 'c', 'd', 'e']);
    const neu = positionen(['a', 'x', 'y', 'd', 'z']);
    const ergebnis = vergleicheSeite(alt, neu);
    expect(ergebnis.art).toBe('markiert');
    if (ergebnis.art !== 'markiert') throw new Error('unreachable');
    expect(ergebnis.entferntAnzahl).toBe(ergebnis.entferntRects.length);
    expect(ergebnis.hinzugefuegtAnzahl).toBe(ergebnis.hinzugefuegtRects.length);
    expect(ergebnis.entferntAnzahl).toBeGreaterThan(0);
    expect(ergebnis.hinzugefuegtAnzahl).toBeGreaterThan(0);
  });
});

describe('vergleicheSeite — ohne Stellenmarkierung', () => {
  it('ein Wort ohne Position (eine Seite liefert nur Text) erzeugt kein Rechteck und wird stattdessen nur gezählt', () => {
    const alt = positionen(['Vertrag', 'über', 'Kauf']);
    const neu = text('Vertrag über Miete');
    const ergebnis = vergleicheSeite(alt, neu);
    expect(ergebnis.art).toBe('ohne-stellen');
    if (ergebnis.art !== 'ohne-stellen') throw new Error('unreachable');
    expect(ergebnis.entferntAnzahl).toBeGreaterThan(0);
    expect(ergebnis.hinzugefuegtAnzahl).toBeGreaterThan(0);
    // Keine Rechteckfelder in dieser Variante — TypeScript würde einen Zugriff bereits ablehnen,
    // die Laufzeitprüfung bestätigt zusätzlich, dass keins existiert.
    expect('entferntRects' in ergebnis).toBe(false);
  });

  it('beide Fassungen ohne Positionen erzeugen ein Ergebnis mit der Kennzeichnung "ohne Stellenmarkierung" und den beiden Zählungen', () => {
    const ergebnis = vergleicheSeite(text('Vertrag über Kauf'), text('Vertrag über Miete'));
    expect(ergebnis).toEqual({ art: 'ohne-stellen', entferntAnzahl: 1, hinzugefuegtAnzahl: 1 });
  });

  it('die Zählungen entsprechen der Anzahl der entfernten und hinzugefügten Vergleichsschritte (Text-Fall)', () => {
    const ergebnis = vergleicheSeite(text('a b c d'), text('a x y d'));
    expect(ergebnis.art).toBe('ohne-stellen');
    if (ergebnis.art !== 'ohne-stellen') throw new Error('unreachable');
    expect(ergebnis.entferntAnzahl).toBe(2);
    expect(ergebnis.hinzugefuegtAnzahl).toBe(2);
  });
});

describe('vergleicheSeite — kein Text', () => {
  it('fehlt der alten Fassung jeder Text, trägt das Ergebnis "kein-text" mit spalte "links"; die andere Spalte bleibt unberührt', () => {
    expect(vergleicheSeite(KEIN_TEXT, text('vorhanden'))).toEqual({ art: 'kein-text', spalte: 'links' });
  });

  it('fehlt der neuen Fassung jeder Text, trägt das Ergebnis "kein-text" mit spalte "rechts"', () => {
    expect(vergleicheSeite(positionen(['vorhanden']), KEIN_TEXT)).toEqual({ art: 'kein-text', spalte: 'rechts' });
  });

  it('fehlt beiden Fassungen jeder Text, trägt das Ergebnis "kein-text" mit spalte "beide"', () => {
    expect(vergleicheSeite(KEIN_TEXT, KEIN_TEXT)).toEqual({ art: 'kein-text', spalte: 'beide' });
  });
});

describe('vergleicheSeite — geschwärzt (CR-01)', () => {
  // CR-01: 'geschwaerzt' entsteht NIE aus einem Rückfall auf unfilterten Server-Text — die
  // Aufrufseite (VergleichsViewer.svelte) darf diese Eingabeart ausschließlich liefern, wenn
  // `seitenWoerter()`s `hatteRohtext` wahr war. Hier wird nur die reine Vergleichslogik geprüft:
  // 'geschwaerzt' bleibt von 'kein-text' unterschieden und niemals als 'ohne-stellen'/'markiert'
  // mit den (nicht vorhandenen) Wörtern der anderen Seite verrechnet.
  it('ist die alte Fassung vollständig geschwärzt, trägt das Ergebnis "geschwaerzt" mit spalte "links" — nicht "kein-text"', () => {
    expect(vergleicheSeite(GESCHWAERZT, text('vorhanden'))).toEqual({ art: 'geschwaerzt', spalte: 'links' });
  });

  it('ist die neue Fassung vollständig geschwärzt, trägt das Ergebnis "geschwaerzt" mit spalte "rechts"', () => {
    expect(vergleicheSeite(positionen(['vorhanden']), GESCHWAERZT)).toEqual({ art: 'geschwaerzt', spalte: 'rechts' });
  });

  it('sind beide Fassungen vollständig geschwärzt, trägt das Ergebnis "geschwaerzt" mit spalte "beide"', () => {
    expect(vergleicheSeite(GESCHWAERZT, GESCHWAERZT)).toEqual({ art: 'geschwaerzt', spalte: 'beide' });
  });

  it('ist eine Seite geschwärzt und die andere ganz ohne Text, hat die Schwärzungs-Meldung Vorrang vor "kein-text"', () => {
    expect(vergleicheSeite(GESCHWAERZT, KEIN_TEXT)).toEqual({ art: 'geschwaerzt', spalte: 'beide' });
    expect(vergleicheSeite(KEIN_TEXT, GESCHWAERZT)).toEqual({ art: 'geschwaerzt', spalte: 'beide' });
  });
});

describe('seiteEingabeFuer — CR-01 (Iteration 2, Rückfall-Entscheidung)', () => {
  const ECHTE_SCHWAERZUNG: Rect[] = [{ x: 0, y: 0, w: 10, h: 10 }];
  const KEINE_SCHWAERZUNG: Rect[] = [];

  function quellen(overrides: Partial<SeiteEingabeQuellen>): SeiteEingabeQuellen {
    return {
      bytesFor: vi.fn().mockResolvedValue(new Uint8Array([1])),
      seitenWoerter: vi.fn().mockResolvedValue({ woerter: [], hatteRohtext: false }),
      erkannterTextFuer: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  it('liefert "positionen", wenn die Extraktion Wörter findet', async () => {
    const woerter: WortMitPosition[] = [{ text: 'a', rect: { x: 0, y: 0, w: 8, h: 12 } }];
    const q = quellen({ seitenWoerter: vi.fn().mockResolvedValue({ woerter, hatteRohtext: true }) });
    const ergebnis = await seiteEingabeFuer(1, ECHTE_SCHWAERZUNG, q);
    expect(ergebnis).toEqual({ art: 'positionen', woerter });
    expect(q.erkannterTextFuer).not.toHaveBeenCalled();
  });

  it('liefert "geschwaerzt", wenn die Extraktion gelingt, aber hatteRohtext positiv meldet (Iteration 1, Regressionsschutz)', async () => {
    const q = quellen({ seitenWoerter: vi.fn().mockResolvedValue({ woerter: [], hatteRohtext: true }) });
    const ergebnis = await seiteEingabeFuer(1, ECHTE_SCHWAERZUNG, q);
    expect(ergebnis).toEqual({ art: 'geschwaerzt' });
    expect(q.erkannterTextFuer).not.toHaveBeenCalled();
  });

  it('CR-01-residual (a): bytesFor() schlägt fehl UND die Seite trägt eine echte Schwärzung — der unfilterte Server-Rückfall (erkannterTextFuer) darf NICHT laufen, Ergebnis ist "geschwaerzt"', async () => {
    const q = quellen({ bytesFor: vi.fn().mockRejectedValue(new Error('PreviewError: Zeitüberschreitung')) });
    const ergebnis = await seiteEingabeFuer(3, ECHTE_SCHWAERZUNG, q);
    expect(ergebnis).toEqual({ art: 'geschwaerzt' });
    expect(q.seitenWoerter).not.toHaveBeenCalled();
    expect(q.erkannterTextFuer).not.toHaveBeenCalled();
  });

  it('CR-01-residual (b): die Extraktion schlägt intern fehl (seitenWoerter() liefert bei internem pdf.js-Fehler ambig hatteRohtext: false) UND die Seite trägt eine echte Schwärzung — der unfilterte Server-Rückfall darf NICHT laufen, Ergebnis ist "geschwaerzt"', async () => {
    // seitenWoerter() wirft laut eigenem Vertrag NIE, sondern fängt jede pdf.js-Ausnahme intern ab
    // und liefert { woerter: [], hatteRohtext: false } — exakt dieselbe Form wie "Seite hatte nie
    // Text". Der Mock simuliert genau diesen (nicht unterscheidbaren) Vertrag.
    const q = quellen({ seitenWoerter: vi.fn().mockResolvedValue({ woerter: [], hatteRohtext: false }) });
    const ergebnis = await seiteEingabeFuer(5, ECHTE_SCHWAERZUNG, q);
    expect(ergebnis).toEqual({ art: 'geschwaerzt' });
    expect(q.erkannterTextFuer).not.toHaveBeenCalled();
  });

  it('ohne echte Schwärzung auf der Seite darf der Server-Rückfall weiterhin laufen, auch wenn bytesFor() fehlschlägt', async () => {
    const q = quellen({
      bytesFor: vi.fn().mockRejectedValue(new Error('network')),
      erkannterTextFuer: vi.fn().mockResolvedValue('erkannter Text'),
    });
    const ergebnis = await seiteEingabeFuer(2, KEINE_SCHWAERZUNG, q);
    expect(ergebnis).toEqual({ art: 'text', text: 'erkannter Text' });
    expect(q.erkannterTextFuer).toHaveBeenCalledWith(2);
  });

  it('ohne echte Schwärzung und ohne jeden Text liefert die Funktion "kein-text"', async () => {
    const q = quellen({ bytesFor: vi.fn().mockRejectedValue(new Error('network')) });
    const ergebnis = await seiteEingabeFuer(2, KEINE_SCHWAERZUNG, q);
    expect(ergebnis).toEqual({ art: 'kein-text' });
  });
});

describe('vergleicheSeite — Überlänge', () => {
  it('ein Überlängeergebnis aus dem Wortvergleich wird als eigene Kennzeichnung durchgereicht, nicht als unterschiedsfrei', () => {
    const langerText = Array.from({ length: DIFF_MAX_WOERTER + 1 }, (_, i) => `wort${i}`).join(' ');
    const ergebnis = vergleicheSeite(text(langerText), text('kurz'));
    expect(ergebnis).toEqual({ art: 'zu-lang', woerterAlt: DIFF_MAX_WOERTER + 1, woerterNeu: 1 });
  });

  it('eine Überlänge auf der positionierten Seite liefert ebenfalls "zu-lang", nicht "markiert" mit leeren Rechteckfeldern', () => {
    const zuVieleWoerter = Array.from({ length: DIFF_MAX_WOERTER + 1 }, (_, i) => `wort${i}`);
    const ergebnis = vergleicheSeite(positionen(zuVieleWoerter), positionen(['kurz']));
    expect(ergebnis.art).toBe('zu-lang');
  });
});

describe('vergleicheSeite — kein Wortlaut im Ergebnis', () => {
  it('kein Zweig des Ergebnisses trägt Text als zusammenhängenden String oder Wortliste', () => {
    const ergebnisse: unknown[] = [
      vergleicheSeite(positionen(['a', 'X', 'b']), positionen(['a', 'Y', 'b'])),
      vergleicheSeite(text('a X b'), text('a Y b')),
      vergleicheSeite(KEIN_TEXT, text('a')),
    ];
    for (const e of ergebnisse) {
      for (const [feld, wert] of Object.entries(e as Record<string, unknown>)) {
        if (feld === 'art' || feld === 'spalte') continue; // begrenzte literale Kennzeichnungen, kein Wortlaut
        if (typeof wert === 'string') throw new Error(`Feld "${feld}" trägt einen String: ${wert}`);
        if (Array.isArray(wert)) {
          for (const eintrag of wert as unknown[]) {
            expect(typeof eintrag).toBe('object'); // Rect-Objekte, keine Wort-Strings
            expect(eintrag).not.toHaveProperty('text');
          }
        }
      }
    }
  });
});

describe('markierungenAus', () => {
  it('rechnet Basiskoordinaten über denselben Faktor wie SourceHighlight/MarkLayer in Darstellungspixel um', () => {
    const rects: Rect[] = [{ x: 10, y: 20, w: 5, h: 5 }];
    expect(markierungenAus(rects, 100, 200)).toEqual([{ x: 20, y: 40, w: 10, h: 10 }]);
  });

  it('liefert eine leere Liste für eine leere Rechteckliste', () => {
    expect(markierungenAus([], 100, 200)).toEqual([]);
  });
});

describe('Quellprüfung: SeitenVergleich trägt keinen Wortlaut', () => {
  const quelle = readFileSync(fileURLToPath(new URL('./vergleichSeite.ts', import.meta.url)), 'utf-8');
  const start = quelle.indexOf('export type SeitenVergleich');
  const ende = quelle.indexOf('function woerterVon');
  const typBlock = quelle.slice(start, ende);

  it('kein Feld ist als bare string oder string[] typisiert — jedes Feld ist eine Zahl, ein Rect[] oder eine begrenzte literale Kennzeichnung', () => {
    expect(typBlock).not.toMatch(/:\s*string(\[\])?/);
  });
});
