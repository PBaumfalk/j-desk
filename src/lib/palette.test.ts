import { describe, expect, it } from 'vitest';
import type { Zone } from '@j-desk/core';
import {
  ABSCHNITT_LABEL, SHORTCUT_INVENTAR, baueBefehle, filtereBefehle, sucheBefehle, teilfolgenMatch,
  type PaletteBefehl, type PaletteKontext,
} from './palette';
import type { VerlaufEintrag } from './verlauf';
import type { Ansicht } from './views';

/** Minimal-vollständige Kontexte für die Registry-Fabrik — leer/voll je Testfall. */
function leererKontext(): PaletteKontext {
  return { rolle: 'Eigentümer', mode: 'standalone', verlauf: [], zonen: [], ansichten: [] };
}

function vollerKontext(): PaletteKontext {
  const zonen: Zone[] = [{ id: 'z1', name: 'Fristen', rect: { x: 0, y: 0, w: 100, h: 100 } }];
  const ansichten: Ansicht[] = [{
    id: 'a1', name: 'Übersicht', updatedAt: '2026-01-01T00:00:00.000Z',
    vp: { x: 0, y: 0, scale: 1 }, visibleLayers: [], suchText: '', highlightedIds: [], openDocIds: [],
  }];
  const verlauf: VerlaufEintrag[] = [
    { vp: { x: 0, y: 0, scale: 1 }, ausloeser: 'fundstelle', label: 'Fundstelle: Klageschrift, Seite 3' },
    { vp: { x: 10, y: 10, scale: 1 }, ausloeser: 'zone', label: 'Zone: Fristen' },
  ];
  return { rolle: 'Eigentümer', mode: 'standalone', verlauf, zonen, ansichten };
}

