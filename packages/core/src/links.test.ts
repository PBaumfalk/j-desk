import { describe, it, expect } from 'vitest';
import { emptyState, type DesktopState } from './model';
import { addDoc } from './documents';
import { removeDoc } from './removal';
import { applyCommand, CommandError } from './commands';
import {
  addLink, setLinkNote, removeLink, removeLinksFor, linkedEntityIds, collectLinkedDocs,
  LINK_MEANINGS, LINK_MEANING_FAMILY, familieVon, setLinkKind, type LinkMeaning,
  addVersionLink, removeVersionLink, versionKetteVon, istVersionLink,
} from './links';
import { projectStateForActor, type ActorContext } from './projection';
import type { Ebene } from './layers';
import { stempeleGeaenderte } from './stempel';

function docs(n: number): DesktopState {
  let s = emptyState();
  for (let i = 0; i < n; i++) s = addDoc(s, `file-${i}`, `${i}.pdf`, { x: 0, y: 0 }, `id-${i}`);
  return s;
}

describe('addLink', () => {
  it('legt eine Verknüpfung mit leerer Notiz an', () => {
    const s = addLink(docs(2), 'id-0', 'id-1', 'l-1');
    expect(s.links).toEqual([{ id: 'l-1', fromId: 'id-0', toId: 'id-1', note: '' }]);
  });

  it('lehnt Selbstverknüpfung ab', () => {
    const s = addLink(docs(2), 'id-0', 'id-0', 'l-1');
    expect(s.links).toHaveLength(0);
  });

  it('lehnt Duplikate in beiden Richtungen ab', () => {
    let s = addLink(docs(2), 'id-0', 'id-1', 'l-1');
    s = addLink(s, 'id-0', 'id-1', 'l-2');
    s = addLink(s, 'id-1', 'id-0', 'l-3');
    expect(s.links).toHaveLength(1);
  });
});

describe('Notiz und Entfernen', () => {
  it('setzt eine Notiz', () => {
    let s = addLink(docs(2), 'id-0', 'id-1', 'l-1');
    s = setLinkNote(s, 'l-1', 'Rechnung zu Vertrag X');
    expect(s.links[0].note).toBe('Rechnung zu Vertrag X');
  });

  it('entfernt eine Verknüpfung per id', () => {
    let s = addLink(docs(2), 'id-0', 'id-1', 'l-1');
    s = removeLink(s, 'l-1');
    expect(s.links).toHaveLength(0);
  });

  it('entfernt alle Verknüpfungen einer Entität', () => {
    let s = docs(3);
    s = addLink(s, 'id-0', 'id-1', 'l-1');
    s = addLink(s, 'id-2', 'id-0', 'l-2');
    s = addLink(s, 'id-1', 'id-2', 'l-3');
    s = removeLinksFor(s, 'id-0');
    expect(s.links.map((l) => l.id)).toEqual(['l-3']);
  });
});

describe('linkedEntityIds / collectLinkedDocs', () => {
  it('liefert die Gegenseiten aller Verknüpfungen', () => {
    let s = docs(3);
    s = addLink(s, 'id-0', 'id-1', 'l-1');
    s = addLink(s, 'id-2', 'id-0', 'l-2');
    expect(linkedEntityIds(s, 'id-0').sort()).toEqual(['id-1', 'id-2']);
  });

  it('sammelt das Dokument selbst plus Verknüpfte, Stapel expandiert, dedupliziert', () => {
    let s = docs(4);
    s = {
      ...s,
      stacks: [{ id: 'st-1', name: '', docIds: ['id-2', 'id-3'], position: { x: 0, y: 0 }, zIndex: 0 }],
    };
    s = addLink(s, 'id-0', 'st-1', 'l-1');
    s = addLink(s, 'id-0', 'id-2', 'l-2'); // id-2 steckt im Stapel → darf nicht doppelt erscheinen
    expect(collectLinkedDocs(s, 'id-0').map((d) => d.id).sort()).toEqual(['id-0', 'id-2', 'id-3']);
  });
});

