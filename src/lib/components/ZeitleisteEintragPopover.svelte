<script module lang="ts">
  import type { ZeitleisteEintragArt, ZeitangabeArt } from '@j-desk/core';

  /**
   * Zeitleisten-Eintrags-Popover (CHRONO-01/02) — Struktur/Stil wortgleich zur `.popover`-Vorlage
   * aus `LinkLayer.svelte` (weiße Karte, Radius 10px, Schatten, Abstand 8px). Arbeitet
   * ausschließlich auf `ui.zeitleisteEintragEntwurf` (09-01 Task 3) — Neuanlage ohne `eintragId`,
   * Bearbeiten mit gesetzter `eintragId`.
   *
   * Die drei Zuordnungskonstanten leben bewusst im `module`-Skript (nicht im Instanz-Skript) —
   * nur so sind sie echte, importierbare ES-Modul-Exports statt Svelte-Komponenten-Props, und
   * `ZeitleisteCard.svelte` (Task 3) kann sie als einzige Quelle für die Achsen-Marker wiederverwenden.
   */

  /** Icon+Text-Beschriftung der sieben Eintragsarten (CHRONO-01), vollständig über den
   *  Literaltyp — eine vergessene Art wäre ein Übersetzungsfehler (Muster LINK_MEANING_LABELS in
   *  LinkLayer.svelte). Reihenfolge im Dropdown folgt ZEITLEISTE_EINTRAG_ARTEN. */
  export const ZEITLEISTE_ART_LABELS: Record<ZeitleisteEintragArt, string> = {
    ereignis: 'Ereignis',
    dokument: 'Dokument',
    email: 'E-Mail',
    bescheid: 'Bescheid',
    frist: 'Frist',
    zahlung: 'Zahlung',
    zeugenaussage: 'Zeugenaussage',
  };

  /** Kompakte Achsen-Icons je Art (09-UI-SPEC.md Design System) — `dokument` bewusst leer, weil
   *  das referenzierte Objekt bereits seine eigene Dokumentoptik mitbringt. Der leere Wert ist
   *  Teil der vollständigen Zuordnung, keine Auslassung — auch `ZeitleisteCard.svelte` (Task 3)
   *  liest ausschließlich diese Konstante, keine zweite Liste. */
  export const ZEITLEISTE_ART_ICONS: Record<ZeitleisteEintragArt, string> = {
    ereignis: '⚡',
    dokument: '',
    email: '✉',
    bescheid: '📋',
    frist: '⏳',
    zahlung: '💶',
    zeugenaussage: '🗣',
  };

  /** Beschriftung der fünf Zeitangaben (CHRONO-02), Reihenfolge folgt ZEITANGABE_ARTEN
   *  (Genau/Ungefähr/Zeitraum/Streitig/Aus Dokument abgeleitet — 09-UI-SPEC.md Copywriting). */
  export const ZEITANGABE_LABELS: Record<ZeitangabeArt, string> = {
    genau: 'Genau',
    ungefaehr: 'Ungefähr',
    zeitraum: 'Zeitraum',
    streitig: 'Streitig',
    abgeleitet: 'Aus Dokument abgeleitet',
  };

  /** Optionstext im „Art"-Dropdown: immer Icon+Text zusammen, nie Icon allein (09-UI-SPEC.md
   *  Design-System-Label-Fallback-Pflicht) — Ausnahme „Dokument" ohne Icon. */
  function artOptionText(art: ZeitleisteEintragArt): string {
    const icon = ZEITLEISTE_ART_ICONS[art];
    return icon === '' ? ZEITLEISTE_ART_LABELS[art] : `${icon} ${ZEITLEISTE_ART_LABELS[art]}`;
  }
</script>

