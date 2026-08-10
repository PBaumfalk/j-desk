<script lang="ts">
  import { untrack } from 'svelte';
  import { desktop } from '../store.svelte';
  import { ui } from '../ui.svelte';
  import { beschreibe, type HistorienEintrag } from '../history';

  let laden = $state(false);
  let fehler = $state<string | null>(null);
  let liste = $state<HTMLDivElement | null>(null);

  // Merkt sich den Modus des zuletzt GESTARTETEN Ladeversuchs (nicht nur des
  // erfolgreichen), damit "Erneut versuchen" genau den fehlgeschlagenen Schritt
  // wiederholt. Ohne dieses Gedächtnis würde ein fehlgeschlagenes "Mehr laden"
  // beim Retry auf weiter=false zurückfallen und die bereits nachgeladenen
  // Seiten stillschweigend durch die erste Seite ersetzen — bitte NICHT
  // "vereinfachen", indem der Retry-Knopf wieder fest laedt() aufruft.
  let letzterModus = false;

  let vorherFokussiert: HTMLElement | null = null;
  let schliessenKnopf = $state<HTMLButtonElement | null>(null);
  let warOffen = false;

  const eintraege = $derived(
    ui.historieEintraege.map((e) => beschreibe(e, desktop.state)),
  );

  /** Tagesüberschrift; heute/gestern ausgeschrieben, sonst Datum. */
  function tag(zeit: number): string {
    const d = new Date(zeit);
    const heute = new Date();
    const gleich = (a: Date, b: Date) => a.toDateString() === b.toDateString();
    if (gleich(d, heute)) return 'Heute';
    const gestern = new Date(heute.getTime() - 86_400_000);
    if (gleich(d, gestern)) return 'Gestern';
    return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }

  function uhrzeit(zeit: number): string {
    return new Date(zeit).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  }

  async function laedt(weiter = false): Promise<void> {
    const api = desktop.api;
    const id = desktop.deskId;
    letzterModus = weiter;
    if (!api || !id) { fehler = 'Nicht verbunden'; return; }
    laden = true;
    fehler = null;
    try {
      const vorher = weiter ? ui.historieEintraege.at(-1)?.id : undefined;
      const { entries } = await api.listJournal(id, { limit: 50, ...(vorher !== undefined ? { before: vorher } : {}) });
      ui.historieEintraege = weiter ? [...ui.historieEintraege, ...entries] : entries;
    } catch (e) {
      fehler = e instanceof Error ? e.message : 'Historie konnte nicht geladen werden';
    } finally {
      laden = false;
    }
  }

  function schliessen(): void {
    ui.historieScroll = liste?.scrollTop ?? 0;
    ui.historieOffen = false;
    vorherFokussiert?.focus();
  }

  function springen(e: HistorienEintrag): void {
    if (!e.ziel) return;
    vorherFokussiert = null;
    // Konsumiert vom Öffnen-Effekt: Rückkehr aus dem Sprung soll Liste+Scrollposition
    // behalten statt frisch zu laden (Spec: mehrere Fundstellen nacheinander prüfen
    // soll keine Jagd werden).
    ui.historieNachSprung = true;
    schliessen();
    void desktop.jumpTo(e.ziel);
  }

  /** Tab-Bewegungen im Overlay halten (Fokusfalle) — sonst wandert der Fokus hinter das Modal. */
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

  // Beim Öffnen: standardmäßig frisch laden (Seite 1) — nur die Rückkehr aus springen()
  // (historieNachSprung, einmalig konsumiert) behält Liste und Scrollposition, damit das
  // Prüfen mehrerer Fundstellen hintereinander keine Jagd wird. Ein abweichender
  // desktop.deskId erzwingt IMMER Neuladen, auch nach einem Sprung — der Zwischenspeicher
  // gehört sonst zum falschen Schreibtisch/zur falschen Akte (historieDeskId).
  //
  // Reagiert NUR auf den Übergang geschlossen -> offen (Guard via warOffen), nicht auf
  // jede Änderung von ui.historieEintraege/ui.historieDeskId/desktop.deskId. Alle diese
  // Lese-Zugriffe sind daher bewusst in untrack() gekapselt: laedt() schreibt
  // historieEintraege — ohne untrack wäre es eine Dependency dieses Effekts, und jedes
  // "Mehr laden" bzw. jeder erfolgreiche Reload würde den Effekt erneut auslösen. Dabei
  // würde vorherFokussiert mit dem inzwischen fokussierten Schließen-Knopf überschrieben
  // (Fokusrückgabe kaputt) und die Liste bei jedem Nachladen auf die alte Scroll-Position
  // zurückspringen. Der einzige getrackte Read bleibt ui.historieOffen.
  $effect(() => {
    if (!ui.historieOffen) { warOffen = false; return; }
    if (warOffen) return;
    warOffen = true;
    vorherFokussiert = document.activeElement as HTMLElement | null;
    queueMicrotask(() => schliessenKnopf?.focus());
    untrack(() => {
      const deskId = desktop.deskId;
      const ruecksprung = ui.historieNachSprung && ui.historieDeskId === deskId && ui.historieEintraege.length > 0;
      ui.historieNachSprung = false;
      ui.historieDeskId = deskId;
      if (ruecksprung) {
        queueMicrotask(() => { if (liste) liste.scrollTop = ui.historieScroll; });
      } else {
        ui.historieEintraege = [];
        void laedt();
      }
    });
  });
