import { VERSIONIERTE_ARTEN, type DesktopState } from '@j-desk/core';
import type { Db } from '../db';

interface IndexZeile {
  text: string;
  ersteller: string | null;
  datum: string | null;
}

/**
 * Liefert die Indexzeile für ein einzelnes Objekt einer versionierten Art — oder `null`, wenn
 * diese Art/dieses Objekt (noch) nicht indiziert wird. Jede Art aus `VERSIONIERTE_ARTEN` hat
 * einen EXPLIZITEN Zweig (keine Restklausel), damit eine später ergänzte Art nicht stillschweigend
 * unindiziert bleibt (T-07-13) — der Vollständigkeitslauf in `searchSync.test.ts` iteriert genau
 * über `VERSIONIERTE_ARTEN` und verlangt für jede Art eine bewusste Entscheidung.
 *
 * Die Funktion darf `layerId`/`freigabe` NICHT auswerten, um Text weglassen oder aufnehmen zu
 * entscheiden (Sichtbarkeitsprohibition, 07-02-PLAN.md) — die einzige Sichtbarkeitsgrenze ist
 * `projectStateForActor()` beim Ausliefern (searchQuery.ts), niemals hier beim Indizieren.
 *
 * `legalObjects` (LEGAL-01, Phase 8) folgt demselben Muster wie `notes`: der Objekttext wird
 * unverändert indiziert, auch hier ohne `layerId`/`freigabe`-Auswertung.
 *
 * `tables` (CALC-01, Phase 8) indiziert NUR den Kartentitel — Zellinhalte bleiben bewusst
 * unindiziert: eine Zahlen-/Datums-Zelle trägt anders als Freitext (notes/legalObjects) keinen
 * eigenständigen Suchnutzen.
 *
 * `zeitleisten` (CHRONO-01, 09-02) indiziert NUR den Kartentitel — exakt nach demselben Muster
 * wie `tables` oben. Die EINTRÄGE selbst werden bewusst NICHT indiziert (kein eigener
 * Indexeintrag pro Eintrag): ein Eintrag trägt keinen eigenen Text, sondern nur eine Referenz
 * (`objRef`) auf ein Objekt, das bereits über seine eigene Art eigenständig indiziert ist. Ein
 * zweiter Indexeintrag über dieselbe Aussage wäre ein Duplikat, und ein Datum ohne Freitext trägt
 * keinen eigenständigen Suchnutzen — dieselbe Lesart wie bei den Tabellenzellen oben.
 *
 * `sitzungsmappen` (SESS-02, 11-01) wird BEWUSST NICHT indiziert (T-11-04) — anders als
 * `tables`/`zeitleisten` trägt sie hier gar keinen expliziten Textzweig, sondern läuft mit
 * `strokes`/`clips` im frühen Ausschlusszweig unten: der Titel ist reines Organisationsmetadatum,
 * die Agenda-Dokumente sind bereits über ihre eigene Art (`docs`) eigenständig indiziert, und der
 * Freitext der offenen Fragen soll bewusst keine neue Suchfläche für vertrauliche
 * Vorbereitungsnotizen öffnen. `SUCHINDEX_VERSION` (searchIndex.ts) wird deshalb NICHT erhöht —
 * es gibt keine neue Textquelle, die ein Vollreindex nachholen müsste.
 */