<script lang="ts">
  import {
    ZEITLEISTE_EINTRAG_ARTEN, ZEITANGABE_ARTEN, findeObjekt,
    addZeitleisteEintrag, setZeitleisteEintrag, removeZeitleisteEintrag,
    docBox, noteBox, cutoutBox, legalObjectBox, stackBox, tableBox, zeitleisteBox,
    type Vec2, type Box,
    type Doc, type Note, type Cutout, type LegalObject, type Stack, type TableCard, type ZeitleisteCard as ZeitleisteKarte,
  } from '@j-desk/core';
  import { uid } from '../uid';
  import { desktop } from '../store.svelte';
  import { ui } from '../ui.svelte';

  let { anchor }: { anchor: Vec2 } = $props();

  const entwurf = $derived(ui.zeitleisteEintragEntwurf);

  const bestehenderEintrag = $derived.by(() => {
    if (!entwurf?.eintragId) return undefined;
    const zl = (desktop.state.zeitleisten ?? []).find((z) => z.id === entwurf.zeitleisteId);
    return zl?.eintraege.find((e) => e.id === entwurf.eintragId);
  });

  let art = $state<ZeitleisteEintragArt>('ereignis');
  let zeitangabe = $state<ZeitangabeArt>('genau');
  let datum = $state('');
  let datumBis = $state('');

  // Formularfelder aus dem Entwurf initialisieren: Neuanlage bekommt Defaults, Bearbeiten den
  // bestehenden Eintrag. Läuft nur, wenn sich der ZIEL-Eintrag ändert (nicht bei jedem
  // Store-Update) — sonst würde eine laufende Nutzereingabe bei jedem Tick überschrieben.
  let letzteEintragId: string | null = null;
  $effect(() => {
    const zielId = entwurf?.eintragId ?? null;
    if (zielId === letzteEintragId) return;
    letzteEintragId = zielId;
    if (bestehenderEintrag) {
      art = bestehenderEintrag.art;
      zeitangabe = bestehenderEintrag.zeitangabe;
      datum = bestehenderEintrag.datum;
      datumBis = bestehenderEintrag.datumBis ?? '';
    } else {
      art = 'ereignis';
      zeitangabe = 'genau';
      datum = '';
      datumBis = '';
    }
  });

  /** Knopf „Eintragen" bleibt gesperrt, solange kein gültiges Datum gesetzt ist; bei „Zeitraum"
   *  solange nicht beide Daten gesetzt sind und das Ende nicht vor dem Start liegt. Kein stiller
   *  Rückfall auf eine andere Zeitangabe. */
  const gueltig = $derived(
    zeitangabe === 'zeitraum' ? datum !== '' && datumBis !== '' && datumBis >= datum : datum !== '',
  );

  const quelle = $derived(entwurf ? findeObjekt(desktop.state, entwurf.objRef) : undefined);

  /** Box des referenzierten Objekts für „Zur Quelle springen" — je nach Objektart (analog
   *  `labelFuer()` in ZeitleisteCard.svelte, das ebenfalls nur den projizierten Zustand liest). */
  const quelleBox = $derived.by((): Box | null => {
    if (!quelle) return null;
    const o = quelle.obj as unknown;
    switch (quelle.art) {
      case 'docs': return docBox(o as Doc);
      case 'notes': return noteBox(o as Note);
      case 'cutouts': return cutoutBox(o as Cutout);
      case 'legalObjects': return legalObjectBox(o as LegalObject);
      case 'stacks': return stackBox(o as Stack);
      case 'tables': return tableBox(o as TableCard);
      case 'zeitleisten': return zeitleisteBox(o as ZeitleisteKarte);
      default: return null;
    }
  });

  function schliessen(): void {
    ui.zeitleisteEintragEntwurf = null;
  }

  function eintragen(): void {
    if (!entwurf || !gueltig) return;
    const zeitleisteId = entwurf.zeitleisteId;
    // Command-Payload trägt bei Nicht-Zeitraum bewusst `datumBis: null` (nicht `undefined`) —
    // JSON kennt kein undefined, `null` ist das vereinbarte „ausdrücklich entfernen"-Signal
    // (commands.ts zeitleisteEintragFelder()). Der optimistische Kern-Aufruf bekommt dieselbe
    // Bedeutung über ein tatsächlich VORHANDENES Feld mit Wert `undefined` (setZeitleisteEintrag
    // prüft mit `in`, nicht mit `!== undefined`).
    const datumBisFuerCommand = zeitangabe === 'zeitraum' ? datumBis : null;
    if (entwurf.eintragId) {
      const eintragId = entwurf.eintragId;
      const felderLokal = { art, zeitangabe, datum, datumBis: zeitangabe === 'zeitraum' ? datumBis : undefined };
      desktop.applyLocal((s) => setZeitleisteEintrag(s, zeitleisteId, eintragId, felderLokal));
      void desktop.command('setZeitleisteEintrag', { zeitleisteId, eintragId, art, zeitangabe, datum, datumBis: datumBisFuerCommand });
    } else {
      const neueId = uid();
      const datumBisLokal = zeitangabe === 'zeitraum' ? datumBis : undefined;
      desktop.applyLocal((s) => addZeitleisteEintrag(s, zeitleisteId, entwurf.objRef, art, zeitangabe, datum, datumBisLokal, neueId));
      void desktop.command('addZeitleisteEintrag', {
        zeitleisteId, objRef: entwurf.objRef, art, zeitangabe, datum, datumBis: datumBisFuerCommand, id: neueId,
      });
    }
    schliessen();
  }

  function entfernen(): void {
    if (!entwurf?.eintragId) return;
    const zeitleisteId = entwurf.zeitleisteId;
    const eintragId = entwurf.eintragId;
    desktop.applyLocal((s) => removeZeitleisteEintrag(s, zeitleisteId, eintragId));
    void desktop.command('removeZeitleisteEintrag', { zeitleisteId, eintragId });
    schliessen();
  }

  /** „Zur Quelle springen" nutzt dieselbe Zentrier-Leitung wie die Kartensuche und
   *  `desktop.jumpTo()` (Desktop.svelte, `ui.jumpRequest`-Effekt) — hier direkt gesetzt, weil das
   *  Ziel ein Weltobjekt auf dem Tisch ist, keine PDF-Fundstelle (jump.ts). */
  function zurQuelleSpringen(): void {
    if (!quelleBox) return;
    ui.jumpRequest = { box: quelleBox };
    schliessen();
  }

  // Klick außerhalb schließt das Formular (Escape läuft bereits global über Desktop.svelte, das
  // ui.zeitleisteEintragEntwurf seit 09-01 Task 3 zurücksetzt — hier nur noch der Klick-außerhalb-
  // Fall). Ein Fenster-Listener statt eines Backdrop-Divs, weil dieses Popover innerhalb des
  // transformierten `.world`-Containers lebt (Desktop.svelte `style:transform`) — ein
  // `position: fixed`-Backdrop dort würde nicht den ganzen Bildschirm abdecken (CSS: eine
  // Transformation auf einem Vorfahren erzeugt einen neuen Containing Block für fixed-Kinder).
  let popoverEl = $state<HTMLDivElement | null>(null);
  function beiFensterZeiger(e: PointerEvent): void {
    if (!entwurf) return;
    if (popoverEl && e.target instanceof Node && popoverEl.contains(e.target)) return;
    schliessen();
  }
