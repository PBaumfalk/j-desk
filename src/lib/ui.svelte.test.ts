import { describe, it, expect, afterEach } from 'vitest';
import {
  ui, setJlVersionIncompatible, toast403, clearHistorieCache, pointerUeberZeitleiste,
  setzeSitzungsUiZurueck,
} from './ui.svelte';

describe('ui.aktivitaetOffen (Phase 4, HIST-01 — Entkopplung von der Historie)', () => {
  afterEach(() => {
    ui.aktivitaetOffen = false;
  });

  it('ist initial false', () => {
    expect(ui.aktivitaetOffen).toBe(false);
  });

  it('bleibt von clearHistorieCache() unberührt — Beleg, dass beide Oberflächen entkoppelt sind (D-01)', () => {
    ui.aktivitaetOffen = true;
    clearHistorieCache();
    expect(ui.aktivitaetOffen).toBe(true);
  });
});

describe('setJlVersionIncompatible (WR-06 Race-/Overwrite-Fall)', () => {
  it('kollabiert jeden Aufruf ohne Merge — ein späterer false-Aufruf überschreibt ein zuvor gesetztes true', () => {
    // Dokumentiert bewusst die bestehende "letzter Aufruf gewinnt"-Semantik: setJlVersionIncompatible
    // kennt kein Upgrade-only-Merge. Genau das macht den in WR-06 gefundenen Fehler möglich, wenn
    // connect() diesen Setter nach einem bereits korrekten Login()-Aufruf redundant ein zweites Mal
    // mit einem eigenständigen (und potenziell abweichenden) Ergebnis auslöst — z. B. wenn der
    // zweite, unabhängige GET /auth/status-Check wegen eines transienten Netzwerkhängers
    // 'unbestimmt' statt 'inkompatibel' liefert und der Aufrufer das zu false kollabiert
    // (`jlVersion === 'inkompatibel'`).
    //
    // Der eigentliche Fix (WR-06) verhindert das, indem `connect()` in +page.svelte diesen
    // redundanten zweiten Aufruf beim expliziten Login (`LoginScreen.svelte` submit()) überspringt
    // (`opts.skipVersionCheck`) — dieser Test pinnt das Setter-Verhalten, das genau deshalb NICHT
    // erneut ungeschützt aufgerufen werden darf.
    setJlVersionIncompatible(true);
    expect(ui.jlVersionIncompatible).toBe(true);

    setJlVersionIncompatible(false);
    expect(ui.jlVersionIncompatible).toBe(false);
  });

  it('setzt jlVersionBannerGeschlossen bei jedem Aufruf zurück (Session-Storage-Reset bleibt unverändert, planner_assumption 01-07)', () => {
    setJlVersionIncompatible(true);
    ui.jlVersionBannerGeschlossen = true; // simuliert: Nutzerin hat das Banner der vorherigen Verbindung geschlossen

    setJlVersionIncompatible(true);

    expect(ui.jlVersionBannerGeschlossen).toBe(false);
  });
});

describe('toast403 (403-Fallback-Toast, PERM-04, 02-08 Task 2)', () => {
  afterEach(() => {
    ui.toast = null;
  });

  it('liefert die exakten UI-SPEC-Wortlaute für die verbliebenen spezifischen Fälle', () => {
    // 'fremdesObjekt'/'privateEbene' sind seit WR-05 keine Toast-Fälle mehr — der
    // Command-Pfad zeigt dort die präzise Server-Meldung (body.error).
    toast403('loeschen');
    expect(ui.toast).toBe('Endgültiges Löschen ist nur dem Eigentümer vorbehalten.');

    toast403('upload');
    expect(ui.toast).toBe('Hochladen ist mit Ihrer Rolle nicht möglich.');

    toast403('verwaltung');
    expect(ui.toast).toBe('Nur Eigentümer und Bearbeiter dürfen Rollen oder Ebenen verwalten.');
  });

  it('liefert für "allgemein" den rollen-interpolierten Wortlaut', () => {
    toast403('allgemein', 'Kommentator');
    expect(ui.toast).toBe('Aktion nicht erlaubt — Ihre Rolle „Kommentator" erlaubt das nicht.');
  });

  it('liefert für unbekannte/nicht antizipierte Fälle denselben allgemeinen Fallback (fail-closed)', () => {
    toast403('ein-nie-verwendeter-fall', 'Nur-Lesen');
    expect(ui.toast).toBe('Aktion nicht erlaubt — Ihre Rolle „Nur-Lesen" erlaubt das nicht.');
  });

  it('lässt die Rolle ohne Angabe als "unbekannt" erscheinen statt zu crashen', () => {
    toast403('allgemein');
    expect(ui.toast).toBe('Aktion nicht erlaubt — Ihre Rolle „unbekannt" erlaubt das nicht.');
  });
});

