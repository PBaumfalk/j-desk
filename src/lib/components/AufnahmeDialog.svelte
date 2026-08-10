<script lang="ts">
  import { EXTERN_ARTEN, type ExternArt, type Vec2 } from '@j-desk/core';
  import { uid } from '../uid';
  import { desktop } from '../store.svelte';
  import { ui, showToast, toast403 } from '../ui.svelte';
  import { ApiError } from '../api';

  /**
   * AufnahmeDialog (EXT-01, 13-06) — Dialog-Klasse 1:1 aus VorschlaegeDialog.svelte:
   * .hintergrund/.overlay, role="dialog", Fokusfalle, Escape schließt (eigene
   * svelte:window-Zeile — kein Eintrag im globalen Desktop.svelte-Escape-Handler nötig),
   * warOffen-geschützter Öffnen-Effekt, stehende Fußzeile.
   *
   * Sieben Arten (EXTERN_ARTEN-Registry aus 13-02): Weblink/Urteil/Norm/Textfragment sind
   * Text-Arten (addNote als externe Referenz ODER Text-Ablage-Route aus Task 1); E-Mail/
   * Foto/Audio-Video sind Datei-Arten (Bestands-Uploadpfade). Die Ablage-Wahl ist Pflicht
   * (nie voreingestellt) außer bei Weblink (immer extern, UI-SPEC-Sonderregel) und fehlender
   * j-lawyer-Fähigkeit (Hinweiszeile ersetzt die Wahl). Der Weg „extern → j-lawyer" existiert
   * nachträglich nicht — eine Ablage ist immer eine neue Aufnahme (Klarheit vor Bequemlichkeit).
   */

  const AUFNAHME_W = 'min(640px, 92vw)';
  const AUFNAHME_H = 'min(88vh, 760px)';

  const ART_LABEL: Record<ExternArt, string> = {
    weblink: 'Weblink',
    urteil: 'Urteil',
    norm: 'Norm',
    email: 'E-Mail',
    foto: 'Foto',
    medien: 'Audio oder Video',
    textfragment: 'Textfragment',
  };
  const ART_BESCHREIBUNG: Record<ExternArt, string> = {
    weblink: 'Verweis auf eine externe Seite',
    urteil: 'Gericht, Aktenzeichen, Datum',
    norm: 'Gesetz und Paragraf',
    email: '.eml-Datei',
    foto: 'Bilddatei',
    medien: 'Mediendatei',
    textfragment: 'freier Text mit optionaler Quelle',
  };
  const DATEI_ARTEN = new Set<ExternArt>(['email', 'foto', 'medien']);
  const TEXT_ABLAGE_ARTEN = new Set<ExternArt>(['urteil', 'norm', 'textfragment']); // ablagefähig in j-lawyer
  const DATEI_ACCEPT: Record<'email' | 'foto' | 'medien', string> = {
    email: '.eml',
    foto: 'image/*',
    medien: 'audio/*,video/*',
  };

  let vorherFokussiert: HTMLElement | null = null;
  let schliessenKnopf = $state<HTMLButtonElement | null>(null);
  let warOffen = false;

  let art = $state<ExternArt | null>(null);
  let felder = $state<Record<string, string>>({});
  let datei = $state<File | null>(null);
  let ablage = $state<'extern' | 'jlawyer' | null>(null);
  let laedt = $state(false);

  /** j-lawyer-Fähigkeit: Modus UND Verbindung (UI-SPEC „kein j-lawyer-Modus / keine
   *  Verbindung" — Fähigkeits-Hinweis statt Ausgrauen, keine PERM-04-Regel). */
  const jlVerfuegbar = $derived(desktop.mode === 'jlawyer' && desktop.status === 'online');
  const istDateiArt = $derived(art !== null && DATEI_ARTEN.has(art));
  /** Weblink hat strukturell keine Ablage-Wahl (immer extern); ansonsten entfällt sie nur
   *  bei fehlender j-lawyer-Fähigkeit (dann ebenfalls implizit extern). */
  const ablageWahlNoetig = $derived(art !== null && art !== 'weblink' && jlVerfuegbar);
  const effektiveAblage = $derived<'extern' | 'jlawyer'>(ablageWahlNoetig ? (ablage ?? 'extern') : 'extern');

  function waehleArt(neu: ExternArt): void {
    art = neu;
    felder = {};
    datei = null;
    ablage = null;
  }

  function feld(name: string): string {
    return felder[name] ?? '';
  }
  function setzeFeld(name: string, wert: string): void {
    felder = { ...felder, [name]: wert };
  }

  const pflichtfelderErfuellt = $derived((() => {
    if (art === null) return false;
    if (art === 'weblink') return feld('url').trim() !== '';
    if (art === 'urteil') return feld('gericht').trim() !== '' && feld('aktenzeichen').trim() !== '';
    if (art === 'norm') return feld('gesetz').trim() !== '' && feld('paragraf').trim() !== '';
    if (art === 'textfragment') return feld('text').trim() !== '';
    return datei !== null; // Datei-Arten
  })());

  const kannAufnehmen = $derived(
    art !== null && pflichtfelderErfuellt && (!ablageWahlNoetig || ablage !== null) && !laedt,
  );

  function schliessen(): void {
    ui.aufnahmeOffen = false;
    art = null;
    felder = {};
    datei = null;
    ablage = null;
    laedt = false;
    vorherFokussiert?.focus();
  }

  /** Position neuer Karten im „Eingang" — Client-Spiegel des server-eingang()-Helfers
   *  (app.ts, Upload-/Aufnahme-Route): links oben, leicht gestaffelt nach Objektzahl. */
  function eingangsPosition(): Vec2 {
    const n = desktop.state.docs.length + (desktop.state.notes ?? []).length;
    return { x: 24 + (n % 3) * 36, y: 24 + n * 30 };
  }

  /** Einzeilige Kopfform je art + optionaler Fließtext/Zusatzangabe (Planner-Detail,
   *  bewusst schlicht — die Karte ist ein Verweis, kein Format-Nachbau). */
  function strukturierterText(a: ExternArt, f: Record<string, string>): string {
    if (a === 'weblink') {
      const kopf = `Weblink: ${f.url ?? ''}`;
      return f.titel?.trim() ? `${kopf}\n${f.titel.trim()}` : kopf;
    }
    if (a === 'urteil') {
      const kopf = `Urteil: ${[f.gericht, f.aktenzeichen, f.datum].filter((t) => t?.trim()).join(', ')}`;
      return f.fundstelle?.trim() ? `${kopf}\nFundstelle: ${f.fundstelle.trim()}` : kopf;
    }
    if (a === 'norm') {
      const kopf = `Norm: ${[f.gesetz, f.paragraf].filter((t) => t?.trim()).join(', ')}`;
      return f.absatz?.trim() ? `${kopf}\nAbsatz ${f.absatz.trim()}` : kopf;
    }
    // textfragment: der Text IST der Inhalt, keine Kopfzeile nötig (Badge trägt bereits „Textfragment").
    const kopf = f.text ?? '';
    return f.quelle?.trim() ? `${kopf}\n\nQuelle: ${f.quelle.trim()}` : kopf;
  }

  /** extern-Payload (13-02 ExternRef) je Text-art — quelle trägt eine kurze Provenienz-
   *  Angabe, wo sinnvoll (nie rechte-relevant, nur deklarativ). */
  function externPayload(a: ExternArt, f: Record<string, string>): { art: ExternArt; url?: string; quelle?: string } {
    if (a === 'weblink') return { art: a, url: f.url, ...(f.titel?.trim() ? { quelle: f.titel.trim() } : {}) };
    if (a === 'urteil') return { art: a, quelle: [f.gericht, f.aktenzeichen].filter((t) => t?.trim()).join(', ') };
    if (a === 'norm') return { art: a, quelle: [f.gesetz, f.paragraf].filter((t) => t?.trim()).join(', ') };
    return { art: a, ...(f.quelle?.trim() ? { quelle: f.quelle.trim() } : {}) };
  }

  /** Felder für die Text-Ablage-Route (Task 1) — nur die je art relevanten Schlüssel. */
  function felderFuerJlawyer(a: 'urteil' | 'norm' | 'textfragment', f: Record<string, string>): Record<string, string | undefined> {
    if (a === 'urteil') return { gericht: f.gericht, aktenzeichen: f.aktenzeichen, datum: f.datum || undefined, fundstelle: f.fundstelle || undefined };
    if (a === 'norm') return { gesetz: f.gesetz, paragraf: f.paragraf, absatz: f.absatz || undefined };
    return { text: f.text, quelle: f.quelle || undefined };
  }

  async function aufnehmen(): Promise<void> {
    if (!kannAufnehmen || art === null) return;
    const gewaehlteArt = art;
    const deskId = desktop.deskId;
    if (!deskId || !desktop.api) return;
    laedt = true;
    try {
      if (istDateiArt) {
        if (!datei) return;
        const bytes = new Uint8Array(await datei.arrayBuffer());
        if (effektiveAblage === 'jlawyer') {
          // j-lawyer-Pfad für Datei-Arten (unverändert normale Karte, Bestands-Uploadpfad).
          const result = await desktop.api.uploadToCase(deskId, bytes, datei.name);
          desktop.acceptServerState(result);
        } else {
          // Extern-Pfad für Datei-Arten: Standalone-Ablage (NIE in die Akte, auch nicht im
          // j-lawyer-Modus — sonst wäre es keine externe Referenz mehr) + addDoc mit extern.
          const r = await desktop.api.uploadFile(bytes, datei.name, datei.type || undefined);
          const docId = uid();
          await desktop.command('addDoc', {
            fileId: r.fileId, name: datei.name, position: eingangsPosition(), id: docId, kind: r.kind,
            extern: { art: gewaehlteArt },
          });
        }
      } else if (effektiveAblage === 'jlawyer' && TEXT_ABLAGE_ARTEN.has(gewaehlteArt)) {
        // j-lawyer-Pfad für Text-Arten: die neue Text-Ablage-Route (Task 1) — PDF-Synthese
        // + echte Akten-Karte, kein extern-Feld.
        const result = await desktop.api.aufnehmenTextAblage(deskId, {
          art: gewaehlteArt as 'urteil' | 'norm' | 'textfragment',
          felder: felderFuerJlawyer(gewaehlteArt as 'urteil' | 'norm' | 'textfragment', felder),
        });
        desktop.acceptServerState(result);
      } else {
        // Extern-Pfad für Text-Arten (inkl. Weblink, immer): addNote mit extern-Payload —
        // Offline-Queue-fähig wie jedes andere erzeugende Kommando.
        await desktop.command('addNote', {
          kind: 'eigen',
          customLabel: ART_LABEL[gewaehlteArt],
          text: strukturierterText(gewaehlteArt, felder),
          position: eingangsPosition(),
          id: uid(),
          extern: externPayload(gewaehlteArt, felder),
        });
      }
      showToast(effektiveAblage === 'jlawyer' ? 'In j-lawyer abgelegt und auf den Tisch gelegt.' : `${ART_LABEL[gewaehlteArt]} aufgenommen.`);
      schliessen();
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) toast403('upload', desktop.currentRolle);
      else showToast(`${ART_LABEL[gewaehlteArt]} konnte nicht aufgenommen werden. ${e instanceof Error ? e.message : ''}`.trim());
    } finally {
      laedt = false;
    }
  }

  /** Fokusfalle — wortgleich zu VorschlaegeDialog.svelte. */
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
    if (!ui.aufnahmeOffen) { warOffen = false; return; }
    if (warOffen) return;
    warOffen = true;
    vorherFokussiert = document.activeElement as HTMLElement | null;
    queueMicrotask(() => schliessenKnopf?.focus());
  });
