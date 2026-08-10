<script lang="ts">
  import { onMount } from 'svelte';
  import { ApiClient, ApiError } from '../api';
  import { saveSession, type Session } from '../session';
  import { setJlVersionIncompatible } from '../ui.svelte';

  let {
    onConnected,
  }: { onConnected: (s: Session, opts?: { skipVersionCheck?: boolean }) => Promise<void> } =
    $props();

  let username = $state('');
  let password = $state('');
  let needsSetup = $state<boolean | null>(null);
  let error = $state('');
  let busy = $state(false);

  let modus = $state<'laden' | 'wahl' | 'eigenstaendig' | 'jlawyer' | 'anmelden' | 'fertig'>(
    'laden',
  );
  let jlUrl = $state('');
  let jlTest = $state<{ ok: boolean; message: string } | null>(null);
  let jlBusy = $state(false);

  // OPS-01: hält fest, dass die laufende Sitzung durch die Ersteinrichtung kam (Moduswahl oder
  // Konto-Anlage) — ohne diesen Merker bekäme auch die alltägliche Anmeldung an einem längst
  // eingerichteten Server den neuen Abschluss-Schritt, was die UI-SPEC ausdrücklich ausschließt.
  // Er ist zugleich der Grund, warum der j-lawyer-Weg funktioniert: dort endet die Einrichtung
  // technisch mit einer normalen Anmeldung (speichereJl() wechselt modus zu 'anmelden'), die aber
  // inhaltlich noch zum Assistenten gehört — der Merker überdauert diesen Moduswechsel.
  let kamDurchEinrichtung = $state(false);
  // OPS-01: Sitzung + Option zum Überspringen der zweiten Versionsprüfung müssen den
  // Abschluss-Schritt überdauern; sie werden hier festgehalten und beim Klick auf „Zum
  // Schreibtisch" unverändert an die Übergabe weitergereicht (zumSchreibtisch()).
  let pendingSession = $state<{ session: Session; opts: { skipVersionCheck: boolean } } | null>(
    null,
  );
  let fertigKnopf = $state<HTMLButtonElement | undefined>();

  // OPS-01: aus dem Modus abgeleitet statt als eigener Zähler mitgeführt — der Assistent erlaubt
  // „Zurück zur Moduswahl" (modus springt zurück auf 'wahl'); ein separat hochgezählter Zähler
  // würde dabei aus dem Takt geraten. Erscheint nur in den drei Einrichtungsschritten, nicht bei
  // der Anmeldung und nicht im Abschluss-Schritt (der trägt seinen eigenen Titel).
  let schrittHinweis = $derived(
    modus === 'wahl'
      ? 'Schritt 1 von 2 · Betriebsmodus wählen'
      : modus === 'eigenstaendig'
        ? 'Schritt 2 von 2 · Konto anlegen'
        : modus === 'jlawyer'
          ? 'Schritt 2 von 2 · Mit j-lawyer verbinden'
          : null,
  );

  onMount(() => void checkServer());

  $effect(() => {
    // OPS-01: der Abschluss-Knopf wird beim Erscheinen fokussiert, damit der Assistent ohne Maus
    // abschließbar bleibt.
    if (modus === 'fertig') fertigKnopf?.focus();
  });

  async function checkServer(): Promise<void> {
    error = '';
    try {
      const s = await new ApiClient().status();
      needsSetup = s.needsSetup;
      modus = s.needsModeChoice ? 'wahl' : s.needsSetup ? 'eigenstaendig' : 'anmelden';
      if (modus === 'wahl' || modus === 'eigenstaendig') kamDurchEinrichtung = true;
    } catch {
      error = 'Server nicht erreichbar — später erneut versuchen';
    }
  }

  async function testeJlUrl(): Promise<void> {
    jlBusy = true;
    jlTest = null;
    try {
      jlTest = await new ApiClient().setupJlawyerTest(jlUrl.trim());
    } catch (e) {
      jlTest = { ok: false, message: e instanceof ApiError ? e.message : 'Prüfung fehlgeschlagen' };
    } finally {
      jlBusy = false;
    }
  }

  async function speichereJl(): Promise<void> {
    jlBusy = true;
    error = '';
    try {
      await new ApiClient().setupJlawyer(jlUrl.trim());
      // Der Server baut sich neu auf — Status pollen, bis der j-lawyer-Modus antwortet.
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 500));
        try {
          const s = await new ApiClient().status();
          if (s.mode === 'jlawyer') {
            needsSetup = false;
            modus = 'anmelden';
            jlBusy = false;
            return;
          }
        } catch {
          // Server gerade im Rebuild — weiter pollen
        }
      }
      error = 'Server meldet den j-lawyer-Modus nicht — Seite neu laden';
    } catch (e) {
      error = e instanceof ApiError ? e.message : 'Speichern fehlgeschlagen';
    }
    jlBusy = false;
  }

  async function submit(): Promise<void> {
    busy = true;
    error = '';
    try {
      if (needsSetup === null) await checkServer();
      const api = new ApiClient();
      if (needsSetup) {
        await api.setup(username, password);
      } else {
        // REF-03: nur bei tatsächlicher Abweichung ('inkompatibel') das Banner auslösen —
        // 'unbestimmt' (Ermittlung fehlgeschlagen) und 'kompatibel' bleiben bannerfrei
        // (Normalfall/Spike-Fallback-Entscheidung, nicht login-blockierend).
        const jlVersion = await api.login(username, password);
        setJlVersionIncompatible(jlVersion === 'inkompatibel');
      }
      // name: die Telefon-Aufgabenliste (MOBILE-02, 11-09) filtert auf den eigenen
      // Verantwortlichen — der angemeldete Name wird deshalb mit der Sitzung gemerkt.
      const session = { token: api.token!, name: username };
      saveSession(session);
      // WR-06: api.login() hat das Versionskompatibilitäts-Banner oben bereits aus DERSELBEN
      // Anmeldeantwort korrekt gesetzt — die Übergabe soll das nicht durch eine zweite,
      // unabhängige Anfrage (die bei transientem Fehlschlag 'unbestimmt' liefern und den
      // Banner-Zustand stillschweigend überschreiben könnte) redundant erneut ermitteln.
      pendingSession = { session, opts: { skipVersionCheck: true } };
      if (kamDurchEinrichtung) {
        // OPS-01: läuft eine Ersteinrichtung, wird die Übergabe zurückgehalten und der
        // Abschluss-Schritt gezeigt, statt sofort weiterzuschalten.
        modus = 'fertig';
      } else {
        // Alltags-Anmeldung an einem bereits eingerichteten Server: unverändert ohne
        // Zwischenschritt, derselbe einzige Übergabeaufruf wie zuvor (siehe zumSchreibtisch()).
        await zumSchreibtisch();
      }
    } catch (e) {
      error = e instanceof ApiError ? e.message : 'Verbindung fehlgeschlagen';
    } finally {
      busy = false;
    }
  }

  async function zumSchreibtisch(): Promise<void> {
    if (!pendingSession) return;
    const { session, opts } = pendingSession;
    await onConnected(session, opts);
  }
