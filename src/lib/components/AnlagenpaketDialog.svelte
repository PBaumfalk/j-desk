<script lang="ts">
  import { desktop } from '../store.svelte';
  import { ui, showToast, toast403 } from '../ui.svelte';
  import { ApiError, type AnlagenpaketPruefung } from '../api';
  import { toast403FallFuerDeskAktion } from '../deskAktionen';
  import { debounce } from '../debounce';
  import {
    ausschlussListe, auswahlZeilen, benenneAuswahl, bereinigeAusschluesse, entferneAuswahl, ergaenzeAuswahl,
    seitenSchluessel, verfuegbareDokumente, verschiebeAuswahl, vorbelegteAusschluesse,
  } from '../anlagenpaketAuswahl';

  /**
   * Anlagenpaket-Dialog (KONV-01, 10-01/10-03): Tracer-Endpunkt der Phase — der Pfad erreicht hier
   * den Nutzer. Struktur wortgleich zu UebergabeDialog.svelte (self-contained über
   * ui.anlagenpaketOffen, Fokusfalle, Escape schließt), aber breiter (ANLAGENPAKET_W, 10-UI-SPEC.md
   * Spacing Exceptions) und mit einer festen, nicht schließbaren Unterzeile direkt unter dem Titel.
   *
   * Feste Abschnittsreihenfolge (UI-SPEC Komponentenkontrakt): Deckblatt → Verfügbare Dokumente →
   * Ausgewählt & Reihenfolge → Dubletten & Leerseiten → Fußzeile (F-19, 10-05). Die Dubletten-/
   * Leerseiten-Prüfung (KONV-03) läuft debounced (400 ms, s. ladePruefungEntprellt) bei jeder
   * Änderung der Reihenfolge-Liste und beim Öffnen des Dialogs; ihre Namen kommen ausschließlich
   * aus dem Client-Zustand (bezeichnungFuer), nie aus der Serverantwort (T-10-25).
   *
   * Die Auswahl (ui.anlagenpaketAuswahl) lebt im Store, nicht in Komponenten-lokalem State, damit
   * Plan 10-03 sie auch aus dem Kontextmenü am Tisch befüllen kann, ohne den Dialog als
   * Zwischenstation zu brauchen — der Öffnen-Effekt setzt sie deshalb NICHT zurück (Festlegung F-04).
   *
   * Die Reihenfolge-Liste (Abschnitt „Ausgewählt & Reihenfolge") rendert ausschließlich aus
   * `zeilen` (auswahlZeilen(), 10-03 Task 1) — dieselbe Nummerierungsregel wie der Server beim
   * Zusammenbau. `ui.anlagenpaketAuswahl` bleibt als Rohliste die einzige Quelle der Wahrheit
   * für Schreiboperationen (hinzufügen/entfernen/verschieben/umbenennen/erzeugen), wird aber nicht
   * mehr direkt zur Darstellung iteriert.
   */

  let deckblattTitel = $state('');
  let erzeugeLaeuft = $state(false);

  // Dubletten-/Leerseiten-Prüfung (KONV-03, 10-05).
  let pruefung = $state<AnlagenpaketPruefung | null>(null);
  let pruefungLaeuft = $state(false);
  let pruefungFehler = $state(false);
  // Ankreuzungen (F-16): Menge zusammengesetzter Seitenschlüssel (docId#Seite) — nie Listenindex.
  let ausschluesse = $state<Set<string>>(new Set());
  // F-17: Seiten, die der Nutzer bewusst abgewählt hat — dürfen nach dem nächsten Prüflauf nicht
  // stillschweigend wieder ankreuzen, selbst wenn sie erneut als Dublette auftauchen.
  let abgewaehlt = $state<Set<string>>(new Set());

  let vorherFokussiert: HTMLElement | null = null;
  let schliessenKnopf = $state<HTMLButtonElement | null>(null);
  let warOffen = false;

  const verfuegbar = $derived(verfuegbareDokumente(desktop.state, ui.anlagenpaketAuswahl));
  const zeilen = $derived(auswahlZeilen(desktop.state, ui.anlagenpaketAuswahl));
  const leerseitenAlleAusgewaehlt = $derived(
    pruefung !== null
      && pruefung.leerseiten.length > 0
      && pruefung.leerseiten.every((l) => ausschluesse.has(seitenSchluessel(l.docId, l.lokaleSeite))),
  );

  /** Anzeigename einer Fundstelle (T-10-25): ausschließlich aus der Reihenfolge-Liste des
   *  Clients (zeilen), nie aus der Serverantwort — diese kennt keine Namen. Nicht auflösbar
   *  (Zeile inzwischen entfernt oder ohne Bezeichnung/Dokumentname): „unbekannte Unterlage". */
  function bezeichnungFuer(docId: string): string {
    return zeilen.find((z) => z.docId === docId)?.bezeichnung || 'unbekannte Unterlage';
  }

  function schliessen(): void {
    ui.anlagenpaketOffen = false;
    vorherFokussiert?.focus();
  }

  function hinzufuegen(docId: string, bezeichnung: string): void {
    const { auswahl, ergaenzt } = ergaenzeAuswahl(ui.anlagenpaketAuswahl, docId, bezeichnung);
    ui.anlagenpaketAuswahl = auswahl;
    if (!ergaenzt) showToast(`„${bezeichnung}" ist bereits im Anlagenpaket.`);
  }

  function entfernen(docId: string): void {
    ui.anlagenpaketAuswahl = entferneAuswahl(ui.anlagenpaketAuswahl, docId);
  }

  function verschieben(docId: string, richtung: -1 | 1): void {
    ui.anlagenpaketAuswahl = verschiebeAuswahl(ui.anlagenpaketAuswahl, docId, richtung);
  }

  function umbenennen(docId: string, bezeichnung: string): void {
    ui.anlagenpaketAuswahl = benenneAuswahl(ui.anlagenpaketAuswahl, docId, bezeichnung);
  }

  /**
   * Dubletten-/Leerseiten-Prüfung (KONV-03, 10-05) — Vorbild `UebergabeDialog.svelte
   * ladeStatistik()`: Ladezustand setzen, die VOLLSTÄNDIGE aktuelle Auswahl an den Server
   * schicken (Ausschlussliste wird bei der Prüfung nicht mitgesendet, s. api.ts), Ergebnis
   * übernehmen, Fehler auf einen festen Zustand setzen (Wortlaut steht im Markup), im `finally`
   * den Ladezustand zurücknehmen. Eine leere Auswahl löst keine Anfrage aus und leert das
   * Ergebnis. Nach jedem erfolgreichen Ergebnis werden veraltete Ankreuzungen verworfen (F-17)
   * und neu erscheinende Dubletten vorbelegt — außer der Nutzer hatte sie bereits bewusst
   * abgewählt.
   */
  async function ladePruefung(): Promise<void> {
    const api = desktop.api;
    const id = desktop.deskId;
    if (!api || !id) { pruefungFehler = true; return; }
    if (ui.anlagenpaketAuswahl.length === 0) {
      pruefung = null;
      pruefungFehler = false;
      return;
    }
    pruefungLaeuft = true;
    pruefungFehler = false;
    try {
      const ergebnis = await api.anlagenpaketPruefung(id, {
        deckblattTitel,
        eintraege: ui.anlagenpaketAuswahl,
      });
      pruefung = ergebnis;
      const bereinigt = bereinigeAusschluesse(ausschluesse, ergebnis);
      const neu = new Set(bereinigt);
      for (const schluessel of vorbelegteAusschluesse(ergebnis)) {
        if (!abgewaehlt.has(schluessel)) neu.add(schluessel);
      }
      ausschluesse = neu;
    } catch {
      pruefungFehler = true;
    } finally {
      pruefungLaeuft = false;
    }
  }

  /** F-18: um 400 ms entprellt, damit nicht jede Umsortierung sofort eine vollständige
   *  serverseitige Kopier-Pipeline auslöst. Die Schaltfläche „Erneut versuchen" ruft bewusst
   *  `ladePruefung` direkt (ohne Entprellung) auf. */
  const ladePruefungEntprellt = debounce(400, ladePruefung);

  /** Wechselt die Ankreuzung einer einzelnen Dublettenzeile (kein Alles-oder-nichts-Schalter). */
  function toggleDublette(docId: string, lokaleSeite: number): void {
    const schluessel = seitenSchluessel(docId, lokaleSeite);
    const neuAusschluesse = new Set(ausschluesse);
    const neuAbgewaehlt = new Set(abgewaehlt);
    if (neuAusschluesse.has(schluessel)) {
      neuAusschluesse.delete(schluessel);
      neuAbgewaehlt.add(schluessel);
    } else {
      neuAusschluesse.add(schluessel);
      neuAbgewaehlt.delete(schluessel);
    }
    ausschluesse = neuAusschluesse;
    abgewaehlt = neuAbgewaehlt;
  }

  /** Eine Ankreuzung für alle Leerseiten gemeinsam (Copywriting Contract: „Leere Seiten
   *  entfernen"), Default nicht angehakt. */
  function toggleLeerseiten(): void {
    if (!pruefung) return;
    const schluesselListe = pruefung.leerseiten.map((l) => seitenSchluessel(l.docId, l.lokaleSeite));
    if (schluesselListe.length === 0) return;
    const alleAusgewaehlt = schluesselListe.every((s) => ausschluesse.has(s));
    const neuAusschluesse = new Set(ausschluesse);
    const neuAbgewaehlt = new Set(abgewaehlt);
    for (const s of schluesselListe) {
      if (alleAusgewaehlt) { neuAusschluesse.delete(s); neuAbgewaehlt.add(s); }
      else { neuAusschluesse.add(s); neuAbgewaehlt.delete(s); }
    }
    ausschluesse = neuAusschluesse;
    abgewaehlt = neuAbgewaehlt;
  }

  /** Erzeugen-Klick (D-13): Download-Muster identisch zu UebergabeDialog.svelte erzeugen() —
   *  Blob → objectURL → temporärer a[download] → revoke im finally. Erfolg schließt den Dialog
   *  und leert Auswahl, Ankreuzungen und Prüfergebnis (F-04); ein Fehler lässt alle vier
   *  Zustände (Titel/Reihenfolge/Ankreuzungen/Prüfergebnis) vollständig erhalten (Dialog bleibt
   *  offen), zeigt bei 403 den toast403-Pfad, sonst die Servermeldung. Genau die im Dialog
   *  angehakten Seiten (ausschlussListe(ausschluesse)) werden ausgeschlossen — der Server
   *  erkennt nicht erneut, sondern setzt die bestätigte Liste um. */
  async function erzeugen(): Promise<void> {
    const api = desktop.api;
    const id = desktop.deskId;
    const name = desktop.desks.find((d) => d.id === id)?.name ?? 'Schreibtisch';
    if (!api || !id || erzeugeLaeuft || ui.anlagenpaketAuswahl.length === 0) return;
    erzeugeLaeuft = true;
    let url: string | undefined;
    try {
      const { blob, ausgelassen } = await api.anlagenpaketErzeugen(id, {
        deckblattTitel,
        eintraege: ui.anlagenpaketAuswahl,
        ausgeschlosseneSeiten: ausschlussListe(ausschluesse),
      });
      url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${name.replace(/[/\\:*?"<>|]/g, '-')}-anlagenpaket.pdf`;
      a.click();
      if (ausgelassen > 0) {
        showToast(`${ausgelassen} Unterlage(n) waren nicht verfügbar und wurden ausgelassen.`);
      }
      ui.anlagenpaketOffen = false;
      ui.anlagenpaketAuswahl = [];
      ausschluesse = new Set();
      abgewaehlt = new Set();
      pruefung = null;
      vorherFokussiert?.focus();
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) toast403(toast403FallFuerDeskAktion('export'), desktop.currentRolle);
      else showToast(`Das Anlagenpaket konnte nicht erzeugt werden. ${e instanceof Error ? e.message : ''}`.trim());
    } finally {
      erzeugeLaeuft = false;
      if (url) URL.revokeObjectURL(url);
    }
  }

  /** Tab-Bewegungen im Overlay halten (Fokusfalle) — identisches Muster zu UebergabeDialog.svelte. */
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
    if (!ui.anlagenpaketOffen) { warOffen = false; return; }
    if (warOffen) return;
    warOffen = true;
    vorherFokussiert = document.activeElement as HTMLElement | null;
    queueMicrotask(() => schliessenKnopf?.focus());
    if (deckblattTitel === '') {
      const name = desktop.desks.find((d) => d.id === desktop.deskId)?.name ?? 'Schreibtisch';
      deckblattTitel = `Anlagen zu ${name}`;
    }
    // Die Auswahl (ui.anlagenpaketAuswahl) wird hier BEWUSST NICHT zurückgesetzt (F-04) —
    // sie wächst laut UI-Spezifikation über mehrere Dialogöffnungen und das Kontextmenü hinweg.
  });

  /** Löst die (entprellte) Dubletten-/Leerseiten-Prüfung bei jeder Änderung der Reihenfolge-
   *  Liste UND beim Öffnen des Dialogs aus (10-UI-SPEC.md Abschnitt 4) — beide Abhängigkeiten
   *  werden unbedingt gelesen, bevor die Bedingung geprüft wird, damit Svelte beide als
   *  Reaktivitätsquelle registriert. Bei geschlossenem Dialog löst eine Änderung der Auswahl
   *  (z. B. über das Kontextmenü) keine Anfrage aus — erst das nächste Öffnen holt sie nach. */
  $effect(() => {
    const offen = ui.anlagenpaketOffen;
    const auswahl = ui.anlagenpaketAuswahl;
    void auswahl;
    if (!offen) return;
    void ladePruefungEntprellt();
  });
