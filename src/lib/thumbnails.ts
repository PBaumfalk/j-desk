import {
  BaseDirectory, exists, mkdir, readFile, remove, writeFile,
} from '@tauri-apps/plugin-fs';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { Doc } from '@digital-desktop/core';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const base = { baseDir: BaseDirectory.AppData };
const cachePath = (id: string) => `thumbnails/${id}.png`;
const urls = new Map<string, string>();

function remember(id: string, bytes: Uint8Array): string {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
  urls.set(id, url);
  return url;
}

/** Object-URL der Miniatur der ersten Seite; nutzt den PNG-Cache, sonst rendern. Null, wenn nicht renderbar. */
export async function getThumbnail(doc: Doc): Promise<string | null> {
  const cached = urls.get(doc.id);
  if (cached) return cached;
  try {
    if (await exists(cachePath(doc.id), base)) {
      return remember(doc.id, await readFile(cachePath(doc.id), base));
    }
    const data = await readFile(doc.path);
    const pdf = await pdfjs.getDocument({ data }).promise;
    const page = await pdf.getPage(1);
    const scale = 360 / page.getViewport({ scale: 1 }).width;
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport }).promise;
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob fehlgeschlagen'))), 'image/png'),
    );
    const bytes = new Uint8Array(await blob.arrayBuffer());
    await mkdir('thumbnails', { ...base, recursive: true }).catch(() => {});
    await writeFile(cachePath(doc.id), bytes, base).catch(() => {});
    return remember(doc.id, bytes);
  } catch {
    return null; // defekt oder passwortgeschützt → Karte zeigt generisches Symbol
  }
}

/** Nach „Datei neu verknüpfen…“: gecachte Miniatur verwerfen. */
export function invalidateThumbnail(id: string): void {
  const u = urls.get(id);
  if (u) URL.revokeObjectURL(u);
  urls.delete(id);
  void remove(cachePath(id), base).catch(() => {});
}