</script>

{#if ui.aufnahmeOffen}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="hintergrund" onclick={schliessen}></div>
  <div
    class="overlay" role="dialog" aria-modal="true" aria-label="Inhalt aufnehmen" tabindex="-1"
    style:width={AUFNAHME_W} style:max-height={AUFNAHME_H}
    onkeydown={fokusFalle}
  >
    <header>
      <div class="titelblock">
        <h2>📥 Inhalt aufnehmen</h2>
        <p class="unterzeile">Nehmen Sie externe Inhalte als Karte auf. Sie wählen je Inhalt ausdrücklich: eindeutig gekennzeichnete externe Referenz — oder Ablage in der j-lawyer-Akte.</p>
      </div>
      <button class="schliessen" bind:this={schliessenKnopf} onclick={schliessen} aria-label="Aufnahme-Dialog schließen">✕</button>
    </header>

    <div class="inhalt">
      <div class="abschnitt">Art</div>
      <div class="art-liste" role="radiogroup" aria-label="Art des Inhalts">
        {#each EXTERN_ARTEN as a (a)}
          <label class="art-option">
            <input type="radio" name="art" checked={art === a} onchange={() => waehleArt(a)} />
            <span class="art-text"><strong>{ART_LABEL[a]}</strong> — {ART_BESCHREIBUNG[a]}</span>
          </label>
        {/each}
      </div>

      <div class="abschnitt">Angaben</div>
      {#if art === null}
        <p class="hinweis">Wählen Sie oben eine Art.</p>
      {:else if art === 'weblink'}
        <label class="feld"><strong>URL</strong>
          <input class="glass-input" type="url" placeholder="https://…" value={feld('url')} oninput={(e) => setzeFeld('url', e.currentTarget.value)} />
        </label>
        <label class="feld">Titel (optional)
          <input class="glass-input" type="text" value={feld('titel')} oninput={(e) => setzeFeld('titel', e.currentTarget.value)} />
        </label>
      {:else if art === 'urteil'}
        <label class="feld"><strong>Gericht</strong>
          <input class="glass-input" type="text" value={feld('gericht')} oninput={(e) => setzeFeld('gericht', e.currentTarget.value)} />
        </label>
        <label class="feld"><strong>Aktenzeichen</strong>
          <input class="glass-input" type="text" value={feld('aktenzeichen')} oninput={(e) => setzeFeld('aktenzeichen', e.currentTarget.value)} />
        </label>
        <label class="feld">Datum (optional)
          <input class="glass-input" type="text" placeholder="TT.MM.JJJJ" value={feld('datum')} oninput={(e) => setzeFeld('datum', e.currentTarget.value)} />
        </label>
        <label class="feld">Fundstelle (optional)
          <input class="glass-input" type="text" value={feld('fundstelle')} oninput={(e) => setzeFeld('fundstelle', e.currentTarget.value)} />
        </label>
      {:else if art === 'norm'}
        <label class="feld"><strong>Gesetz</strong>
          <input class="glass-input" type="text" value={feld('gesetz')} oninput={(e) => setzeFeld('gesetz', e.currentTarget.value)} />
        </label>
        <label class="feld"><strong>Paragraf</strong>
          <input class="glass-input" type="text" value={feld('paragraf')} oninput={(e) => setzeFeld('paragraf', e.currentTarget.value)} />
        </label>
        <label class="feld">Absatz (optional)
          <input class="glass-input" type="text" value={feld('absatz')} oninput={(e) => setzeFeld('absatz', e.currentTarget.value)} />
        </label>
      {:else if art === 'email' || art === 'foto' || art === 'medien'}
        <label class="feld"><strong>{art === 'email' ? '.eml-Datei' : art === 'foto' ? 'Bilddatei' : 'Mediendatei'}</strong>
          <input class="glass-input" type="file" accept={DATEI_ACCEPT[art]}
                 onchange={(e) => (datei = e.currentTarget.files?.[0] ?? null)} />
        </label>
      {:else}
        <label class="feld"><strong>Text</strong>
          <textarea class="glass-input textarea" rows="6" value={feld('text')} oninput={(e) => setzeFeld('text', e.currentTarget.value)}></textarea>
        </label>
        <label class="feld">Quelle/URL (optional)
          <input class="glass-input" type="text" value={feld('quelle')} oninput={(e) => setzeFeld('quelle', e.currentTarget.value)} />
        </label>
      {/if}

      {#if art !== null}
        <div class="abschnitt">Ablage</div>
        {#if art === 'weblink'}
          <p class="hinweis">Weblinks werden immer als externe Referenz aufgenommen.</p>
        {:else if !jlVerfuegbar}
          <p class="hinweis">Ablage in j-lawyer ist hier nicht verfügbar (kein j-lawyer-Modus / keine Verbindung) — die Karte wird als externe Referenz gekennzeichnet.</p>
        {:else}
          <div class="art-liste" role="radiogroup" aria-label="Ablage-Wahl">
            <label class="art-option">
              <input type="radio" name="ablage" checked={ablage === 'extern'} onchange={() => (ablage = 'extern')} />
              <span class="art-text">Als externe Referenz aufnehmen — die Karte trägt dauerhaft die Kennzeichnung „🌐 Externe Referenz".</span>
            </label>
            <label class="art-option">
              <input type="radio" name="ablage" checked={ablage === 'jlawyer'} onchange={() => (ablage = 'jlawyer')} />
              <span class="art-text">In j-lawyer ablegen — wird als Dokument in der Akte gespeichert und als normale Karte verknüpft.</span>
            </label>
          </div>
        {/if}
      {/if}
    </div>

    <div class="aktionen">
      <span></span>
      <div class="aktionen-rechts">
        <button class="sekundaer" onclick={schliessen}>Abbrechen</button>
        <button class="primaer" disabled={!kannAufnehmen} onclick={() => void aufnehmen()}>
          {laedt ? 'Wird hochgeladen …' : 'Aufnehmen'}
        </button>
      </div>
    </div>
  </div>
{/if}

<svelte:window onkeydown={(ev) => { if (ev.key === 'Escape' && ui.aufnahmeOffen) schliessen(); }} />

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

  .inhalt { overflow-y: auto; padding: 8px 16px 0; display: flex; flex-direction: column; gap: 8px; }
  .abschnitt { font-size: 12px; font-weight: 600; opacity: .75; margin-top: 8px; }
  .hinweis { margin: 0; font-size: 13px; opacity: .75; }

  .art-liste { display: flex; flex-direction: column; gap: 8px; }
  .art-option { display: flex; align-items: flex-start; gap: 8px; font-size: 13px; cursor: pointer; }
  .art-option input { margin-top: 3px; }
  .art-text { line-height: 1.4; }

  .feld { display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
  .glass-input { padding: 6px 8px; border-radius: 7px; border: 1px solid var(--glass-separator);
                 background: var(--glass-input-bg); color: var(--glass-text); font: inherit; font-size: 13px; }
  .textarea { resize: vertical; font-family: inherit; }

  /* Fußzeile liegt AUSSERHALB der scrollenden .inhalt-Fläche und scrollt nie mit (E8/overflow). */
  .aktionen { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-top: 24px; padding: 0 16px; }
  .aktionen-rechts { display: flex; gap: 8px; }
  .aktionen button {
    padding: 9px 12px; border-radius: 8px; border: 1px solid var(--glass-border);
    background: transparent; color: var(--glass-text); cursor: pointer; font: inherit; font-size: 13px;
  }
  .aktionen button:hover { background: var(--glass-hover); }
  .aktionen .primaer { background: var(--brand-blue); color: #fff; border-color: transparent; }
  .aktionen .primaer:hover { background: var(--brand-blue); opacity: .9; }
  .aktionen .primaer:disabled { opacity: .5; cursor: default; }
</style>
