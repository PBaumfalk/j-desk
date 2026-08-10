import type { Command, DesktopState, Erwartet, FileKind, JournalEintragDto, Konflikt, Rolle } from '@j-desk/core';
import { KonfliktAntwort } from './konflikt';

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly konflikt?: Konflikt) {
    super(message);
  }
}

export interface DeskInfo {
  id: string;
  name: string;
  ownerId: string;
}

/** Öffentliche Sicht einer Mandatsvorlage (TMPL-01, 13-07) — id/name/beschreibung + konkrete
 *  Inhalts-Aufzählung (Zonen-Namen, Hinweis-Texte) für die VorlagenDialog-Vorschau; wortgleich
 *  zur Server-Sicht (packages/server/src/vorlagen.ts VorlagenUebersicht). */
export interface VorlagenUebersicht {
  id: string;
  name: string;
  beschreibung: string;
  zonen: string[];
  hinweise: string[];
}

/** Ein Mitglied eines Desks samt Rolle (Teilen-Dialog, PERM-03) — Eigentümer zuerst (Server-Reihenfolge). */
export interface Mitglied {
  userId: string;
  username: string;
  rolle: Rolle;
}

export interface DeskState {
  rev: number;
  state: DesktopState;
  /** Nur im j-lawyer-Modus: j-lawyer war beim Abgleich nicht erreichbar — Stand vom letzten Abgleich. */
  syncFehler?: string;
  /** 02-07 (PERM-02): eigene Rolle am Desk — im Standalone-Modus über GET /state, seit
   *  WR-04 auch im j-lawyer-Modus (GET /cases/:id/desk, POST /cases/:id/documents und der
   *  Ausfall-Fallback liefern die serverseitig ermittelte desk_roles-Rolle mit). Fehlt das
   *  Feld (z. B. jl-Fallback für eine Akte ohne desk_roles-Zeile), gilt die Rolle als
   *  unbekannt — `null` ist das dokumentierte fail-open-Bestandsverhalten. */
  rolle?: Rolle;
}

/**
 * Ein serverseitig gefundener und sichtbarkeitsgefilterter Suchtreffer (SEARCH-01/SEARCH-04,
 * 07-01). Endform für die gesamte Phase 7 — spätere Pläne (07-02…07-06) füllen zusätzliche
 * `art`-Werte/Felder, ändern diese Form aber nicht (07-01-PLAN.md „Vertrag für 07-02/03/04/06").
 */
export interface SucheTreffer {
  id: string;
  // WR-03 (09-REVIEW.md): 'Zeitleiste' ergänzt — Gegenstück zu TrefferArt in
  // packages/server/src/search/searchQuery.ts, sonst würde die server-seitige Art hier nicht
  // typkonform ankommen.
  art: 'Karte' | 'Stapel' | 'Zettel' | 'Verknüpfung' | 'Markierung' | 'Stempel' | 'Ausschnitt' | 'PDF-Text' | 'OCR' | 'Zeitleiste';
  objId?: string;
  fileId?: string;
  docId?: string;
  page?: number;
  label: string;
  snippet?: string;
  ersteller?: string;
  datum?: string;
  ocrUnsicher?: boolean;
  rang: number;
}

/** Text einer einzelnen Seite über den Rückfallweg für eingescannte Fassungen (COMP-01/02,
 *  09-08). Keine Wortkoordinaten — `quelle` benennt nur, ob der Text eingebettet vorlag oder
 *  erkannt wurde. */
export interface FileTextSeite {
  seite: number;
  text: string;
  quelle: 'pdf-text' | 'ocr';
}

/** Kennung einer der drei kanonischen juristischen Abfragen (LEGAL-03, 08-05). */
export type LegalQueryKind =
  | 'facts-without-evidence'
  | 'opposing-claims-without-rebuttal'
  | 'evidence-supporting-multiple-facts';

/** Ein Treffer einer juristischen Abfrage — dieselbe Zeilenform wie SucheTreffer (server:
 *  packages/server/src/legalQueries.ts LegalQueryTreffer), hier client-seitig gespiegelt. */
export interface LegalQueryTreffer {
  objektId: string;
  art: string;
  label: string;
  ersteller?: string;
  datum?: string;
}

/** Vier Zustände einer Diagnose-Zeile — Serverspiegel von `DiagnoseStatus`
 *  (packages/server/src/diagnose.ts), identisch zu den vier UI-SPEC-Statusfarben
 *  (`.status-badge`-Palette, DocCard.svelte). */
