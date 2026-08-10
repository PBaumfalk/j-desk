<script lang="ts">
  import { onMount } from 'svelte';
  import Desktop from '../lib/components/Desktop.svelte';
  import SmartphoneSchnellzugriff from '../lib/components/SmartphoneSchnellzugriff.svelte';
  import LoginScreen from '../lib/components/LoginScreen.svelte';
  import { desktop } from '../lib/store.svelte';
  import { geraeteProfil } from '../lib/deviceProfile.svelte';
  import { ApiClient, ApiError } from '../lib/api';
  import { loadSession, clearSession, type Session } from '../lib/session';
  import { setJlVersionIncompatible } from '../lib/ui.svelte';
  import { readSnapshot } from '../lib/snapshot';

  let phase = $state<'loading' | 'login' | 'desk'>('loading');

  async function connect(
    session: Session,
    opts: { skipVersionCheck?: boolean } = {},
  ): Promise<void> {
    const api = new ApiClient('', session.token);
    // REF-03 (WR-03): Session-Wiederherstellung ruft api.login() nicht auf, deshalb hier separat
    // anstoßen — parallel zum Desk-Laden und nicht blockierend (wie beim Login: ein Fehlschlag
    // hier darf den Verbindungsaufbau nicht verzögern oder verhindern).
    // WR-06: Beim expliziten Login (LoginScreen.svelte submit()) hat api.login() das Banner
    // bereits synchron und korrekt aus derselben Anmeldeantwort gesetzt — dieser Aufruf hier
    // wäre dann eine zweite, unabhängige Anfrage, die den soeben korrekten Zustand bei einem
    // rein transienten Fehlschlag (Server liefert 'unbestimmt') wieder überschreiben könnte
    // (ui.jlVersionIncompatible kennt kein Upgrade-only-Merge). Deshalb hier übersprungen.
    if (!opts.skipVersionCheck) {
      void api
        .status()
        .then((s) => {
          if (s.jlVersion !== undefined) setJlVersionIncompatible(s.jlVersion === 'inkompatibel');
        })
        .catch(() => {});
    }
    await desktop.start(api, session.lastDeskId);
    phase = 'desk';
  }

  onMount(async () => {
    window.addEventListener('contextmenu', (e) => e.preventDefault());
    const session = loadSession();
    if (!session) {
      phase = 'login';
      return;
    }
    // SAFE-01 (D-04): Cache-First-Boot — der zuletzt bestätigte Schreibtisch-Zustand
    // erscheint sofort, BEVOR die Server-Antwort da ist. Kein leerer Tisch, kein
    // Dauer-Ladebildschirm bei einem nicht erreichbaren Server.
    let cacheGerendert = false;
    if (session.lastDeskId) {
      const cached = await readSnapshot(session.lastDeskId);
      if (cached) {
        desktop.hydrateFromCache(cached.deskId, cached.rev, cached.state);
        phase = 'desk';
        cacheGerendert = true;
      }
    }
    try {
      await connect(session);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        clearSession();
        phase = 'login';
      } else if (!cacheGerendert) {
        phase = 'login';
      }
      // Netzfehler mit gerendertem Cache: phase bleibt 'desk' — der gecachte Schreibtisch
      // bleibt sichtbar, während der Verbindungsstatus 'offline'/'connecting' anzeigt.
    }
  });
</script>

{#if phase === 'login'}
  <LoginScreen onConnected={connect} />
{:else if phase === 'desk'}
  <!-- MOBILE-01/02 (11-09): ausschließende Rendering-Weiche — zu jedem Zeitpunkt ist genau
       eine Profil-Oberfläche gemountet (E5/zero-one-many), nie beide gleichzeitig. Das
       wirksame Profil ist während einer laufenden Sitzung eingefroren (deviceProfile.svelte). -->
  {#if geraeteProfil.wirksam === 'smartphone'}
    <SmartphoneSchnellzugriff />
  {:else}
    <Desktop onlogout={() => (phase = 'login')} />
  {/if}
{/if}

<style>
  :global(html, body) { margin: 0; height: 100%; overflow: hidden; }
</style>
