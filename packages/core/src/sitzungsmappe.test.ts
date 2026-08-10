import { describe, it, expect } from 'vitest';
import { emptyState, isValidState, type DesktopState } from './model';
import { addDoc } from './documents';
import { addFlag, FLAG_COLORS } from './flags';
import { applyCommand, CommandError } from './commands';
import { projectStateForActor, type ActorContext } from './projection';
import type { Ebene } from './layers';
import {
  addSitzungsmappe, addSitzungsmappeDoc, findSitzungsmappe, aktuelleSitzungsmappe,
  sprungmarkenFuerSitzungsmappe, renameSitzungsmappe, removeSitzungsmappe, removeSitzungsmappeDoc,
  verschiebeSitzungsmappeDoc, addOffeneFrage, setOffeneFrageText, setOffeneFrageBeantwortet,
  removeOffeneFrage, agendaZeilen,
} from './sitzungsmappe';
import { trashObject } from './trash';

function tisch(): DesktopState {
  let s = emptyState();
  s = addDoc(s, 'f1', 'Erstes.pdf', { x: 0, y: 0 }, 'd1');
  s = addDoc(s, 'f2', 'Zweites.pdf', { x: 10, y: 0 }, 'd2');
  return s;
}

describe('addSitzungsmappe', () => {
  it('erzeugt einen Eintrag mit id, titel, leerem docIds/offeneFragen und Provenienz aus meta', () => {
    const meta = { createdBy: 'Frau Meier', createdAt: '2026-08-07T10:00:00.000Z' };
    const s = addSitzungsmappe(emptyState(), 'Termin 14.08.', 'sm1', meta);
    expect(s.sitzungsmappen).toHaveLength(1);
    const m = s.sitzungsmappen![0];
    expect(m).toMatchObject({
      id: 'sm1', titel: 'Termin 14.08.', docIds: [], offeneFragen: [],
      createdBy: 'Frau Meier', createdAt: meta.createdAt,
    });
  });

  it('funktioniert auf einem alten State ohne sitzungsmappen-Feld', () => {
    const alt = emptyState();
    delete (alt as { sitzungsmappen?: unknown }).sitzungsmappen;
    expect(addSitzungsmappe(alt, 'Termin', 'sm1').sitzungsmappen).toHaveLength(1);
  });
});

describe('addSitzungsmappeDoc', () => {
  it('hängt eine docId an', () => {
    let s = addSitzungsmappe(tisch(), 'Termin', 'sm1');
    s = addSitzungsmappeDoc(s, 'sm1', 'd1');
    expect(findSitzungsmappe(s, 'sm1')?.docIds).toEqual(['d1']);
  });

  it('ist idempotent: eine bereits vorhandene docId liefert exakt denselben State (Referenzgleichheit) und verlängert docIds nicht', () => {
    let s = addSitzungsmappe(tisch(), 'Termin', 'sm1');
    s = addSitzungsmappeDoc(s, 'sm1', 'd1');
    const nochmal = addSitzungsmappeDoc(s, 'sm1', 'd1');
    expect(nochmal).toBe(s);
    expect(findSitzungsmappe(nochmal, 'sm1')?.docIds).toEqual(['d1']);
  });

  it('wirft, wenn die Sitzungsmappe-id unbekannt ist', () => {
    expect(() => addSitzungsmappeDoc(tisch(), 'gibt-es-nicht', 'd1')).toThrow('nicht gefunden');
  });
});

describe('sprungmarkenFuerSitzungsmappe', () => {
  it('liefert für eine leere Agenda ein leeres Array', () => {
    const s = addSitzungsmappe(tisch(), 'Termin', 'sm1');
    const mappe = findSitzungsmappe(s, 'sm1')!;
    expect(sprungmarkenFuerSitzungsmappe(s, mappe)).toEqual([]);
  });

  it('liefert Fahnen in Agenda-Reihenfolge der Dokumente, je Dokument nach Seite aufsteigend, bei Gleichstand stabil nach Flag-id', () => {
    let s = tisch();
    s = addFlag(s, { id: 'f-d2-p2', docId: 'd2', page: 2, offset: 0.1, color: FLAG_COLORS[0] });
    s = addFlag(s, { id: 'f-d1-p3', docId: 'd1', page: 3, offset: 0.1, color: FLAG_COLORS[0] });
    s = addFlag(s, { id: 'f-d1-p1-b', docId: 'd1', page: 1, offset: 0.2, color: FLAG_COLORS[1] });
    s = addFlag(s, { id: 'f-d1-p1-a', docId: 'd1', page: 1, offset: 0.3, color: FLAG_COLORS[2] });
    s = addSitzungsmappe(s, 'Termin', 'sm1');
    s = addSitzungsmappeDoc(s, 'sm1', 'd2'); // Agenda-Reihenfolge: d2 zuerst
    s = addSitzungsmappeDoc(s, 'sm1', 'd1');
    const mappe = findSitzungsmappe(s, 'sm1')!;
    const marken = sprungmarkenFuerSitzungsmappe(s, mappe);
    expect(marken.map((f) => f.id)).toEqual(['f-d2-p2', 'f-d1-p1-a', 'f-d1-p1-b', 'f-d1-p3']);
  });
});

