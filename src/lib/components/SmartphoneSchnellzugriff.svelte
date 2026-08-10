<script lang="ts">
  import { naechsteKaskadenPosition, type LegalObject } from '@j-desk/core';
  import { desktop, darfAktionClient } from '../store.svelte';
  import { uid } from '../uid';
  import { ladeDateiHoch } from '../upload';
  import { telefonAufgaben, darfAbhaken, statusLesetext, aufgabenHerkunft } from '../telefonAufgaben';
  import { profilLabel, profilMenuZeilen, type ProfilAuswahl } from '../deviceProfile';
  import { geraeteProfil, setzeProfilAuswahl } from '../deviceProfile.svelte';
  import { loadSession } from '../session';
  import { bannerText, bannerSichtbar } from '../banner';
  import KonfliktOverlay from './KonfliktOverlay.svelte';

  /**
   * Smartphone-Schnellzugriff (MOBILE-02, 11-09 Task 2): bewusst KEINE volle Oberfläche — eine
   * eigenständige Hülle über die volle Bildschirmbreite ohne Canvas und ohne Desktop.svelte.
   * Genau vier feste Kacheln (E4/zero-one-many): Aufgaben, Fotografieren/Hochladen, Diktieren,
   * Schreibtischliste. Jede angebotene Aktion läuft über einen serverseitig geprüften
   * Bestandspfad (T-11-02b): Upload über das gemeinsame Modul (T-11-02), Abhaken und
   * Notizanlage über unveränderte Bestands-Kommandos — keine neue Server-Route, keine
   * clientseitige Rechteprüfung, keine laxere Berechtigungsschicht fürs Telefon.
   * WR-04 (11-REVIEW): die Foto-Kachel wird Rollen ohne Upload-Recht vollständig ausgeblendet
   * (PERM-04-Decision „ausgeblendet, nicht ausgegraut", dasselbe darfAktionClient-Gate wie
   * „Datei…" am Tisch) — der Server bleibt trotzdem die eigentliche 403-Sicherheitsgrenze.
   */

  /** Angemeldeter Name für die Aufgaben-Zuordnung; fehlt er (Altsitzung), zeigt die Liste nur
   *  unverantwortete Aufgaben (fail-open, siehe session.ts). */
  const nutzerName = loadSession()?.name ?? '';

  type Kachel = 'aufgaben' | 'foto' | 'diktat' | 'schreibtische';
  let offeneKachel = $state<Kachel | null>(null);
  let profilOffen = $state(false);
  let detailId = $state<string | null>(null);
  let fotoInput = $state<HTMLInputElement | null>(null);
  let laedtHoch = $state(false);
  let diktatText = $state('');

  const deskName = $derived(desktop.desks.find((d) => d.id === desktop.deskId)?.name ?? '');
  const aufgaben = $derived(telefonAufgaben(desktop.state, nutzerName));
  const detailAufgabe = $derived(detailId ? (aufgaben.find((a) => a.id === detailId) ?? null) : null);
  const detailHerkunft = $derived(detailAufgabe ? aufgabenHerkunft(desktop.state, detailAufgabe) : null);
  const profilZeilen = $derived(profilMenuZeilen(geraeteProfil.auswahl, geraeteProfil.erkannt));

  function kachelUmschalten(k: Kachel): void {
    offeneKachel = offeneKachel === k ? null : k;
    profilOffen = false;
    detailId = null;
  }

  /** Fälligkeit in deutscher Punktschreibweise (TT.MM.JJJJ) — Muster LegalObjectCard.svelte. */
  function formatFaelligkeit(dueDate: string): string {
    return new Date(dueDate).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }

  /** Häkchen schaltet nur zwischen offen und erledigt um (T-11-22: kein stilles Überschreiben
   *  eines Zwischenstands eines anderen Geräts — in-arbeit/uebergeben tragen kein Bedienelement). */
  function hakenUmschalten(a: LegalObject): void {
    void desktop.command('setTaskStatus', { id: a.id, status: a.status === 'erledigt' ? 'offen' : 'erledigt' });
  }

  /** Upload über exakt denselben Pfad wie der Tisch (T-11-02) — auf dem Telefon existiert kein
   *  Weltausschnitt, deshalb dieselbe feste Ersatzkoordinate samt Kaskadenversatz, die auch
   *  Sitzungsnotizen verwenden. WR-01: naechsteKaskadenPosition statt naechsteSitzungsnotizPosition —
   *  Foto-Uploads sind Docs und würden sonst nie gezählt, jedes weitere Foto läge deckungsgleich
   *  auf dem ersten Slot. Fehler (inkl. Berechtigungs-Toast) zeigt das gemeinsame Modul. */
  async function fotoGewaehlt(): Promise<void> {
    const datei = fotoInput?.files?.[0];
    if (!fotoInput || !datei) return;
    fotoInput.value = '';
    laedtHoch = true;
    try {
      await ladeDateiHoch(datei, naechsteKaskadenPosition(desktop.state));
    } finally {
      laedtHoch = false;
    }
  }

  /** Diktat als gewöhnliche Notiz über das Bestands-Kommando anlegen. Das Diktat selbst läuft
   *  ausschließlich über das Mikrofon der Betriebssystem-Tastatur — hier entsteht BEWUSST kein
   *  eigener Spracherkennungs- oder Transkriptionscode (UI-SPEC; VOICE-01/Phase 13 baut die
   *  vollwertige In-App-Aufnahme später auf genau diesem Textfeld auf, statt es zu ersetzen).
   *  WR-01: das Kennzeichen sitzungsnotiz schiebt die Kaskade fort (und markiert das Diktat als
   *  mobil erfasst) — ohne es lägen alle Diktate deckungsgleich auf dem ersten Slot. */
  function diktatSpeichern(): void {
    const text = diktatText; // unverändert — ohne Kürzung (E4/long-text)
    if (text.trim().length === 0) return;
    diktatText = '';
    void desktop.command('addNote', {
      kind: 'notiz',
      text,
      position: naechsteKaskadenPosition(desktop.state),
      id: uid(),
      sitzungsnotiz: true,
    });
  }

  /** Auswahl über die reaktive Hülle: persistiert UND schaltet die Rendering-Weiche sofort um
   *  (11-09 Task 3) — wählt die Nutzerin hier „Desktop erzwingen", unmountet sich diese Hülle. */
  function profilWaehlen(wert: ProfilAuswahl): void {
    setzeProfilAuswahl(wert);
    profilOffen = false;
  }