describe('Verknüpfungsbedeutung (LEGAL-02)', () => {
  it('setLinkKind setzt das Feld; übrige Verknüpfungen behalten ihre Referenz', () => {
    let s = docs(3);
    s = addLink(s, 'id-0', 'id-1', 'l-1');
    s = addLink(s, 'id-0', 'id-2', 'l-2');
    const vorher = s.links.find((l) => l.id === 'l-2');
    s = setLinkKind(s, 'l-1', 'belegt');
    expect(s.links.find((l) => l.id === 'l-1')?.kind).toBe('belegt');
    expect(s.links.find((l) => l.id === 'l-2')).toBe(vorher);
  });

  it('setLinkKind auf unbekannter linkId ändert nichts und wirft nicht (stilles No-op)', () => {
    const s = addLink(docs(2), 'id-0', 'id-1', 'l-1');
    expect(() => setLinkKind(s, 'nix', 'belegt')).not.toThrow();
    expect(setLinkKind(s, 'nix', 'belegt')).toEqual(s);
  });

  it('setLinkKind(s, linkId, undefined) entfernt das Feld wieder aus dem Objekt', () => {
    let s = addLink(docs(2), 'id-0', 'id-1', 'l-1');
    s = setLinkKind(s, 'l-1', 'belegt');
    s = setLinkKind(s, 'l-1', undefined);
    expect(s.links[0]).not.toHaveProperty('kind');
  });

  it('addLink erzeugt weiterhin Verknüpfungen ohne kind', () => {
    const s = addLink(docs(2), 'id-0', 'id-1', 'l-1');
    expect(s.links[0]).not.toHaveProperty('kind');
  });

  it('LINK_MEANING_FAMILY bildet alle 11 Werte ab (Vollständigkeitstest)', () => {
    for (const wert of LINK_MEANINGS) {
      expect(LINK_MEANING_FAMILY[wert], `LINK_MEANING_FAMILY fehlt für "${wert}"`).toBeDefined();
      expect(['bestaetigend', 'widersprechend', 'offen']).toContain(LINK_MEANING_FAMILY[wert]);
    }
    expect(LINK_MEANINGS).toHaveLength(11);
  });

  it('familieVon(undefined) liefert "offen" — dieselbe Familie wie "offene-frage"', () => {
    expect(familieVon(undefined)).toBe('offen');
    expect(familieVon('offene-frage')).toBe('offen');
  });

  it('familieVon ordnet jede Familie korrekt zu', () => {
    const bestaetigend: LinkMeaning[] = ['belegt', 'bestaetigt', 'gehoert-zu', 'folge-von', 'voraussetzung-fuer', 'unstreitig'];
    const widersprechend: LinkMeaning[] = ['widerspricht', 'widerlegt', 'entkraeftet', 'streitig'];
    for (const wert of bestaetigend) expect(familieVon(wert)).toBe('bestaetigend');
    for (const wert of widersprechend) expect(familieVon(wert)).toBe('widersprechend');
  });
});

describe('setLinkKind über applyCommand (Validierung)', () => {
  function basis(): DesktopState {
    let s = docs(2);
    s = addLink(s, 'id-0', 'id-1', 'l-1');
    return s;
  }

  it('setzt eine bekannte Bedeutung', () => {
    const s = applyCommand(basis(), { type: 'setLinkKind', payload: { linkId: 'l-1', kind: 'widerspricht' } });
    expect(s.links[0].kind).toBe('widerspricht');
  });

  it('lehnt einen unbekannten Bedeutungswert mit CommandError ab', () => {
    expect(() =>
      applyCommand(basis(), { type: 'setLinkKind', payload: { linkId: 'l-1', kind: 'erfunden' } }),
    ).toThrow(CommandError);
  });

  it('kind: null setzt die Bedeutung zurück, statt zu werfen', () => {
    let s = applyCommand(basis(), { type: 'setLinkKind', payload: { linkId: 'l-1', kind: 'belegt' } });
    s = applyCommand(s, { type: 'setLinkKind', payload: { linkId: 'l-1', kind: null } });
    expect(s.links[0]).not.toHaveProperty('kind');
  });

  it('fehlendes kind setzt die Bedeutung zurück, statt zu werfen', () => {
    let s = applyCommand(basis(), { type: 'setLinkKind', payload: { linkId: 'l-1', kind: 'belegt' } });
    s = applyCommand(s, { type: 'setLinkKind', payload: { linkId: 'l-1' } });
    expect(s.links[0]).not.toHaveProperty('kind');
  });
});

