import { describe, it, expect } from 'vitest';
import { emptyState, addDoc, trashObject, type DesktopState } from '@j-desk/core';
import { beschreibe, TEXTE } from './history';
import { zeitpunktLang } from './zeitformat';

function eintrag(type: string, payload: unknown) {
  return { id: 1, rev: 5, type, payload, actorId: 'u1', actorName: 'Patrick', at: 1_700_000_000_000 };
}

function mitDoc(): DesktopState {
  return addDoc(emptyState(), 'file-a', 'Bescheid.pdf', { x: 0, y: 0 }, 'doc-a');
}

describe('beschreibe', () => {
  it('nennt Akteur und Zeitpunkt unverändert', () => {
    const e = beschreibe(eintrag('moveDoc', { id: 'doc-a' }), mitDoc());
    expect(e.akteur).toBe('Patrick');
    expect(e.zeit).toBe(1_700_000_000_000);
  });

  it('addMark: Text mit Dokumentname und Seite, Ziel mit docId-Anker', () => {
    const e = beschreibe(
      eintrag('addMark', { mark: { docId: 'doc-a', page: 3, rect: { x: 1, y: 2, w: 8, h: 4 }, kind: 'redact' } }),
      mitDoc(),
    );
    expect(e.text).toContain('Bescheid.pdf');
    expect(e.text).toContain('3');
    expect(e.ziel).toEqual({ docId: 'doc-a', page: 3, rect: { x: 1, y: 2, w: 8, h: 4 } });
  });

  it('addStamp: Ziel bekommt ein abgeleitetes Rechteck um den Mittelpunkt', () => {
    const e = beschreibe(
      eintrag('addStamp', { stamp: { docId: 'doc-a', page: 2, x: 100, y: 200, text: 'FRIST!' } }),
      mitDoc(),
    );
    expect(e.ziel?.docId).toBe('doc-a');
    expect(e.ziel?.page).toBe(2);
    expect(e.ziel?.rect).toBeDefined();
    expect(e.text).toContain('FRIST!');
  });

  it('addCutout: Ausschnitt im Zustand liefert den fileId-Anker', () => {
    let s = mitDoc();
    s = { ...s, cutouts: [{ id: 'cut-1', fileId: 'file-a', page: 4, rect: { x: 0, y: 0, w: 5, h: 5 }, position: { x: 0, y: 0 }, zIndex: 1 }] };
    const e = beschreibe(eintrag('addCutout', { docId: 'doc-a', page: 4, id: 'cut-1' }), s);
    expect(e.ziel?.fileId).toBe('file-a');
  });

  it('addMark: unvollständiges rect (fehlende/ungültige Zahl) wird verworfen statt NaN in ziel zu übernehmen', () => {
    const e = beschreibe(
      eintrag('addMark', { mark: { docId: 'doc-a', page: 3, rect: { x: 1, y: 2, w: 'acht', h: 4 }, kind: 'redact' } }),
      mitDoc(),
    );
    expect(e.ziel).toEqual({ docId: 'doc-a', page: 3 });
  });

  it('addMark: Quelle liegt im Papierkorb (nicht endgültig weg) — Name UND Ziel bleiben, Klick soll Papierkorb-Hinweis auslösen', () => {
    let s = mitDoc();
    s = trashObject(s, 'doc-a', '2026-07-20T00:00:00.000Z', 'trash-1');
    const e = beschreibe(
      eintrag('addMark', { mark: { docId: 'doc-a', page: 2, rect: { x: 1, y: 2, w: 8, h: 4 }, kind: 'redact' } }),
      s,
    );
    expect(e.text).toContain('Bescheid.pdf');
    expect(e.ziel).toEqual({ docId: 'doc-a', page: 2, rect: { x: 1, y: 2, w: 8, h: 4 } });
  });

  it('gelöschtes Dokument: erklärender Text, kein Ziel', () => {
    const e = beschreibe(eintrag('addMark', { mark: { docId: 'weg-999', page: 1, kind: 'redact' } }), emptyState());
    expect(e.text).toContain('entferntes Dokument');
    expect(e.ziel).toBeUndefined();
  });

  it('CR-03: addMark(redact) mit textSnapshot erzeugt NIE ein Zitat — echte Schwärzung darf nicht durchsickern', () => {
    const lang = 'A'.repeat(400);
    const e = beschreibe(
      eintrag('addMark', { mark: { docId: 'doc-a', page: 1, kind: 'redact', textSnapshot: lang } }),
      mitDoc(),
    );
    expect(e.zitat).toBeUndefined();
  });

  it('CR-03: addMark(tippex) mit textSnapshot erzeugt ebenfalls NIE ein Zitat (istEchteSchwaerzung gilt für beide Arten)', () => {
    const e = beschreibe(
      eintrag('addMark', { mark: { docId: 'doc-a', page: 1, kind: 'tippex', textSnapshot: 'geheimer Text' } }),
      mitDoc(),
    );
    expect(e.zitat).toBeUndefined();
  });

  it('Systemereignis: kein Sprungziel, eigener Text', () => {
    const e = beschreibe(eintrag('snapshot', { state: '…' }), mitDoc());
    expect(e.ziel).toBeUndefined();
    expect(e.text.length).toBeGreaterThan(0);
  });

  it('unbekannter Typ: generischer Text statt Absturz', () => {
    const e = beschreibe(eintrag('quantenSprung', { irgendwas: 1 }), mitDoc());
    expect(e.text.length).toBeGreaterThan(0);
    expect(e.ziel).toBeUndefined();
  });

  it('payload null bricht nicht', () => {
    expect(() => beschreibe(eintrag('emptyTrash', null), mitDoc())).not.toThrow();
  });
});

