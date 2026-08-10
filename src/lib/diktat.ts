/**
 * Diktat-Zustandsautomat (VOICE-01, 14-09): Aufnahme mit anschließender Transkription über die
 * eigene, authentifizierte J-DESK-Server-Route (`packages/server/src/transkription.ts`) —
 * ersetzt die bisherige Live-Spracherkennung des Browsers (Web Speech API) vollständig.
 *
 * Warum ERSATZLOS entfernt statt bedingt beibehalten (Task 2, 14-09): nicht die
 * cloud-basierte Erkennung war das eigentliche Problem, sondern die Unmöglichkeit, dem
 * Versprechen des Browsers über eine geräteinterne Verarbeitungs-Präferenz zu trauen — die
 * Verfügbarkeit dieser Stufe war reine Feature-Detection ohne belastbare Zusicherung, WAS der
 * Browser tatsächlich lokal verarbeitet. Ein bedingter Zweig („nur behalten, wo geräteinterne
 * Verarbeitung nachweisbar verfügbar ist") hätte genau diese Vertrauensfrage offengehalten, die
 * die Nutzerentscheidung („Es soll nichts an Google gehen") schließen soll — und hätte zwei
 * völlig verschiedene Interaktionsmodelle (Strom vs. Stapel) in denselben Knopf gezwängt.
 * Durchgesetzt durch eine strukturelle Gegenprobe über `src/` und `packages/` (diktat.test.ts),
 * die rot wird, sobald ein Bezeichner der alten Erkennungs-API wieder einzieht.
 *
 * Bewusst DOM-frei und mit Funktions-Injektion (Muster wie zuvor, jetzt auf die Aufnahme- und
 * Hochlade-Funktion statt auf eine Erkennungs-Klasse angewendet): Vitest läuft mit
 * `environment: 'node'` — es gibt kein DOM, kein echtes Mikrofon und keinen echten Netzwerkpfad.
 * `aufnehmen` (Muster `src/lib/audioAufnahme.ts`, `starteAufnahme()`) und `hochladen` (Muster
 * `src/lib/api.ts`, `ApiClient.transkribiere()`) werden vom Aufrufer eingehängt — es gibt hier
 * bewusst KEINEN Standardwert mit einer Adresse darin, damit dieses Modul frei von jedem
 * Adress- und Pfadliteral bleibt (Quellenassertion in diktat.test.ts).
 *
 * Schranken:
 * - Der Anymize-Schlüssel und die Anymize-Job-Kennung berühren dieses Modul nie — beide leben
 *   ausschließlich serverseitig in `transkription.ts` (T-14-09-02/-03).
 * - Bereits im Feld stehender Text geht bei keinem Fehlerweg verloren: `onText` feuert
 *   ausschließlich bei erfolgreichem Durchlauf, der Aufrufer HÄNGT AN, ersetzt nie (bestehender
 *   Anhänge-Pfad der Komponenten, unverändert).
 * - Eine überlange Aufnahme geht nicht verloren: nach `maxSekunden` (Standard 300, fünf Minuten)
 *   beendet dieses Modul die Aufnahme selbsttätig und transkribiert das Aufgenommene trotzdem —
 *   die Nutzerin bekommt dafür `onHinweis()` statt `onAbbruch()` (kein Fehler).
 * - Wortlaut-Hoheit liegt beim Aufrufer: `onAbbruch` erhält nur die technische Ursache
 *   (Fehlermeldung), `onHinweis` gar keine (es gibt genau eine Ursache: Höchstdauer erreicht) —
 *   die fixierten Toast-Texte formuliert die jeweilige Komponente (14-UI-SPEC Copywriting
 *   Contract).
 */

export type DiktatZustand = 'idle' | 'aufnahme' | 'transkription';

/** Strukturelle Sicht auf eine laufende Aufnahme (Muster src/lib/audioAufnahme.ts:Aufnahme) —
 *  hier lokal gehalten statt importiert, damit dieses Modul weiterhin frei von jedem
 *  DOM-/Browser-Bezug bleibt (nur die Typform wird geteilt, nicht die Implementierung). */
