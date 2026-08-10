import { describe, expect, it } from 'vitest';
import { applyCommand, CommandError } from './commands';
import { emptyState } from './model';
import { addDoc } from './documents';
import { addNote } from './notes';
import { valideExternRef, EXTERN_ARTEN } from './extern';

/**
 * ExternRef-Kern (EXT-01, 13-02 Task 2, Vorentscheidung U3): die externe-Referenz-Markierung
 * ist ein deklaratives FELD auf Doc/Note — bewusst KEIN neuer Objekttyp. Der Validator
 * (art-Whitelist + Protokoll-Bremse https? gegen den javascript:-Vektor, T-13-02-03/ASVS V5)
 * läuft im Kommandopfad; das Feld ist niemals rechte-relevant.
 */

describe('EXTERN_ARTEN', () => {
  it('enthält genau die sieben Arten in kanonischer Reihenfolge', () => {
    expect(EXTERN_ARTEN).toEqual(['weblink', 'urteil', 'norm', 'email', 'foto', 'medien', 'textfragment']);
  });
});

describe('valideExternRef', () => {
  it('akzeptiert einen Weblink mit https-URL', () => {
    expect(valideExternRef({ art: 'weblink', url: 'https://beispiel.de/x' }))
      .toEqual({ art: 'weblink', url: 'https://beispiel.de/x' });
  });

  it('akzeptiert ein Urteil mit Quellenangabe ohne URL', () => {
    expect(valideExternRef({ art: 'urteil', quelle: 'BGH, VI ZR 1/23' }))
      .toEqual({ art: 'urteil', quelle: 'BGH, VI ZR 1/23' });
  });

  it('lässt undefined (und null aus JSON) als undefined — das Feld ist optional', () => {
    expect(valideExternRef(undefined)).toBeUndefined();
    expect(valideExternRef(null)).toBeUndefined();
  });

  it('wirft CommandError bei unbekannter art', () => {
    expect(() => valideExternRef({ art: 'rss', url: 'https://x.de' })).toThrow(CommandError);
    expect(() => valideExternRef({ art: 'rss' })).toThrow(/Feld "extern\.art"/);
  });

  it('wirft CommandError bei url ohne http/https-Protokoll (javascript:-Vektor, ftp, schemalos)', () => {
    for (const url of ['javascript:alert(1)', 'ftp://x', 'example.com']) {
      expect(() => valideExternRef({ art: 'weblink', url }), url).toThrow(CommandError);
      expect(() => valideExternRef({ art: 'weblink', url }), url)
        .toThrow(/Feld "extern\.url" muss mit http:\/\/ oder https:\/\/ beginnen/);
    }
  });

  it('wirft CommandError bei Nicht-String-quelle', () => {
    expect(() => valideExternRef({ art: 'urteil', quelle: 42 })).toThrow(CommandError);
    expect(() => valideExternRef({ art: 'urteil', quelle: 42 })).toThrow(/Feld "extern\.quelle"/);
  });

  it('wirft CommandError bei Nicht-Objekt-Eingabe', () => {
    expect(() => valideExternRef('weblink')).toThrow(CommandError);
    expect(() => valideExternRef(['weblink'])).toThrow(CommandError);
  });
});

describe('extern-Payload im Kommandopfad', () => {
  it('addNote mit extern speichert die Referenz am Objekt', () => {
    const s = applyCommand(emptyState(), {
      type: 'addNote',
      payload: {
        id: 'n1', kind: 'notiz', text: 'Vgl. BGH', position: { x: 0, y: 0 },
        extern: { art: 'urteil', quelle: 'BGH, VI ZR 1/23' },
      },
    });
    expect(s.notes![0].extern).toEqual({ art: 'urteil', quelle: 'BGH, VI ZR 1/23' });
  });

  it('addNote ohne extern erzeugt KEIN extern-Feld (undefined, nicht null)', () => {
    const s = applyCommand(emptyState(), {
      type: 'addNote',
      payload: { id: 'n1', kind: 'notiz', text: 'normal', position: { x: 0, y: 0 } },
    });
    expect(s.notes![0].extern).toBeUndefined();
    expect('extern' in s.notes![0]).toBe(false);
  });

  it('addDoc mit extern speichert die Referenz am Objekt', () => {
    const s = applyCommand(emptyState(), {
      type: 'addDoc',
      payload: {
        fileId: 'f1', name: 'foto.jpg', position: { x: 0, y: 0 }, id: 'd1', kind: 'image',
        extern: { art: 'foto', quelle: 'Mandant Handy' },
      },
    });
    expect(s.docs[0].extern).toEqual({ art: 'foto', quelle: 'Mandant Handy' });
  });

  it('addDoc ohne extern bleibt feldlos', () => {
    const s = applyCommand(emptyState(), {
      type: 'addDoc',
      payload: { fileId: 'f1', name: 'a.pdf', position: { x: 0, y: 0 }, id: 'd1' },
    });
    expect(s.docs[0].extern).toBeUndefined();
    expect('extern' in s.docs[0]).toBe(false);
  });

  it('editNote mit extern setzt/ersetzt die Markierung', () => {
    let s = addNote(emptyState(), 'notiz', 'x', { x: 0, y: 0 }, 'n1');
    s = applyCommand(s, {
      type: 'editNote',
      payload: { id: 'n1', text: 'y', extern: { art: 'weblink', url: 'https://gesetze.de/norm' } },
    });
    expect(s.notes![0].extern).toEqual({ art: 'weblink', url: 'https://gesetze.de/norm' });
  });

  it('editNote OHNE extern im Payload lässt eine bestehende Markierung unverändert (kein implizites Löschen)', () => {
    let s = applyCommand(emptyState(), {
      type: 'addNote',
      payload: {
        id: 'n1', kind: 'notiz', text: 'x', position: { x: 0, y: 0 },
        extern: { art: 'norm', quelle: '§ 823 BGB' },
      },
    });
    s = applyCommand(s, { type: 'editNote', payload: { id: 'n1', text: 'überarbeitet' } });
    expect(s.notes![0].text).toBe('überarbeitet');
    expect(s.notes![0].extern).toEqual({ art: 'norm', quelle: '§ 823 BGB' });
  });

  it('ungültiges extern-Payload im Kommandopfad wirft CommandError (Validator-Position im Handler)', () => {
    expect(() =>
      applyCommand(emptyState(), {
        type: 'addNote',
        payload: {
          id: 'n1', kind: 'notiz', text: 'x', position: { x: 0, y: 0 },
          extern: { art: 'weblink', url: 'javascript:alert(1)' },
        },
      }),
    ).toThrow(CommandError);
  });
});

describe('Alt-States-Verträglichkeit (Additive-Only)', () => {
  it('Objekte ohne extern-Feld bleiben nach beliebigen Kommandos feldlos', () => {
    // Alt-Bestand simulieren: direkt über die Domänenfunktionen, ohne extern.
    let s = addDoc(emptyState(), 'f1', 'alt.pdf', { x: 0, y: 0 }, 'd1');
    s = addNote(s, 'notiz', 'alt', { x: 1, y: 1 }, 'n1');

    s = applyCommand(s, { type: 'editNote', payload: { id: 'n1', text: 'bearbeitet' } });
    s = applyCommand(s, { type: 'moveDoc', payload: { id: 'd1', position: { x: 9, y: 9 } } });

    expect('extern' in s.notes![0]).toBe(false);
    expect('extern' in s.docs[0]).toBe(false);
  });
});
