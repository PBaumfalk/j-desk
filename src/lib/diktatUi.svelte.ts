import { onDestroy, onMount } from 'svelte';
import { erzeugeDiktat, type Diktat, type DiktatZustand } from './diktat';
import { starteAufnahme } from './audioAufnahme';
import { showToast } from './ui.svelte';
import { desktop } from './store.svelte';

/**
 * Gemeinsame UI-Verdrahtung des Diktat-Zustandsautomaten (VOICE-01, 14-09) für jede Karte/jedes
 * Panel mit einem 🎤-Knopf (NoteCard, LegalObjectCard, SitzungsmodusShell) — WR-02 (14-REVIEW.md):
 * die drei Aufrufer hatten die komplette Verdrahtung (Verfügbarkeitsprüfung, Zustand,
 * erzeugeDiktat()-Aufruf, Start/Stopp, Aufräumen) wortgleich kopiert und waren bereits
 * auseinandergedriftet — SitzungsmodusShell.svelte rief `diktat.stop()` nicht in `onDestroy` auf
 * (ein offen bleibendes Mikrofon wäre denkbar, s. Befund). Dieses Modul registriert das
 * Aufräumen HIER, ein für alle Mal, statt es jedem Aufrufer zu überlassen, es nicht zu vergessen.
 *
 * Muss aus dem <script>-Wurzelbereich einer Komponente aufgerufen werden (ruft `onMount`/
 * `onDestroy` intern auf — dieselbe Regel wie bei jeder anderen Svelte-5-Runen-Komposition).
 *
 * Wortlaut der beiden Toasts (Abbruch/Höchstdauer-Hinweis) ist der EINZIGE Teil, der über die
 * drei bisherigen Kopien hinweg bereits identisch war (14-UI-SPEC Copywriting Contract erzwingt
 * denselben Text überall) — er lebt deshalb bewusst hier und nicht mehr je Aufrufer. Die
 * Wortlaut-Hoheit-Regel aus `diktat.ts` (dort bewusst DOM-/Wortlaut-frei) bleibt unberührt: dieses
 * Modul ist die UI-Schicht EINE Ebene darüber, nicht der Zustandsautomat selbst.
 */
export interface DiktatUiOptionen {
  /** Hängt transkribierten Text ans Zielfeld an — je Aufrufer verschieden (DOM-Textarea bei
   *  NoteCard/LegalObjectCard, reaktive Variable bei SitzungsmodusShell), deshalb injiziert. */
  anhaengen: (text: string) => void;
}

export interface DiktatUi {
  readonly verfuegbar: boolean;
  readonly zustand: DiktatZustand;
  readonly sekunden: number;
  /** Laufzeit in m:ss (aktiver Zustand „Aufnahme läuft · {m:ss}" — Doppelkodierung Text+Stil). */
  laufzeit(): string;
  startenStoppen(): void;
  /** No-Op außerhalb 'aufnahme' (u. a. während 'transkription', s. diktat.ts) — Aufrufer dürfen
   *  dies jederzeit gefahrlos aufrufen (Bearbeiten-Modus verlassen, Panel schließen, …). */
  beenden(): void;
}

export function erzeugeDiktatUi(opts: DiktatUiOptionen): DiktatUi {
  const zustand = $state<{ verfuegbar: boolean; wert: DiktatZustand; sekunden: number }>({
    verfuegbar: false, wert: 'idle', sekunden: 0,
  });

  onMount(() => {
    void desktop.api?.transkriptionVerfuegbar().then((v) => { zustand.verfuegbar = v; });
  });

  // Eine einzige Instanz für die Lebenszeit des Aufrufers — erzeugeDiktat() beginnt bei jedem
  // start() intern eine frische Generation, ein Wegwerfen/Neuerzeugen je Sitzung ist nicht nötig.
  const diktat: Diktat = erzeugeDiktat({
    onText: opts.anhaengen,
    onZustand: (z) => { zustand.wert = z; },
    onTick: (s) => { zustand.sekunden = s; },
    onAbbruch: (meldung) => {
      showToast(`Diktat abgebrochen. ${meldung} — Ihr bereits eingegebener Text bleibt unverändert.`);
    },
    onHinweis: () => {
      showToast('Aufnahme nach 5:00 automatisch beendet — der aufgenommene Teil wird transkribiert.');
    },
    aufnehmen: starteAufnahme,
    hochladen: (bytes, mime) => desktop.api!.transkribiere(bytes, mime),
  });

  function beenden(): void {
    diktat.stop();
  }

  // Der eigentliche WR-02-Fix: läuft für ALLE drei Aufrufer automatisch mit, statt komponenten-
  // lokal wiederholt (und ggf. vergessen) zu werden.
  onDestroy(beenden);

  return {
    get verfuegbar() { return zustand.verfuegbar; },
    get zustand() { return zustand.wert; },
    get sekunden() { return zustand.sekunden; },
    laufzeit(): string {
      const s = zustand.sekunden;
      return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    },
    startenStoppen(): void {
      if (zustand.wert === 'idle') {
        zustand.sekunden = 0;
        diktat.start();
      } else {
        beenden();
      }
    },
    beenden,
  };
}
