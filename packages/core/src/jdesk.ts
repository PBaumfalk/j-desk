import { isValidState, type DesktopState } from './model';
import type { Mark } from './marks';
import type { Cutout } from './cutouts';

type Rect = { x: number; y: number; w: number; h: number };

/** Berührende Kanten gelten NICHT als Überlappung. */
function ueberlappt(a: Rect, b: Rect): boolean {
  return !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
}

function ohneSnapshot<T extends { textSnapshot?: string }>(o: T): T {
  if (o.textSnapshot === undefined) return o;
  const { textSnapshot: _weg, ...rest } = o;
  return rest as T;
}

/**
 * Entfernt Klartext-Snapshots, die hinter einer Schwärzung liegen — das Paket wird
 * automatisch in die j-lawyer-Akte geschrieben, wo es jede:r mit Aktenzugriff öffnen kann.
 *
 * Schwärzungsflächen werden bewusst aus Live-Zustand UND Papierkorb vereinigt: eine
 * Schwärzung im Korb ist zwar nicht mehr wirksam, aber zu viel zu entfernen kostet nur
 * den Sprung zur Fundstelle, zu wenig zu entfernen wäre ein Leck.
 *
 * Position und Größe der Fläche bleiben erhalten, damit der Re-Import sie wiederherstellt.
 */
export function sanitizeForExport(s: DesktopState): DesktopState {
  const trash = s.trash ?? [];
  // Marks tragen docId, Cutouts fileId — die Brücke schlägt state.docs, inkl. der
  // bereits entfernten Dokumente aus dem Papierkorb.
  const fileIdVon = new Map<string, string>();
  for (const d of s.docs) fileIdVon.set(d.id, d.fileId);
  for (const t of trash) for (const d of t.payload.docs) fileIdVon.set(d.id, d.fileId);

  const schwaerzungen = new Map<string, Rect[]>();
  const merken = (m: Mark): void => {
    if (m.kind !== 'redact') return;
    const fileId = fileIdVon.get(m.docId);
    if (!fileId) return;
    const key = `${fileId}|${m.page}`;
    const liste = schwaerzungen.get(key);
    if (liste) liste.push(m.rect);
    else schwaerzungen.set(key, [m.rect]);
  };
  for (const m of s.marks ?? []) merken(m);
  for (const t of trash) for (const m of t.payload.marks) merken(m);

  const verdeckt = (fileId: string | undefined, page: number, rect: Rect): boolean =>
    fileId !== undefined && (schwaerzungen.get(`${fileId}|${page}`) ?? []).some((r) => ueberlappt(r, rect));

  const proMark = (m: Mark): Mark =>
    m.kind === 'redact' || verdeckt(fileIdVon.get(m.docId), m.page, m.rect) ? ohneSnapshot(m) : m;
  const proCutout = (c: Cutout): Cutout => (verdeckt(c.fileId, c.page, c.rect) ? ohneSnapshot(c) : c);

  return {
    ...s,
    ...(s.marks ? { marks: s.marks.map(proMark) } : {}),
    ...(s.cutouts ? { cutouts: s.cutouts.map(proCutout) } : {}),
    ...(s.trash
      ? {
          trash: trash.map((t) => ({
            ...t,
            payload: { ...t.payload, marks: t.payload.marks.map(proMark), cutouts: t.payload.cutouts.map(proCutout) },
          })),
        }
      : {}),
  };
}

export type ImportPruefung = { ok: true } | { ok: false; grund: string };

/** Wächter gegen strukturell kaputte Array-Elemente (z. B. `null`) aus einer Fremddatei:
    isValidState prüft nur, dass ein Feld ein Array IST, nicht die Form seiner Elemente. */
function istObjekt(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null;
}

/**
 * Strenger als isValidState, weil die Eingabe aus einer Fremddatei stammt: isValidState
 * prüft nur, ob die Pflichtfelder Arrays sind — weder deren Inhalte noch referenzielle
 * Integrität. Ein Paket, das hier durchfällt, wird abgewiesen, statt einen halb kaputten
 * Schreibtisch zu erzeugen. Jeder Elementzugriff ist daher durch istObjekt abgesichert,
 * bevor ein Feld gelesen wird — ein kaputtes Element (z. B. null) führt zur Ablehnung
 * statt zu einer Exception.
 */
