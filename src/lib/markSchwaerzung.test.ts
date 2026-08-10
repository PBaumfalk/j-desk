import { describe, it, expect } from 'vitest';
import { istEchteSchwaerzung } from './markSchwaerzung';

/**
 * CR-02-Regression: server-seitig behandelt der Export (pdfExport.ts D-01) redact- UND
 * tippex-Markierungen identisch als echte Schwärzung — vor dem Fix zeigte ProvenancePopover
 * den textSnapshot einer tippex-Markierung trotzdem an. Beide Mark-Arten müssen hier "true"
 * liefern, sonst leckt der Popover wieder den ursprünglich überdeckten Text.
 */
describe('istEchteSchwaerzung (CR-02)', () => {
  it("kind 'redact' ⇒ true", () => {
    expect(istEchteSchwaerzung('redact')).toBe(true);
  });

  it("kind 'tippex' ⇒ true (server behandelt tippex identisch zu redact, D-01)", () => {
    expect(istEchteSchwaerzung('tippex')).toBe(true);
  });
});
