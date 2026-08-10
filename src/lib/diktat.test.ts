import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { erzeugeDiktat, type Diktat, type DiktatZustand } from './diktat';

/**
 * Tests für diktat.ts (VOICE-01, 14-09): DOM-frei per Funktions-Injektion — `aufnehmen` und
 * `hochladen` werden gemockt (Vitest läuft mit environment 'node', es gibt weder DOM noch ein
 * echtes Mikrofon oder Netzwerk). `vi.waitFor` flusht die internen Promise-Ketten des
 * Zustandsautomaten deterministisch, ohne die genaue Anzahl Microtask-Hops kennen zu müssen.
 * Alle `vi.fn()`-Aufrufe tragen einen expliziten Funktionstyp (Vitest 4: ein untypisiertes
 * `vi.fn()` ergibt `Mock<Procedure | Constructable>`, das sich nicht gegen die konkreten
 * `DiktatOptionen`-Feldsignaturen zuweisen lässt).
 */

interface AufnahmeMock {
  beenden: ReturnType<typeof vi.fn<() => Promise<{ bytes: Uint8Array; mime: string }>>>;
}

function mockAufnahme(bytes = new Uint8Array([1, 2, 3]), mime = 'audio/webm'): AufnahmeMock {
  return { beenden: vi.fn<() => Promise<{ bytes: Uint8Array; mime: string }>>(async () => ({ bytes, mime })) };
}

function mockAufnehmen(aufnahme: AufnahmeMock = mockAufnahme()): ReturnType<typeof vi.fn<() => Promise<AufnahmeMock>>> {
  return vi.fn<() => Promise<AufnahmeMock>>(async () => aufnahme);
}

function mockAufnehmenFehler(fehler: unknown): ReturnType<typeof vi.fn<() => Promise<AufnahmeMock>>> {
  return vi.fn<() => Promise<AufnahmeMock>>(async () => { throw fehler; });
}

function mockHochladen(text: string): ReturnType<typeof vi.fn<(bytes: Uint8Array, mime: string) => Promise<string>>> {
  return vi.fn<(bytes: Uint8Array, mime: string) => Promise<string>>(async () => text);
}

function mockHochladenFehler(fehler: unknown): ReturnType<typeof vi.fn<(bytes: Uint8Array, mime: string) => Promise<string>>> {
  return vi.fn<(bytes: Uint8Array, mime: string) => Promise<string>>(async () => { throw fehler; });
}

/** Injizierbarer Timer: `tick()` löst alle laufenden Intervalle manuell aus (Muster aus dem
 *  Vorgänger-Test, unverändert wiederverwendbar für den neuen Sekundentakt). */
function manuellerTimer(): {
  intervall: (ms: number, fn: () => void) => () => void;
  tick: (n?: number) => void;
} {
  const laufend: Array<() => void> = [];
  return {
    intervall: (_ms: number, fn: () => void): (() => void) => {
      laufend.push(fn);
      return (): void => {
        const i = laufend.indexOf(fn);
        if (i >= 0) laufend.splice(i, 1);
      };
    },
    tick: (n = 1): void => {
      for (let k = 0; k < n; k += 1) [...laufend].forEach((f) => f());
    },
  };
}

interface Rueckrufe {
  onText: ReturnType<typeof vi.fn<(text: string) => void>>;
  onAbbruch: ReturnType<typeof vi.fn<(meldung: string) => void>>;
  onHinweis: ReturnType<typeof vi.fn<() => void>>;
  onZustand: ReturnType<typeof vi.fn<(zustand: DiktatZustand) => void>>;
  onTick: ReturnType<typeof vi.fn<(sekunden: number) => void>>;
}

function rueckrufe(): Rueckrufe {
  return {
    onText: vi.fn<(text: string) => void>(),
    onAbbruch: vi.fn<(meldung: string) => void>(),
    onHinweis: vi.fn<() => void>(),
    onZustand: vi.fn<(zustand: DiktatZustand) => void>(),
    onTick: vi.fn<(sekunden: number) => void>(),
  };
}

function zustandsfolge(r: Rueckrufe): DiktatZustand[] {
  return r.onZustand.mock.calls.map((c) => c[0]);
}

const KEIN_UPLOAD = mockHochladen('nicht erwartet');