describe('aktuelleSitzungsmappe', () => {
  it('liefert auf einem State ohne Sitzungsmappen undefined', () => {
    expect(aktuelleSitzungsmappe(tisch())).toBeUndefined();
  });

  it('liefert die zuletzt angelegte', () => {
    let s = addSitzungsmappe(tisch(), 'Erste', 'sm1');
    s = addSitzungsmappe(s, 'Zweite', 'sm2');
    expect(aktuelleSitzungsmappe(s)?.id).toBe('sm2');
  });
});

describe('renameSitzungsmappe', () => {
  it('ändert nur den Titel und lässt Agenda und Fragen unberührt', () => {
    let s = addSitzungsmappe(tisch(), 'Termin', 'sm1');
    s = addSitzungsmappeDoc(s, 'sm1', 'd1');
    s = addOffeneFrage(s, 'sm1', 'Streitwert?', 'f1');
    const umbenannt = renameSitzungsmappe(s, 'sm1', 'Neuer Titel');
    const m = findSitzungsmappe(umbenannt, 'sm1')!;
    expect(m.titel).toBe('Neuer Titel');
    expect(m.docIds).toEqual(['d1']);
    expect(m.offeneFragen).toEqual([{ id: 'f1', text: 'Streitwert?', beantwortet: false }]);
  });

  it('wirft, wenn die id unbekannt ist', () => {
    expect(() => renameSitzungsmappe(tisch(), 'gibt-es-nicht', 'Neu')).toThrow('nicht gefunden');
  });
});

describe('removeSitzungsmappe', () => {
  it('entfernt genau eine Mappe und lässt die übrigen stehen', () => {
    let s = addSitzungsmappe(tisch(), 'Erste', 'sm1');
    s = addSitzungsmappe(s, 'Zweite', 'sm2');
    const nachEntfernen = removeSitzungsmappe(s, 'sm1');
    expect(findSitzungsmappe(nachEntfernen, 'sm1')).toBeUndefined();
    expect(findSitzungsmappe(nachEntfernen, 'sm2')?.titel).toBe('Zweite');
  });

  it('wirft, wenn die id unbekannt ist', () => {
    expect(() => removeSitzungsmappe(tisch(), 'gibt-es-nicht')).toThrow('nicht gefunden');
  });
});

describe('removeSitzungsmappeDoc', () => {
  it('entfernt die docId aus der Agenda', () => {
    let s = addSitzungsmappe(tisch(), 'Termin', 'sm1');
    s = addSitzungsmappeDoc(s, 'sm1', 'd1');
    s = addSitzungsmappeDoc(s, 'sm1', 'd2');
    const nach = removeSitzungsmappeDoc(s, 'sm1', 'd1');
    expect(findSitzungsmappe(nach, 'sm1')?.docIds).toEqual(['d2']);
  });

  it('ist ein No-op mit Referenzgleichheit, wenn die docId nicht (mehr) in der Agenda steht', () => {
    let s = addSitzungsmappe(tisch(), 'Termin', 'sm1');
    s = addSitzungsmappeDoc(s, 'sm1', 'd1');
    const entfernt = removeSitzungsmappeDoc(s, 'sm1', 'd1');
    const nochmal = removeSitzungsmappeDoc(entfernt, 'sm1', 'd1');
    expect(nochmal).toBe(entfernt);
  });

  it('wirft, wenn die Sitzungsmappe-id unbekannt ist', () => {
    expect(() => removeSitzungsmappeDoc(tisch(), 'gibt-es-nicht', 'd1')).toThrow('nicht gefunden');
  });
});

