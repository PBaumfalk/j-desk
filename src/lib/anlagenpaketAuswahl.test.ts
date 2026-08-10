import { describe, expect, it } from 'vitest';
import { addDoc, changeLayerId, emptyState, trashObject, type Stack } from '@j-desk/core';
import {
  ausschlussListe, auswahlAusStapel, auswahlZeilen, benenneAuswahl, bereinigeAusschluesse,
  entferneAuswahl, ergaenzeAuswahl, kNummer, seitenSchluessel, verfuegbareDokumente,
  verschiebeAuswahl, vorbelegteAusschluesse,
  type AuswahlEintrag,
} from './anlagenpaketAuswahl';
import type { AnlagenpaketPruefung } from './api';

/**
 * Anlagenpaket-Auswahllogik (KONV-01, 10-01): reine Funktionen, kein Svelte-Kontext nötig.
 * Jede Funktion muss die Eingabe unverändert lassen (Bestandsregel des Projekts) — Tests prüfen
 * das explizit über Referenzvergleich bzw. unveränderten Inhalt der Ursprungsliste.
 */

describe('kNummer', () => {
  it('leitet die K-Nummer aus der 0-basierten Position ab', () => {
    expect(kNummer(0)).toBe('K1');
    expect(kNummer(1)).toBe('K2');
    expect(kNummer(9)).toBe('K10');
  });
});

describe('ergaenzeAuswahl', () => {
  it('hängt ein neues Dokument ans Ende an', () => {
    const auswahl: AuswahlEintrag[] = [{ docId: 'd1', bezeichnung: 'Erstes' }];
    const { auswahl: neu, ergaenzt } = ergaenzeAuswahl(auswahl, 'd2', 'Zweites');
    expect(ergaenzt).toBe(true);
    expect(neu).toEqual([{ docId: 'd1', bezeichnung: 'Erstes' }, { docId: 'd2', bezeichnung: 'Zweites' }]);
    expect(auswahl).toEqual([{ docId: 'd1', bezeichnung: 'Erstes' }]); // Eingabe unverändert
  });

  it('ist idempotent: eine bereits enthaltene docId erzeugt keinen zweiten Eintrag', () => {
    const auswahl: AuswahlEintrag[] = [{ docId: 'd1', bezeichnung: 'Erstes' }];
    const { auswahl: neu, ergaenzt } = ergaenzeAuswahl(auswahl, 'd1', 'Erstes noch mal');
    expect(ergaenzt).toBe(false);
    expect(neu).toBe(auswahl); // unveränderte Referenz
    expect(neu.length).toBe(auswahl.length);
  });
});

describe('entferneAuswahl', () => {
  it('entfernt genau den angegebenen Eintrag', () => {
    const auswahl: AuswahlEintrag[] = [
      { docId: 'd1', bezeichnung: 'Eins' },
      { docId: 'd2', bezeichnung: 'Zwei' },
    ];
    const neu = entferneAuswahl(auswahl, 'd1');
    expect(neu).toEqual([{ docId: 'd2', bezeichnung: 'Zwei' }]);
    expect(auswahl.length).toBe(2); // Eingabe unverändert
  });
});

describe('verschiebeAuswahl', () => {
  const auswahl: AuswahlEintrag[] = [
    { docId: 'd1', bezeichnung: 'Eins' },
    { docId: 'd2', bezeichnung: 'Zwei' },
    { docId: 'd3', bezeichnung: 'Drei' },
  ];

  it('tauscht mit dem Vorgänger bei Richtung -1', () => {
    const neu = verschiebeAuswahl(auswahl, 'd2', -1);
    expect(neu.map((e) => e.docId)).toEqual(['d2', 'd1', 'd3']);
  });

  it('tauscht mit dem Nachfolger bei Richtung +1', () => {
    const neu = verschiebeAuswahl(auswahl, 'd2', 1);
    expect(neu.map((e) => e.docId)).toEqual(['d1', 'd3', 'd2']);
  });

  it('lässt die Reihenfolge unverändert, wenn der erste Eintrag nach oben verschoben wird (kein Umlauf)', () => {
    const neu = verschiebeAuswahl(auswahl, 'd1', -1);
    expect(neu.map((e) => e.docId)).toEqual(['d1', 'd2', 'd3']);
  });

  it('lässt die Reihenfolge unverändert, wenn der letzte Eintrag nach unten verschoben wird (kein Umlauf)', () => {
    const neu = verschiebeAuswahl(auswahl, 'd3', 1);
    expect(neu.map((e) => e.docId)).toEqual(['d1', 'd2', 'd3']);
  });

  it('nach dem Verschieben liefert kNummer für die verschobene Zeile die neue Positionsnummer', () => {
    const neu = verschiebeAuswahl(auswahl, 'd3', -1); // d3 rückt an Position 1 (Index 1)
    const index = neu.findIndex((e) => e.docId === 'd3');
    expect(kNummer(index)).toBe('K2');
  });
});