describe('erzeugeDiktat — start()', () => {
  it("meldet die Zustandsfolge 'aufnahme' und tickt sofort bei 0", async () => {
    const r = rueckrufe();
    const aufnehmen = mockAufnehmen();
    const diktat = erzeugeDiktat({ ...r, aufnehmen, hochladen: KEIN_UPLOAD });
    expect(diktat.zustand()).toBe('idle');
    diktat.start();
    expect(diktat.zustand()).toBe('aufnahme');
    expect(zustandsfolge(r)).toEqual(['aufnahme']);
    expect(r.onTick).toHaveBeenNthCalledWith(1, 0);
    await vi.waitFor(() => expect(aufnehmen).toHaveBeenCalledTimes(1));
  });

  it("zählt Sekunden über den injizierten Takt, beginnend bei 0", () => {
    const r = rueckrufe();
    const timer = manuellerTimer();
    const diktat = erzeugeDiktat({ ...r, aufnehmen: mockAufnehmen(), hochladen: KEIN_UPLOAD, intervall: timer.intervall });
    diktat.start();
    timer.tick(3);
    expect(r.onTick).toHaveBeenNthCalledWith(1, 0);
    expect(r.onTick).toHaveBeenNthCalledWith(2, 1);
    expect(r.onTick).toHaveBeenNthCalledWith(4, 3);
  });

  it("bremst den Doppelstart: start() im Zustand 'aufnahme' ist ein No-Op", () => {
    const r = rueckrufe();
    const aufnehmen = mockAufnehmen();
    const diktat = erzeugeDiktat({ ...r, aufnehmen, hochladen: KEIN_UPLOAD });
    diktat.start();
    diktat.start();
    expect(aufnehmen).toHaveBeenCalledTimes(1);
    expect(zustandsfolge(r)).toEqual(['aufnahme']);
  });
});

describe('erzeugeDiktat — Beenden durch die Nutzerin (Erfolgsweg)', () => {
  it("Zustandsfolge 'aufnahme' → 'transkription' → 'idle'; Text genau einmal über onText", async () => {
    const r = rueckrufe();
    const aufnahme = mockAufnahme();
    const aufnehmen = mockAufnehmen(aufnahme);
    const hochladen = mockHochladen('Diktierter Text.');
    const diktat = erzeugeDiktat({ ...r, aufnehmen, hochladen });
    diktat.start();
    await vi.waitFor(() => expect(aufnehmen).toHaveBeenCalledTimes(1));
    diktat.stop();
    await vi.waitFor(() => expect(r.onText).toHaveBeenCalledTimes(1));
    expect(r.onText).toHaveBeenCalledWith('Diktierter Text.');
    expect(aufnahme.beenden).toHaveBeenCalledTimes(1);
    expect(hochladen).toHaveBeenCalledTimes(1);
    expect(zustandsfolge(r)).toEqual(['aufnahme', 'transkription', 'idle']);
    expect(diktat.zustand()).toBe('idle');
    expect(r.onAbbruch).not.toHaveBeenCalled();
    expect(r.onHinweis).not.toHaveBeenCalled();
  });

  it('der Laufzeittakt endet mit der Aufnahme (keine weiteren Ticks nach stop())', async () => {
    const r = rueckrufe();
    const timer = manuellerTimer();
    const aufnehmen = mockAufnehmen();
    const hochladen = mockHochladen('x');
    const diktat = erzeugeDiktat({ ...r, aufnehmen, hochladen, intervall: timer.intervall });
    diktat.start();
    timer.tick(2);
    await vi.waitFor(() => expect(aufnehmen).toHaveBeenCalledTimes(1));
    diktat.stop();
    await vi.waitFor(() => expect(r.onText).toHaveBeenCalledTimes(1));
    const anzahlTicksVorher = r.onTick.mock.calls.length;
    timer.tick(5); // Timer wurde beim Beenden abgebrochen — kein Effekt mehr
    expect(r.onTick.mock.calls.length).toBe(anzahlTicksVorher);
  });
});

describe('erzeugeDiktat — Höchstdauer', () => {
  it('beendet die Aufnahme selbsttätig, transkribiert trotzdem, meldet onHinweis statt onAbbruch', async () => {
    const r = rueckrufe();
    const timer = manuellerTimer();
    const aufnahme = mockAufnahme();
    const aufnehmen = mockAufnehmen(aufnahme);
    const hochladen = mockHochladen('Bis hierhin Gesagtes.');
    const diktat = erzeugeDiktat({ ...r, aufnehmen, hochladen, intervall: timer.intervall, maxSekunden: 2 });
    diktat.start();
    await vi.waitFor(() => expect(aufnehmen).toHaveBeenCalledTimes(1));
    timer.tick(2); // sekunden=1, dann sekunden=2 → Höchstdauer erreicht
    await vi.waitFor(() => expect(r.onText).toHaveBeenCalledTimes(1));
    expect(r.onText).toHaveBeenCalledWith('Bis hierhin Gesagtes.');
    expect(r.onHinweis).toHaveBeenCalledTimes(1);
    expect(r.onAbbruch).not.toHaveBeenCalled();
    expect(aufnahme.beenden).toHaveBeenCalledTimes(1);
  });
});