describe('verschiebeSitzungsmappeDoc', () => {
  function mitDreiDocs(): DesktopState {
    let s = addSitzungsmappe(tisch(), 'Termin', 'sm1');
    s = addSitzungsmappeDoc(s, 'sm1', 'd1');
    s = addSitzungsmappeDoc(s, 'sm1', 'd2');
    return s;
  }

  it('richtung -1 tauscht den Eintrag mit seinem Vorgänger', () => {
    const s = verschiebeSitzungsmappeDoc(mitDreiDocs(), 'sm1', 'd2', -1);
    expect(findSitzungsmappe(s, 'sm1')?.docIds).toEqual(['d2', 'd1']);
  });

  it('richtung +1 tauscht den Eintrag mit seinem Nachfolger', () => {
    const s = verschiebeSitzungsmappeDoc(mitDreiDocs(), 'sm1', 'd1', 1);
    expect(findSitzungsmappe(s, 'sm1')?.docIds).toEqual(['d2', 'd1']);
  });

  it('ist ein No-op, wenn der erste Eintrag nach oben verschoben wird', () => {
    const s = mitDreiDocs();
    const nach = verschiebeSitzungsmappeDoc(s, 'sm1', 'd1', -1);
    expect(nach).toBe(s);
  });

  it('ist ein No-op, wenn der letzte Eintrag nach unten verschoben wird', () => {
    const s = mitDreiDocs();
    const nach = verschiebeSitzungsmappeDoc(s, 'sm1', 'd2', 1);
    expect(nach).toBe(s);
  });

  it('ist ein No-op für eine docId, die nicht in der Agenda steht', () => {
    const s = mitDreiDocs();
    const nach = verschiebeSitzungsmappeDoc(s, 'sm1', 'gibt-es-nicht', 1);
    expect(nach).toBe(s);
  });

  it('bei genau einem Agenda-Eintrag sind beide Richtungen No-ops', () => {
    let s = addSitzungsmappe(tisch(), 'Termin', 'sm1');
    s = addSitzungsmappeDoc(s, 'sm1', 'd1');
    expect(verschiebeSitzungsmappeDoc(s, 'sm1', 'd1', -1)).toBe(s);
    expect(verschiebeSitzungsmappeDoc(s, 'sm1', 'd1', 1)).toBe(s);
  });
});

describe('addOffeneFrage', () => {
  it('hängt eine Zeile mit eigener id an', () => {
    const s = addOffeneFrage(addSitzungsmappe(tisch(), 'Termin', 'sm1'), 'sm1', 'Streitwert?', 'f1');
    expect(findSitzungsmappe(s, 'sm1')?.offeneFragen).toEqual([{ id: 'f1', text: 'Streitwert?', beantwortet: false }]);
  });

  it('zwei Zeilen mit identischem Text bleiben zwei Einträge mit verschiedenen ids', () => {
    let s = addSitzungsmappe(tisch(), 'Termin', 'sm1');
    s = addOffeneFrage(s, 'sm1', 'Dieselbe Frage', 'f1');
    s = addOffeneFrage(s, 'sm1', 'Dieselbe Frage', 'f2');
    const fragen = findSitzungsmappe(s, 'sm1')!.offeneFragen;
    expect(fragen.map((f) => f.id)).toEqual(['f1', 'f2']);
    expect(fragen.every((f) => f.text === 'Dieselbe Frage')).toBe(true);
  });

  it('akzeptiert einen leeren Text (leere Zeile zum späteren Befüllen)', () => {
    const s = addOffeneFrage(addSitzungsmappe(tisch(), 'Termin', 'sm1'), 'sm1', '', 'f1');
    expect(findSitzungsmappe(s, 'sm1')?.offeneFragen[0].text).toBe('');
  });
});

describe('setOffeneFrageText', () => {
  it('ersetzt den Text unverändert und ohne Kürzung, auch bei sehr langem Text und Sonderzeichen', () => {
    let s = addSitzungsmappe(tisch(), 'Termin', 'sm1');
    s = addOffeneFrage(s, 'sm1', 'Alt', 'f1');
    const langerText = `${'x'.repeat(5000)}\nZeile zwei — „Anführungszeichen" & <tags>`;
    s = setOffeneFrageText(s, 'sm1', 'f1', langerText);
    expect(findSitzungsmappe(s, 'sm1')?.offeneFragen[0].text).toBe(langerText);
  });

  it('wirft, wenn die Frage-id unbekannt ist', () => {
    const s = addSitzungsmappe(tisch(), 'Termin', 'sm1');
    expect(() => setOffeneFrageText(s, 'sm1', 'gibt-es-nicht', 'x')).toThrow('nicht gefunden');
  });
});

