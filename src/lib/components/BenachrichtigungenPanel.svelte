<script lang="ts">
  import { desktop } from '../store.svelte';
  import { ui } from '../ui.svelte';
  import {
    benachrichtigungen, markiereAlleGelesen, markiereGelesen, ungelesen, ungelesenText,
    zeilenMitSammelzeile, klickZiel, istSammelzeile, type AnzeigeZeile,
  } from '../benachrichtigungen.svelte';
  import { TASK_STATUS_LABELS } from '../menus';

  // BenachrichtigungenPanel (NOTIF-01, 13-01/13-04; 13-UI-SPEC Komponentenkontrakt E10):
  // - Lärm-Regel: der Badge ist das EINZIGE Signal — keine Toasts für Inbox-Ereignisse;
  //   Accent-Blau (nicht Rot): „Neues für Sie", nur bei > 0, ab 100 „99+". Sechs Zeilentypen
  //   (Erwähnung/Aufgabe/ersetzt/geteilt/quelle + KI-Sammelzeile) sind die VOLLSTÄNDIGE Menge —
  //   Kartenbewegungen, Fremdbearbeitungen und Live-Ereignisse erzeugen weder Zeile noch Toast.
  // - E10/loading: KEIN eigener Ladepfad/Spinner — die Zeilen kommen aus dem mit dem Desk
  //   geladenen bzw. per WS-Signal gepflegten benachrichtigungen-Zustand.
  // - E10/error: bei Verbindungsabbruch zeigt die Inbox den letzten bekannten Stand weiter;
  //   der Verbindungsverlust bleibt Sache des Bestands-Verbindungsbanners.
  // - Sitzungsmodus: kein 🔔, keine Unterbrechung (Lärm-Regel während des Termins) — die
  //   Komponente rendert dann strukturell nichts.
  // - Ungelesen-Doppelkodierung: 8px-Accent-Punkt PLUS Schriftgewicht 600 (nie Gewicht allein).

  /** Aufgaben-Fälligkeit (YYYY-MM-DD) als deutsches Datum — Anzeige, kein Prüfpfad. */
  function faelligAnzeige(iso: string): string {
    const d = new Date(`${iso}T00:00:00`);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }

  /** Zeilentext je art (13-UI-SPEC Copywriting Contract) — sechs Zeilentypen + Sammelzeile;
   *  Nutzernamen/Titel/Daten werden in die fixierten Schablonen eingesetzt, keine freien
   *  Umformulierungen. */
  function textFuer(z: AnzeigeZeile): string {
    if (istSammelzeile(z)) return `${z.anzahl} KI-Vorschlag/-Vorschläge warten auf Prüfung.`;
    const p = z.payload;
    switch (z.art) {
      case 'erwaehnung':
        return `${p.vonName ?? 'unbekannt'} hat Sie in „${p.notizTitel ?? ''}" erwähnt.`;
      case 'aufgabe':
        if (p.variante === 'status') {
          const label = p.status !== undefined ? (TASK_STATUS_LABELS[p.status as keyof typeof TASK_STATUS_LABELS] ?? p.status) : '';
          return `Aufgabe „${p.titel ?? ''}" ist jetzt ${label}.`;
        }
        return p.faellig !== undefined
          ? `${p.vonName ?? 'unbekannt'} hat Ihnen die Aufgabe „${p.titel ?? ''}" zugewiesen (fällig ${faelligAnzeige(p.faellig)}).`
          : `${p.vonName ?? 'unbekannt'} hat Ihnen die Aufgabe „${p.titel ?? ''}" zugewiesen.`;
      case 'ersetzt':
        return `„${p.dokumentName ?? ''}" wurde in j-lawyer ersetzt — Ihre Annotationen bleiben erhalten.`;
      case 'geteilt':
        return `${p.vonName ?? 'unbekannt'} hat den Schreibtisch „${p.deskName ?? ''}" mit Ihnen geteilt (Rolle: ${p.rolle ?? ''}).`;
      case 'quelle':
        return `Quelle von „${p.dokumentName ?? ''}" ist derzeit nicht erreichbar — Annotationen bleiben erhalten.`;
      default:
        return '';
    }
  }

  /** Relative Zeit der Meta-Zeile (Anzeige, kein Prüfpfad — die Aktivitätsansicht aus
   *  Phase 4 bleibt die auditierbare Quelle). */
  function relativ(createdAt: number): string {
    const min = Math.floor((Date.now() - createdAt) / 60000);
    if (min < 1) return 'gerade eben';
    if (min < 60) return `vor ${min} Min.`;
    const std = Math.floor(min / 60);
    if (std < 24) return `vor ${std} Std.`;
    return std < 48 ? 'vor 1 Tag' : `vor ${Math.floor(std / 24)} Tagen`;
  }

  /** Zeilenklick: markiert gelesen (optimistisch, außer Sammelzeile — die ist kein
   *  Server-Objekt) und führt das Klickziel aus — Sprung über den Bestands-Sprungweg
   *  (ui.jumpRequest), Dokument öffnen über desktop.jumpTo(), Desk-Wechsel über
   *  desktop.switchDesk(), Sammelzeile öffnet den VorschlaegeDialog. Das Panel schließt
   *  in jedem ausgeführten Fall (AuswertungsPanel-Muster). */
  function ausfuehren(z: AnzeigeZeile): void {
    if (istSammelzeile(z)) {
      ui.vorschlaegeOffen = true;
      ui.inboxOffen = false;
      return;
    }
    const ziel = klickZiel(z, desktop.state);
    if (!ziel) return; // defensiv — das Template rendert inerte Zeilen ohnehin ohne onclick
    const api = desktop.api;
    if (api && z.read_at === null) void markiereGelesen(api, z.id);
    if (ziel.art === 'sprung') ui.jumpRequest = { box: ziel.box };
    else if (ziel.art === 'dokument') void desktop.jumpTo(ziel.ziel);
    else if (ziel.art === 'desk') void desktop.switchDesk(ziel.deskId);
    ui.inboxOffen = false;
  }

  /** „Alle als gelesen markieren" — online-only; der Fehler kommt per Toast aus dem
   *  Zustandsmodul (kein Queue-Nachspielen, zustandsbezogen nicht historisch). */
  async function alleGelesen(): Promise<void> {
    const api = desktop.api;
    if (!api) return;
    await markiereAlleGelesen(api);
  }
