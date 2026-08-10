<script lang="ts">
  import { effektiveFreigabe, findDoc, type Doc, type Ebene, type Freigabe } from '@j-desk/core';
  import { desktop } from '../store.svelte';
  import { fundstelleAusCutout, fundstelleAusFlag, fundstelleAusMark, fundstelleAusStamp, type Fundstelle } from '../jump';
  import { referenzstatusVon } from '../referenzstatus';
  import { istEchteSchwaerzung } from '../markSchwaerzung';
  import { FREIGABE_LABEL } from '../menus';

  let { id, anchor, onclose }: { id: string; anchor?: { x: number; y: number }; onclose: () => void } = $props();

  interface Anzeige {
    /** true: Notiz/Verknüpfung/Klammer/Stapel — nicht quellgebunden (kein docId/fileId),
        kein Dokument-Block und kein Sprung-Button, aber KEIN „Herkunft unbekannt". */
    reduziert: boolean;
    dokumentName: string | null;
    seite: number | null;
    ersteller?: string;
    erstelltAm?: string;
    textSnapshot?: string;
    /** Mark vom Typ "redact" ODER "tippex": der überdeckte Wortlaut wird trotz vorhandenem
        Snapshot nicht angezeigt (T-0103-01, CR-02) — kein neuer Ausleitungsweg für
        geschwärzten Text (beide Mark-Arten schwärzen server-seitig echt, D-01). */
    geschwaerzt: boolean;
    fileSha256?: string;
    fundstelle: Fundstelle | null;
    /** Das quellgebundene Doc-Objekt (für die Referenzstatus-Ableitung, 01-06) — bei nicht
        quellgebundenen Typen (Stapel/Notiz/Verknüpfung/Klammer) immer undefined. */
    referenzstatusDoc?: Doc;
    /** Feldzeile „Freigabe: …" (03-06, UI-SPEC) — nur gesetzt, wenn das Objekt im State
        bekannt ist; gerendert wird sie nur zusammen mit den übrigen Metadatenfeldern
        (bei Altobjekten ohne Provenienz entfällt sie mit ihnen, Phase-1-Konvention). */
    freigabeZeile: string;
  }

  /** Feldzeile „Freigabe: …" (03-06, EXP-03, UI-SPEC): effektive Stufe via effektiveFreigabe
      aus @j-desk/core — derselbe Wert, den der Server dem Export zugrunde legt, keine
      Client-Nachrechnung. Ohne Override am Objekt mit Zusatz „(Ebenen-Standard)"; Altobjekte
      ohne freigabe-Attribut zeigen so nahtlos „Freigabe: Intern (Ebenen-Standard)" (D-14). */
  function freigabeZeileAus(o: { freigabe?: Freigabe; layerId?: string }, layers: Ebene[] | undefined): string {
    const basis = `Freigabe: ${FREIGABE_LABEL[effektiveFreigabe(o, layers)]}`;
    return o.freigabe === undefined ? `${basis} (Ebenen-Standard)` : basis;
  }

  function reduziertAus(o: { createdBy?: string; createdAt?: string; freigabe?: Freigabe; layerId?: string }, layers: Ebene[] | undefined): Anzeige {
    return {
      reduziert: true, dokumentName: null, seite: null,
      ersteller: o.createdBy, erstelltAm: o.createdAt, geschwaerzt: false, fundstelle: null,
      freigabeZeile: freigabeZeileAus(o, layers),
    };
  }

  const anzeige = $derived.by((): Anzeige | null => {
    const s = desktop.state;

    const doc = s.docs.find((d) => d.id === id);
    if (doc) {
      return {
        reduziert: false, dokumentName: doc.name, seite: doc.page ?? 1,
        ersteller: doc.createdBy, erstelltAm: doc.createdAt, geschwaerzt: false,
        fundstelle: { fileId: doc.fileId, page: doc.page ?? 1 },
        referenzstatusDoc: doc,
        freigabeZeile: freigabeZeileAus(doc, s.layers),
      };
    }

    const cutout = (s.cutouts ?? []).find((c) => c.id === id);
    if (cutout) {
      return {
        reduziert: false,
        dokumentName: s.docs.find((d) => d.fileId === cutout.fileId)?.name ?? cutout.sourceName ?? 'unbekanntes Dokument',
        seite: cutout.page, ersteller: cutout.createdBy, erstelltAm: cutout.createdAt,
        textSnapshot: cutout.textSnapshot, geschwaerzt: false, fileSha256: cutout.fileSha256,
        fundstelle: fundstelleAusCutout(cutout),
        referenzstatusDoc: s.docs.find((d) => d.fileId === cutout.fileId),
        freigabeZeile: freigabeZeileAus(cutout, s.layers),
      };
    }

    const mark = (s.marks ?? []).find((m) => m.id === id);
    if (mark) {
      const geschwaerzt = istEchteSchwaerzung(mark.kind);
      return {
        reduziert: false, dokumentName: findDoc(s, mark.docId)?.name ?? 'unbekanntes Dokument',
        seite: mark.page, ersteller: mark.createdBy, erstelltAm: mark.createdAt,
        textSnapshot: geschwaerzt ? undefined : mark.textSnapshot, geschwaerzt, fileSha256: mark.fileSha256,
        fundstelle: fundstelleAusMark(mark),
        referenzstatusDoc: findDoc(s, mark.docId),
        freigabeZeile: freigabeZeileAus(mark, s.layers),
      };
    }

    const stamp = (s.stamps ?? []).find((st) => st.id === id);
    if (stamp) {
      return {
        reduziert: false, dokumentName: findDoc(s, stamp.docId)?.name ?? 'unbekanntes Dokument',
        seite: stamp.page, ersteller: stamp.createdBy, erstelltAm: stamp.createdAt, geschwaerzt: false,
        fundstelle: fundstelleAusStamp(stamp),
        referenzstatusDoc: findDoc(s, stamp.docId),
        freigabeZeile: freigabeZeileAus(stamp, s.layers),
      };
    }

    const flag = (s.flags ?? []).find((f) => f.id === id);
    if (flag) {
      return {
        reduziert: false, dokumentName: findDoc(s, flag.docId)?.name ?? 'unbekanntes Dokument',
        seite: flag.page, ersteller: flag.createdBy, erstelltAm: flag.createdAt, geschwaerzt: false,
        fundstelle: fundstelleAusFlag(flag),
        referenzstatusDoc: findDoc(s, flag.docId),
        freigabeZeile: freigabeZeileAus(flag, s.layers),
      };
    }

    const stack = s.stacks.find((st) => st.id === id);
    if (stack) return reduziertAus(stack, s.layers);
    const note = (s.notes ?? []).find((n) => n.id === id);
    if (note) return reduziertAus(note, s.layers);
    const link = s.links.find((l) => l.id === id);
    if (link) return reduziertAus(link, s.layers);
    // IN-02: bewusst vorbereitet, aktuell aber unerreichbar — es existiert (noch) kein
    // Kontextmenü-Eintrag (z. B. showClipMenu), der ui.provenancePopover mit einer Clip-id
    // befüllt. Kein toter Code im Sinne von Datenverlust, nur Wartungslast ohne UI-Anbindung;
    // bleibt stehen, falls ein „Herkunft"-Eintrag für Klammern fachlich gewünscht wird.
    const clip = (s.clips ?? []).find((c) => c.id === id);
    if (clip) return reduziertAus(clip, s.layers);

    return null;
  });

  /** Referenzstatus-Erklärtext bei Abweichung vom Zustand „existiert". Die Priorität
      (gone > entzogen > nicht erreichbar > ersetzt > umbenannt > archiviert) kommt aus der mit
      DocCard.svelte/DocViewer.svelte geteilten Hilfsfunktion (IN-01) — der ausführlichere
      Popover-Wortlaut selbst bleibt bewusst hier lokal (mehr Kontext als ein Karten-Tooltip).
      Nur quellgebundene Objekte tragen ein referenzstatusDoc; Objekte ohne Doc-Bezug
      (Notiz/Verknüpfung/Klammer/Stapel) zeigen nie einen Referenzstatus. */
  const referenzstatusText = $derived.by((): string | null => {
    const doc = anzeige?.referenzstatusDoc;
    const status = referenzstatusVon(doc);
    if (!status) return null;
    switch (status.kind) {
      case 'gone':
        return 'Das Quelldokument wurde in j-lawyer gelöscht. Ihre Annotationen bleiben erhalten, der Originalinhalt ist jedoch nicht mehr abrufbar.';
      case 'entzogen':
        return 'Ihnen wurde der Zugriff auf dieses Dokument in j-lawyer entzogen. Ihre Annotationen bleiben sichtbar, der Originalinhalt ist für Sie derzeit nicht einsehbar. Wenden Sie sich bei Bedarf an die Aktenverwaltung.';
      case 'nichtErreichbar':
        return 'Das Quelldokument ist derzeit nicht erreichbar. Ihre Annotationen bleiben erhalten. Prüfen Sie die Verbindung zu j-lawyer oder versuchen Sie es später erneut.';
      case 'neueFassung': {
        const datum = doc?.sourceReplacedAt ? new Date(doc.sourceReplacedAt).toLocaleDateString('de-DE') : '';
        return `Das Quelldokument wurde in j-lawyer durch eine neue Fassung ersetzt (aktualisiert am ${datum}). Ihre Annotationen beziehen sich weiterhin auf den damaligen Wortlaut.`;
      }
      case 'umbenannt':
        return 'Das Quelldokument wurde in j-lawyer umbenannt. Der Inhalt ist unverändert, Ihre Annotationen bleiben gültig.';
      case 'archiviert':
        return 'Das Quelldokument wurde in j-lawyer archiviert. Es bleibt über die Archivsuche auffindbar; Ihre Annotationen bleiben unverändert gültig.';
    }
  });

  /** „{Ersteller} · {Datum, Uhrzeit}" im deutschen Format (Copywriting Contract). */
  function formatiertesDatum(iso: string | undefined): string {
    if (!iso) return '';
    const d = new Date(iso);
    return `${d.toLocaleDateString('de-DE')}, ${d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`;
  }

  async function springen(): Promise<void> {
    const ziel = anzeige?.fundstelle;
    if (!ziel) return;
    await desktop.jumpTo(ziel);
    onclose();
  }

  // Kollisions-Clamping im Viewport (Bestandsmuster RadialMenu.svelte cx/cy).
  const RAND = 12;
  const POP_W = 340;
  const POP_H = 340;
  const pos = $derived.by(() => {
    const ax = anchor?.x ?? window.innerWidth / 2;
    const ay = anchor?.y ?? window.innerHeight / 2;
    const maxX = Math.max(RAND, window.innerWidth - POP_W - RAND);
    const maxY = Math.max(RAND, window.innerHeight - POP_H - RAND);
    return { x: Math.min(Math.max(ax, RAND), maxX), y: Math.min(Math.max(ay, RAND), maxY) };
  });
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape') onclose(); }} />

