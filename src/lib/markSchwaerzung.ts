import type { MarkKind } from '@j-desk/core';

/**
 * CR-02: server-seitig behandelt der Export beide Mark-Arten identisch als echte Schwärzung
 * ("redact UND tippex schwärzen echt (D-01): beide löschen den darunterliegenden Text",
 * packages/server/src/export/pdfExport.ts). Der Client muss denselben Maßstab anlegen — sonst
 * wäre der textSnapshot (der ursprünglich überdeckte Text) einer tippex-Markierung ein
 * Ausleitungsweg für Text, den der Export bereits als vertraulich behandelt.
 *
 * Zentral hier statt inline in ProvenancePopover.svelte, damit diese Klassifizierung nicht
 * erneut auseinanderdriften kann (IN-01-Lehre: dreifach duplizierte Logik war real ein
 * Bug-Vektor, siehe referenzstatus.ts) und unabhängig von der Svelte-Komponente testbar bleibt.
 */
export function istEchteSchwaerzung(kind: MarkKind): boolean {
  return kind === 'redact' || kind === 'tippex';
}
