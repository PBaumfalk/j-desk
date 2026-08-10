import { CommandError, id, num, optId, optStr, text, vec, type Command } from './commands';
import { uid } from './uid';
import type { Vorschlag } from './vorschlag';

/**
 * Arten mit hinterlegter Genehmigungs-Abbildung im switch unten — die Whitelist des
 * Erstellungspfads (packages/server/src/proposals.ts, 12-03) liest DIESE Menge, damit
 * Whitelist und Abbildung nie auseinanderlaufen: eine art, die hier fehlt, wird bereits bei
 * der Erstellung mit 422 'art_nicht_genehmigungsfähig' abgelehnt statt erst bei der
 * Genehmigung zu werfen. Der Wächtertest (vorschlagAnwenden.test.ts) sichert die Sync.
 *
 * 12-04: sortiertes Array mit allen 19 arten (Sortierung ist Vertrag — deterministische
 * Diffbarkeit). Endgültige Lösch-/Schredder-arten (LOESCH_COMMANDS/SCHREDDER_COMMANDS,
 * app.ts:131-150) gehören hier NIEMALS hinein — KI-Aufräumen läuft ausschließlich über
 * trashObject, dessen Inverse restoreObject ist (T-12-04-04); der Ausschluss ist über die
 * Regressionssperre im Test abgesichert.
 */
export const GENEHMIGUNGS_FAEHIGE_ARTEN: readonly string[] = [
  'addClip', 'addFlag', 'addLink', 'addNote', 'addStamp', 'dissolveStack', 'editNote',
  'extractPage', 'moveDoc', 'moveStack', 'removeFromStack', 'renameStack', 'restoreObject',
  'setLinkNote', 'setNoteDone', 'stackDocs', 'stapleStack', 'trashObject', 'unstapleStack',
];

/**
 * Reine Abbildung Vorschlag → reguläre Command-Liste (AI-01): die abgeleiteten Kommandos
 * laufen bei der Genehmigung durch dieselbe applyCommand/applyDeskCommand-Maschinerie wie
 * menschliche Aktionen — es gibt keinen zweiten Schreibpfad. Bewusste Mengenbegrenzung: nur
 * Arten mit hinterlegter Abbildung sind genehmigungsfähig; 12-04 bildet alle 19 arten ab.
 * Jeder Zweig validiert ausschließlich über die Bestandshelfer id()/text()/optId()/num()/
 * vec()/optStr() aus commands.ts — kein roher Payload-Zugriff, dieselben deutschen
 * Feldfehler wie am /commands-Pfad. Unbekannte Arten werfen einen benannten Fehler, BEVOR
 * irgendetwas persistiert wird.
 */
