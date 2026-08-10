<script lang="ts">
  /**
   * Präsenz-Rosette (06-03, COLLAB-01): Werkzeugleisten-Button mit Aufklappliste, die zeigt, wer
   * gerade auf diesem Schreibtisch arbeitet und — soweit für den Betrachter sichtbar — woran.
   * Struktur bewusst gespiegelt von Desktop.svelte `.ebenen-wrap`/`.ebenen-menu` (Button öffnet
   * Dropdown darunter, Backdrop-Klick und Escape schließen) — kein neues Interaktionsmuster.
   */
  import { deskBackground, findeObjekt } from '@j-desk/core';
  import { desktop } from '../store.svelte';
  import { isLight } from '../deskThemes';
  import { ui } from '../ui.svelte';
  import { anderePersonen } from '../presence.svelte';
  import { identityColor } from '../identityColor';

  /** 06-01/06-02: der Server (`presence.ts` `praesenzRoster()`) schließt den eigenen Eintrag
   *  bereits aus JEDER ausgelieferten Präsenzmeldung aus (06-03-Deviation, siehe
   *  06-03-SUMMARY.md) — `praesenz.personen` enthält den Betrachter selbst daher nie. Dieses
   *  Prop bleibt dennoch Teil des vereinbarten Komponentenvertrags (Artefakt-Tabelle,
   *  06-03-PLAN.md) für eine mögliche künftige clientseitige Verwendung, wird hier aber bewusst
   *  mit `null` befüllt: eine eigene userId ist clientseitig aktuell nirgends bekannt und wird
   *  durch den serverseitigen Ausschluss auch nicht mehr benötigt. */
  let { eigeneUserId }: { eigeneUserId: string | null } = $props();

  const personen = $derived(anderePersonen(eigeneUserId));

  // Überlauf (UI-SPEC „overflow — mehr als 4 gleichzeitig verbunden"): ab der 5. Person zeigt
  // der Button die verdichtete Kurzform „+N" statt der Einzelanzahl. Die Personenliste selbst
  // wird dafür NICHT gekürzt (kein slice() auf `personen` — nur diese Kurzanzeige verdichtet).
  const kurzanzeige = $derived(personen.length >= 5 ? `+${personen.length}` : `${personen.length}`);

  // Dunkles/helles Glas: dieselbe Themenerkennung wie Desktop.svelte (dort `class:hell` auf
  // `.desk` über isLight(hintergrund.themeId)) — keine zweite Themenerkennung einführen.
  // identityColor()s zweiter Parameter "dunkel" (dunkles Theme aktiv) erwartet, isLight() aber
  // das Gegenteil liefert — daher die Negation (wie DocCard.svelte/NoteCard.svelte).
  const dunkel = $derived(!isLight(deskBackground(desktop.state).themeId));

  /** Anzeigename des gerade bearbeiteten Objekts — fail-safe: liefert `undefined` statt zu
   *  crashen, wenn das Objekt inzwischen verschwunden ist. Notizen tragen `text` statt `name`,
   *  daher der zweite Fallback (Cast wie `presence.ts` `sichtbareObjektIdFuer()` auf
   *  `{ layerId?: string }` — hier auf `{ name?: string; text?: string }`, da `Versioniert`
   *  strukturell nur `id`/`updatedRev`/`updatedAt`/`updatedBy` kennt). */
  function kartenName(objektId: string | undefined): string | undefined {
    if (!objektId) return undefined;
    const treffer = findeObjekt(desktop.state, objektId);
    if (!treffer) return undefined;
    const obj = treffer.obj as { name?: string; text?: string };
    if (typeof obj.name === 'string' && obj.name) return obj.name;
    if (typeof obj.text === 'string' && obj.text) return obj.text;
    return undefined;
  }
</script>

