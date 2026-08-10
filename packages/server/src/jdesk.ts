import { existsSync, readFileSync } from 'node:fs';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import {
  sanitizeForExport, validateImportState, nurBekannteFelder, projectStateForActor,
  type DesktopState, type Rolle,
} from '@j-desk/core';
import { instanceId, type Db } from './db';
import { getDeskState, DeskNotFoundError } from './deskStore';
import { getFileMeta, getFilePath, MAX_SIZE } from './files';

export const JDESK_FORMAT_VERSION = 1;

export class PaketFehler extends Error {}

/** Echtes JSON-Objekt — schließt `null`, Arrays und Skalare aus, die JSON.parse
    ebenfalls unbeanstandet liefert und die einen nachfolgenden Feldzugriff sonst
    mit einem rohen TypeError abbrechen ließen. */
function istEchtesObjekt(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

export interface JdeskManifest {
  format: 'jdesk';
  formatVersion: number;
  createdAt: number;
  createdBy: string;
  instanceId: string;
  mode: 'linked' | 'self-contained';
  source: { kind: 'jlawyer' | 'standalone'; caseId?: string; deskName: string };
  rev: number;
  counts: Record<string, number>;
}

export interface GelesenesPaket {
  manifest: JdeskManifest;
  state: DesktopState;
  files: Map<string, { name: string; bytes: Buffer }>;
}

/** Alle Dateien, auf die der Zustand verweist — inkl. Papierkorb-Kopien. */
function referenzierteFileIds(s: DesktopState): string[] {
  const ids = new Set<string>();
  for (const d of s.docs) ids.add(d.fileId);
  for (const c of s.cutouts ?? []) ids.add(c.fileId);
  for (const t of s.trash ?? []) {
    for (const d of t.payload.docs) ids.add(d.fileId);
    for (const c of t.payload.cutouts) ids.add(c.fileId);
  }
  return [...ids];
}

function zaehle(s: DesktopState): Record<string, number> {
  return {
    docs: s.docs.length, stacks: s.stacks.length, links: s.links.length,
    notes: (s.notes ?? []).length, cutouts: (s.cutouts ?? []).length,
    strokes: (s.strokes ?? []).length, marks: (s.marks ?? []).length,
    stamps: (s.stamps ?? []).length, flags: (s.flags ?? []).length,
    trash: (s.trash ?? []).length,
  };
}

export function buildPackage(
  db: Db, dataDir: string, deskId: string,
  opts: { createdBy: string; jlawyer: boolean; userId: string; rolle: Rolle },
): Buffer {
  const zustand = getDeskState(db, deskId);
  if (!zustand) throw new DeskNotFoundError('Schreibtisch nicht gefunden');
  const row = db.prepare('SELECT name FROM desks WHERE id = ?').get(deskId) as { name: string } | undefined;
  // PERM-05/T-02-05: Sichtbarkeitsprojektion VOR der Export-Bereinigung — sonst enthielte ein
  // exportiertes .jdesk-Paket private Objekte anderer Nutzer, die sanitizeForExport allein nicht
  // herausfiltert (die beiden Funktionen haben unterschiedliche Aufgaben: Projektion entscheidet
  // "wer darf das sehen", Sanitize entfernt reine Serverinterna wie Datei-Hashes/Provenienz-IDs).
  const projiziert = projectStateForActor(zustand.state, { userId: opts.userId, rolle: opts.rolle });
  const state = sanitizeForExport(projiziert);
  const mode = opts.jlawyer ? 'linked' : 'self-contained';

  const eintraege: Record<string, Uint8Array> = {};
  if (mode === 'self-contained') {
    const dateien: Record<string, { name: string; sha256: string; kind: string; size: number }> = {};
    for (const fileId of referenzierteFileIds(state)) {
      const meta = getFileMeta(db, fileId);
      const pfad = getFilePath(db, dataDir, fileId);
      // Fehlende Datei ist kein Abbruch: der Zustand bleibt vollständig, die Karte
      // verwaist beim Import — dasselbe Verhalten wie bei einer gelöschten jl-Quelle.
      if (!meta || !pfad || !existsSync(pfad)) continue;
      eintraege[`files/${fileId}`] = new Uint8Array(readFileSync(pfad));
      dateien[fileId] = { name: meta.originalName, sha256: meta.sha256, kind: meta.kind, size: meta.size };
    }
    eintraege['files.json'] = strToU8(JSON.stringify(dateien, null, 2));
  }

  const manifest: JdeskManifest = {
    format: 'jdesk',
    formatVersion: JDESK_FORMAT_VERSION,
    createdAt: Date.now(),
    createdBy: opts.createdBy,
    instanceId: instanceId(db),
    mode,
    source: {
      kind: opts.jlawyer ? 'jlawyer' : 'standalone',
      ...(opts.jlawyer ? { caseId: deskId } : {}),
      deskName: row?.name ?? deskId,
    },
    rev: zustand.rev,
    counts: zaehle(state),
  };
  eintraege['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2));
  eintraege['workspace.json'] = strToU8(JSON.stringify(state));
  return Buffer.from(zipSync(eintraege, { level: 6 }));
}

export function readPackage(bytes: Buffer): GelesenesPaket {
  let eintraege: Record<string, Uint8Array>;
  try {
    eintraege = unzipSync(new Uint8Array(bytes));
  } catch {
    throw new PaketFehler('Die Datei ist kein lesbares .jdesk-Paket');
  }
  if (!eintraege['manifest.json'] || !eintraege['workspace.json']) {
    throw new PaketFehler('Dem Paket fehlt manifest.json oder workspace.json');
  }

  let manifest: JdeskManifest;
  try {
    manifest = JSON.parse(strFromU8(eintraege['manifest.json'])) as JdeskManifest;
  } catch {
    throw new PaketFehler('Das Manifest des Pakets ist beschädigt');
  }
  if (!istEchtesObjekt(manifest)) throw new PaketFehler('Das Manifest des Pakets ist beschädigt');
  if (manifest.format !== 'jdesk') throw new PaketFehler('Die Datei ist kein .jdesk-Paket');
  if (typeof manifest.formatVersion !== 'number' || Number.isNaN(manifest.formatVersion)) {
    throw new PaketFehler('Das Manifest des Pakets ist beschädigt (formatVersion fehlt oder ist ungültig)');
  }
  if (!(manifest.formatVersion <= JDESK_FORMAT_VERSION)) {
    throw new PaketFehler('Das Paket stammt aus einer neueren J-DESK-Fassung');
  }

  let roh: unknown;
  try {
    roh = JSON.parse(strFromU8(eintraege['workspace.json']));
  } catch {
    throw new PaketFehler('Der Schreibtisch-Zustand im Paket ist beschädigt');
  }
  const pruefung = validateImportState(roh);
  if (!pruefung.ok) throw new PaketFehler(pruefung.grund);
  const state = nurBekannteFelder(roh as DesktopState);

  // Echte Dateieinträge unter files/ — Verzeichniseinträge (Pfad endet auf '/' oder liefert eine
  // leere fileId) ausgeschlossen. Ein mit einem gewöhnlichen ZIP-Werkzeug neu gepacktes Paket
  // (z. B. beim Umzug zwischen Installationen) kann solche Verzeichniseinträge mitliefern;
  // fflate.zipSync legt sie bei unseren eigenen Paketen nie an.
  const dateiEintraege = Object.entries(eintraege).filter(([pfad]) => {
    if (!pfad.startsWith('files/')) return false;
    if (pfad.endsWith('/')) return false;
    return pfad.slice('files/'.length) !== '';
  });

  if (dateiEintraege.length > 0 && !eintraege['files.json']) {
    throw new PaketFehler('Dem Paket fehlt die Dateiliste (files.json), obwohl es Dateien enthält');
  }

  const files = new Map<string, { name: string; bytes: Buffer }>();
  if (eintraege['files.json']) {
    let namen: unknown;
    try {
      namen = JSON.parse(strFromU8(eintraege['files.json']));
    } catch {
      throw new PaketFehler('Die Dateiliste (files.json) des Pakets ist beschädigt');
    }
    if (!istEchtesObjekt(namen)) {
      throw new PaketFehler('Die Dateiliste (files.json) des Pakets ist beschädigt');
    }
    const namenTabelle = namen as Record<string, { name: string } | undefined>;
    for (const [pfad, inhalt] of dateiEintraege) {
      const fileId = pfad.slice('files/'.length);
      // Vorprüfung, bevor auch nur ein Byte gespeichert wird: die Route legt Dateien in der
      // Reihenfolge der Map ab, ohne Rollback bei einem späteren Treffer. Ein Paket mit einer
      // leeren oder übergroßen eingebetteten Datei muss also schon hier scheitern — nicht erst,
      // wenn storeFile bereits vorherige Dateien endgültig geschrieben hat.
      if (inhalt.length === 0) {
        throw new PaketFehler(`Die eingebettete Datei "${namenTabelle[fileId]?.name ?? fileId}" ist leer`);
      }
      if (inhalt.length > MAX_SIZE) {
        throw new PaketFehler(`Die eingebettete Datei "${namenTabelle[fileId]?.name ?? fileId}" ist größer als 100 MB`);
      }
      files.set(fileId, { name: namenTabelle[fileId]?.name ?? fileId, bytes: Buffer.from(inhalt) });
    }
  }

  // Herkunft prüfen, bevor das Manifest zurückgegeben wird: die Import-Route liest
  // source.caseId direkt (app.ts) — ein Paket ohne echtes, korrekt geformtes source-Objekt
  // würde dort sonst nicht mit einem deutschen PaketFehler, sondern mit einem rohen
  // TypeError abbrechen.
  const { source } = manifest;
  if (!istEchtesObjekt(source)) {
    throw new PaketFehler('Dem Manifest fehlt die Herkunftsangabe (source)');
  }
  if (source.kind !== 'jlawyer' && source.kind !== 'standalone') {
    throw new PaketFehler('Die Herkunftsangabe (source) des Manifests hat eine unbekannte Art (kind)');
  }
  if (source.kind === 'jlawyer' && (typeof source.caseId !== 'string' || source.caseId === '')) {
    throw new PaketFehler('Dem Manifest fehlt die Akten-ID (source.caseId) für ein j-lawyer-Paket');
  }

  return { manifest, state, files };
}