interface AufnahmeQuelle {
  beenden(): Promise<{ bytes: Uint8Array; mime: string }>;
}

export interface DiktatOptionen {
  /** Feuert GENAU EINMAL je erfolgreichem Durchlauf — der Aufrufer hängt an sein Feld an. */
  onText: (text: string) => void;
  /** Jeder Fehlerweg (Mikrofon verweigert, Aufnahme fehlgeschlagen, Upload fehlgeschlagen,
   *  Transkription fehlgeschlagen, leeres Transkript) — erhält die technische Ursache. */
  onAbbruch: (meldung: string) => void;
  /** Selbsttätige Beendigung bei Höchstdauer — kein Fehler, deshalb ein eigener Rückruf ohne
   *  Argument (es gibt genau eine Ursache). */
  onHinweis: () => void;
  /** Jeder Zustandsübergang (`idle` → `aufnahme` → `transkription` → `idle`). */
  onZustand?: (zustand: DiktatZustand) => void;
  /** Laufzeit-Ticks in Sekunden, beginnend bei 0, nur während `aufnahme`. */
  onTick?: (sekunden: number) => void;
  /** Injizierte Aufnahme-Funktion (Tests, Produktion: audioAufnahme.ts:starteAufnahme). */
  aufnehmen: () => Promise<AufnahmeQuelle>;
  /** Injizierte Hochlade-/Transkriptions-Funktion (Tests, Produktion: api.ts:transkribiere). */
  hochladen: (bytes: Uint8Array, mime: string) => Promise<string>;
  /** Injizierbarer Sekunden-Timer (Tests); Standard: setInterval/clearInterval. Rückgabe = Abbruchfunktion. */
  intervall?: (ms: number, fn: () => void) => () => void;
  /** Höchstdauer in Sekunden — Standard 300 (fünf Minuten): begrenzt durch die Größenkappe der
   *  Server-Route und deren Wartefrist gegenüber der Gegenstelle; bei Erreichen wird trotzdem
   *  transkribiert statt verworfen (nichts vom Gesprochenen geht verloren). */
  maxSekunden?: number;
}

export interface Diktat {
  start(): void;
  stop(): void;
  zustand(): DiktatZustand;
}

/** Formt eine Fehlermeldung aus einem geworfenen Wert — deckt sowohl `Error`-Instanzen (u. a.
 *  `TranskriptionError`, die Fehlerklasse der Server-Route) als auch `DOMException` ab (Browser:
 *  `getUserMedia()` lehnt damit ab; DOMException trägt `.message`, auch wenn sie in manchen
 *  Engines nicht `instanceof Error` ist). Der Wortlaut selbst bleibt komplett beim Aufrufer
 *  (Wortlaut-Hoheit-Prinzip dieses Moduls) — hier wird nur die technische Ursache extrahiert. */
function fehlermeldung(e: unknown, fallback: string): string {
  if (e instanceof Error && e.message) return e.message;
  if (e && typeof e === 'object' && 'message' in e && typeof e.message === 'string' && e.message) return e.message;
  return fallback;
}

/** Erzeugt den Zustandsautomaten. Jeder start() beginnt eine FRISCHE Generation — so bleiben
 *  veraltete Abschlüsse einer vorherigen Aufnahme (z. B. eine spät auflösende Mikrofon-Promise
 *  nach zwischenzeitlichem erneuten Start) strukturell wirkungslos. */
