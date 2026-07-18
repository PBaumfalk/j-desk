export function pageCacheKey(fileId: string, page: number, targetWidth: number): string {
  return `${fileId}:${page}:${targetWidth}`;
}

/** Kleiner Bitmap-Cache mit Insertion-Order-Verdrängung (kein echtes LRU nötig). */
export class PageBitmapCache {
  private map = new Map<string, ImageBitmap>();
  constructor(private max = 12) {}

  get(key: string): ImageBitmap | undefined {
    return this.map.get(key);
  }

  set(key: string, bmp: ImageBitmap): void {
    this.map.set(key, bmp);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      const victim = this.map.get(oldest);
      this.map.delete(oldest);
      victim?.close?.(); // Bitmap freigeben; defensiv, falls .close fehlt (z. B. in Tests)
    }
  }

  /** Gibt alle Bitmaps frei (beim Unmount des Renderers). */
  clear(): void {
    for (const bmp of this.map.values()) bmp.close?.();
    this.map.clear();
  }
}