</script>

{#if ui.anlagenpaketOffen}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="hintergrund" onclick={schliessen}></div>
  <div class="overlay" role="dialog" aria-modal="true" aria-label="Anlagenpaket" tabindex="-1" onkeydown={fokusFalle}>
    <header>
      <div class="titelblock">
        <h2>📑 Anlagenpaket</h2>
        <p class="unterzeile">Erzeugt eine gerichtsfähige PDF-Kopie. Die Originaldokumente in j-lawyer bleiben unverändert.</p>
      </div>
      <button class="schliessen" bind:this={schliessenKnopf} onclick={schliessen} aria-label="Anlagenpaket-Dialog schließen">✕</button>
    </header>

    <div class="inhalt">
      <div class="abschnitt">Deckblatt</div>
      <label class="deckblatt-feld">
        <span class="deckblatt-label">Titel des Anlagenverzeichnisses</span>
        <input class="glass-input" type="text" bind:value={deckblattTitel} />
      </label>

      <div class="abschnitt">Verfügbare Dokumente</div>
      {#if verfuegbar.length === 0}
        <p class="hinweis">Keine für den Export freigegebenen Dokumente auf diesem Schreibtisch.</p>
      {:else}
        <div class="umfang-liste">
          {#each verfuegbar as d (d.id)}
            <button class="umfang-option" title={d.name} onclick={() => hinzufuegen(d.id, d.name)}>
              <span class="umfang-name">{d.name}</span>
            </button>
          {/each}
        </div>
      {/if}

      <div class="abschnitt abschnitt-lg">Ausgewählt & Reihenfolge</div>
      {#if zeilen.length === 0}
        <p class="hinweis">Noch keine Dokumente ausgewählt. Über das Kontextmenü am Tisch oder die Liste oben hinzufügen.</p>
      {:else}
        <div class="auswahl-liste">
          {#each zeilen as zeile, index (zeile.docId)}
            <div class="auswahl-zeile" class:gedaempft={!zeile.verfuegbar}>
              {#if zeile.verfuegbar}
                <span class="k-badge">K{zeile.nummer}</span>
              {:else}
                <span class="nicht-verfuegbar" title={zeile.hinweis}>({zeile.hinweis})</span>
              {/if}
              <input
                class="glass-input bezeichnung-feld"
                type="text"
                value={zeile.bezeichnung}
                title={zeile.bezeichnung}
                oninput={(e) => umbenennen(zeile.docId, (e.currentTarget as HTMLInputElement).value)}
              />
              <div class="schaltflaechen">
                <button
                  class="pager-btn" disabled={index === 0}
                  onclick={() => verschieben(zeile.docId, -1)} aria-label="Nach oben verschieben"
                >↑</button>
                <button
                  class="pager-btn" disabled={index === zeilen.length - 1}
                  onclick={() => verschieben(zeile.docId, 1)} aria-label="Nach unten verschieben"
                >↓</button>
                <button class="entfernen" onclick={() => entfernen(zeile.docId)} aria-label={`${zeile.bezeichnung} entfernen`}>✕ Entfernen</button>
              </div>
            </div>
          {/each}
        </div>
      {/if}

      <div class="abschnitt">Dubletten & Leerseiten</div>
      <div class="pruefung-abschnitt">
        {#if pruefungLaeuft}
          <p class="hinweis">Prüft auf Dubletten und leere Seiten …</p>
        {:else if pruefungFehler}
          <div class="fehler">
            <p>Prüfung fehlgeschlagen.</p>
            <button onclick={ladePruefung}>Erneut versuchen</button>
          </div>
        {:else if pruefung}
          <div class="pruefung-unterabschnitt">
            {#if pruefung.dubletten.length === 0}
              <p class="hinweis">Keine Dubletten gefunden.</p>
            {:else}
              {#each pruefung.dubletten as d (seitenSchluessel(d.docId, d.lokaleSeite))}
                <label class="warnzeile">
                  <span class="warnzeile-text">
                    ⚠️ Seite {d.lokaleSeite} in „{bezeichnungFuer(d.docId)}" ist inhaltsgleich mit Seite {d.gleichWieLokaleSeite} in „{bezeichnungFuer(d.gleichWieDocId)}"
                  </span>
                  <span class="warnzeile-checkbox">
                    <input
                      type="checkbox"
                      checked={ausschluesse.has(seitenSchluessel(d.docId, d.lokaleSeite))}
                      onchange={() => toggleDublette(d.docId, d.lokaleSeite)}
                    />
                    Aus dem Anlagenpaket ausschließen
                  </span>
                </label>
              {/each}
            {/if}
          </div>

          <div class="pruefung-unterabschnitt">
            {#if pruefung.leerseiten.length === 0}
              <p class="hinweis">Keine leeren Seiten gefunden.</p>
            {:else}
              <label class="warnzeile">
                <span class="warnzeile-text">⚠️ {pruefung.leerseiten.length} leere Seite(n) gefunden.</span>
                <span class="warnzeile-checkbox">
                  <input type="checkbox" checked={leerseitenAlleAusgewaehlt} onchange={toggleLeerseiten} />
                  Leere Seiten entfernen
                </span>
              </label>
              <ul class="fundstellen-liste">
                {#each pruefung.leerseiten as l (seitenSchluessel(l.docId, l.lokaleSeite))}
                  <li>{bezeichnungFuer(l.docId)} — Seite {l.lokaleSeite}</li>
                {/each}
              </ul>
            {/if}
          </div>

          {#if pruefung.unbeurteilbar.length > 0}
            <div class="pruefung-unterabschnitt">
              <p class="warnzeile-text warnzeile-block">
                ⚠️ {pruefung.unbeurteilbar.length} Seite(n) konnten nicht auf Dubletten und Leerheit geprüft werden.
              </p>
              <ul class="fundstellen-liste">
                {#each pruefung.unbeurteilbar as u (seitenSchluessel(u.docId, u.lokaleSeite))}
                  <li>{bezeichnungFuer(u.docId)} — Seite {u.lokaleSeite}</li>
                {/each}
              </ul>
            </div>
          {/if}

          {#if pruefung.ausgelassen > 0}
            <p class="hinweis">{pruefung.ausgelassen} Unterlage(n) waren nicht verfügbar und wurden ausgelassen.</p>
          {/if}
        {/if}
      </div>

      <div class="aktionen">
        <button class="abbrechen" onclick={schliessen}>Abbrechen</button>
        <button
          class="primaer"
          disabled={erzeugeLaeuft || zeilen.length === 0}
          onclick={erzeugen}
        >
          {erzeugeLaeuft ? 'Erzeugt Anlagenpaket …' : 'Anlagenpaket erzeugen'}
        </button>
      </div>
    </div>
  </div>
{/if}

<svelte:window onkeydown={(ev) => { if (ev.key === 'Escape' && ui.anlagenpaketOffen) schliessen(); }} />

<style>
  .hintergrund { position: fixed; inset: 0; background: rgba(8, 20, 35, .35); z-index: 9750; }
  .overlay {
    position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
    width: min(640px, 92vw); max-height: min(88vh, 760px); display: flex; flex-direction: column;
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
  .inhalt { overflow-y: auto; padding: 0 16px; display: flex; flex-direction: column; gap: 2px; }
  .abschnitt {
    padding: 4px 0 2px; margin-top: 12px; font-size: 11px; font-weight: 700; text-transform: uppercase;
    letter-spacing: .04em; opacity: .7;
  }
  .abschnitt:first-child { margin-top: 0; }
  /* 24px zwischen „Verfügbare Dokumente" und „Ausgewählt & Reihenfolge" (10-UI-SPEC.md Spacing Scale lg). */
  .abschnitt-lg { margin-top: 24px; }

  .deckblatt-feld { display: flex; flex-direction: column; gap: 4px; padding: 4px 0; }
  .deckblatt-label { font-size: 12px; opacity: .75; }

  .umfang-liste { max-height: 140px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
  .umfang-option {
    display: flex; align-items: center; gap: 8px; padding: 4px; border-radius: 6px; cursor: pointer;
    border: none; background: transparent; text-align: left; font: inherit; color: inherit; width: 100%;
  }
  .umfang-option:hover { background: var(--glass-hover); }
  .umfang-name { font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  .auswahl-liste { max-height: 220px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; padding: 4px 0; }
  .auswahl-zeile { display: flex; align-items: center; gap: 8px; }
  /* Nicht mehr verfügbares Dokument (Papierkorb/Freigabe verloren): gedimmt, identisches Muster
     zu DocCard.svelte .card.verwaist — die Zeile bleibt vollständig bedienbar. */
  .auswahl-zeile.gedaempft { opacity: .65; }
  /* K-Nummern-Badge: Bestandsstil (Art-Badge, Desktop.svelte .treffer .art) — 10px/700 uppercase,
     letter-spacing .05em, var(--brand-blue-soft)-Hintergrund (10-UI-SPEC.md Typography/Color). */
  .k-badge {
    flex-shrink: 0; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em;
    background: var(--brand-blue-soft); border-radius: 5px; padding: 2px 6px;
  }
  .nicht-verfuegbar {
    flex-shrink: 0; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    max-width: 220px;
  }
  .bezeichnung-feld {
    flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  /* Schaltflächengruppe je Zeile (↑/↓/Entfernen): 4px Abstand (10-UI-SPEC.md Spacing Scale xs). */
  .schaltflaechen { flex-shrink: 0; display: flex; align-items: center; gap: 4px; }
  /* ↑/↓-Reorder-Buttons: Bestandsstil .pager button (DocViewer.svelte/KonvolutViewer.svelte). */
  .pager-btn {
    flex-shrink: 0; border: none; background: #e7ebf2; border-radius: 5px; cursor: pointer;
    width: 24px; height: 24px; font-size: 13px; line-height: 1;
  }
  .pager-btn:disabled { opacity: .4; cursor: default; }
  .entfernen {
    flex-shrink: 0; border: none; background: transparent; color: inherit; cursor: pointer;
    font-size: 12px; padding: 4px 6px; opacity: .75;
  }
  .entfernen:hover { opacity: 1; }

  .hinweis { margin: 0; font-size: 13px; opacity: .75; }
  .fehler { display: flex; flex-direction: column; gap: 6px; }
  .fehler p { margin: 0; font-size: 13px; opacity: .75; }
  .fehler button { align-self: flex-start; border: none; border-radius: 6px; background: var(--glass-active); color: var(--glass-text); cursor: pointer; font-size: 12px; padding: 4px 8px; }

  /* Abschnitt „Dubletten & Leerseiten" (KONV-03, 10-05): scrollt in sich, damit die Fußzeile mit
     den beiden Schaltflächen sichtbar bleibt (10-UI-SPEC.md UI Considerations, overflow-backstop). */
  .pruefung-abschnitt { max-height: 220px; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; padding: 4px 0; }
  .pruefung-unterabschnitt { display: flex; flex-direction: column; gap: 6px; }
  /* Warnton: bestehende Bestandsfarbe (DocCard.svelte .status-badge.unerreichbar), keine neue
     vierte Warnfarbe. Icon+Text stehen im selben Element (T-10-25-analoge Copywriting-Regel). */
  .warnzeile {
    display: flex; flex-direction: column; gap: 4px; padding: 6px 8px; border-radius: 8px;
    background: rgba(150, 92, 10, .88); color: #fff; font-size: 12px; line-height: 1.4; cursor: pointer;
  }
  .warnzeile-text { display: block; }
  .warnzeile-block { margin: 0; padding: 6px 8px; border-radius: 8px; background: rgba(150, 92, 10, .88); color: #fff; }
  .warnzeile-checkbox { display: flex; align-items: center; gap: 6px; }
  .warnzeile-checkbox input { accent-color: var(--brand-blue); }
  .fundstellen-liste { margin: 0; padding-left: 20px; font-size: 12px; opacity: .8; display: flex; flex-direction: column; gap: 2px; }

  .aktionen { display: flex; justify-content: flex-end; gap: 8px; margin-top: 24px; }
  .aktionen button {
    padding: 9px 12px; border-radius: 8px; border: 1px solid var(--glass-border);
    background: transparent; color: var(--glass-text); cursor: pointer; font: inherit; font-size: 13px;
  }
  .aktionen button:hover { background: var(--glass-hover); }
  .aktionen .primaer { background: var(--brand-blue); color: #fff; border-color: transparent; }
  .aktionen .primaer:hover { background: var(--brand-blue); opacity: .9; }
  .aktionen .primaer:disabled { opacity: .5; cursor: default; }
</style>
