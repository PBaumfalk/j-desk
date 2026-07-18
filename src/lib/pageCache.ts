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
      this.map.delete(oldest);
    }
  }
}