describe('benenneAuswahl', () => {
  it('setzt die Bezeichnung des angegebenen Eintrags neu', () => {
    const auswahl: AuswahlEintrag[] = [{ docId: 'd1', bezeichnung: 'Alt' }];
    const neu = benenneAuswahl(auswahl, 'd1', 'Neu');
    expect(neu).toEqual([{ docId: 'd1', bezeichnung: 'Neu' }]);
    expect(auswahl[0].bezeichnung).toBe('Alt'); // Eingabe unverändert
  });
});

describe('verfuegbareDokumente', () => {
  it('enthält nur Dokumente mit effektiver Freigabe export, die noch nicht in der Auswahl stehen', () => {
    let s = emptyState();
    s = addDoc(s, 'file-1', 'export.pdf', { x: 0, y: 0 }, 'd-export');
    s = changeLayerId(s, 'd-export', 'exportierbar');
    s = addDoc(s, 'file-2', 'intern.pdf', { x: 0, y: 0 }, 'd-intern'); // keine Export-Ebene
    s = addDoc(s, 'file-3', 'bereits-gewaehlt.pdf', { x: 0, y: 0 }, 'd-gewaehlt');
    s = changeLayerId(s, 'd-gewaehlt', 'exportierbar');

    const auswahl: AuswahlEintrag[] = [{ docId: 'd-gewaehlt', bezeichnung: 'Schon dabei' }];
    const verfuegbar = verfuegbareDokumente(s, auswahl);

    expect(verfuegbar.map((d) => d.id)).toEqual(['d-export']);
    expect(verfuegbar.some((d) => d.id === 'd-intern')).toBe(false);
    expect(verfuegbar.some((d) => d.id === 'd-gewaehlt')).toBe(false);
  });
});

describe('auswahlZeilen', () => {
  function dreiDokumenteState(): ReturnType<typeof emptyState> {
    let s = emptyState();
    s = addDoc(s, 'file-1', 'erstes.pdf', { x: 0, y: 0 }, 'd1');
    s = changeLayerId(s, 'd1', 'exportierbar');
    s = addDoc(s, 'file-2', 'zweites.pdf', { x: 0, y: 0 }, 'd2');
    s = changeLayerId(s, 'd2', 'exportierbar');
    s = addDoc(s, 'file-3', 'drittes.pdf', { x: 0, y: 0 }, 'd3');
    s = changeLayerId(s, 'd3', 'exportierbar');
    return s;
  }

  const auswahlDreiZeilen: AuswahlEintrag[] = [
    { docId: 'd1', bezeichnung: 'Eins' },
    { docId: 'd2', bezeichnung: 'Zwei' },
    { docId: 'd3', bezeichnung: 'Drei' },
  ];

  it('nummeriert drei verfügbare Zeilen lückenlos von 1 aufwärts', () => {
    const s = dreiDokumenteState();
    const zeilen = auswahlZeilen(s, auswahlDreiZeilen);
    expect(zeilen.map((z) => z.nummer)).toEqual([1, 2, 3]);
    expect(zeilen.every((z) => z.verfuegbar)).toBe(true);
  });

  it('eine Zeile, deren Dokument nicht mehr in state.docs steht, bleibt ohne Nummer, die äußeren Zeilen springen die Lücke', () => {
    let s = dreiDokumenteState();
    s = { ...s, docs: s.docs.filter((d) => d.id !== 'd2') }; // d2 unsichtbar/entfernt, nicht im Papierkorb
    const zeilen = auswahlZeilen(s, auswahlDreiZeilen);
    expect(zeilen[0].nummer).toBe(1);
    expect(zeilen[1].verfuegbar).toBe(false);
    expect(zeilen[1].nummer).toBeUndefined();
    expect(zeilen[1].hinweis).toBe('nicht mehr verfügbar — wird beim Erzeugen ausgelassen');
    expect(zeilen[2].nummer).toBe(2);
  });

  it('eine Zeile, deren Dokument im Papierkorb liegt, trägt den Papierkorb-Hinweis, mit demselben Nummernsprung', () => {
    let s = dreiDokumenteState();
    s = trashObject(s, 'd2', '2026-08-07T00:00:00.000Z');
    const zeilen = auswahlZeilen(s, auswahlDreiZeilen);
    expect(zeilen[0].nummer).toBe(1);
    expect(zeilen[1].verfuegbar).toBe(false);
    expect(zeilen[1].nummer).toBeUndefined();
    expect(zeilen[1].hinweis).toBe('im Papierkorb — wird beim Erzeugen ausgelassen');
    expect(zeilen[2].nummer).toBe(2);
  });

  it('eine Zeile, deren Dokument die Export-Freigabe verloren hat, ist nicht verfügbar', () => {
    let s = dreiDokumenteState();
    s = changeLayerId(s, 'd2', 'kanzlei'); // keine Export-Ebene mehr
    const zeilen = auswahlZeilen(s, auswahlDreiZeilen);
    expect(zeilen[1].verfuegbar).toBe(false);
    expect(zeilen[1].nummer).toBeUndefined();
  });

  it('nach verschiebeAuswahl ändern sich die Nummern entsprechend der neuen Reihenfolge', () => {
    const s = dreiDokumenteState();
    const verschoben = verschiebeAuswahl(auswahlDreiZeilen, 'd3', -1); // d1, d3, d2
    const zeilen = auswahlZeilen(s, verschoben);
    expect(zeilen.map((z) => z.docId)).toEqual(['d1', 'd3', 'd2']);
    expect(zeilen.map((z) => z.nummer)).toEqual([1, 2, 3]);
  });

  it('verändert die übergebene Auswahl nicht', () => {
    const s = dreiDokumenteState();
    const kopie = JSON.parse(JSON.stringify(auswahlDreiZeilen));
    auswahlZeilen(s, auswahlDreiZeilen);
    expect(auswahlDreiZeilen).toEqual(kopie);
  });
});

