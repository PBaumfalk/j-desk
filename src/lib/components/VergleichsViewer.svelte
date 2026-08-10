<script lang="ts">
  import { onMount } from 'svelte';
  import { findDoc, marksFor, type Doc } from '@j-desk/core';
  import { desktop } from '../store.svelte';
  import { bytesFor } from '../pageCounts';
  import { seitenWoerter, type Rect } from '../pdfText';
  import {
    vergleicheSeite,
    seiteEingabeFuer as seiteEingabeAusQuellen,
    type SeitenVergleich,
    type SeiteEingabe,
  } from '../vergleichSeite';
  import { koppleSeite, koppleRollposition, type SyncQuelle } from '../vergleichSync';
  import { istEchteSchwaerzung } from '../markSchwaerzung';
  import PageRenderer from './PageRenderer.svelte';
  import DiffOverlay from './DiffOverlay.svelte';

  // Vergleichsfenster (COMP-01/02, Plan 09-09) — Struktur wortgleich zu ActivityOverlay.svelte
  // (Hintergrund/Dialogrolle/Fokusfalle/Escape/Hintergrundklick), nur breiteres Format
  // (VERGLEICH_W/H, 09-UI-SPEC.md Spacing Exceptions) und zwei Spalten statt einer Liste.
  let { aId, bId, onclose }: { aId: string; bId: string; onclose: () => void } = $props();

  const docA = $derived(findDoc(desktop.state, aId));
  const docB = $derived(findDoc(desktop.state, bId));

  let seiteA = $state(1);
  let seiteB = $state(1);
  let pageCountA = $state<number | null>(null);
  let pageCountB = $state<number | null>(null);
  let baseA = $state<{ w: number; h: number } | null>(null);
  let baseB = $state<{ w: number; h: number } | null>(null);
  let breiteA = $state(0);
  let breiteB = $state(0);

  let gekoppelt = $state(true);
  let unterschiedeAn = $state(true);

  let linksBody = $state<HTMLDivElement | null>(null);
  let rechtsBody = $state<HTMLDivElement | null>(null);
  // Nächster scroll-Event der jeweils ANDEREN Spalte gilt als programmatisch ausgelöst (Muster
  // renderToken aus PageRenderer.svelte, 09-PATTERNS.md Pitfall 4) — siehe onScrollLinks/Rechts.
  let programmScrollLinks = false;
  let programmScrollRechts = false;

  let vorherFokussiert: HTMLElement | null = null;
  let schliessenKnopf = $state<HTMLButtonElement | null>(null);

  onMount(() => {
    vorherFokussiert = document.activeElement as HTMLElement | null;
    queueMicrotask(() => schliessenKnopf?.focus());
  });

  function schliessen(): void {
    onclose();
    vorherFokussiert?.focus();
  }

  /** Fokusfalle im geöffneten Fenster — identisches Muster zu ActivityOverlay.svelte. */
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

  // Seitenwechsel: ausschließlich über koppleSeite (vergleichSync.ts, Plan 09-08) — keine eigene
  // Klemm-/Rückkopplungslogik hier. Das Setzen der GEGENÜBER-Seite ist ein einfacher
  // Zustandswechsel ohne eigenes DOM-Ereignis, deshalb reicht das direkte Zuweisen — anders als
  // beim Scrollen unten, wo derselbe Wechsel als scroll-Ereignis erneut hereinkäme.
  function turnLinks(delta: number): void {
    const naechste = seiteA + delta;
    if (naechste < 1 || (pageCountA !== null && naechste > pageCountA)) return;
    seiteA = naechste;
    const angeglichen = koppleSeite({ gekoppelt, quelle: 'links', seite: naechste, seitenAndereSpalte: pageCountB ?? 0 });
    if (angeglichen !== null) seiteB = angeglichen;
  }
  function turnRechts(delta: number): void {
    const naechste = seiteB + delta;
    if (naechste < 1 || (pageCountB !== null && naechste > pageCountB)) return;
    seiteB = naechste;
    const angeglichen = koppleSeite({ gekoppelt, quelle: 'rechts', seite: naechste, seitenAndereSpalte: pageCountA ?? 0 });
    if (angeglichen !== null) seiteA = angeglichen;
  }

  // Rollpositions-Kopplung über koppleRollposition (vergleichSync.ts): eine programmatisch
  // gesetzte scrollTop löst im Browser selbst wieder ein scroll-Ereignis aus — programmScrollLinks/
  // Rechts markieren GENAU den nächsten scroll-Event der jeweils anderen Spalte als Quelle
  // 'programm', damit koppleRollposition dort null liefert und die Kaskade nach einem Schritt endet.
  function bruchteilVon(el: HTMLElement): number {
    const bereich = el.scrollHeight - el.clientHeight;
    return bereich > 0 ? el.scrollTop / bereich : 0;
  }
  function setzeBruchteil(el: HTMLElement, bruchteil: number): void {
    const bereich = el.scrollHeight - el.clientHeight;
    el.scrollTop = bereich > 0 ? bruchteil * bereich : 0;
  }
  function onScrollLinks(e: Event): void {
    const el = e.currentTarget as HTMLElement;
    const quelle: SyncQuelle = programmScrollLinks ? 'programm' : 'links';
    programmScrollLinks = false;
    const ziel = koppleRollposition({ gekoppelt, quelle, bruchteil: bruchteilVon(el) });
    if (ziel === null || !rechtsBody) return;
    programmScrollRechts = true;
    setzeBruchteil(rechtsBody, ziel);
  }
  function onScrollRechts(e: Event): void {
    const el = e.currentTarget as HTMLElement;
    const quelle: SyncQuelle = programmScrollRechts ? 'programm' : 'rechts';
    programmScrollRechts = false;
    const ziel = koppleRollposition({ gekoppelt, quelle, bruchteil: bruchteilVon(el) });
    if (ziel === null || !linksBody) return;
    programmScrollLinks = true;
    setzeBruchteil(linksBody, ziel);
  }

  // Textbeschaffung + Vergleich je sichtbarem Seitenpaar (T-09-39) — NIE für das ganze Dokument
  // beim Öffnen. Zwischenspeicher je fileId, damit ein Seitenwechsel nicht bei jeder Seite den
  // kompletten erkannten Text der Datei erneut abruft (fetchFileText liefert je Aufruf ALLE
  // Seiten einer Datei auf einmal, s. 09-08-PLAN.md).
  const erkannterTextCache = new Map<string, Promise<Map<number, string> | null>>();
  function erkannterTextFuer(fileId: string): Promise<Map<number, string> | null> {
    let p = erkannterTextCache.get(fileId);
    if (!p) {
      p = (async () => {
        if (!desktop.api || !desktop.deskId) return null;
        try {
          const { seiten } = await desktop.api.fetchFileText(desktop.deskId, fileId);
          return new Map<number, string>(seiten.map((s) => [s.seite, s.text]));
        } catch {
          return null;
        }
      })();
      erkannterTextCache.set(fileId, p);
    }
    return p;
  }

  /**
   * Eingabe für vergleicheSeite() einer Seite: zuerst eingebetteter Text mit Positionen
   * (seitenWoerter, Plan 09-03), gefiltert auf Dokument und Seite über marksFor() und um echte
   * Schwärzungen bereinigt (T-09-37, Fortführung von T-09-11) — liefert das nichts, der erkannte
   * Text ohne Positionen (fetchFileText, Plan 09-08) — liefert auch das nichts, 'kein-text'.
   *
   * Reine Beschaffung der `ueberdeckungen` sowie der konkreten Quell-Funktionen hier; die
   * sicherheitskritische Rückfall-Entscheidung selbst steckt in `seiteEingabeFuer()` aus
   * `vergleichSeite.ts` (CR-01, Iterationen 1+2) — dorthin ausgelagert, damit sie ohne echte
   * pdf.js-/API-Aufrufe mit Mocks getestet werden kann (siehe `vergleichSeite.test.ts`).
   */
  async function seiteEingabeFuer(doc: Doc | undefined, seite: number): Promise<SeiteEingabe> {
    if (!doc || !desktop.api) return { art: 'kein-text' };
    const api = desktop.api;
    const quelle = doc.kind === 'convertible' ? 'preview' : 'original';
    const ueberdeckungen: Rect[] = marksFor(desktop.state, doc.id, seite)
      .filter((m) => istEchteSchwaerzung(m.kind))
      .map((m) => m.rect);
    return seiteEingabeAusQuellen(seite, ueberdeckungen, {
      bytesFor: () => bytesFor(api, doc.fileId, quelle),
      seitenWoerter: (bytes) => seitenWoerter(bytes, seite, ueberdeckungen),
      erkannterTextFuer: async (s) => (await erkannterTextFuer(doc.fileId))?.get(s),
    });
  }

  let vergleichsErgebnis = $state<SeitenVergleich | null>(null);
  let vergleichLaedt = $state(false);
  let vergleichLauf = 0;

  async function ladeVergleich(): Promise<void> {
    const token = ++vergleichLauf;
    const dA = docA;
    const dB = docB;
    const sA = seiteA;
    const sB = seiteB;
    vergleichLaedt = true;
    try {
      const [eingabeA, eingabeB] = await Promise.all([seiteEingabeFuer(dA, sA), seiteEingabeFuer(dB, sB)]);
      if (token !== vergleichLauf) return; // überholt — inzwischen wurde eine andere Seite angefragt
      vergleichsErgebnis = vergleicheSeite(eingabeA, eingabeB);
    } finally {
      if (token === vergleichLauf) vergleichLaedt = false;
    }
  }

  $effect(() => {
    // Abhängig von der sichtbaren Seite je Spalte und vom Umschalter — der Vergleich läuft
    // ausschließlich für das aktuell sichtbare Seitenpaar (T-09-39), nie für das ganze Dokument.
    seiteA; seiteB; docA?.fileId; docB?.fileId; unterschiedeAn;
    if (!unterschiedeAn) { vergleichsErgebnis = null; vergleichLaedt = false; return; }
    void ladeVergleich();
  });

  const kurzName = (n: string | undefined): string => n ?? 'Unbekanntes Dokument';
  const titelText = $derived(`Vergleich: ${kurzName(docA?.name)} ↔ ${kurzName(docB?.name)}`);
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="hintergrund" onclick={schliessen}></div>
<div class="overlay" role="dialog" aria-modal="true" aria-label={titelText} tabindex="-1" onkeydown={fokusFalle}>
  <header>
    <span class="titel" title={titelText}>{titelText}</span>
    <div class="umschalter">
      <button class:aktiv={gekoppelt} aria-pressed={gekoppelt} title="Scrollen/Seitenwechsel koppeln"
              onclick={() => (gekoppelt = !gekoppelt)}>🔗 Gekoppelt</button>
      <button class:aktiv={unterschiedeAn} aria-pressed={unterschiedeAn}
              onclick={() => (unterschiedeAn = !unterschiedeAn)}>Unterschiede</button>
    </div>
    <button class="schliessen" bind:this={schliessenKnopf} onclick={schliessen} aria-label="Vergleich schließen">✕</button>
  </header>

  <!-- Fünf Ergebnisvarianten (kein-text/geschwaerzt teilen sich hier einen No-op-Zweig) — keine fällt in einen Sammelzweig, den sie nicht auch inhaltlich teilt. -->
  {#if vergleichLaedt}
    <div class="status">Vergleicht Text …</div>
  {:else if vergleichsErgebnis}
    {#if vergleichsErgebnis.art === 'markiert'}
      <!-- Markierungen liegen direkt auf den Seiten (DiffOverlay unten) — kein Text hier. -->
    {:else if vergleichsErgebnis.art === 'ohne-stellen'}
      <div class="status hinweis-text">
        Mindestens eine der beiden Fassungen liegt nur als erkannter Text vor (zum Beispiel aus
        einem eingescannten Dokument) — die Unterschiede lassen sich deshalb nicht auf der Seite
        markieren. Gezählt: {vergleichsErgebnis.entferntAnzahl} entfernte,
        {vergleichsErgebnis.hinzugefuegtAnzahl} hinzugefügte Wörter.
      </div>
    {:else if vergleichsErgebnis.art === 'kein-text' || vergleichsErgebnis.art === 'geschwaerzt'}
      <!-- Hinweis erscheint einzeln je betroffener Spalte unten, nicht hier gemeinsam. -->
    {:else if vergleichsErgebnis.art === 'zu-lang'}
      <div class="status hinweis-text">
        Diese Seite ist für den Wortvergleich zu umfangreich ({vergleichsErgebnis.woerterAlt} bzw.
        {vergleichsErgebnis.woerterNeu} Wörter) — kein Vergleich für dieses Seitenpaar möglich.
      </div>
    {/if}
  {/if}

  <div class="rumpf">
    <div class="spalte">
      <div class="spalte-kopf">
        <span class="spalte-name" title={docA?.name}>{kurzName(docA?.name)}</span>
        <span class="pager">
          <button onclick={() => turnLinks(-1)} disabled={seiteA <= 1} aria-label="Zurück">‹</button>
          <span class="pos">{seiteA}{#if pageCountA} / {pageCountA}{/if}</span>
          <button onclick={() => turnLinks(1)} disabled={pageCountA !== null && seiteA >= pageCountA} aria-label="Weiter">›</button>
        </span>
      </div>
      <div class="spalte-body" bind:this={linksBody} bind:clientWidth={breiteA} onscroll={onScrollLinks}>
        {#if desktop.api && docA}
          <div class="seite-wrap">
            <PageRenderer api={desktop.api} fileId={docA.fileId} page={seiteA}
                          targetWidth={Math.max(1, breiteA - 20)}
                          source={docA.kind === 'convertible' ? 'preview' : 'original'}
                          onpagecount={(n) => (pageCountA = n)} onbasesize={(s) => (baseA = s)} />
            {#if unterschiedeAn && vergleichsErgebnis?.art === 'markiert'}
              <DiffOverlay rects={vergleichsErgebnis.entferntRects} art="entfernt" base={baseA} renderedWidth={Math.max(1, breiteA - 20)} />
            {/if}
          </div>
        {/if}
        {#if vergleichsErgebnis?.art === 'kein-text' && (vergleichsErgebnis.spalte === 'links' || vergleichsErgebnis.spalte === 'beide')}
          <div class="hinweis">Kein Text zum Vergleichen verfügbar.</div>
        {:else if vergleichsErgebnis?.art === 'geschwaerzt' && (vergleichsErgebnis.spalte === 'links' || vergleichsErgebnis.spalte === 'beide')}
          <div class="hinweis">Diese Seite ist vollständig geschwärzt — kein Vergleich möglich.</div>
        {/if}
      </div>
    </div>

    <div class="trennlinie" aria-hidden="true"></div>

    <div class="spalte">
      <div class="spalte-kopf">
        <span class="spalte-name" title={docB?.name}>{kurzName(docB?.name)}</span>
        <span class="pager">
          <button onclick={() => turnRechts(-1)} disabled={seiteB <= 1} aria-label="Zurück">‹</button>
          <span class="pos">{seiteB}{#if pageCountB} / {pageCountB}{/if}</span>
          <button onclick={() => turnRechts(1)} disabled={pageCountB !== null && seiteB >= pageCountB} aria-label="Weiter">›</button>
        </span>
      </div>
      <div class="spalte-body" bind:this={rechtsBody} bind:clientWidth={breiteB} onscroll={onScrollRechts}>
        {#if desktop.api && docB}
          <div class="seite-wrap">
            <PageRenderer api={desktop.api} fileId={docB.fileId} page={seiteB}
                          targetWidth={Math.max(1, breiteB - 20)}
                          source={docB.kind === 'convertible' ? 'preview' : 'original'}
                          onpagecount={(n) => (pageCountB = n)} onbasesize={(s) => (baseB = s)} />
            {#if unterschiedeAn && vergleichsErgebnis?.art === 'markiert'}
              <DiffOverlay rects={vergleichsErgebnis.hinzugefuegtRects} art="hinzugefuegt" base={baseB} renderedWidth={Math.max(1, breiteB - 20)} />
            {/if}
          </div>
        {/if}
        {#if vergleichsErgebnis?.art === 'kein-text' && (vergleichsErgebnis.spalte === 'rechts' || vergleichsErgebnis.spalte === 'beide')}
          <div class="hinweis">Kein Text zum Vergleichen verfügbar.</div>
        {:else if vergleichsErgebnis?.art === 'geschwaerzt' && (vergleichsErgebnis.spalte === 'rechts' || vergleichsErgebnis.spalte === 'beide')}
          <div class="hinweis">Diese Seite ist vollständig geschwärzt — kein Vergleich möglich.</div>
        {/if}
      </div>
    </div>
  </div>
</div>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape') schliessen(); }} />

<style>
  .hintergrund { position: fixed; inset: 0; background: rgba(8, 20, 35, .35); z-index: 9750; }
  /* VERGLEICH_W/H aus 09-UI-SPEC.md Spacing Exceptions — Bildschirm-fixiertes Overlay wie
     ActivityOverlay.svelte, kein Weltkoordinaten-Objekt. */
  .overlay {
    position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
    width: min(1100px, 94vw); height: min(800px, 82vh);
    display: flex; flex-direction: column; min-height: 0;
    z-index: 9760; border-radius: 16px; padding: 0 0 8px;
    background: var(--glass-panel-bg, rgba(255, 255, 255, .82));
    color: var(--glass-text);
    backdrop-filter: var(--glass-blur-panel); -webkit-backdrop-filter: var(--glass-blur-panel);
    box-shadow: 0 18px 48px rgba(0, 0, 0, .28);
  }
  header { display: flex; align-items: center; gap: 12px; padding: 14px 16px 8px; flex: none; }
  .titel { flex: 1; min-width: 0; font-size: 15px; font-weight: 600; white-space: nowrap;
           overflow: hidden; text-overflow: ellipsis; }
  .umschalter { display: flex; align-items: center; gap: 8px; flex: none; }
  .umschalter button { border: 1px solid var(--glass-separator); background: transparent; color: var(--glass-text);
                        border-radius: 8px; padding: 6px 10px; font: inherit; font-size: 12.5px; cursor: pointer;
                        display: flex; align-items: center; gap: 4px; }
  /* Aktiver Zustand: Muster AuswertungsPanel.svelte .abfrage-knopf.aktiv (09-UI-SPEC.md Color). */
  .umschalter button.aktiv { background: var(--brand-blue-soft); border-color: var(--brand-blue); }
  .schliessen { flex: none; border: none; background: transparent; font-size: 15px; cursor: pointer; padding: 4px 8px; }
  .status { padding: 4px 16px 8px; font-size: 12.5px; line-height: 1.4; text-align: center; flex: none; }
  .hinweis-text { opacity: .9; }
  .rumpf { flex: 1; min-height: 0; display: flex; gap: 24px; padding: 0 16px 8px; position: relative; }
  /* Trennlinie mittig im 24px-Gap zwischen den beiden gleich breiten Spalten. */
  .trennlinie { position: absolute; left: 50%; top: 0; bottom: 0; width: 1px;
                background: var(--glass-separator); transform: translateX(-50%); }
  .spalte { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; }
  .spalte-kopf { display: flex; align-items: center; justify-content: space-between; gap: 8px;
                 padding: 0 2px 8px; flex: none; }
  .spalte-name { flex: 1; min-width: 0; font-size: 12px; font-weight: 600; white-space: nowrap;
                 overflow: hidden; text-overflow: ellipsis; }
  /* Pager-Stil wortgleich zu DocViewer.svelte .pager. */
  .pager { display: flex; align-items: center; gap: 6px; flex: none; }
  .pager button { border: none; background: #e7ebf2; border-radius: 5px; cursor: pointer;
                   width: 24px; height: 24px; font-size: 15px; line-height: 1; }
  .pager button:disabled { opacity: .4; cursor: default; }
  .pos { font-size: 12px; font-variant-numeric: tabular-nums; min-width: 44px; text-align: center; }
  .spalte-body { flex: 1; min-height: 0; overflow: auto; background: #52616b; border-radius: 8px;
                 padding: 10px; position: relative; display: flex; justify-content: center; }
  .seite-wrap { position: relative; width: fit-content; }
  .hinweis { position: absolute; inset: 10px; display: flex; align-items: center; justify-content: center;
             padding: 16px; text-align: center; font-size: 12.5px; color: #fff;
             background: rgba(0, 0, 0, .4); border-radius: 8px; }
</style>