export function validateImportState(v: unknown): ImportPruefung {
  if (!isValidState(v)) return { ok: false, grund: 'Kein gültiger Schreibtisch-Zustand' };
  const s = v;
  const docIds = new Set(s.docs.map((d) => d.id));

  // Objekt-Kennungen einsammeln — ein kaputtes Element wird hier bereits erkannt, bevor
  // sein fehlendes .id einen TypeError auslösen könnte.
  const stackIds: string[] = [];
  for (const [i, st] of s.stacks.entries()) {
    if (!istObjekt(st)) return { ok: false, grund: `Stapel an Position ${i} ist kein gültiges Objekt` };
    stackIds.push(st.id as string);
  }
  const noteIds: string[] = [];
  for (const [i, n] of (s.notes ?? []).entries()) {
    if (!istObjekt(n)) return { ok: false, grund: `Notiz an Position ${i} ist kein gültiges Objekt` };
    noteIds.push(n.id as string);
  }
  const cutoutIds: string[] = [];
  for (const [i, c] of (s.cutouts ?? []).entries()) {
    if (!istObjekt(c)) return { ok: false, grund: `Ausschnitt an Position ${i} ist kein gültiges Objekt` };
    cutoutIds.push(c.id as string);
  }
  const objektIds = new Set<string>([...docIds, ...stackIds, ...noteIds, ...cutoutIds]);

  for (const [i, l] of s.links.entries()) {
    if (!istObjekt(l)) return { ok: false, grund: `Verknüpfung an Position ${i} ist kein gültiges Objekt` };
    if (typeof l.id !== 'string') return { ok: false, grund: 'Verknüpfung ohne Kennung' };
    if (!objektIds.has(l.fromId as string) || !objektIds.has(l.toId as string)) {
      return { ok: false, grund: `Verknüpfung "${l.id}" zeigt auf ein Objekt, das im Paket fehlt` };
    }
  }
  for (const [i, st] of s.stacks.entries()) {
    if (!istObjekt(st)) return { ok: false, grund: `Stapel an Position ${i} ist kein gültiges Objekt` };
    if (!Array.isArray(st.docIds)) return { ok: false, grund: `Stapel "${st.id}" hat keine Mitgliederliste` };
    for (const id of st.docIds) {
      if (!docIds.has(id)) return { ok: false, grund: `Stapel "${st.id}" nennt das unbekannte Dokument "${id}"` };
    }
  }
  for (const [i, c] of (s.clips ?? []).entries()) {
    if (!istObjekt(c)) return { ok: false, grund: `Klammer an Position ${i} ist kein gültiges Objekt` };
    if (!Array.isArray(c.memberIds)) return { ok: false, grund: `Klammer "${c.id}" hat keine Mitgliederliste` };
    for (const id of c.memberIds) {
      if (!objektIds.has(id)) return { ok: false, grund: `Klammer "${c.id}" nennt das unbekannte Objekt "${id}"` };
    }
  }
  const anDoc: [string, { id: string; docId: string }[]][] = [
    ['Strich', s.strokes ?? []],
    ['Fläche', s.marks ?? []],
    ['Stempel', s.stamps ?? []],
    ['Fahne', s.flags ?? []],
  ];
  for (const [bezeichnung, liste] of anDoc) {
    for (const [i, a] of liste.entries()) {
      if (!istObjekt(a)) return { ok: false, grund: `${bezeichnung} an Position ${i} ist kein gültiges Objekt` };
      if (!docIds.has(a.docId)) {
        return { ok: false, grund: `${bezeichnung} "${a.id}" zeigt auf das unbekannte Dokument "${a.docId}"` };
      }
    }
  }
  for (const [i, c] of (s.cutouts ?? []).entries()) {
    if (!istObjekt(c)) return { ok: false, grund: `Ausschnitt an Position ${i} ist kein gültiges Objekt` };
    if (typeof c.fileId !== 'string' || c.fileId === '') {
      return { ok: false, grund: `Ausschnitt "${c.id}" hat keine Quelldatei` };
    }
  }
  return { ok: true };
}

/** Baut den Zustand aus ausschließlich bekannten Feldern neu — Fremdfelder aus einer
    Paketdatei landen nicht in der Server-DB. Fehlende Optionalfelder bleiben fehlend. */
export function nurBekannteFelder(s: DesktopState): DesktopState {
  const raus: DesktopState = { docs: s.docs, links: s.links, stacks: s.stacks };
  if (s.strokes !== undefined) raus.strokes = s.strokes;
  if (s.notes !== undefined) raus.notes = s.notes;
  if (s.cutouts !== undefined) raus.cutouts = s.cutouts;
  if (s.marks !== undefined) raus.marks = s.marks;
  if (s.stamps !== undefined) raus.stamps = s.stamps;
  if (s.flags !== undefined) raus.flags = s.flags;
  if (s.clips !== undefined) raus.clips = s.clips;
  if (s.trash !== undefined) raus.trash = s.trash;
  if (s.background !== undefined) raus.background = s.background;
  return raus;
}

/** Schreibt alle Dateiverweise um (Umzug zwischen Installationen: storeFile vergibt
    beim Import neue fileIds). Unbekannte fileIds bleiben unverändert stehen. */
export function mapFileIds(s: DesktopState, abbildung: Map<string, string>): DesktopState {
  const neu = (fileId: string): string => abbildung.get(fileId) ?? fileId;
  return {
    ...s,
    docs: s.docs.map((d) => ({ ...d, fileId: neu(d.fileId) })),
    ...(s.cutouts ? { cutouts: s.cutouts.map((c) => ({ ...c, fileId: neu(c.fileId) })) } : {}),
    ...(s.trash
      ? {
          trash: s.trash.map((t) => ({
            ...t,
            payload: {
              ...t.payload,
              docs: t.payload.docs.map((d) => ({ ...d, fileId: neu(d.fileId) })),
              cutouts: t.payload.cutouts.map((c) => ({ ...c, fileId: neu(c.fileId) })),
            },
          })),
        }
      : {}),
  };
}