describe('auswahlAusStapel', () => {
  function stapelState(): { s: ReturnType<typeof emptyState>; stack: Stack } {
    let s = emptyState();
    s = addDoc(s, 'file-1', 'a.pdf', { x: 0, y: 0 }, 'a');
    s = changeLayerId(s, 'a', 'exportierbar');
    s = addDoc(s, 'file-2', 'b.pdf', { x: 0, y: 0 }, 'b');
    s = changeLayerId(s, 'b', 'exportierbar');
    s = addDoc(s, 'file-3', 'c.pdf', { x: 0, y: 0 }, 'c');
    s = changeLayerId(s, 'c', 'exportierbar');
    const stack: Stack = { id: 'st1', name: '', docIds: ['a', 'b', 'c'], position: { x: 0, y: 0 }, zIndex: 0 };
    return { s, stack };
  }

  it('übernimmt die Reihenfolge von stack.docIds unverändert', () => {
    const { s, stack } = stapelState();
    const auswahl = auswahlAusStapel(s, stack);
    expect(auswahl.map((e) => e.docId)).toEqual(['a', 'b', 'c']);
  });

  it('überspringt eine verwaiste id und ein nicht freigegebenes Dokument', () => {
    let { s, stack } = stapelState();
    s = changeLayerId(s, 'b', 'kanzlei'); // nicht mehr exportierbar
    stack = { ...stack, docIds: ['a', 'b', 'verwaist', 'c'] };
    const auswahl = auswahlAusStapel(s, stack);
    expect(auswahl.map((e) => e.docId)).toEqual(['a', 'c']);
  });

  it('liefert für einen leeren Stapel eine leere Liste', () => {
    const { s, stack } = stapelState();
    const leererStapel: Stack = { ...stack, docIds: [] };
    const auswahl = auswahlAusStapel(s, leererStapel);
    expect(auswahl).toEqual([]);
  });

  it('verändert den übergebenen Stack nicht', () => {
    const { s, stack } = stapelState();
    const kopie = JSON.parse(JSON.stringify(stack));
    auswahlAusStapel(s, stack);
    expect(stack).toEqual(kopie);
  });
});

/**
 * Ankreuzungslogik für den Abschnitt „Dubletten & Leerseiten" (KONV-03, 10-05).
 */
describe('seitenSchluessel', () => {
  it('ist eindeutig und umkehrbar (docId + Seite lassen sich wieder auseinanderhalten)', () => {
    expect(seitenSchluessel('d1', 3)).toBe('d1#3');
    expect(seitenSchluessel('d1', 3)).not.toBe(seitenSchluessel('d1', 4));
    expect(seitenSchluessel('d1', 3)).not.toBe(seitenSchluessel('d2', 3));
  });
});

