import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ui } from './ui.svelte';
import { abwurfZielFuer, starteZeitleisteEintrag } from './zeitleisteDrop';

function reset(): void {
  ui.trashRect = null;
  ui.zeitleisteRects = {};
  ui.zeitleisteEintragFuer = null;
  ui.zeitleisteEintragEntwurf = null;
}

describe('abwurfZielFuer (CHRONO-01, Plan 09-06 Task 1 — Vorrang Korb > Zeitleiste > Tisch)', () => {
  afterEach(reset);

  it('liefert das Korbziel, wenn der Zeiger über dem Papierkorb liegt', () => {
    reset();
    ui.trashRect = { x: 0, y: 0, w: 40, h: 40 };
    expect(abwurfZielFuer(10, 10, 'obj1')).toEqual({ art: 'korb' });
  });

  it('liefert das Korbziel, auch wenn zugleich eine Zeitleiste unter dem Zeiger liegt (Korb gewinnt bei Überlappung)', () => {
    reset();
    ui.trashRect = { x: 0, y: 0, w: 100, h: 100 };
    ui.zeitleisteRects = { zl1: { x: 0, y: 0, w: 100, h: 100, zIndex: 1 } };
    expect(abwurfZielFuer(50, 50, 'obj1')).toEqual({ art: 'korb' });
  });

  it('liefert das Zeitleistenziel, wenn der Zeiger über einer geöffneten Zeitleiste liegt und nicht über dem Papierkorb', () => {
    reset();
    ui.trashRect = { x: 500, y: 500, w: 40, h: 40 };
    ui.zeitleisteRects = { zl1: { x: 0, y: 0, w: 100, h: 100, zIndex: 1 } };
    expect(abwurfZielFuer(50, 50, 'obj1')).toEqual({ art: 'zeitleiste', zeitleisteId: 'zl1' });
  });

  it('liefert das Tischziel, wenn der Zeiger über keinem der beiden liegt', () => {
    reset();
    ui.trashRect = { x: 500, y: 500, w: 40, h: 40 };
    ui.zeitleisteRects = { zl1: { x: 0, y: 0, w: 100, h: 100, zIndex: 1 } };
    expect(abwurfZielFuer(900, 900, 'obj1')).toEqual({ art: 'tisch' });
  });

  it('liefert das Tischziel statt eines Selbsteintrags, wenn das gezogene Objekt die getroffene Zeitleiste selbst ist', () => {
    reset();
    ui.zeitleisteRects = { zl1: { x: 0, y: 0, w: 100, h: 100, zIndex: 1 } };
    expect(abwurfZielFuer(50, 50, 'zl1')).toEqual({ art: 'tisch' });
  });

  // WR-01 (09-REVIEW.md): der Sieger bei Überlappung richtet sich nach dem zIndex (oberste
  // Karte), nicht mehr nach der Objektschlüssel-Reihenfolge — hier absichtlich mit zl1 ZUERST im
  // Objekt, aber höherem zIndex, damit ein Rückfall auf die alte Logik den Test bräche.
  it('bei zwei überlappenden Zeitleisten gewinnt die mit dem höheren zIndex (die oberste)', () => {
    reset();
    ui.zeitleisteRects = {
      zl1: { x: 0, y: 0, w: 100, h: 100, zIndex: 5 },
      zl2: { x: 50, y: 50, w: 100, h: 100, zIndex: 2 },
    };
    expect(abwurfZielFuer(75, 75, 'obj1')).toEqual({ art: 'zeitleiste', zeitleisteId: 'zl1' });
  });
});

describe('starteZeitleisteEintrag (CHRONO-01, Plan 09-06 Task 1)', () => {
  afterEach(reset);

  it('setzt den Entwurf mit Zeitleisten-id und Objektreferenz und ohne Eintrags-id', () => {
    reset();
    starteZeitleisteEintrag('zl1', 'doc1');
    expect(ui.zeitleisteEintragEntwurf).toEqual({ zeitleisteId: 'zl1', objRef: 'doc1' });
    expect(ui.zeitleisteEintragEntwurf?.eintragId).toBeUndefined();
  });

  it('räumt einen offenen Zwei-Klick-Auswahlmodus ab', () => {
    reset();
    ui.zeitleisteEintragFuer = 'zl1';
    starteZeitleisteEintrag('zl1', 'doc1');
    expect(ui.zeitleisteEintragFuer).toBeNull();
  });

  it('legt keinen Eintrag an und sendet kein Command — die Datei importiert nicht aus store.svelte.ts (Quellprüfung)', () => {
    const hier = fileURLToPath(new URL('./zeitleisteDrop.ts', import.meta.url));
    const quelltext = readFileSync(hier, 'utf-8');
    expect(quelltext).not.toMatch(/store\.svelte/);
    expect(quelltext).not.toMatch(/desktop\.command/);
  });
});
