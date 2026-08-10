/**
 * Gemeinsamer Upload-Pfad (MOBILE-02, T-11-02): aus Desktop.svelte extrahiert, UNVERÄNDERT im
 * Verhalten. Diese Extraktion ist eine Sicherheitsmaßnahme, keine reine Aufräumaktion: das
 * Telefon-Profil (SmartphoneSchnellzugriff.svelte) lädt über EXAKT dieselbe Funktion hoch —
 * dieselbe Server-Route, dieselbe Ebenenzuweisung, derselbe Berechtigungs-Toast. Weil es nur
 * diesen einen Weg gibt, kann strukturell kein zweiter, laxerer Upload-Pfad fürs Telefon
 * entstehen.
 */
import type { Vec2 } from '@j-desk/core';
import { uid } from './uid';
import { desktop, LAYER_FALLBACK } from './store.svelte';
import { ApiError } from './api';
import { showToast, toast403 } from './ui.svelte';

/** Neu angelegte Objekte landen auf der aktiven Zeichen-Ebene — bei 'kanzlei' (Default) ist
 *  kein zusätzlicher Command nötig (implizites Bestandsverhalten, keine überflüssige Runde). */
export function aufAktiveEbeneSetzen(objectId: string): void {
  if (desktop.currentLayerId !== LAYER_FALLBACK) {
    void desktop.command('changeLayerId', { objectId, layerId: desktop.currentLayerId });
  }
}

/** Datei hochladen und als Karte an der übergebenen Weltposition anlegen.
 *  Ohne Verbindung oder geladenen Schreibtisch passiert nichts (stiller Rücksprung wie bisher). */
export async function ladeDateiHoch(file: File, position: Vec2): Promise<void> {
  if (!desktop.api || !desktop.deskId) return;
  try {
    if (desktop.mode === 'jlawyer') {
      // Upload in die Akte; die Karte legt der Server erst nach j-lawyer-Bestätigung an.
      const result = await desktop.api.uploadToCase(desktop.deskId, new Uint8Array(await file.arrayBuffer()), file.name);
      desktop.acceptServerState(result);
      return;
    }
    const r = await desktop.api.uploadFile(new Uint8Array(await file.arrayBuffer()), file.name, file.type || undefined);
    const docId = uid();
    await desktop.command('addDoc', { fileId: r.fileId, name: file.name, position, id: docId, kind: r.kind });
    aufAktiveEbeneSetzen(docId);
  } catch (e) {
    // 02-08 (PERM-04, T-02-12): 403 ist der Race-Condition-Fallback (Rolle wurde serverseitig
    // geändert) — die primäre Verteidigung ist das Ausblenden von „Datei…" im ＋-Menü (plusMenu).
    if (e instanceof ApiError && e.status === 403) toast403('upload', desktop.currentRolle);
    else showToast(e instanceof Error ? e.message : `Upload fehlgeschlagen: ${file.name}`);
  }
}
