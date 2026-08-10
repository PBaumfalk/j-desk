import { freeDocs, type DesktopState, type Doc, type Vec2 } from './model';
import { docBox } from './geometry';
import { linkedEntityIds } from './links';
import { clipOf } from './clips';
import { isTaped } from './tape';

/**
 * Aufräumen-Vorschau-Ermittlung (UX-02, 13-08): reine, DOM-freie Client-Logik — Vitest läuft mit
 * `environment: 'node'`, es gibt kein DOM (Muster views.ts:1-17). Bewusst im Core statt in einem
 * eigenen Server-Endpunkt: die Ermittlung liest ausschließlich den bereits geladenen
 * `DesktopState` — ein eigener Serverpfad wäre ein zweiter Wahrheitspfad neben diesem Modul
 * (13-RESEARCH.md „Vorschau-Ermittlung serverseitig"). Die Ausführung der hier erzeugten
 * Vorschläge läuft NICHT hier, sondern in `AufraeumenDialog.svelte` als Folge einzelner
 * `desktop.command()`-Aufrufe (P7, 13-RESEARCH.md — kein Batch-Kommando, kein neuer Endpunkt).
 *
 * Reinheit (Test-Assertion: State-Referenz unverändert): dieses Modul liest nur, mutiert nie und
 * ruft absichtlich NIE `new Date()`/`Date.now()` auf. `trashObject`-Kommando-Bausteine (Gruppe
 * „Unverbundene Notizen") tragen deshalb bewusst KEIN `trashedAt` — der Ausführungszeitpunkt
 * gehört zum Ausführungsaugenblick (AufraeumenDialog beim Dispatch), nicht zum
 * Ermittlungsaugenblick.
 */

/** Die vier festen Vorschlagsgruppen (Copywriting Contract, 13-UI-SPEC.md). */
export type AufraeumGruppe = 'ausrichten' | 'gruppieren' | 'dubletten' | 'unverbundene-notizen';

/** Feste Überschriften je Gruppe (Copywriting Contract) — nur gerendert, wenn die Gruppe ≥1
 *  Vorschlag hat (E1/partial, AufraeumenDialog.svelte). Die Schlüsselreihenfolge dieses Records
 *  ist zugleich `GRUPPEN_REIHENFOLGE` unten (eine einzige Quelle für „welche Gruppe kommt zuerst"). */
export const GRUPPEN_LABEL: Record<AufraeumGruppe, string> = {
  ausrichten: 'Ausrichten & Sortieren',
  gruppieren: 'Gruppieren',
  dubletten: 'Dubletten',
  'unverbundene-notizen': 'Unverbundene Notizen',
};

const GRUPPEN_REIHENFOLGE: readonly AufraeumGruppe[] = [
  'ausrichten', 'gruppieren', 'dubletten', 'unverbundene-notizen',
];

/** Ein Kommando-Baustein, den `AufraeumenDialog.svelte` 1:1 über `desktop.command(type, payload)`
 *  dispatcht (P7 — derselbe `{type,payload}`-Vertrag wie `Command`, commands.ts). Bewusst ein
 *  eigener, schlanker Typ statt eines Imports aus `./commands`, damit die Vorschau-Ermittlung
 *  nicht von der Kommando-Registry abhängt (keine Zirkularbeziehung Vorschau ↔ Ausführung). */
export interface AufraeumKommando {
  type: string;
  payload: Record<string, unknown>;
}

export interface AufraeumVorschlag {
  id: string;
  gruppe: AufraeumGruppe;
  beschreibung: string;
  objektIds: string[];
  namen: string[];
  aktion: { kommandos: AufraeumKommando[] };
}

// ---- Schwellen-Konstanten (Planner-Annahmen, UAT-kalibrierbar ohne Architekturänderung) ----

/** Mindestanzahl für einen Ausrichten-Vorschlag: drei ist die kleinste Menge, bei der „eine
 *  Reihe" optisch erkennbar wird — zwei Karten liegen häufig zufällig nah beieinander, ohne dass
 *  das etwas über eine gewollte Ausrichtung aussagt. */
const AUSRICHTEN_MIN = 3;
/** Toleranzband für „nahe dem linken Rand" in Weltpixeln — rund ein Sechstel der Kartenbreite
 *  (`CARD_W` = 180, model.ts): enger als „irgendwo auf dem Tisch", großzügig genug für leichte
 *  Freihand-Ablage. */