export type DiagnoseStatus = 'ok' | 'warnung' | 'fehler' | 'nicht-konfiguriert';

/** Eine Zeile im Systemdiagnose-Overlay (OPS-02, 14-01/14-06) — Serverspiegel von
 *  `DiagnoseZeile` (packages/server/src/diagnose.ts). `bytes`/`anzahl`/`zeitpunkt`/`errechnet`
 *  sind rohe Werte (SPEICHER-/BACKUP-Abschnitt, 14-06) — der Client formatiert sie lesbar
 *  (KB/MB/GB, deutsches Datumsformat), damit die Formatierungslogik nicht doppelt
 *  (Server+Client) gepflegt werden muss. */
export interface DiagnoseZeile {
  status: DiagnoseStatus;
  label: string;
  wert?: string;
  ursache?: string;
  empfehlung?: string;
  bytes?: number;
  anzahl?: number;
  zeitpunkt?: string;
  errechnet?: boolean;
}

/** Systemdiagnose-Bericht (OPS-02, 14-01/14-06) — Serverspiegel von `DiagnoseBericht`
 *  (packages/server/src/diagnose.ts). */
export interface DiagnoseBericht {
  system: DiagnoseZeile[];
  verbindungen: DiagnoseZeile[];
  speicher: DiagnoseZeile[];
  backup: DiagnoseZeile[];
}

/** Ein Begründungspunkt der Admin-Berechtigungsdiagnose (OPS-03, 14-05) — Serverspiegel von
 *  `BerechtigungsGrund` (packages/server/src/berechtigung.ts). `art` ist rein maschinenlesbar
 *  (künftige clientseitige Sonderfälle); `text` ist bereits fertig deutsch und wird unverändert
 *  angezeigt. */
export interface BerechtigungsGrund {
  art: 'ebene-privat-fremd' | 'rolle-gast-intern' | 'ebene-sichtbar' | 'rolle-erlaubt';
  text: string;
}

/** Ergebnis der Admin-Berechtigungsdiagnose (OPS-03, 14-05) — Serverspiegel von
 *  `BerechtigungsBefund` (packages/server/src/berechtigung.ts). Ein 404 (Nutzer/Objekt nicht
 *  gefunden ODER das Objekt ist für den fragenden Eigentümer selbst nicht sichtbar — bewusst
 *  ununterscheidbar, Informationssparsamkeit T-14-05-02) landet als `ApiError` im Fehlerpfad
 *  des Dialogs, nicht in dieser Form. */
export interface BerechtigungsBefund {
  gefunden: true;
  sichtbar: boolean;
  gruende: BerechtigungsGrund[];
  nutzerName: string;
  nutzerRolle: Rolle;
  objektName: string;
  objektArt: string;
}

/** KI-Vorschlag aus der projizierten GET-Liste (AI-01, Phase 12: 12-03 Server / 12-06 Client) —
 *  exakt die öffentlichen Felder der Server-Route (`oeffentlicheFelder` in
 *  packages/server/src/proposals.ts); `inverse`/`genehmigte_objekte` sind Entscheidungs-Interna
 *  und kommen hier strukturell nie an (T-12-03-06). */
export interface VorschlagDto {
  id: string;
  art: string;
  payload: Record<string, unknown>;
  quellen: { dokumentId: string; seite: number; zitat: string }[];
  zusammenfassung: string;
  status: 'ausstehend' | 'genehmigt' | 'abgelehnt' | 'zurückgenommen';
  createdBy: string;
  createdAt: number;
  decidedBy?: string;
  decidedAt?: number;
}

/** Inbox-Zeile (NOTIF-01, 13-01/13-04): exakt die Felder der user-scoped Server-Route
 *  (packages/server/src/benachrichtigungen.ts); `payload` ist art-spezifisch:
 *  - 'erwaehnung': notizId/notizTitel/vonName/textStand (notizTitel serverseitig auf 60
 *    Zeichen gekappt, Andeutungs-Bremse)
 *  - 'aufgabe': aufgabeId/titel/variante ('zuweisung'|'status')/vonName/faellig?/status?
 *  - 'geteilt': deskId/deskName/rolle/vonName
 *  - 'ersetzt'/'quelle': dokumentId/dokumentName */
export interface BenachrichtigungDto {
  id: string;
  user_id: string;
  desk_id: string | null;
  art: string;
  payload: {
    notizId?: string; notizTitel?: string; vonName?: string; textStand?: string;
    aufgabeId?: string; titel?: string; variante?: 'zuweisung' | 'status'; faellig?: string; status?: string;
    deskId?: string; deskName?: string; rolle?: string;
    dokumentId?: string; dokumentName?: string;
  };
  created_at: number;
  read_at: number | null;
}

