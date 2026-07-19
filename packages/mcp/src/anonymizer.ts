import { AnymizeClient } from './anymize';
import { AnonCache, MappingStore, batchLines, splitLines } from './mapping';

const MAX_TEXT = 100_000;

export class Anonymizer {
  constructor(
    private readonly client: AnymizeClient,
    private readonly mappings: MappingStore,
    private readonly cache: AnonCache,
  ) {}

  /** Cache-first; Uncached gebatcht in einem anymize-Aufruf (Fallback: einzeln). */
  async anonNames(namen: string[]): Promise<string[]> {
    const fehlend = [...new Set(namen.filter((n) => n !== '' && this.cache.getName(n) === undefined))];
    if (fehlend.length > 0) {
      const r = await this.client.anonymizeText(batchLines(fehlend));
      this.mappings.record(r.pairs);
      const zeilen = splitLines(r.text, fehlend.length);
      if (zeilen) {
        fehlend.forEach((n, i) => this.cache.setName(n, zeilen[i]));
      } else {
        for (const n of fehlend) {
          const einzel = await this.client.anonymizeText(n);
          this.mappings.record(einzel.pairs);
          this.cache.setName(n, einzel.text);
        }
      }
    }
    return namen.map((n) => (n === '' ? '' : this.cache.getName(n)!));
  }

  async anonFileText(fileId: string, laden: () => Promise<Uint8Array>, filename: string): Promise<string> {
    const cached = this.cache.getFileText(fileId);
    if (cached !== undefined) return cached;
    const bytes = await laden();
    if (bytes.length > 25 * 1024 * 1024) throw new Error('PDF zu groß (max. 25 MB)');
    const r = await this.client.anonymizeFile(bytes, filename);
    this.mappings.record(r.pairs);
    const text = r.text.length > MAX_TEXT ? `${r.text.slice(0, MAX_TEXT)}\n\n[Hinweis: Text gekürzt]` : r.text;
    this.cache.setFileText(fileId, text);
    return text;
  }
}
