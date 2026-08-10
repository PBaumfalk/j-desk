import { describe, it, expect } from 'vitest';
import { emptyState, type DesktopState } from './model';
import { addDoc } from './documents';
import { addNote } from './notes';
import { addLink } from './links';
import { addClip } from './clips';
import { setTaped } from './tape';
import { stackDocs } from './stacks';
import { copyObject } from './copy';
import { ermittleVorschlaege, GRUPPEN_LABEL } from './aufraeumen';

/** Drei freie Docs, y-verschachtelt, nahe demselben linken Rand (< AUSRICHTEN_STREUUNG_PX). */
function dreiDocsAmLinkenRand(): DesktopState {
  let s = addDoc(emptyState(), 'f1', 'Anklageschrift.pdf', { x: 0, y: 0 }, 'd1');
  s = addDoc(s, 'f2', 'Bescheid.pdf', { x: 10, y: 260 }, 'd2');
  s = addDoc(s, 'f3', 'Klageerwiderung.pdf', { x: 20, y: 520 }, 'd3');
  return s;
}

describe('aufraeumen: ermittleVorschlaege', () => {
  it('liefert [] auf einem leeren Tisch (E1/empty)', () => {
    expect(ermittleVorschlaege(emptyState())).toEqual([]);
  });

  it('GRUPPEN_LABEL deckt alle vier Gruppen mit den fixierten Überschriften ab', () => {
    expect(GRUPPEN_LABEL).toEqual({
      ausrichten: 'Ausrichten & Sortieren',
      gruppieren: 'Gruppieren',
      dubletten: 'Dubletten',
      'unverbundene-notizen': 'Unverbundene Notizen',
    });
  });

  describe('Ausrichten & Sortieren', () => {
    it('drei freie Docs nahe dem linken Rand erzeugen genau einen ausrichten-Vorschlag', () => {
      const vorschlaege = ermittleVorschlaege(dreiDocsAmLinkenRand()).filter((v) => v.gruppe === 'ausrichten');
      expect(vorschlaege).toHaveLength(1);
      expect(vorschlaege[0].objektIds.slice().sort()).toEqual(['d1', 'd2', 'd3']);
      expect(vorschlaege[0].namen.slice().sort()).toEqual(['Anklageschrift.pdf', 'Bescheid.pdf', 'Klageerwiderung.pdf']);
      expect(vorschlaege[0].beschreibung).toContain('3 Dokumente');
      expect(vorschlaege[0].beschreibung).toContain('Anklageschrift.pdf');
      expect(vorschlaege[0].aktion.kommandos.length).toBeGreaterThan(0);
      expect(vorschlaege[0].aktion.kommandos.every((k) => k.type === 'moveDoc')).toBe(true);
    });

    it('zwei Docs erzeugen keinen Vorschlag (Mindestanzahl 3)', () => {
      let s = addDoc(emptyState(), 'f1', 'a.pdf', { x: 0, y: 0 }, 'd1');
      s = addDoc(s, 'f2', 'b.pdf', { x: 5, y: 260 }, 'd2');
      expect(ermittleVorschlaege(s).filter((v) => v.gruppe === 'ausrichten')).toEqual([]);
    });

    it('Docs weit auseinander (kein gemeinsamer Rand) erzeugen keinen Vorschlag', () => {
      let s = addDoc(emptyState(), 'f1', 'a.pdf', { x: 0, y: 0 }, 'd1');
      s = addDoc(s, 'f2', 'b.pdf', { x: 800, y: 260 }, 'd2');
      s = addDoc(s, 'f3', 'c.pdf', { x: 1600, y: 520 }, 'd3');
      expect(ermittleVorschlaege(s).filter((v) => v.gruppe === 'ausrichten')).toEqual([]);
    });
  });

  describe('Gruppieren', () => {
    it('zwei freie, räumlich nahe Docs erzeugen einen gruppieren-Vorschlag (stackDocs-artig)', () => {
      let s = addDoc(emptyState(), 'f1', 'a.pdf', { x: 0, y: 0 }, 'd1');
      s = addDoc(s, 'f2', 'b.pdf', { x: 20, y: 10 }, 'd2');
      const vorschlaege = ermittleVorschlaege(s).filter((v) => v.gruppe === 'gruppieren');
      expect(vorschlaege).toHaveLength(1);
      expect(vorschlaege[0].objektIds.slice().sort()).toEqual(['d1', 'd2']);
      expect(vorschlaege[0].aktion.kommandos).toEqual([
        { type: 'stackDocs', payload: { draggedId: 'd2', targetId: 'd1' } },
      ]);
    });

    it('bereits gestapelte Dokumente werden nicht erneut vorgeschlagen', () => {
      let s = addDoc(emptyState(), 'f1', 'a.pdf', { x: 0, y: 0 }, 'd1');
      s = addDoc(s, 'f2', 'b.pdf', { x: 20, y: 10 }, 'd2');
      s = stackDocs(s, 'd2', 'd1', 'st1');
      expect(ermittleVorschlaege(s).filter((v) => v.gruppe === 'gruppieren')).toEqual([]);
    });

    it('räumlich weit entfernte Docs erzeugen keinen Vorschlag', () => {
      let s = addDoc(emptyState(), 'f1', 'a.pdf', { x: 0, y: 0 }, 'd1');
      s = addDoc(s, 'f2', 'b.pdf', { x: 2000, y: 2000 }, 'd2');
      expect(ermittleVorschlaege(s).filter((v) => v.gruppe === 'gruppieren')).toEqual([]);
    });
  });

  describe('Dubletten', () => {
    it('zwei Docs mit identischer fileId (copyObject-Semantik) erzeugen einen dubletten-Vorschlag ohne Löschen', () => {
      let s = addDoc(emptyState(), 'geteilt', 'original.pdf', { x: 0, y: 0 }, 'd1');
      // copyObject ist der einzige legitime Weg zu einer geteilten fileId (A4) — addDoc lehnt
      // eine zweite Karte mit derselben fileId sonst stillschweigend ab (documents.ts:41).
      s = copyObject(s, 'd1');
      const kopieId = s.docs.find((d) => d.id !== 'd1')!.id;
      const vorschlaege = ermittleVorschlaege(s).filter((v) => v.gruppe === 'dubletten');
      expect(vorschlaege).toHaveLength(1);
      expect(vorschlaege[0].objektIds.slice().sort()).toEqual(['d1', kopieId].sort());
      expect(vorschlaege[0].namen).toContain('original.pdf');
      expect(vorschlaege[0].aktion.kommandos.some((k) => k.type === 'trashObject')).toBe(false);
      expect(vorschlaege[0].aktion.kommandos.every((k) => k.type === 'stackDocs')).toBe(true);
    });

    it('zwei Docs mit verschiedenen fileIds erzeugen keinen Dubletten-Vorschlag', () => {
      let s = addDoc(emptyState(), 'f1', 'a.pdf', { x: 0, y: 0 }, 'd1');
      s = addDoc(s, 'f2', 'b.pdf', { x: 2000, y: 2000 }, 'd2');
      expect(ermittleVorschlaege(s).filter((v) => v.gruppe === 'dubletten')).toEqual([]);
    });
  });

  describe('Unverbundene Notizen', () => {
    it('unverbundene Notizen erzeugen je einen eigenen Vorschlag mit trashObject (keine Bündelung)', () => {
      let s = addNote(emptyState(), 'notiz', 'Frei schwebender Gedanke', { x: 0, y: 0 }, 'n1');
      s = addNote(s, 'notiz', 'Zweiter frei schwebender Gedanke', { x: 400, y: 0 }, 'n2');
      const vorschlaege = ermittleVorschlaege(s).filter((v) => v.gruppe === 'unverbundene-notizen');
      expect(vorschlaege).toHaveLength(2);
      expect(vorschlaege.map((v) => v.objektIds)).toEqual([['n1'], ['n2']]);
      expect(vorschlaege.every((v) => v.aktion.kommandos.length === 1 && v.aktion.kommandos[0].type === 'trashObject')).toBe(true);
      // Bewusst OHNE trashedAt (Reinheit der Ermittlung — s. Kopfkommentar aufraeumen.ts).
      expect(vorschlaege.every((v) => !('trashedAt' in v.aktion.kommandos[0].payload))).toBe(true);
    });

    it('verlinkte, geklammerte oder festgeklebte Notizen erzeugen keinen Vorschlag', () => {
      let s = addDoc(emptyState(), 'f1', 'a.pdf', { x: 0, y: 0 }, 'd1');
      s = addNote(s, 'notiz', 'verlinkt', { x: 400, y: 0 }, 'n1');
      s = addNote(s, 'notiz', 'geklammert', { x: 800, y: 0 }, 'n2');
      s = addNote(s, 'notiz', 'geklebt', { x: 1200, y: 0 }, 'n3');
      s = addLink(s, 'd1', 'n1', 'l1');
      s = addClip(s, 'd1', 'n2', 'c1');
      s = setTaped(s, 'n3', true);
      expect(ermittleVorschlaege(s).filter((v) => v.gruppe === 'unverbundene-notizen')).toEqual([]);
    });
  });

  it('jeder Vorschlag trägt die vollständige Feldform {id, gruppe, beschreibung, objektIds, namen, aktion}', () => {
    let s = addDoc(emptyState(), 'geteilt', 'a.pdf', { x: 0, y: 0 }, 'd1');
    s = copyObject(s, 'd1');
    const [v] = ermittleVorschlaege(s);
    expect(v).toMatchObject({
      id: expect.any(String),
      gruppe: expect.any(String),
      beschreibung: expect.any(String),
      objektIds: expect.any(Array),
      namen: expect.any(Array),
      aktion: { kommandos: expect.any(Array) },
    });
  });

  it('Determinismus: zwei Aufrufe auf demselben komplexen State liefern identische Reihenfolge', () => {
    let s = dreiDocsAmLinkenRand();
    s = addDoc(s, 'geteilt', 'x.pdf', { x: 5000, y: 0 }, 'd4');
    s = copyObject(s, 'd4');
    s = addNote(s, 'notiz', 'unverbunden', { x: 9000, y: 0 }, 'n1');
    const erste = ermittleVorschlaege(s);
    const zweite = ermittleVorschlaege(s);
    expect(zweite.map((v) => v.id)).toEqual(erste.map((v) => v.id));
    expect(zweite).toEqual(erste);
  });

  it('ist rein und nebenwirkungsfrei: der State bleibt referenzgleich', () => {
    const s = dreiDocsAmLinkenRand();
    const vorherDocs = s.docs;
    ermittleVorschlaege(s);
    ermittleVorschlaege(s);
    expect(s.docs).toBe(vorherDocs); // keine neue Array-Referenz — keine Mutation
  });
});