/** Prüfergebnis der Anlagenpaket-Prüfroute (KONV-03, 10-04 packages/server/src/export/anlagenpaket.ts
 *  AnlagenpaketPruefung), hier client-seitig gespiegelt — ausschließlich Positionen und Zahlen,
 *  keine Namen: Bezeichnungen für die Anzeige kommen ausschließlich aus dem Zustand des Clients. */
export interface AnlagenpaketPruefung {
  dubletten: { docId: string; lokaleSeite: number; gleichWieDocId: string; gleichWieLokaleSeite: number }[];
  leerseiten: { docId: string; lokaleSeite: number }[];
  unbeurteilbar: { docId: string; lokaleSeite: number }[];
  seitenGesamt: number;
  ausgelassen: number;
}

export class ApiClient {
  constructor(public baseUrl = '', public token: string | null = null) {}

  private authHeaders(): Record<string, string> {
    return this.token ? { authorization: `Bearer ${this.token}` } : {};
  }

  private async parseError(res: Response): Promise<ApiError> {
    let message = `HTTP ${res.status}`;
    let konflikt: Konflikt | undefined;
    try {
      const body = (await res.json()) as { error?: string; konflikt?: Konflikt };
      message = body.error ?? message;
      if (res.status === 409) konflikt = body.konflikt;
    } catch {
      // kein JSON-Body — Statuscode reicht
    }
    return new ApiError(message, res.status, konflikt);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}/api/v1${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...this.authHeaders(),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw await this.parseError(res);
    return (await res.json()) as T;
  }

  /**
   * REF-03 (WR-03): `jlVersion` ist nur gesetzt, wenn der Server im j-lawyer-Modus läuft UND
   * ein gültiger Token mitgeschickt wurde, für den bereits j-lawyer-Zugangsdaten vorliegen
   * (gesetzt beim ursprünglichen Login) — ermöglicht die Versionsprüfung auch bei
   * Session-Wiederherstellung (Reload), ohne erneuten Login zu erzwingen.
   */
  status(): Promise<{
    needsSetup: boolean;
    needsModeChoice: boolean;
    mode?: 'standalone' | 'jlawyer';
    jlVersion?: 'kompatibel' | 'inkompatibel' | 'unbestimmt';
  }> {
    return this.request('GET', '/auth/status');
  }

  /** Setup: j-lawyer-Erreichbarkeit prüfen (nur vor der Ersteinrichtung erlaubt). */
  setupJlawyerTest(url: string): Promise<{ ok: boolean; message: string }> {
    return this.request('POST', '/setup/jlawyer-test', { url });
  }

  /** Setup: j-lawyer-Modus speichern; der Server baut sich danach intern neu auf. */
  async setupJlawyer(url: string): Promise<void> {
    await this.request('POST', '/setup/jlawyer', { url });
  }

  async setup(username: string, password: string): Promise<void> {
    const r = await this.request<{ token: string }>('POST', '/auth/setup', { username, password });
    this.token = r.token;
  }

  /**
   * REF-03: `jlVersion` ist nur im j-lawyer-Modus gesetzt (tri-state, server-ermittelt gegen die
   * getestete API-Ebene) — Standalone-Antworten tragen das Feld nicht. `undefined` heißt hier
   * "kein j-lawyer-Modus", nicht "unbestimmt" (das ist der server-seitige Ermittlungs-Fehlerfall).
   */
  async login(username: string, password: string): Promise<'kompatibel' | 'inkompatibel' | 'unbestimmt' | undefined> {
    const r = await this.request<{ token: string; jlVersion?: 'kompatibel' | 'inkompatibel' | 'unbestimmt' }>(
      'POST', '/auth/login', { username, password },
    );
    this.token = r.token;
    return r.jlVersion;
  }

  async logout(): Promise<void> {
    await this.request('POST', '/auth/logout').finally(() => (this.token = null));
  }

  listDesks(): Promise<DeskInfo[]> {
    return this.request('GET', '/desks');
  }

  /** `vorlageId` optional (TMPL-01, 13-07): ohne das Feld bleibt die Anlage byte-identisch zum
   *  Bestand — der Server baut den Start-State nur bei gesetzter vorlageId aus einer Vorlage. */
  createDesk(name: string, vorlageId?: string): Promise<DeskInfo> {
    return this.request('POST', '/desks', vorlageId !== undefined ? { name, vorlageId } : { name });
  }