</script>

<div class="wrap bg-mesh">
  <form class="card glass-elevated" onsubmit={(e) => { e.preventDefault(); void submit(); }}>
    <img class="logo" src="/j-desk-icon-256.png" alt="" width="72" height="72" />
    <h1>J-Desk</h1>
    {#if schrittHinweis}<p class="schritt">{schrittHinweis}</p>{/if}
    {#if modus === 'wahl'}
      <p class="hint">Wie soll J-Desk arbeiten? Die Wahl gilt dauerhaft für diesen Server.</p>
      <button type="button" class="moduskarte" onclick={() => (modus = 'eigenstaendig')}>
        <strong>Eigenständig</strong>
        <span>J-Desk verwaltet Konten und Dokumente selbst.</span>
      </button>
      <button type="button" class="moduskarte" onclick={() => (modus = 'jlawyer')}>
        <strong>Mit j-lawyer verbinden</strong>
        <span>j-lawyer ist die Dokumentquelle; Anmeldung mit j-lawyer-Konten.</span>
      </button>
    {:else if modus === 'jlawyer'}
      <p class="hint">Adresse des j-lawyer-Servers (z. B. https://kanzlei:8080/j-lawyer-io)</p>
      <label>j-lawyer-URL <input bind:value={jlUrl} placeholder="http://…/j-lawyer-io" /></label>
      {#if jlTest}<p class={jlTest.ok ? 'hint' : 'error'}>{jlTest.message}</p>{/if}
      {#if error}<p class="error">{error}</p>{/if}
      <div class="reihe">
        <button type="button" class="zweit" onclick={() => { modus = 'wahl'; jlTest = null; }}>Zurück</button>
        <button type="button" class="zweit" disabled={jlBusy || !jlUrl.trim()} onclick={() => void testeJlUrl()}>
          Verbindung testen
        </button>
      </div>
      <button type="button" disabled={jlBusy || !jlTest?.ok} onclick={() => void speichereJl()}>
        {jlBusy ? 'Speichere…' : 'Speichern & verbinden'}
      </button>
    {:else if modus === 'eigenstaendig' || modus === 'anmelden'}
      {#if modus === 'eigenstaendig'}
        <p class="hint">Ersteinrichtung: Lege das erste Konto an (Passwort min. 8 Zeichen).</p>
      {/if}
      <label>Benutzername <input bind:value={username} autocomplete="username" /></label>
      <label>Passwort <input type="password" bind:value={password} autocomplete="current-password" /></label>
      {#if error}<p class="error">{error}</p>{/if}
      <button disabled={busy || !username || !password}>
        {needsSetup ? 'Konto anlegen' : 'Anmelden'}
      </button>
      {#if modus === 'eigenstaendig' && needsSetup}
        <button type="button" class="zweit" onclick={() => (modus = 'wahl')}>Zurück zur Moduswahl</button>
      {/if}
    {:else if modus === 'fertig'}
      <p class="fertig-titel">Einrichtung abgeschlossen</p>
      <p class="fertig-text">J-Desk ist betriebsbereit. Sie sind als „{username}" angemeldet.</p>
      <button type="button" bind:this={fertigKnopf} onclick={() => void zumSchreibtisch()}>
        Zum Schreibtisch
      </button>
    {/if}
  </form>
</div>

<style>
  .wrap { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; }
  .card { display: flex; flex-direction: column; gap: 12px; width: 320px; padding: 32px 28px;
          border-radius: 18px; }
  .logo { align-self: center; margin-bottom: 2px; }
  h1 { margin: 0 0 4px; font-size: 22px; text-align: center; color: var(--brand-navy);
       letter-spacing: -0.01em; }
  label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: var(--glass-text); }
  input { padding: 8px 10px; border: 1px solid var(--glass-separator); border-radius: 8px;
          background: rgba(255, 255, 255, .7); font: inherit; }
  input:focus-visible { outline: 2px solid var(--brand-blue); outline-offset: 0; }
  .hint { margin: 0; font-size: 12px; color: var(--brand-blue); }
  .error { margin: 0; font-size: 12px; color: var(--brand-red); }
  /* OPS-01: Fortschritts-Hinweis — schlanke Variante von .hint (12px Label-Rolle unverändert),
     kein neuer Farbwert (--glass-text-secondary ist bereits in .moduskarte span im Einsatz). */
  .schritt { margin: 0; font-size: 12px; color: var(--glass-text-secondary); text-align: center; }
  /* OPS-01: Abschluss-Schritt — reine Wiederverwendung bestehender Typografiestufen (Heading
     15px/600, Body 13px), kein neuer Farbwert, kein neuer Kartenstil. */
  .fertig-titel { margin: 0; font-size: 15px; font-weight: 600; color: var(--brand-navy);
                  text-align: center; }
  .fertig-text { margin: 0; font-size: 13px; color: var(--glass-text); text-align: center; }
  button { padding: 9px; border: none; border-radius: 9px; background: var(--brand-navy); color: #fff;
           font-size: 14px; cursor: pointer; }
  button:hover:enabled { background: var(--brand-navy-hover); }
  button:disabled { opacity: .5; cursor: default; }

  .moduskarte { display: flex; flex-direction: column; gap: 2px; text-align: left; padding: 12px 14px;
                border: 1px solid var(--glass-separator); border-radius: 10px;
                background: rgba(255, 255, 255, .7); cursor: pointer; font: inherit; }
  .moduskarte:hover { border-color: var(--brand-blue); background: #fff; }
  .moduskarte strong { color: var(--brand-navy); font-size: 14px; }
  .moduskarte span { font-size: 12px; color: var(--glass-text-secondary); }
  .reihe { display: flex; gap: 8px; }
  .zweit { background: rgba(255, 255, 255, .7); color: var(--brand-navy);
           border: 1px solid var(--glass-separator); }
  .zweit:hover:enabled { background: #fff; }
  .reihe .zweit { flex: 1; }
</style>
