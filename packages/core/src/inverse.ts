import { CommandError, id, type Command } from './commands';
import { findDoc, findStack, stackOf, type DesktopState } from './model';
import { findNote } from './notes';
import type { TrashedItem } from './trash';

/**
 * Umkehr-Kommandos für die Rücknahme (AI-02): die Inverse wird zur GENEHMIGUNGSZEIT aus dem
 * frisch gelesenen Desk-State berechnet und persistiert, BEVOR das erste Kommando wirkt
 * (Inversen-Pflicht — keine persistierbare Inverse = keine Genehmigung). Nie zum
 * Einreichungszeitpunkt berechnen: zwischen Einreichung und Genehmigung kann ein Mensch den
 * Tisch verändert haben (12-RESEARCH.md Pitfall 4, Stale-Inverse).
 *
 * Bewusste Mengenbegrenzung (12-04): Inversen existieren ausschließlich für die 19
 * genehmigungsfähigen arten (GENEHMIGUNGS_FAEHIGE_ARTEN, vorschlagAnwenden.ts); alles aus
 * LOESCH_COMMANDS/SCHREDDER_COMMANDS (app.ts:131-150) fällt in den default-Wurf — endgültiges
 * Löschen bekommt konstruktiv keine Genehmigungs-Abbildung und keine Inverse, KI-Aufräumen
 * läuft über das Paar trashObject ↔ restoreObject (Papierkorb). Positions-/Text-/Status-
 * Inversen lesen den ALTEN Wert aus dem übergebenen State s (Objekt fehlt → benannter Wurf:
 * ohne lesbaren Alt-Wert ist keine ehrliche Inverse möglich).
 */
export function inverseFuer(s: DesktopState, kommandos: Command[]): Command[] {
  // Pro Kommando eine oder MEHRERE Inverse-Kommandos (dissolveStack → Re-Stack-Sequenz);
  // die Reihenfolge über die Kommandos umkehren (Links vor ihren Endpunkten entfernen
  // etc.), die interne Reihenfolge je Kommando bleibt erhalten.
  return kommandos.map((c) => inverseFuerKommando(s, c)).reverse().flat();
}

function fehlend(type: string, objektId: string): CommandError {
  return new CommandError(`Keine Inverse definierbar für ${type}: Objekt "${objektId}" nicht im aktuellen State`);
}

/**
 * Verknüpfungen ZUM Stapel (fromId/toId === stackId), die dissolveStack entfernt hat: sie
 * werden mit ursprünglicher id, Notiz und Bedeutung wiederhergestellt, NACHDEM der Stapel
 * neu entstanden ist (sonst wäre der Rückbau still unvollständig — AI-02 „ohne Rückstände").
 */
function stapelLinksWiederherstellen(s: DesktopState, stackId: string): Command[] {
  const kommandos: Command[] = [];
  for (const l of s.links) {
    if (l.fromId !== stackId && l.toId !== stackId) continue;
    kommandos.push({ type: 'addLink', payload: { fromId: l.fromId, toId: l.toId, id: l.id } });
    if (l.note !== '') kommandos.push({ type: 'setLinkNote', payload: { linkId: l.id, note: l.note } });
    if (l.kind !== undefined) kommandos.push({ type: 'setLinkKind', payload: { linkId: l.id, kind: l.kind } });
  }
  return kommandos;
}

/** Objekt-id eines Korb-Eintrags (die Inverse von restoreObject muss das Objekt re-trashen).
 *  Exportiert: der Rücknahme-Anker der Genehmigungs-Route (CR-03, proposals.ts) löst die
 *  Objekt-id eines restoreObject-Vorschlags über dieselbe Vorschrift auf — eine Quelle für
 *  „welches Objekt steckt im Korb-Eintrag". */
export function objektIdAusKorbEintrag(t: TrashedItem): string {
  const listen = [
    t.payload.docs, t.payload.notes, t.payload.cutouts, t.payload.stacks,
    t.payload.legalObjects, t.payload.tables, t.payload.zeitleisten,
  ];
  for (const liste of listen) {
    const erstes = liste[0] as { id: string } | undefined;
    if (erstes) return erstes.id;
  }
  throw new CommandError(`Keine Inverse definierbar für restoreObject: Korb-Eintrag "${t.id}" ist leer`);
}

