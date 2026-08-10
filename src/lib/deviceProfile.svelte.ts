/**
 * Reaktive Hülle um die reine Geräteprofil-Logik aus deviceProfile.ts (MOBILE-01/02, 11-09
 * Task 3) — die geprüfte Kernlogik bleibt unangetastet; hier kommt nur die Framework-Anbindung
 * dazu: zwei `MediaQuery`-Instanzen aus `svelte/reactivity` statt eigener Zuhörerverwaltung
 * (11-RESEARCH.md Pattern 3), synchroner Anfangswert gegen einen sichtbaren Oberflächenwechsel
 * beim ersten Aufbau (E5/loading) und das Einfrieren des wirksamen Profils während einer
 * laufenden Sitzung (MOBILE-01/concurrency).
 *
 * Unter Vitest (`environment: 'node'`, 11-RESEARCH.md Pitfall 4) und beim serverseitigen
 * Rendern fehlen `window`/`matchMedia` vollständig — die Medienabfragen werden deshalb NUR
 * erzeugt, wenn eine Fensterumgebung mit Medienabfrage vorhanden ist; sonst bleibt es beim
 * festen Desktop-Profil (fail-open zur bisherigen, getesteten Oberfläche, E5/error).
 */
import { MediaQuery } from 'svelte/reactivity';
import {
  aktivesProfil, erkanntesProfilAusUmgebung, leseProfilAuswahl, schreibeProfilAuswahl,
  BREAKPOINT_SMARTPHONE,
  type DeviceProfile, type ProfilAuswahl,
} from './deviceProfile';
import { ui } from './ui.svelte';

const HAT_UMGEBUNG = typeof window !== 'undefined' && typeof window.matchMedia === 'function';

/** Gespeicherte Übersteuerung ('auto' = Erkennung entscheidet). */
let auswahl = $state<ProfilAuswahl>(leseProfilAuswahl());

/** Erkanntes Profil. Der Anfangswert wird synchron über `erkanntesProfilAusUmgebung()`
 *  bestimmt — der erste Aufbau der Seite rendert sofort die passende Oberfläche, ohne dass
 *  zwischendurch die andere aufblitzt (E5/loading, backstop). */
let erkannt = $state<DeviceProfile>(HAT_UMGEBUNG ? erkanntesProfilAusUmgebung() : 'desktop');

if (HAT_UMGEBUNG) {
  // Kürzere Kante unter der Schwelle als Oder-Verknüpfung beider Dimensionen (min(w,h) < N
  // ⟺ (w<N) ∨ (h<N) — 11-RESEARCH.md Pattern 3); Schwelle = BREAKPOINT_SMARTPHONE − 1, weil
  // die Abfragesyntax „max-width" inklusiv ist, die Schwelle selbst aber exklusiv wirkt.
  const kurzeKante = new MediaQuery(
    `(max-width: ${BREAKPOINT_SMARTPHONE - 1}px), (max-height: ${BREAKPOINT_SMARTPHONE - 1}px)`,
    false,
  );
  const groberZeiger = new MediaQuery('(pointer: coarse)', false);
  $effect.root(() => {
    $effect(() => {
      // Rohe Erkennung OHNE Übersteuerung — die wirkt separat über `auswahl`, damit die
      // Auswahlzeile „Automatisch (erkannt: …)" das tatsächlich erkannte Profil nennt.
      erkannt = kurzeKante.current ? 'smartphone' : groberZeiger.current ? 'ipad' : 'desktop';
    });
  });
}

/** Wirksames Profil vor dem Sitzungs-Einfrieren: gespeicherte Übersteuerung gewinnt. */
const wirksamOhneFreeze = $derived<DeviceProfile>(auswahl === 'auto' ? erkannt : auswahl);

/** MOBILE-01/concurrency: solange eine Sitzung läuft, bleibt das gerenderte Profil auf dem
 *  beim Sitzungsstart aktiven Profil eingefroren — eine Drehung oder Größenänderung im Termin
 *  zieht die Oberfläche nicht unter der laufenden Sitzung weg. */
let eingefroren = $state<DeviceProfile | null>(null);
$effect.root(() => {
  let warSitzungAktiv = false;
  $effect(() => {
    if (ui.sitzungsmodusAktiv) {
      if (!warSitzungAktiv) eingefroren = wirksamOhneFreeze;
      warSitzungAktiv = true;
    } else {
      warSitzungAktiv = false;
      eingefroren = null;
    }
  });
});
const wirksam = $derived(aktivesProfil(wirksamOhneFreeze, eingefroren));

/** Die drei Zugriffe der Hülle: erkanntes Profil, gespeicherte Auswahl, wirksames Profil. */
export const geraeteProfil = {
  get erkannt(): DeviceProfile {
    return erkannt;
  },
  get auswahl(): ProfilAuswahl {
    return auswahl;
  },
  get wirksam(): DeviceProfile {
    return wirksam;
  },
};

/** Setzt die Übersteuerung: persistiert über `schreibeProfilAuswahl` und aktualisiert den
 *  reaktiven Zustand — die Rendering-Weiche schaltet sofort um, ohne Neuladen. */
export function setzeProfilAuswahl(wert: ProfilAuswahl): void {
  schreibeProfilAuswahl(wert);
  auswahl = wert;
}