export function indexZeileFuer(art: string, obj: unknown): IndexZeile | null {
  if (obj === null || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;

  // strokes (Geometrie ohne Text) und clips (reine Verbindung ohne Text) haben grundsätzlich
  // keine Textquelle — bewusst früh ausgeschlossen statt implizit durch die Restklausel unten,
  // damit eine später versehentlich ergänzte Textquelle für diese beiden Arten nicht still
  // durchfällt. sitzungsmappen (T-11-04) steht bewusst hier statt in der Restklausel — dieselbe
  // Begründung, aber fachlich anders motiviert (Vertraulichkeit statt fehlender Textquelle, s. o.).
  // zones (UX-03, 13-02) ist die dritte bewusste Entscheidung: Zonen sind reine
  // Orientierungsstruktur (geteilte Sprungziele der Palette), keine Fundstellen-Fachlichkeit —
  // die Volltextsuche findet Inhalte, Zonen-Sprünge laufen über die Palette-Registry (13-04).
  if (art === 'strokes' || art === 'clips' || art === 'sitzungsmappen' || art === 'zones') return null;

  let text: string | undefined;
  if ((art === 'docs' || art === 'stacks') && typeof o.name === 'string') {
    text = o.name;
  } else if (art === 'notes' && typeof o.text === 'string') {
    const customLabel = typeof o.customLabel === 'string' && o.customLabel.trim() !== '' ? `${o.customLabel} ` : '';
    text = `${customLabel}${o.text}`;
  } else if (art === 'legalObjects' && typeof o.text === 'string') {
    text = o.text;
  } else if (art === 'tables' && typeof o.titel === 'string') {
    // Zellinhalte werden hier BEWUSST nicht indiziert (siehe Funktionskommentar oben) — nur der
    // Kartentitel trägt eine indizierbare Textaussage.
    text = o.titel;
  } else if (art === 'zeitleisten' && typeof o.titel === 'string') {
    // Einträge werden hier BEWUSST nicht indiziert (siehe Funktionskommentar oben) — nur der
    // Kartentitel trägt eine indizierbare Textaussage, exakt wie bei tables.
    text = o.titel;
  } else if (art === 'links' && typeof o.note === 'string') {
    text = o.note;
  } else if (art === 'stamps' && typeof o.text === 'string') {
    text = o.text;
  } else if (art === 'cutouts') {
    const snapshot = typeof o.textSnapshot === 'string' ? o.textSnapshot : '';
    const sourceName = typeof o.sourceName === 'string' ? o.sourceName : '';
    text = [snapshot, sourceName].filter((t) => t !== '').join(' ');
  } else if (art === 'flags' && typeof o.label === 'string') {
    // Fahnen tragen nur ein Kurzlabel ohne fachliche Textaussage — indiziert wird es trotzdem
    // (falls gesetzt), rein für den Vollständigkeitsanspruch von SEARCH-01; ein eigener
    // Trefferart-Badge für Fahnen ist NICHT Teil dieser Phase (07-03-PLAN.md kennt keine
    // Fahnen-Klick-Weiche, 07-UI-SPEC.md definiert keinen Fahnen-Art-Badge) — ein Fahnen-Treffer
    // wird von `sucheAufDesk()` daher indiziert, aber lautlos aus der Ergebnisliste gefiltert.
    text = o.label;
  } else if (art === 'marks') {
    // Eine Markierung ohne erkannten Ursprungstext (häufig bei Flächen über Bildbereichen ohne
    // Textextraktion) bekommt TROTZDEM eine Indexzeile mit leerem Text — anders als jede andere
    // Art hier bleibt eine textlose Markierung über Ersteller/Datum weiterhin auffindbar (siehe
    // must_haves.truths in 07-02-PLAN.md).
    text = typeof o.textSnapshot === 'string' ? o.textSnapshot : '';
  }

  if (art !== 'marks' && (text === undefined || text.trim() === '')) return null;
  if (text === undefined) return null;

  const ersteller = typeof o.createdBy === 'string' ? o.createdBy : null;
  const datum = datumAus(o.createdAt);
  return { text, ersteller, datum };
}

/**
 * Zwei Schreibweisen desselben Datums in EIN Feld, getrennt durch ein Leerzeichen — die
 * ISO-Form (`2026-03-14`) und die deutsche Form (`14.03.2026`) — damit beide Eingabegewohnheiten
 * treffen (Claude's Discretion, 07-CONTEXT.md/07-RESEARCH.md).
 */
function datumAus(createdAt: unknown): string | null {
  if (typeof createdAt !== 'string' || createdAt.trim() === '') return null;
  const iso = createdAt.slice(0, 10);
  const teile = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!teile) return iso;
  const [, jahr, monat, tag] = teile;
  return `${iso} ${tag}.${monat}.${jahr}`;
}

