/**
 * Telefon-Aufgabenlogik (MOBILE-02, 11-09): reine, DOM-freie Funktionen hinter der
 * Smartphone-Schnellzugriff-Oberfläche — Vorbild anlagenpaketAuswahl.ts (kein Store-Import,
 * keine Svelte-Abhängigkeit, unter Vitest `environment: 'node'` testbar).
 *
 * Die Liste ist eine neue SICHT auf Bestandsdaten, keine neue Datenquelle: gelesen wird
 * ausschließlich aus dem bereits projizierten DesktopState, geschrieben wird am Telefon
 * ausschließlich über das unveränderte Bestands-Kommando setTaskStatus (T-11-22).
 */
import {
  findCutout, type DesktopState, type LegalObject, type TaskPriority, type TaskStatus,
} from '@j-desk/core';

/** Unerledigte Status stehen in der Liste vor den abgeschlossenen (erledigt/übergeben). */
function abgeschlossen(status: TaskStatus | undefined): boolean {
  return status === 'erledigt' || status === 'uebergeben';
}

const PRIORITAET_ORDNUNG: Record<TaskPriority, number> = { hoch: 0, mittel: 1, niedrig: 2 };

/**
 * Aufgabenliste fürs Telefon: Objekte der Art Aufgabe, deren Verantwortlicher fehlt oder dem
 * übergebenen Namen entspricht (der Bestand kennt den Verantwortlichen nur als Freitext —
 * Planner-Annahme, geht in die UAT). Sortierung fünfstufig, vollständig deterministisch:
 * 1. unerledigt vor abgeschlossen, 2. Fälligkeit aufsteigend (ohne Fälligkeit zuletzt),
 * 3. Priorität (hoch, mittel, niedrig), 4. Text, 5. Kennung. Der Zustand bleibt unverändert —
 * sortiert wird eine Kopie.
 */
export function telefonAufgaben(state: DesktopState, nutzerName: string): LegalObject[] {
  const eigene = (state.legalObjects ?? []).filter(
    (o) => o.kind === 'aufgabe' && (o.assignee === undefined || o.assignee === '' || o.assignee === nutzerName),
  );
  return [...eigene].sort((a, b) => {
    const abgeschlossenDiff = Number(abgeschlossen(a.status)) - Number(abgeschlossen(b.status));
    if (abgeschlossenDiff !== 0) return abgeschlossenDiff;
    // Aufsteigend nach Fälligkeit; fehlende Fälligkeit ans Ende der Gruppe.
    if (a.dueDate === undefined && b.dueDate !== undefined) return 1;
    if (a.dueDate !== undefined && b.dueDate === undefined) return -1;
    if (a.dueDate !== undefined && b.dueDate !== undefined && a.dueDate !== b.dueDate) {
      return a.dueDate < b.dueDate ? -1 : 1;
    }
    const prioDiff = PRIORITAET_ORDNUNG[a.priority ?? 'mittel'] - PRIORITAET_ORDNUNG[b.priority ?? 'mittel'];
    if (prioDiff !== 0) return prioDiff;
    const textDiff = a.text.localeCompare(b.text, 'de');
    if (textDiff !== 0) return textDiff;
    return a.id.localeCompare(b.id);
  });
}

/**
 * Nur zwischen diesen beiden Status schaltet das Häkchen um — Aufgaben in Arbeit oder an
 * j-lawyer übergeben bekommen bewusst KEIN Bedienelement, damit kein Zwischenstand eines
 * anderen Geräts still überschrieben wird (T-11-22, UI-SPEC E4/partial).
 */
export function darfAbhaken(status: TaskStatus | undefined): boolean {
  return status === 'offen' || status === 'erledigt';
}

/** Lesetext statt Häkchen für die nicht abhakbaren Status (Copywriting Contract); sonst null. */
export function statusLesetext(status: TaskStatus | undefined): string | null {
  if (status === 'in-arbeit') return 'in Arbeit';
  if (status === 'uebergeben') return 'an j-lawyer übergeben';
  return null;
}

export interface AufgabenHerkunft {
  dokumentName: string;
  seite: number;
  zitat?: string;
}

/**
 * Löst den Dokumentbezug einer Aufgabe fürs Detail-Popover auf. Liefert null, wenn die Aufgabe
 * keinen Bezug trägt oder das benannte Dokument nicht mehr existiert (kein Platzhaltername —
 * T-11-23). Das Zitat aus dem gespeicherten Herkunfts-Schnappschuss (`Cutout.textSnapshot`,
 * das einzige Feld, das der UI-SPEC-Begriff trifft) erscheint NUR, wenn der Bezug eine
 * Ausschnittkennung trägt, dieser Ausschnitt noch existiert und er einen Schnappschuss
 * gespeichert hat.
 *
 * Hintergrund (11-RESEARCH.md Pitfall 3): die MEHRZAHL der Aufgaben trägt gar keinen
 * Ausschnittbezug — sie werden ad hoc angelegt, nicht aus einem Ausschnitt heraus. Ein leerer
 * Zitatbereich wäre also der Regelfall, wenn man ihn nicht ausdrücklich wegließe; zusätzlich
 * könnte ein Platzhalter auf die Existenz eines nicht sichtbaren Ausschnitts hindeuten
 * (T-11-23). Deshalb entfällt das Zitat ersatzlos, statt einen leeren Bereich zu zeichnen.
 */
export function aufgabenHerkunft(state: DesktopState, obj: LegalObject): AufgabenHerkunft | null {
  const bezug = obj.docRef;
  if (!bezug) return null;
  const doc = state.docs.find((d) => d.id === bezug.docId);
  if (!doc) return null;
  const herkunft: AufgabenHerkunft = { dokumentName: doc.name, seite: bezug.page ?? 1 };
  if (bezug.cutoutId) {
    const ausschnitt = findCutout(state, bezug.cutoutId);
    if (ausschnitt?.textSnapshot) herkunft.zitat = ausschnitt.textSnapshot;
  }
  return herkunft;
}