</script>

{#if !ui.sitzungsmodusAktiv}
  <button
    class="glocke"
    onclick={() => (ui.inboxOffen = !ui.inboxOffen)}
    aria-label="Benachrichtigungen"
    title="Benachrichtigungen"
    aria-expanded={ui.inboxOffen}
  >
    🔔 Benachrichtigungen{#if ungelesen() > 0}<span class="badge">{ungelesenText()}</span>{/if}
  </button>
{/if}
{#if ui.inboxOffen && !ui.sitzungsmodusAktiv}
  <div class="hintergrund" role="presentation" onclick={() => (ui.inboxOffen = false)}></div>
  <div class="panel" role="dialog" aria-label="Benachrichtigungen">
    <div class="kopf">🔔 Benachrichtigungen</div>
    <div class="liste">
      {#if zeilenMitSammelzeile().length === 0}
        <div class="leer">Keine neuen Benachrichtigungen. Hier erscheinen nur Erwähnungen, Aufgaben, ersetzte Dokumente, wartende KI-Freigaben, geteilte Schreibtische und verlorene Quellen.</div>
      {:else}
        <ul>
          {#each zeilenMitSammelzeile() as z (z.id)}
            {@const ziel = klickZiel(z, desktop.state)}
            {@const text = textFuer(z)}
            {@const zeileUngelesen = !istSammelzeile(z) && z.read_at === null}
            <li>
              {#if ziel}
                <button class="zeile" class:ungelesen={zeileUngelesen} onclick={() => ausfuehren(z)}>
                  <span class="punktbereich">{#if zeileUngelesen}<span class="punkt"></span>{/if}</span>
                  <span class="inhalt">
                    <span class="text" title={text}>{text}</span>
                    {#if !istSammelzeile(z)}<span class="meta">{relativ(z.created_at)}</span>{/if}
                  </span>
                </button>
              {:else}
                <div class="zeile inert" class:ungelesen={zeileUngelesen}>
                  <span class="punktbereich">{#if zeileUngelesen}<span class="punkt"></span>{/if}</span>
                  <span class="inhalt">
                    <span class="text" title="{text} (Ziel nicht mehr vorhanden)">{text} (Ziel nicht mehr vorhanden)</span>
                    {#if !istSammelzeile(z)}<span class="meta">{relativ(z.created_at)}</span>{/if}
                  </span>
                </div>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </div>
    {#if benachrichtigungen.zeilen.length > 0}
      <div class="fuss">
        <button class="alle" onclick={() => void alleGelesen()} disabled={ungelesen() === 0}>Alle als gelesen markieren</button>
      </div>
    {/if}
  </div>
{/if}

<style>
  /* INBOX_W/H (13-UI-SPEC Spacing Exceptions): 360px × max-height 60vh — Dropdown-Panel
     unter der Werkzeugleiste rechts (TrashCan.svelte-Muster, dort 320px/50vh); etwas
     breiter/höher, weil Zeilen zweizeilig sind (Text + Meta). */
  .glocke { position: relative; font-size: 13px; padding: 6px 12px; border-radius: 8px;
            border: 1px solid var(--glass-border);
            background: var(--glass-card-bg); color: var(--glass-text);
            backdrop-filter: var(--glass-blur-card); -webkit-backdrop-filter: var(--glass-blur-card);
            cursor: pointer; box-shadow: var(--glass-shadow); }
  .glocke:hover { background: var(--glass-elevated-bg); }
  /* Accent-Badge (bewusst NICHT rot — Blau bedeutet „Neues für Sie", 13-UI-SPEC Color (c)). */
  .badge { position: absolute; top: -6px; right: -6px; min-width: 20px; height: 20px; border-radius: 10px;
           background: var(--brand-blue); color: #fff; font-size: 11px; font-weight: 700; line-height: 20px; padding: 0 4px; }
  .hintergrund { position: fixed; inset: 0; z-index: 9390; }
  .panel { position: fixed; right: 16px; top: 56px; z-index: 9400; width: 360px; max-height: 60vh;
           display: flex; flex-direction: column;
           background: var(--glass-panel-bg); color: var(--glass-text);
           border: 1px solid var(--glass-border); border-radius: 12px; padding: 10px;
           backdrop-filter: var(--glass-blur-panel); -webkit-backdrop-filter: var(--glass-blur-panel);
           box-shadow: var(--glass-shadow-lg); font-size: 13px; }
  .kopf { font-size: 15px; font-weight: 600; padding: 2px 4px 10px; }
  /* E10/overflow: die Liste scrollt innerhalb INBOX_H; die Fußzeile steht außerhalb. */
  .liste { overflow: auto; min-height: 0; }
  .leer { padding: 10px; color: var(--glass-text-secondary); }
  ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
  .zeile { display: grid; grid-template-columns: 12px 1fr; gap: 4px; align-items: start; width: 100%;
           text-align: left; border: none; border-radius: 8px; padding: 6px 8px;
           background: var(--glass-hover); color: var(--glass-text); font-size: 13px; cursor: pointer; }
  button.zeile:hover { background: var(--glass-active); }
  .zeile.inert { cursor: default; color: var(--glass-text-secondary); }
  /* UNREAD_DOT (8px, Accent) — Doppelkodierung mit Gewicht 600 (.ungelesen .text). */
  .punktbereich { padding-top: 5px; }
  .punkt { display: block; width: 8px; height: 8px; border-radius: 4px; background: var(--brand-blue); }
  .inhalt { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  /* E10/long-text: Zeilentext maximal zweizeilig, dann Ellipsis (+ title am Element). */
  .text { display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical;
          overflow: hidden; text-overflow: ellipsis; line-height: 1.5; }
  .ungelesen .text { font-weight: 600; }
  /* Meta-Zeile einzeilig (12px Label). */
  .meta { font-size: 12px; color: var(--glass-text-secondary); white-space: nowrap;
          overflow: hidden; text-overflow: ellipsis; }
  .fuss { padding-top: 8px; }
  /* Sekundärer Glass-Button (kein Accent — Accent ist dem Ungelesen-Signal vorbehalten). */
  .alle { width: 100%; border: 1px solid var(--glass-border); border-radius: 8px; padding: 6px 8px;
          background: var(--glass-card-bg); color: var(--glass-text); font-size: 13px; cursor: pointer; }
  .alle:hover:not(:disabled) { background: var(--glass-elevated-bg); }
  .alle:disabled { opacity: .55; cursor: default; }
</style>
