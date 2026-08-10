<script lang="ts">
  import {
    CARD_W, CARD_H, cutoutBox, docBox, findCutout, findDoc, findLegalObject, findNote, findStack, findTable,
    findZeitleiste, legalObjectBox, noteBox, stackOf, tableBox, zeitleisteBox, setLinkNote, setLinkKind,
    familieVon, istVersionLink,
    type LinkMeaning, type Vec2,
  } from '@j-desk/core';
  import { debounce } from '../debounce';
  import { desktop } from '../store.svelte';

  /** Anzeigenamen der 11 Bedeutungswerte (LEGAL-02, REQUIREMENTS.md Zeile 78) — gesperrter
      Wortlaut, nicht umformulieren. */
  const LINK_MEANING_LABELS: Record<LinkMeaning, string> = {
    belegt: 'belegt',
    widerspricht: 'widerspricht',
    bestaetigt: 'bestätigt',
    widerlegt: 'widerlegt',
    'gehoert-zu': 'gehört zu',
    entkraeftet: 'entkräftet',
    'folge-von': 'Folge von',
    'voraussetzung-fuer': 'Voraussetzung für',
    'offene-frage': 'offene Frage',
    streitig: 'streitig',
    unstreitig: 'unstreitig',
  };

  /** Dropdown-Gruppierung nach den drei Familien (08-UI-SPEC.md), Reihenfolge je Gruppe folgt
      der Familientabelle. Feste Listen statt aus LINK_MEANING_FAMILY abgeleitet, damit die
      <optgroup>-Reihenfolge (Bestätigend, Widersprechend, Offen) explizit bleibt; die
      Vollständigkeit aller 11 Werte je Familie ist bereits in links.test.ts bewiesen. */
  const LINK_MEANING_GRUPPEN: { name: string; werte: LinkMeaning[] }[] = [
    { name: 'Bestätigend', werte: ['belegt', 'bestaetigt', 'gehoert-zu', 'folge-von', 'voraussetzung-fuer', 'unstreitig'] },
    { name: 'Widersprechend', werte: ['widerspricht', 'widerlegt', 'entkraeftet', 'streitig'] },
    { name: 'Offen', werte: ['offene-frage'] },
  ];

  /** Kürzt Freitext auf 40 Zeichen mit Ellipsis; der Volltext steht im title-Attribut. */
  function kuerzen(text: string, max = 40): string {
    return text.length > max ? `${text.slice(0, max)}…` : text;
  }

  const sendNote = debounce(400, (linkId: string, note: string) => {
    void desktop.command('setLinkNote', { linkId, note });
  });

  let openLinkId = $state<string | null>(null);
  const openLink = $derived(desktop.state.links.find((l) => l.id === openLinkId) ?? null);

  /** Linien-Endpunkt: Kartenmitte (bei aufgeschlagenen Karten die Viewer-Mitte);
      liegt das Dokument in einem Stapel, endet die Linie am Stapel. */
  function endpoint(id: string): Vec2 | null {
    const s = desktop.state;
    const stack = findStack(s, id) ?? stackOf(s, id);
    if (stack) return { x: stack.position.x + (CARD_W + 24) / 2, y: stack.position.y + (CARD_H + 24) / 2 };
    const n = findNote(s, id);
    if (n) {
      const nb = noteBox(n);
      return { x: nb.x + nb.w / 2, y: nb.y + nb.h / 2 };
    }
    const c = findCutout(s, id);
    if (c) {
      const cb = cutoutBox(c);
      return { x: cb.x + cb.w / 2, y: cb.y + cb.h / 2 };
    }
    const o = findLegalObject(s, id);
    if (o) {
      const ob = legalObjectBox(o);
      return { x: ob.x + ob.w / 2, y: ob.y + ob.h / 2 };
    }
    const t = findTable(s, id);
    if (t) {
      const tb = tableBox(t);
      return { x: tb.x + tb.w / 2, y: tb.y + tb.h / 2 };
    }
    // CR-02: Zeitleisten fehlte hier — showZeitleisteMenuAt() bot "Verknüpfen…" bereits an
    // (09-UI-SPEC.md: "Verknüpfen … identisch zum Bestand"), aber ohne diesen Zweig landete eine
    // Zeitleiste im findDoc-Fallback darunter und ergab null: Link wurde erzeugt, aber weder Linie
    // noch Popover konnten je gezeichnet werden (permanent unsichtbar, unlösbar über die UI).
    const zl = findZeitleiste(s, id);
    if (zl) {
      const zb = zeitleisteBox(zl);
      return { x: zb.x + zb.w / 2, y: zb.y + zb.h / 2 };
    }
    const d = findDoc(s, id);
    if (!d) return null;
    const b = docBox(d);
    return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  }

  function curve(a: Vec2, b: Vec2): string {
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    return `M ${a.x} ${a.y} Q ${mx - (dy / len) * 40} ${my + (dx / len) * 40} ${b.x} ${b.y}`;
  }