interface Versioniert {
  id: string;
  layerId?: string;
}

// applyDeskCommand()/putDeskState() rufen syncSearchIndex() UNBEDINGT auf — auch dann, wenn
// (nur in Tests real möglich: eine Bestandsdatenbank wird bewusst über openDbRaw() OHNE
// migrate() geöffnet, um einen Vorzustand nachzustellen, s. migration.rollback.test.ts) die
// Tabelle noch gar nicht existiert. Ein Cache pro Db-Verbindung spart den sqlite_master-Lookup,
// sobald die Tabelle einmal gesehen wurde (sie wird danach nie wieder gelöscht).
const ftsVorhandenCache = new WeakMap<Db, true>();

function searchFtsVorhanden(db: Db): boolean {
  if (ftsVorhandenCache.has(db)) return true;
  const vorhanden = !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='search_fts'").get();
  if (vorhanden) ftsVorhandenCache.set(db, true);
  return vorhanden;
}

/**
 * Hält `search_fts` synchron mit den zwei Schreibpunkten von `desks.state`
 * (`applyDeskCommand`/`putDeskState` in deskStore.ts) — dieselbe Referenzvergleichs-Technik
 * wie `stempeleGeaenderte` (stempel.ts): jeder Command-Handler gibt neue Objekte per Spread
 * zurück und mutiert nie, unveränderte Objektreferenz bedeutet also unveränderten Inhalt.
 * Aufruf MUSS innerhalb derselben Transaktion stehen, die auch `desks.state` schreibt — sonst
 * könnte ein Absturz zwischen State-Write und Index-Sync den Index gegen die Wahrheit
 * driften lassen (T-07-07).
 *
 * No-op, solange `search_fts` noch nicht existiert (migrateSearchIndex() ist noch nie gelaufen,
 * z. B. weil eine Bestandsdatenbank per openDbRaw() ohne migrate() geöffnet wurde) — der Index
 * ist jederzeit vollständig aus `desks.state` rekonstruierbar, migrateSearchIndex() holt jeden
 * so übersprungenen Schreibvorgang beim nächsten regulären Start per Vollreindex nach.
 */
export function syncSearchIndex(db: Db, deskId: string, alt: DesktopState, neu: DesktopState): void {
  if (alt === neu) return;
  if (!searchFtsVorhanden(db)) return;

  for (const art of VERSIONIERTE_ARTEN) {
    const vorher = (alt as unknown as Record<string, Versioniert[] | undefined>)[art] ?? [];
    const nachher = (neu as unknown as Record<string, Versioniert[] | undefined>)[art] ?? [];
    if (vorher === nachher) continue;

    const vorherNachId = new Map(vorher.map((o) => [o.id, o]));
    const nachherIds = new Set(nachher.map((o) => o.id));

    // Gelöschte Objekte: in vorher, aber nicht mehr in nachher.
    for (const o of vorher) {
      if (!nachherIds.has(o.id)) {
        db.prepare('DELETE FROM search_fts WHERE desk_id = ? AND obj_id = ?').run(deskId, o.id);
      }
    }
    // Neue/geänderte Objekte: Referenz unterscheidet sich vom gleichnamigen Eintrag in vorher.
    for (const o of nachher) {
      if (vorherNachId.get(o.id) === o) continue; // unverändert (Referenzidentität)
      db.prepare('DELETE FROM search_fts WHERE desk_id = ? AND obj_id = ?').run(deskId, o.id);
      const zeile = indexZeileFuer(art, o);
      if (!zeile) continue;
      db.prepare(
        `INSERT INTO search_fts (desk_id, obj_type, obj_id, layer_id, text, ersteller, datum)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(deskId, art, o.id, (o as Versioniert).layerId ?? null, zeile.text, zeile.ersteller, zeile.datum);
    }
  }
}