describe('setOffeneFrageBeantwortet', () => {
  it('setzt das Häkchen', () => {
    let s = addSitzungsmappe(tisch(), 'Termin', 'sm1');
    s = addOffeneFrage(s, 'sm1', 'Frage', 'f1');
    s = setOffeneFrageBeantwortet(s, 'sm1', 'f1', true);
    expect(findSitzungsmappe(s, 'sm1')?.offeneFragen[0].beantwortet).toBe(true);
  });

  it('zweimal denselben Wert zu setzen ändert am Ergebnis nichts', () => {
    let s = addSitzungsmappe(tisch(), 'Termin', 'sm1');
    s = addOffeneFrage(s, 'sm1', 'Frage', 'f1');
    s = setOffeneFrageBeantwortet(s, 'sm1', 'f1', true);
    s = setOffeneFrageBeantwortet(s, 'sm1', 'f1', true);
    expect(findSitzungsmappe(s, 'sm1')?.offeneFragen[0].beantwortet).toBe(true);
  });

  it('wirft, wenn die Frage-id unbekannt ist', () => {
    const s = addSitzungsmappe(tisch(), 'Termin', 'sm1');
    expect(() => setOffeneFrageBeantwortet(s, 'sm1', 'gibt-es-nicht', true)).toThrow('nicht gefunden');
  });
});

describe('removeOffeneFrage', () => {
  it('entfernt genau die Zeile mit der übergebenen id', () => {
    let s = addSitzungsmappe(tisch(), 'Termin', 'sm1');
    s = addOffeneFrage(s, 'sm1', 'Erste', 'f1');
    s = addOffeneFrage(s, 'sm1', 'Zweite', 'f2');
    s = removeOffeneFrage(s, 'sm1', 'f1');
    expect(findSitzungsmappe(s, 'sm1')?.offeneFragen.map((f) => f.id)).toEqual(['f2']);
  });

  it('wirft, wenn die Frage-id unbekannt ist', () => {
    const s = addSitzungsmappe(tisch(), 'Termin', 'sm1');
    expect(() => removeOffeneFrage(s, 'sm1', 'gibt-es-nicht')).toThrow('nicht gefunden');
  });
});

describe('agendaZeilen', () => {
  it('liefert je docId Name und Verfügbarkeit; ein vorhandenes Dokument gilt als verfügbar', () => {
    let s = addSitzungsmappe(tisch(), 'Termin', 'sm1');
    s = addSitzungsmappeDoc(s, 'sm1', 'd1');
    const mappe = findSitzungsmappe(s, 'sm1')!;
    expect(agendaZeilen(s, mappe)).toEqual([{ docId: 'd1', name: 'Erstes.pdf', verfuegbar: true, imPapierkorb: false }]);
  });

  it('ein in den Papierkorb verschobenes Dokument gilt als nicht verfügbar, aber im Papierkorb, mit Namen aus dem Korb-Eintrag', () => {
    let s = addSitzungsmappe(tisch(), 'Termin', 'sm1');
    s = addSitzungsmappeDoc(s, 'sm1', 'd1');
    s = trashObject(s, 'd1', '2026-08-07T10:00:00.000Z', 't1');
    const mappe = findSitzungsmappe(s, 'sm1')!;
    expect(agendaZeilen(s, mappe)).toEqual([{ docId: 'd1', name: 'Erstes.pdf', verfuegbar: false, imPapierkorb: true }]);
  });

  it('ein vollständig verschwundenes Dokument gilt als weder verfügbar noch im Papierkorb', () => {
    const mappe: import('./sitzungsmappe').Sitzungsmappe = {
      id: 'sm1', titel: 'Termin', docIds: ['spurlos-weg'], offeneFragen: [],
    };
    const zeilen = agendaZeilen(tisch(), mappe);
    expect(zeilen).toHaveLength(1);
    expect(zeilen[0].verfuegbar).toBe(false);
    expect(zeilen[0].imPapierkorb).toBe(false);
  });

  it('behält die Agenda-Reihenfolge bei und verändert den State nicht', () => {
    let s = addSitzungsmappe(tisch(), 'Termin', 'sm1');
    s = addSitzungsmappeDoc(s, 'sm1', 'd2');
    s = addSitzungsmappeDoc(s, 'sm1', 'd1');
    const vorher = s;
    const mappe = findSitzungsmappe(s, 'sm1')!;
    const zeilen = agendaZeilen(s, mappe);
    expect(zeilen.map((z) => z.docId)).toEqual(['d2', 'd1']);
    expect(s).toBe(vorher);
  });
});