  /** TMPL-01 (13-07): die drei kuratierten Mandatsvorlagen — desk-los, kein Ladepfad im Dialog
   *  (E11/loading: einmal beim Öffnen geholt, danach synchron aus dem lokalen State). */
  async listVorlagen(): Promise<VorlagenUebersicht[]> {
    const r = await this.request<{ vorlagen: VorlagenUebersicht[] }>('GET', '/vorlagen');
    return r.vorlagen;
  }

  renameDesk(deskId: string, name: string): Promise<{ ok: boolean }> {
    return this.request('PATCH', `/desks/${deskId}`, { name });
  }

  deleteDesk(deskId: string): Promise<{ ok: boolean }> {
    return this.request('DELETE', `/desks/${deskId}`);
  }

  getState(deskId: string): Promise<DeskState> {
    return this.request('GET', `/desks/${deskId}/state`);
  }

  /** OCR-Qualitäts-Chip (SEARCH-03, 07-08) — sichtbarkeitsgefilterte fileId-Liste unsicherer Erkennungen. */
  ocrStatus(deskId: string): Promise<{ unsicher: string[] }> {
    return this.request('GET', `/desks/${deskId}/ocr`);
  }

  /** Rückfallweg für eingescannte Fassungen im Vergleichsviewer (COMP-01/02, 09-08) —
   *  sichtbarkeitsgefilterter Text je Seite, ohne Wortkoordinaten. Wirft bei Ablehnung (nicht
   *  sichtbar oder nicht existent) einen `ApiError` mit dem Statuscode, wie jede andere Methode. */
  fetchFileText(deskId: string, fileId: string): Promise<{ seiten: FileTextSeite[]; stand: string }> {
    return this.request('GET', `/desks/${encodeURIComponent(deskId)}/file-text/${encodeURIComponent(fileId)}`);
  }

  /** Servergestützte Volltextsuche (SEARCH-01/SEARCH-04, 07-01) — POST statt GET, s. app.ts. */
  suche(deskId: string, q: string): Promise<{ treffer: SucheTreffer[] }> {
    return this.request('POST', `/desks/${encodeURIComponent(deskId)}/search`, { q });
  }

  /** Juristische Auswertung (LEGAL-03, 08-05) — eine der drei kanonischen Abfragen über den
   *  serverseitig projizierten Zustand, s. app.ts. */
  legalQuery(deskId: string, query: LegalQueryKind): Promise<{ treffer: LegalQueryTreffer[] }> {
    return this.request('POST', `/desks/${encodeURIComponent(deskId)}/legal-queries`, { query });
  }

  /**
   * TASK-02 (08-08): Aufgabe an j-lawyer übergeben (Wiedervorlage anlegen). Der Statuswechsel
   * (`status: 'uebergeben'` + Übergabe-Provenienz) kommt über den WebSocket-Broadcast des
   * serverseitig angewendeten `markTaskHandedOver`-Commands zurück, GENAU wie bei jedem anderen
   * Command — der Aufrufer darf den Rückgabewert dieser Methode nicht selbst in `desktop.state`
   * schreiben (kein optimistischer Statuswechsel vor der Serverbestätigung).
   */
  uebergebeAufgabe(deskId: string, taskId: string): Promise<{ rev: number; state: DesktopState; jlDueDateId: string }> {
    return this.request('POST', `/desks/${encodeURIComponent(deskId)}/tasks/${encodeURIComponent(taskId)}/handover`);
  }

  async sendCommand(deskId: string, cmd: Command & { erwartet?: Erwartet }): Promise<DeskState> {
    try {
      return await this.request('POST', `/desks/${deskId}/commands`, cmd);
    } catch (e) {
      // 409 ist kein Fehlschlag im üblichen Sinn: Der Aufrufer entscheidet, ob er still
      // neu aufsetzt oder fragt. Deshalb eine eigene Fehlerklasse statt einer Meldung.
      const konflikt = konfliktAus(e);
      if (konflikt) throw new KonfliktAntwort(konflikt);
      throw e;
    }
  }

  putState(deskId: string, state: DesktopState): Promise<DeskState> {
    return this.request('PUT', `/desks/${deskId}/state`, state);
  }

  /** Historie eines Schreibtischs, neueste zuerst; `before` blättert über die Eintrags-id weiter. */
  listJournal(
    deskId: string,
    opts?: { limit?: number; before?: number },
  ): Promise<{ entries: JournalEintragDto[] }> {
    const q = new URLSearchParams();
    if (opts?.limit !== undefined) q.set('limit', String(opts.limit));
    if (opts?.before !== undefined) q.set('before', String(opts.before));
    const suffix = q.toString() === '' ? '' : `?${q}`;
    return this.request('GET', `/desks/${encodeURIComponent(deskId)}/journal${suffix}`);
  }