describe('Versionskette (COMP-03)', () => {
  it('addVersionLink legt eine gerichtete, strukturelle Verknüpfung an (fromId = alt, toId = neu)', () => {
    const s = addVersionLink(docs(2), 'id-0', 'id-1', 'vl-1');
    expect(s.links).toEqual([{ id: 'vl-1', fromId: 'id-0', toId: 'id-1', note: '', struktur: 'version' }]);
  });

  it('die angelegte Verknüpfung trägt keine der elf juristischen Bedeutungen', () => {
    const s = addVersionLink(docs(2), 'id-0', 'id-1', 'vl-1');
    expect(s.links[0]).not.toHaveProperty('kind');
  });

  it('addVersionLink mit identischer alter und neuer Fassung ändert den Zustand nicht', () => {
    const s = addVersionLink(docs(2), 'id-0', 'id-0', 'vl-1');
    expect(s.links).toHaveLength(0);
  });

  it('lehnt einen zweiten direkten Vorgänger für dieselbe neue Fassung ab', () => {
    const s = addVersionLink(docs(3), 'id-0', 'id-2', 'vl-1');
    expect(() => addVersionLink(s, 'id-1', 'id-2', 'vl-2')).toThrow(CommandError);
  });

  it('lehnt einen zweiten Nachfolger derselben alten Fassung ab (Kette verzweigt nicht)', () => {
    const s = addVersionLink(docs(3), 'id-0', 'id-1', 'vl-1');
    expect(() => addVersionLink(s, 'id-0', 'id-2', 'vl-2')).toThrow(CommandError);
  });

  it('verhindert_zyklus: lehnt einen direkten Kreis ab (A vor B, danach B vor A)', () => {
    const s = addVersionLink(docs(2), 'id-0', 'id-1', 'vl-1');
    expect(() => addVersionLink(s, 'id-1', 'id-0', 'vl-2')).toThrow(CommandError);
  });

  it('erkennt_indirekten_zyklus: lehnt einen zweistufigen Kreis ab (A→B, B→C, dann C→A)', () => {
    let s = addVersionLink(docs(3), 'id-0', 'id-1', 'vl-1');
    s = addVersionLink(s, 'id-1', 'id-2', 'vl-2');
    expect(() => addVersionLink(s, 'id-2', 'id-0', 'vl-3')).toThrow(CommandError);
  });

  it('erkennt_indirekten_zyklus: lehnt einen dreistufigen Kreis ab (A→B→C→D, dann D→A)', () => {
    let s = addVersionLink(docs(4), 'id-0', 'id-1', 'vl-1');
    s = addVersionLink(s, 'id-1', 'id-2', 'vl-2');
    s = addVersionLink(s, 'id-2', 'id-3', 'vl-3');
    expect(() => addVersionLink(s, 'id-3', 'id-0', 'vl-4')).toThrow(CommandError);
  });

  it('zwei unabhängige Ketten im selben Zustand behindern einander nicht — kein falsch positiver Kreisbefund', () => {
    let s = addVersionLink(docs(6), 'id-0', 'id-1', 'vl-1'); // Kette 1: id-0 → id-1
    s = addVersionLink(s, 'id-2', 'id-3', 'vl-2'); // Kette 2: id-2 → id-3, unabhängig von Kette 1
    expect(() => addVersionLink(s, 'id-3', 'id-4', 'vl-3')).not.toThrow(); // erweitert nur Kette 2
  });

  it('legt eine bereits bestehende, gleiche Versionsbeziehung nicht doppelt an (stilles No-op)', () => {
    let s = addVersionLink(docs(2), 'id-0', 'id-1', 'vl-1');
    s = addVersionLink(s, 'id-0', 'id-1', 'vl-2');
    expect(s.links).toHaveLength(1);
  });

  it('prüft nicht gegen bestehende gewöhnliche Verknüpfungen — beide bestehen nebeneinander', () => {
    let s = addLink(docs(2), 'id-0', 'id-1', 'l-1');
    s = addVersionLink(s, 'id-0', 'id-1', 'vl-1');
    expect(s.links.map((l) => l.id).sort()).toEqual(['l-1', 'vl-1']);
  });

  it('istVersionLink erkennt genau die Verknüpfungen mit der Strukturkennzeichnung', () => {
    let s = addLink(docs(2), 'id-0', 'id-1', 'l-1');
    s = addVersionLink(s, 'id-0', 'id-1', 'vl-1');
    expect(s.links.filter(istVersionLink).map((l) => l.id)).toEqual(['vl-1']);
  });

  it('removeVersionLink entfernt genau eine Versionsbeziehung; gewöhnliche Verknüpfungen bleiben unberührt', () => {
    let s = addLink(docs(2), 'id-0', 'id-1', 'l-1');
    s = addVersionLink(s, 'id-0', 'id-1', 'vl-1');
    s = removeVersionLink(s, 'vl-1');
    expect(s.links.map((l) => l.id)).toEqual(['l-1']);
  });

  it('removeVersionLink auf einer gewöhnlichen Verknüpfung ändert nichts (stilles No-op)', () => {
    const s = addLink(docs(2), 'id-0', 'id-1', 'l-1');
    expect(removeVersionLink(s, 'l-1').links).toHaveLength(1);
  });

  it('removeLinksFor entfernt auch Versionsbeziehungen des gelöschten Objekts', () => {
    let s = addVersionLink(docs(2), 'id-0', 'id-1', 'vl-1');
    s = removeLinksFor(s, 'id-1');
    expect(s.links).toHaveLength(0);
  });

  it('versionKetteVon liefert eine einelementige Liste für ein Dokument ohne Versionsbeziehung', () => {
    expect(versionKetteVon(docs(1), 'id-0')).toEqual(['id-0']);
  });

  it('versionKetteVon liefert dieselbe geordnete Kette von der ersten, mittleren und letzten Fassung aus', () => {
    let s = addVersionLink(docs(3), 'id-0', 'id-1', 'vl-1');
    s = addVersionLink(s, 'id-1', 'id-2', 'vl-2');
    expect(versionKetteVon(s, 'id-0')).toEqual(['id-0', 'id-1', 'id-2']);
    expect(versionKetteVon(s, 'id-1')).toEqual(['id-0', 'id-1', 'id-2']);
    expect(versionKetteVon(s, 'id-2')).toEqual(['id-0', 'id-1', 'id-2']);
  });

  it('drei Ablehnungen (Vorgänger, Nachfolger, Kreis) werfen CommandError mit unterschiedlichen Meldungen', () => {
    const s = addVersionLink(docs(3), 'id-0', 'id-1', 'vl-1');
    const meldung = (fn: () => void): string => {
      try {
        fn();
        return '';
      } catch (e) {
        return e instanceof Error ? e.message : '';
      }
    };
    const vorgaengerMsg = meldung(() => addVersionLink(s, 'id-2', 'id-1', 'vl-x'));
    const nachfolgerMsg = meldung(() => addVersionLink(s, 'id-0', 'id-2', 'vl-y'));
    const kreisMsg = meldung(() => addVersionLink(s, 'id-1', 'id-0', 'vl-z'));
    expect(vorgaengerMsg).not.toBe('');
    expect(nachfolgerMsg).not.toBe('');
    expect(kreisMsg).not.toBe('');
    expect(new Set([vorgaengerMsg, nachfolgerMsg, kreisMsg]).size).toBe(3);
  });
});