describe('applyCommand über Sitzungsmappe-Handler', () => {
  it('addSitzungsmappe validiert über text() — fehlender titel wirft CommandError', () => {
    expect(() => applyCommand(tisch(), { type: 'addSitzungsmappe', payload: {} })).toThrow(CommandError);
  });

  it('addSitzungsmappeDoc validiert über id() — fehlende id wirft CommandError', () => {
    const s = addSitzungsmappe(tisch(), 'Termin', 'sm1');
    expect(() => applyCommand(s, { type: 'addSitzungsmappeDoc', payload: { docId: 'd1' } })).toThrow(CommandError);
  });

  it('legt über den Command-Pfad eine Sitzungsmappe an und fügt ein Dokument hinzu', () => {
    let s = applyCommand(tisch(), { type: 'addSitzungsmappe', payload: { titel: 'Termin', id: 'sm1' } });
    s = applyCommand(s, { type: 'addSitzungsmappeDoc', payload: { id: 'sm1', docId: 'd1' } });
    expect(findSitzungsmappe(s, 'sm1')?.docIds).toEqual(['d1']);
  });

  function vorbereiteterState(): DesktopState {
    let s = applyCommand(tisch(), { type: 'addSitzungsmappe', payload: { titel: 'Termin', id: 'sm1' } });
    s = applyCommand(s, { type: 'addSitzungsmappeDoc', payload: { id: 'sm1', docId: 'd1' } });
    s = applyCommand(s, { type: 'addSitzungsmappeDoc', payload: { id: 'sm1', docId: 'd2' } });
    s = applyCommand(s, { type: 'addOffeneFrage', payload: { id: 'sm1', text: 'Frage', frageId: 'f1' } });
    return s;
  }

  it('renameSitzungsmappe validiert über text() — fehlender titel wirft CommandError', () => {
    expect(() => applyCommand(vorbereiteterState(), { type: 'renameSitzungsmappe', payload: { id: 'sm1' } })).toThrow(CommandError);
  });

  it('removeSitzungsmappe validiert über id() — fehlende id wirft CommandError', () => {
    expect(() => applyCommand(vorbereiteterState(), { type: 'removeSitzungsmappe', payload: {} })).toThrow(CommandError);
  });

  it('removeSitzungsmappeDoc validiert über id() — fehlende docId wirft CommandError', () => {
    expect(() => applyCommand(vorbereiteterState(), { type: 'removeSitzungsmappeDoc', payload: { id: 'sm1' } })).toThrow(CommandError);
  });

  it('verschiebeSitzungsmappeDoc validiert über verschiebeRichtung() — fehlende richtung wirft CommandError', () => {
    expect(() =>
      applyCommand(vorbereiteterState(), { type: 'verschiebeSitzungsmappeDoc', payload: { id: 'sm1', docId: 'd1' } }),
    ).toThrow(CommandError);
  });

  it('verschiebeSitzungsmappeDoc: eine Richtungsangabe außerhalb von -1/+1 wirft CommandError', () => {
    expect(() =>
      applyCommand(vorbereiteterState(), { type: 'verschiebeSitzungsmappeDoc', payload: { id: 'sm1', docId: 'd1', richtung: 2 } }),
    ).toThrow(CommandError);
  });

  it('addOffeneFrage validiert über text() — fehlender text wirft CommandError', () => {
    expect(() => applyCommand(vorbereiteterState(), { type: 'addOffeneFrage', payload: { id: 'sm1' } })).toThrow(CommandError);
  });

  it('setOffeneFrageText validiert über id() — fehlende frageId wirft CommandError', () => {
    expect(() =>
      applyCommand(vorbereiteterState(), { type: 'setOffeneFrageText', payload: { id: 'sm1', text: 'x' } }),
    ).toThrow(CommandError);
  });

  it('setOffeneFrageBeantwortet: ein nicht-boolesches Häkchen wirft CommandError', () => {
    expect(() =>
      applyCommand(vorbereiteterState(), { type: 'setOffeneFrageBeantwortet', payload: { id: 'sm1', frageId: 'f1', beantwortet: 'ja' } }),
    ).toThrow(CommandError);
  });

  it('setOffeneFrageBeantwortet: fehlendes Häkchen wirft CommandError', () => {
    expect(() =>
      applyCommand(vorbereiteterState(), { type: 'setOffeneFrageBeantwortet', payload: { id: 'sm1', frageId: 'f1' } }),
    ).toThrow(CommandError);
  });

  it('removeOffeneFrage validiert über id() — fehlende frageId wirft CommandError', () => {
    expect(() => applyCommand(vorbereiteterState(), { type: 'removeOffeneFrage', payload: { id: 'sm1' } })).toThrow(CommandError);
  });

  it('führt renameSitzungsmappe/removeSitzungsmappeDoc/verschiebeSitzungsmappeDoc/addOffeneFrage/setOffeneFrageText/setOffeneFrageBeantwortet/removeOffeneFrage über den Command-Pfad aus', () => {
    let s = vorbereiteterState();
    s = applyCommand(s, { type: 'renameSitzungsmappe', payload: { id: 'sm1', titel: 'Neuer Titel' } });
    s = applyCommand(s, { type: 'verschiebeSitzungsmappeDoc', payload: { id: 'sm1', docId: 'd1', richtung: 1 } });
    s = applyCommand(s, { type: 'removeSitzungsmappeDoc', payload: { id: 'sm1', docId: 'd2' } });
    s = applyCommand(s, { type: 'setOffeneFrageText', payload: { id: 'sm1', frageId: 'f1', text: 'geändert' } });
    s = applyCommand(s, { type: 'setOffeneFrageBeantwortet', payload: { id: 'sm1', frageId: 'f1', beantwortet: true } });
    s = applyCommand(s, { type: 'removeOffeneFrage', payload: { id: 'sm1', frageId: 'f1' } });
    const mappe = findSitzungsmappe(s, 'sm1')!;
    expect(mappe.titel).toBe('Neuer Titel');
    expect(mappe.docIds).toEqual(['d1']);
    expect(mappe.offeneFragen).toEqual([]);
    s = applyCommand(s, { type: 'removeSitzungsmappe', payload: { id: 'sm1' } });
    expect(findSitzungsmappe(s, 'sm1')).toBeUndefined();
  });
});