describe('beschreibe: stateRestored', () => {
  it('mit targetAt liefert Text „Stand vom …" mit dem formatierten Zeitpunkt', () => {
    const targetAt = 1_700_000_000_000;
    const e = beschreibe(eintrag('stateRestored', { targetAt, targetEntryId: 7 }), mitDoc());
    expect(e.text.startsWith('Stand vom ')).toBe(true);
    expect(e.text.endsWith(' wiederhergestellt')).toBe(true);
    expect(e.text).toContain(zeitpunktLang(targetAt));
  });

  it('ohne verwertbares targetAt liefert den Ersatztext ohne erfundenes Datum', () => {
    const e = beschreibe(eintrag('stateRestored', { targetEntryId: 7 }), mitDoc());
    expect(e.text).toBe('Stand von einem früheren Zeitpunkt wiederhergestellt');
  });

  it('setzt badge auf ↺ mit dem Akteur im Titel', () => {
    const e = beschreibe(eintrag('stateRestored', { targetAt: 1_700_000_000_000 }), mitDoc());
    expect(e.badge).toEqual({ icon: '↺', titel: 'Wiederhergestellt von Patrick' });
  });
});

describe('beschreibe: exported', () => {
  it('format "dokument" liefert „Übergabe erzeugt — Annotierte PDF-Kopie"', () => {
    const e = beschreibe(eintrag('exported', { format: 'dokument' }), mitDoc());
    expect(e.text).toBe('Übergabe erzeugt — Annotierte PDF-Kopie');
  });

  it('format "jdesk" liefert „Übergabe erzeugt — Arbeitsstand (.jdesk)"', () => {
    const e = beschreibe(eintrag('exported', { format: 'jdesk' }), mitDoc());
    expect(e.text).toBe('Übergabe erzeugt — Arbeitsstand (.jdesk)');
  });

  it('unbekannte Format-Kennung erscheint unverändert im Text', () => {
    const e = beschreibe(eintrag('exported', { format: 'gibtEsNicht' }), mitDoc());
    expect(e.text).toBe('Übergabe erzeugt — gibtEsNicht');
  });

  it('setzt badge auf 📤 mit dem Akteur im Titel', () => {
    const e = beschreibe(eintrag('exported', { format: 'dokument' }), mitDoc());
    expect(e.badge).toEqual({ icon: '📤', titel: 'Übergabe erzeugt von Patrick' });
  });
});

describe('beschreibe: Bestandstypen tragen weiterhin kein badge', () => {
  it('moveDoc, addMark, snapshot liefern badge === undefined', () => {
    expect(beschreibe(eintrag('moveDoc', { id: 'doc-a' }), mitDoc()).badge).toBeUndefined();
    expect(
      beschreibe(eintrag('addMark', { mark: { docId: 'doc-a', page: 1, kind: 'redact' } }), mitDoc()).badge,
    ).toBeUndefined();
    expect(beschreibe(eintrag('snapshot', { state: '…' }), mitDoc()).badge).toBeUndefined();
  });
});

