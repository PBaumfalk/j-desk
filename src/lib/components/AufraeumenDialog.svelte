<script lang="ts">
  import { untrack } from 'svelte';
  import { ermittleVorschlaege, GRUPPEN_LABEL, type AufraeumGruppe, type AufraeumVorschlag } from '@j-desk/core';
  import { desktop } from '../store.svelte';
  import { ui, showToast } from '../ui.svelte';

  /**
   * AufraeumenDialog (UX-02, 13-08): strukturell erzwungene Vorschau mit Abwahl — Vorlage
   * VorschlaegeDialog.svelte (Dialog-Klasse 1:1: `.hintergrund`/`.overlay`, `role="dialog"`,
   * `aria-modal`, Fokusfalle, `warOffen`-geschützter Öffnen-Effekt, Escape schließt, Glas-Panel,
   * stehende Fußzeile AUSSERHALB der scrollenden Fläche).
   *
   * Vorschau-Erzwingung (strukturell, nicht redaktionell, Leitplanke 2 aus 13-CONTEXT.md): dieser
   * Dialog hat KEINEN Pfad, der ohne sichtbare Zeilenliste und ausdrücklichen CTA-Klick etwas
   * verändert — kein „automatisch aufräumen"-Kommando existiert in Palette, Menü oder Shortcut
   * (13-09 fügt später höchstens einen Registry-Eintrag hinzu, der auf `ui.aufraeumenOffen`
   * zeigt, niemals einen Direktausführungs-Befehl). Jede Zeile ist voreingestellt ANGEHAKT
   * (`abgewaehlt` trägt nur die Ausnahmen); der CTA-Zähler (`angehaktCount`) zählt ausschließlich
   * angehakte Zeilen.
   *
   * Die Ermittlung (`ermittleVorschlaege`, `@j-desk/core`) läuft SYNCHRON aus dem bereits
   * geladenen `desktop.state` — kein Serverpfad, kein echter Netz-Ladezustand. „Vorschläge werden
   * ermittelt …" (E1/loading) ist eine reine Form-Konvention für den kurzen Moment zwischen
   * Öffnen-Effekt und erstem Render (nie den Leertext währenddessen zeigen, Muster
   * ActivityOverlay.svelte) — sie existiert, weil ein laufender Vorgang nie als „nichts
   * vorzuschlagen" lesbar sein darf, auch wenn er hier nur einen Tick dauert.
   *
   * Ausführung (P7, 13-RESEARCH.md „Aufraeumen-Ausführung als Batch-Kommando erfinden"):
   * sequenzielle Schleife über die angehakten Zeilen — je Zeile werden ihre `aktion.kommandos`
   * EINZELN über `desktop.command(type, payload, { silent: true })` dispatcht (Offline-Queue,
   * 409-Konflikt, Journal und Projektion erben unverändert mit). `{ silent: true }` unterdrückt
   * die MODULEIGENEN Einzel-Toasts von `store.svelte.ts` (Offline-Hinweis/403/generischer
   * Fehler) — sonst würde jede Zeile ihren eigenen Toast auslösen, bevor der zusammenfassende
   * Teilerfolgs-Toast dieser Komponente erscheint (Toast-Lärm). KEIN neues Kommando, KEIN neuer
   * Server-Endpunkt, KEINE Sammel-Transaktion — bereits Ausgeführtes bleibt ausgeführt, sobald
   * eine Zeile fehlschlägt (fail-honest).
   */

  /** Identisch zu VORSCHLAEGE_W/H (Phase 12) — dieselbe Dialogklasse (13-UI-SPEC Spacing Exceptions). */
  const AUFRAEUMEN_W = 'min(640px, 92vw)';
  const AUFRAEUMEN_H = 'min(88vh, 760px)';

  let vorherFokussiert: HTMLElement | null = null;
  let schliessenKnopf = $state<HTMLButtonElement | null>(null);
  let warOffen = false;

  /** Gesetzt vom Öffnen-Effekt, bevor `ermitteln()` (synchron) läuft — Form-Konvention für
   *  E1/loading, s. Kopfkommentar. */
  let ermittelt = $state(false);
  let vorschlaege = $state<AufraeumVorschlag[]>([]);
  let fehler = $state<string | null>(null);
  /** Abwahl-Menge (Muster `ausschluesse`, AnlagenpaketDialog.svelte F-16): trägt die Vorschlag-id
   *  NICHT den Listenindex. Jede Zeile startet angehakt — diese Menge enthält ausschließlich die
   *  bewusst ABGEWÄHLTEN Zeilen. */
  let abgewaehlt = $state<Set<string>>(new Set());
  let laeuft = $state(false);

  /** CTA-Zähler: ausschließlich angehakte (= NICHT abgewählte) Zeilen — niemals die Gesamtzahl. */
  const angehaktCount = $derived(vorschlaege.filter((v) => !abgewaehlt.has(v.id)).length);

  /** Nur Gruppen mit ≥1 Vorschlag werden gerendert (E1/partial) — die feste Gruppenreihenfolge
   *  kommt aus `GRUPPEN_LABEL` (aufraeumen.ts), hier nicht erneut dupliziert. */
  const gruppiert = $derived(
    (Object.keys(GRUPPEN_LABEL) as AufraeumGruppe[])
      .map((gruppe) => ({ gruppe, label: GRUPPEN_LABEL[gruppe], zeilen: vorschlaege.filter((v) => v.gruppe === gruppe) }))
      .filter((g) => g.zeilen.length > 0),
  );

  function schliessen(): void {
    ui.aufraeumenOffen = false;
    vorherFokussiert?.focus();
  }

  function toggle(id: string): void {
    const next = new Set(abgewaehlt);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    abgewaehlt = next;
  }

  /** Frischer, unabhängiger Vorschau-Lauf — jedes Öffnen (und „Erneut versuchen") ermittelt neu
   *  aus dem AKTUELLEN `desktop.state`, nie aus einem Zwischenspeicher (E1/error „Dialog bleibt
   *  offen und bedienbar"). */
  function ermitteln(): void {
    fehler = null;
    ermittelt = false;
    try {
      vorschlaege = ermittleVorschlaege(desktop.state);
      abgewaehlt = new Set();
    } catch (e) {
      fehler = e instanceof Error ? e.message : 'Unbekannter Fehler.';
      vorschlaege = [];
    } finally {
      ermittelt = true;
    }
  }

  /** `trashObject`-Kommando-Bausteine tragen bewusst KEIN `trashedAt` aus der Ermittlung
   *  (aufraeumen.ts bleibt zeitfrei/rein, s. dortiger Kopfkommentar) — der Ausführungsaugenblick
   *  ergänzt es hier, unmittelbar vor dem Dispatch. */
  function payloadFuerAusfuehrung(kommando: { type: string; payload: Record<string, unknown> }): Record<string, unknown> {
    return kommando.type === 'trashObject'
      ? { ...kommando.payload, trashedAt: new Date().toISOString() }
      : kommando.payload;
  }

  /** Fail-honest Ausführung (Copywriting Contract, 13-UI-SPEC.md): bricht bei der ERSTEN
   *  fehlschlagenden Zeile ab — alle zuvor erfolgreich ausgeführten Zeilen bleiben ausgeführt
   *  (P7, kein Rollback). Der Toast nennt den Stand („{X} von {N} ausgeführt"), die
   *  Aktionsbeschreibung der gescheiterten Zeile und die genaue Servermeldung. */
  async function ausfuehren(): Promise<void> {
    if (laeuft) return;
    const ausgewaehlt = vorschlaege.filter((v) => !abgewaehlt.has(v.id));
    if (ausgewaehlt.length === 0) return;
    laeuft = true;
    let erledigt = 0;
    try {
      for (const v of ausgewaehlt) {
        let zeileOk = true;
        let zeileFehler = '';
        for (const kommando of v.aktion.kommandos) {
          // P7: bewusst sequenziell (kein Promise.all) — keine Sammel-Transaktion, jedes
          // Kommando erbt den normalen Offline-Queue-/409-Pfad einzeln.
          const ergebnis = await desktop.command(kommando.type, payloadFuerAusfuehrung(kommando), { silent: true });
          if (!ergebnis.ok) {
            zeileOk = false;
            zeileFehler = ergebnis.error ?? 'Aktion fehlgeschlagen.';
            break;
          }
        }
        if (!zeileOk) {
          showToast(`${erledigt} von ${ausgewaehlt.length} ausgeführt; „${v.beschreibung}" ist fehlgeschlagen. ${zeileFehler}`.trim());
          return;
        }
        erledigt += 1;
      }
      showToast(`${erledigt} Aktion(en) ausgeführt.`);
      schliessen();
    } finally {
      laeuft = false;
    }
  }

  /** Tab-Bewegungen im Overlay halten (Fokusfalle) — wortgleich zu VorschlaegeDialog.svelte. */
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

  // Öffnen-Effekt (warOffen-geschützt, Muster VorschlaegeDialog/ActivityOverlay): Fokus merken,
  // auf den Schließen-Knopf setzen (KEIN Fokus/Preselect auf dem Accent-Button, Dark-Pattern-
  // Verbot) und frisch ermitteln. untrack kapselt den Ermittlungs-Aufruf, damit dessen eigene
  // State-Schreibzugriffe (ermittelt/vorschlaege/fehler/abgewaehlt) den Effekt nicht erneut
  // auslösen.
  $effect(() => {
    if (!ui.aufraeumenOffen) { warOffen = false; return; }
    if (warOffen) return;
    warOffen = true;
    vorherFokussiert = document.activeElement as HTMLElement | null;
    queueMicrotask(() => schliessenKnopf?.focus());
    untrack(() => ermitteln());
  });