describe('isValidState', () => {
  it('bleibt true für einen State ohne sitzungsmappen-Feld', () => {
    const alt = emptyState();
    delete (alt as { sitzungsmappen?: unknown }).sitzungsmappen;
    expect(isValidState(alt)).toBe(true);
  });

  it('bleibt true für einen State mit sitzungsmappen-Array', () => {
    const s = addSitzungsmappe(tisch(), 'Termin', 'sm1');
    expect(isValidState(s)).toBe(true);
  });
});

describe('projectStateForActor', () => {
  const PRIVAT_A: Ebene = { id: 'privat-a', typ: 'privat', name: 'Privat (A)', ownerUserId: 'nutzer-a' };
  const bearbeiterB: ActorContext = { userId: 'nutzer-b', rolle: 'Bearbeiter' };

  it('entfernt eine Sitzungsmappe mit fremder privater layerId vollständig aus dem projizierten State', () => {
    const GEHEIME_ID = 'geheime-sitzungsmappe';
    const GEHEIM_TITEL = 'Streng vertraulicher Termin';
    const state: DesktopState = {
      ...tisch(),
      layers: [PRIVAT_A],
      sitzungsmappen: [{ id: GEHEIME_ID, titel: GEHEIM_TITEL, docIds: [], offeneFragen: [], layerId: PRIVAT_A.id }],
    };
    const projiziert = projectStateForActor(state, bearbeiterB);
    expect(projiziert.sitzungsmappen?.some((m) => m.id === GEHEIME_ID)).toBe(false);
    const json = JSON.stringify(projiziert);
    expect(json).not.toContain(GEHEIME_ID);
    expect(json).not.toContain(GEHEIM_TITEL);
  });
});
