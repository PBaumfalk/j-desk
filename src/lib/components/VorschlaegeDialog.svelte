<script lang="ts">
  import { untrack } from 'svelte';
  import { desktop, darfAktionClient } from '../store.svelte';
  import { ui, showToast } from '../ui.svelte';
  import { ApiError, type VorschlagDto } from '../api';
  import {
    aktualisiereNachEntscheidung, freigaben, ladeVorschlaege, zaehler,
  } from '../freigaben.svelte';
  import { referenzstatusVon } from '../referenzstatus';
  import { zeitpunktLang } from '../zeitformat';
  import { loadSession } from '../session';

  /**
   * VorschlaegeDialog (AI-01/AI-03, 12-07): die einzige Entscheidungsfläche der KI-Vertrauens-
   * schicht — die Karte auf dem Tisch (EntwurfKarte) ist nur Vorschau, hier steht der
   * vollständige Prüfinhalt. Struktur wortgleich zur Bestands-Dialogklasse (AnlagenpaketDialog/
   * SitzungsmappeDialog): .hintergrund/.overlay, role="dialog", Fokusfalle, Escape schließt,
   * warOffen-geschützter Öffnen-Effekt, Glas-Panel, 16px Eckenradius; die Aktions-Fußzeile
   * liegt AUSSERHALB der scrollenden Fläche (E2/overflow, Muster SitzungsmappeDialog).
   *
   * Feste Abschnittsfolge (12-UI-SPEC Komponentenkontrakt): Kopf (Titel + feste Unterzeile + ✕)
   * → scrollende Vorschlagsliste → stehende Fußzeile. Kartenzeilenfolge je Vorschlag:
   * Zusammenfassung → Meta → Quellenblock je Fundstelle ODER Umfangszeile (Ordnungsvorschläge)
   * → Aktionszeile. Alle Texte stehen wörtlich im Copywriting Contract der 12-UI-SPEC.
   *
   * Prüfinhalt wird NIEMALS gekürzt (Blind-Genehmigungs-Verbot, T-12-07-02): Zusammenfassung
   * und wörtliches Zitat umbrechen vollständig; die einzige Ellipsis dieser Komponente sitzt am
   * Dokumentnamen-LABEL der Quellenzeile (Bestandsmuster .umfang-name).
   *
   * Live-Konsistenz (T-12-07-03): entschiedene Karten (lokal nachgezeichnet über
   * aktualisiereNachEntscheidung, bis das projizierte Nachladen sie aus der Liste nimmt)
   * ersetzen die Aktionszeile durch Lesetext — nie eine stale Aktion. Eigene 409-Races laufen
   * über Toast + Listen-Neuladen, bewusst NICHT über das Konflikt-Overlay (das bleibt
   * Desk-Kommando-Konflikten vorbehalten).
   */

  /** Dialogmaße (12-UI-SPEC Spacing Exceptions): identisch zu ANLAGENPAKET_W/SITZUNGSMAPPE_W/H. */
  const VORSCHLAEGE_W = 'min(640px, 92vw)';
  const VORSCHLAEGE_H = 'min(88vh, 760px)';

  let vorherFokussiert: HTMLElement | null = null;
  let schliessenKnopf = $state<HTMLButtonElement | null>(null);
  let warOffen = false;
  let liste = $state<HTMLDivElement | null>(null);

  /** id der Karte mit laufender Einzel-Aktion (Übernehmen/Ablehnen), sonst null — sperrt
   *  Parallel-Läufe und Doppelklicks (laeuftFuer-Muster aus ActivityOverlay.svelte). */
  let laeuftFuer = $state<string | null>(null);
  /** true während die „Alle übernehmen"-Kette läuft — sperrt sämtliche Aktions-Buttons. */
  let alleLaeuft = $state(false);
  /** id der kurz hervorgehobenen Karte (Scrollziel aus freigaben.fokussierterVorschlagId). */
  let hervorgehobenId = $state<string | null>(null);

  /** Rollen-Gate (PERM-04): ohne 'manage'-Recht fehlen sämtliche Aktions-Buttons vollständig
   *  (ausblenden statt ausgrauen + Erklärung in der Fußzeile); der Server bleibt über den
   *  403-Pfad die eigentliche Grenze — das hier ist Komfort (darfAktionClient, 02-08). */
  const darfGenehmigen = $derived(darfAktionClient(desktop.currentRolle, 'manage'));

  function schliessen(): void {
    ui.vorschlaegeOffen = false;
    vorherFokussiert?.focus();
  }

  /** Anzeigename des Quelldokuments aus dem Client-Zustand (nie nachgeladen —
   *  ProvenancePopover-Konvention „unbekanntes Dokument"). */
  function dokumentname(dokumentId: string): string {
    return desktop.state.docs.find((d) => d.id === dokumentId)?.name ?? 'unbekanntes Dokument';
  }

  /** REF-01-Guard (T-12-07-04): bei den drei Blockade-Zuständen des Referenzstatus (gelöscht/
   *  entzogen/nicht erreichbar) ersetzt der Hinweis den Sprung-Link — nie ein toter Sprung.
   *  Die übrigen Zustände (neue Fassung/umbenannt/archiviert) lassen die Fundstelle erreichbar. */
  function quelleBlockiert(dokumentId: string): boolean {
    const doc = desktop.state.docs.find((d) => d.id === dokumentId);
    const status = referenzstatusVon(doc);
    return status !== null
      && (status.kind === 'gone' || status.kind === 'entzogen' || status.kind === 'nichtErreichbar');
  }

  /** „Fundstelle öffnen": docId-Anker + ganzeSeite — das Zitat trägt keine Wortkoordinaten,
   *  darum dieselbe Sprungform wie PDF-/OCR-Treffer (jump.ts fundstelleAusPdfTreffer,
   *  PROV-02-Bestand, kein neuer Sprungweg). Wie der ProvenancePopover schließt der Dialog
   *  nach dem Sprung — die Warteliste bleibt serverseitig erhalten. */
  function oeffneFundstelle(q: { dokumentId: string; seite: number }): void {
    void desktop.jumpTo({ docId: q.dokumentId, page: q.seite, ganzeSeite: true });
    schliessen();
  }

  /** Umfangszeile bei Ordnungsvorschlägen (quellen leer): macht die Eingriffsgröße vor dem
   *  Klick sichtbar. Anzahl/Typen werden aus art+payload abgeleitet — die inhaltsbezogenen
   *  arten (INHALTS_ARTEN: addNote/editNote/addLink/extractPage) kommen hier nie an, weil sie
   *  serverseitig quellenpflichtig sind. */
  function umfangFuer(v: VorschlagDto): { n: number; teile: string } {
    switch (v.art) {
      case 'moveDoc':
      case 'removeFromStack':
        return { n: 1, teile: '1 Dokument' };
      case 'stackDocs':
        return { n: 2, teile: '2 Dokumente' };
      case 'dissolveStack':
      case 'renameStack':
      case 'moveStack':
      case 'stapleStack':
      case 'unstapleStack':
        return { n: 1, teile: '1 Stapel' };
      case 'setLinkNote':
        return { n: 1, teile: '1 Verknüpfung' };
      case 'addClip':
        return { n: 1, teile: '1 Klammer' };
      case 'setNoteDone':
        return { n: 1, teile: '1 Notiz' };
      case 'addStamp':
        return { n: 1, teile: '1 Stempel' };
      case 'addFlag':
        return { n: 1, teile: '1 Fahne' };
      default:
        // trashObject/restoreObject und künftige arten: ehrliche Minimalangabe statt Schätzung.
        return { n: 1, teile: '1 Objekt' };
    }
  }

  /** Eigenname für die lokale Entscheidungs-Markierung (Lücken-Schließung bis zum projizierten
   *  Nachladen); Sitzungen aus der Zeit vor dem name-Feld (11-09) fallen auf „Ihnen" zurück —
   *  grammatikalisch korrekt im Lesetext „Bereits übernommen von …". */
  function eigenerName(): string {
    return loadSession()?.name ?? 'Ihnen';
  }

  /** Fehlerbehandlung der Einzel-Übernahme (Copywriting Contract): 409 = zwischenzeitlich
   *  geändert → fester Toast + Listen-Neuladen (kein Overlay); 403 = präzise Server-Meldung
   *  (WR-05, ActivityOverlay-Pfad); sonst generischer Toast mit Server-Meldung. */
  async function uebernehmenFehler(e: unknown, api: NonNullable<typeof desktop.api>, deskId: string): Promise<void> {
    if (e instanceof ApiError && e.status === 409) {
      showToast('Dieser Vorschlag wurde zwischenzeitlich geändert. Die Liste wird aktualisiert.');
      await ladeVorschlaege(api, deskId);
    } else if (e instanceof ApiError && e.status === 403) {
      showToast(e.message);
    } else {
      showToast(`Der Vorschlag konnte nicht übernommen werden. ${e instanceof Error ? e.message : ''}`.trim());
    }
  }

  async function uebernehmen(v: VorschlagDto): Promise<void> {
    if (laeuftFuer !== null || alleLaeuft) return;
    const api = desktop.api;
    const deskId = desktop.deskId;
    if (!api || !deskId) return;
    laeuftFuer = v.id;
    try {
      await api.genehmigeVorschlag(deskId, v.id);
      aktualisiereNachEntscheidung(v.id, 'genehmigt', eigenerName());
    } catch (e) {
      await uebernehmenFehler(e, api, deskId);
    } finally {
      laeuftFuer = null;
    }
  }

  async function ablehnen(v: VorschlagDto): Promise<void> {
    if (laeuftFuer !== null || alleLaeuft) return;
    const api = desktop.api;
    const deskId = desktop.deskId;
    if (!api || !deskId) return;
    laeuftFuer = v.id;
    try {
      await api.lehneVorschlagAb(deskId, v.id);
      aktualisiereNachEntscheidung(v.id, 'abgelehnt', eigenerName());
      showToast('Vorschlag abgelehnt. Die KI kann jederzeit einen überarbeiteten Vorschlag einreichen.');
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        showToast('Dieser Vorschlag wurde zwischenzeitlich geändert. Die Liste wird aktualisiert.');
        await ladeVorschlaege(api, deskId);
      } else if (e instanceof ApiError && e.status === 403) {
        showToast(e.message);
      } else {
        showToast(`Der Vorschlag konnte nicht abgelehnt werden. ${e instanceof Error ? e.message : ''}`.trim());
      }
    } finally {
      laeuftFuer = null;
    }
  }

  /** „Alle übernehmen ({N})": wendet die wartenden Vorschläge der Reihe nach über denselben
   *  Einzel-REST-Pfad an (keine eigene Batch-Maschinerie). Fail-honest: scheitert ein
   *  Vorschlag, stoppt die Kette an dieser Stelle, bereits Übernommene bleiben übernommen,
   *  Toast nennt Stand + gescheiterten Vorschlag + Server-Meldung, die Liste lädt neu.
   *  Dark-Pattern-Verbot: der Button ist nie vorselektiert und hat keinen Enter-Shortcut. */
  async function alleUebernehmen(): Promise<void> {
    if (alleLaeuft || laeuftFuer !== null) return;
    const api = desktop.api;
    const deskId = desktop.deskId;
    if (!api || !deskId) return;
    const wartend = freigaben.vorschlaege.filter((v) => v.status === 'ausstehend');
    if (wartend.length === 0) return;
    alleLaeuft = true;
    try {
      let uebernommen = 0;
      for (const v of wartend) {
        try {
          await api.genehmigeVorschlag(deskId, v.id);
          uebernommen += 1;
          aktualisiereNachEntscheidung(v.id, 'genehmigt', eigenerName());
        } catch (e) {
          const meldung = e instanceof Error ? e.message : '';
          showToast(
            `${uebernommen} von ${wartend.length} übernommen; Vorschlag „${v.zusammenfassung}" konnte nicht übernommen werden. ${meldung}`.trim(),
          );
          await ladeVorschlaege(api, deskId);
          return;
        }
      }
      // Erfolg komplett: die übernommenen Objekte kommen über den regulären State-Broadcast an,
      // die Liste selbst lädt neu (entschiedene Karten verlassen den Wartebereich).
      await ladeVorschlaege(api, deskId);
    } finally {
      alleLaeuft = false;
    }
  }

  /** „Erneut versuchen" im Fehlerzustand: exakt der zuletzt GESTARTETE Lade-Schritt
   *  (letzterModus-Gedächtnis aus freigaben.svelte.ts, ActivityOverlay-Muster). */
  function erneutVersuchen(): void {
    void freigaben.letzterModus?.();
  }

  /** Tab-Bewegungen im Overlay halten (Fokusfalle) — wortgleich zu AnlagenpaketDialog.svelte. */
  function fokusFalle(ev: KeyboardEvent): void {
    if (ev.key !== 'Tab') return;
    const ziele = (ev.currentTarget as HTMLElement).querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (ziele.length === 0) return;
    const erste = ziele[0];
    const letzte = ziele[ziele.length - 1];
    if (!ev.shiftKey && document.activeElement === letzte) { ev.preventDefault(); erste.focus(); }
    else if (ev.shiftKey && document.activeElement === erste) { ev.preventDefault(); letzte.focus(); }
  }

  // Öffnen-Effekt (warOffen-geschützt, Muster ActivityOverlay): Fokus merken, auf den
  // Schließen-Knopf setzen (KEIN Fokus/Preselect auf dem Accent-Button, Dark-Pattern-Verbot)
  // und die Warteliste frisch laden. untrack kapselt den Lade-Aufruf, damit dessen
  // State-Schreibzugriffe (laden/fehler/vorschlaege) den Effekt nicht erneut auslösen.
  $effect(() => {
    if (!ui.vorschlaegeOffen) { warOffen = false; return; }
    if (warOffen) return;
    warOffen = true;
    vorherFokussiert = document.activeElement as HTMLElement | null;
    queueMicrotask(() => schliessenKnopf?.focus());
    untrack(() => {
      const api = desktop.api;
      const id = desktop.deskId;
      if (api && id) void ladeVorschlaege(api, id);
    });
  });

  // Scrollziel (12-07 Task 1 Aktion 6): die EntwurfKarte hat beim Öffnen
  // freigaben.fokussierterVorschlagId gesetzt — sobald der Dialog offen und die Liste geladen
  // ist, scrollt er zur Karte, hebt sie kurz hervor und leert das Feld danach selbst.
  $effect(() => {
    const zielId = freigaben.fokussierterVorschlagId;
    if (!ui.vorschlaegeOffen || freigaben.laden || !zielId) return;
    freigaben.fokussierterVorschlagId = null;
    const el = liste?.querySelector(`[data-vorschlag-id="${CSS.escape(zielId)}"]`);
    if (!(el instanceof HTMLElement)) return;
    el.scrollIntoView({ block: 'center' });
    hervorgehobenId = zielId;
    setTimeout(() => { if (hervorgehobenId === zielId) hervorgehobenId = null; }, 2500);
  });