</script>

{#if ui.historieOffen}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="hintergrund" onclick={schliessen}></div>
  <div class="overlay" role="dialog" aria-modal="true" aria-label="Historie" tabindex="-1" onkeydown={fokusFalle}>
    <header>
      <h2>Historie</h2>
      <button class="schliessen" bind:this={schliessenKnopf} onclick={schliessen} aria-label="Historie schließen">✕</button>
    </header>

    <div class="liste" bind:this={liste}>
      {#each eintraege as e, i (e.id)}
        {#if i === 0 || tag(eintraege[i - 1].zeit) !== tag(e.zeit)}
          <div class="tag">{tag(e.zeit)}</div>
        {/if}
        {#if e.ziel}
          <button class="eintrag klickbar" onclick={() => springen(e)}>
            <span class="zeit">{uhrzeit(e.zeit)}</span>
            <span class="wer">{e.akteur}</span>
            <span class="was">{e.text}</span>
            {#if e.zitat}<span class="zitat">„{e.zitat}"</span>{/if}
            <span class="pfeil" aria-hidden="true">→</span>
          </button>
        {:else}
          <div class="eintrag">
            <span class="zeit">{uhrzeit(e.zeit)}</span>
            <span class="wer">{e.akteur}</span>
            <span class="was">{e.text}</span>
            {#if e.zitat}<span class="zitat">„{e.zitat}"</span>{/if}
          </div>
        {/if}
      {:else}
        {#if !laden && !fehler}
          <p class="leer">Auf diesem Schreibtisch wurde noch nichts festgehalten.</p>
        {/if}
      {/each}

      {#if fehler}
        <div class="fehler">
          <p>{fehler}</p>
          <button onclick={() => laedt(letzterModus)}>Erneut versuchen</button>
        </div>
      {/if}

      {#if eintraege.length > 0 && !fehler}
        <button class="mehr" onclick={() => laedt(true)} disabled={laden || desktop.status !== 'online'}>
          {laden ? 'Lädt …' : 'Mehr laden'}
        </button>
      {/if}
    </div>
  </div>
{/if}

<svelte:window onkeydown={(ev) => { if (ev.key === 'Escape' && ui.historieOffen) schliessen(); }} />

<style>
  .hintergrund { position: fixed; inset: 0; background: rgba(8, 20, 35, .35); z-index: 9750; }
  .overlay {
    position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
    width: min(560px, 92vw); max-height: min(70vh, 640px); display: flex; flex-direction: column;
    z-index: 9760; border-radius: 16px; padding: 0 0 8px;
    background: var(--glass-panel-bg, rgba(255, 255, 255, .82));
    color: var(--glass-text);
    backdrop-filter: var(--glass-blur-panel); -webkit-backdrop-filter: var(--glass-blur-panel);
    box-shadow: 0 18px 48px rgba(0, 0, 0, .28);
  }
  header { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px 8px; }
  h2 { margin: 0; font-size: 15px; font-weight: 600; }
  .schliessen { border: 0; background: transparent; font-size: 15px; cursor: pointer; padding: 4px 8px; }
  .liste { overflow-y: auto; padding: 0 8px; }
  .tag { position: sticky; top: 0; padding: 6px 8px; font-size: 11px; text-transform: uppercase;
         letter-spacing: .04em; opacity: .6; background: inherit; }
  .eintrag { display: grid; grid-template-columns: auto auto 1fr auto; gap: 8px; align-items: baseline;
             width: 100%; text-align: left; padding: 7px 8px; border: 0; background: transparent;
             border-radius: 8px; font: inherit; }
  .klickbar { cursor: pointer; }
  .klickbar:hover, .klickbar:focus-visible { background: rgba(120, 160, 210, .18); }
  .zeit { font-variant-numeric: tabular-nums; opacity: .6; font-size: 12px; }
  .wer { font-weight: 600; font-size: 13px; }
  .was { font-size: 13px; }
  .zitat { grid-column: 3 / -1; font-size: 12px; opacity: .7; font-style: italic; }
  .pfeil { opacity: .45; }
  .leer, .fehler { padding: 18px 10px; font-size: 13px; opacity: .75; }
  .mehr { display: block; width: calc(100% - 16px); margin: 8px; padding: 8px; border-radius: 8px;
          border: 1px solid rgba(0, 0, 0, .12); background: transparent; cursor: pointer; font: inherit; }
  .mehr:disabled { opacity: .5; cursor: default; }
</style>