function pruefungMitZweiDublettenDreiLeerseiten(): AnlagenpaketPruefung {
  return {
    dubletten: [
      { docId: 'd1', lokaleSeite: 2, gleichWieDocId: 'd1', gleichWieLokaleSeite: 1 },
      { docId: 'd3', lokaleSeite: 1, gleichWieDocId: 'd2', gleichWieLokaleSeite: 1 },
    ],
    leerseiten: [
      { docId: 'd1', lokaleSeite: 3 },
      { docId: 'd2', lokaleSeite: 2 },
      { docId: 'd3', lokaleSeite: 2 },
    ],
    unbeurteilbar: [],
    seitenGesamt: 8,
    ausgelassen: 0,
  };
}

describe('vorbelegteAusschluesse', () => {
  it('liefert für ein Ergebnis mit zwei Dubletten und drei Leerseiten genau zwei Schlüssel', () => {
    const pruefung = pruefungMitZweiDublettenDreiLeerseiten();
    const ausschluesse = vorbelegteAusschluesse(pruefung);
    expect(ausschluesse.size).toBe(2);
  });

  it('enthält je Dublette den Schlüssel der zweiten Fundstelle, nie den der ersten', () => {
    const pruefung = pruefungMitZweiDublettenDreiLeerseiten();
    const ausschluesse = vorbelegteAusschluesse(pruefung);
    expect(ausschluesse.has(seitenSchluessel('d1', 2))).toBe(true);
    expect(ausschluesse.has(seitenSchluessel('d3', 1))).toBe(true);
    expect(ausschluesse.has(seitenSchluessel('d1', 1))).toBe(false);
    expect(ausschluesse.has(seitenSchluessel('d2', 1))).toBe(false);
  });

  it('enthält keinen einzigen Leerseitenschlüssel', () => {
    const pruefung = pruefungMitZweiDublettenDreiLeerseiten();
    const ausschluesse = vorbelegteAusschluesse(pruefung);
    expect(ausschluesse.has(seitenSchluessel('d1', 3))).toBe(false);
    expect(ausschluesse.has(seitenSchluessel('d2', 2))).toBe(false);
    expect(ausschluesse.has(seitenSchluessel('d3', 2))).toBe(false);
  });
});

describe('bereinigeAusschluesse', () => {
  it('verwirft einen Schlüssel, dessen Seite im neuen Ergebnis fehlt', () => {
    const alt = new Set([seitenSchluessel('d1', 2), seitenSchluessel('d-verschwunden', 9)]);
    const neu = bereinigeAusschluesse(alt, pruefungMitZweiDublettenDreiLeerseiten());
    expect(neu.has(seitenSchluessel('d-verschwunden', 9))).toBe(false);
  });

  it('behält einen Schlüssel, der weiterhin vorkommt', () => {
    const alt = new Set([seitenSchluessel('d1', 2)]);
    const neu = bereinigeAusschluesse(alt, pruefungMitZweiDublettenDreiLeerseiten());
    expect(neu.has(seitenSchluessel('d1', 2))).toBe(true);
  });

  it('behält auch die erste Fundstelle einer Dublette (gleichWieDocId/gleichWieLokaleSeite) und eine Leerseite', () => {
    const alt = new Set([seitenSchluessel('d1', 1), seitenSchluessel('d2', 2)]);
    const neu = bereinigeAusschluesse(alt, pruefungMitZweiDublettenDreiLeerseiten());
    expect(neu.has(seitenSchluessel('d1', 1))).toBe(true);
    expect(neu.has(seitenSchluessel('d2', 2))).toBe(true);
  });
});

describe('ausschlussListe', () => {
  it('liefert für dieselbe Menge zweimal dieselbe Reihenfolge (stabil sortiert nach docId und Seite)', () => {
    const ausschluesse = new Set([seitenSchluessel('d2', 1), seitenSchluessel('d1', 3), seitenSchluessel('d1', 1)]);
    const erste = ausschlussListe(ausschluesse);
    const zweite = ausschlussListe(new Set(ausschluesse));
    expect(erste).toEqual(zweite);
    expect(erste).toEqual([
      { docId: 'd1', seite: 1 },
      { docId: 'd1', seite: 3 },
      { docId: 'd2', seite: 1 },
    ]);
  });

  it('liefert für eine leere Ankreuzungsmenge eine leere Liste', () => {
    expect(ausschlussListe(new Set())).toEqual([]);
  });
});