</script>

{#if ui.vorschlaegeOffen}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="hintergrund" onclick={schliessen}></div>
  <div
    class="overlay" role="dialog" aria-modal="true" aria-label="KI-Vorschläge" tabindex="-1"
    style:width={VORSCHLAEGE_W} style:max-height={VORSCHLAEGE_H}
    onkeydown={fokusFalle}
  >
    <header>
      <div class="titelblock">
        <h2>🤖 KI-Vorschläge</h2>
        <p class="unterzeile">Die KI hat nichts am Schreibtisch geändert. Prüfen Sie jeden Vorschlag samt Quelle — wirksam wird erst, was Sie übernehmen.</p>
      </div>
      <button class="schliessen" bind:this={schliessenKnopf} onclick={schliessen} aria-label="KI-Vorschläge-Dialog schließen">✕</button>
    </header>

    <div class="inhalt" bind:this={liste}>
      {#if freigaben.laden && freigaben.vorschlaege.length === 0}
        <!-- E2/loading: ein laufender Ladevorgang ist nie als „keine Vorschläge" lesbar. -->
        <p class="hinweis">Wird geladen …</p>
      {:else}
        {#if freigaben.fehler}
          <!-- E2/error: Dialog bleibt offen und bedienbar — die bisherige Liste (falls
               vorhanden) bleibt unter dem Fehlerblock sichtbar. -->
          <div class="fehler">
            <p>Vorschläge konnten nicht geladen werden. {freigaben.fehler}</p>
            <button onclick={erneutVersuchen}>Erneut versuchen</button>
          </div>
        {/if}
        {#if freigaben.vorschlaege.length === 0}
          {#if !freigaben.fehler}
            <p class="hinweis">Keine wartenden KI-Freigaben. Sobald die KI einen Vorschlag einreicht, erscheint er hier zur Prüfung.</p>
          {/if}
        {:else}
          {#each freigaben.vorschlaege as v (v.id)}
            <div
              class="vorschlag-karte" class:hervorgehoben={hervorgehobenId === v.id}
              data-vorschlag-id={v.id}
            >
              <p class="zusammenfassung">{v.zusammenfassung}</p>
              <p class="meta">eingereicht von {v.createdBy} · {zeitpunktLang(v.createdAt)}</p>
              {#if v.quellen.length > 0}
                <!-- WR-06: Index im Key — der Server laesst bis zu 5 Quellen je Vorschlag zu,
                     ohne (dokumentId, seite)-Duplikate zu verbieten (zwei Fundstellen auf
                     derselben Seite sind legitim); ohne Index braeche die gesamte Prueffläche
                     mit each_key_duplicate zusammen. -->
                {#each v.quellen as q, i (`${q.dokumentId}#${q.seite}#${i}`)}
                  <div class="quellenblock">
                    <p class="quellenzeile">Quelle: <span class="quelle-name" title={dokumentname(q.dokumentId)}>{dokumentname(q.dokumentId)}</span>, Seite {q.seite}</p>
                    <p class="zitat">„{q.zitat}"</p>
                    {#if quelleBlockiert(q.dokumentId)}
                      <p class="quelle-hinweis">Quelldokument derzeit nicht verfügbar — Fundstelle kann nicht geöffnet werden</p>
                    {:else}
                      <button class="fundstelle-link" onclick={() => oeffneFundstelle(q)}>Fundstelle öffnen</button>
                    {/if}
                  </div>
                {/each}
              {:else}
                {@const umfang = umfangFuer(v)}
                <p class="umfang">Betrifft {umfang.n} Objekt(e): {umfang.teile}</p>
              {/if}
              {#if v.status === 'genehmigt'}
                <p class="entschieden">Bereits übernommen von {v.decidedBy ?? 'unbekannt'}</p>
              {:else if v.status === 'abgelehnt'}
                <p class="entschieden">Bereits abgelehnt von {v.decidedBy ?? 'unbekannt'}</p>
              {:else if darfGenehmigen}
                <div class="karten-aktionen">
                  <button disabled={laeuftFuer !== null || alleLaeuft} onclick={() => uebernehmen(v)}>Übernehmen</button>
                  <button disabled={laeuftFuer !== null || alleLaeuft} onclick={() => ablehnen(v)}>Ablehnen</button>
                </div>
              {/if}
            </div>
          {/each}
        {/if}
      {/if}
    </div>

    <div class="aktionen">
      {#if !darfGenehmigen}
        <!-- PERM-04: ausblenden statt ausgrauen + Erklärung statt der leeren Aktionsfläche. -->
        <p class="berechtigungs-hinweis">Sie können diese Vorschläge einsehen, aber nicht übernehmen (Rolle: {desktop.currentRolle ?? 'unbekannt'}).</p>
      {:else}
        <span></span>
      {/if}
      <div class="aktionen-rechts">
        <button class="sekundaer" onclick={schliessen}>Schließen</button>
        {#if darfGenehmigen}
          <button
            class="primaer"
            disabled={zaehler() === 0 || alleLaeuft || laeuftFuer !== null}
            onclick={alleUebernehmen}
          >
            Alle übernehmen ({zaehler()})
          </button>
        {/if}
      </div>
    </div>
  </div>
{/if}

<svelte:window onkeydown={(ev) => { if (ev.key === 'Escape' && ui.vorschlaegeOffen) schliessen(); }} />

<style>
  .hintergrund { position: fixed; inset: 0; background: rgba(8, 20, 35, .35); z-index: 9750; }
  .overlay {
    position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
    display: flex; flex-direction: column;
    z-index: 9760; border-radius: 16px; padding: 0 0 16px;
    background: var(--glass-panel-bg, rgba(255, 255, 255, .82));
    color: var(--glass-text);
    backdrop-filter: var(--glass-blur-panel); -webkit-backdrop-filter: var(--glass-blur-panel);
    box-shadow: 0 18px 48px rgba(0, 0, 0, .28);
  }
  header { display: flex; align-items: flex-start; justify-content: space-between; padding: 14px 16px 8px; gap: 8px; }
  .titelblock { display: flex; flex-direction: column; gap: 2px; }
  h2 { margin: 0; font-size: 15px; font-weight: 600; }
  .unterzeile { margin: 0; font-size: 12px; line-height: 1.4; opacity: .7; }
  .schliessen { border: 0; background: transparent; font-size: 15px; cursor: pointer; padding: 4px 8px; flex-shrink: 0; }
  /* Die Liste scrollt innerhalb der festen Dialoghöhe; Kartenabstand sm (8px, 12-UI-SPEC). */
  .inhalt { overflow-y: auto; padding: 8px 16px 0; display: flex; flex-direction: column; gap: 8px; }

  /* Vorschlags-Karte: Sekundärfläche var(--glass-card-bg) (12-UI-SPEC Color), Innenpolster md
     (16px); Zeilenabstand Zusammenfassung → Meta → Quellenblock → Aktionen sm (8px). */
  .vorschlag-karte {
    display: flex; flex-direction: column; gap: 8px; padding: 16px; border-radius: 12px;
    background: var(--glass-card-bg); border: 1px solid var(--glass-border);
  }
  /* Kurzzeit-Hervorhebung des Scrollziels: Accent-Ring 2px innerhalb der Kartenkontur
     (Bestands-Prinzip .hervorgehoben aus Phase 11 — kein Layout-Shift, additiver Zustand). */
  .vorschlag-karte.hervorgehoben { box-shadow: inset 0 0 0 2px var(--brand-blue); }

  /* Zusammenfassung ist INHALT (Prüfobjekt): Body 13/400, bricht vollständig um — niemals
     eine Auslassung (Blind-Genehmigungs-Verbot, 12-UI-SPEC). */
  .zusammenfassung { margin: 0; font-size: 13px; font-weight: 400; line-height: 1.5; overflow-wrap: break-word; }
  .meta { margin: 0; font-size: 12px; font-weight: 400; line-height: 1.4; color: var(--glass-text-secondary); }

  .quellenblock { display: flex; flex-direction: column; gap: 4px; }
  .quellenzeile { margin: 0; font-size: 12px; font-weight: 400; line-height: 1.4; color: var(--glass-text-secondary); }
  /* Der Dokumentname ist ein LABEL: Auslassung + title (Bestandsmuster .umfang-name) — die
     EINZIGE Stelle dieser Komponente, an der Inhalt optisch gekürzt wird. */
  .quelle-name {
    display: inline-block; max-width: 65%; vertical-align: bottom;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  /* Das wörtliche Zitat ist INHALT und das eigentliche Prüfobjekt des Gates: Body 13/400,
     NICHT-kursiv (Kursivierung verwässert die Wörtlichkeits-Wahrnehmung, 12-UI-SPEC),
     deutsche Anführungszeichen im Markup, bricht vollständig um — niemals gekürzt. */
  .zitat { margin: 0; font-size: 13px; font-weight: 400; line-height: 1.5; overflow-wrap: break-word; }
  /* Textlink ohne neue Accent-Fläche: Unterstreichung trägt die Affordanz (12-UI-SPEC Color). */
  .fundstelle-link {
    align-self: flex-start; border: none; background: transparent; padding: 0; cursor: pointer;
    color: inherit; font: inherit; font-size: 12px; text-decoration: underline;
  }
  .fundstelle-link:hover { background: var(--glass-hover); }
  .quelle-hinweis { margin: 0; font-size: 12px; line-height: 1.4; color: var(--glass-text-secondary); }

  .umfang { margin: 0; font-size: 12px; font-weight: 400; line-height: 1.4; color: var(--glass-text-secondary); }

  /* Live-Konsistenz-Lesetext: ersetzt die Aktionszeile vollständig (nie eine stale Aktion). */
  .entschieden { margin: 0; font-size: 12px; line-height: 1.4; color: var(--glass-text-secondary); }

  /* Übernehmen/Ablehnen: NEUTRALE Glass-Buttons (.glass-input-Optik) — kein Accent, kein Rot,
     kein Bestätigungsdialog; „Ablehnen" ist gleichwertig sichtbar (Dark-Pattern-Verbot). */
  .karten-aktionen { display: flex; gap: 8px; }
  .karten-aktionen button {
    padding: 6px 12px; border-radius: 8px; border: 1px solid var(--glass-border);
    background: var(--glass-input-bg); color: var(--glass-text); cursor: pointer;
    font: inherit; font-size: 13px; box-shadow: var(--glass-shadow);
  }
  .karten-aktionen button:hover { background: var(--glass-hover); }
  .karten-aktionen button:disabled { opacity: .5; cursor: default; }

  .hinweis { margin: 0; font-size: 13px; opacity: .75; }
  .fehler { display: flex; flex-direction: column; gap: 6px; }
  .fehler p { margin: 0; font-size: 13px; opacity: .75; }
  .fehler button { align-self: flex-start; border: none; border-radius: 6px; background: var(--glass-active); color: var(--glass-text); cursor: pointer; font-size: 12px; padding: 4px 8px; }

  /* Fußzeile liegt AUSSERHALB der scrollenden .inhalt-Fläche und scrollt nie mit (E2/overflow). */
  .aktionen { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-top: 24px; padding: 0 16px; }
  .berechtigungs-hinweis { margin: 0; font-size: 12px; line-height: 1.4; color: var(--glass-text-secondary); }
  .aktionen-rechts { display: flex; gap: 8px; }
  .aktionen button {
    padding: 9px 12px; border-radius: 8px; border: 1px solid var(--glass-border);
    background: transparent; color: var(--glass-text); cursor: pointer; font: inherit; font-size: 13px;
  }
  .aktionen button:hover { background: var(--glass-hover); }
  /* „Alle übernehmen" ist der EINZIGE Accent-Button des Dialogs (12-UI-SPEC Color) —
     Deaktivierungsmuster identisch zu „Sitzung starten". */
  .aktionen .primaer { background: var(--brand-blue); color: #fff; border-color: transparent; }
  .aktionen .primaer:hover { background: var(--brand-blue); opacity: .9; }
  .aktionen .primaer:disabled { opacity: .5; cursor: default; }
</style>