export function erzeugeDiktat(opts: DiktatOptionen): Diktat {
  const maxSekunden = opts.maxSekunden ?? 300;
  const intervall = opts.intervall ?? ((ms: number, fn: () => void): (() => void) => {
    const t = setInterval(fn, ms);
    return (): void => clearInterval(t);
  });

  let zustandIntern: DiktatZustand = 'idle';
  let generation = 0;
  let timerAbbrechen: (() => void) | null = null;
  let aufnahmePromise: Promise<AufnahmeQuelle> | null = null;

  function setZustand(z: DiktatZustand): void {
    zustandIntern = z;
    opts.onZustand?.(z);
  }

  function stopTimer(): void {
    if (timerAbbrechen) {
      timerAbbrechen();
      timerAbbrechen = null;
    }
  }

  /** Job-Rückmeldung verarbeiten: hochladen → Text (oder Fehlschlag/leeres Transkript als
   *  Abbruch). `hinweis`, wenn dieser Durchlauf durch die Höchstdauer ausgelöst wurde. */
  async function verarbeiteAufnahme(bytes: Uint8Array, mime: string, gen: number, hinweis: boolean): Promise<void> {
    setZustand('transkription');
    let text: string;
    try {
      text = await opts.hochladen(bytes, mime);
    } catch (e) {
      if (gen !== generation) return; // zwischenzeitlich neu gestartet — diese Antwort ist veraltet
      setZustand('idle');
      opts.onAbbruch(fehlermeldung(e, 'Transkription fehlgeschlagen'));
      return;
    }
    if (gen !== generation) return;
    if (text.trim() === '') {
      // T-14-09-06: fehlender/leerer Text ist ein Fehlschlag, kein leeres Diktat — sonst sähe
      // ein stiller Fehlweg wie ein leergesprochenes Diktat aus.
      setZustand('idle');
      opts.onAbbruch('Transkription lieferte keinen Text.');
      return;
    }
    setZustand('idle');
    if (hinweis) opts.onHinweis();
    opts.onText(text);
  }

  /** Gemeinsamer Pfad für stop() (Nutzer-Beendigung) und das selbsttätige Ende bei
   *  Höchstdauer — No-Op außerhalb des Zustands 'aufnahme' (insbesondere während
   *  'transkription': eine bereits übertragene Aufnahme lässt sich nicht zurückholen). */
  function beendenUndVerarbeiten(gen: number, hinweis: boolean): void {
    if (gen !== generation || zustandIntern !== 'aufnahme') return;
    stopTimer();
    const p = aufnahmePromise;
    if (!p) return;
    aufnahmePromise = null;
    void (async () => {
      let quelle: AufnahmeQuelle;
      try {
        quelle = await p;
      } catch {
        return; // bereits als Mikrofon-Abbruch behandelt (siehe start()-Fehlerpfad unten)
      }
      if (gen !== generation) return;
      try {
        const { bytes, mime } = await quelle.beenden();
        if (gen !== generation) return;
        await verarbeiteAufnahme(bytes, mime, gen, hinweis);
      } catch (e) {
        if (gen !== generation) return;
        setZustand('idle');
        opts.onAbbruch(fehlermeldung(e, 'Aufnahme fehlgeschlagen'));
      }
    })();
  }

  return {
    start(): void {
      if (zustandIntern !== 'idle') return; // Doppelstart-Bremse (auch während 'transkription')
      generation += 1;
      const gen = generation;
      setZustand('aufnahme');
      let sekunden = 0;
      opts.onTick?.(0);
      timerAbbrechen = intervall(1000, () => {
        if (gen !== generation) return;
        sekunden += 1;
        opts.onTick?.(sekunden);
        if (sekunden >= maxSekunden) beendenUndVerarbeiten(gen, true);
      });
      aufnahmePromise = opts.aufnehmen();
      aufnahmePromise.catch((e: unknown) => {
        if (gen !== generation) return;
        stopTimer();
        aufnahmePromise = null;
        setZustand('idle');
        opts.onAbbruch(fehlermeldung(e, 'Mikrofon nicht verfügbar'));
      });
    },
    stop(): void {
      beendenUndVerarbeiten(generation, false);
    },
    zustand(): DiktatZustand {
      return zustandIntern;
    },
  };
}

// Task 1 hielt hier vorübergehend eine No-Op-Kompatibilitätsschicht für LegalObjectCard.svelte
// und SitzungsmodusShell.svelte, die bis Task 2 noch die alte, Web-Speech-API-Ära-Form dieses
// Moduls aufriefen. Beide Komponenten sind jetzt (Task 2) auf die neue Verdrahtung umgestellt
// — die Übergangsschicht ist ersatzlos entfernt.