{#if personen.length > 0}
  <!-- Empty/Loading State (UI-SPEC): ohne andere verbundene Personen entfällt der Button
       vollständig — kein Ausgrauen, kein Zwischenzustand vor der ersten Präsenzmeldung (beide
       Zustände sehen optisch identisch aus: nichts). -->
  <div class="praesenz-wrap">
    <button
      class="praesenz-current"
      class:offen={ui.praesenzOffen}
      onclick={() => (ui.praesenzOffen = !ui.praesenzOffen)}
      aria-label={`Anwesend: ${personen.map((p) => p.name).join(', ')}`}
      title="Wer arbeitet gerade hier"
      aria-expanded={ui.praesenzOffen}
    >👀 {kurzanzeige}</button>
    {#if ui.praesenzOffen}
      <div class="backdrop" role="presentation"
           onpointerdown={(e) => { e.stopPropagation(); ui.praesenzOffen = false; }}></div>
      <div class="praesenz-menu" role="menu" tabindex="-1" onpointerdown={(e) => e.stopPropagation()}>
        <div class="titel">Auf diesem Schreibtisch</div>
        <!-- Überlauf bei vielen Personen (UI-SPEC, Task 2): der Button oben verdichtet ab der
             5. Person zur Kurzform, aber diese Liste selbst wird NIE gekürzt — alle `personen`
             werden gerendert, die Rollbegrenzung übernimmt ausschließlich `.praesenz-menu`s
             `max-height`/`overflow-y` (dieselbe Rollbegrenzung wie das Ebenen-Menü). Kein
             serverseitiges oder clientseitiges Kappen der Personenliste. -->
        {#each personen as p (p.userId)}
          <!-- Rollenwechsel während der Sitzung (UI-SPEC Backstop, Zustand „loading"): p.rolle
               wird bei jedem Rendern frisch aus dem aktuellen Präsenzeintrag gelesen, nirgends
               zwischengespeichert oder beim ersten Sehen einer Person eingefroren — eine
               geänderte Rolle korrigiert sich mit der nächsten Präsenzmeldung von selbst, ohne
               dass ein Neuladen nötig wäre. -->
          {@const bearbeitetName = kartenName(p.objektId)}
          <div class="zeile">
            <div class="kopf">
              <span class="punkt" style={`color:${identityColor(p.userId, dunkel)}`} aria-hidden="true">●</span>
              <!-- Überlauf bei langem Namen (UI-SPEC): einzeiliges Abschneiden mit Auslassungs-
                   punkten, Volltext im title-Attribut — dasselbe Muster wie TrashCan.svelte
                   `.name`/DocCard.svelte `.name`. -->
              <span class="name" title={p.name}>{p.name}</span>
              <span class="rolle">· {p.rolle}</span>
            </div>
            {#if bearbeitetName}
              <!-- Populated/partial (UI-SPEC + PERM-05/T-06-11): der Untertext erscheint
                   ausschließlich, wenn der Server für DIESEN Empfänger eine objektId
                   mitgeliefert hat UND das Objekt clientseitig noch auffindbar ist — sonst
                   entfällt die Zeile ersatzlos (keine Existenz-Info über unsichtbare/gelöschte
                   Objekte, KEIN Platzhaltertext). Auch hier einzeiliges Abschneiden + Volltext
                   im title. -->
              <div class="taetigkeit" title={`bearbeitet „${bearbeitetName}"`}>bearbeitet „{bearbeitetName}"</div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>
{/if}

<style>
  .praesenz-wrap { position: relative; }
  /* Ruhezustand-Optik verbatim aus Desktop.svelte `.toolbar button` übernommen — `.ebenen-current`
     dort erbt dieselbe Optik nur über die CSS-Kaskade des Elternelements; als eigenständige
     Komponente (Svelte-Style-Scoping überschreitet keine Komponentengrenzen) braucht dieser
     Button die Deklaration selbst. */
  .praesenz-current { position: relative; z-index: 9010; font-size: 13px; padding: 6px 12px; border-radius: 8px;
                       border: 1px solid var(--glass-border);
                       background: var(--glass-card-bg); color: var(--glass-text);
                       backdrop-filter: var(--glass-blur-card); -webkit-backdrop-filter: var(--glass-blur-card);
                       cursor: pointer; box-shadow: var(--glass-shadow); }
  .praesenz-current:hover { background: var(--glass-elevated-bg); }
  /* Akzentfarbe (UI-SPEC Color-Abschnitt): ausschließlich für den geöffneten Button-Zustand
     reserviert — keine weitere Regel in dieser Datei greift auf diese Variable zu (kein Akzent
     auf Roster-Zeilen, siehe Prohibitions). */
  .praesenz-current.offen { border-color: var(--brand-blue); }
  .backdrop { position: fixed; inset: 0; z-index: 9011; }
  /* Rahmen/Fläche/Innenabstand/Rollbegrenzung wortgleich aus Desktop.svelte `.ebenen-menu`
     übernommen — einzige bewusste Abweichung ist der neue, phasen-eigene z-index (Task 1). */
  .praesenz-menu { position: absolute; top: 40px; right: 0; z-index: 9012; min-width: 220px; padding: 4px;
                   border-radius: 10px; background: var(--glass-elevated-bg); color: var(--glass-text);
                   border: 1px solid var(--glass-border);
                   backdrop-filter: var(--glass-blur-elevated); -webkit-backdrop-filter: var(--glass-blur-elevated);
                   box-shadow: var(--glass-shadow-lg);
                   display: flex; flex-direction: column; gap: 2px;
                   max-height: calc(100vh - 56px); overflow-y: auto; }
  .titel { padding: 4px 10px 8px; font-size: 15px; font-weight: 600; line-height: 1.3; }
  .zeile { display: flex; flex-direction: column; gap: 2px; padding: 7px 10px; border-radius: 6px; }
  .zeile:hover { background: var(--glass-hover); }
  .kopf { display: flex; align-items: baseline; gap: 4px; min-width: 0; }
  .punkt { flex: none; }
  .name { flex: 1 1 auto; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .rolle { flex: none; font-size: 12px; color: var(--glass-text-secondary); }
  .taetigkeit { padding-left: 14px; font-size: 12px; color: var(--glass-text-secondary);
                white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
