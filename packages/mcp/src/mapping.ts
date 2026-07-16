import type { HashPair } from './anymize';

/** Beide dokumentierte Formate: [[Type-HASH]] und [PREFIX-N] (docs/anymize-api.md). */
export const PLACEHOLDER_RE = /\[\[[A-Za-z_]+-[A-Za-z0-9]+\]\]|\[[A-Z_]+-\d+\]/g;

export class MappingStore {
  private readonly map = new Map<string, string>();

  record(pairs: HashPair[]): void {
    for (const p of pairs) this.map.set(p.placeholder, p.original);
  }

  get size(): number {
    return this.map.size;
  }

  deanonymize(text: string): { text: string; unknown: string[] } {
    const unknown: string[] = [];
    const ersetzt = text.replace(PLACEHOLDER_RE, (m) => {
      const original = this.map.get(m);
      if (original === undefined) {
        unknown.push(m);
        return m;
      }
      return original;
    });
    return { text: ersetzt, unknown };
  }
}

export class AnonCache {
  private readonly fileTexts = new Map<string, string>();
  private readonly namen = new Map<string, string>();

  getFileText(fileId: string): string | undefined {
    return this.fileTexts.get(fileId);
  }
  setFileText(fileId: string, text: string): void {
    this.fileTexts.set(fileId, text);
  }
  getName(klartext: string): string | undefined {
    return this.namen.get(klartext);
  }
  setName(klartext: string, anonymisiert: string): void {
    this.namen.set(klartext, anonymisiert);
  }
}

export const batchLines = (namen: string[]): string => namen.join('\n');

export function splitLines(anonymisiert: string, erwartet: number): string[] | null {
  const zeilen = anonymisiert.split('\n');
  return zeilen.length === erwartet ? zeilen : null;
}
