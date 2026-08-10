import { describe, expect, it } from 'vitest';
import { findeZitat, normalisiere, zitatAufloesbar } from './quelle';

/**
 * Referenzdatensatz-Kanten aus 12-AI-SPEC.md Section 5 (Edge Cases): Umbruch,
 * Bindestrich-Trennung, OCR-Artefakt, Mehrfachvorkommen. Die Verifikation ist bewusst
 * exakt (nach Normalisierung) — ein OCR-verrauschtes Zitat, das danach nicht matcht,
 * wird abgelehnt statt durchgewunken; die Zitat-Ablehnungsquote kalibriert später die
 * Normalisierung, niemals die Prüfung (A5 aus 12-RESEARCH.md).
 */

describe('normalisiere', () => {
  it('kollabiert Mehrfach-Leerzeichen, Tabs und Zeilenumbrüche zu je einem Leerzeichen und kleinschreibt', () => {
    expect(normalisiere('Der  Anspruch\tist\nverjährt.')).toBe('der anspruch ist verjährt.');
    expect(normalisiere('  Erste   Zeile\r\nZweite\tZeile  ')).toBe('erste zeile zweite zeile');
  });

  it('löst Bindestrich-Trennung auf: „Infor-\nmation" und „Information" normalisieren gleich', () => {
    expect(normalisiere('Infor-\nmation')).toBe('information');
    expect(normalisiere('Infor-\nmation')).toBe(normalisiere('Information'));
    // Mit Folge-Einrückung nach dem Umbruch (PDF-Satzspiegel).
    expect(normalisiere('ver-\n  jährung')).toBe('verjährung');
  });

  it('löst Soft-Hyphen-Trennung (U+00AD) am Zeilenende auf', () => {
    expect(normalisiere('Infor­\nmation')).toBe('information');
    expect(normalisiere('Infor­\nmation')).toBe(normalisiere('Information'));
  });

  it('entfernt vereinzelte Soft-Hyphens auch ohne Umbruch', () => {
    expect(normalisiere('Ver­jährung')).toBe('verjährung');
  });

  it('vereinheitlicht Unicode (NFC), damit kombinierte Zeichen wörtlich matchen', () => {
    // 'ä' als Combining Sequence (a + U+0308) vs. vorgeprägtes U+00E4.
    expect(normalisiere('verjährt')).toBe(normalisiere('verjährt'));
  });
});

describe('zitatAufloesbar', () => {
  const seitenText =
    'Die Klage ist unbegründet.\nDer geltend gemachte Anspruch ist verjährt.\n' +
    'Die Verjährung tritt am Ende des dritten Jahres ein.';

  it('findet ein wörtliches Zitat im Seitentext', () => {
    expect(zitatAufloesbar(seitenText, 'Der geltend gemachte Anspruch ist verjährt.')).toBe(true);
  });

  it('findet ein Zitat über Zeilenumbrüche im Seitentext hinweg', () => {
    expect(zitatAufloesbar(seitenText, 'unbegründet. Der geltend gemachte')).toBe(true);
  });

  it('findet ein Zitat, das im Original umgebrochen UND silbengetrennt ist', () => {
    const seite = 'Die Infor-\nmation ergibt sich aus dem Schreiben.';
    expect(zitatAufloesbar(seite, 'Die Information ergibt sich')).toBe(true);
  });

  it('findet ein Zitat unabhängig von Groß-/Kleinschreibung', () => {
    expect(zitatAufloesbar(seitenText, 'die klage ist unbegründet')).toBe(true);
  });

  it('liefert false für ein Zitat mit abweichendem Wortlaut (OCR-Rauschen, bewusste Strenge)', () => {
    // OCR-Fixture: „4" statt „a", „0" statt „o" — nach Normalisierung KEIN Treffer.
    const seite = 'Der Anspruch ist am 01.03.2021 entstanden.';
    expect(zitatAufloesbar(seite, 'Der 4nspruch ist am 01.03.2021 entstanden.')).toBe(false);
    expect(zitatAufloesbar(seite, 'Der Anspruch ist am O1.03.2O21 entstanden.')).toBe(false);
  });

  it('liefert false für ein leeres Zitat, ohne zu werfen', () => {
    expect(zitatAufloesbar(seitenText, '')).toBe(false);
  });

  it('liefert false für ein whitespace-only Zitat, ohne zu werfen', () => {
    expect(zitatAufloesbar(seitenText, '   \n\t  ')).toBe(false);
  });

  it('liefert true bei Mehrfachvorkommen auf derselben Seite (Mehrdeutigkeit ist kein Ablehnungsgrund)', () => {
    const seite = 'Verjährung tritt ein. […] Die Verjährung ist gewahrt.';
    expect(zitatAufloesbar(seite, 'Verjährung')).toBe(true);
  });

  it('verhält sich bei sehr kurzem Zitat (ein Wort) definiert: Treffer nur bei wörtlichem Vorkommen', () => {
    expect(zitatAufloesbar(seitenText, 'Verjährung')).toBe(true);
    expect(zitatAufloesbar(seitenText, 'Abmahnung')).toBe(false);
  });

  it('liefert false, wenn der Seitentext das Zitat schlicht nicht enthält', () => {
    expect(zitatAufloesbar(seitenText, 'Die Klage ist begründet.')).toBe(false);
  });
});

describe('findeZitat (Diagnose)', () => {
  const seite = 'Verjährung tritt ein. Die Verjährung ist gewahrt.';

  it('zählt die Vorkommen im normalisierten Text', () => {
    expect(findeZitat(seite, 'Verjährung')).toEqual({ gefunden: true, anzahl: 2 });
  });

  it('meldet gefunden=false und anzahl=0 bei Nicht-Treffer', () => {
    expect(findeZitat(seite, 'Verlust')).toEqual({ gefunden: false, anzahl: 0 });
  });

  it('meldet gefunden=false und anzahl=0 bei leerem Zitat, ohne zu werfen', () => {
    expect(findeZitat(seite, '   ')).toEqual({ gefunden: false, anzahl: 0 });
  });

  it('zählt über Normalisierungs-Kanten hinweg (Umbruch + Silbentrennung)', () => {
    expect(findeZitat('Die Infor-\nmation liegt vor.', 'Information')).toEqual({
      gefunden: true,
      anzahl: 1,
    });
  });
});