function inverseFuerKommando(s: DesktopState, c: Command): Command[] {
  const p = c.payload ?? {};
  switch (c.type) {
    case 'moveDoc': {
      const docId = id(p.id, 'id');
      const doc = findDoc(s, docId);
      if (!doc) throw fehlend('moveDoc', docId);
      return [{ type: 'moveDoc', payload: { id: docId, position: doc.position } }];
    }
    case 'stackDocs': {
      // Eingetretenes Mitglied wieder herauslösen — an seine alte Position. Überlebt der
      // Rest-Stapel mit nur einem Mitglied, räumt removeFromStack ihn per Auto-dissolve auf
      // (das verbleibende Mitglied landet exakt auf der alten Stapel-Position).
      const draggedId = id(p.draggedId, 'draggedId');
      const doc = findDoc(s, draggedId);
      if (!doc) throw fehlend('stackDocs', draggedId);
      return [{ type: 'removeFromStack', payload: { docId: draggedId, position: doc.position } }];
    }
    case 'removeFromStack': {
      const docId = id(p.docId, 'docId');
      const st = stackOf(s, docId);
      if (!st) throw fehlend('removeFromStack', docId);
      const doc = findDoc(s, docId);
      const sequenz: Command[] = [];
      if (st.docIds.length > 2) {
        // Der Stapel überlebt das Herauslösen — das Mitglied steigt wieder ein. Grenze der
        // Kommando-Fläche: stackDocs hängt immer AN, die ursprüngliche Reihenfolge im
        // Stapel ist nur exakt wiederherstellbar, wenn das herausgelöste Mitglied das
        // letzte war (kein Index-Kommando).
        sequenz.push({ type: 'stackDocs', payload: { draggedId: docId, targetId: st.id } });
      } else {
        // Zwei-Mitglieder-Stapel: das Herauslösen löst den Stapel vollständig auf
        // (Auto-dissolve in removeFromStack) — er wird wie bei der dissolveStack-Inverse
        // mit ursprünglicher id, Stapel-Verknüpfungen und Namen neu aufgebaut.
        const anderes = st.docIds.find((d) => d !== docId)!;
        sequenz.push({ type: 'stackDocs', payload: { draggedId: docId, targetId: anderes, id: st.id } });
        sequenz.push(...stapelLinksWiederherstellen(s, st.id));
        if (st.name !== '') sequenz.push({ type: 'renameStack', payload: { stackId: st.id, name: st.name } });
        const anderesDoc = findDoc(s, anderes);
        if (anderesDoc) sequenz.push({ type: 'moveDoc', payload: { id: anderes, position: anderesDoc.position } });
      }
      if (doc) sequenz.push({ type: 'moveDoc', payload: { id: docId, position: doc.position } });
      return sequenz;
    }
    case 'dissolveStack': {
      const stackId = id(p.stackId, 'stackId');
      const st = findStack(s, stackId);
      if (!st) throw fehlend('dissolveStack', stackId);
      // Re-Stack-Sequenz in ursprünglicher Reihenfolge: das erste Mitglied ist das Ziel,
      // alle weiteren steigen ein — mit der URSPRÜNGLICHEN Stapel-id, damit die
      // wiederhergestellten Verknüpfungen auf die Stapel-id greifen.
      const sequenz: Command[] = [];
      if (st.docIds.length >= 2) {
        sequenz.push({ type: 'stackDocs', payload: { draggedId: st.docIds[1], targetId: st.docIds[0], id: st.id } });
        for (let i = 2; i < st.docIds.length; i++) {
          sequenz.push({ type: 'stackDocs', payload: { draggedId: st.docIds[i], targetId: st.id } });
        }
      }
      sequenz.push(...stapelLinksWiederherstellen(s, st.id));
      if (st.name !== '') sequenz.push({ type: 'renameStack', payload: { stackId: st.id, name: st.name } });
      // Die Stapel-Position entsteht aus der Kaskaden-Position des ersten Mitglieds (=
      // alte Stapel-Position, dissolveStack versetzt um i*40/i*24); danach stellen die
      // moveDoc-Schritte die ursprünglichen Mitglieds-Positionen wieder her.
      for (const docId of st.docIds) {
        const doc = findDoc(s, docId);
        if (doc) sequenz.push({ type: 'moveDoc', payload: { id: docId, position: doc.position } });
      }
      return sequenz;
    }
    case 'renameStack': {
      const stackId = id(p.stackId, 'stackId');
      const st = findStack(s, stackId);
      if (!st) throw fehlend('renameStack', stackId);
      return [{ type: 'renameStack', payload: { stackId, name: st.name } }];
    }
    case 'moveStack': {
      const stackId = id(p.stackId, 'stackId');
      const st = findStack(s, stackId);
      if (!st) throw fehlend('moveStack', stackId);
      return [{ type: 'moveStack', payload: { stackId, position: st.position } }];
    }
    case 'addLink':
      return [{ type: 'removeLink', payload: { linkId: id(p.id, 'id') } }];
    case 'addNote':
      return [{ type: 'removeNote', payload: { id: id(p.id, 'id') } }];
    case 'editNote': {
      const notizId = id(p.id, 'id');
      const notiz = findNote(s, notizId);
      if (!notiz) throw fehlend('editNote', notizId);
      return [{ type: 'editNote', payload: { id: notizId, text: notiz.text } }];
    }
    case 'addStamp':
      // Die id steckt im verschachtelten stamp-Payload (stampPayload-Form, commands.ts).
      return [{ type: 'removeStamp', payload: { stampId: id((p.stamp as Record<string, unknown> | undefined)?.id, 'stamp.id') } }];
    case 'addFlag':
      return [{ type: 'removeFlag', payload: { flagId: id((p.flag as Record<string, unknown> | undefined)?.id, 'flag.id') } }];
    case 'stapleStack':
      return [{ type: 'unstapleStack', payload: { stackId: id(p.stackId, 'stackId') } }];
    case 'unstapleStack':
      return [{ type: 'stapleStack', payload: { stackId: id(p.stackId, 'stackId') } }];
    case 'addClip':
      return [{ type: 'removeClip', payload: { clipId: id(p.id, 'id') } }];
    case 'trashObject':
      // Die trashId kommt aus dem PAYLOAD des Original-Kommandos — der Genehmigungspfad
      // generiert sie vorab (vorschlagAnwenden), darum ist sie hier bekannt, BEVOR das
      // erste Kommando wirkt (Inversen-Pflicht).
      return [{ type: 'restoreObject', payload: { trashId: id(p.trashId, 'trashId') } }];
    case 'restoreObject': {
      const trashId = id(p.trashId, 'trashId');
      const eintrag = (s.trash ?? []).find((t) => t.id === trashId);
      if (!eintrag) throw fehlend('restoreObject', trashId);
      // trashedAt + trashId aus dem Korb-Eintrag des States: das re-trashObject
      // rekonstruiert den Eintrag identisch (Paar trashObject ↔ restoreObject).
      return [{
        type: 'trashObject',
        payload: { id: objektIdAusKorbEintrag(eintrag), trashedAt: eintrag.trashedAt, trashId: eintrag.id },
      }];
    }
    case 'setNoteDone': {
      const notizId = id(p.id, 'id');
      const notiz = findNote(s, notizId);
      if (!notiz) throw fehlend('setNoteDone', notizId);
      return [{ type: 'setNoteDone', payload: { id: notizId, done: notiz.done ?? false } }];
    }
    case 'extractPage':
      // extractPage erzeugt eine pageOnly-KARTE (viewer.ts), keinen Ausschnitt — die
      // Inverse ist removeDoc auf die neue Karten-id (Plan-Korrektur in 12-04: das im
      // Plan genannte removeCutout träfe die falsche Objektart). removeDoc ist hier
      // zulässig, obwohl es zu LOESCH_COMMANDS zählt: die Sperre gilt für genehmigungs-
      // fähige ARTEN, nicht für Inverse-Kommandos, die ausschließlich über die
      // 'manage'-geschützte Rücknahme-Route abgespielt werden.
      return [{ type: 'removeDoc', payload: { id: id(p.id, 'id') } }];
    case 'setLinkNote': {
      const linkId = id(p.linkId, 'linkId');
      const link = s.links.find((l) => l.id === linkId);
      if (!link) throw fehlend('setLinkNote', linkId);
      return [{ type: 'setLinkNote', payload: { linkId, note: link.note } }];
    }
    default:
      throw new CommandError(`Keine Inverse definiert für: ${c.type}`);
  }
}