</script>

<svg class="links">
  <!-- Richtungspfeil der Versionskette (COMP-03): EIN Markerelement für alle Versionslinien,
       nicht je Linie neu definiert — die Pfeilfarbe folgt der Linienfarbe, weil beide aus
       demselben Farbwert stammen (var(--brand-navy-hover), 09-UI-SPEC.md). -->
  <defs>
    <marker id="pfeil-versionskette" viewBox="0 0 10 10" refX="9" refY="5"
            markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--brand-navy-hover, #123256)" />
    </marker>
  </defs>
  {#each desktop.state.links as link (link.id)}
    {@const a = endpoint(link.fromId)}
    {@const b = endpoint(link.toId)}
    {#if a && b}
      <!-- Die Weiche prüft ZUERST die Strukturkennzeichnung, erst danach fällt sie auf
           familieVon(link.kind) für die drei Bedeutungsfamilien zurück — eine Versionsbeziehung
           trägt nie eine Bedeutung, die Reihenfolge ist deshalb bewusst so und nicht umgekehrt. -->
      {@const versionslinie = istVersionLink(link)}
      <path d={curve(a, b)} class="hit" role="button" tabindex="-1" aria-label="Verknüpfung öffnen"
            onpointerdown={(e) => { e.stopPropagation(); openLinkId = link.id; }} />
      {#if versionslinie}
        <path d={curve(a, b)} class="line familie-versionskette" marker-end="url(#pfeil-versionskette)" />
        <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 + 16} text-anchor="middle" class="bedeutung">neue Version von →</text>
        {#if link.note}
          <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 + 30} text-anchor="middle" class="note" {...{ title: link.note }}>{kuerzen(link.note)}</text>
        {/if}
      {:else}
        {@const familie = familieVon(link.kind)}
        <path d={curve(a, b)} class="line familie-{familie}" />
        {#if link.kind}
          <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 + 16} text-anchor="middle" class="bedeutung">{LINK_MEANING_LABELS[link.kind]}</text>
          {#if link.note}
            <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 + 30} text-anchor="middle" class="note" {...{ title: link.note }}>{kuerzen(link.note)}</text>
          {/if}
        {:else if link.note}
          <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 + 28} text-anchor="middle" class="note" {...{ title: link.note }}>{kuerzen(link.note)}</text>
        {/if}
      {/if}
    {/if}
  {/each}
</svg>

{#if openLink}
  {@const a = endpoint(openLink.fromId)}
  {@const b = endpoint(openLink.toId)}
  {#if a && b}
    <!-- Kein Bedeutungs-Auswahlfeld für eine Versionslinie (Task 2, COMP-03): die
         Versionsbeziehung ist kein zwölfter LinkMeaning-Wert — ein <select> hier würde genau
         diese Verwechslung nahelegen. Die Beziehung wird ausschließlich über den eigenen
         Zwei-Klick-Modus (ui.versionFromId) gesetzt, nie über dieses Popover. -->
    {@const istVersion = istVersionLink(openLink)}
    <div class="popover" role="dialog" tabindex="-1" aria-label={istVersion ? 'Versionsbeziehung' : 'Verknüpfungsnotiz'} style:left="{(a.x + b.x) / 2}px" style:top="{(a.y + b.y) / 2}px"
         onpointerdown={(e) => e.stopPropagation()}>
      {#if !istVersion}
        <label class="feld">
          <span>Bedeutung</span>
          <select
            aria-label="Bedeutung"
            value={openLink.kind ?? ''}
            onchange={(e) => {
              const raw = (e.currentTarget as HTMLSelectElement).value;
              const kind = raw === '' ? undefined : (raw as LinkMeaning);
              desktop.applyLocal((s) => setLinkKind(s, openLink.id, kind));
              void desktop.command('setLinkKind', { linkId: openLink.id, kind: kind ?? null });
            }}
          >
            <option value="">— keine Bedeutung —</option>
            <optgroup label={LINK_MEANING_GRUPPEN[0].name}>
              {#each LINK_MEANING_GRUPPEN[0].werte as wert (wert)}
                <option value={wert}>{LINK_MEANING_LABELS[wert]}</option>
              {/each}
            </optgroup>
            <optgroup label={LINK_MEANING_GRUPPEN[1].name}>
              {#each LINK_MEANING_GRUPPEN[1].werte as wert (wert)}
                <option value={wert}>{LINK_MEANING_LABELS[wert]}</option>
              {/each}
            </optgroup>
            <optgroup label={LINK_MEANING_GRUPPEN[2].name}>
              {#each LINK_MEANING_GRUPPEN[2].werte as wert (wert)}
                <option value={wert}>{LINK_MEANING_LABELS[wert]}</option>
              {/each}
            </optgroup>
          </select>
        </label>
      {/if}
      <textarea placeholder="Notiz zur Verknüpfung…" value={openLink.note}
        oninput={(e) => {
          const note = (e.currentTarget as HTMLTextAreaElement).value;
          desktop.applyLocal((s) => setLinkNote(s, openLink.id, note));
          sendNote(openLink.id, note);
        }}
      ></textarea>
      <div class="row">
        <button onclick={() => {
          if (istVersion) void desktop.command('removeVersionLink', { linkId: openLink.id });
          else void desktop.command('removeLink', { linkId: openLink.id });
          openLinkId = null;
        }}>Verknüpfung lösen</button>
        <button onclick={() => (openLinkId = null)}>Schließen</button>
      </div>
    </div>
  {/if}
{/if}

<style>
  svg.links { position: absolute; overflow: visible; width: 1px; height: 1px; }
  path.line { fill: none; stroke-width: 2; pointer-events: none; }
  path.line.familie-bestaetigend { stroke: #5fa87a; }
  path.line.familie-widersprechend { stroke: #d9686a; }
  path.line.familie-offen { stroke: #f2e2b8; stroke-dasharray: 6 4; }
  /* Versionskette (COMP-03): vierte Familie, strukturell statt evidenzbezogen — bewusst 3px
     statt der 2px der drei Bestandsfamilien, durchgezogen, mit Richtungspfeil (s. <defs> oben). */
  path.line.familie-versionskette { stroke: var(--brand-navy-hover, #123256); stroke-width: 3; }
  path.hit { fill: none; stroke: transparent; stroke-width: 14; cursor: pointer; }
  text.note { fill: #fdf9ec; font-size: 12px; paint-order: stroke; stroke: rgba(0, 0, 0, .55); stroke-width: 3px; }
  text.bedeutung { fill: #fdf9ec; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em;
                   paint-order: stroke; stroke: rgba(0, 0, 0, .55); stroke-width: 3px; }
  .popover { position: absolute; transform: translate(-50%, 10px); z-index: 100000; width: 230px;
             background: var(--glass-elevated-bg); color: var(--glass-text);
             border: 1px solid var(--glass-border); border-radius: 10px;
             backdrop-filter: var(--glass-blur-elevated); -webkit-backdrop-filter: var(--glass-blur-elevated);
             box-shadow: var(--glass-shadow-lg); padding: 10px;
             display: flex; flex-direction: column; gap: 8px; }
  .feld { display: flex; flex-direction: column; gap: 2px; font-size: 12px; }
  /* Felder und Knöpfe tragen die Glass-Tokens statt der Browser-Standardoptik: die Popover-Fläche
     ist halbtransparent und wird über hellen Tischflächen dunkel (.hell) — graue Systemsteuerelemente
     mit dunklem Text wären dort unlesbar (gleiche Ursache wie 5ec6c91). */
  .feld select { font: inherit; font-size: 12px; box-sizing: border-box; padding: 5px 6px;
                 border: 1px solid var(--glass-separator); border-radius: 6px;
                 background: var(--glass-input-bg); color: var(--glass-text); }
  textarea { width: 100%; min-height: 60px; font: inherit; font-size: 12px; box-sizing: border-box;
             padding: 6px 8px; border: 1px solid var(--glass-separator); border-radius: 6px;
             background: var(--glass-input-bg); color: var(--glass-text); }
  .row { display: flex; justify-content: space-between; gap: 8px; }
  .row button { font: inherit; font-size: 12px; cursor: pointer; padding: 6px 10px; border-radius: 6px;
                border: 1px solid var(--glass-border); background: transparent; color: var(--glass-text); }
  .row button:hover { background: var(--glass-hover); }
</style>