describe('erzeugeDiktat — Fehlerwege (Texterhalt: onText wird NIE gerufen)', () => {
  it('verweigertes Mikrofon → onAbbruch, kein onText', async () => {
    const r = rueckrufe();
    const aufnehmen = mockAufnehmenFehler(new Error('NotAllowedError'));
    const diktat = erzeugeDiktat({ ...r, aufnehmen, hochladen: KEIN_UPLOAD });
    diktat.start();
    await vi.waitFor(() => expect(r.onAbbruch).toHaveBeenCalledTimes(1));
    expect(r.onAbbruch).toHaveBeenCalledWith('NotAllowedError');
    expect(r.onText).not.toHaveBeenCalled();
    expect(diktat.zustand()).toBe('idle');
    expect(zustandsfolge(r)).toEqual(['aufnahme', 'idle']);
  });

  it('fehlgeschlagener Upload/Transkription → onAbbruch, kein onText', async () => {
    const r = rueckrufe();
    const aufnehmen = mockAufnehmen();
    const hochladen = mockHochladenFehler(new Error('Transkription nicht erreichbar (HTTP 502)'));
    const diktat = erzeugeDiktat({ ...r, aufnehmen, hochladen });
    diktat.start();
    await vi.waitFor(() => expect(aufnehmen).toHaveBeenCalledTimes(1));
    diktat.stop();
    await vi.waitFor(() => expect(r.onAbbruch).toHaveBeenCalledTimes(1));
    expect(r.onAbbruch).toHaveBeenCalledWith('Transkription nicht erreichbar (HTTP 502)');
    expect(r.onText).not.toHaveBeenCalled();
  });

  it('leeres Transkript → onAbbruch, kein onText (kein leeres Diktat)', async () => {
    const r = rueckrufe();
    const aufnehmen = mockAufnehmen();
    const hochladen = mockHochladen('   ');
    const diktat = erzeugeDiktat({ ...r, aufnehmen, hochladen });
    diktat.start();
    await vi.waitFor(() => expect(aufnehmen).toHaveBeenCalledTimes(1));
    diktat.stop();
    await vi.waitFor(() => expect(r.onAbbruch).toHaveBeenCalledTimes(1));
    expect(r.onText).not.toHaveBeenCalled();
  });

  it('fehlgeschlagenes Beenden der Aufnahme selbst → onAbbruch, kein onText', async () => {
    const r = rueckrufe();
    const aufnahme: AufnahmeMock = {
      beenden: vi.fn<() => Promise<{ bytes: Uint8Array; mime: string }>>(async () => { throw new Error('Aufnahme fehlgeschlagen'); }),
    };
    const aufnehmen = mockAufnehmen(aufnahme);
    const diktat = erzeugeDiktat({ ...r, aufnehmen, hochladen: KEIN_UPLOAD });
    diktat.start();
    await vi.waitFor(() => expect(aufnehmen).toHaveBeenCalledTimes(1));
    diktat.stop();
    await vi.waitFor(() => expect(r.onAbbruch).toHaveBeenCalledTimes(1));
    expect(r.onText).not.toHaveBeenCalled();
  });
});

