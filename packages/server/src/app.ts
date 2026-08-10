import { readFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import {
  CommandError, KonfliktError, addDoc, trashedFileIds, emptyState, TEXT_SNAPSHOT_MAX, mapFileIds,
  darfAktion, darfEbeneBearbeiten, findeEbene, findeObjekt, findePrivateEbeneFuer, istObjektSichtbarFuer, zielObjektIdsFuerCommand,
  findLegalObject,
  type ActorContext, type Command, type DesktopState, type Doc, type Erwartet, type GefahrlicheAktion, type Rolle,
  projectStateForActor,
} from '@j-desk/core';
import { getSetting, claimBetriebsmodus, type Db } from './db';
import {
  needsSetup, createUser, createFirstUser, login, logout, validateToken, createWsTickets, createFileTickets,
  createSession, ensureExternalUser, AuthError, type FileTickets,
} from './auth';
import {
  validateLogin, listCases, listDocuments, getDocumentMeta, getDocumentContent, getCase,
  createDocument, createDueDate, probeJLawyer, getApiMetadata, JLawyerError, type JLawyerFehlerArt,
} from './jlawyer';
import {
  createDesk, listDesks, listDesksOwnedBy, getDeskOwner, getRolleForNutzer, renameDesk, deleteDesk, getDeskState,
  ensureDesk, applyDeskCommand, putDeskState, listMembers, setRolle, setRolleFuerNutzer, removeRolle,
  ensureBearbeiterRolle,
  DeskNotFoundError, InvalidStateError, UnbekannterNutzerError, UngueltigeRolleError, type Actor,
} from './deskStore';
import { requireDeskRolle, requireDeskAktion } from './guards';
import { listJournal, appendJournal } from './journal';
import { restoreDeskTo, ReplayFehler } from './restore';
import { actorFromRequest } from './actor';
import { storeFile, getFilePath, fileExists, classify, classifyName, getFileMeta, getOrComputeJlHash, FileError } from './files';
import { istDateiSichtbarFuer } from './dateiSichtbarkeit';
import { registerAufnahme } from './aufnahme';
import { enqueueExtraction } from './ocr/ocrQueue';
import { createConverter, ConvertError, previewCachePath, type ConvertConfig } from './convert';
import { register, unregister, broadcast, aktualisiereRolle, trenneNutzer } from './broadcast';
import { registerPresence, unregisterPresence, setzeBearbeitung, loeseBearbeitung, sendePraesenz, aktualisierePresenzRolle } from './presence';
import { buildPackage, readPackage, PaketFehler } from './jdesk';
import { vielleichtArchiviere } from './autoArchive';
import { registerPdfExportRoutes } from './export/pdfExport';
import { registriereAnlagenpaketRouten } from './export/anlagenpaket';
import { registerProposals } from './proposals';
import { registerBenachrichtigungen, verarbeiteGeteiltAusloeser, verarbeiteSyncAusloeser } from './benachrichtigungen';
import { dateiname, contentDisposition } from './download';
import { sucheAufDesk } from './search/searchQuery';
import { ocrStatusFuerDesk } from './search/ocrStatus';
import { fileTextFuerDesk } from './search/fileText';
import { runLegalQuery, LEGAL_QUERIES, type LegalQueryKind } from './legalQueries';
import { listeVorlagen, findeVorlage, initialerStateAusVorlage } from './vorlagen';
import { baueDiagnose } from './diagnose';
import { pruefeBerechtigung } from './berechtigung';
import { baueDiagnosepaket } from './diagnosepaket';
import { rotateBackup } from './backup';
import { registerTranskription, type TranskriptionConfig } from './transkription';

export interface AppOptions {
  db: Db;
  dataDir: string;
  webDir?: string;
  /** Basis-URL der j-lawyer-REST-API (inkl. /j-lawyer-io). Gesetzt = j-lawyer-Login-Modus. */
  jlawyerUrl?: string;
  /** TASK-02 (08-08): Kalender-Kennung für Aufgaben-Wiedervorlagen — j-lawyer bietet keinen
   *  REST-Endpunkt, um Kalender aufzulisten, die Kennung muss daher betreiberseitig konfiguriert
   *  werden (docs/deployment/jlawyer-aufgabenuebergabe.md). Fehlt sie, antwortet die
   *  Übergaberoute mit einem Klartexthinweis, statt j-lawyer aufzurufen. */
  jlawyerTaskCalendarId?: string;
  /** Euro-Office-DocumentServer für die Vorschau-Konvertierung; null/fehlend = deaktiviert. */
  convert?: ConvertConfig | null;
  /** Eigene, vom DocumentServer erreichbare Basis-URL (für /convert-source-Tickets). */
  publicUrl?: string;
  /** Wird nach erfolgreichem Speichern des Betriebsmodus (POST /api/v1/setup/jlawyer) aufgerufen. */
  onModeConfigured?: () => void;
  /** Backup-Takt in Stunden (main.ts: `parseHours('BACKUP_INTERVAL_HOURS', …, 6)`, WR-02) — für
   *  die BACKUP-Diagnosezeile „Nächste geplante Sicherung" (14-06). Absichtlich NICHT hier
   *  erneut aus `process.env` gelesen: main.ts bleibt die einzige Stelle, die den Rohwert
   *  validiert. Fehlt der Parameter (v. a. Tests, die `buildApp()` ohne ihn aufrufen), gilt
   *  derselbe Standardwert wie main.ts (6) — kein zweiter, abweichender Default. */
  backupIntervalHours?: number;
  /** Anymize-Transkription (VOICE-01, 14-09): NUR aus main.ts (Umgebung) gelesen und hier
   *  durchgereicht (Disziplin wie diagnosepaket.ts) — null/fehlend = kein Startfehler, die
   *  Route meldet sich lediglich als nicht verfügbar (main.ts, anders als der MCP-Prozess). */
  transkriptionConfig?: TranskriptionConfig | null;
}

const PUBLIC_PATHS = new Set(['/api/v1/auth/status', '/api/v1/auth/login', '/api/v1/auth/setup']);
const CONVERT_SOURCE_PREFIX = '/api/v1/convert-source/';
// Ersteinrichtung: die Setup-Routen müssen vor jeder Anmeldung erreichbar sein (kein Token existiert noch).
const SETUP_PREFIX = '/api/v1/setup/';

declare module 'fastify' {
  interface FastifyInstance {
    fileTickets: FileTickets;
  }
}

function bearerToken(req: FastifyRequest): string | null {
  // Nur der Authorization-Header — Tokens in Query-Strings landen in Logs und Proxies.
  const header = req.headers.authorization;
  return header?.startsWith('Bearer ') ? header.slice(7) : null;
}

/**
 * Sprung zur Quelle: die 2000er-Kappung von textSnapshot greift erst in @j-desk/core (beim
 * Anwenden aufs Desk-Objekt) — journaliert wird aber cmd.payload roh, VOR dieser Kappung.
 * Ohne diese Vorab-Kappung könnte ein manipulierter Client bis zu ~1 MiB Text pro Command ins
 * append-only Journal drücken. Mutiert das übergebene Objekt in place (dieselbe Referenz landet
 * gleich darauf in appendJournal).
 */
function kappeTextSnapshot(payload: Record<string, unknown>): void {
  if (typeof payload.textSnapshot !== 'string') {
    delete payload.textSnapshot;
  } else if (payload.textSnapshot.length > TEXT_SNAPSHOT_MAX) {
    payload.textSnapshot = payload.textSnapshot.slice(0, TEXT_SNAPSHOT_MAX);
  }
}

/**
 * Sprung zur Quelle: fileSha256 ist ein serverseitiges Faktum und darf nie vom Client kommen
 * (Anti-Pattern in 01-RESEARCH.md). Standalone: Hash aus files.sha256 über die fileId der Karte.
 * j-lawyer-Modus: Hash aus jl_file_hashes über fileId + sourceChangeDate der Karte — der Cache-Hash,
 * den cachedDocBytes() beim ersten Abruf der jeweiligen Fassung persistiert hat. Ist die Fassung
 * noch nie abgerufen worden (kein Eintrag), liefert die Funktion undefined; das Feld bleibt dann
 * schlicht unbesetzt (kein Fehler, kein Rückgriff auf einen Client-Wert).
 */
function ermittleFileSha256(
  db: Db,
  jlawyerUrl: string | undefined,
  doc: { fileId: string; sourceChangeDate?: number } | undefined,
): string | undefined {
  if (!doc) return undefined;
  if (jlawyerUrl) {
    if (doc.sourceChangeDate === undefined) return undefined;
    const row = db.prepare('SELECT sha256 FROM jl_file_hashes WHERE doc_id = ? AND change_date = ?')
      .get(doc.fileId, doc.sourceChangeDate) as { sha256: string } | undefined;
    return row?.sha256;
  }
  const row = db.prepare('SELECT sha256 FROM files WHERE id = ?').get(doc.fileId) as { sha256: string } | undefined;
  return row?.sha256;
}

/**
 * Command-Rechteprüfung (PERM-04, 02-04 Task 2): endgültige Lösch-/Schredder-Commands werden
 * auf die GefahrlicheAktion-Matrix (darfAktion, nur Eigentümer) abgebildet; das reversible
 * `trashObject`/`restoreObject` (Papierkorb, TrashCan.svelte) zählt NICHT als "endgültig" und
 * fällt daher unter die allgemeine Mutationsprüfung unten. `addCustomLayer` zählt als
 * Ebenenverwaltung (Eigentümer+Bearbeiter, wie im CONTEXT für "Rollen-/Ebenenverwaltung" festgelegt).
 */
const LOESCH_COMMANDS = new Set([
  'removeDoc', 'removeLink', 'removeStack', 'removeStroke', 'removeNote', 'removeCutout',
  'removeMark', 'removeStamp', 'removeFlag', 'removeClip',
  // CR-03: removeLegalObject/removeTable fehlten hier — Bearbeiter (nur Eigentümer darf
  // 'delete') konnte juristische Objekte/Tabellenkarten dadurch endgültig löschen, ohne
  // über den Papierkorb (trashObject) zu gehen.
  'removeLegalObject', 'removeTable',
  // 11-REVIEW CR-01: removeSitzungsmappe ist endgültig (trashObject kennt die Art nicht,
  // es gibt keinen Papierkorb-Weg) und betrifft vertrauliche Vorbereitungsnotizen (offene
  // Fragen) — dieselbe Defektklasse wie CR-03, daher Eigentümer-only wie removeTable.
  'removeSitzungsmappe',
  // 11-REVIEW CR-01-Nebenbefund (Bestandsdefekt aus Phase 08/09): removeZeitleiste fehlte
  // in derselben Matrix — Zeitleisten sind wie Tabellenkarten endgültig löschbar, also
  // ebenfalls Eigentümer-only.
  'removeZeitleiste',
]);
const SCHREDDER_COMMANDS = new Set(['shredTrashItem', 'emptyTrash']);

function kommandoAktion(type: string): GefahrlicheAktion | null {
  if (SCHREDDER_COMMANDS.has(type)) return 'shred';
  if (LOESCH_COMMANDS.has(type)) return 'delete';
  // 02-07: setLayerExportierbar zählt wie addCustomLayer als Ebenenverwaltung.
  if (type === 'addCustomLayer' || type === 'setLayerExportierbar') return 'manage';
  // 03-01 (D-05): setFreigabe ist bewusst KEINE gefährliche Aktion im Matrix-Sinn — der
  // Freigabe-Override ist eine Objekt-Bearbeitung wie editNote; das Bearbeitungsrecht
  // (Kommentator-Eigenregel + Privat-Ebenen-Schutz) reicht, die Matrix bliebe wirkungslos
  // fein. Der Export selbst bleibt über requireDeskAktion('export') geschützt.
  return null;
}

/**
 * Kommentator (PERM-04/CONTEXT „Kommentator: darf Notizen/Fähnchen … + Kanzlei-Kommentare
 * anlegen; keine fremden Objekte ändern/verschieben, nichts löschen"): erzeugende Commands sind
 * erlaubt; editNote/moveNote/setNoteDone nur, wenn das Objekt IHM gehört (createdBy-Vergleich,
 * geprüft in kommentatorDarf unten) — Flags haben keinen Edit-Command, nur addFlag/removeFlag,
 * und removeFlag ist bereits über LOESCH_COMMANDS (darfAktion) für jede Rolle außer Eigentümer
 * gesperrt.
 */
const KOMMENTATOR_ERLAUBT = new Set(['addNote', 'editNote', 'moveNote', 'setNoteDone', 'addFlag']);
/** Objektarten (VERSIONIERTE_ARTEN-Ausschnitt), auf denen editNote/moveNote/setNoteDone wirken. */
const KOMMENTATOR_EIGENTUM_ART: Record<string, 'notes'> = { editNote: 'notes', moveNote: 'notes', setNoteDone: 'notes' };

/**
 * Prüft, ob `rolle` den Command `cmd.type` überhaupt auslösen darf — UNABHÄNGIG von jedem im
 * Payload mitgeschickten Wert (Sprung zur Quelle: layerId/rolle im Payload sind niemals eine
 * Rechte-Umgehung, s. Threat T-02-03). Liefert bei Ablehnung eine Fehlermeldung, sonst null.
 * `actor` ist der Auslöser (aus actorFromRequest) — für die Eigentümerschafts-Prüfung bei
 * Kommentator-Bearbeitungen: seit WR-05 primär über `createdById` (stabile users.id), der
 * Username-Vergleich (`createdBy`) bleibt nur als Fallback für Alt-Objekte ohne createdById
 * (Usernames sind UNIQUE, aber nach Konto-Löschung neu vergebbar).
 */
function pruefeKommandoRecht(
  db: Db, deskId: string, rolle: Rolle, cmd: Command, actor: Actor,
): string | null {
  const aktion = kommandoAktion(cmd.type);
  if (aktion) {
    return darfAktion(rolle, aktion) ? null : `Ihre Rolle „${rolle}" erlaubt „${cmd.type}" nicht.`;
  }
  if (rolle === 'Eigentümer' || rolle === 'Bearbeiter') return null;
  if (rolle === 'Kommentator') {
    if (cmd.type === 'changeLayerId') {
      // CONTEXT-Locked-Decision (02-09): der Kommentator darf EIGENE Notizen/Fähnchen zwischen
      // der Kanzlei-Ebene und seiner eigenen Privat-Instanz verschieben — sonst nichts. Das
      // zulässige Ebenenpaar prüft pruefeEbenenRecht; hier Eigentum + Objektart.
      const objectId = (cmd.payload as { objectId?: unknown } | undefined)?.objectId;
      const state = getDeskState(db, deskId)?.state;
      const treffer = typeof objectId === 'string' && state ? findeObjekt(state, objectId) : undefined;
      if (!treffer) return null; // unbekannte Objekte bleiben dem 400-CommandError vorbehalten (Bestandsmuster)
      if (treffer.art !== 'notes' && treffer.art !== 'flags') {
        return 'Sie können nur eigene Notizen und Fähnchen zwischen Ebenen verschieben.';
      }
      const obj = treffer.obj as { createdById?: string; createdBy?: string };
      const gehoertIhm = obj.createdById !== undefined
        ? obj.createdById === actor.id
        : obj.createdBy === actor.name;
      if (!gehoertIhm) {
        return 'Sie können nur eigene Notizen und Fähnchen zwischen Ebenen verschieben.';
      }
      return null;
    }
    if (cmd.type === 'setFreigabe') {
      // EXP-03/D-05 (03-01): der Freigabe-Override zählt als Objekt-Bearbeitung wie
      // editNote — der Kommentator darf ihn nur an Objekten mit eigener createdById
      // setzen (Eigentumsprüfung exakt wie im changeLayerId-Zweig oben). Der
      // Privat-Ebenen-Schutz greift über zielObjektIdsFuerCommand automatisch
      // (objektbezug.ts, pruefeEbenenRecht); die UI-Ausblendung ist nur Komfort.
      const objectId = (cmd.payload as { objectId?: unknown } | undefined)?.objectId;
      const state = getDeskState(db, deskId)?.state;
      const treffer = typeof objectId === 'string' && state ? findeObjekt(state, objectId) : undefined;
      if (!treffer) return null; // unbekannte Objekte bleiben dem 400-CommandError vorbehalten (Bestandsmuster)
      const obj = treffer.obj as { createdById?: string; createdBy?: string };
      const gehoertIhm = obj.createdById !== undefined
        ? obj.createdById === actor.id
        : obj.createdBy === actor.name;
      if (!gehoertIhm) {
        return 'Sie können nur die Freigabe eigener Objekte ändern.';
      }
      return null;
    }
    if (!KOMMENTATOR_ERLAUBT.has(cmd.type)) {
      return `Ihre Rolle „Kommentator" erlaubt „${cmd.type}" nicht.`;
    }
    const art = KOMMENTATOR_EIGENTUM_ART[cmd.type];
    if (art) {
      const objectId = (cmd.payload as { id?: unknown } | undefined)?.id;
      const state = getDeskState(db, deskId)?.state;
      const bestehend = typeof objectId === 'string' ? state?.[art]?.find((o) => o.id === objectId) : undefined;
      if (bestehend) {
        const gehoertIhm = bestehend.createdById !== undefined
          ? bestehend.createdById === actor.id
          : bestehend.createdBy === actor.name;
        if (!gehoertIhm) {
          return 'Sie können nur eigene Notizen bearbeiten.';
        }
      }
    }
    return null;
  }
  // Nur-Lesen/externer Gast: keine Mutation außerhalb der oben behandelten Fälle.
  return `Ihre Rolle „${rolle}" erlaubt keine Änderungen.`;
}

/**
 * Serverseitige Ebenen-Bearbeitungsprüfung (CR-04, PERM-02, T-02-03) — die Prüfung, die
 * layers.ts am `changeLayerId`-Kommentar schon immer angekündigt hat („passiert nicht hier,
 * sondern serverseitig im Command-Guard"), die aber bis zur Review nirgends lief:
 *
 * - `changeLayerId`: Quell- UND Ziel-Ebene müssen für den Actor bearbeitbar sein
 *   (darfEbeneBearbeiten) — sonst zöge ein Bearbeiter mit bekannter ID ein fremdes
 *   Privatobjekt auf 'kanzlei' (direktes Vertraulichkeits-Leck) oder versänke ein Objekt
 *   auf einer fremden privaten Ebene. Unbekannte Ebene/Objekt bleibt dem applyCommand-
 *   CommandError (400) vorbehalten (Bestandsverhalten, kein doppelter Fehlerpfad).
 * - Alle übrigen Commands mit Bezug zu einem bestehenden Objekt (zielObjektIdsFuerCommand):
 *   liegt das Zielobjekt auf einer `privat`-Ebene, ist es ausschließlich deren Eigentümer
 *   bearbeitbar — fremde Privatobjekte können so weder mutiert, annotiert, kopiert noch
 *   weggeworfen werden. Nicht-private Ebenen bleiben der Rollenprüfung oben vorbehalten
 *   (Kommentator darf weiterhin eigene Notizen auf der Kanzlei-Ebene bearbeiten).
 */
function pruefeEbenenRecht(state: DesktopState, ctx: ActorContext, cmd: Command): string | null {
  if (cmd.type === 'changeLayerId') {
    const payload = (cmd.payload ?? {}) as Record<string, unknown>;
    const objectId = typeof payload.objectId === 'string' ? payload.objectId : undefined;
    const layerId = typeof payload.layerId === 'string' ? payload.layerId : undefined;
    if (ctx.rolle === 'Kommentator') {
      // Ebenenpaar-Regel (02-09, CONTEXT): Quelle nur die Kanzlei-Ebene oder die eigene
      // Privat-Instanz, Ziel nur 'privat' (eigene Instanz, ggf. lazy — Auflösung wie unten)
      // oder 'kanzlei'. Eigentum/Objektart hat pruefeKommandoRecht bereits geprüft; custom,
      // exportierbar, ki-vorschlaege und fremde Instanz-ids bleiben 403.
      if (objectId) {
        const treffer = findeObjekt(state, objectId);
        if (treffer) {
          const quellId = (treffer.obj as { layerId?: string }).layerId ?? 'kanzlei';
          const eigeneInstanz = findePrivateEbeneFuer(state, ctx.userId)?.id;
          if (quellId !== 'kanzlei' && quellId !== eigeneInstanz) {
            return 'Kein Bearbeitungsrecht auf der Ebene des Objekts.';
          }
        }
      }
      if (layerId && layerId !== 'kanzlei' && layerId !== 'privat') {
        return 'Kein Bearbeitungsrecht auf der Ziel-Ebene.';
      }
      return null;
    }
    if (objectId) {
      const treffer = findeObjekt(state, objectId);
      if (treffer) {
        const quelle = findeEbene((treffer.obj as { layerId?: string }).layerId ?? 'kanzlei', state.layers);
        if (!quelle || !darfEbeneBearbeiten(quelle, ctx)) {
          return 'Kein Bearbeitungsrecht auf der Ebene des Objekts.';
        }
      }
    }
    if (layerId) {
      if (layerId === 'privat') {
        // Platzhalter-Auflösung (02-09, PERM-01): 'privat' ist die SYSTEM_EBENEN-Platzhalter-id,
        // die die UI sendet — Ziel ist immer die Pro-Nutzer-Privat-Instanz des Auslösers.
        // Fehlt sie noch, entsteht sie im selben Command atomar (ensurePrivateLayer über
        // meta.createdById = actor.id aus der Session, niemals aus dem Payload — T-02-09-03);
        // die so erzeugte Instanz kann nur dem Auslöser gehören, also ist das Fehlen zulässig.
        const eigene = findePrivateEbeneFuer(state, ctx.userId);
        if (eigene && !darfEbeneBearbeiten(eigene, ctx)) {
          return 'Kein Bearbeitungsrecht auf der Ziel-Ebene.';
        }
      } else {
        const ziel = findeEbene(layerId, state.layers);
        if (ziel && !darfEbeneBearbeiten(ziel, ctx)) {
          return 'Kein Bearbeitungsrecht auf der Ziel-Ebene.';
        }
      }
    }
    return null;
  }
  if (cmd.type === 'setLayerExportierbar') {
    // WR-01 (02-REVIEW Iteration 3): seit der Instanz-Materialisierung (02-09) liegen echte
    // Privat-Instanzen in state.layers — ohne diesen Zweig könnte jeder Bearbeiter/Eigentümer
    // das exportierbar-Flag einer FREMDEN Privat-Instanz flippen (die Instanz-id
    // `privat-<userId>` ist deterministisch und über GET /members bzw. das Journal erreichbar)
    // — Integritätsbruch am fremden Privatbereich (PERM-05 „fremde private Ebene
    // unantastbar") und Latenz-Risiko für die Phase-3-Exportauswertung. Die Rollen-Matrix
    // (manage: Eigentümer+Bearbeiter) hat pruefeKommandoRecht bereits geprüft; hier zusätzlich
    // Eigentum am Privatbereich. Der Platzhalter 'privat' wird wie im changeLayerId-Pfad auf
    // die EIGENE Instanz aufgelöst — niemals auf die SYSTEM-Platzhalter-Ebene selbst (die
    // trägt kein ownerUserId und wäre sonst für jeden „fremd"). Unbekannte Ebene bleibt dem
    // 400-CommandError aus applyCommand vorbehalten (Bestandsmuster).
    const payload = (cmd.payload ?? {}) as Record<string, unknown>;
    const layerId = typeof payload.layerId === 'string' ? payload.layerId : undefined;
    if (layerId) {
      const ziel = layerId === 'privat'
        ? findePrivateEbeneFuer(state, ctx.userId)
        : findeEbene(layerId, state.layers);
      if (ziel?.typ === 'privat' && ziel.ownerUserId !== ctx.userId) {
        return 'Kein Bearbeitungsrecht auf dieser Ebene.';
      }
    }
    return null;
  }
  for (const objectId of zielObjektIdsFuerCommand(cmd)) {
    const treffer = findeObjekt(state, objectId);
    if (!treffer) continue;
    const ebene = findeEbene((treffer.obj as { layerId?: string }).layerId ?? 'kanzlei', state.layers);
    if (ebene && ebene.typ === 'privat' && ebene.ownerUserId !== ctx.userId) {
      return 'Dieses Objekt liegt auf einer privaten Ebene einer anderen Person.';
    }
  }
  return null;
}

/**
 * Kommando-Rechteprüfungs-Sequenz für eine LISTE von Kommandos gegen denselben Actor:
 * pro Kommando zuerst die Rollen-Stufe (pruefeKommandoRecht), dann die Ebenen-Stufe
 * (pruefeEbenenRecht gegen den aktuellen State) — exakt die Reihenfolge der
 * /commands-Route. Liefert die erste Verweigerungs-Meldung oder null.
 *
 * Extrahiert für den Genehmigungspfad der KI-Vorschläge (12-03, Pitfall 5): die
 * Genehmigungs-Route prüft die aus einem Vorschlag abgeleiteten Kommandos mit dem
 * GENEHMIGER als Actor über DIESE Funktion — ein Genehmiger kann nichts genehmigen, das er
 * manuell nicht dürfte (12-CONTEXT.md Leitplanke 2: dieselbe Kommando-/Konfliktmaschinerie
 * wie menschliche Aktionen). KEINE Semantikänderung gegenüber der bisher inline in der
 * /commands-Route stehenden Sequenz — der Refactor-Beweis sind die unverändert grünen
 * Bestandstests der Route.
 */
export function pruefeKommandosFuerActor(
  db: Db,
  deskId: string,
  rolle: Rolle,
  actor: Actor,
  kommandos: Command[],
): string | null {
  const stateFuerEbenen = getDeskState(db, deskId)?.state;
  // actor.id ist die users.id des Auslösers (actorFromRequest); der leere Fallback ist
  // fail-closed (fremde Privat-Ebenen matchen nie ownerUserId === '').
  const ctx: ActorContext = { userId: actor.id ?? '', rolle };
  for (const cmd of kommandos) {
    const verweigert = pruefeKommandoRecht(db, deskId, rolle, cmd, actor);
    if (verweigert) return verweigert;
    if (stateFuerEbenen) {
      const ebenenVerweigert = pruefeEbenenRecht(stateFuerEbenen, ctx, cmd);
      if (ebenenVerweigert) return ebenenVerweigert;
    }
  }
  return null;
}

const WS_PATH = /^\/api\/v1\/desks\/[^/]+\/ws$/;

// REF-03: getestete j-lawyer-API-Ebene (01-SPIKE-FINDINGS.md — apiLevel 8 zum Spike-Zeitpunkt,
// GET /v1/security/metadata). apiLevel ist eine monoton wachsende Ganzzahl, kein Semver-String.
const JL_TESTED_API_LEVEL_MIN = 8;
const JL_TESTED_API_LEVEL_MAX = 8;

type JlVersionKompat = 'kompatibel' | 'inkompatibel' | 'unbestimmt';

/** REF-03: ermittelt die j-lawyer-API-Ebene und vergleicht sie gegen die getestete Spanne.
 *  Blockiert den Login NIE — jeder Fehlschlag der Ermittlung (kein Endpunkt, Netzfehler,
 *  unerwartete Antwort) ergibt 'unbestimmt', nicht stillschweigend 'kompatibel'. */
async function jlVersionKompatibilitaet(baseUrl: string, username: string, password: string): Promise<JlVersionKompat> {
  try {
    const { apiLevel } = await getApiMetadata(baseUrl, username, password);
    if (!Number.isFinite(apiLevel)) return 'unbestimmt';
    return apiLevel >= JL_TESTED_API_LEVEL_MIN && apiLevel <= JL_TESTED_API_LEVEL_MAX ? 'kompatibel' : 'inkompatibel';
  } catch {
    return 'unbestimmt';
  }
}

export async function buildApp({ db, dataDir, webDir, jlawyerUrl, jlawyerTaskCalendarId, convert, publicUrl, onModeConfigured, backupIntervalHours, transkriptionConfig }: AppOptions): Promise<FastifyInstance> {
  const app = Fastify();
  const backupStunden = backupIntervalHours ?? 6;
  // In-Flight-Sperre für „Jetzt sichern" (T-14-06-03, Denial of Service): ein zweiter Aufruf
  // während eines laufenden vollständigen DB-Backups würde die Dateisystemlast unnötig
  // verdoppeln. RAM-only, gleicher Kompromiss wie handoverInFlight unten — bei Serverneustart
  // ist keine Sicherung mehr „in flight".
  let backupInFlight = false;
  const wsTickets = createWsTickets();
  const fileTickets = createFileTickets();
  app.decorate('fileTickets', fileTickets);
  // j-lawyer-Modus: Basic-Credentials der Sitzungen leben ausschließlich im RAM
  // (nie persistiert; nach Server-Neustart melden sich alle neu an — Spec-Entscheidung).
  const jlCreds = new Map<string, { username: string; password: string }>();
  // WR-05: In-Flight-Sperre gegen die TOCTOU-Lücke der Aufgabenübergabe unten — der Guard auf
  // task.handedOverToJLawyer liest den Zustand VOR dem createDueDate-await, Node gibt an dieser
  // Stelle die Event-Loop frei. Zwei nahezu gleichzeitige Anfragen für dieselbe Aufgabe würden
  // sonst beide den ungesetzten Zustand sehen, beide echte Wiedervorlagen in j-lawyer anlegen und
  // sich beim Schreiben von jlDueDateId gegenseitig überschreiben. RAM-only, gleicher Kompromiss
  // wie jlCreds/previewErrors — bei Serverneustart ist die Sperre ohnehin hinfällig, weil dann
  // keine Anfrage mehr "in flight" sein kann.
  const handoverInFlight = new Set<string>();
  const basisUrl = (publicUrl ?? 'http://localhost:4810').replace(/\/+$/, '');
  // j-lawyer-Modus: Zugangsdaten des zuletzt anfordernden Nutzers je Dokument-ID, ausschließlich
  // damit die sourceUrl-Funktion unten (die selbst nur die fileId/docId bekommt) ein
  // Konverter-Ticket mit jl-Payload bauen kann. RAM-only, gleicher Kompromiss wie jlCreds.
  const previewJlCreds = new Map<string, { username: string; password: string }>();
  // Letzter Konvertierungsfehler je cacheKey — wird beim NÄCHSTEN preview-Aufruf als 409
  // ausgeliefert und dabei zurückgesetzt (Retry-Semantik statt dauerhaftem Fehlerzustand).
  const previewErrors = new Map<string, ConvertError>();
  const converter = createConverter({
    config: convert ?? null,
    dataDir,
    sourceUrl: (fileId) => {
      const jl = previewJlCreds.get(fileId);
      const payload = jl ? { fileId, jl: { docId: fileId, ...jl } } : { fileId };
      return `${basisUrl}/api/v1/convert-source/${fileTickets.issue(payload)}`;
    },
  });

  /** Vorschau-Antwort für kind 'convertible': Cache -> Hintergrund-Anstoß (202) -> Fehler-Merker (409) -> disabled (409). */
  async function respondConvertiblePreview(
    reply: FastifyReply,
    cacheKey: string,
    fileIdForConvert: string,
    sourceName: string,
  ) {
    if (!converter.enabled()) {
      return reply.code(409).send({ error: 'Vorschau-Dienst nicht konfiguriert', reason: 'disabled' });
    }
    const priorError = previewErrors.get(cacheKey);
    if (priorError) {
      previewErrors.delete(cacheKey); // nächster Versuch bekommt eine echte Chance
      return reply.code(409).send({ error: priorError.message, reason: priorError.reason });
    }
    const cachePath = previewCachePath(dataDir, cacheKey);
    if (existsSync(cachePath)) {
      reply.header('content-type', 'application/pdf');
      return readFileSync(cachePath);
    }
    void converter.ensurePreview(fileIdForConvert, cacheKey, sourceName).catch((e) => {
      previewErrors.set(cacheKey, e instanceof ConvertError ? e : new ConvertError(String(e), 'failed'));
    });
    reply.code(202);
    return { status: 'converting' };
  }
  await app.register(cors, { origin: true });
  await app.register(multipart, { limits: { fileSize: 100 * 1024 * 1024 } });
  await app.register(websocket);
  if (webDir) {
    // wildcard:true löst Dateien zur ANFRAGEZEIT auf (fehlende rufen callNotFound → SPA-Fallback).
    // wildcard:false globbte die Dateiliste einmalig beim Boot — ein Rebuild bei laufendem
    // Server machte alle neuen Assets zu 404/HTML (UAT-Befund „weißer Bildschirm").
    await app.register(fastifyStatic, { root: webDir, wildcard: true });
    // SPA-Fallback: unbekannte GET-Pfade außerhalb der API liefern die App.
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'Nicht gefunden' });
    });
  }

  app.addHook('onRequest', async (req, reply) => {
    let path = req.url.split('?')[0];
    try {
      path = decodeURIComponent(path);
    } catch {
      return reply.code(400).send({ error: 'Ungültiger Pfad' });
    }
    if (!path.startsWith('/api/')) return; // statische Auslieferung ist öffentlich
    if (PUBLIC_PATHS.has(path)) return;
    // Ersteinrichtung: vor jeder Anmeldung erreichbar (Routen selbst sperren sich, sobald konfiguriert — s. setupGesperrt).
    if (path.startsWith(SETUP_PREFIX)) return;
    // Konverter-Quelle: das Einmal-Ticket in der URL ersetzt die Auth (einmalig + kurzlebig, s. Route unten).
    if (path.startsWith(CONVERT_SOURCE_PREFIX)) return;
    if (WS_PATH.test(path)) {
      // Browser-WebSockets können keine Header setzen — hier gilt ausschließlich das Einmal-Ticket.
      const ticket = (req.query as { ticket?: string })?.ticket;
      const session = ticket ? wsTickets.consume(ticket) : null;
      if (!session) return reply.code(401).send({ error: 'Nicht angemeldet' });
      (req as FastifyRequest & { userId: string }).userId = session.userId;
      return;
    }
    const token = bearerToken(req);
    const session = token ? validateToken(db, token) : null;
    if (!session) return reply.code(401).send({ error: 'Nicht angemeldet' });
    (req as FastifyRequest & { userId: string }).userId = session.userId;
  });

  // ---- Auth ----
  app.get('/api/v1/auth/status', async (req) => {
    // REF-03 (WR-03): Session-Wiederherstellung ruft /auth/login nie erneut auf (der Client
    // reicht den gespeicherten Token direkt durch) — ohne diesen Zweig würde die
    // Versionskompatibilitätsprüfung bei einem Tab-/Seiten-Reload mit gültiger Sitzung nie
    // erneut ausgewertet. /auth/status ist ein PUBLIC_PATH (auch ohne Token erreichbar), daher
    // hier bewusst optionale, nicht erzwungene Auth: nur wenn ein gültiger Token UND
    // bereits gecachte j-lawyer-Zugangsdaten für diesen Token vorliegen (gesetzt beim
    // ursprünglichen Login), wird die Ermittlung erneut angestoßen — sonst bleibt jlVersion
    // schlicht unbestimmt (kein Login-Zwang, kein Blockieren).
    let jlVersion: JlVersionKompat | undefined;
    if (jlawyerUrl) {
      const token = bearerToken(req);
      const creds = token && validateToken(db, token) ? jlCreds.get(token) : undefined;
      if (creds) jlVersion = await jlVersionKompatibilitaet(jlawyerUrl, creds.username, creds.password);
    }
    return {
      needsSetup: jlawyerUrl ? false : needsSetup(db),
      mode: jlawyerUrl ? 'jlawyer' : 'standalone',
      // Erststart ohne jede Konfiguration → Login-Screen zeigt die Moduswahl.
      needsModeChoice: !jlawyerUrl && needsSetup(db) && getSetting(db, 'jlawyer_url') === null,
      ...(jlVersion !== undefined ? { jlVersion } : {}),
    };
  });

  app.post('/api/v1/auth/setup', async (req, reply) => {
    if (jlawyerUrl) return reply.code(403).send({ error: 'Anmeldung erfolgt mit dem j-lawyer-Konto' });
    if (!needsSetup(db)) return reply.code(403).send({ error: 'Es existiert bereits ein Konto' });
    const { username, password } = (req.body ?? {}) as { username?: string; password?: string };
    try {
      // null = ein paralleler Setup-POST war schneller (Fenster: das argon2-Hashen).
      if ((await createFirstUser(db, String(username ?? ''), String(password ?? ''))) === null) {
        return reply.code(403).send({ error: 'Es existiert bereits ein Konto' });
      }
    } catch (e) {
      if (e instanceof AuthError) return reply.code(400).send({ error: e.message });
      throw e;
    }
    return { token: await login(db, String(username), String(password)) };
  });

  app.post('/api/v1/auth/login', async (req, reply) => {
    const { username, password } = (req.body ?? {}) as { username?: string; password?: string };
    if (jlawyerUrl) {
      const name = String(username ?? '').trim();
      const pass = String(password ?? '');
      let gueltig: boolean;
      try {
        gueltig = name !== '' && (await validateLogin(jlawyerUrl, name, pass));
      } catch (e) {
        if (e instanceof JLawyerError) return reply.code(e.status).send({ error: e.message });
        throw e;
      }
      if (!gueltig) return reply.code(401).send({ error: 'Benutzername oder Passwort falsch' });
      const token = createSession(db, ensureExternalUser(db, name));
      jlCreds.set(token, { username: name, password: pass });
      // REF-03: nicht login-blockierend — ein Fehlschlag der Ermittlung liefert 'unbestimmt'.
      const jlVersion = await jlVersionKompatibilitaet(jlawyerUrl, name, pass);
      return { token, jlVersion };
    }
    const token = await login(db, String(username ?? ''), String(password ?? ''));
    if (!token) return reply.code(401).send({ error: 'Benutzername oder Passwort falsch' });
    return { token };
  });

  app.post('/api/v1/auth/logout', async (req) => {
    const token = bearerToken(req);
    if (token) {
      logout(db, token);
      jlCreds.delete(token);
    }
    return { ok: true };
  });

  // ---- Ersteinrichtung: Betriebsmodus (nur solange nichts konfiguriert ist) ----
  function setupGesperrt(reply: FastifyReply): boolean {
    if (jlawyerUrl || !needsSetup(db) || getSetting(db, 'jlawyer_url') !== null) {
      void reply.code(403).send({ error: 'Der Betriebsmodus ist bereits konfiguriert' });
      return true;
    }
    return false;
  }

  app.post('/api/v1/setup/jlawyer-test', async (req, reply) => {
    if (setupGesperrt(reply)) return;
    const { url } = (req.body ?? {}) as { url?: string };
    if (!url || typeof url !== 'string') return reply.code(400).send({ error: 'URL fehlt' });
    return probeJLawyer(url);
  });

  app.post('/api/v1/setup/jlawyer', async (req, reply) => {
    if (setupGesperrt(reply)) return;
    const { url } = (req.body ?? {}) as { url?: string };
    if (!url || typeof url !== 'string') return reply.code(400).send({ error: 'URL fehlt' });
    const probe = await probeJLawyer(url);
    if (!probe.ok) return reply.code(400).send({ error: probe.message });
    // Der Check oben liegt vor dem Probe-Await — hier nochmal atomar beanspruchen, sonst
    // gewinnen zwei parallele Erststart-POSTs beide (siehe claimBetriebsmodus).
    if (!claimBetriebsmodus(db, url.replace(/\/+$/, ''))) {
      return reply.code(403).send({ error: 'Der Betriebsmodus ist bereits konfiguriert' });
    }
    onModeConfigured?.();
    return { ok: true };
  });

  /** Sitzungs-Credentials oder 401 (Session vor Server-Neustart / in j-lawyer abgelaufen).
   *  Gehört genau genommen zum j-lawyer-Modus, ist aber außerhalb des `if (jlawyerUrl)`-Blocks
   *  deklariert (TASK-02, 08-08): die Übergaberoute unten ist UNBEDINGT registriert (sie muss
   *  im Standalone-Modus mit einem Klartexthinweis antworten, nicht mit 404) und braucht
   *  denselben Zugangsdaten-Zugriff wie die j-lawyer-Routen. */
  const credsOder401 = (req: FastifyRequest, reply: Parameters<Parameters<typeof app.get>[1]>[1]) => {
    const token = bearerToken(req)!;
    const creds = jlCreds.get(token);
    if (!creds) {
      logout(db, token);
      void reply.code(401).send({ error: 'Bitte neu anmelden' });
      return null;
    }
    return { token, creds };
  };
  /** Wie credsOder401 — außerhalb des j-lawyer-Blocks für die Übergaberoute (TASK-02). */
  const jlFehler = (e: unknown, token: string, reply: Parameters<Parameters<typeof app.get>[1]>[1]) => {
    if (e instanceof JLawyerError) {
      // Nur eine abgelaufene/ungültige Sitzung (art 'auth', 401) erzwingt Logout. 'verboten'
      // (403) heißt „diese Aktion nicht erlaubt", NICHT „Sitzung ungültig" — Session bleibt.
      if (e.art === 'auth') {
        logout(db, token);
        jlCreds.delete(token);
      }
      return reply.code(e.status).send({ error: e.message });
    }
    throw e;
  };

  // ---- j-lawyer (nur im j-lawyer-Modus) ----
  if (jlawyerUrl) {
    const jlBase = jlawyerUrl;
    const cacheDir = join(dataDir, 'jlcache');
    mkdirSync(cacheDir, { recursive: true });

    /** Position neuer Karten im „Eingang" (links oben, leicht gestaffelt). */
    const eingang = (n: number) => ({ x: 24 + (n % 3) * 36, y: 24 + n * 30 });

    /** Abgleich: j-lawyer ist führend, aber Karten sind zäh — Dokumente, die in j-lawyer
     *  verschwinden, verlieren NICHT ihre Karte (samt Annotationen), sondern verwaisen nur
     *  (sourceGone). Ersatz-/Umbenennungs-Erkennung anhand jl-changeDate/-name; neue
     *  jl-Dokumente ohne Karte bekommen eine (Papierkorb zählt als „vorhanden"). */
    async function syncCaseDesk(creds: { username: string; password: string }, userId: string, actor: Actor, caseId: string) {
      const jlDocs = await listDocuments(jlBase, creds.username, creds.password, caseId);
      ensureDesk(db, caseId, userId, caseId, actor);
      // WR-02: der erfolgreiche listDocuments-Abruf beweist die jl-seitige Berechtigung an
      // dieser Akte — der zugreifende Nutzer bekommt eine desk_roles-Zeile (Bearbeiter;
      // INSERT OR IGNORE, der Erst-Öffner bleibt Eigentümer). Ohne diese Zeile wäre der
      // jl-Modus faktisch Einpersonen-pro-Akte (Guards/WS verweigerten dem Zweitnutzer alles),
      // mit der früheren ensureDesk-Implementierung wurde er stattdessen still Mit-Eigentümer.
      ensureBearbeiterRolle(db, caseId, userId);
      let { state } = getDeskState(db, caseId)!;
      let changed = false;
      const jlById = new Map(jlDocs.map((d) => [d.id, d]));
      // Sammelt Karten, deren Einzelabruf gerade "nicht erreichbar" ergab — transienter
      // Live-Zustand, wird NUR auf die zurückgegebene Antwort aufgeprägt, nie persistiert
      // (Pitfall 2, 01-RESEARCH.md; 01-SPIKE-FINDINGS.md).
      const liveNichtErreichbar = new Set<string>();
      // NOTIF-01 (13-04): echte Übergangs-Ereignisse für den Sync-Auslöser — NUR frisch
      // erkannte Transitionen (kein Zustands-Diff im Nachhinein). 'ersetzt' bei einer
      // sourceChangeDate-Abweichung an einer BEREITS initialisierten Karte, 'quelle' bei
      // einer neu gesetzten sourceGone-Markierung. Init (erster Abgleich) und Umbenennung
      // zählen NICHT als Transition (Kommentar an den jeweiligen Zweigen unten).
      const syncTransitionen: { art: 'ersetzt' | 'quelle'; dokumentId: string }[] = [];

      // 1 + 2: bestehende Karten gegen den jl-Stand abgleichen (Wiederauftauchen/Umbenennen/
      // Ersetzen bei fileId in jl; granularer Referenzstatus bei fileId nicht mehr in jl).
      const naechsteDocs: Doc[] = [];
      for (const doc of state.docs) {
        const d = jlById.get(doc.fileId);
        if (!d) {
          // Bereits klassifiziert (gelöscht ODER Recht entzogen) — kein erneuter Einzelabruf
          // für bekannte Fälle (Performance, RESEARCH Pitfall 2 / A3).
          if (doc.sourceGone || doc.sourceAccessDenied) {
            naechsteDocs.push(doc);
            continue;
          }
          // NEU verschwunden: gezielter Einzelabruf statt pauschaler sourceGone-Setzung, um
          // "Recht entzogen" (403) von "gelöscht" zu unterscheiden (Pitfall 2). 01-SPIKE-FINDINGS.md:
          // 404 tritt in der Praxis nicht auf (500 statt 404) — daher bleibt "alles außer 403" fail-closed
          // beim bulk-abgeleiteten "gelöscht" (kein falsches "entzogen"). `changed` wird NUR in den
          // Zweigen gesetzt, die tatsächlich persistiert werden — der transiente nichtErreichbar-Zweig
          // darf den globalen changed-Status nicht zurücksetzen (er markiert nur die Antwort, nie die DB).
          try {
            await getDocumentMeta(jlBase, creds.username, creds.password, doc.fileId);
            // Erfolgreicher Einzelabruf trotz Fehlens in der Bulk-Liste — inkonsistente
            // Zwischenlage, kein Vertrauen auf die Bulk-Lücke allein: bleibt "gelöscht".
            changed = true;
            naechsteDocs.push({ ...doc, sourceGone: true as const });
            syncTransitionen.push({ art: 'quelle', dokumentId: doc.id }); // NOTIF-01 (13-04): echte sourceGone-Transition
          } catch (e) {
            if (e instanceof JLawyerError && e.art === 'verboten') {
              changed = true;
              naechsteDocs.push({ ...doc, sourceAccessDenied: true as const });
              // NOTIF-01: 'entzogen' ist fachlich KEIN Quellenverlust (Rechteproblem, nicht
              // „nicht erreichbar") — bewusst KEINE 'quelle'-Zeile (REF-01-Wortlaut deckt nur
              // die Nichterreichbarkeit ab).
            } else if (e instanceof JLawyerError && e.art === 'nichtErreichbar') {
              // Transient: NICHT als gelöscht persistieren (siehe liveNichtErreichbar unten).
              liveNichtErreichbar.add(doc.id);
              naechsteDocs.push(doc);
            } else {
              // 'fehlt' (404) oder 'server' (500 — der laut Spike tatsächliche "gelöscht"-Fall):
              // fail-closed beim bulk-abgeleiteten "gelöscht" bleiben.
              changed = true;
              naechsteDocs.push({ ...doc, sourceGone: true as const });
              syncTransitionen.push({ art: 'quelle', dokumentId: doc.id }); // NOTIF-01 (13-04): echte sourceGone-Transition
            }
          }
          continue;
        }
        let next = doc;
        if (next.sourceGone || next.sourceAccessDenied) {
          changed = true;
          const { sourceGone: _sourceGone, sourceAccessDenied: _sourceAccessDenied, ...rest } = next;
          next = rest;
        }
        const nameChanged = next.name !== d.name;
        if (next.sourceChangeDate === undefined) {
          // Erster Abgleich, an dem diese Karte teilnimmt — reine Versionsinitialisierung,
          // kein Umbenennungs-/Ersetzungssignal (keine Vorfassung zum Vergleichen).
          changed = true;
          next = { ...next, sourceChangeDate: d.changeDate, ...(nameChanged ? { name: d.name } : {}) };
        } else if (next.sourceChangeDate !== d.changeDate) {
          // changeDate weicht ab: neue Fassung der Quelle — "ersetzt", nicht "umbenannt"
          // (fachlich verschiedene Zustände, RESEARCH Anti-Pattern A4).
          changed = true;
          next = { ...next, sourceReplacedAt: new Date().toISOString(), sourceChangeDate: d.changeDate, name: d.name };
          syncTransitionen.push({ art: 'ersetzt', dokumentId: next.id }); // NOTIF-01 (13-04): echte Ersetzungs-Transition (A5-Annotationsprüfung im Auslöser selbst)
        } else if (nameChanged) {
          // Gleiche Fassung (changeDate unverändert), nur der Name weicht ab — Umbenennung.
          changed = true;
          next = { ...next, name: d.name, sourceRenamedAt: new Date().toISOString() };
        }
        naechsteDocs.push(next);
      }
      state = { ...state, docs: naechsteDocs };

      // 3: jl-Dokumente ohne Karte bekommen eine — Karten im Papierkorb gelten als vorhanden,
      // sonst käme die Karte beim Abgleich zurück.
      const vorhanden = new Set([...state.docs.map((d) => d.fileId), ...trashedFileIds(state)]);
      let n = state.docs.length;
      // Systemkennung statt des auslösenden Nutzers — der Abgleich läuft automatisiert,
      // nicht als bewusste Handlung dieses Nutzers (Spec-Entscheidung).
      const syncMeta = { createdBy: 'j-lawyer-Abgleich', createdAt: new Date().toISOString() };
      for (const d of jlDocs) {
        // SAFE-06 (Rule 1, während Task 2/3 entdeckt): ein .jdesk-Paket — ob durch die
        // Automatiksicherung oder manuell in die Akte hochgeladen — ist ein Arbeitsstand-Abbild,
        // kein Aktendokument, das eine eigene Karte bekommen soll. Ohne diesen Ausschluss würde
        // der NÄCHSTE Abgleich das eigene Backup als "neues Dokument" lesen und eine Phantom-
        // Karte anlegen, die bei jedem weiteren Abgleich ein neues Backup auslöst (rev-Anstieg
        // durch addDoc) — ein sich selbst verstärkender Kreislauf, der genau das Zumüllen-Verbot
        // (T-05-23) verletzt. Erkennung über die Dateiendung, da .jdesk-Import ausschließlich
        // über die separate /import-Route läuft (Datei-Upload), nicht über den Akten-Abgleich.
        if (d.name.toLowerCase().endsWith('.jdesk')) continue;
        if (!vorhanden.has(d.id)) {
          // Magic-Bytes gibt's beim Abgleich nicht (Inhalt wird erst bei Bedarf abgerufen) —
          // die Endung reicht hier gut genug (classifyName statt classify).
          state = addDoc(state, d.id, d.name, eingang(n), undefined, classifyName(d.name), syncMeta);
          // addDoc kennt sourceChangeDate nicht (Abgleich-exklusives Feld) — hier nachtragen.
          state = { ...state, docs: state.docs.map((x) => (x.fileId === d.id ? { ...x, sourceChangeDate: d.changeDate } : x)) };
          changed = true;
          n++;
        }
      }

      // 4: "archiviert" ist laut 01-SPIKE-FINDINGS.md ausschließlich eine FALL-Eigenschaft
      // (kein Dokument-/Bulk-Feld) — ein Aufruf pro Abgleich genügt (nicht pro Dokument).
      // Fehlschlag hier blockiert den übrigen Abgleich nicht (Zusatzsignal, kein Kernzustand).
      try {
        const fall = await getCase(jlBase, creds.username, creds.password, caseId);
        let archivedChanged = false;
        const docsArchiviert = state.docs.map((d) => {
          if (fall.archived === (d.sourceArchived === true)) return d;
          archivedChanged = true;
          if (fall.archived) return { ...d, sourceArchived: true as const };
          // Fall wurde in j-lawyer entarchiviert — symmetrisch zu sourceGone/
          // sourceAccessDenied das Feld wieder entfernen (WR-01).
          const { sourceArchived: _sourceArchived, ...rest } = d;
          return rest;
        });
        if (archivedChanged) {
          changed = true;
          state = { ...state, docs: docsArchiviert };
        }
      } catch {
        // Fall-Metadaten nicht abrufbar — Archiv-Status bleibt unverändert.
      }

      /** Überlagert die transienten sourceNotReachable-Markierungen NUR auf das zurückgegebene
       *  Ergebnis (nicht auf das, was persistiert wurde). */
      const mitLiveOverlay = (ergebnis: { rev: number; state: DesktopState }) =>
        liveNichtErreichbar.size === 0
          ? ergebnis
          : {
              ...ergebnis,
              state: {
                ...ergebnis.state,
                docs: ergebnis.state.docs.map((d) =>
                  liveNichtErreichbar.has(d.id) ? { ...d, sourceNotReachable: true as const } : d,
                ),
              },
            };

      if (!changed) return mitLiveOverlay(getDeskState(db, caseId)!);
      const result = putDeskState(db, caseId, state, { type: 'caseSync', actor });
      broadcast(caseId, result);
      // NOTIF-01 (13-04): NACH dem Persistieren, gegen den frischen State — nur hier ist
      // sicher, dass Annotationen-Mengenprüfung (A5) und Sichtprüfung den abgeglichenen
      // Stand sehen. syncTransitionen ist in diesem Zweig niemals leer-aber-irrelevant:
      // es enthält ausschließlich Transitionen aus GENAU diesem Abgleichsdurchlauf.
      verarbeiteSyncAusloeser(db, caseId, syncTransitionen, result.state);
      return mitLiveOverlay(result);
    }

    /** Deutsche Meldung für den syncFehler-Fallback der Desk-Route (Fehler-Klassen außer
     *  'auth' und 'verboten' — beide laufen über jlFehler, kein 200-Fallback). */
    function syncFehlerMeldung(art: Exclude<JLawyerFehlerArt, 'auth' | 'verboten'>): string {
      switch (art) {
        case 'nichtErreichbar': return 'j-lawyer ist derzeit nicht erreichbar — Stand vom letzten Abgleich.';
        default: return 'j-lawyer meldet einen Fehler — Stand vom letzten Abgleich.';
      }
    }

    app.get('/api/v1/cases', async (req, reply) => {
      const ctx = credsOder401(req, reply);
      if (!ctx) return;
      try {
        return await listCases(jlBase, ctx.creds.username, ctx.creds.password);
      } catch (e) {
        // Derselbe Fallback wie bei GET /cases/:id/desk (Reload-Fix): ein toter/fehlerhafter
        // j-lawyer darf den Nutzer nicht auf den Login-Bildschirm zwingen, obwohl die Sitzung
        // gültig ist. 'auth' (401) und 'verboten' (403) laufen weiterhin unverändert über
        // jlFehler — bei 'verboten' gibt es bewusst KEINEN Fallback (kein Klardaten-Leak bei
        // entzogener Berechtigung). Für nichtErreichbar/fehlt/server liefern wir die aus der
        // desks-Tabelle bekannten Akten (Antwortform bleibt ein Array, Client-Vertrag
        // unverändert): Name ist im Fallback die Akten-ID selbst (ehrlich, da wir den echten
        // Rubrum-Namen ohne j-lawyer nicht kennen) — beim nächsten erfolgreichen Abgleich
        // wieder korrekt. Die Desk-Route liefert dann den syncFehler-Banner dazu.
        //
        // Ohne j-lawyer können wir Rechte nicht prüfen — der Ausfall-Fallback liefert deshalb
        // ausschließlich Akten, die dieser Nutzer selbst geöffnet hat (fail-closed): NICHT
        // listDesks (alle Akten des Servers, auch von Kolleg:innen), sondern
        // listDesksOwnedBy — sonst sähe jeder Nutzer während eines jl-Ausfalls fremde
        // Aktennamen (Cross-User-Leck, unabhängig vom eigentlichen Klartext-Inhalt).
        if (e instanceof JLawyerError && e.art !== 'auth' && e.art !== 'verboten') {
          const userId = (req as FastifyRequest & { userId: string }).userId;
          return listDesksOwnedBy(db, userId).map((d) => ({ id: d.id, name: d.name, fileNumber: '', reason: '' }));
        }
        return jlFehler(e, ctx.token, reply);
      }
    });

    app.get('/api/v1/cases/:id/desk', async (req, reply) => {
      const ctx = credsOder401(req, reply);
      if (!ctx) return;
      const { id } = req.params as { id: string };
      const userId = (req as FastifyRequest & { userId: string }).userId;
      const actor = actorFromRequest(db, req);
      try {
        const result = await syncCaseDesk(ctx.creds, userId, actor, id);
        // WR-07 (PERM-05): auch die jl-Auslieferungspfade gehören zur 10-Pfade-Tabelle —
        // die Antwort wird für den anfragenden Actor projiziert. Die Rolle ist nach dem
        // erfolgreichen Abgleich garantiert gesetzt (ensureBearbeiterRolle, WR-02); für die
        // Projektion ist ohnehin nur die userId relevant (private Ebenen).
        // WR-04: die ermittelte Rolle wird auch AUSGELIEFERT — der Client hält myRolle
        // sonst im jl-Modus dauerhaft auf null („unbekannt" = fail-open „erlaubt") und
        // zeigt dem jl-Bearbeiter Aktionen an, die erst am Server mit 403 scheitern.
        const rolleRoh = getRolleForNutzer(db, id, userId);
        const rolle = rolleRoh ?? 'Eigentümer';
        // SAFE-06/D-13: opportunistische .jdesk-Automatiksicherung in die Akte — bewusst ohne
        // await, damit die Antwortzeit des Abgleichs unverändert bleibt; die Sicherungsfunktion
        // wirft nie (Fehler werden protokolliert, der Merker bleibt im Fehlerfall unverändert).
        // WR-05: für DIESE Sicherung gilt fail-closed statt fail-open — anders als die
        // Rolle oben (nur für die Projektion der Antwort an DIESEN Nutzer relevant) entscheidet
        // die hier übergebene Rolle in buildPackage() darüber, welche PRIVATEN Ebenen ins
        // gemeinsam sichtbare .jdesk-Paket der j-lawyer-Akte gelangen. Ein unauflösbarer Wert
        // (laut ensureBearbeiterRolle „garantiert gesetzt", aber nicht durch einen lokalen Check
        // erzwungen) darf deshalb NICHT still auf die meistprivilegierte Rolle 'Eigentümer'
        // zurückfallen — lieber diese eine Automatiksicherung überspringen (protokolliert) als
        // riskieren, fremden Privatinhalt in ein geteiltes Dokument zu exponieren.
        if (rolleRoh === null) {
          console.error(
            `Automatische .jdesk-Sicherung übersprungen: keine auflösbare Rolle für Nutzer ${userId} an Desk ${id}.`,
          );
        } else {
          void vielleichtArchiviere({ db, dataDir, jlBase, creds: ctx.creds, deskId: id, userId, rolle: rolleRoh, actorName: actor.name });
        }
        return { ...result, state: projectStateForActor(result.state, { userId, rolle }), rolle };
      } catch (e) {
        // Eine abgelaufene/ungültige Sitzung (art 'auth') erzwingt weiterhin die heutige
        // Login-Kette. 'verboten' (403 — j-lawyer verweigert den Zugriff auf GENAU diese
        // Akte) läuft ebenfalls über jlFehler und bekommt KEINEN 200-Fallback: Der letzte
        // gespeicherte Klartext-Stand darf nicht durchsickern, wenn der Zugriff gerade
        // entzogen ist. Alle anderen Fehlerarten (nichtErreichbar/fehlt/server) liefern
        // weiterhin den letzten bekannten Stand mit 200 + syncFehler — ein toter j-lawyer
        // darf den Desk nicht unbenutzbar machen. Kein ensureDesk hier: der Fallback legt
        // für unbekannte/falsche Case-IDs keine Geister-Desk-Zeile mehr an — existiert der
        // Desk noch nicht, kommt ein leerer State ohne Persistenz zurück (der Desk entsteht
        // erst beim ersten erfolgreichen Abgleich).
        //
        // Ohne j-lawyer können wir Rechte nicht prüfen — der Ausfall-Fallback liefert deshalb
        // ausschließlich an Nutzer mit einer desk_roles-Zeile an dieser Akte (fail-closed):
        // der Eigentümer des Erst-Öffnens und alle Nutzer, deren jl-Berechtigung bei einem
        // früheren erfolgreichen Abgleich bereits erwiesen war (WR-02). Nutzer OHNE Zeile
        // bekommen KEINEN Fallback (sonst Cross-User-Leck des vollen Desk-Stands: Karten,
        // Zettel, Stempel, Text-Snapshots) — stattdessen dieselbe 403-Semantik wie bei
        // 'verboten', ohne die Session zu zerstören. Existiert gar keine Zeile, ist der
        // leere State unbedenklich.
        if (e instanceof JLawyerError && e.art !== 'auth' && e.art !== 'verboten') {
          const rolle = getRolleForNutzer(db, id, userId);
          if (rolle === null && getDeskOwner(db, id) !== null) {
            return jlFehler(new JLawyerError('Kein Zugriff auf diese Akte.', 403, 'verboten'), ctx.token, reply);
          }
          const existing = getDeskState(db, id);
          const fallback = existing ?? { rev: 0, state: emptyState() };
          // WR-07: auch der Ausfall-Fallback liefert nur die projizierte Sicht des Anfragenden.
          // WR-04: die bekannte Rolle geht mit (ohne desk_roles-Zeile — Desk existiert noch
          // nicht — bleibt das Feld weg; der Client behandelt das als „unbekannt").
          return {
            ...fallback,
            state: projectStateForActor(fallback.state, { userId, rolle: rolle ?? 'Eigentümer' }),
            ...(rolle !== null ? { rolle } : {}),
            syncFehler: syncFehlerMeldung(e.art),
          };
        }
        return jlFehler(e, ctx.token, reply);
      }
    });

    app.post('/api/v1/cases/:id/documents', async (req, reply) => {
      const ctx = credsOder401(req, reply);
      if (!ctx) return;
      const { id: caseId } = req.params as { id: string };
      const part = await req.file();
      if (!part) return reply.code(400).send({ error: 'Keine Datei im Request' });
      const bytes = await part.toBuffer();
      try {
        // Erst j-lawyer bestätigen lassen, dann die Karte anlegen (Spec: kein Optimismus).
        const { id: docId } = await createDocument(jlBase, ctx.creds.username, ctx.creds.password, caseId, part.filename, bytes);
        const userId = (req as FastifyRequest & { userId: string }).userId;
        const actor = actorFromRequest(db, req);
        ensureDesk(db, caseId, userId, caseId, actor);
        // WR-02: erfolgreicher createDocument-Abruf = jl-Berechtigung an der Akte (s. syncCaseDesk).
        ensureBearbeiterRolle(db, caseId, userId);
        const anzahl = getDeskState(db, caseId)!.state.docs.length;
        const kind = classify(bytes, part.filename);
        const result = applyDeskCommand(db, caseId, {
          type: 'addDoc',
          payload: { fileId: docId, name: part.filename, position: eingang(anzahl), kind },
        }, actor);
        broadcast(caseId, result);
        reply.code(201);
        // WR-07 (PERM-05): Antwort für den anfragenden Actor projizieren (s. GET /cases/:id/desk).
        // WR-04: Rolle mitliefern (durch ensureBearbeiterRolle oben garantiert gesetzt).
        const rolle = getRolleForNutzer(db, caseId, userId) ?? 'Eigentümer';
        return { ...result, state: projectStateForActor(result.state, { userId, rolle }), rolle };
      } catch (e) {
        return jlFehler(e, ctx.token, reply);
      }
    });

    // EXT-01 (13-06): Text-Ablage-Route (Urteil/Norm/Textfragment mit Ablage-Wahl „In j-lawyer
    // ablegen") — PDF-Synthese + dieselbe „erst j-lawyer, dann Karte"-Sequenz wie oben. Die Route
    // lehnt Datei-Arten (E-Mail/Foto/Medien: laufen über den Bestands-Uploadpfad oben) und
    // Weblinks (niemals Ablage, UI-SPEC-Sonderregel) strukturell mit 400 ab (nicht zuständig).
    // credsOder401/jlFehler/eingang leben als Closures über jlCreds/jlBase in diesem Block und
    // werden durchgereicht statt dupliziert.
    registerAufnahme(app, db, { jlBase, credsOder401, jlFehler, eingang });

    /** Lädt (und cacht auf Platte, Schlüssel Dokument-ID + Änderungsdatum) den Dokumentinhalt.
        Wird sowohl von GET /files/:id als auch von der pdf-Fassung der Vorschau-Route genutzt. */
    async function cachedDocBytes(
      creds: { username: string; password: string },
      meta: { id: string; changeDate: number; name: string },
    ): Promise<Buffer> {
      const safe = meta.id.replace(/[^a-zA-Z0-9_-]/g, '_');
      const cacheFile = join(cacheDir, `${safe}-${meta.changeDate}.pdf`);
      if (!existsSync(cacheFile)) {
        const bytes = await getDocumentContent(jlBase, creds.username, creds.password, meta.id);
        // Sprung zur Quelle: Fingerabdruck einmal pro Fassung berechnen, VOR dem Cache-Schreiben
        // (Pattern 2, 01-RESEARCH.md) — persistiert in jl_file_hashes, nicht in dieser Funktion gelesen.
        getOrComputeJlHash(db, meta.id, meta.changeDate, bytes);
        for (const alt of readdirSync(cacheDir).filter((f) => f.startsWith(`${safe}-`))) {
          rmSync(join(cacheDir, alt), { force: true }); // veraltete Fassungen desselben Dokuments
        }
        writeFileSync(cacheFile, bytes);
      }
      const bytes = readFileSync(cacheFile);
      // Zweiter Ingestionsweg für die Datei-Textextraktion (Gegenstück: files.ts storeFile() im
      // Standalone-Pfad, s. Kommentar dort/07-RESEARCH Pitfall 4) — die j-lawyer-fileId auf einer
      // Karte ist dieselbe Dokument-Id, die Doc.fileId im j-lawyer-Modus trägt. Muss AUCH dann
      // laufen, wenn die Bytes aus dem Plattencache kommen (nicht neu heruntergeladen wurden):
      // enqueueExtraction ist idempotent (file_extract-Zeile existiert dann schon), kostet in
      // diesem Fall nur einen SELECT. Dateiart NICHT auf 'pdf' festgenagelt (classifyName statt
      // eines festen Werts) — eine j-lawyer-Akte enthält auch Bilddateien, für die 07-07 einen
      // eigenen OCR-Weg ergänzt; ein hier festgeschriebener Wert würde diesen Weg still aushebeln.
      enqueueExtraction(db, meta.id, classifyName(meta.name), async () => bytes);
      return bytes;
    }

    /** Dokumentinhalt unter dem files-Pfad — fileCache/PageRenderer im Client bleiben
        unverändert; fileId ist im j-lawyer-Modus die j-lawyer-Dokument-ID.
        AR-02-04-Abgrenzung (14-07): dieser Zweig bekommt bewusst KEINE desk-basierte
        istDateiSichtbarFuer()-Prüfung — der Metadatenabruf unten prüft bereits mit den
        Sitzungs-Credentials GEGEN j-lawyer selbst (j-lawyer bleibt das führende
        Berechtigungssystem, s. 02-SECURITY.md). Eine zweite, desk-basierte Prüfung wäre hier
        weder möglich (dieser Modus kennt keine desk_roles-Zeilen für j-lawyer-Dokumente) noch
        richtig (sie würde j-lawyer-Rechte durch ein fremdes Modell ersetzen). */
    app.get('/api/v1/files/:id', async (req, reply) => {
      const ctx = credsOder401(req, reply);
      if (!ctx) return;
      const { id } = req.params as { id: string };
      try {
        // Metadatenabruf mit den Sitzungs-Credentials = Berechtigungsprüfung
        const meta = await getDocumentMeta(jlBase, ctx.creds.username, ctx.creds.password, id);
        reply.header('content-type', 'application/pdf');
        return await cachedDocBytes(ctx.creds, meta);
      } catch (e) {
        return jlFehler(e, ctx.token, reply);
      }
    });

    /** Vorschau: gleiche Berechtigungsprüfung wie /files/:id (Metadatenabruf mit Sitzungs-Credentials).
        kind aus dem Dateinamen (classifyName) — Magic-Bytes gibt's ohne Herunterladen nicht. */
    app.get('/api/v1/files/:id/preview', async (req, reply) => {
      const ctx = credsOder401(req, reply);
      if (!ctx) return;
      const { id: docId } = req.params as { id: string };
      try {
        const meta = await getDocumentMeta(jlBase, ctx.creds.username, ctx.creds.password, docId);
        const kind = classifyName(meta.name);
        if (kind === 'image' || kind === 'other') {
          return reply.code(404).send({ error: 'Keine Vorschau für diese Datei-Art' });
        }
        if (kind === 'pdf') {
          reply.header('content-type', 'application/pdf');
          return await cachedDocBytes(ctx.creds, meta);
        }
        // convertible: Ticket-Konverter braucht die Sitzungs-Credentials, um die Quelle
        // (den Akteninhalt) selbst abzurufen — siehe previewJlCreds/sourceUrl oben.
        previewJlCreds.set(docId, ctx.creds);
        const cacheKey = `${docId}-${meta.changeDate}`;
        return await respondConvertiblePreview(reply, cacheKey, docId, meta.name);
      } catch (e) {
        return jlFehler(e, ctx.token, reply);
      }
    });

    /** Fundstellen-Metadaten für „Sprung zur Quelle": kein Hash verfügbar, kind aus dem Dateinamen. */
    app.get('/api/v1/files/:id/meta', async (req, reply) => {
      const ctx = credsOder401(req, reply);
      if (!ctx) return;
      const { id } = req.params as { id: string };
      try {
        const meta = await getDocumentMeta(jlBase, ctx.creds.username, ctx.creds.password, id);
        return { id: meta.id, name: meta.name, kind: classifyName(meta.name), sha256: null };
      } catch (e) {
        return jlFehler(e, ctx.token, reply);
      }
    });
  }

  // TASK-02 (08-08): Aufgabe an j-lawyer übergeben (Wiedervorlage anlegen). UNBEDINGT
  // registriert (nicht nur innerhalb `if (jlawyerUrl)`) — im Standalone-Betrieb antwortet die
  // Route mit einem ehrlichen Klartexthinweis (400), statt mit einem irreführenden 404 ("Route
  // existiert nicht"). requireDeskAktion(db, 'upload'): die Übergabe erzeugt neuen Inhalt in
  // einem fremden System, genau wie der Dokument-Upload nach j-lawyer — dieselbe Klasse
  // gefährlicher Aktion (RESEARCH.md Assumption A7).
  app.post('/api/v1/desks/:id/tasks/:taskId/handover', { preHandler: requireDeskAktion(db, 'upload') }, async (req, reply) => {
    const { id, taskId } = req.params as { id: string; taskId: string };
    if (!jlawyerUrl) {
      return reply.code(400).send({ error: 'Die Übergabe an j-lawyer ist nur im j-lawyer-Modus möglich.' });
    }
    if (!jlawyerTaskCalendarId) {
      return reply.code(400).send({
        error: 'JLAWYER_TASK_CALENDAR_ID ist nicht konfiguriert — siehe docs/deployment/jlawyer-aufgabenuebergabe.md.',
      });
    }
    const ctx = credsOder401(req, reply);
    if (!ctx) return;
    const state = getDeskState(db, id)?.state;
    const task = state ? findLegalObject(state, taskId) : undefined;
    if (!task) return reply.code(404).send({ error: 'Aufgabe nicht gefunden' });
    if (task.kind !== 'aufgabe') return reply.code(400).send({ error: 'Objekt ist keine Aufgabe' });
    if (!task.dueDate) return reply.code(400).send({ error: 'Aufgabe hat keine Fälligkeit gesetzt' });
    // WR-03: serverseitiger Guard gegen doppelte Übergabe — der Client zeigt zwar einen
    // Warnhinweis (menus.ts uebergebeAufgabe), das ist aber nur eine Bestätigung, kein
    // Schutz gegen Netzwerk-Retry/zweiten Tab/direkten API-Aufruf. Diese Route schreibt
    // irreversiblen, cross-system Zustand (echte Wiedervorlage in j-lawyer); ein zweiter
    // Aufruf legt sonst eine zweite Wiedervorlage an und überschreibt jlDueDateId still.
    if (task.handedOverToJLawyer) {
      return reply.code(409).send({ error: 'Diese Aufgabe wurde bereits an j-lawyer übergeben.' });
    }
    // WR-05: schließt die verbleibende TOCTOU-Lücke des Guards oben — zwei nahezu gleichzeitige
    // Anfragen für dieselbe Aufgabe lesen sonst beide handedOverToJLawyer als unset, bevor der
    // erste createDueDate-await zurückkehrt. Die Sperre wird SOFORT nach der letzten synchronen
    // Prüfung gesetzt (kein await dazwischen) und im finally garantiert wieder freigegeben, auch
    // bei Exceptions/frühen Returns.
    const handoverKey = `${id}:${taskId}`;
    if (handoverInFlight.has(handoverKey)) {
      return reply.code(409).send({ error: 'Diese Aufgabe wird gerade an j-lawyer übergeben.' });
    }
    handoverInFlight.add(handoverKey);

    const summaryQuelle = task.text.split('\n')[0]?.trim() ?? '';
    const summary = summaryQuelle.length > 200 ? summaryQuelle.slice(0, 200) : summaryQuelle;
    // Beschreibung trägt AUSSCHLIESSLICH einen Dokument-/Seitenverweis aus dem Aufgaben-Bezug —
    // kein Annotationstext, kein Ausschnitt-Textauszug, kein Ebenenname, kein Inhalt
    // verknüpfter Objekte (T-08-35). Ist kein Bezug gesetzt, bleibt das Feld leer (weggelassen).
    let description: string | undefined;
    if (task.docRef) {
      const doc = state!.docs.find((d) => d.id === task.docRef!.docId);
      if (doc) description = task.docRef.page !== undefined ? `${doc.name}, S. ${task.docRef.page}` : doc.name;
    }

    try {
      // Erst j-lawyer bestätigen lassen, dann den Status wechseln (Spec: kein Optimismus —
      // dasselbe Muster wie die Dokument-Upload-Route oben).
      const jlDueDateId = await createDueDate(jlawyerUrl, ctx.creds.username, ctx.creds.password, {
        caseId: id,
        calendar: jlawyerTaskCalendarId,
        summary,
        beginDate: task.dueDate,
        ...(description !== undefined ? { description } : {}),
        ...(task.assignee !== undefined ? { assignee: task.assignee } : {}),
      });
      const actor = actorFromRequest(db, req);
      const userId = (req as FastifyRequest & { userId: string }).userId;
      const result = applyDeskCommand(db, id, {
        type: 'markTaskHandedOver',
        payload: { id: taskId, at: new Date().toISOString(), jlDueDateId },
      }, actor);
      broadcast(id, result);
      // WR-07 (PERM-05): Antwort für den anfragenden Actor projizieren (s. GET /cases/:id/desk).
      return { ...result, state: projectStateForActor(result.state, { userId, rolle: req.rolle! }), jlDueDateId };
    } catch (e) {
      return jlFehler(e, ctx.token, reply);
    } finally {
      handoverInFlight.delete(handoverKey);
    }
  });

  // ---- Schreibtische ----
  // PERM-05 (Pfad 1): nur Desks liefern, für die der Nutzer eine desk_roles-Zeile hat — fremde
  // Desks fehlen komplett, kein Platzhalter (Research 10-Pfade-Tabelle Zeile 1).
  app.get('/api/v1/desks', async (req) => {
    const userId = (req as FastifyRequest & { userId: string }).userId;
    return listDesks(db).filter((d) => getRolleForNutzer(db, d.id, userId) !== null);
  });

  // TMPL-01 (13-07): desk-loser GET — Auth-Pflicht über den globalen Auth-Hook oben, keine
  // Desk-Rolle nötig (Vorlagen sind Code-Konstanten, kein Mandatsbezug).
  app.get('/api/v1/vorlagen', async () => ({ vorlagen: listeVorlagen() }));

  app.post('/api/v1/desks', async (req, reply) => {
    const { name, vorlageId } = (req.body ?? {}) as { name?: string; vorlageId?: string };
    if (typeof name !== 'string' || name.trim() === '') {
      return reply.code(400).send({ error: 'Feld "name" fehlt oder ist leer' });
    }
    // TMPL-01 (13-07, T-13-07-01): unbekannte vorlageId muss VOR jeder Schreibung mit 400
    // abgewiesen werden — sonst entstünde ein halb angelegter Desk. Ohne vorlageId bleibt der
    // Weg byte-identisch zum Bestand (initial bleibt undefined → createDesk() nutzt emptyState()).
    let initial;
    if (vorlageId !== undefined) {
      const vorlage = findeVorlage(vorlageId);
      if (!vorlage) return reply.code(400).send({ error: 'Feld "vorlageId" verweist auf keine Vorlage' });
      initial = initialerStateAusVorlage(vorlage, actorFromRequest(db, req));
    }
    const userId = (req as FastifyRequest & { userId: string }).userId;
    reply.code(201);
    return createDesk(db, userId, name.trim(), actorFromRequest(db, req), initial);
  });

  // PERM-04 (CR-01): Umbenennen ist Eigentümer/Bearbeiter vorbehalten, Löschen als gefährliche
  // Aktion (darfAktion 'delete') ausschließlich dem Eigentümer — bis zur Review standen beide
  // Routen mit dem globalen Auth-Hook allein da, jeder angemeldete Nutzer konnte jeden Desk
  // umbenennen/löschen.
  app.patch('/api/v1/desks/:id', { preHandler: requireDeskRolle(db, ['Eigentümer', 'Bearbeiter']) }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { name } = (req.body ?? {}) as { name?: string };
    if (typeof name !== 'string' || name.trim() === '') {
      return reply.code(400).send({ error: 'Feld "name" fehlt oder ist leer' });
    }
    try {
      renameDesk(db, id, name.trim());
    } catch (e) {
      if (e instanceof DeskNotFoundError) return reply.code(404).send({ error: e.message });
      throw e;
    }
    return { ok: true };
  });

  app.delete('/api/v1/desks/:id', { preHandler: requireDeskAktion(db, 'delete') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      deleteDesk(db, id);
    } catch (e) {
      if (e instanceof DeskNotFoundError) return reply.code(404).send({ error: e.message });
      throw e;
    }
    return { ok: true };
  });

  // PERM-04/PERM-05 (Pfad 2): Guard VOR jeder Auslieferung, projizierter State in der Antwort —
  // ein Guard allein sagt nichts über den Payload-Inhalt aus (Research „Guard auf /state sagt
  // nichts über /commands").
  app.get('/api/v1/desks/:id/state', { preHandler: requireDeskRolle(db) }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = getDeskState(db, id);
    if (!result) return reply.code(404).send({ error: 'Schreibtisch nicht gefunden' });
    const userId = (req as FastifyRequest & { userId: string }).userId;
    // 02-07: der Client kennt sonst nirgends seine eigene Rolle am Desk — ohne dieses Feld
    // könnte die UI rollengebundene Aktionen (Ebenen-/Rollenverwaltung, PERM-02) nicht ausblenden.
    return { rev: result.rev, state: projectStateForActor(result.state, { userId, rolle: req.rolle! }), rolle: req.rolle! };
  });

  // SEARCH-03 (07-08): OCR-Qualitäts-Chip an der Karte — eigene, kleine Route statt eines
  // zusätzlichen Felds am Zustandsobjekt (Begründung: 07-08-PLAN.md-Objective — eine Datei kann
  // auf mehreren Desks liegen, die Erkennung endet asynchron nach dem Upload). Derselbe Guard wie
  // GET /desks/:id/state (T-07-39) — keine zweite, schwächere Rechteprüfung.
  app.get('/api/v1/desks/:id/ocr', { preHandler: requireDeskRolle(db) }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = getDeskState(db, id);
    if (!result) return reply.code(404).send({ error: 'Schreibtisch nicht gefunden' });
    const userId = (req as FastifyRequest & { userId: string }).userId;
    return ocrStatusFuerDesk(db, id, { userId, rolle: req.rolle! });
  });

  // COMP-01/02 (09-08): Rückfallweg für eingescannte Fassungen im Vergleichsviewer — der
  // erkannte bzw. eingebettete Text einer Datei, ohne Wortkoordinaten. Derselbe Guard wie
  // GET /desks/:id/state (T-09-33): keine zweite, schwächere Rechteprüfung — ein Textabruf ist
  // ein Inhaltsabruf, kein Metadatenabruf, und braucht deshalb dieselbe Schranke wie der
  // Zustand selbst. GENAU EIN Ablehnungszweig (T-09-32): fileTextFuerDesk() liefert `null`
  // sowohl für eine nicht sichtbare als auch für eine nicht existierende Datei-id — die Route
  // unterscheidet die beiden Fälle NICHT, weder im Statuscode noch in der Meldung. Die Datei-id
  // fließt ausschließlich als Parameter in eine parametrisierte Datenbankabfrage (fileText.ts)
  // und wird an keiner Stelle zu einem Dateisystempfad zusammengesetzt (T-09-34).
  app.get('/api/v1/desks/:id/file-text/:fileId', { preHandler: requireDeskRolle(db) }, async (req, reply) => {
    const { id, fileId } = req.params as { id: string; fileId: string };
    const userId = (req as FastifyRequest & { userId: string }).userId;
    const ergebnis = fileTextFuerDesk(db, id, fileId, { userId, rolle: req.rolle! });
    if (!ergebnis) return reply.code(404).send({ error: 'Datei nicht gefunden oder nicht sichtbar.' });
    return ergebnis;
  });

  // SEARCH-01/04 (07-01): POST statt GET — der Suchtext enthält Mandanteninhalte und darf
  // nicht in Zugriffsprotokollen von Server/Proxy oder der Browser-Historie landen (T-07-06,
  // Query-Strings werden dort protokolliert, Request-Bodies nicht). Derselbe Guard wie
  // GET /desks/:id/state — kein neues Rechtekonzept, keine Route ohne Guard (T-07-05).
  app.post('/api/v1/desks/:id/search', { preHandler: requireDeskRolle(db) }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { q } = (req.body ?? {}) as { q?: unknown };
    if (typeof q !== 'string') return reply.code(400).send({ error: 'Suchtext fehlt oder ist ungültig.' });
    const userId = (req as FastifyRequest & { userId: string }).userId;
    try {
      return { treffer: sucheAufDesk(db, id, { userId, rolle: req.rolle! }, q) };
    } catch {
      // T-07-04: eine geworfene SQLite-/FTS5-Ausnahme erreicht den Client NIE im Original-
      // Wortlaut — nur die generische Meldung, kein Stacktrace, keine interne Fehlerdetails.
      return reply.code(500).send({ error: 'Suche fehlgeschlagen.' });
    }
  });

  // LEGAL-03 (08-05): dieselbe Schranke wie die Suche (requireDeskRolle, NICHT
  // requireDeskAktion) — eine Auswertung verändert nichts und gibt nichts preis, das der
  // Nutzer nicht ohnehin im projizierten Zustand sähe; ein Nutzer mit der Rolle Nur-Lesen darf
  // daher auswerten. Ein unbekannter Abfragename ergibt bewusst 400 statt eines leeren 200 —
  // der Client soll einen Tippfehler bemerken, statt stillschweigend nichts zu erhalten.
  const LEGAL_QUERY_KINDS = new Set<string>(LEGAL_QUERIES.map((q) => q.kind));
  app.post('/api/v1/desks/:id/legal-queries', { preHandler: requireDeskRolle(db) }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { query } = (req.body ?? {}) as { query?: unknown };
    if (typeof query !== 'string' || !LEGAL_QUERY_KINDS.has(query)) {
      return reply.code(400).send({ error: 'Abfragename fehlt oder ist ungültig.' });
    }
    const userId = (req as FastifyRequest & { userId: string }).userId;
    try {
      return { treffer: runLegalQuery(db, id, { userId, rolle: req.rolle! }, query as LegalQueryKind) };
    } catch {
      // T-08-20: dasselbe Schweigemuster wie die Suchroute — keine Ausnahmedetails im Antwortkörper.
      return reply.code(500).send({ error: 'Auswertung fehlgeschlagen.' });
    }
  });

  // PERM-04/PERM-05 (Pfad 8): Export ist eine GefahrlicheAktion (nur Eigentümer/Bearbeiter,
  // s. darfAktion-Matrix); buildPackage() projiziert den State für den anfragenden Actor VOR
  // sanitizeForExport() — ein exportiertes Paket enthält nie mehr, als der Anfragende ohnehin
  // in seiner State-/Commands-Antwort sähe.
  app.get('/api/v1/desks/:id/export', { preHandler: requireDeskAktion(db, 'export') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    // Der Dateiname kommt aus dem Schreibtischnamen, nicht aus der ID.
    const row = db.prepare('SELECT name FROM desks WHERE id = ?').get(id) as { name: string } | undefined;
    if (!row) return reply.code(404).send({ error: 'Schreibtisch nicht gefunden' });
    const actor = actorFromRequest(db, req);
    const userId = (req as FastifyRequest & { userId: string }).userId;
    try {
      const paket = buildPackage(db, dataDir, id, { createdBy: actor.name, jlawyer: !!jlawyerUrl, userId, rolle: req.rolle! });
      // HIST-04: ein Export ist kein Zustands-Write — desks.rev bleibt unverändert, die
      // exported-Zeile trägt denselben rev wie die letzte reale Änderung (Muster wie beim
      // Sicherheits-Snapshot in restore.ts). Payload ausschließlich {format} (P-07) — kein
      // Dateiname, keine Paketgröße, kein Manifest-Auszug.
      const stand = getDeskState(db, id);
      if (stand) {
        appendJournal(db, {
          deskId: id, rev: stand.rev, type: 'exported', payload: { format: 'jdesk' },
          actorId: actor.id, actorName: actor.name,
        });
      }
      reply.header('content-type', 'application/vnd.digitaldesk.workspace+zip');
      reply.header('content-disposition', contentDisposition(dateiname(row.name)));
      return paket;
    } catch (e) {
      if (e instanceof DeskNotFoundError) return reply.code(404).send({ error: e.message });
      throw e;
    }
  });

  // VOICE-01 (14-09): Anymize-Transkription — Vermittlerroute, modusunabhängig registriert
  // (Diktat ist keine j-lawyer-spezifische Fähigkeit, anders als registerAufnahme oben). Fehlt
  // die Konfiguration (main.ts), meldet sich die Route lediglich als nicht verfügbar.
  registerTranskription(app, { config: transkriptionConfig ?? null });

  // EXP-03/EXP-05 (03-01): PDF-Übergabeformate — dieselbe Guard-Kette wie der .jdesk-Export
  // (requireDeskAktion('export') → Projektion → freigabeFilter → Pipeline), D-02.
  registerPdfExportRoutes(app, db, dataDir);

  // KONV-01 (10-01): Anlagenpaket — eigene Route, eigener Anfragekörper (Reihenfolge,
  // Bezeichnungen, ausgeschlossene Seiten passen nicht in eine Abfragezeichenkette).
  registriereAnlagenpaketRouten(app, db, dataDir);

  // AI-01/AI-02 (12-01): Vorschlags-Register — Erstellen/Genehmigen/Ablehnen von
  // KI-Vorschlägen; die Genehmigung wirkt ausschließlich über applyDeskCommand (kein
  // zweiter Schreibpfad auf desks.state).
  registerProposals(app, db);

  // NOTIF-01 (13-01): Inbox-Register — user-scoped lesen/gelesen-markieren. Rollenfrage
  // explizit beantwortet: die Routen brauchen KEINEN Eintrag in guards/LOESCH_COMMANDS
  // (Nutzerhoheit über die eigene Inbox, ASVS V4, kein Desk-Rollen-Shortcut); der
  // Erwähnungs-Hook in deskStore feuert unabhängig von der Auslöser-Rolle — auch
  // Kommentatoren (die addNote/editNote dürfen) lösen aus, Nur-Lesen-Nutzer empfangen.
  registerBenachrichtigungen(app, db);

  // PERM-04 (Pfad 9): nur Eigentümer/Bearbeiter dürfen einen Schreibtisch per Import ersetzen.
  app.post('/api/v1/desks/:id/import', { preHandler: requireDeskRolle(db, ['Eigentümer', 'Bearbeiter']) }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!getDeskState(db, id)) return reply.code(404).send({ error: 'Schreibtisch nicht gefunden' });
    const teil = await req.file();
    if (!teil) return reply.code(400).send({ error: 'Keine Datei übermittelt' });
    const bytes = await teil.toBuffer();

    let paket;
    try {
      paket = readPackage(bytes);
    } catch (e) {
      if (e instanceof PaketFehler) return reply.code(400).send({ error: e.message });
      throw e;
    }

    // Nur im j-lawyer-Betrieb: der Akten-Abgleich ist die Wahrheit über den Karteninhalt.
    // Ein Paket aus einer anderen Akte (oder Installation) würde nach dem Ersetzen sofort
    // vom nächsten Abgleich zerpflückt (fremde fileIds verwaisen, echte Aktendokumente kommen
    // frisch dazu) — der Schreibtisch muss also VOR dem Ablegen jeder Datei und VOR der
    // Transaktion unberührt bleiben. Die Wiederherstellung in dieselbe Akte bleibt erlaubt.
    if (jlawyerUrl && paket.manifest.source?.caseId !== id) {
      const herkunft = paket.manifest.source?.deskName || paket.manifest.source?.caseId || 'einer anderen Akte';
      return reply.code(409).send({
        error: `Dieses Paket stammt aus der Akte „${herkunft}" und passt nicht zu dieser Akte. `
          + 'Ein Arbeitsstand lässt sich nur in die Akte zurückspielen, aus der er exportiert wurde.',
      });
    }

    // Im Eigenständig-Betrieb gibt es keinen Akten-Abgleich, der ein Paket aus dem
    // j-lawyer-Betrieb ('linked', ohne Dateibytes) nachträglich als kaputt erkennen würde:
    // mapFileIds ließe alle fileIds unverändert stehen, der Zustand würde klaglos ersetzt und
    // jede Karte zeigte auf eine Datei, die es hier nie gab (stille Blindkarten). Also VOR dem
    // Ablegen jeder Datei und VOR der Transaktion ablehnen — der Schreibtisch muss unberührt bleiben.
    if (!jlawyerUrl && paket.manifest.source?.kind === 'jlawyer') {
      return reply.code(409).send({
        error: 'Dieses Paket stammt aus dem j-lawyer-Betrieb und lässt sich im Eigenständig-Betrieb '
          + 'dieser Installation nicht verwenden.',
      });
    }

    // Dateien zuerst ablegen (dedupliziert über sha256) und die Verweise umschreiben —
    // beim Umzug zwischen Installationen vergibt storeFile neue fileIds.
    // readPackage prüft jede eingebettete Datei bereits vor (leer/über 100 MB) — dieser
    // Fang ist die zweite Sicherung für Fälle, die die Vorprüfung nicht kennt.
    const abbildung = new Map<string, string>();
    try {
      for (const [alteId, eintrag] of paket.files) {
        const meta = storeFile(db, dataDir, eintrag.bytes, eintrag.name);
        abbildung.set(alteId, meta.id);
      }
    } catch (e) {
      if (e instanceof FileError) return reply.code(400).send({ error: e.message });
      throw e;
    }
    const state = mapFileIds(paket.state, abbildung);

    const actor = actorFromRequest(db, req);
    const vorher = getDeskState(db, id)!;
    // Vorzustand als snapshot sichern, BEVOR er ersetzt wird — sonst ist er unwiederbringlich.
    const ersetzen = db.transaction(() => {
      appendJournal(db, {
        deskId: id, rev: vorher.rev, type: 'snapshot', payload: { state: vorher.state },
        actorId: actor.id, actorName: actor.name,
      });
      return putDeskState(db, id, state, { type: 'stateReplaced', actor });
    });
    let neu;
    try {
      neu = ersetzen();
    } catch (e) {
      // Ziel-Schreibtisch zwischen der Existenzprüfung oben und der Transaktion gelöscht.
      if (e instanceof DeskNotFoundError) return reply.code(404).send({ error: e.message });
      throw e;
    }
    // Gleiche Form wie alle uebrigen Broadcasts im Bestand (app.ts:622, :635): das
    // DeskState-Ergebnis unverändert weiterreichen, kein eigener Umschlag.
    broadcast(id, neu);
    return { ok: true, rev: neu.rev };
  });

  // HIST-02 (04-01): eine frühere Journal-Zeile vollständig als Schreibtischstand
  // zurückholen — 'manage' (Eigentümer + Bearbeiter) wie die Import-Route (T-04-03).
  app.post('/api/v1/desks/:id/restore', { preHandler: requireDeskAktion(db, 'manage') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { toEntryId } = (req.body ?? {}) as { toEntryId?: unknown };
    if (typeof toEntryId !== 'number' || !Number.isFinite(toEntryId) || toEntryId <= 0) {
      return reply.code(400).send({ error: 'toEntryId erforderlich' });
    }
    const actor = actorFromRequest(db, req);
    try {
      const neu = restoreDeskTo(db, id, toEntryId, actor);
      // D-08: derselbe unprojizierte State wie alle übrigen Bestandsaufrufer — broadcast()
      // projiziert pro Empfänger (projiziertFuerEmpfaenger); 'event' ist ein additives Feld,
      // das dabei unverändert durchgereicht wird.
      broadcast(id, { rev: neu.rev, state: neu.state, event: 'restored' });
      return { ok: true, rev: neu.rev };
    } catch (e) {
      if (e instanceof DeskNotFoundError) return reply.code(404).send({ error: e.message });
      if (e instanceof ReplayFehler) return reply.code(422).send({ error: e.message });
      throw e;
    }
  });

  // PERM-04/PERM-05 (Pfad 3): Guard lässt jede Rolle grundsätzlich rein (die Feinprüfung —
  // welcher Command-Typ, welche Rolle — folgt unten pro Command), die Antwort wird projiziert.
  app.post('/api/v1/desks/:id/commands', { preHandler: requireDeskRolle(db) }, async (req, reply) => {
    const { id } = req.params as { id: string };
    // Body trägt jetzt zusätzlich die Erwartung (Objekt-ID -> zuletzt gesehene updatedRev).
    const cmd = (req.body ?? {}) as Command & { erwartet?: Erwartet };
    const actor = actorFromRequest(db, req);
    const userId = (req as FastifyRequest & { userId: string }).userId;
    // PERM-04 (Task 2): Rechteprüfung NACH der Rolle aus dem Guard, NIE aus dem Payload (ein
    // mitgeschickter "rolle"-Wert im Body ist strukturell wirkungslos — wir lesen ihn nirgends).
    // CR-04 (PERM-02): die Ebenen-Bearbeitungsprüfung gegen den AKTUELLEN State folgt in
    // derselben Sequenz — beide Stufen laufen über die extrahierte Guard-Funktion
    // (pruefeKommandosFuerActor oben), die der Genehmigungspfad der KI-Vorschläge teilt.
    const verweigert = pruefeKommandosFuerActor(db, id, req.rolle!, actor, [cmd]);
    if (verweigert) return reply.code(403).send({ error: verweigert });
    // Der files-Guard gilt NUR im Standalone-Modus: im jl-Modus ist die files-Tabelle immer
    // leer (Dateien liegen in j-lawyer), addDoc käme hier nie an einer echten fileId vorbei —
    // sonst bekäme der Sprung-anlegen-Pfad (addDoc nach erfolgreicher jl-meta-Route) immer 400.
    // Im jl-Modus ist der Akten-Abgleich die Wahrheit: Karten zu nicht (mehr) existierenden
    // Dokumenten entfernt der nächste Abgleich; eine getDocumentMeta-Validierung pro Command
    // wäre unverhältnismäßig.
    if (!jlawyerUrl && cmd.type === 'addDoc' && !fileExists(db, String((cmd.payload as { fileId?: unknown })?.fileId ?? ''))) {
      return reply.code(400).send({ error: 'Unbekannte fileId' });
    }
    // Sprung zur Quelle: fileSha256 gehört zur Fundstelle und darf nicht vom Client kommen —
    // serverseitig aus der Quellfassung der Karte ermitteln (Standalone: files.sha256,
    // j-lawyer-Modus: jl_file_hashes) und jeden Client-Wert überschreiben/verwerfen.
    if (cmd.type === 'addCutout') {
      const payload = cmd.payload as Record<string, unknown> | undefined;
      if (payload && typeof payload === 'object') {
        const doc = getDeskState(db, id)?.state.docs.find((d) => d.id === payload.docId);
        const hash = ermittleFileSha256(db, jlawyerUrl, doc);
        if (hash) payload.fileSha256 = hash;
        else delete payload.fileSha256;
        kappeTextSnapshot(payload);
      }
    } else if (cmd.type === 'addMark') {
      const payload = cmd.payload as Record<string, unknown> | undefined;
      const mark = payload?.mark as Record<string, unknown> | undefined;
      if (mark && typeof mark === 'object') {
        const doc = getDeskState(db, id)?.state.docs.find((d) => d.id === mark.docId);
        const hash = ermittleFileSha256(db, jlawyerUrl, doc);
        if (hash) mark.fileSha256 = hash;
        else delete mark.fileSha256;
        kappeTextSnapshot(mark);
      }
    }
    try {
      const result = applyDeskCommand(db, id, cmd, actor);
      broadcast(id, result);
      return { ...result, state: projectStateForActor(result.state, { userId, rolle: req.rolle! }) };
    } catch (e) {
      if (e instanceof KonfliktError) {
        // WR-06: der Konflikt-Körper nennt Akteur (von) und Zeitpunkt (am) des konfligierenden
        // Objekts — mit geratener/eingefrorener ID ließe sich so die Existenz und der letzte
        // Bearbeiter eines verborgenen (privaten) Objekts ertasten. Für Objekte ohne
        // Sichtrecht des Anfragenden werden beide Felder gestrichen; objektId/typ/art bleiben
        // (Client-Vertrag des Konflikt-Overlays).
        const konfliktState = getDeskState(db, id)?.state;
        const treffer = konfliktState ? findeObjekt(konfliktState, e.konflikt.objektId) : undefined;
        const sichtbar = treffer !== undefined && konfliktState !== undefined
          && istObjektSichtbarFuer(
            (treffer.obj as { layerId?: string }).layerId,
            { userId, rolle: req.rolle! },
            konfliktState.layers,
          );
        if (!sichtbar) {
          return reply.code(409).send({ konflikt: { ...e.konflikt, von: null, am: null } });
        }
        return reply.code(409).send({ konflikt: e.konflikt });
      }
      if (e instanceof CommandError) return reply.code(400).send({ error: e.message });
      if (e instanceof DeskNotFoundError) return reply.code(404).send({ error: e.message });
      throw e;
    }
  });

  // PERM-04 (Pfad 4, CR-05): State-Replace ist ausschließlich dem Eigentümer vorbehalten. Bis
  // zur Review durften auch Bearbeiter den vollständigen Stand ersetzen — das umging die
  // Lösch-/Schredder-Sperre der Matrix (Objekte einfach weglassen), die Provenienz-Feldhoheit
  // (createdBy/updatedBy frei erfindbar) und die Ebenen-Hoheit (fremde private Ebenen tilgen,
  // wodurch deren Objekte über den „unbekannte layerId"-Fallback für ALLE sichtbar würden).
  // Der legitime Bearbeiter-Ersetzen-Weg ist /import (separat abgesichert).
  app.put('/api/v1/desks/:id/state', { preHandler: requireDeskRolle(db, ['Eigentümer']) }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const result = putDeskState(db, id, req.body, { type: 'stateReplaced', actor: actorFromRequest(db, req) });
      broadcast(id, result);
      // Wie überall: die Antwort ist für den ANFRAGENDEN projiziert — auch der Eigentümer
      // sieht fremde private Objekte nicht (PERM-05).
      const userId = (req as FastifyRequest & { userId: string }).userId;
      return { rev: result.rev, state: projectStateForActor(result.state, { userId, rolle: req.rolle! }) };
    } catch (e) {
      if (e instanceof InvalidStateError) return reply.code(400).send({ error: e.message });
      if (e instanceof DeskNotFoundError) return reply.code(404).send({ error: e.message });
      throw e;
    }
  });

  // PERM-05/T-02-04 (Pfad 7): Guard auf Eigentümer/Bearbeiter (CONTEXT nennt keine explizite
  // Journal-Rollenschranke; Research Pitfall 2 empfiehlt Bearbeiter-aufwärts als Default) +
  // Payload-Projektion pro Betrachter (state-tragende Einträge UND sensible Objektfelder wie
  // textSnapshot in addCutout/addMark-Einträgen privater Fremdobjekte).
  app.get('/api/v1/desks/:id/journal', { preHandler: requireDeskRolle(db, ['Eigentümer', 'Bearbeiter']) }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const deskState = getDeskState(db, id);
    if (!deskState) return reply.code(404).send({ error: 'Schreibtisch nicht gefunden' });
    const { limit, before } = req.query as { limit?: string; before?: string };
    // Number('') wäre 0 statt NaN — ein geleertes Formularfeld (URLSearchParams) darf aber
    // nicht als gültige 0 durchgehen, sondern muss wie ein fehlender Parameter wirken.
    // trim() zuerst: Number(' ') ist ebenfalls 0 (whitespace-only Query-Wert würde sonst durchrutschen).
    const limitTrimmed = limit?.trim();
    const beforeTrimmed = before?.trim();
    const parsedLimit = limitTrimmed === undefined || limitTrimmed === '' ? NaN : Number(limitTrimmed);
    const parsedBefore = beforeTrimmed === undefined || beforeTrimmed === '' ? NaN : Number(beforeTrimmed);
    const userId = (req as FastifyRequest & { userId: string }).userId;
    return {
      entries: listJournal(db, id, {
        limit: Number.isNaN(parsedLimit) ? undefined : parsedLimit,
        before: Number.isNaN(parsedBefore) ? undefined : parsedBefore,
        ctx: { userId, rolle: req.rolle! },
        state: deskState.state,
      }),
    };
  });

  // ---- Mitglieder/Rollenvergabe (02-04 Task 3) ----
  // Bewusst NUR Rollenvergabe für bereits existierende Nutzer (PERM-03) — kein Einladungscode-,
  // Admin-Konto- oder Passwort-Reset-Flow. Das ist der volle TP3-Umfang (archivierte
  // Benutzer-Teilen-Spec) NICHT — Research Open Question 1 grenzt das explizit aus.
  // Alle vier Routen sind ausschließlich dem Eigentümer vorbehalten (CONTEXT „Rollenvergabe
  // durch den Desk-Eigentümer"); der Eigentümer selbst ist in der Liste, aber schreibgeschützt
  // (setRolleFuerNutzer/removeRolle lehnen die eigene userId ab).
  app.get('/api/v1/desks/:id/members', { preHandler: requireDeskRolle(db, ['Eigentümer']) }, async (req) => {
    const { id } = req.params as { id: string };
    return listMembers(db, id);
  });

  app.post('/api/v1/desks/:id/members', { preHandler: requireDeskRolle(db, ['Eigentümer']) }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { username, rolle } = (req.body ?? {}) as { username?: string; rolle?: string };
    if (typeof username !== 'string' || username.trim() === '') {
      return reply.code(400).send({ error: 'Feld "username" fehlt oder ist leer' });
    }
    if (typeof rolle !== 'string' || rolle.trim() === '') {
      return reply.code(400).send({ error: 'Feld "rolle" fehlt oder ist leer' });
    }
    try {
      // WR-01/T-06-04: offene WS-Sockets des Nutzers bekommen die neue Rolle sofort mit (statt
      // erst nach Reconnect) — sowohl im Broadcast- als auch im unabhängigen Präsenz-Register.
      const betroffenerUserId = setRolle(db, id, username.trim(), rolle);
      aktualisiereRolle(id, betroffenerUserId, rolle as Rolle);
      aktualisierePresenzRolle(id, betroffenerUserId, rolle as Rolle);
      // WR-02: Registry-Update allein aktualisiert nicht den bereits an andere Sockets
      // ausgelieferten Roster — ohne diesen Rundruf bleibt eine Soft-Lock-Dekoration auf
      // fremden Bildschirmen bis zum nächsten unabhängigen Präsenz-Ereignis stale.
      sendePraesenz(id, getDeskState(db, id)?.state);
      // NOTIF-01 (13-04, O3): AUSSCHLIESSLICH dieser POST-Zweig benachrichtigt — PUT
      // (Rollenwechsel) und DELETE (Entzug) bleiben bewusst still (Lärm-Regel).
      const deskZeile = db.prepare('SELECT name FROM desks WHERE id = ?').get(id) as { name: string } | undefined;
      verarbeiteGeteiltAusloeser(db, id, deskZeile?.name ?? id, betroffenerUserId, rolle, actorFromRequest(db, req));
    } catch (e) {
      if (e instanceof UnbekannterNutzerError) return reply.code(404).send({ error: e.message });
      if (e instanceof UngueltigeRolleError) return reply.code(400).send({ error: e.message });
      throw e;
    }
    reply.code(201);
    return { ok: true };
  });

  app.put('/api/v1/desks/:id/members/:userId', { preHandler: requireDeskRolle(db, ['Eigentümer']) }, async (req, reply) => {
    const { id, userId: zielUserId } = req.params as { id: string; userId: string };
    const { rolle } = (req.body ?? {}) as { rolle?: string };
    if (typeof rolle !== 'string' || rolle.trim() === '') {
      return reply.code(400).send({ error: 'Feld "rolle" fehlt oder ist leer' });
    }
    try {
      setRolleFuerNutzer(db, id, zielUserId, rolle);
      // WR-01/T-06-04: s. POST /members — Rollenänderung wirkt sofort auf offene Verbindungen.
      aktualisiereRolle(id, zielUserId, rolle as Rolle);
      aktualisierePresenzRolle(id, zielUserId, rolle as Rolle);
      // WR-02: s. POST /members — ohne Rundruf bleibt der Roster bei anderen Sockets stale.
      sendePraesenz(id, getDeskState(db, id)?.state);
    } catch (e) {
      if (e instanceof UnbekannterNutzerError) return reply.code(404).send({ error: e.message });
      if (e instanceof UngueltigeRolleError) return reply.code(400).send({ error: e.message });
      throw e;
    }
    return { ok: true };
  });

  app.delete('/api/v1/desks/:id/members/:userId', { preHandler: requireDeskRolle(db, ['Eigentümer']) }, async (req, reply) => {
    const { id, userId: zielUserId } = req.params as { id: string; userId: string };
    try {
      removeRolle(db, id, zielUserId);
      // WR-01: entzogener Zugriff wirkt sofort — offene Sockets werden geschlossen (4003),
      // der auto-reconnectende Client scheitert danach am Rollen-Check des WS-Connects.
      trenneNutzer(id, zielUserId, 'Der Zugriff auf diesen Schreibtisch wurde entfernt.');
    } catch (e) {
      if (e instanceof UngueltigeRolleError) return reply.code(400).send({ error: e.message });
      throw e;
    }
    return { ok: true };
  });

  // ---- Systemdiagnose (OPS-02, 14-01) ----
  // Betriebs-Innenansicht (Versionen, Konfigurationszustand, Erreichbarkeit) — bewusst am
  // bestehenden desk-scoped Eigentümer-Gate statt an einem neuen Instanz-Admin-Konzept:
  // auth.ts kennt kein isAdmin, ein zweites Rechtekonzept wäre ein eigenes Feature (Planner-
  // Entscheidung D-B, 14-RESEARCH.md Open Question 1). Im j-lawyer-Modus ist currentRolle
  // null, der Toolbar-Button fehlt dort im Client vollständig — dieselbe Bestandslage wie beim
  // Teilen-Button. Fehlt der preHandler, wäre die Betriebs-Innenansicht für jede angemeldete
  // Session offen (T-14-01-01, Elevation of Privilege).
  app.get('/api/v1/desks/:id/diagnose', { preHandler: requireDeskRolle(db, ['Eigentümer']) }, async () => {
    return baueDiagnose({ db, dataDir, jlBase: jlawyerUrl, convert, backupTaktStunden: backupStunden });
  });

  // ---- Admin-Berechtigungsdiagnose (OPS-03, 14-05) ----
  // Direkt neben der Systemdiagnose-Route registriert (14-PATTERNS.md „Betriebs-/Adminrouten
  // beieinander"), gleiches Gate wie oben: der Fragende erhält Auskunft über die Sicht eines
  // ANDEREN Nutzers — eine privilegien-sensible Fläche (T-14-05-01). Der Handler bleibt kurz
  // und delegiert die gesamte Entscheidungs-/Begründungslogik an berechtigung.ts.
  app.get('/api/v1/desks/:id/berechtigung', { preHandler: requireDeskRolle(db, ['Eigentümer']) }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { userId, objektId } = req.query as { userId?: string; objektId?: string };
    if (typeof userId !== 'string' || userId.trim() === '') {
      return reply.code(400).send({ error: 'Feld "userId" fehlt oder ist leer' });
    }
    if (typeof objektId !== 'string' || objektId.trim() === '') {
      return reply.code(400).send({ error: 'Feld "objektId" fehlt oder ist leer' });
    }
    const fragenderUserId = (req as FastifyRequest & { userId: string }).userId;
    const befund = pruefeBerechtigung(db, id, fragenderUserId, userId, objektId);
    if (!befund.gefunden) {
      return reply.code(404).send({ error: 'Nutzer oder Objekt nicht gefunden' });
    }
    return befund;
  });

  // ---- Jetzt sichern (SAFE-03, 14-06) ----
  // Löst dieselbe rotateBackup()-Routine aus wie der Boot-/Intervall-Lauf (main.ts) — keine
  // zweite Sicherungslogik (must_haves key_links). Schreibender Aufruf, deshalb POST statt GET.
  // In-Flight-Sperre gegen Mehrfachauslösung (backupInFlight oben, T-14-06-03); dasselbe
  // Eigentümer-Gate wie die übrigen Betriebsrouten dieser Nachbarschaft.
  app.post('/api/v1/desks/:id/backup-jetzt', { preHandler: requireDeskRolle(db, ['Eigentümer']) }, async (_req, reply) => {
    if (backupInFlight) {
      return reply.code(409).send({ error: 'Eine Sicherung läuft bereits — bitte kurz warten.' });
    }
    backupInFlight = true;
    try {
      const backupPfad = await rotateBackup(db, dataDir);
      if (!backupPfad) {
        return reply.code(409).send({ error: 'Keine Datenbankdatei zum Sichern gefunden.' });
      }
      return { ok: true, zeitpunkt: statSync(backupPfad).mtime.toISOString() };
    } finally {
      backupInFlight = false;
    }
  });

  // ---- Diagnosepaket-Export (OPS-02/OPS-05, 14-06) ----
  // Support-Bundle als lesbare JSON-Textdatei — die Inhalts-Zusicherung „nie Mandanteninhalte,
  // Dokumente, Passwörter oder Zugangsmerkmale" ist serverseitig in diagnosepaket.ts erzwungen
  // (explizite Feldliste, kein process.env-Zugriff im Modul, T-14-06-01). Dasselbe
  // Eigentümer-Gate wie /diagnose und /berechtigung — das Paket verrät denselben
  // Betriebszustand, nur exportierbar.
  app.get('/api/v1/desks/:id/diagnosepaket', { preHandler: requireDeskRolle(db, ['Eigentümer']) }, async (_req, reply) => {
    const paket = await baueDiagnosepaket({ db, dataDir, jlBase: jlawyerUrl, convert, backupTaktStunden: backupStunden });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    reply.header('content-type', 'application/json');
    reply.header('content-disposition', contentDisposition(`j-desk-diagnosepaket-${stamp}.json`));
    return JSON.stringify(paket, null, 2);
  });

  // ---- Dateien (eigene Ablage nur im Standalone-Modus; im j-lawyer-Modus liefert
  //      /files/:id den Akteninhalt — Route oben — und Uploads gehen in die Akte) ----
  if (!jlawyerUrl) {
    app.post('/api/v1/files', async (req, reply) => {
      // WR-03 (PERM-04): 'upload' ist in der Rechte-Matrix eine gefährliche Aktion — die
      // desk-lose Route kann die Matrix nicht anwenden und knüpft den Upload deshalb
      // mindestens an eine bestehende Rolle an IRGENDEINEM Desk: ein angemeldeter Nutzer
      // ohne jede Mitgliedschaft kann keine 100-MB-Dateien in die Ablage drücken.
      const uploadUserId = (req as FastifyRequest & { userId: string }).userId;
      const hatRolle = db.prepare('SELECT 1 FROM desk_roles WHERE user_id = ? LIMIT 1').get(uploadUserId);
      if (!hatRolle) {
        return reply.code(403).send({ error: 'Datei-Upload erfordert eine Schreibtisch-Mitgliedschaft.' });
      }
      const part = await req.file();
      if (!part) return reply.code(400).send({ error: 'Keine Datei im Request' });
      const bytes = await part.toBuffer();
      try {
        const meta = storeFile(db, dataDir, bytes, part.filename);
        reply.code(201);
        return { fileId: meta.id, kind: meta.kind };
      } catch (e) {
        if (e instanceof FileError) return reply.code(400).send({ error: e.message });
        throw e;
      }
    });

    app.get('/api/v1/files/:id', async (req, reply) => {
      // AR-02-04 (02-SECURITY.md, vormals WR-03) — geschlossen (14-07): die Lese-Routen sind
      // desk-los, deshalb prüft istDateiSichtbarFuer() (dateiSichtbarkeit.ts) vor der Auslieferung,
      // ob mindestens ein für DIESEN NUTZER SICHTBARES Objekt (über alle Schreibtische, auf denen
      // er eine Rolle hat) auf die Dateikennung verweist — dieselbe Nicht-gefunden-Antwort wie bei
      // einer wirklich unbekannten Datei, damit die Antwort selbst keine Existenzauskunft wird.
      const { id } = req.params as { id: string };
      const nutzerId = (req as FastifyRequest & { userId: string }).userId;
      if (!istDateiSichtbarFuer(db, nutzerId, id)) return reply.code(404).send({ error: 'Datei nicht gefunden' });
      const path = getFilePath(db, dataDir, id);
      if (!path) return reply.code(404).send({ error: 'Datei nicht gefunden' });
      reply.header('content-type', 'application/pdf');
      return readFileSync(path);
    });

    /** Vorschau: gleiche Berechtigungslage wie /files/:id (desk-los, geschlossen über
        istDateiSichtbarFuer(), dateiSichtbarkeit.ts, s. AR-02-04-Kommentar dort). cacheKey = fileId:
        eigene Ablage ist inhaltsadressiert/unveränderlich, keine Versionierung nötig. */
    app.get('/api/v1/files/:id/preview', async (req, reply) => {
      const { id } = req.params as { id: string };
      const nutzerId = (req as FastifyRequest & { userId: string }).userId;
      if (!istDateiSichtbarFuer(db, nutzerId, id)) return reply.code(404).send({ error: 'Datei nicht gefunden' });
      const meta = getFileMeta(db, id);
      if (!meta) return reply.code(404).send({ error: 'Datei nicht gefunden' });
      if (meta.kind === 'image' || meta.kind === 'other') {
        return reply.code(404).send({ error: 'Keine Vorschau für diese Datei-Art' });
      }
      if (meta.kind === 'pdf') {
        const path = getFilePath(db, dataDir, id)!;
        reply.header('content-type', 'application/pdf');
        return readFileSync(path);
      }
      return respondConvertiblePreview(reply, id, id, meta.originalName);
    });

    /** Fundstellen-Metadaten für „Sprung zur Quelle" (Hash + Name + Art der Quelldatei) — gleiche
        Berechtigungslage wie /files/:id (desk-los, geschlossen über istDateiSichtbarFuer(),
        dateiSichtbarkeit.ts, s. AR-02-04-Kommentar dort). */
    app.get('/api/v1/files/:id/meta', async (req, reply) => {
      const { id } = req.params as { id: string };
      const nutzerId = (req as FastifyRequest & { userId: string }).userId;
      if (!istDateiSichtbarFuer(db, nutzerId, id)) return reply.code(404).send({ error: 'Datei nicht gefunden' });
      const meta = getFileMeta(db, id);
      if (!meta) return reply.code(404).send({ error: 'Datei nicht gefunden' });
      return { id: meta.id, name: meta.originalName, kind: meta.kind, sha256: meta.sha256 };
    });
  } else {
    app.post('/api/v1/files', async (_req, reply) =>
      reply.code(400).send({ error: 'Uploads erfolgen in die Akte (POST /api/v1/cases/:id/documents)' }));
  }

  // ---- Konverter-Quelle (Einmal-Ticket statt Auth, s. Hook-Ausnahme oben) ----
  app.get('/api/v1/convert-source/:ticket', async (req, reply) => {
    const { ticket } = req.params as { ticket: string };
    const payload = fileTickets.consume(ticket);
    if (!payload) return reply.code(404).send({ error: 'Ticket ungültig oder abgelaufen' });
    // Kein content-type-Rätselraten hier — der DocumentServer sniffed selbst.
    reply.header('content-type', 'application/octet-stream');
    if (payload.jl) {
      // j-lawyer-Modus: die Quelle ist der Akteninhalt, nicht eine lokal abgelegte Datei.
      const { docId, username, password } = payload.jl;
      try {
        return await getDocumentContent(jlawyerUrl!, username, password, docId);
      } catch (e) {
        if (e instanceof JLawyerError) return reply.code(e.status).send({ error: e.message });
        throw e;
      }
    }
    const path = getFilePath(db, dataDir, payload.fileId);
    if (!path) return reply.code(404).send({ error: 'Datei nicht gefunden' });
    return readFileSync(path);
  });

  // ---- WebSocket ----
  app.post('/api/v1/ws-ticket', async (req) => ({
    ticket: wsTickets.issue((req as FastifyRequest & { userId: string }).userId),
  }));

  // PERM-05/T-02-02 (Pfad 5, WS-Connect): der Ticket-Check im onRequest-Hook oben beweist nur
  // eine gültige Session — NICHT, dass dieser Nutzer irgendeine Rolle für DIESEN Desk hat. Ohne
  // diese Prüfung würde jeder angemeldete Nutzer jeden Desk-Room live mithören können.
  app.get('/api/v1/desks/:id/ws', { websocket: true }, (socket, req) => {
    const { id } = req.params as { id: string };
    const userId = (req as FastifyRequest & { userId: string }).userId;
    const rolle = getRolleForNutzer(db, id, userId);
    if (!rolle) {
      // 4003: anwendungsdefinierter Close-Code (Bereich 4000-4999 laut RFC 6455) — analog zum
      // TP3-Vorbild derselben Codebasis. Kein register(): der Socket landet nie in der Registry.
      socket.close(4003, 'Kein Zugriff auf diesen Schreibtisch.');
      return;
    }
    register(id, socket, userId, rolle);
    const anzeigename = actorFromRequest(db, req).name;
    registerPresence(id, socket, userId, anzeigename, rolle);
    sendePraesenz(id, getDeskState(db, id)?.state);
    socket.on('close', () => {
      unregister(id, socket);
      unregisterPresence(id, socket);
      sendePraesenz(id, getDeskState(db, id)?.state);
    });
    // T-06-02 (Tampering): striktes Whitelist-Format — ausschließlich die zwei bekannten
    // `typ`-Werte werden verarbeitet, jeder Parse-Fehler und jeder andere Wert führt zu einem
    // wirkungslosen, kommentarlosen `return`. Dieser Rückkanal ruft nie applyDeskCommand/die
    // Datenbank auf (K7) — er kann den dauerhaften Zustand also strukturell nicht erreichen.
    socket.on('message', (roh) => {
      let data: unknown;
      try {
        data = JSON.parse(roh.toString());
      } catch {
        return;
      }
      if (!data || typeof data !== 'object') return;
      const { typ } = data as { typ?: unknown };
      if (typ === 'bearbeitet') {
        const { objektId } = data as { objektId?: unknown };
        if (typeof objektId !== 'string') return;
        setzeBearbeitung(id, socket, objektId);
        sendePraesenz(id, getDeskState(db, id)?.state);
        return;
      }
      if (typ === 'ruht') {
        loeseBearbeitung(id, socket);
        sendePraesenz(id, getDeskState(db, id)?.state);
        return;
      }
    });
  });

  return app;
}