  /** Stellt den Schreibtisch auf den Stand der Journal-Zeile `toEntryId` zurück (HIST-02). */
  restoreDesk(deskId: string, toEntryId: number): Promise<{ ok: boolean; rev: number }> {
    return this.request('POST', `/desks/${encodeURIComponent(deskId)}/restore`, { toEntryId });
  }

  // ---- KI-Freigaben (AI-01, Phase 12) ----
  // Fehler bleiben als ApiError mit Status unterscheidbar (403 Genehmigungs-Guard, 409
  // zwischenzeitlich entschieden, 500 Serverfehler) — der Aufrufer (freigaben.ts, Dialog
  // aus Plan 12-07) entscheidet anhand des Status, keine clientseitige Vorab-Zuordnung.

  /** Projizierte Vorschlagsliste (12-03): der Server filtert jeden Vorschlag mit unsichtbarer
   *  Referenz KOMPLETT heraus (PERM-05) — der Client konsumiert nur, was ankommt; es gibt
   *  keinen Zählerstand „irgendwo wartet etwas Unsichtbares" (Andeutungs-Verbot). */
  listVorschlaege(deskId: string): Promise<{ vorschlaege: VorschlagDto[] }> {
    return this.request('GET', `/desks/${encodeURIComponent(deskId)}/vorschlaege`);
  }

  /** Genehmigung (AI-01): wirkt ausschließlich über den serverseitigen Bestandspfad
   *  (applyDeskCommand, Journal, Broadcast) — der Client triggert nur. */
  genehmigeVorschlag(deskId: string, vorschlagId: string): Promise<{ ok: boolean; rev: number }> {
    return this.request('POST', `/desks/${encodeURIComponent(deskId)}/vorschlaege/${encodeURIComponent(vorschlagId)}/genehmigen`);
  }

  /** Ablehnung (AI-01): reine Register-Entscheidung ohne Desk-Wirkung. */
  lehneVorschlagAb(deskId: string, vorschlagId: string): Promise<{ ok: boolean }> {
    return this.request('POST', `/desks/${encodeURIComponent(deskId)}/vorschlaege/${encodeURIComponent(vorschlagId)}/ablehnen`);
  }

  /** Rücknahme einer bereits genehmigten KI-Übernahme (AI-02, Route aus Plan 12-04). */
  nimmVorschlagZurueck(deskId: string, vorschlagId: string): Promise<{ ok: boolean; rev: number }> {
    return this.request('POST', `/desks/${encodeURIComponent(deskId)}/vorschlaege/${encodeURIComponent(vorschlagId)}/zuruecknehmen`);
  }

  // ---- Benachrichtigungen (NOTIF-01, Phase 13) ----
  // User-scoped Routen OHNE deskId-Pfadsegment: der Server erzwingt die Nutzerhoheit
  // (WHERE user_id = req.userId, T-13-01-03) — der Client konsumiert ausschließlich die
  // eigene Liste; Fehler bleiben als ApiError mit Status unterscheidbar (404 bei fremder
  // Zeilen-id, fail-closed ohne Existenz-Auskunft).

  /** Eigene Inbox (13-01): neueste zuerst, serverseitig auf 200 Zeilen begrenzt. */
  listBenachrichtigungen(): Promise<{ benachrichtigungen: BenachrichtigungDto[] }> {
    return this.request('GET', '/benachrichtigungen');
  }

  /** Einzelne eigene Zeile als gelesen markieren (404 bei fremder/unbekannter id). */
  markiereBenachrichtigungGelesen(id: string): Promise<{ ok: boolean }> {
    return this.request('POST', `/benachrichtigungen/${encodeURIComponent(id)}/gelesen`);
  }

  /** Alle eigenen Zeilen als gelesen markieren — zustandsbezogen, online-only (kein
   *  Offline-Queue-Nachspielen, Anti-Pattern aus 13-RESEARCH). */
  markiereAlleBenachrichtigungenGelesen(): Promise<{ ok: boolean }> {
    return this.request('POST', '/benachrichtigungen/alle-gelesen');
  }

  async exportDesk(deskId: string): Promise<Blob> {
    const res = await fetch(`${this.baseUrl}/api/v1/desks/${encodeURIComponent(deskId)}/export`, {
      headers: this.authHeaders(),
    });
    if (!res.ok) throw await this.parseError(res);
    return res.blob();
  }