<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -- Backdrop schließt nur -->
<div class="backdrop" onpointerdown={onclose}></div>
<div class="pop" role="dialog" aria-label="Herkunft" style:left="{pos.x}px" style:top="{pos.y}px">
  <h2>Herkunft</h2>
  {#if !anzeige}
    <p class="hinweis">Objekt nicht mehr vorhanden.</p>
  {:else if anzeige.reduziert}
    {#if anzeige.ersteller || anzeige.erstelltAm}
      <p class="meta">{anzeige.ersteller ?? 'unbekannt'} · {formatiertesDatum(anzeige.erstelltAm)}</p>
      <p class="meta">{anzeige.freigabeZeile}</p>
    {:else}
      <p class="hinweis">Ersteller/Zeitpunkt unbekannt (vor Provenienz-Einführung erstellt)</p>
    {/if}
  {:else if !anzeige.ersteller && !anzeige.erstelltAm}
    <p class="hinweis">Herkunft unbekannt (vor Provenienz-Einführung erstellt)</p>
  {:else}
    <p class="dokument">{anzeige.dokumentName}, Seite {anzeige.seite}</p>
    <p class="meta">{anzeige.ersteller} · {formatiertesDatum(anzeige.erstelltAm)}</p>
    <p class="meta">{anzeige.freigabeZeile}</p>
    {#if anzeige.geschwaerzt}
      <p class="auszug geschwaerzt">Der überdeckte Wortlaut wird aus Vertraulichkeitsgründen nicht angezeigt.</p>
    {:else if anzeige.textSnapshot}
      <p class="auszug">„{anzeige.textSnapshot}"</p>
    {:else}
      <p class="hinweis">Kein Textauszug gespeichert</p>
    {/if}
    {#if anzeige.fileSha256}
      <p class="fingerabdruck" title={anzeige.fileSha256}>SHA-256: {anzeige.fileSha256.slice(0, 8)}…</p>
    {:else}
      <p class="hinweis">Kein Fingerabdruck vorhanden (vor Einführung erstellt)</p>
    {/if}
  {/if}
  {#if referenzstatusText}
    <p class="referenzstatus">{referenzstatusText}</p>
  {/if}
  {#if anzeige?.fundstelle}
    <button class="primaer" onclick={() => void springen()}>Zur Originalstelle</button>
  {/if}
</div>

<style>
  .backdrop { position: fixed; inset: 0; z-index: 9600; }
  .pop { position: fixed; z-index: 9700; width: min(340px, 92vw); box-sizing: border-box;
         display: flex; flex-direction: column;
         background: var(--glass-elevated-bg); border: 1px solid var(--glass-border);
         backdrop-filter: var(--glass-blur-elevated); -webkit-backdrop-filter: var(--glass-blur-elevated);
         border-radius: 12px; box-shadow: var(--glass-shadow-lg); padding: 14px 16px 16px; color: var(--glass-text); }
  h2 { margin: 0 0 8px; font-size: 15px; font-weight: 600; line-height: 1.3; }
  p { margin: 0 0 4px; }
  .dokument { font-size: 13px; font-weight: 400; line-height: 1.5; }
  .meta { font-size: 12px; font-weight: 400; line-height: 1.4; color: var(--glass-text-secondary); }
  .auszug { font-size: 13px; font-style: italic; line-height: 1.5; overflow-wrap: break-word; }
  .auszug.geschwaerzt { font-style: normal; color: var(--glass-text-secondary); }
  .fingerabdruck { font-family: ui-monospace, 'SF Mono', 'Cascadia Code', monospace;
                    font-size: 12px; color: var(--glass-text-secondary); }
  .hinweis { font-size: 12px; line-height: 1.4; color: var(--glass-text-secondary); }
  .referenzstatus { font-size: 12.5px; line-height: 1.4; color: var(--glass-text-secondary); }
  .primaer { margin: 20px 0 0; padding: 9px 12px; border-radius: 8px; border: none;
             background: var(--brand-blue); color: #fff; cursor: pointer; font: inherit; font-size: 13px; }
  .primaer:hover { opacity: .9; }
</style>
