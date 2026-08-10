<script lang="ts">
  import type { Command } from '@j-desk/core';
  import { desktop } from '../store.svelte';
  import { ui } from '../ui.svelte';
  import { TEXTE } from '../history';

  let vorherFokussiert: HTMLElement | null = null;
  let schliessenKnopf = $state<HTMLButtonElement | null>(null);
  let warOffen = false;

  /** Klartext der eigenen, abgewiesenen Änderung — dieselbe Übersetzung wie in der Historie,
      keine zweite Tabelle dafür. */
  function beschreibeCommand(cmd: Command): string {
    return TEXTE[cmd.type] ?? 'Änderung';
  }

  /** Grobe, gut lesbare Zeitspanne seit einem ISO-Zeitpunkt. */
  function zeitspanne(am: string | null): string {
    if (!am) return 'kürzlich';
    const minuten = Math.round((Date.now() - new Date(am).getTime()) / 60_000);
    if (minuten < 1) return 'gerade eben';
    if (minuten === 1) return 'vor einer Minute';
    if (minuten < 60) return `vor ${minuten} Minuten`;
    const stunden = Math.round(minuten / 60);
    return stunden === 1 ? 'vor einer Stunde' : `vor ${stunden} Stunden`;
  }

  /** Liegt das umstrittene Objekt (gleich welcher Art) derzeit im Papierkorb? */
  const imPapierkorb = $derived.by(() => {
    const id = ui.konflikt?.konflikt.objektId;
    if (!id) return false;
    return (desktop.state.trash ?? []).some(
      (t) =>
        t.payload.docs.some((d) => d.id === id) ||
        t.payload.notes.some((n) => n.id === id) ||
        t.payload.cutouts.some((c) => c.id === id) ||
        t.payload.stacks.some((s) => s.id === id),
    );
  });

  function verwerfen(): void {
    // Der lokale Zustand ist bereits der des Servers (Store hat die optimistische
    // Anwendung zurückgenommen und neu geladen) — schließen reicht.
    ui.konflikt = null;
    vorherFokussiert?.focus();
  }

  function durchsetzen(): void {
    const eintrag = ui.konflikt;
    if (!eintrag) return;
    ui.konflikt = null;
    vorherFokussiert?.focus();
    // desktop.command() leitet die Erwartung selbst aus dem aktuellen (bereits
    // aktualisierten) Zustand ab — dort steht die neue Version schon. Kein zweiter Weg
    // zum Senden nötig, nur der Wiederholungspfad von behandleKonflikt().
    void desktop.command(eintrag.cmd.type, eintrag.cmd.payload);
  }

  function danebenLegen(): void {
    const eintrag = ui.konflikt;
    if (!eintrag || eintrag.cmd.type !== 'editNote') return;
    const original = desktop.state.notes?.find((n) => n.id === eintrag.konflikt.objektId);
    const text = eintrag.cmd.payload?.text;
    ui.konflikt = null;
    vorherFokussiert?.focus();
    void desktop.command('addNote', {
      kind: original?.kind ?? 'notiz',
      text,
      position: original ? { x: original.position.x + 24, y: original.position.y + 24 } : { x: 0, y: 0 },
    });
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

  $effect(() => {
    if (!ui.konflikt) { warOffen = false; return; }
    if (warOffen) return;
    warOffen = true;
    vorherFokussiert = document.activeElement as HTMLElement | null;
    queueMicrotask(() => schliessenKnopf?.focus());
  });
</script>

{#if ui.konflikt}
  {@const k = ui.konflikt.konflikt}
  {@const cmd = ui.konflikt.cmd}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="hintergrund" onclick={verwerfen}></div>
  <div class="overlay" role="dialog" aria-modal="true" aria-label="Gleichzeitig bearbeitet" tabindex="-1" onkeydown={fokusFalle}>
    <header>
      <h2>Gleichzeitig bearbeitet</h2>
      <button class="schliessen" bind:this={schliessenKnopf} onclick={verwerfen} aria-label="Meldung schließen">✕</button>
    </header>

    <p>
      {#if k.art === 'geloescht'}
        Dieses Objekt wurde zwischenzeitlich gelöscht.
        {#if imPapierkorb}Es liegt im Papierkorb und lässt sich von dort wiederherstellen.{/if}
      {:else}
        {k.von ?? 'Jemand'} hat dieses Objekt {zeitspanne(k.am)} geändert.
      {/if}
    </p>

    <p class="was">Ihre Änderung: {beschreibeCommand(cmd)}</p>

    <div class="wahl">
      {#if k.art !== 'geloescht'}
        <button class="primaer" onclick={durchsetzen}>Meine Änderung übernehmen</button>
        {#if cmd.type === 'editNote'}
          <button onclick={danebenLegen}>Beides behalten</button>
        {/if}
      {/if}
      <button onclick={verwerfen}>Meine Änderung verwerfen</button>
    </div>
  </div>
{/if}

<svelte:window onkeydown={(ev) => { if (ev.key === 'Escape' && ui.konflikt) verwerfen(); }} />

<style>
  .hintergrund { position: fixed; inset: 0; background: rgba(8, 20, 35, .35); z-index: 9750; }
  .overlay {
    position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
    width: min(420px, 92vw); display: flex; flex-direction: column; gap: 10px;
    z-index: 9760; border-radius: 16px; padding: 14px 16px 16px;
    background: var(--glass-panel-bg, rgba(255, 255, 255, .82));
    color: var(--glass-text);
    backdrop-filter: var(--glass-blur-panel); -webkit-backdrop-filter: var(--glass-blur-panel);
    box-shadow: 0 18px 48px rgba(0, 0, 0, .28);
  }
  header { display: flex; align-items: center; justify-content: space-between; }
  h2 { margin: 0; font-size: 15px; font-weight: 600; }
  .schliessen { border: 0; background: transparent; font-size: 15px; cursor: pointer; padding: 4px 8px; }
  p { margin: 0; font-size: 13px; line-height: 1.5; }
  .was { opacity: .8; font-style: italic; }
  .wahl { display: flex; flex-direction: column; gap: 8px; margin-top: 4px; }
  .wahl button {
    padding: 9px 12px; border-radius: 8px; border: 1px solid var(--glass-border);
    background: transparent; color: var(--glass-text); cursor: pointer; font: inherit; text-align: left;
  }
  .wahl button:hover { background: var(--glass-hover); }
  .wahl button:active { background: var(--glass-active); }
  .wahl .primaer { background: var(--brand-blue); color: #fff; border-color: transparent; }
  .wahl .primaer:hover { background: var(--brand-blue); opacity: .9; }
</style>