describe('erzeugeDiktat — stop()', () => {
  it("ist im Zustand 'idle' ein No-Op", () => {
    const r = rueckrufe();
    const aufnehmen = mockAufnehmen();
    const diktat = erzeugeDiktat({ ...r, aufnehmen, hochladen: KEIN_UPLOAD });
    diktat.stop();
    expect(aufnehmen).not.toHaveBeenCalled();
    expect(diktat.zustand()).toBe('idle');
  });

  it("ist im Zustand 'transkription' ebenfalls ein No-Op (bereits übertragene Aufnahme lässt sich nicht zurückholen)", async () => {
    const r = rueckrufe();
    const aufnahme = mockAufnahme();
    const aufnehmen = mockAufnehmen(aufnahme);
    let loeseHochladenAuf!: (t: string) => void;
    const hochladen = vi.fn<(bytes: Uint8Array, mime: string) => Promise<string>>(
      () => new Promise<string>((resolve) => { loeseHochladenAuf = resolve; }),
    );
    const diktat = erzeugeDiktat({ ...r, aufnehmen, hochladen });
    diktat.start();
    await vi.waitFor(() => expect(aufnehmen).toHaveBeenCalledTimes(1));
    diktat.stop();
    await vi.waitFor(() => expect(diktat.zustand()).toBe('transkription'));
    diktat.stop(); // No-Op — beenden() darf NICHT ein zweites Mal aufgerufen werden
    expect(aufnahme.beenden).toHaveBeenCalledTimes(1);
    loeseHochladenAuf('Text nach Freigabe.');
    await vi.waitFor(() => expect(r.onText).toHaveBeenCalledTimes(1));
    expect(r.onText).toHaveBeenCalledTimes(1);
  });

  it('beginnt nach einem abgeschlossenen Durchlauf sauber neu (frische Generation)', async () => {
    const r = rueckrufe();
    const ersteAufnahme = mockAufnahme();
    const zweiteAufnahme = mockAufnahme();
    const aufnehmen = vi.fn<() => Promise<AufnahmeMock>>()
      .mockImplementationOnce(async () => ersteAufnahme)
      .mockImplementationOnce(async () => zweiteAufnahme);
    const hochladen = mockHochladen('Text.');
    const diktat = erzeugeDiktat({ ...r, aufnehmen, hochladen });
    diktat.start();
    await vi.waitFor(() => expect(aufnehmen).toHaveBeenCalledTimes(1));
    diktat.stop();
    await vi.waitFor(() => expect(r.onText).toHaveBeenCalledTimes(1));
    expect(diktat.zustand()).toBe('idle');
    diktat.start();
    expect(diktat.zustand()).toBe('aufnahme');
    await vi.waitFor(() => expect(aufnehmen).toHaveBeenCalledTimes(2));
    diktat.stop();
    await vi.waitFor(() => expect(r.onText).toHaveBeenCalledTimes(2));
  });
});

describe('Netzwerkfreiheit und Quellenassertionen (VOICE-01/edge — diktat.ts bleibt DOM-/Adressfrei)', () => {
  const quelle = readFileSync(new URL('./diktat.ts', import.meta.url), 'utf8');

  it('das Modul enthält keine Adresse mit Protokollpräfix und kein /api/-Pfadliteral', () => {
    expect(quelle.match(/https?:\/\//g)).toBeNull();
    expect(quelle.match(/\/api\//g)).toBeNull();
  });

  it('das Modul enthält keinen Bezeichner der Browser-Spracherkennung (keine der beiden Namensvarianten)', () => {
    expect(quelle).not.toContain('SpeechRecognition');
    expect(quelle).not.toContain('webkitSpeechRecognition');
  });

  it('das Modul legt nichts im Browserspeicher ab', () => {
    expect(quelle).not.toContain('localStorage');
  });
});

/**
 * Strukturelle Gegenprobe (Task 2, T-14-09-07): in `src/` und `packages/` (ohne node_modules/
 * Build-Ausgaben) darf kein Bezeichner der Browser-Spracherkennung mehr vorkommen — dieser Test
 * ist die Durchsetzung der Nutzerentscheidung („Es soll nichts an Google gehen"), er wird ROT,
 * sobald der Pfad wieder einzieht. Der gesuchte Bezeichner wird aus Zeichenteilen zusammen-
 * gesetzt, damit dieser Test sich nicht selbst trifft (dieser Kommentar nennt ihn zwangsläufig).
 */
describe('Strukturelle Gegenprobe: keine Browser-Spracherkennung mehr im Quellbaum', () => {
  const PROJEKTWURZEL = fileURLToPath(new URL('../../', import.meta.url));
  const AUSGESCHLOSSEN = new Set(['node_modules', 'build', '.svelte-kit', 'dist', '.git']);
  const ERKENNUNGS_BEZEICHNER = ['Speech' + 'Recognition', 'webkit' + 'Speech' + 'Recognition'];

  function* dateien(verzeichnis: string): Generator<string> {
    for (const eintrag of readdirSync(verzeichnis)) {
      if (AUSGESCHLOSSEN.has(eintrag)) continue;
      const pfad = join(verzeichnis, eintrag);
      const info = statSync(pfad);
      if (info.isDirectory()) {
        yield* dateien(pfad);
      } else if (/\.(ts|svelte)$/.test(eintrag) && !eintrag.endsWith('.test.ts')) {
        yield pfad;
      }
    }
  }

  it('src/ und packages/ enthalten keinen Bezeichner der Browser-Spracherkennung', () => {
    const treffer: string[] = [];
    for (const wurzel of ['src', 'packages']) {
      for (const datei of dateien(join(PROJEKTWURZEL, wurzel))) {
        const inhalt = readFileSync(datei, 'utf8');
        for (const bezeichner of ERKENNUNGS_BEZEICHNER) {
          if (inhalt.includes(bezeichner)) treffer.push(`${datei}: ${bezeichner}`);
        }
      }
    }
    expect(treffer).toEqual([]);
  });
});