export function vorschlagAnwenden(v: Vorschlag): Command[] {
  const p = v.payload;
  switch (v.art) {
    case 'moveDoc':
      return [{ type: 'moveDoc', payload: { id: id(p.id, 'id'), position: vec(p.position, 'position') } }];
    case 'stackDocs':
      // id ist Client-Konvention (neue Stapel-id); fehlt sie, vergibt der Server eine —
      // dieselbe optId-Fallback-Regel wie am /commands-Pfad.
      return [{ type: 'stackDocs', payload: { draggedId: id(p.draggedId, 'draggedId'), targetId: id(p.targetId, 'targetId'), id: optId(p.id) ?? uid() } }];
    case 'removeFromStack':
      return [{ type: 'removeFromStack', payload: { docId: id(p.docId, 'docId'), position: vec(p.position, 'position') } }];
    case 'dissolveStack':
      return [{ type: 'dissolveStack', payload: { stackId: id(p.stackId, 'stackId') } }];
    case 'renameStack':
      return [{ type: 'renameStack', payload: { stackId: id(p.stackId, 'stackId'), name: text(p.name, 'name') } }];
    case 'moveStack':
      return [{ type: 'moveStack', payload: { stackId: id(p.stackId, 'stackId'), position: vec(p.position, 'position') } }];
    case 'addLink':
      return [{ type: 'addLink', payload: { fromId: id(p.fromId, 'fromId'), toId: id(p.toId, 'toId'), id: optId(p.id) ?? uid() } }];
    case 'addNote':
      // kind wird durchgereicht — die NOTE_KINDS-Prüfung liegt im addNote-Handler
      // (notes.ts); die id ist Client-Konvention, fehlt sie, vergibt der Server eine
      // (derselbe optId-Fallback wie am /commands-Pfad).
      return [{
        type: 'addNote',
        payload: {
          id: optId(p.id) ?? uid(),
          kind: id(p.kind, 'kind'),
          text: text(p.text, 'text'),
          position: vec(p.position, 'position'),
        },
      }];
    case 'editNote':
      return [{ type: 'editNote', payload: { id: id(p.id, 'id'), text: text(p.text, 'text') } }];
    case 'addStamp': {
      // Die exakten Pflichtfelder aus stamps.ts (stampPayload) gespiegelt: docId, page, x, y,
      // angle, text, color, baseW, baseH; optional date + id. Farbe/Inhalt prüft der Handler.
      const stamp: Record<string, unknown> = {
        id: optId(p.id) ?? uid(),
        docId: id(p.docId, 'docId'),
        page: num(p.page, 'page'),
        x: num(p.x, 'x'),
        y: num(p.y, 'y'),
        angle: num(p.angle, 'angle'),
        text: text(p.text, 'text'),
        color: text(p.color, 'color'),
        baseW: num(p.baseW, 'baseW'),
        baseH: num(p.baseH, 'baseH'),
      };
      const date = optStr(p.date);
      if (date !== undefined) stamp.date = date;
      return [{ type: 'addStamp', payload: { stamp } }];
    }
    case 'addFlag': {
      // Pflichtfelder aus flags.ts (flagPayload): docId, page, offset, color; optional label + id.
      const flag: Record<string, unknown> = {
        id: optId(p.id) ?? uid(),
        docId: id(p.docId, 'docId'),
        page: num(p.page, 'page'),
        offset: num(p.offset, 'offset'),
        color: text(p.color, 'color'),
      };
      const label = optStr(p.label);
      if (label !== undefined) flag.label = label;
      return [{ type: 'addFlag', payload: { flag } }];
    }
    case 'stapleStack':
      return [{ type: 'stapleStack', payload: { stackId: id(p.stackId, 'stackId') } }];
    case 'unstapleStack':
      return [{ type: 'unstapleStack', payload: { stackId: id(p.stackId, 'stackId') } }];
    case 'addClip':
      return [{ type: 'addClip', payload: { aId: id(p.aId, 'aId'), bId: id(p.bId, 'bId'), id: optId(p.id) ?? uid() } }];
    case 'trashObject':
      // trashId wird bei der Genehmigung VORAB generiert (optId-Muster, additiv am Handler —
      // trash.ts nutzt sie, wenn vorhanden, sonst uid()): nur so kennt inverseFuer die
      // restoreObject-Inverse, BEVOR das erste Kommando wirkt (Inversen-Pflicht bleibt
      // ungebrochen). trashedAt ist der Genehmigungszeitpunkt (clientseitige Konvention,
      // hier serverseitig gesetzt).
      return [{
        type: 'trashObject',
        payload: {
          id: id(p.objectId, 'objectId'),
          trashedAt: new Date().toISOString(),
          trashId: optId(p.trashId) ?? uid(),
        },
      }];
    case 'restoreObject':
      return [{ type: 'restoreObject', payload: { trashId: id(p.trashId, 'trashId') } }];
    case 'setNoteDone':
      // Dieselbe explizite Boolean-Prüfung wie der setNoteDone-Handler (commands.ts, T-11-05).
      if (typeof p.done !== 'boolean') throw new CommandError('Feld "done" muss true oder false sein');
      return [{ type: 'setNoteDone', payload: { id: id(p.id, 'id'), done: p.done as boolean } }];
    case 'extractPage':
      return [{
        type: 'extractPage',
        payload: {
          docId: id(p.docId, 'docId'),
          page: num(p.page, 'page'),
          position: vec(p.position, 'position'),
          id: optId(p.id) ?? uid(),
        },
      }];
    case 'setLinkNote':
      return [{ type: 'setLinkNote', payload: { linkId: id(p.linkId, 'linkId'), note: text(p.note, 'note') } }];
    default:
      throw new CommandError(`Keine Genehmigungs-Abbildung definiert für: ${v.art}`);
  }
}
