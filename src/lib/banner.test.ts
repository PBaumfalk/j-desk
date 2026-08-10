import { describe, it, expect } from 'vitest';
import { wartestandZusatz, bannerText, bannerSichtbar, bannerBlockiert } from './banner';

describe('wartestandZusatz', () => {
  it('liefert bei 0 und negativem Wartestand einen leeren Text', () => {
    expect(wartestandZusatz(0)).toBe('');
    expect(wartestandZusatz(-1)).toBe('');
  });

  it('liefert die Singularform bei 1 und die Pluralform mit Zahl ab 2', () => {
    expect(wartestandZusatz(1)).toBe(' — 1 Änderung wartet auf Übertragung');
    expect(wartestandZusatz(2)).toBe(' — 2 Änderungen warten auf Übertragung');
    expect(wartestandZusatz(7)).toBe(' — 7 Änderungen warten auf Übertragung');
  });
});

describe('bannerText', () => {
  it('liefert den Trenn-Text ohne Zusatz bei leerer Warteschlange und mit Pluralzusatz bei Wartestand', () => {
    expect(bannerText('offline', 0)).toBe('Verbindung getrennt — verbinde neu…');
    expect(bannerText('offline', 3)).toBe('Verbindung getrennt — verbinde neu… — 3 Änderungen warten auf Übertragung');
  });

  it('liefert den Verbinde-Text mit Singularzusatz', () => {
    expect(bannerText('connecting', 1)).toBe('Verbinde… — 1 Änderung wartet auf Übertragung');
    expect(bannerText('connecting', 0)).toBe('Verbinde…');
  });

  it('liefert online den Übertragungstext ohne Zähleranhang', () => {
    expect(bannerText('online', 2)).toBe('Änderungen werden übertragen…');
    expect(bannerText('online', 0)).toBe('Änderungen werden übertragen…');
  });
});

describe('bannerSichtbar', () => {
  it('ist online ohne Wartestand unsichtbar, sonst sichtbar', () => {
    expect(bannerSichtbar('online', 0)).toBe(false);
    expect(bannerSichtbar('online', 1)).toBe(true);
    expect(bannerSichtbar('offline', 0)).toBe(true);
    expect(bannerSichtbar('connecting', 0)).toBe(true);
  });
});

describe('bannerBlockiert', () => {
  it('blockiert nur getrennt und verbindend, nie online mit offener Warteschlange', () => {
    expect(bannerBlockiert('offline')).toBe(true);
    expect(bannerBlockiert('connecting')).toBe(true);
    expect(bannerBlockiert('online')).toBe(false);
  });
});

describe('Reinheit', () => {
  it('liefert bei gleicher Eingabe gleiche Ergebnisse', () => {
    expect(bannerText('offline', 2)).toBe(bannerText('offline', 2));
    expect(wartestandZusatz(4)).toBe(wartestandZusatz(4));
    expect(bannerSichtbar('online', 1)).toBe(bannerSichtbar('online', 1));
    expect(bannerBlockiert('connecting')).toBe(bannerBlockiert('connecting'));
  });
});