describe('palette', () => {
  describe('SHORTCUT_INVENTAR-Vollständigkeit', () => {
    it('hat für jeden Shortcut des verbindlichen Inventars mindestens eine Registry-Zeile', () => {
      const alle = baueBefehle(vollerKontext());
      for (const shortcut of SHORTCUT_INVENTAR) {
        const treffer = alle.filter((b) => b.shortcut === shortcut);
        expect(treffer.length, `Shortcut ${shortcut} ohne Registry-Zeile`).toBeGreaterThan(0);
      }
    });

    it('deckt exakt die sieben verbindlichen Shortcuts ab', () => {
      expect(SHORTCUT_INVENTAR).toEqual(['⌘F', '⌘K', '⌥⇧A', '⌥←', '⌥→', 'Leertaste', 'Esc']);
    });
  });

  describe('Mindestbefehlsumfang', () => {
    const alle = baueBefehle(vollerKontext());
    function hatBefehl(teilLabel: string): boolean {
      return alle.some((b) => b.label.includes(teilLabel));
    }

    it('deckt Suche, Werkzeugwechsel, Ansicht speichern, Quelle öffnen ab', () => {
      expect(hatBefehl('Suche öffnen')).toBe(true);
      expect(hatBefehl('Kugelschreiber')).toBe(true);
      expect(hatBefehl('Textmarker')).toBe(true);
      expect(hatBefehl('Bleistift')).toBe(true);
      expect(hatBefehl('Ansicht speichern')).toBe(true);
      expect(hatBefehl('Quelle öffnen')).toBe(true);
    });

    it('deckt zurück zur letzten Position, KI-Freigaben, Papierkorb, Aufräumen, Aufnahme ab', () => {
      expect(hatBefehl('Zurück zur letzten Position')).toBe(true);
      expect(hatBefehl('KI-Freigaben öffnen')).toBe(true);
      expect(hatBefehl('Papierkorb öffnen')).toBe(true);
      expect(hatBefehl('Schreibtisch aufräumen')).toBe(true);
      expect(hatBefehl('Inhalt aufnehmen')).toBe(true);
    });

    it('deckt Zone anlegen, Benachrichtigungen, Minikarte, Sitzungsmappe, Anlagenpaket, Übergabe, Export ab', () => {
      expect(hatBefehl('Zone anlegen')).toBe(true);
      expect(hatBefehl('Benachrichtigungen öffnen')).toBe(true);
      expect(hatBefehl('Minikarte')).toBe(true);
      expect(hatBefehl('Sitzungsmappe')).toBe(true);
      expect(hatBefehl('Anlagenpaket')).toBe(true);
      expect(hatBefehl('Übergabe')).toBe(true);
      expect(hatBefehl('Arbeitsstand exportieren')).toBe(true);
    });

    it('jede Registry-Zeile trägt einen Ausführungs-Deskriptor mit gültiger art', () => {
      const GUELTIG = new Set(['kommando', 'ui', 'sprung', 'dialog']);
      for (const b of alle) expect(GUELTIG.has(b.aktion.art)).toBe(true);
    });
  });

  describe('Rollen-Filter (PERM-04, ausblenden statt ausgrauen)', () => {
    it('entfernt "Arbeitsstand exportieren…" vollständig für die Rolle Kommentator', () => {
      const alle = baueBefehle(vollerKontext());
      const gefiltert = filtereBefehle(alle, { ...vollerKontext(), rolle: 'Kommentator' });
      expect(gefiltert.some((b) => b.label.includes('Arbeitsstand exportieren'))).toBe(false);
      // Kein Eintrag trägt ein Deaktiviert-Flag — die PaletteBefehl-Form kennt keins.
      for (const b of gefiltert) expect((b as PaletteBefehl & { deaktiviert?: unknown }).deaktiviert).toBeUndefined();
    });

    it('entfernt "Schreibtisch aufräumen…" und "Zone anlegen…" ohne Bearbeitungsrecht (Nur-Lesen)', () => {
      const alle = baueBefehle(vollerKontext());
      const gefiltert = filtereBefehle(alle, { ...vollerKontext(), rolle: 'Nur-Lesen' });
      expect(gefiltert.some((b) => b.label.includes('Schreibtisch aufräumen'))).toBe(false);
      expect(gefiltert.some((b) => b.label.includes('Zone anlegen'))).toBe(false);
    });

    it('behält rollenfreie Befehle (Papierkorb öffnen) auch für Nur-Lesen', () => {
      const alle = baueBefehle(vollerKontext());
      const gefiltert = filtereBefehle(alle, { ...vollerKontext(), rolle: 'Nur-Lesen' });
      expect(gefiltert.some((b) => b.label.includes('Papierkorb öffnen'))).toBe(true);
    });
  });

  describe('Kontext-Filter', () => {
    it('entfernt bei leerem Verlauf "Zurück zur letzten Position", "Wieder vor" und "Quelle öffnen"', () => {
      const kontext = leererKontext();
      const alle = baueBefehle(kontext);
      const gefiltert = filtereBefehle(alle, kontext);
      expect(gefiltert.some((b) => b.label.includes('Zurück zur letzten Position'))).toBe(false);
      expect(gefiltert.some((b) => b.label === 'Wieder vor')).toBe(false);
      expect(gefiltert.some((b) => b.label.includes('Quelle öffnen'))).toBe(false);
    });

    it('behält Verlauf-Navigation bei nicht-leerem Verlauf', () => {
      const kontext = vollerKontext();
      const alle = baueBefehle(kontext);
      const gefiltert = filtereBefehle(alle, kontext);
      expect(gefiltert.some((b) => b.label.includes('Zurück zur letzten Position'))).toBe(true);
      expect(gefiltert.some((b) => b.label.includes('Quelle öffnen'))).toBe(true);
    });

    it('ohne Zonen fehlt der Zonen-Abschnitt komplett (aber "Zone anlegen…" bleibt in Aktionen)', () => {
      const kontext = leererKontext();
      const alle = baueBefehle(kontext);
      expect(alle.some((b) => b.abschnitt === 'zonen')).toBe(false);
      expect(alle.some((b) => b.label.includes('Zone anlegen'))).toBe(true);
    });

    it('mit Zonen erscheint je Zone eine "Zu „{Name}" springen"-Zeile im Zonen-Abschnitt', () => {
      const kontext = vollerKontext();
      const alle = baueBefehle(kontext);
      const zonenZeilen = alle.filter((b) => b.abschnitt === 'zonen');
      expect(zonenZeilen).toHaveLength(1);
      expect(zonenZeilen[0].label).toBe('Zu „Fristen" springen');
    });

    it('ohne Ansichten fehlt der Ansichten-Abschnitt (aber "Ansicht speichern…" bleibt in Aktionen)', () => {
      const kontext = leererKontext();
      const alle = baueBefehle(kontext);
      expect(alle.some((b) => b.abschnitt === 'ansichten')).toBe(false);
      expect(alle.some((b) => b.label.includes('Ansicht speichern'))).toBe(true);
    });

    it('außerhalb des Standalone-Modus fehlt "Neu aus Vorlage…" (mode-Kontext-Filter)', () => {
      const kontext: PaletteKontext = { ...vollerKontext(), mode: 'jlawyer' };
      const alle = baueBefehle(kontext);
      const gefiltert = filtereBefehle(alle, kontext);
      expect(gefiltert.some((b) => b.label.includes('Neu aus Vorlage'))).toBe(false);
    });

    it('im Standalone-Modus erscheint "Neu aus Vorlage…"', () => {
      const kontext = vollerKontext();
      const alle = baueBefehle(kontext);
      const gefiltert = filtereBefehle(alle, kontext);
      expect(gefiltert.some((b) => b.label.includes('Neu aus Vorlage'))).toBe(true);
    });
  });

  describe('Verlauf-Abschnitt', () => {
    it('zeigt höchstens die letzten 10 Einträge, neueste zuerst, mit den 13-05-Label-Formen', () => {
      const eintraege: VerlaufEintrag[] = Array.from({ length: 15 }, (_, i) => ({
        vp: { x: i, y: 0, scale: 1 }, ausloeser: 'minikarte' as const, label: `Minikarte-Sprung ${i}`,
      }));
      const kontext: PaletteKontext = { ...leererKontext(), verlauf: eintraege };
      const alle = baueBefehle(kontext);
      const verlaufZeilen = alle.filter((b) => b.abschnitt === 'verlauf');
      expect(verlaufZeilen).toHaveLength(10);
      // Neueste zuerst: Eintrag 14 (letzter im Array) kommt zuerst.
      expect(verlaufZeilen[0].label).toBe('Minikarte-Sprung 14');
      expect(verlaufZeilen[9].label).toBe('Minikarte-Sprung 5');
    });

    it('fehlt komplett bei leerem Verlauf', () => {
      const alle = baueBefehle(leererKontext());
      expect(alle.some((b) => b.abschnitt === 'verlauf')).toBe(false);
    });
  });

  describe('teilfolgenMatch', () => {
    it('trifft eine Teilfolge case-insensitiv und NFC-normalisiert', () => {
      expect(teilfolgenMatch('auf', '🧹 Schreibtisch aufräumen…')).not.toBeNull();
      expect(teilfolgenMatch('AUF', '🧹 Schreibtisch aufräumen…')).not.toBeNull();
    });

    it('trifft nichts, wenn die Zeichen nicht in Reihenfolge vorkommen', () => {
      expect(teilfolgenMatch('xyz', '🧹 Schreibtisch aufräumen…')).toBeNull();
    });

    it('liefert Start und Spannweite des frühesten Treffers', () => {
      const treffer = teilfolgenMatch('sn', 'Suche öffnen');
      expect(treffer).not.toBeNull();
      expect(treffer?.start).toBe(0);
    });
  });

  describe('sucheBefehle', () => {
    it('liefert bei leerem Suchtext die volle Liste in Abschnittsreihenfolge (Aktionen → Zonen → Ansichten → Verlauf)', () => {
      const kontext = vollerKontext();
      const alle = baueBefehle(kontext);
      const gefiltert = filtereBefehle(alle, kontext);
      const ergebnis = sucheBefehle(gefiltert, '');
      expect(ergebnis).toHaveLength(gefiltert.length);
      const REIHENFOLGE = ['aktionen', 'zonen', 'ansichten', 'verlauf'];
      let letzterIndex = -1;
      for (const b of ergebnis) {
        const idx = REIHENFOLGE.indexOf(b.abschnitt);
        expect(idx).toBeGreaterThanOrEqual(letzterIndex);
        letzterIndex = idx;
      }
    });

    it('"auf" trifft "🧹 Schreibtisch aufräumen…"', () => {
      const kontext = vollerKontext();
      const alle = baueBefehle(kontext);
      const gefiltert = filtereBefehle(alle, kontext);
      const ergebnis = sucheBefehle(gefiltert, 'auf');
      expect(ergebnis.some((b) => b.label.includes('Schreibtisch aufräumen'))).toBe(true);
    });

    it('"xyz" trifft nichts (Leer-Pfad)', () => {
      const kontext = vollerKontext();
      const alle = baueBefehle(kontext);
      const gefiltert = filtereBefehle(alle, kontext);
      expect(sucheBefehle(gefiltert, 'xyz')).toHaveLength(0);
    });
  });

  describe('ABSCHNITT_LABEL', () => {
    it('trägt die vier fixierten Abschnittsnamen', () => {
      expect(ABSCHNITT_LABEL).toEqual({
        aktionen: 'Aktionen', zonen: 'Zonen', ansichten: 'Ansichten', verlauf: 'Verlauf',
      });
    });
  });
});