</script>

{#if ui.aufraeumenOffen}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="hintergrund" onclick={schliessen}></div>
  <div
    class="overlay" role="dialog" aria-modal="true" aria-label="Schreibtisch aufräumen" tabindex="-1"
    style:width={AUFRAEUMEN_W} style:max-height={AUFRAEUMEN_H}
    onkeydown={fokusFalle}
  >
    <header>
      <div class="titelblock">
        <h2>🧹 Schreibtisch aufräumen — Vorschau</h2>
        <p class="unterzeile">Nichts geschieht automatisch. Prüfen Sie jede Zeile, wählen Sie ab, was Sie nicht möchten — ausgeführt wird erst, was Sie bestätigen.</p>
      </div>
      <button class="schliessen" bind:this={schliessenKnopf} onclick={schliessen} aria-label="Aufräumen-Dialog schließen">✕</button>
    </header>

    <div class="inhalt">
      {#if !ermittelt}
        <!-- E1/loading: ein laufender Vorgang ist nie als „nichts vorzuschlagen" lesbar. -->
        <p class="hinweis">Vorschläge werden ermittelt …</p>
      {:else if fehler}
        <!-- E1/error: der Dialog bleibt offen und bedienbar. -->
        <div class="fehlerblock">
          <p>Vorschläge konnten nicht ermittelt werden. {fehler}</p>
          <button onclick={ermitteln}>Erneut versuchen</button>
        </div>
      {:else if vorschlaege.length === 0}
        <!-- E1/empty -->
        <p class="hinweis">Der Schreibtisch ist aufgeräumt — es gibt nichts vorzuschlagen.</p>
      {:else}
        {#each gruppiert as g (g.gruppe)}
          <section class="gruppe">
            <h3>{g.label}</h3>
            {#each g.zeilen as v (v.id)}
              <label class="zeile">
                <input
                  type="checkbox"
                  checked={!abgewaehlt.has(v.id)}
                  disabled={laeuft}
                  onchange={() => toggle(v.id)}
                />
                <!-- E1/long-text: Ellipsis + title (Bestandsmuster .umfang-name); die
                     Beschreibung selbst ist bereits erzeugter Text mit gebremster Länge
                     (aufraeumen.ts, BESCHREIBUNG_NAMEN_MAX/EINZELNAME_MAX). -->
                <span class="zeile-text" title={v.beschreibung}>{v.beschreibung}</span>
              </label>
            {/each}
          </section>
        {/each}
      {/if}
    </div>

    <div class="aktionen">
      <button class="sekundaer" disabled={laeuft} onclick={schliessen}>Schließen</button>
      <button class="primaer" disabled={angehaktCount === 0 || laeuft} onclick={ausfuehren}>
        Ausführen ({angehaktCount} ausgewählt)
      </button>
    </div>
  </div>
{/if}

<svelte:window onkeydown={(ev) => { if (ev.key === 'Escape' && ui.aufraeumenOffen) schliessen(); }} />

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
  /* Die Liste scrollt innerhalb der festen Dialoghöhe; Gruppenabstand lg (24px, 13-UI-SPEC). */
  .inhalt { overflow-y: auto; padding: 8px 16px 0; display: flex; flex-direction: column; gap: 24px; }

  .gruppe { display: flex; flex-direction: column; gap: 8px; }
  .gruppe h3 { margin: 0; font-size: 15px; font-weight: 600; }

  .zeile {
    display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 8px;
    background: var(--glass-card-bg); border: 1px solid var(--glass-border); cursor: pointer;
  }
  .zeile:hover { background: var(--glass-hover); }
  .zeile input[type='checkbox'] { flex-shrink: 0; }
  .zeile-text {
    font-size: 13px; line-height: 1.4; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }

  .hinweis { margin: 0; font-size: 13px; opacity: .75; }
  .fehlerblock { display: flex; flex-direction: column; gap: 6px; }
  .fehlerblock p { margin: 0; font-size: 13px; opacity: .75; }
  .fehlerblock button { align-self: flex-start; border: none; border-radius: 6px; background: var(--glass-active); color: var(--glass-text); cursor: pointer; font-size: 12px; padding: 4px 8px; }

  /* Fußzeile liegt AUSSERHALB der scrollenden .inhalt-Fläche und scrollt nie mit (E1/overflow). */
  .aktionen { display: flex; justify-content: flex-end; align-items: center; gap: 8px; margin-top: 24px; padding: 0 16px; }
  .aktionen button {
    padding: 9px 12px; border-radius: 8px; border: 1px solid var(--glass-border);
    background: transparent; color: var(--glass-text); cursor: pointer; font: inherit; font-size: 13px;
  }
  .aktionen button:hover { background: var(--glass-hover); }
  .aktionen button:disabled { opacity: .5; cursor: default; }
  /* „Ausführen ({N} ausgewählt)" ist der EINZIGE Accent-Button des Dialogs (Deaktivierungsmuster
     „Sitzung starten") — Dark-Pattern-Verbot: nie vorselektiert, kein Preselect-Fokus. */
  .aktionen .primaer { background: var(--brand-blue); color: #fff; border-color: transparent; }
  .aktionen .primaer:hover { background: var(--brand-blue); opacity: .9; }
  .aktionen .primaer:disabled { opacity: .5; cursor: default; }
</style>
