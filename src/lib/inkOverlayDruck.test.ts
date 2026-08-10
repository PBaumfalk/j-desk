// Quelltext-Wächtertest für die Pencil-Druckverdrahtung in InkOverlay.svelte (MOBILE-01, Plan 11-07).
//
// Die Testumgebung kennt kein DOM, `PointerEvent` existiert dort nicht, und eine
// Svelte-Komponente lässt sich in diesem Projekt nicht mounten (vitest läuft mit
// `environment: 'node'`, siehe vitest.config.ts). Die Zahlenlogik selbst (Klemmung,
// Rückfallwert, Textmarker-Ausschluss) ist bereits in `inkMath.test.ts` vollständig
// geprüft — hier wird nur die korrekte Verdrahtung im Quelltext gesichert: dass die
// Komponente die geprüfte Funktion tatsächlich aufruft, mit den richtigen Argumenten,
// und die Rechnung nicht wieder in die Komponente hineinkopiert.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function quelltext(): string {
  const hier = fileURLToPath(new URL('./components/InkOverlay.svelte', import.meta.url));
  return readFileSync(hier, 'utf-8');
}

describe('InkOverlay.svelte — Pencil-Druckverdrahtung (MOBILE-01, Plan 11-07)', () => {
  it('importiert strichbreiteMitDruck aus ../inkMath', () => {
    const q = quelltext();
    expect(q).toMatch(/import\s*\{[^}]*strichbreiteMitDruck[^}]*\}\s*from\s*'\.\.\/inkMath'/);
  });

  it('übergibt der Breitenberechnung sowohl den gemerkten Zeigertyp als auch den gemerkten Höchstdruck', () => {
    const q = quelltext();
    const aufruf = q.match(/strichbreiteMitDruck\(([^)]*)\)/);
    expect(aufruf).not.toBeNull();
    const argumente = aufruf?.[1] ?? '';
    expect(argumente).toMatch(/gestenZeigertyp/);
    expect(argumente).toMatch(/gestenHoechstdruck/);
  });

  it('enthält keine eigene Klemmung (0.4/1.4) — die Rechnung lebt ausschließlich im geprüften Modul', () => {
    const q = quelltext();
    expect(q).not.toMatch(/0\.4/);
    expect(q).not.toMatch(/1\.4/);
  });

  it('schließt den Textmarker nicht innerhalb der Breitenberechnung selbst aus (der Ausschluss liegt in inkMath.ts)', () => {
    const q = quelltext();
    const onPointerUp = q.match(/function onPointerUp[\s\S]*?\n  \}/);
    expect(onPointerUp).not.toBeNull();
    // Kein eigener Vergleich auf die Zeichenkette 'marker' innerhalb der Abschlussbehandlung —
    // Kommentar-Erwähnungen sind erlaubt, ein struktureller Ausschluss (===/!== 'marker') nicht.
    expect(onPointerUp?.[0] ?? '').not.toMatch(/[=!]==\s*'marker'/);
  });

  it('lässt die Werkzeugtabelle mit den drei festen Breiten unverändert', () => {
    const q = quelltext();
    expect(q).toMatch(/pen:\s*\{\s*color:\s*'#1d3557',\s*width:\s*1\.5,\s*alpha:\s*1\s*\}/);
    expect(q).toMatch(/marker:\s*\{\s*color:\s*'#ffd166',\s*width:\s*9,\s*alpha:\s*0\.35\s*\}/);
    expect(q).toMatch(/pencil:\s*\{\s*color:\s*'#5c6672',\s*width:\s*1\.2,\s*alpha:\s*0\.9\s*\}/);
  });
});
