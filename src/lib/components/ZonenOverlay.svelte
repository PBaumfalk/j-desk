<script lang="ts">
  /**
   * Zonen-Overlay (UX-03, 13-05 Task 3): dünne Bedienschale über den 13-02-Core-Kommandos
   * (addZone/renameZone/removeZone) — keine lokale Zonen-Mutation, jede Änderung geht über
   * desktop.command() (Server bleibt Wahrheit, E4/error-Toast kommt bereits aus dem Bestands-
   * Fehlerpfad in store.svelte.ts, WR-05).
   *
   * Montage: innerhalb der `.world`-transformierten Ebene in Desktop.svelte (world-Koordinaten
   * direkt als CSS-Werte, wie DocCard/NoteCard — kein eigener Projektions-Code nötig).
   *
   * „Zone anlegen…" ist BEWUSST NICHT Teil dieser Fläche (Planner-Annahme, 13-05-PLAN.md): der
   * verbindliche Einstieg ist der Palette-Befehl aus Plan 13-09. Diese Komponente zeigt/bedient
   * nur bereits bestehende Zonen (Zentrieren/Umbenennen/Entfernen).
   */
  import type { Viewport, Zone } from '@j-desk/core';
  import { desktop } from '../store.svelte';
  import { ui } from '../ui.svelte';
  import { aufzeichnen, labelFuer, type VerlaufEintrag } from '../verlauf';

  let { vp = $bindable(), viewW, viewH }: { vp: Viewport; viewW: number; viewH: number } = $props();

  // E4/empty: ohne Zonen wird nichts gerendert (kein Placeholder) — der leere Array-Fall
  // durchläuft einfach ein leeres {#each} weiter unten, kein Sonderfall nötig.
  const zonen = $derived((desktop.state.zones ?? []) as Zone[]);

  /** E4/overflow: überlappen sich zwei Zonen-Ecken (grobe Nähe-Heuristik, keine exakte
   *  Kollisionserkennung), stapelt das SPÄTERE Label vertikal um 8px — einfache Index-Staffelung
   *  über die Zonen-Liste, kein eigener Layout-Algorithmus. */
  const LABEL_STAPEL_OFFSET = 8;
  const NAEHE_SCHWELLE = 40; // Weltpixel — grob die Breite eines schmalen Label-Chips
  function labelYOffset(index: number, zone: Zone): number {
    let n = 0;
    for (let i = 0; i < index; i++) {
      const andere = zonen[i];
      if (Math.abs(andere.rect.x - zone.rect.x) < NAEHE_SCHWELLE && Math.abs(andere.rect.y - zone.rect.y) < NAEHE_SCHWELLE) n++;
    }
    return n * LABEL_STAPEL_OFFSET;
  }

  /** „Auf Zone zentrieren": Viewport-Zentrierung auf die Rechteck-Mitte, instant ohne Tween
   *  (Bestands-Sprungkonvention) — Skalierung bleibt unverändert (kein Fit, nur Zentrieren, wie
   *  im UI-SPEC-Wortlaut). Erzeugt genau EINEN Verlaufseintrag „Zone: {Name}". */
  function zentriereAufZone(zone: Zone): void {
    const cx = zone.rect.x + zone.rect.w / 2;
    const cy = zone.rect.y + zone.rect.h / 2;
    vp = { scale: vp.scale, x: viewW / 2 - cx * vp.scale, y: viewH / 2 - cy * vp.scale };
    const eintrag: VerlaufEintrag = { vp, ausloeser: 'zone', label: labelFuer({ ausloeser: 'zone', name: zone.name }) };
    ui.verlauf = aufzeichnen(ui.verlauf, eintrag);
  }

  /** Öffnet das dreiteilige Kontextmenü am Klickpunkt (Bildschirmkoordinaten — `ui.menu` ist
   *  `position: fixed`, s. ContextMenu.svelte). „Zone umbenennen…" ersetzt den Menüinhalt erst
   *  im nächsten Tick (Muster Desktop.svelte::zettelTypAuswahl „Eigener…"), sonst schließt
   *  ContextMenu.svelte das gerade geöffnete Menü sofort wieder. */
  function oeffneZonenMenu(x: number, y: number, zone: Zone): void {
    ui.menu = {
      x, y,
      items: [
        { label: 'Auf Zone zentrieren', action: () => zentriereAufZone(zone) },
        {
          label: 'Zone umbenennen…',
          action: () => queueMicrotask(() => {
            ui.menu = {
              x, y, items: [],
              input: {
                placeholder: 'Zonenname',
                maxlength: 40,
                onSubmit: (t) => void desktop.command('renameZone', { id: zone.id, name: t }),
                onEscape: () => oeffneZonenMenu(x, y, zone),
              },
            };
          }),
        },
        // Kein Bestätigungsdialog (Muster Ansicht löschen, ansichtEntfernen ohne confirm()) —
        // die Anlage ist über dieselbe Anlage-mit-derselben-id-Logik reversibel wie eine Ansicht.
        { label: 'Zone entfernen', action: () => void desktop.command('removeZone', { id: zone.id }) },
      ],
    };
  }
</script>

{#each zonen as zone, i (zone.id)}
  <div class="zone" style:left="{zone.rect.x}px" style:top="{zone.rect.y}px"
       style:width="{zone.rect.w}px" style:height="{zone.rect.h}px" aria-hidden="true">
    <button class="label" style:top="{labelYOffset(i, zone)}px"
            onclick={(e) => oeffneZonenMenu(e.clientX, e.clientY, zone)}
            title={zone.name} aria-label={`Zone „${zone.name}" — Menü öffnen`}>
      {zone.name}
    </button>
  </div>
{/each}

<style>
  /* Zonen-Rechteck: 1px-Outline, BEWUSST durchgezogen statt gestrichelt (das gestrichelte Muster
     ist seit Phase 12 „KI-Entwurf, noch nicht wirksam" — Verwechslungsverbot, must_haves.
     prohibitions). z-index über den Karten (typische zIndex-Werte bleiben weit darunter), aber
     unter Popovern/Menüs (99998+). */
  .zone { position: absolute; border: 1px solid var(--glass-border); border-style: solid;
          pointer-events: none; z-index: 500; border-radius: 2px; }
  /* Label-Chip an der linken oberen Zonen-Ecke — Glass-Card-Hintergrund, 12px Label. */
  .label { position: absolute; left: 0; top: 0; transform: translateY(-50%);
           pointer-events: auto; cursor: pointer; max-width: 220px;
           padding: 3px 8px; border-radius: 6px; border: 1px solid var(--glass-border);
           background: var(--glass-card-bg); color: var(--glass-text);
           backdrop-filter: var(--glass-blur-card); -webkit-backdrop-filter: var(--glass-blur-card);
           font-size: 12px; line-height: 1.3;
           overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .label:hover { background: var(--glass-elevated-bg); }
</style>