</script>

<svelte:window onpointerdown={beiFensterZeiger} />

{#if entwurf}
  <div class="popover" role="dialog" tabindex="-1" aria-label="Zeitleisten-Eintrag"
       bind:this={popoverEl}
       style:left="{anchor.x}px" style:top="{anchor.y}px"
       onpointerdown={(e) => e.stopPropagation()}>
    <div class="titel">Zeitleisten-Eintrag</div>
    <label class="feld">
      <span>Art</span>
      <select aria-label="Art" bind:value={art}>
        {#each ZEITLEISTE_EINTRAG_ARTEN as wert (wert)}
          <option value={wert}>{artOptionText(wert)}</option>
        {/each}
      </select>
    </label>
    <label class="feld">
      <span>Zeitangabe</span>
      <select aria-label="Zeitangabe" bind:value={zeitangabe}>
        {#each ZEITANGABE_ARTEN as wert (wert)}
          <option value={wert}>{ZEITANGABE_LABELS[wert]}</option>
        {/each}
      </select>
    </label>
    {#if zeitangabe === 'zeitraum'}
      <div class="datum-paar">
        <label class="feld">
          <span>Start</span>
          <input type="date" aria-label="Startdatum" bind:value={datum} />
        </label>
        <label class="feld">
          <span>Ende</span>
          <input type="date" aria-label="Enddatum" bind:value={datumBis} />
        </label>
      </div>
    {:else}
      <label class="feld">
        <span>Datum</span>
        <input type="date" aria-label="Datum" bind:value={datum} />
      </label>
    {/if}
    {#if quelleBox}
      <button class="quelle" onclick={zurQuelleSpringen}>Zur Quelle springen</button>
    {/if}
    <div class="row">
      {#if entwurf.eintragId}
        <button onclick={entfernen}>Eintrag entfernen</button>
      {/if}
      <button class="primaer" disabled={!gueltig} onclick={eintragen}>Eintragen</button>
    </div>
  </div>
{/if}

<style>
  .popover { position: absolute; transform: translate(-50%, -50%); z-index: 100000; width: 230px;
             background: var(--glass-elevated-bg); color: var(--glass-text);
             border: 1px solid var(--glass-border); border-radius: 10px;
             backdrop-filter: var(--glass-blur-elevated); -webkit-backdrop-filter: var(--glass-blur-elevated);
             box-shadow: var(--glass-shadow-lg); padding: 10px;
             display: flex; flex-direction: column; gap: 8px; }
  .titel { font-size: 13px; font-weight: 600; }
  .feld { display: flex; flex-direction: column; gap: 2px; font-size: 12px; }
  /* Felder und Knöpfe tragen die Glass-Tokens statt der Browser-Standardoptik: die Popover-Fläche
     ist halbtransparent und wird über hellen Tischflächen dunkel (.hell) — graue Systemsteuerelemente
     mit dunklem Text wären dort unlesbar (gleiche Ursache wie 5ec6c91). */
  .feld select, .feld input { font: inherit; font-size: 12px; box-sizing: border-box; padding: 5px 6px;
                              border: 1px solid var(--glass-separator); border-radius: 6px;
                              background: var(--glass-input-bg); color: var(--glass-text); }
  .datum-paar { display: flex; gap: 8px; }
  .datum-paar .feld { flex: 1; }
  /* color: inherit statt Markenblau — Textlink-Muster auf Glasflächen (VorschlaegeDialog.svelte). */
  .quelle { align-self: flex-start; font-size: 12px; background: none; border: none; color: inherit;
            cursor: pointer; padding: 0; text-decoration: underline; }
  .row { display: flex; justify-content: space-between; gap: 8px; }
  .row button { font: inherit; font-size: 12px; cursor: pointer; padding: 6px 10px; border-radius: 6px;
                border: 1px solid var(--glass-border); background: transparent; color: var(--glass-text); }
  .row button:hover { background: var(--glass-hover); }
  .row .primaer { margin-left: auto; background: var(--brand-blue); color: #fff; border-color: transparent;
                  padding: 6px 12px; }
  .row .primaer:hover { background: var(--brand-blue); opacity: .9; }
  .row .primaer:disabled { opacity: .5; cursor: not-allowed; }
</style>
