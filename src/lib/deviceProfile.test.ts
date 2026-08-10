import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  aktivesProfil, BREAKPOINT_SMARTPHONE, DEVICE_PROFILE_KEY, erkanntesProfilAusUmgebung,
  leseProfilAuswahl, PROFIL_AUSWAHLEN, profilLabel, profilMenuZeilen, resolveDeviceProfile,
  schreibeProfilAuswahl,
} from './deviceProfile';

describe('resolveDeviceProfile', () => {
  it('erkennt Desktop bei großer Fläche und feinem Zeiger', () => {
    expect(resolveDeviceProfile(1440, 900, false)).toBe('desktop');
  });

  it('erkennt iPad bei großer Fläche und grobem Zeiger', () => {
    expect(resolveDeviceProfile(1024, 768, true)).toBe('ipad');
  });

  it('erkennt Smartphone bei kleiner Fläche', () => {
    expect(resolveDeviceProfile(390, 844, true)).toBe('smartphone');
  });

  describe('Grenzfälle auf der kürzeren Kante (orientierungsunabhängig, Math.min(w,h))', () => {
    it('599 ist Smartphone, unabhängig vom Zeigertyp und davon, welche Kante die kürzere ist', () => {
      expect(resolveDeviceProfile(1200, 599, true)).toBe('smartphone');
      expect(resolveDeviceProfile(599, 1200, false)).toBe('smartphone');
    });

    it('600 entscheidet über den Zeigertyp', () => {
      expect(resolveDeviceProfile(1200, 600, true)).toBe('ipad');
      expect(resolveDeviceProfile(1200, 600, false)).toBe('desktop');
    });

    it('601 entscheidet weiterhin über den Zeigertyp', () => {
      expect(resolveDeviceProfile(1200, 601, true)).toBe('ipad');
      expect(resolveDeviceProfile(1200, 601, false)).toBe('desktop');
    });
  });

  it('BREAKPOINT_SMARTPHONE ist der einzige numerische Schwellwert (600)', () => {
    expect(BREAKPOINT_SMARTPHONE).toBe(600);
  });

  it('eine Übersteuerung schlägt jede Messung', () => {
    expect(resolveDeviceProfile(1440, 900, false, 'smartphone')).toBe('smartphone');
    expect(resolveDeviceProfile(390, 844, true, 'desktop')).toBe('desktop');
  });

  it("die Übersteuerung 'auto' verhält sich exakt wie ein fehlendes Argument", () => {
    expect(resolveDeviceProfile(390, 844, true, 'auto')).toBe(resolveDeviceProfile(390, 844, true));
    expect(resolveDeviceProfile(1440, 900, false, 'auto')).toBe(resolveDeviceProfile(1440, 900, false));
  });

  it('ist eine reine Funktion: zweimaliger Aufruf mit denselben Argumenten liefert denselben Wert', () => {
    const a = resolveDeviceProfile(1024, 768, true);
    const b = resolveDeviceProfile(1024, 768, true);
    expect(a).toBe(b);
  });
});

describe('leseProfilAuswahl / schreibeProfilAuswahl (localStorage-Übersteuerung)', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("liefert 'auto' ohne gespeicherten Wert", () => {
    expect(leseProfilAuswahl()).toBe('auto');
  });

  it("liefert 'auto' bei einem unbekannten gespeicherten Wert", () => {
    localStorage.setItem(DEVICE_PROFILE_KEY, 'tablet');
    expect(leseProfilAuswahl()).toBe('auto');
  });

  it("liefert 'auto', wenn der Speicher gesperrt ist (getItem wirft)", () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('gesperrt'); },
      setItem: () => { throw new Error('gesperrt'); },
    });
    expect(leseProfilAuswahl()).toBe('auto');
  });

  it('schreibt unter dem Schlüssel jdesk.deviceProfile', () => {
    schreibeProfilAuswahl('ipad');
    expect(localStorage.getItem(DEVICE_PROFILE_KEY)).toBe('ipad');
    expect(leseProfilAuswahl()).toBe('ipad');
  });

  it('kehrt bei werfendem setItem still zurück', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => { throw new Error('gesperrt'); },
    });
    expect(() => schreibeProfilAuswahl('smartphone')).not.toThrow();
  });

  it('kennt genau die vier gültigen Übersteuerungswerte', () => {
    expect(PROFIL_AUSWAHLEN).toEqual(['auto', 'desktop', 'ipad', 'smartphone']);
  });
});

describe('erkanntesProfilAusUmgebung', () => {
  afterEach(() => vi.unstubAllGlobals());

  it("liefert 'desktop' in der Node-Testumgebung ohne window", () => {
    expect(erkanntesProfilAusUmgebung()).toBe('desktop');
  });

  it("liefert 'desktop', wenn window.matchMedia keine Funktion ist", () => {
    vi.stubGlobal('window', { innerWidth: 390, innerHeight: 844 });
    expect(erkanntesProfilAusUmgebung()).toBe('desktop');
  });

  it("misst über gestubbtes window: 'ipad' bei 1024x768 mit grobem Zeiger", () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });
    vi.stubGlobal('window', {
      innerWidth: 1024,
      innerHeight: 768,
      matchMedia: () => ({ matches: true }),
    });
    expect(erkanntesProfilAusUmgebung()).toBe('ipad');
  });

  it("misst über gestubbtes window: 'smartphone' bei 390x844", () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });
    vi.stubGlobal('window', {
      innerWidth: 390,
      innerHeight: 844,
      matchMedia: () => ({ matches: true }),
    });
    expect(erkanntesProfilAusUmgebung()).toBe('smartphone');
  });
});

describe('aktivesProfil (eingefrorenes Profil gewinnt während einer laufenden Sitzung)', () => {
  it('liefert das erkannte Profil ohne Einfrierung', () => {
    expect(aktivesProfil('smartphone', null)).toBe('smartphone');
  });

  it('liefert das eingefrorene Profil, auch wenn ein anderes erkannt wird', () => {
    expect(aktivesProfil('smartphone', 'ipad')).toBe('ipad');
  });
});

describe('profilLabel', () => {
  it('bildet auf die Anzeigenamen Desktop, iPad, Smartphone ab', () => {
    expect(profilLabel('desktop')).toBe('Desktop');
    expect(profilLabel('ipad')).toBe('iPad');
    expect(profilLabel('smartphone')).toBe('Smartphone');
  });
});

describe('profilMenuZeilen', () => {
  it('liefert vier Zeilen; genau eine trägt das Häkchen; die erste Zeile nennt das erkannte Profil', () => {
    const zeilen = profilMenuZeilen('auto', 'ipad');
    expect(zeilen).toHaveLength(4);
    const markiert = zeilen.filter((z) => z.label.startsWith('✓ '));
    expect(markiert).toHaveLength(1);
    expect(markiert[0]!.wert).toBe('auto');
    expect(zeilen[0]!.wert).toBe('auto');
    expect(zeilen[0]!.label).toContain('iPad');
  });

  it("markiert 'Smartphone erzwingen'; die Automatik-Zeile trägt kein Häkchen, nennt aber weiterhin das erkannte Profil", () => {
    const zeilen = profilMenuZeilen('smartphone', 'desktop');
    const smartphoneZeile = zeilen.find((z) => z.wert === 'smartphone')!;
    expect(smartphoneZeile.label).toBe('✓ Smartphone erzwingen');
    const autoZeile = zeilen.find((z) => z.wert === 'auto')!;
    expect(autoZeile.label.startsWith('✓ ')).toBe(false);
    expect(autoZeile.label).toContain('Desktop');
  });
});
