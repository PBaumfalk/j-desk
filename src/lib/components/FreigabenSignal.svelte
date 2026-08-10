<script lang="ts">
  import { zaehler, zaehlerText } from '../freigaben.svelte';
  import { ui } from '../ui.svelte';
</script>

<!-- Freigaben-Signal (AI-01, 12-UI-SPEC Komponentenkontrakt E1):
     - Lärm-Regel: der Button erscheint/verschwindet fail-quiet — keine Benachrichtigung, kein
       Banner, kein Blinken; der ständige Einstieg (auch bei 0) ist der DeskSwitcher-Menüeintrag.
     - E1/loading: KEIN eigener Ladepfad/Spinner — der Zähler kommt aus dem mit dem Desk
       geladenen bzw. per WS gepflegten freigaben-Zustand (pendingCount-Präzedenz).
     - E1/error: ein nicht bestimmbarer Zählerstand fällt unter das bestehende
       Verbindungsbanner (banner.ts) — diese Komponente hat keinen eigenen Fehlerzustand.
     - Kein eigener Farbwert, kein Accent: das 🤖 trägt die Semantik (Label-Fallback-Pflicht:
       Icon+Text-Paar, UI-SPEC Design System). -->
{#if zaehler() >= 1}
  <button
    class="freigaben-signal"
    onclick={() => (ui.vorschlaegeOffen = true)}
    title={`${zaehler()} KI-Vorschlag/-Vorschläge warten auf Prüfung`}
  >
    🤖 Freigaben ({zaehlerText()})
  </button>
{/if}

<style>
  /* Optik verbatim aus Desktop.svelte `.toolbar button` übernommen (Svelte-Style-Scoping
     überschreitet keine Komponentengrenzen — dieselbe Begründung wie .praesenz-current in
     PresenceRoster.svelte); kein eigener Farbwert, kein Accent. */
  .freigaben-signal { font-size: 13px; padding: 6px 12px; border-radius: 8px;
                      border: 1px solid var(--glass-border);
                      background: var(--glass-card-bg); color: var(--glass-text);
                      backdrop-filter: var(--glass-blur-card); -webkit-backdrop-filter: var(--glass-blur-card);
                      cursor: pointer; box-shadow: var(--glass-shadow); }
  .freigaben-signal:hover { background: var(--glass-elevated-bg); }
</style>