describe('beschreibe: stateRestored/exported — Vertraulichkeit (P-09)', () => {
  it('stateRestored: Fremdinhalte im Payload (state, text) landen weder als Zitat noch als Sprungziel noch im Text', () => {
    const e = beschreibe(
      eintrag('stateRestored', {
        targetAt: 1_700_000_000_000,
        targetEntryId: 7,
        state: 'Bescheid.pdf — geheimer Aktenstand',
        text: 'interner Vermerk',
        textSnapshot: 'überdeckter Originaltext',
      }),
      mitDoc(),
    );
    expect(Object.keys(e).sort()).toEqual(['akteur', 'badge', 'id', 'text', 'zeit'].sort());
    expect(e.text).not.toContain('geheimer Aktenstand');
    expect(e.text).not.toContain('interner Vermerk');
    expect(e.text).not.toContain('überdeckter Originaltext');
  });

  it('exported: Fremdinhalte im Payload (state, text) landen weder als Zitat noch als Sprungziel noch im Text', () => {
    const e = beschreibe(
      eintrag('exported', {
        format: 'dokument',
        state: 'Bescheid.pdf — geheimer Aktenstand',
        text: 'interner Vermerk',
        textSnapshot: 'überdeckter Originaltext',
      }),
      mitDoc(),
    );
    expect(Object.keys(e).sort()).toEqual(['akteur', 'badge', 'id', 'text', 'zeit'].sort());
    expect(e.text).not.toContain('geheimer Aktenstand');
    expect(e.text).not.toContain('interner Vermerk');
    expect(e.text).not.toContain('überdeckter Originaltext');
  });
});

describe('beschreibe: stateRestored/exported — Rückfallverhalten (P-08)', () => {
  it('stateRestored mit payload: null liefert den Ersatztext, kein NaN, kein Invalid Date', () => {
    const e = beschreibe(eintrag('stateRestored', null), mitDoc());
    expect(e.text).toBe('Stand von einem früheren Zeitpunkt wiederhergestellt');
    expect(e.text).not.toContain('NaN');
    expect(e.text).not.toContain('Invalid Date');
    expect(e.badge).toEqual({ icon: '↺', titel: 'Wiederhergestellt von Patrick' });
  });

  it('stateRestored mit payload: {} liefert den Ersatztext', () => {
    const e = beschreibe(eintrag('stateRestored', {}), mitDoc());
    expect(e.text).toBe('Stand von einem früheren Zeitpunkt wiederhergestellt');
    expect(e.text).not.toContain('NaN');
    expect(e.text).not.toContain('Invalid Date');
    expect(e.badge).toBeDefined();
  });

  it('stateRestored mit targetAt vom falschen Typ (String) liefert den Ersatztext', () => {
    const e = beschreibe(eintrag('stateRestored', { targetAt: 'gestern' }), mitDoc());
    expect(e.text).toBe('Stand von einem früheren Zeitpunkt wiederhergestellt');
    expect(e.text).not.toContain('NaN');
    expect(e.text).not.toContain('Invalid Date');
    expect(e.badge).toBeDefined();
  });

  it('exported mit payload: {} liefert einen Text, der auf „Übergabe" endet', () => {
    const e = beschreibe(eintrag('exported', {}), mitDoc());
    expect(e.text.endsWith('Übergabe')).toBe(true);
    expect(e.badge).toEqual({ icon: '📤', titel: 'Übergabe erzeugt von Patrick' });
  });
});

describe('beschreibe: vorschlagGenehmigt (KI-Historie, AI-02)', () => {
  const genehmigung = (payload: unknown) => ({
    id: 9, rev: 12, type: 'vorschlagGenehmigt', payload, actorId: 'u2', actorName: 'Anwältin', at: 1_700_000_100_000,
  });

  it('übersetzt zu „KI-Vorschlag übernommen — {art-Klartext}" mit 🤖-Badge und Doppelstempel im title', () => {
    // CR-02: der Text kommt aus der art (byte-genau generisch über TEXTE), nicht mehr aus
    // der Register-zusammenfassung (die kann Privatinhalt tragen).
    const e = beschreibe(
      genehmigung({ vorschlagId: 'v1', art: 'addLink', kiAkteur: 'MCP-Konto', approvedBy: 'Anwältin' }),
      mitDoc(),
    );
    expect(e.text).toBe('KI-Vorschlag übernommen — Verknüpfung gezogen');
    expect(e.badge).toEqual({ icon: '🤖', titel: 'KI-Vorschlag von MCP-Konto, übernommen von Anwältin' });
  });

  it('Alt-Marker mit zusammenfassung wird NICHT mehr ausgespielt (CR-02: der Schnipsel kann Privatinhalt tragen)', () => {
    const e = beschreibe(
      genehmigung({ vorschlagId: 'v1', kiAkteur: 'MCP-Konto', approvedBy: 'Anwältin', zusammenfassung: 'Geheimer Privatschnipsel' }),
      mitDoc(),
    );
    expect(e.text).toBe('KI-Vorschlag übernommen — Änderung');
    expect(e.text).not.toContain('Geheimer Privatschnipsel');
  });

  it('fehlende art fällt auf „Änderung" zurück (kein „undefined" im Klartext)', () => {
    const e = beschreibe(genehmigung({ vorschlagId: 'v1', kiAkteur: 'MCP-Konto', approvedBy: 'Anwältin' }), mitDoc());
    expect(e.text).toBe('KI-Vorschlag übernommen — Änderung');
    expect(e.text).not.toContain('undefined');
  });

  it('fehlender kiAkteur fällt im Badge-title auf „unbekannt" zurück', () => {
    const e = beschreibe(genehmigung({ vorschlagId: 'v1', art: 'addNote' }), mitDoc());
    expect(e.text).toBe('KI-Vorschlag übernommen — Zettel geschrieben');
    expect(e.badge).toEqual({ icon: '🤖', titel: 'KI-Vorschlag von unbekannt, übernommen von Anwältin' });
  });
});