</script>

<div class="shell">
  <header class="kopf">
    <h1 class="titel">J-DESK — Schnellzugriff</h1>
    <div class="unterzeile">{deskName}</div>
  </header>

  <main class="kacheln">
    <section class="kachel">
      <button class="kachel-kopf" aria-expanded={offeneKachel === 'aufgaben'} onclick={() => kachelUmschalten('aufgaben')}>
        <span class="kachel-titel">📋 Aufgaben</span>
      </button>
      {#if offeneKachel === 'aufgaben'}
        <div class="kachel-inhalt">
          {#if aufgaben.length === 0}
            <div class="leer">Keine offenen Aufgaben.</div>
          {:else}
            <ul class="aufgaben">
              {#each aufgaben as a (a.id)}
                <li class="aufgabe">
                  <button class="aufgabe-koerper" onclick={() => (detailId = detailId === a.id ? null : a.id)}>
                    <span class="aufgabe-titel">{a.text}</span>
                    {#if a.dueDate}<span class="aufgabe-faellig">Fällig {formatFaelligkeit(a.dueDate)}</span>{/if}
                  </button>
                  {#if darfAbhaken(a.status)}
                    <label class="haken" title={a.status === 'erledigt' ? 'Wieder öffnen' : 'Erledigt abhaken'}>
                      <input
                        type="checkbox"
                        checked={a.status === 'erledigt'}
                        aria-label={`Aufgabe „${a.text}" ${a.status === 'erledigt' ? 'wieder öffnen' : 'abhaken'}`}
                        onchange={() => hakenUmschalten(a)} />
                    </label>
                  {:else}
                    <span class="lesetext">{statusLesetext(a.status)}</span>
                  {/if}
                </li>
                {#if detailId === a.id && detailAufgabe}
                  <li class="detail">
                    <div class="detail-titel">{detailAufgabe.text}</div>
                    {#if detailAufgabe.dueDate}
                      <div class="detail-zeile">Fällig {formatFaelligkeit(detailAufgabe.dueDate)}</div>
                    {/if}
                    {#if detailHerkunft}
                      <div class="detail-zeile">📄 {detailHerkunft.dokumentName} · Seite {detailHerkunft.seite}</div>
                      {#if detailHerkunft.zitat}
                        <blockquote class="zitat">{detailHerkunft.zitat}</blockquote>
                      {/if}
                    {/if}
                    <!-- Kein leerer Zitatbereich: liefert aufgabenHerkunft kein Zitat (Mehrzahl der
                         Aufgaben trägt keinen Ausschnittbezug, T-11-23), erscheinen ausschließlich
                         Dokumentname und Seite. Ein PDF wird hier nie gerendert. -->
                  </li>
                {/if}
              {/each}
            </ul>
          {/if}
        </div>
      {/if}
    </section>

    {#if darfAktionClient(desktop.currentRolle, 'upload')}
    <section class="kachel">
      <button class="kachel-kopf" aria-expanded={offeneKachel === 'foto'} onclick={() => kachelUmschalten('foto')}>
        <span class="kachel-titel">📷 Fotografieren/Hochladen</span>
      </button>
      {#if offeneKachel === 'foto'}
        <div class="kachel-inhalt">
          <!-- Kamera der Umgebung bevorzugt; ob zusätzlich eine Mediathek angeboten wird,
               unterscheidet sich zwischen den Betriebssystemen — der Kacheltext benennt beides
               bewusst als EINE Handlung (11-RESEARCH.md Pitfall 5). -->
          <input
            bind:this={fotoInput}
            class="versteckt"
            type="file"
            accept="image/*"
            capture="environment"
            aria-hidden="true"
            tabindex="-1"
            onchange={() => void fotoGewaehlt()} />
          <button class="aktion" disabled={laedtHoch} onclick={() => fotoInput?.click()}>
            {laedtHoch ? 'Wird hochgeladen …' : 'Kamera öffnen'}
          </button>
        </div>
      {/if}
    </section>
    {/if}

    <section class="kachel">
      <button class="kachel-kopf" aria-expanded={offeneKachel === 'diktat'} onclick={() => kachelUmschalten('diktat')}>
        <span class="kachel-titel">🎤 Diktieren</span>
      </button>
      {#if offeneKachel === 'diktat'}
        <div class="kachel-inhalt">
          <textarea
            class="diktat"
            rows="5"
            placeholder="Diktat über das Mikrofon der Tastatur eingeben …"
            bind:value={diktatText}></textarea>
          <button class="aktion" disabled={diktatText.trim().length === 0} onclick={diktatSpeichern}>
            Als Notiz speichern
          </button>
        </div>
      {/if}
    </section>

    <section class="kachel">
      <button class="kachel-kopf" aria-expanded={offeneKachel === 'schreibtische'} onclick={() => kachelUmschalten('schreibtische')}>
        <span class="kachel-titel">Schreibtisch wechseln</span>
      </button>
      {#if offeneKachel === 'schreibtische'}
        <div class="kachel-inhalt">
          <!-- Reduzierte Liste: nur Namen und Wechseln per Tipp — keine Gestaltung, kein Export,
               kein Import, keine Verwaltung. Kann nicht leer sein (mindestens der aktuelle
               Schreibtisch steht darin, E4/empty). -->
          <ul class="desks">
            {#each desktop.desks as desk (desk.id)}
              <li>
                <button class="desk-zeile" onclick={() => void desktop.switchDesk(desk.id)}>
                  {desk.id === desktop.deskId ? '✓ ' : ''}{desk.name}
                </button>
              </li>
            {/each}
          </ul>
        </div>
      {/if}
    </section>
  </main>

  <footer class="fuss">
    <button class="profil-knopf" aria-expanded={profilOffen} onclick={() => { profilOffen = !profilOffen; offeneKachel = null; }}>
      ⚙ Profil: {profilLabel(geraeteProfil.wirksam)} (ändern)
    </button>
    {#if profilOffen}
      <div class="profil-auswahl" role="menu">
        {#each profilZeilen as zeile (zeile.wert)}
          <button class="profil-zeile" role="menuitem" onclick={() => profilWaehlen(zeile.wert)}>
            {zeile.label}
          </button>
        {/each}
      </div>
    {/if}
  </footer>

  <!-- WR-03 (11-REVIEW): dasselbe Verbindungs-/Wartestand-Banner wie Tisch und Sitzungsmodus-
       Chrome (Modul ../banner) — gerade auf dem Telefon laufen Commands bei schlechter
       Verbindung in die IndexedDB-Warteschlange, ohne Banner bliebe das unsichtbar. -->
  {#if bannerSichtbar(desktop.status, desktop.pendingCount)}
    <div class="banner" role="status" aria-live="polite">{bannerText(desktop.status, desktop.pendingCount)}</div>
  {/if}
</div>

<!-- WR-03 (11-REVIEW): 409-Konflikte (z. B. setTaskStatus von zwei Geräten) setzen ui.konflikt;
     ohne dieses Overlay wurde die optimistische Anwendung still zurückgerollt und der Konflikt
     poppte später kontextlos auf dem Desktop-Profil auf. -->
<KonfliktOverlay />

<style>
  /* E4/overflow: die Hülle scrollt ausschließlich senkrecht — jede Fläche begrenzt ihre Breite
   * so, dass kein waagerechtes Scrollen entstehen kann. */
  .shell {
    position: fixed; inset: 0; z-index: 8000;
    display: flex; flex-direction: column;
    overflow-y: auto; overflow-x: hidden;
    background: var(--glass-panel-bg); color: var(--glass-text);
    backdrop-filter: var(--glass-blur-card); -webkit-backdrop-filter: var(--glass-blur-card);
    box-sizing: border-box;
  }
  .kopf { padding: 16px 16px 8px; }
  .titel { margin: 0; font-size: 15px; font-weight: 600; line-height: 1.3; }
  .unterzeile {
    font-size: 12px; color: var(--glass-text-secondary);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .kacheln {
    flex: 1 1 auto; display: flex; flex-direction: column; gap: 24px;
    padding: 16px; min-width: 0;
  }
  .kachel {
    background: var(--glass-card-bg); border: 1px solid var(--glass-border); border-radius: 12px;
    box-shadow: var(--glass-shadow); overflow: hidden;
  }
  /* SESSION_TOUCH_MIN (UI-SPEC Spacing Exceptions): mindestens 48px Zielgröße. */
  .kachel-kopf {
    display: flex; align-items: center; width: 100%; min-height: 48px; padding: 12px 16px;
    border: none; background: none; color: inherit; cursor: pointer; text-align: left;
  }
  .kachel-kopf:hover { background: var(--glass-hover); }
  /* Display-Typografie für Kacheltitel (UI-SPEC Typography): 18px / 600 / 1.3, mit Ellipsis. */
  .kachel-titel {
    font-size: 18px; font-weight: 600; line-height: 1.3;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .kachel-inhalt { padding: 0 16px 16px; display: flex; flex-direction: column; gap: 12px; min-width: 0; }
  .leer { font-size: 13px; color: var(--glass-text-secondary); padding: 8px 0; }

  .aufgaben { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
  .aufgabe {
    display: flex; align-items: stretch; min-height: 48px; min-width: 0;
    border-top: 1px solid var(--glass-separator);
  }
  .aufgabe:first-child { border-top: none; }
  .aufgabe-koerper {
    flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; justify-content: center;
    gap: 2px; padding: 8px 8px 8px 0; border: none; background: none; color: inherit;
    cursor: pointer; text-align: left;
  }
  /* E4/long-text: Aufgabentitel höchstens zweizeilig, danach Ellipsis. */
  .aufgabe-titel {
    font-size: 18px; font-weight: 600; line-height: 1.3;
    display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical;
    overflow: hidden; overflow-wrap: anywhere;
  }
  .aufgabe-faellig { font-size: 12px; color: var(--glass-text-secondary); }
  .haken {
    flex: 0 0 auto; min-width: 48px; min-height: 48px;
    display: flex; align-items: center; justify-content: center; cursor: pointer;
  }
  .haken input { width: 22px; height: 22px; accent-color: var(--brand-blue); cursor: pointer; }
  .lesetext {
    flex: 0 0 auto; align-self: center; padding: 0 4px;
    font-size: 12px; color: var(--glass-text-secondary); text-align: right;
  }
  .detail {
    padding: 8px 12px 12px; display: flex; flex-direction: column; gap: 6px;
    background: var(--glass-hover); border-radius: 8px; margin: 4px 0 8px;
    overflow-wrap: anywhere;
  }
  .detail-titel { font-size: 13px; font-weight: 600; }
  .detail-zeile { font-size: 12px; color: var(--glass-text-secondary); }
  .zitat {
    margin: 4px 0 0; padding: 8px 10px; border-left: 3px solid var(--brand-blue);
    background: var(--glass-card-bg); border-radius: 6px;
    font-size: 12px; font-style: italic; overflow-wrap: anywhere;
  }

  .versteckt { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
  .aktion {
    min-height: 48px; padding: 10px 16px; border: none; border-radius: 8px;
    background: var(--brand-blue); color: #fff; font: inherit; font-size: 15px; font-weight: 600;
    cursor: pointer;
  }
  .aktion:disabled { opacity: .55; cursor: default; }
  .diktat {
    width: 100%; box-sizing: border-box; padding: 10px 12px;
    border: 1px solid var(--glass-separator); border-radius: 8px;
    background: var(--glass-input-bg); color: var(--glass-text);
    font: inherit; font-size: 15px; resize: vertical;
  }

  .desks { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
  .desk-zeile {
    width: 100%; min-height: 48px; padding: 10px 8px; border: none; background: none;
    color: inherit; font: inherit; font-size: 15px; text-align: left; cursor: pointer;
    border-radius: 6px; overflow-wrap: anywhere;
  }
  .desk-zeile:hover { background: var(--glass-hover); }

  .fuss { padding: 8px 16px 16px; display: flex; flex-direction: column; gap: 8px; }
  .profil-knopf {
    min-height: 48px; padding: 10px 16px; border: 1px solid var(--glass-border); border-radius: 8px;
    background: var(--glass-card-bg); color: inherit; font: inherit; font-size: 13px;
    cursor: pointer; text-align: left;
  }
  .profil-auswahl {
    display: flex; flex-direction: column; gap: 2px; padding: 4px;
    background: var(--glass-elevated-bg); border: 1px solid var(--glass-border); border-radius: 10px;
    box-shadow: var(--glass-shadow-lg);
  }
  /* E5/overflow: die Zeilen brechen um statt zu kürzen — die Erkennungsangabe IST der
   * Informationsgehalt der Zeile und darf nicht wegellipsiert werden. */
  .profil-zeile {
    width: 100%; min-height: 48px; padding: 10px 12px; border: none; border-radius: 6px;
    background: none; color: inherit; font: inherit; font-size: 13px; text-align: left;
    cursor: pointer; white-space: normal; overflow-wrap: anywhere;
  }
  .profil-zeile:hover { background: var(--glass-hover); }

  /* Wortgleiche Stilregel wie .banner in Desktop.svelte/SitzungsmodusShell.svelte — dasselbe
     Element, dieselbe Optik (WR-03). */
  .banner { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); padding: 6px 14px;
            border-radius: 999px; background: rgba(140, 60, 20, .9); color: #fff; font-size: 13px; z-index: 99000; }
</style>