  /**
   * PDF-Übergabeformat (D-02/D-12/D-13, 03-10): reiner Download — die Erzeugung läuft
   * ausschließlich serverseitig hinter requireDeskAktion('export'); `format` ist der
   * Formatname (aufgaben/snapshot/argumentation/beweismittel/dokument/fundstellen).
   * `docId` ist bei 'dokument' Pflicht (Umfang: genau ein Dokument); `ids` ist bei
   * 'fundstellen' die optionale Umfang-Auswahl (kommagetrennt, serverseitig validiert) —
   * fehlt `ids`, liefert die Route alle freigegebenen Fundstellen.
   */
  async exportPdf(deskId: string, format: string, opts?: { docId?: string; ids?: string[] }): Promise<Blob> {
    const pfad = format === 'dokument' ? `dokument/${encodeURIComponent(opts?.docId ?? '')}` : format;
    const q = new URLSearchParams();
    if (format === 'fundstellen' && opts?.ids && opts.ids.length > 0) q.set('ids', opts.ids.join(','));
    const suffix = q.toString() === '' ? '' : `?${q}`;
    const res = await fetch(`${this.baseUrl}/api/v1/desks/${encodeURIComponent(deskId)}/export/pdf/${pfad}${suffix}`, {
      headers: this.authHeaders(),
    });
    if (!res.ok) throw await this.parseError(res);
    return res.blob();
  }

  /** Freigabe-Statistik vor der Erzeugung (D-12, 03-10): Server zählt auf dem projizierten,
   *  NICHT freigabe-gefilterten State (alle drei Stufen) — Antwort ist ausschließlich Zahlen.
   *  `format`/`docId` schränken die Kandidatenmenge deckungsgleich zum jeweiligen Artefakt ein. */
  exportStatistik(
    deskId: string,
    format?: string,
    docId?: string,
  ): Promise<{ export: number; mandant: number; intern: number }> {
    const q = new URLSearchParams();
    if (format !== undefined && format !== '') q.set('format', format);
    if (docId !== undefined && docId !== '') q.set('docId', docId);
    const suffix = q.toString() === '' ? '' : `?${q}`;
    return this.request('GET', `/desks/${encodeURIComponent(deskId)}/export/statistik${suffix}`);
  }

  /**
   * Anlagenpaket-Erzeugung (KONV-01, 10-01): dieselbe Sicherheitskette wie exportPdf, aber POST
   * mit JSON-Körper statt GET/Query-String — Reihenfolge, Bezeichnungen und ausgeschlossene
   * Seiten passen nicht in eine Abfragezeichenkette. Die Erzeugung läuft ausschließlich
   * serverseitig; der Client löst nur aus und lädt herunter (D-13).
   */
  async anlagenpaketErzeugen(
    deskId: string,
    wunsch: { deckblattTitel: string; eintraege: { docId: string; bezeichnung: string }[]; ausgeschlosseneSeiten?: { docId: string; seite: number }[] },
  ): Promise<{ blob: Blob; ausgelassen: number }> {
    const res = await fetch(`${this.baseUrl}/api/v1/desks/${encodeURIComponent(deskId)}/export/pdf/anlagenpaket`, {
      method: 'POST',
      headers: { ...this.authHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify(wunsch),
    });
    if (!res.ok) throw await this.parseError(res);
    return { blob: await res.blob(), ausgelassen: Number(res.headers.get('x-anlagenpaket-ausgelassen') ?? 0) };
  }

  /** Ergebnis der Dubletten-/Leerseiten-Prüfung (KONV-03, 10-04): ausschließlich Positionen und
   *  Zahlen, kein Seitentext, kein Dokumentname — dieselben Feldnamen wie die Serverantwort. */
  anlagenpaketPruefung(
    deskId: string,
    wunsch: { deckblattTitel: string; eintraege: { docId: string; bezeichnung: string }[] },
  ): Promise<AnlagenpaketPruefung> {
    return this.request('POST', `/desks/${encodeURIComponent(deskId)}/export/anlagenpaket/pruefung`, wunsch);
  }

  async importDesk(deskId: string, datei: File): Promise<void> {
    const form = new FormData();
    form.append('file', datei);
    const res = await fetch(`${this.baseUrl}/api/v1/desks/${encodeURIComponent(deskId)}/import`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: form,
    });
    if (!res.ok) throw await this.parseError(res);
  }