describe('pointerUeberZeitleiste (CHRONO-01, 09-01 Task 3 — Muster pointerUeberKorb)', () => {
  afterEach(() => {
    ui.zeitleisteRects = {};
  });

  it('liefert bei leerem zeitleisteRects null', () => {
    ui.zeitleisteRects = {};
    expect(pointerUeberZeitleiste(10, 10)).toBeNull();
  });

  it('liefert die id bei einem Treffer innerhalb des Rechtecks', () => {
    ui.zeitleisteRects = { zl1: { x: 100, y: 100, w: 50, h: 50, zIndex: 1 } };
    expect(pointerUeberZeitleiste(120, 120)).toBe('zl1');
  });

  it('liefert null außerhalb jedes Rechtecks', () => {
    ui.zeitleisteRects = { zl1: { x: 100, y: 100, w: 50, h: 50, zIndex: 1 } };
    expect(pointerUeberZeitleiste(10, 10)).toBeNull();
  });

  it('liefert bei einem Zeiger exakt auf der Rechteckkante einen Treffer (gleiche Inklusivgrenzen wie pointerUeberKorb)', () => {
    ui.zeitleisteRects = { zl1: { x: 100, y: 100, w: 50, h: 50, zIndex: 1 } };
    expect(pointerUeberZeitleiste(100, 100)).toBe('zl1'); // obere linke Ecke
    expect(pointerUeberZeitleiste(150, 150)).toBe('zl1'); // untere rechte Ecke
  });

  // WR-01 (09-REVIEW.md): bei Überlappung entscheidet der zIndex, NICHT die Reihenfolge, in der
  // die Einträge in zeitleisteRects stehen — sonst würde bringToFront() auf die visuell
  // hintere Zeitleiste (höherer zIndex, aber zuerst eingetragener Objektschlüssel) ignoriert.
  it('bei Überlappung gewinnt das Rechteck mit dem höheren zIndex, unabhängig von der Eintragsreihenfolge', () => {
    ui.zeitleisteRects = {
      zl1: { x: 0, y: 0, w: 100, h: 100, zIndex: 1 },
      zl2: { x: 50, y: 50, w: 100, h: 100, zIndex: 2 },
    };
    expect(pointerUeberZeitleiste(75, 75)).toBe('zl2');
  });

  it('bei Überlappung gewinnt weiterhin das visuell obere Rechteck, selbst wenn es ZUERST eingetragen wurde (Regression WR-01: vorher gewann fälschlich der Objektschlüssel-Reihenfolge nach)', () => {
    ui.zeitleisteRects = {
      // zl1 steht zuerst im Objekt (wäre nach der alten Object.entries-Logik der Verlierer),
      // hat aber den höheren zIndex (wurde zuletzt per bringToFront nach vorn geholt).
      zl1: { x: 0, y: 0, w: 100, h: 100, zIndex: 5 },
      zl2: { x: 50, y: 50, w: 100, h: 100, zIndex: 2 },
    };
    expect(pointerUeberZeitleiste(75, 75)).toBe('zl1');
  });
});