describe('beschreibe: vorschlagZurueckgenommen (KI-Historie, AI-02)', () => {
  const ruecknahme = (payload: unknown) => ({
    id: 10, rev: 13, type: 'vorschlagZurueckgenommen', payload, actorId: 'u2', actorName: 'Anwältin', at: 1_700_000_200_000,
  });

  it('übersetzt zu „{Genehmiger} nahm die KI-Übernahme zurück: {art-Klartext}" mit 🤖-Badge (kein eigenes Glyphen)', () => {
    const e = beschreibe(
      ruecknahme({ vorschlagId: 'v1', art: 'trashObject', kiAkteur: 'MCP-Konto', approvedBy: 'Anwältin' }),
      mitDoc(),
    );
    expect(e.text).toBe('Anwältin nahm die KI-Übernahme zurück: in den Papierkorb gelegt');
    expect(e.badge).toEqual({ icon: '🤖', titel: 'Rücknahme einer KI-Aktion — journalierter Vorgang' });
  });

  it('Alt-Marker mit zusammenfassung wird NICHT mehr ausgespielt (CR-02)', () => {
    const e = beschreibe(ruecknahme({ vorschlagId: 'v1', zusammenfassung: 'Geheimer Privatschnipsel' }), mitDoc());
    expect(e.text).toBe('Anwältin nahm die KI-Übernahme zurück: Änderung');
    expect(e.text).not.toContain('Geheimer Privatschnipsel');
  });

  it('fehlende zusammenfassung fällt auf „Änderung" zurück', () => {
    const e = beschreibe(ruecknahme({ vorschlagId: 'v1' }), mitDoc());
    expect(e.text).toBe('Anwältin nahm die KI-Übernahme zurück: Änderung');
    expect(e.text).not.toContain('undefined');
  });
});

describe('beschreibe: KI-Einträge — strukturelle Badge-Reihenfolge (Verwechslungsverbot)', () => {
  it('beide KI-Zweige setzen das badge-Feld wie stateRestored (Render-Reihenfolge: Badge VOR dem Klartext)', () => {
    const g = beschreibe(
      { id: 9, rev: 12, type: 'vorschlagGenehmigt', payload: { vorschlagId: 'v1', kiAkteur: 'MCP-Konto', zusammenfassung: 'X' }, actorId: 'u2', actorName: 'Anwältin', at: 1_700_000_100_000 },
      mitDoc(),
    );
    const r = beschreibe(
      { id: 10, rev: 13, type: 'vorschlagZurueckgenommen', payload: { vorschlagId: 'v1', zusammenfassung: 'X' }, actorId: 'u2', actorName: 'Anwältin', at: 1_700_000_200_000 },
      mitDoc(),
    );
    // Gleiche Struktur wie die Bestands-Badges: icon+titel-Paar, kein Zitat, kein Sprungziel.
    for (const e of [g, r]) {
      expect(e.badge?.icon).toBe('🤖');
      expect(typeof e.badge?.titel).toBe('string');
      expect(e.zitat).toBeUndefined();
      expect(e.ziel).toBeUndefined();
    }
  });
});

describe('beschreibe: Regressionsschutz TEXTE-Tabelle', () => {
  it('liefert für jeden bestehenden Typ in TEXTE weiterhin nicht-leeren Text ohne badge', () => {
    for (const typ of Object.keys(TEXTE)) {
      const e = beschreibe(eintrag(typ, {}), mitDoc());
      expect(e.text.length).toBeGreaterThan(0);
      expect(e.badge).toBeUndefined();
    }
  });
});
