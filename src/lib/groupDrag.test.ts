import { describe, it, expect, vi } from 'vitest';
import {
  addDoc, addLegalObject, addClip, addZeitleiste, moveZeitleiste, setTaped, isTaped, clipOf,
  copyObject, emptyState,
} from '@j-desk/core';
import { desktop } from './store.svelte';
import { moveGroupLocal, commitGroupMove, groupOf } from './groupDrag';

/**
 * WR-02: moveAny() (moveGroupLocal) resolvte Objekt-ids ueber
 * findDoc → findStack → findNote → findCutout → findTable und fiel fuer ein juristisches
 * Objekt still auf einen No-op zurueck — eine geklammerte Gruppe mit einem LegalObject-Mitglied
 * fiel beim Ziehen optisch auseinander, weil nur die uebrigen Mitglieder folgten.
 */
describe('groupDrag: Klammer-Gruppenzug (WR-02)', () => {
  it('bewegt ein geklammertes juristisches Objekt zusammen mit dem Rest der Gruppe', () => {
    desktop.applyLocal((s) => {
      let n = addDoc(s, 'f1', 'a.pdf', { x: 0, y: 0 }, 'd1');
      n = addLegalObject(n, 'tatsache', 'Behauptung', { x: 100, y: 100 }, 'lo1');
      n = addClip(n, 'd1', 'lo1', 'clip1');
      return n;
    });

    moveGroupLocal(groupOf('lo1'), 10, 5);

    const lo = desktop.state.legalObjects!.find((o) => o.id === 'lo1')!;
    const d1 = desktop.state.docs.find((d) => d.id === 'd1')!;
    expect(lo.position).toEqual({ x: 110, y: 105 });
    expect(d1.position).toEqual({ x: 10, y: 5 });
  });
});

/**
 * 09-02: die Zeitleiste verhält sich bei Klebeband, Klammer-Gruppenzug und Kopierer wie jede
 * andere Weltkarte (Registrierung selbst bereits in 09-01 vollzogen — hier folgt die
 * Testabdeckung für die Erweiterungspunkte, die 09-01 ohne eigene Tests ließ).
 */
describe('Zeitleiste: Klebeband, Klammer-Gruppenzug, Kopierschutz (09-02)', () => {
  it('setTaped auf einer Zeitleiste setzt und entfernt das Klebeband; isTaped meldet es zurück', () => {
    desktop.applyLocal((s) => addZeitleiste(s, { x: 0, y: 0 }, 'zt-tape'));
    expect(isTaped(desktop.state, 'zt-tape')).toBe(false);
    desktop.applyLocal((s) => setTaped(s, 'zt-tape', true));
    expect(isTaped(desktop.state, 'zt-tape')).toBe(true);
    desktop.applyLocal((s) => setTaped(s, 'zt-tape', false));
    expect(isTaped(desktop.state, 'zt-tape')).toBe(false);
  });

  it('eine angeklammerte Zeitleiste wird beim Gruppenzug lokal mitbewegt', () => {
    desktop.applyLocal((s) => {
      let n = addDoc(s, 'f-gd1', 'gd1.pdf', { x: 0, y: 0 }, 'd-gd1');
      n = addZeitleiste(n, { x: 100, y: 100 }, 'zt-gd1');
      n = addClip(n, 'd-gd1', 'zt-gd1', 'clip-gd1');
      return n;
    });

    moveGroupLocal(groupOf('zt-gd1'), 10, 5);

    const zt = desktop.state.zeitleisten!.find((z) => z.id === 'zt-gd1')!;
    const d = desktop.state.docs.find((x) => x.id === 'd-gd1')!;
    expect(zt.position).toEqual({ x: 110, y: 105 });
    expect(d.position).toEqual({ x: 10, y: 5 });
  });

  it('eine festgeklebte Zeitleiste bleibt beim Gruppenzug stehen, der Rest der Gruppe bewegt sich', () => {
    desktop.applyLocal((s) => {
      let n = addDoc(s, 'f-gd2', 'gd2.pdf', { x: 0, y: 0 }, 'd-gd2');
      n = addZeitleiste(n, { x: 200, y: 200 }, 'zt-gd2');
      n = setTaped(n, 'zt-gd2', true);
      n = addClip(n, 'd-gd2', 'zt-gd2', 'clip-gd2');
      return n;
    });

    moveGroupLocal(groupOf('zt-gd2'), 10, 5);

    const zt = desktop.state.zeitleisten!.find((z) => z.id === 'zt-gd2')!;
    const d = desktop.state.docs.find((x) => x.id === 'd-gd2')!;
    expect(zt.position).toEqual({ x: 200, y: 200 }); // festgeklebt: bleibt stehen
    expect(d.position).toEqual({ x: 10, y: 5 }); // Rest der Gruppe bewegt sich trotzdem
  });

  it('commitGroupMove sendet für eine bewegte Zeitleiste genau ein moveZeitleiste-Command', () => {
    desktop.applyLocal((s) => addZeitleiste(s, { x: 300, y: 300 }, 'zt-commit'));
    desktop.applyLocal((s) => moveZeitleiste(s, 'zt-commit', { x: 310, y: 305 }));
    const spion = vi.spyOn(desktop, 'command').mockResolvedValue({ ok: true });

    commitGroupMove(['zt-commit']);

    expect(spion).toHaveBeenCalledTimes(1);
    expect(spion).toHaveBeenCalledWith('moveZeitleiste', { id: 'zt-commit', position: { x: 310, y: 305 } });
    spion.mockRestore();
  });

  it('eine Klammer lässt sich zwischen einer Zeitleiste und einer Dokumentkarte anlegen', () => {
    desktop.applyLocal((s) => {
      let n = addDoc(s, 'f-gd5', 'gd5.pdf', { x: 0, y: 0 }, 'd-gd5');
      n = addZeitleiste(n, { x: 0, y: 0 }, 'zt-gd5');
      n = addClip(n, 'd-gd5', 'zt-gd5', 'clip-gd5');
      return n;
    });

    expect(clipOf(desktop.state, 'zt-gd5')?.memberIds.slice().sort()).toEqual(['d-gd5', 'zt-gd5']);
  });

  it('copyObject auf einer Zeitleiste wirft eine verständliche deutsche Meldung; der Zustand bleibt unverändert', () => {
    const s = addZeitleiste(emptyState(), { x: 0, y: 0 }, 'zt-copy');
    expect(() => copyObject(s, 'zt-copy')).toThrow('Zeitleisten lassen sich nicht kopieren');
    expect(s.zeitleisten).toHaveLength(1); // kein Absturz, keine Kopie entstanden — Ausgangszustand unangetastet
  });

  it('die maxZ-Liste in copy.ts berücksichtigt vorhandene Zeitleisten', () => {
    let s = addDoc(emptyState(), 'f-maxz', 'maxz.pdf', { x: 0, y: 0 }, 'd-maxz');
    s = addZeitleiste(s, { x: 0, y: 0 }, 'zt-maxz'); // erhält den höheren zIndex
    s = copyObject(s, 'd-maxz');
    const kopie = s.docs.find((d) => d.id !== 'd-maxz')!;
    const zt = s.zeitleisten!.find((z) => z.id === 'zt-maxz')!;
    expect(kopie.zIndex).toBeGreaterThan(zt.zIndex); // Kopie landet über der Zeitleiste, nicht dahinter
  });
});