  async uploadFile(bytes: Uint8Array, name: string, mime = 'application/pdf'): Promise<{ fileId: string; kind: FileKind }> {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: mime }), name);
    const res = await fetch(`${this.baseUrl}/api/v1/files`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: form,
    });
    if (!res.ok) throw await this.parseError(res);
    return (await res.json()) as { fileId: string; kind: FileKind };
  }

  /**
   * Anymize-Transkription (VOICE-01, 14-09): Verfügbarkeit prüfen — wahr genau dann, wenn der
   * Server eine Konfiguration trägt (packages/server/src/transkription.ts). Ohne konfigurierten
   * Schlüssel bleibt der Diktat-Einstieg an allen drei Komponenten unsichtbar (fail-quiet, wie
   * zuvor bei fehlender Browser-Spracherkennung).
   */
  async transkriptionVerfuegbar(): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/api/v1/transkription`, { headers: this.authHeaders() });
    if (!res.ok) return false;
    return ((await res.json()) as { verfuegbar: boolean }).verfuegbar === true;
  }

  /**
   * Anymize-Transkription (VOICE-01, 14-09): Aufnahme hochladen, serverseitig auf den fertigen
   * Text warten (multipart, Form wie uploadFile()) — weder Anymize-Schlüssel noch Job-Kennung
   * verlassen je den Server.
   */
  async transkribiere(bytes: Uint8Array, mime: string): Promise<string> {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: mime }), 'diktat');
    const res = await fetch(`${this.baseUrl}/api/v1/transkription`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: form,
    });
    if (!res.ok) throw await this.parseError(res);
    return ((await res.json()) as { text: string }).text;
  }

  // ---- j-lawyer-Modus ----
  getCases(): Promise<{ id: string; fileNumber: string; name: string; reason: string }[]> {
    return this.request('GET', '/cases');
  }

  /** Akten-Schreibtisch öffnen — der Server gleicht mit j-lawyer ab. */
  getCaseDesk(caseId: string): Promise<DeskState> {
    return this.request('GET', `/cases/${caseId}/desk`);
  }

  /**
   * Text-Ablage (EXT-01, 13-06): Urteil/Norm/Textfragment mit Ablage-Wahl „In j-lawyer
   * ablegen" — der Server synthetisiert ein PDF und legt es erst nach j-lawyer-Bestätigung
   * als echte Doc-Karte an (kein extern-Feld). JSON-POST-Form wie restoreDesk/suche; die
   * Antwort ist bereits für den anfragenden Actor projiziert (Upload-Antwort-Muster).
   */
  aufnehmenTextAblage(
    caseId: string,
    body: { art: 'urteil' | 'norm' | 'textfragment'; felder: Record<string, string | undefined>; name?: string },
  ): Promise<DeskState> {
    return this.request('POST', `/cases/${encodeURIComponent(caseId)}/aufnahme`, body);
  }

  /** Upload in die Akte; die Karte legt der Server erst nach j-lawyer-Bestätigung an. */
  async uploadToCase(caseId: string, bytes: Uint8Array, name: string): Promise<DeskState> {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'application/pdf' }), name);
    const res = await fetch(`${this.baseUrl}/api/v1/cases/${caseId}/documents`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: form,
    });
    if (!res.ok) throw await this.parseError(res);
    return (await res.json()) as DeskState;
  }

  async fetchFile(fileId: string): Promise<Uint8Array> {
    const res = await fetch(`${this.baseUrl}/api/v1/files/${fileId}`, { headers: this.authHeaders() });
    if (!res.ok) throw await this.parseError(res);
    return new Uint8Array(await res.arrayBuffer());
  }

  /**
   * Vorschau einer Datei: 200 = fertige PDF-Bytes, 202 = Konvertierung läuft noch,
   * 409 = Konvertierung (endgültig oder vorerst) fehlgeschlagen. Andere Fehler (u. a. 404)
   * werfen wie gehabt einen ApiError.
   */
  async fetchPreview(
    fileId: string,
  ): Promise<{ status: 'ready'; bytes: Uint8Array } | { status: 'converting' } | { status: 'error'; message: string }> {
    const res = await fetch(`${this.baseUrl}/api/v1/files/${fileId}/preview`, { headers: this.authHeaders() });
    if (res.status === 202) return { status: 'converting' };
    if (res.status === 409) {
      let message = `HTTP ${res.status}`;
      try {
        message = ((await res.json()) as { error?: string }).error ?? message;
      } catch {
        // kein JSON-Body — Statuscode reicht
      }
      return { status: 'error', message };
    }
    if (!res.ok) throw await this.parseError(res);
    return { status: 'ready', bytes: new Uint8Array(await res.arrayBuffer()) };
  }

  /** Sprung zur Quelle: Metadaten der Quelldatei (404, wenn sie nicht mehr existiert). */
  fileMeta(fileId: string): Promise<{ id: string; name: string; kind: FileKind; sha256: string | null }> {
    return this.request('GET', `/files/${fileId}/meta`);
  }

  /** Kurzlebiges Einmal-Ticket für den WebSocket-Verbindungsaufbau. */
  wsTicket(): Promise<{ ticket: string }> {
    return this.request('POST', '/ws-ticket');
  }

  // ---- Mitglieder/Rollenvergabe (Teilen-Dialog, PERM-03/PERM-04, 02-08 Task 1) ----
  // Bewusst NUR Rollenvergabe für bereits existierende Nutzer — kein Einladungscode-/
  // Konto-Erstellungs-Flow (Research Open Question 1, explizit out of scope). Der Eigentümer
  // selbst ist in listMembers() enthalten, aber über setMemberRolle/removeMember serverseitig
  // schreibgeschützt (02-04).

  listMembers(deskId: string): Promise<Mitglied[]> {
    return this.request('GET', `/desks/${deskId}/members`);
  }

  addMember(deskId: string, username: string, rolle: Rolle): Promise<{ ok: boolean }> {
    return this.request('POST', `/desks/${deskId}/members`, { username, rolle });
  }

  setMemberRolle(deskId: string, userId: string, rolle: Rolle): Promise<{ ok: boolean }> {
    return this.request('PUT', `/desks/${deskId}/members/${userId}`, { rolle });
  }

  removeMember(deskId: string, userId: string): Promise<{ ok: boolean }> {
    return this.request('DELETE', `/desks/${deskId}/members/${userId}`);
  }

  /** Systemdiagnose (OPS-02, 14-01): Eigentümer-only, serverseitig über
   *  requireDeskRolle(['Eigentümer']) gegated — das Ausblenden des Toolbar-Buttons ist Komfort. */
  getDiagnose(deskId: string): Promise<DiagnoseBericht> {
    return this.request('GET', `/desks/${deskId}/diagnose`);
  }

  /** „Jetzt sichern" (SAFE-03, 14-06): löst die bestehende Sicherungsroutine sofort aus —
   *  Eigentümer-only, serverseitig gegen Mehrfachauslösung gesperrt (409 bei laufendem Lauf). */
  sicherJetzt(deskId: string): Promise<{ ok: boolean; zeitpunkt: string }> {
    return this.request('POST', `/desks/${deskId}/backup-jetzt`);
  }

  /** Diagnosepaket-Export (OPS-02/OPS-05, 14-06): reiner Download, Bestandsmuster wie
   *  exportDesk() — am privaten Anfrage-Helfer vorbei, direkt als Blob. */
  async getDiagnosepaket(deskId: string): Promise<Blob> {
    const res = await fetch(`${this.baseUrl}/api/v1/desks/${encodeURIComponent(deskId)}/diagnosepaket`, {
      headers: this.authHeaders(),
    });
    if (!res.ok) throw await this.parseError(res);
    return res.blob();
  }

  /** Admin-Berechtigungsdiagnose (OPS-03, 14-05): Eigentümer-only, serverseitig über
   *  requireDeskRolle(['Eigentümer']) gegated. Ein 404 (Nutzer/Objekt nicht gefunden ODER für
   *  den fragenden Eigentümer selbst nicht sichtbar) wirft als ApiError — der Aufrufer
   *  behandelt das wie jeden anderen Fehlerpfad des Dialogs. */
  getBerechtigung(deskId: string, userId: string, objektId: string): Promise<BerechtigungsBefund> {
    return this.request(
      'GET',
      `/desks/${deskId}/berechtigung?userId=${encodeURIComponent(userId)}&objektId=${encodeURIComponent(objektId)}`,
    );
  }

  wsUrl(deskId: string, ticket: string): string {
    const base = this.baseUrl || location.origin;
    return `${base.replace(/^http/, 'ws')}/api/v1/desks/${deskId}/ws?ticket=${ticket}`;
  }
}

/** Zieht den Konfliktkörper aus einem 409. Alles andere ergibt undefined und
 *  läuft weiter über den bisherigen Fehlerweg. */
function konfliktAus(e: unknown): Konflikt | undefined {
  return e instanceof ApiError ? e.konflikt : undefined;
}