const AUSRICHTEN_STREUUNG_PX = 32;
/** Radius für „räumliche Nähe" (Gruppieren) in Weltpixeln, gemessen zwischen Kartenmitten
 *  (`docBox`-Zentren, geometry.ts) — knapp unter der Kartenbreite: Karten, die sich (fast)
 *  überlappen, wirken „eigentlich schon wie ein Stapel". */
const GRUPPIEREN_RADIUS_PX = 140;
/** Anzahl Objektnamen, die eine Beschreibung wörtlich nennt — der Rest wird als „und N weitere"
 *  zusammengefasst (E1/long-text: die Aktionsbeschreibung ist erzeugter Text mit gebremster
 *  Länge, unabhängig von der Gruppengröße). */
const BESCHREIBUNG_NAMEN_MAX = 3;
/** Obergrenze je genanntem Einzelnamen (Notizzettel tragen Freitext statt eines Dateinamens und
 *  können beliebig lang sein) — Ellipsis in der Beschreibung selbst, zusätzlich zur
 *  UI-Ellipsis+`title` am Zeilenlabel (AufraeumenDialog.svelte, Bestandsmuster `.umfang-name`). */
const EINZELNAME_MAX = 60;

function kuerzeName(name: string): string {
  const einzeilig = name.replace(/\s+/g, ' ').trim() || 'Zettel';
  return einzeilig.length > EINZELNAME_MAX ? `${einzeilig.slice(0, EINZELNAME_MAX - 1)}…` : einzeilig;
}

/** Nennt bis zu `BESCHREIBUNG_NAMEN_MAX` Objektnamen wörtlich, der Rest als „und N weitere". */
function nenneNamen(namen: string[]): string {
  const gekuerzt = namen.map(kuerzeName);
  if (gekuerzt.length <= BESCHREIBUNG_NAMEN_MAX) return gekuerzt.join(', ');
  const rest = gekuerzt.length - BESCHREIBUNG_NAMEN_MAX;
  return `${gekuerzt.slice(0, BESCHREIBUNG_NAMEN_MAX).join(', ')} und ${rest} weitere`;
}

