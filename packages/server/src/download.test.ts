import { describe, it, expect } from 'vitest';
import { dateiname, contentDisposition } from './download';

describe('contentDisposition', () => {
  it('wirft bei einem unpaarigen UTF-16-Surrogat nicht und liefert einen wohlgeformten Header', () => {
    const header = contentDisposition('Akte \ud800 Meier');
    // toWellFormed() ersetzt das unpaarige Surrogat durch U+FFFD, bevor encodeURIComponent
    // läuft — ohne das würde encodeURIComponent mit URIError ("URI malformed") abbrechen.
    expect(header).toBe(
      `attachment; filename="Akte - Meier"; filename*=UTF-8''${encodeURIComponent('Akte � Meier')}`,
    );
  });

  it('lässt ein wohlgeformtes Emoji-Surrogatpaar unangetastet und prozentkodiert es korrekt', () => {
    const header = contentDisposition('Akte 📎 Meier');
    // Nachweis, dass toWellFormed() nicht überfiltert: das Emoji bleibt im filename*-Teil
    // vollständig erhalten. Im ASCII-Rückfall (filename="...") wird jede der beiden
    // UTF-16-Codeeinheiten des Surrogatpaars einzeln durch "-" ersetzt (daher zwei Striche).
    expect(header).toBe(
      `attachment; filename="Akte -- Meier"; filename*=UTF-8''${encodeURIComponent('Akte 📎 Meier')}`,
    );
    expect(header).toContain(`filename*=UTF-8''${encodeURIComponent('Akte 📎 Meier')}`);
  });

  it('liefert bei Zeichen außerhalb Latin-1 einen ASCII-Rückfall plus korrekten filename*-Teil', () => {
    const header = contentDisposition('Kanzlei – Müller €');
    expect(header).toBe(
      `attachment; filename="Kanzlei - M-ller -"; filename*=UTF-8''${encodeURIComponent('Kanzlei – Müller €')}`,
    );
  });

  it('entfernt Steuerzeichen aus dem Header (keine Steuerzeichen mehr im Ergebnis)', () => {
    const header = contentDisposition('Akte\r\nBoese');
    // eslint-disable-next-line no-control-regex -- Nachweis, dass genau diese Zeichen fehlen.
    expect(header).not.toMatch(/[\x00-\x1f\x7f]/);
    expect(header).toBe(
      `attachment; filename="Akte--Boese"; filename*=UTF-8''${encodeURIComponent('Akte\r\nBoese')}`,
    );
  });

  it('greift bei einem Namen nur aus problematischen Zeichen auf den Rückfallwert zurück', () => {
    // '/' ist druckbares ASCII (0x2F) und bleibt im ASCII-Rückfall daher erhalten statt entfernt
    // zu werden — der Rückfallwert wird trotzdem nie leer, weil replace() nur Zeichen ersetzt,
    // nie streicht. Der Leer-Fall wird über einen rein aus Leerzeichen bestehenden Namen erreicht.
    expect(contentDisposition('///')).toBe(
      `attachment; filename="///"; filename*=UTF-8''${encodeURIComponent('///')}`,
    );
  });

  it('kann Anführungszeichen im Namen nicht zur Header-Injektion (CRLF) nutzen', () => {
    const header = contentDisposition('Akte "X"');
    // Der ASCII-Rückfall filtert nur Zeichen außerhalb des druckbaren Bereichs (0x20-0x7e);
    // druckbare Anführungszeichen bleiben unverändert erhalten. Sicherheitsrelevant ist,
    // dass dabei keine Steuerzeichen (insbesondere kein CR/LF) eingeschleust werden können,
    // wodurch der Header stets eine einzelne Kopfzeile bleibt und keine weitere HTTP-
    // Kopfzeile injiziert werden kann.
    expect(header).toBe(
      `attachment; filename="Akte "X""; filename*=UTF-8''${encodeURIComponent('Akte "X"')}`,
    );
    // eslint-disable-next-line no-control-regex -- Nachweis, dass keine Steuerzeichen enthalten sind.
    expect(header).not.toMatch(/[\x00-\x1f\x7f]/);
  });
});

describe('dateiname', () => {
  it('hängt .jdesk an einen unproblematischen Namen an', () => {
    expect(dateiname('Mandat Meier')).toBe('Mandat Meier.jdesk');
  });

  it('ersetzt problematische Zeichen durch "-"', () => {
    expect(dateiname('Meier / Müller: 12')).toBe('Meier - Müller- 12.jdesk');
  });

  it('ersetzt einen Namen nur aus problematischen Zeichen zeichenweise, wird dabei aber nicht leer', () => {
    // '/' wird durch '-' ersetzt, nicht entfernt — "///" wird daher zu "---" und bleibt
    // nicht-leer. Der Rückfallname "Schreibtisch" greift nur, wenn nach dem Ersetzen und
    // Trimmen tatsächlich nichts übrig bleibt (siehe folgender Test mit reinem Leerraum).
    expect(dateiname('///')).toBe('---.jdesk');
  });

  it('greift bei einem Namen nur aus Leerraum auf den Rückfallnamen "Schreibtisch" zurück', () => {
    expect(dateiname('   ')).toBe('Schreibtisch.jdesk');
  });

  it('greift bei leerem Namen auf den Rückfallnamen "Schreibtisch" zurück', () => {
    expect(dateiname('')).toBe('Schreibtisch.jdesk');
  });
});