/**
 * COMP-03, Task 3: belegt statt behauptet — die Modellentscheidung aus Task 1 (Link.struktur
 * statt eigenem Array) erbt Projektion, Freigabefilterung, Konflikterkennung und
 * Löschbereinigung aus dem bestehenden Verknüpfungsmechanismus, ohne eigene Verdrahtung.
 */
describe('Versionskette: Zusammenspiel mit Projektion, Freigabe und Konflikterkennung', () => {
  const PRIVAT_A: Ebene = { id: 'privat-a', typ: 'privat', name: 'Privat (A)', ownerUserId: 'nutzer-a' };
  const eigentuemerA: ActorContext = { userId: 'nutzer-a', rolle: 'Eigentümer' };
  const bearbeiterB: ActorContext = { userId: 'nutzer-b', rolle: 'Bearbeiter' };
  const gast: ActorContext = { userId: 'gast-x', rolle: 'externer Gast' };

  it('eine Versionsbeziehung auf einer privaten Ebene fehlt in der Projektion eines Betrachters ohne Sichtrecht vollständig', () => {
    let s: DesktopState = { ...docs(2), layers: [PRIVAT_A] };
    s = addVersionLink(s, 'id-0', 'id-1', 'vl-1');
    s = { ...s, links: s.links.map((l) => (l.id === 'vl-1' ? { ...l, layerId: PRIVAT_A.id } : l)) };

    expect(projectStateForActor(s, bearbeiterB).links.some((l) => l.id === 'vl-1')).toBe(false);
    // Der Eigentümer der privaten Ebene sieht seine eigene Versionsbeziehung weiterhin.
    expect(projectStateForActor(s, eigentuemerA).links.some((l) => l.id === 'vl-1')).toBe(true);
  });

  it('eine Versionsbeziehung mit interner Freigabe fehlt in der Projektion eines externen Gasts', () => {
    let s = addVersionLink(docs(2), 'id-0', 'id-1', 'vl-1');
    s = { ...s, links: s.links.map((l) => (l.id === 'vl-1' ? { ...l, freigabe: 'intern' as const } : l)) };

    expect(projectStateForActor(s, gast).links.some((l) => l.id === 'vl-1')).toBe(false);
  });

  it('stempeleGeaenderte versieht eine neu angelegte Versionsbeziehung mit Version, Zeitpunkt und Urheber', () => {
    const S = { rev: 7, at: '2026-08-07T12:00:00.000Z', by: 'Frau Meier' };
    const alt = docs(2);
    const neu = stempeleGeaenderte(alt, addVersionLink(alt, 'id-0', 'id-1', 'vl-1'), S);
    const link = neu.links.find((l) => l.id === 'vl-1')!;
    expect(link.updatedRev).toBe(7);
    expect(link.updatedAt).toBe(S.at);
    expect(link.updatedBy).toBe('Frau Meier');
  });

  it('das Wegwerfen einer Fassung entfernt ihre Versionsbeziehungen aus dem Zustand', () => {
    let s = addVersionLink(docs(3), 'id-0', 'id-1', 'vl-1');
    s = addVersionLink(s, 'id-1', 'id-2', 'vl-2');
    s = removeDoc(s, 'id-1');
    expect(s.links).toHaveLength(0);
  });

  it('versionKetteVon auf einem projizierten Zustand liefert genau die zusammenhängende sichtbare Teilkette — eine unsichtbare mittlere Fassung bricht den Lauf nicht ab', () => {
    let s: DesktopState = { ...docs(3), layers: [PRIVAT_A] };
    // Kette id-0 (öffentlich) -> id-1 (privat) -> id-2 (öffentlich). Sowohl das Dokument id-1 als
    // auch die beiden anliegenden Versionsbeziehungen liegen auf der privaten Ebene — ein
    // Betrachter ohne Sichtrecht sieht weder das Dokument noch dessen Kettenglieder.
    s = { ...s, docs: s.docs.map((d) => (d.id === 'id-1' ? { ...d, layerId: PRIVAT_A.id } : d)) };
    s = addVersionLink(s, 'id-0', 'id-1', 'vl-1');
    s = addVersionLink(s, 'id-1', 'id-2', 'vl-2');
    s = { ...s, links: s.links.map((l) => ({ ...l, layerId: PRIVAT_A.id })) };

    const projiziert = projectStateForActor(s, bearbeiterB);
    expect(projiziert.docs.some((d) => d.id === 'id-1')).toBe(false);
    expect(projiziert.links).toHaveLength(0);
    expect(versionKetteVon(projiziert, 'id-0')).toEqual(['id-0']);
    expect(versionKetteVon(projiziert, 'id-2')).toEqual(['id-2']);

    // Der Eigentümer der privaten Ebene sieht die vollständige Kette weiterhin.
    const projiziertA = projectStateForActor(s, eigentuemerA);
    expect(versionKetteVon(projiziertA, 'id-0')).toEqual(['id-0', 'id-1', 'id-2']);
  });

  it('die Kettenzählung des Betrachters lässt keine Rückschlüsse auf die Anzahl unsichtbarer Fassungen zu', () => {
    let s: DesktopState = { ...docs(3), layers: [PRIVAT_A] };
    s = { ...s, docs: s.docs.map((d) => (d.id === 'id-1' ? { ...d, layerId: PRIVAT_A.id } : d)) };
    s = addVersionLink(s, 'id-0', 'id-1', 'vl-1');
    s = addVersionLink(s, 'id-1', 'id-2', 'vl-2');
    s = { ...s, links: s.links.map((l) => ({ ...l, layerId: PRIVAT_A.id })) };

    // Fremder Betrachter: „Version 1 von 1" — kein Hinweis auf die zwei fehlenden Glieder.
    const ketteFremd = versionKetteVon(projectStateForActor(s, bearbeiterB), 'id-0');
    // Eigentümer: „Version 1 von 3" — dieselbe Kette, vollständig sichtbar.
    const ketteEigentuemer = versionKetteVon(projectStateForActor(s, eigentuemerA), 'id-0');
    expect(ketteFremd).toEqual(['id-0']);
    expect(ketteEigentuemer).toEqual(['id-0', 'id-1', 'id-2']);
    expect(ketteFremd.length).not.toBe(ketteEigentuemer.length);
  });
});