function boxMitte(d: Doc): Vec2 {
  const b = docBox(d);
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

/**
 * Gruppe „Ausrichten & Sortieren": freie Docs (kein Stapelmitglied, `freeDocs()`), deren linke
 * Kante (`docBox(d).x` — identisch zu `d.position.x` bei jeder Kartenart) innerhalb eines
 * zusammenhängenden Streifens von `AUSRICHTEN_STREUUNG_PX` liegt. Sortiert aufsteigend nach
 * x-Koordinate (Tie-Break id), dann ein gieriges Sliding-Window: da die Liste sortiert ist, ist
 * `kandidaten[i]` stets das Minimum jedes bei `i` startenden Fensters — die Prüfung
 * `kandidaten[j+1].x - kandidaten[i].x <= SCHWELLE` bindet also korrekt die volle Streuung
 * (max-min) des Fensters, nicht nur den Abstand zum Vorgänger (keine Drift-Kette). Fenster ab
 * `AUSRICHTEN_MIN` Mitgliedern werden zu einem Vorschlag, das Ziel ist die kleinste x-Koordinate
 * im Fenster (linker Rand). Docs, die bereits exakt dort stehen, tauchen in `objektIds`/`namen`
 * auf (vollständige Gruppe), aber nicht in `aktion.kommandos` (kein Leerlauf-`moveDoc`).
 */
function ermittleAusrichtenVorschlaege(state: DesktopState): AufraeumVorschlag[] {
  const kandidaten = freeDocs(state)
    .slice()
    .sort((a, b) => docBox(a).x - docBox(b).x || a.id.localeCompare(b.id));
  const vorschlaege: AufraeumVorschlag[] = [];
  let i = 0;
  while (i < kandidaten.length) {
    const startX = docBox(kandidaten[i]).x;
    let j = i;
    while (j + 1 < kandidaten.length && docBox(kandidaten[j + 1]).x - startX <= AUSRICHTEN_STREUUNG_PX) j++;
    const cluster = kandidaten.slice(i, j + 1);
    if (cluster.length >= AUSRICHTEN_MIN) {
      const zielX = Math.min(...cluster.map((d) => docBox(d).x));
      const namen = cluster.map((d) => d.name);
      vorschlaege.push({
        id: `ausrichten-${cluster.map((d) => d.id).join('-')}`,
        gruppe: 'ausrichten',
        beschreibung: `${cluster.length} Dokumente am linken Rand ausrichten (${nenneNamen(namen)})`,
        objektIds: cluster.map((d) => d.id),
        namen,
        aktion: {
          kommandos: cluster
            .filter((d) => d.position.x !== zielX)
            .map((d) => ({ type: 'moveDoc', payload: { id: d.id, position: { x: zielX, y: d.position.y } } })),
        },
      });
      i = j + 1;
    } else {
      i += 1;
    }
  }
  return vorschlaege;
}

/**
 * Gruppe „Gruppieren": freie Docs, deren `docBox`-Mittelpunkte innerhalb von
 * `GRUPPIEREN_RADIUS_PX` beieinanderliegen, werden per Union-Find zu zusammenhängenden Clustern
 * verschmolzen (transitive Nähe — eine Kette aus mehr als zwei Karten wird EIN Vorschlag statt
 * mehrerer sich überlappender Zwei-Karten-Vorschläge). Bereits gestapelte Docs sind über
 * `freeDocs()` von vornherein ausgeschlossen („Dokumente in Stapeln werden nicht erneut
 * vorgeschlagen" — automatisch, kein Sonderfall nötig). Aktion ist `stackDocs`-artig: die zweite
 * bis letzte Karte (sortiert nach id) wird auf die erste gestapelt.
 */
function ermittleGruppierenVorschlaege(state: DesktopState): AufraeumVorschlag[] {
  const kandidaten = freeDocs(state).slice().sort((a, b) => a.id.localeCompare(b.id));
  const mitten = new Map(kandidaten.map((d) => [d.id, boxMitte(d)] as const));
  const eltern = new Map<string, string>(kandidaten.map((d) => [d.id, d.id]));
  function find(id: string): string {
    let wurzel = id;
    while (eltern.get(wurzel) !== wurzel) wurzel = eltern.get(wurzel) as string;
    return wurzel;
  }
  function vereinigen(a: string, b: string): void {
    const wa = find(a);
    const wb = find(b);
    if (wa !== wb) eltern.set(wa, wb);
  }
  for (let i = 0; i < kandidaten.length; i++) {
    const ma = mitten.get(kandidaten[i].id) as Vec2;
    for (let j = i + 1; j < kandidaten.length; j++) {
      const mb = mitten.get(kandidaten[j].id) as Vec2;
      if (Math.hypot(ma.x - mb.x, ma.y - mb.y) <= GRUPPIEREN_RADIUS_PX) {
        vereinigen(kandidaten[i].id, kandidaten[j].id);
      }
    }
  }
  const cluster = new Map<string, Doc[]>();
  for (const d of kandidaten) {
    const wurzel = find(d.id);
    const liste = cluster.get(wurzel) ?? [];
    liste.push(d);
    cluster.set(wurzel, liste);
  }
  const vorschlaege: AufraeumVorschlag[] = [];
  for (const gruppe of cluster.values()) {
    if (gruppe.length < 2) continue;
    const sortiert = gruppe.slice().sort((a, b) => a.id.localeCompare(b.id));
    const namen = sortiert.map((d) => d.name);
    vorschlaege.push({
      id: `gruppieren-${sortiert.map((d) => d.id).join('-')}`,
      gruppe: 'gruppieren',
      beschreibung: `${sortiert.length} Dokumente stapeln (${nenneNamen(namen)})`,
      objektIds: sortiert.map((d) => d.id),
      namen,
      aktion: {
        kommandos: sortiert.slice(1).map((d) => ({
          type: 'stackDocs',
          payload: { draggedId: d.id, targetId: sortiert[0].id },
        })),
      },
    });
  }
  return vorschlaege.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Gruppe „Dubletten": freie Docs mit identischer `fileId` (A4, 13-RESEARCH.md — `copyObject`
 * legitimiert geteilte `fileId`, trash.ts:104-107). Die vorgeschlagene Aktion ist ausschließlich
 * Zusammenführen/Stapeln (`stackDocs`) — diese Gruppe enthält bewusst NIE ein `trashObject`
 * (Verbotsliste 13-08-PLAN.md: „Die Dubletten-Gruppe schlägt niemals Löschen ohne Abwahl vor").
 */
function ermittleDublettenVorschlaege(state: DesktopState): AufraeumVorschlag[] {
  const kandidaten = freeDocs(state).slice().sort((a, b) => a.id.localeCompare(b.id));
  const nachFileId = new Map<string, Doc[]>();
  for (const d of kandidaten) {
    const liste = nachFileId.get(d.fileId) ?? [];
    liste.push(d);
    nachFileId.set(d.fileId, liste);
  }
  const vorschlaege: AufraeumVorschlag[] = [];
  for (const gruppe of nachFileId.values()) {
    if (gruppe.length < 2) continue;
    const namen = gruppe.map((d) => d.name);
    vorschlaege.push({
      id: `dubletten-${gruppe.map((d) => d.id).join('-')}`,
      gruppe: 'dubletten',
      beschreibung: `${gruppe.length} Dokumente mit gleicher Quelle zusammenführen (${nenneNamen(namen)})`,
      objektIds: gruppe.map((d) => d.id),
      namen,
      aktion: {
        // KEIN trashObject in dieser Gruppe (s. Kopfkommentar der Funktion) — ausschließlich
        // stackDocs, dieselbe Ausführungsform wie „Gruppieren".
        kommandos: gruppe.slice(1).map((d) => ({
          type: 'stackDocs',
          payload: { draggedId: d.id, targetId: gruppe[0].id },
        })),
      },
    });
  }
  return vorschlaege.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Gruppe „Unverbundene Notizen": Notizzettel ohne Verknüpfung (`linkedEntityIds`, links.ts),
 * ohne Büroklammer-Gruppe (`clipOf`, clips.ts) und ohne Klebeband (`isTaped`, tape.ts) — kein
 * eigener Verknüpfungsgraph, ausschließlich Bestands-Prüffunktionen (Don't Hand-Roll,
 * 13-RESEARCH.md). Jede unverbundene Notiz erzeugt EINEN eigenen Vorschlag (kein Batch), die
 * einzige Gruppe, deren Aktion `trashObject` enthält (in den Papierkorb legen — reversibel,
 * TrashCan hält den Eintrag wiederherstellbar).
 */
function ermittleUnverbundeneNotizenVorschlaege(state: DesktopState): AufraeumVorschlag[] {
  const notizen = (state.notes ?? []).slice().sort((a, b) => a.id.localeCompare(b.id));
  const vorschlaege: AufraeumVorschlag[] = [];
  for (const n of notizen) {
    if (linkedEntityIds(state, n.id).length > 0) continue;
    if (clipOf(state, n.id) !== undefined) continue;
    if (isTaped(state, n.id)) continue;
    const name = n.text || 'Zettel';
    vorschlaege.push({
      id: `unverbundene-notizen-${n.id}`,
      gruppe: 'unverbundene-notizen',
      beschreibung: `Unverbundenen Zettel „${kuerzeName(name)}" in den Papierkorb legen`,
      objektIds: [n.id],
      namen: [name],
      // trashObject NUR in dieser Gruppe (13-08-PLAN.md) — bewusst OHNE trashedAt, s.
      // Kopfkommentar dieses Moduls (Zeitpunkt gehört zur Ausführung, nicht zur Ermittlung).
      aktion: { kommandos: [{ type: 'trashObject', payload: { id: n.id } }] },
    });
  }
  return vorschlaege;
}

/**
 * Ermittelt alle Aufräumen-Vorschläge über den vier festen Gruppen (UX-02). Rein, synchron,
 * nebenwirkungsfrei — liest ausschließlich `state`, ruft nie `new Date()`/`Date.now()` auf und
 * gibt bei jedem Aufruf auf demselben `state` dieselbe Reihenfolge zurück (stabile Sortierung
 * innerhalb jeder Gruppe + feste Gruppenreihenfolge `GRUPPEN_REIHENFOLGE`). Eine Gruppe ohne
 * Vorschläge liefert schlicht ein leeres Array — `AufraeumenDialog.svelte` blendet sie dann
 * vollständig aus (E1/partial, kein Andeuten einer leeren Überschrift).
 */
export function ermittleVorschlaege(state: DesktopState): AufraeumVorschlag[] {
  const gruppen: Record<AufraeumGruppe, AufraeumVorschlag[]> = {
    ausrichten: ermittleAusrichtenVorschlaege(state),
    gruppieren: ermittleGruppierenVorschlaege(state),
    dubletten: ermittleDublettenVorschlaege(state),
    'unverbundene-notizen': ermittleUnverbundeneNotizenVorschlaege(state),
  };
  return GRUPPEN_REIHENFOLGE.flatMap((g) => gruppen[g]);
}