describe('Zwei-Klick-/Entwurfs-Modus-Felder sind initial null (09-01 Task 3)', () => {
  it('linkingFromId/clippingFromId/taskRefFromId/tabelleBelegFuer/zeitleisteEintragFuer/zeitleisteEintragEntwurf/compareFromId/versionFromId/vergleich sind initial null', () => {
    expect(ui.linkingFromId).toBeNull();
    expect(ui.clippingFromId).toBeNull();
    expect(ui.taskRefFromId).toBeNull();
    expect(ui.tabelleBelegFuer).toBeNull();
    expect(ui.zeitleisteEintragFuer).toBeNull();
    expect(ui.zeitleisteEintragEntwurf).toBeNull();
    expect(ui.compareFromId).toBeNull();
    expect(ui.versionFromId).toBeNull();
    expect(ui.vergleich).toBeNull();
  });
});

describe('setzeSitzungsUiZurueck (SESS-01/SESS-02/VIEW-01, 11-01 Task 3, WR-02)', () => {
  afterEach(() => {
    setzeSitzungsUiZurueck();
  });

  it('setzt sitzungsmodusAktiv/verschiebeSperreAktiv/sprungmarkenOffen/sitzungsmappeOffen/sitzungsnotizOffen auf false, aktiveSitzungsmappeId auf null und highlightedIds auf ein leeres Set', () => {
    ui.sitzungsmodusAktiv = true;
    ui.aktiveSitzungsmappeId = 'sm1';
    ui.verschiebeSperreAktiv = true;
    ui.sprungmarkenOffen = true;
    ui.sitzungsmappeOffen = true;
    ui.sitzungsnotizOffen = true;
    ui.highlightedIds = new Set(['d1', 'd2']);

    setzeSitzungsUiZurueck();

    expect(ui.sitzungsmodusAktiv).toBe(false);
    expect(ui.verschiebeSperreAktiv).toBe(false);
    expect(ui.sprungmarkenOffen).toBe(false);
    expect(ui.sitzungsmappeOffen).toBe(false);
    expect(ui.sitzungsnotizOffen).toBe(false);
    expect(ui.aktiveSitzungsmappeId).toBeNull();
    expect(ui.highlightedIds).toEqual(new Set());
  });

  it('ein zweiter Aufruf auf bereits zurückgesetztem Zustand ändert nichts (Idempotenz)', () => {
    setzeSitzungsUiZurueck();
    const vorher = {
      sitzungsmodusAktiv: ui.sitzungsmodusAktiv,
      aktiveSitzungsmappeId: ui.aktiveSitzungsmappeId,
      verschiebeSperreAktiv: ui.verschiebeSperreAktiv,
      sprungmarkenOffen: ui.sprungmarkenOffen,
      sitzungsmappeOffen: ui.sitzungsmappeOffen,
      sitzungsnotizOffen: ui.sitzungsnotizOffen,
      highlightedIds: new Set(ui.highlightedIds),
    };

    setzeSitzungsUiZurueck();

    expect(ui.sitzungsmodusAktiv).toBe(vorher.sitzungsmodusAktiv);
    expect(ui.aktiveSitzungsmappeId).toBe(vorher.aktiveSitzungsmappeId);
    expect(ui.verschiebeSperreAktiv).toBe(vorher.verschiebeSperreAktiv);
    expect(ui.sprungmarkenOffen).toBe(vorher.sprungmarkenOffen);
    expect(ui.sitzungsmappeOffen).toBe(vorher.sitzungsmappeOffen);
    expect(ui.sitzungsnotizOffen).toBe(vorher.sitzungsnotizOffen);
    expect(ui.highlightedIds).toEqual(vorher.highlightedIds);
  });

  it('highlightedIds ist initial ein leeres Set und akzeptiert Einträge, die der Reset wieder entfernt', () => {
    expect(ui.highlightedIds).toEqual(new Set());
    ui.highlightedIds = new Set(['d1']);
    expect(ui.highlightedIds.has('d1')).toBe(true);
    setzeSitzungsUiZurueck();
    expect(ui.highlightedIds.size).toBe(0);
  });
});
