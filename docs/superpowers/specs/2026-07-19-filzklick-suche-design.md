# Design: Quickwins — Doppelklick-Zettel & Karten-Suche

Datum: 2026-07-19 · Branch: `feature/inline-viewer` · Status: vom Auftraggeber gewählt
(„4 und 5" aus der Quickwin-Liste); Detailentscheidungen wie hier dokumentiert.

## 1. Doppelklick auf den Filz → Notizzettel (F4)

- Doppelklick (Mac) bzw. Doppeltipp (iPad, natives dblclick) auf **freie Tischfläche**
  legt einen `notiz`-Zettel zentriert am Klickpunkt an und öffnet ihn sofort im
  Bearbeiten-Modus (Muster `zettelAnlegen`).
- Guard: Nur wenn das Ereignis wirklich vom Filz kommt — Ziele innerhalb von Karten,
  Viewern, Zetteln, Stapeln, Ausschnitten, Bedienelementen werden ignoriert
  (`closest`-Prüfung). Kein neuer Zettel beim Doppelklick auf Objekte.
- Andere Typen weiterhin über „＋ → Zettel…" (dies ist die Schnellspur für Notizen).

## 2. Karten-Suche (F5)

- **Öffnen:** 🔎-Knopf im Bedienfeld (neben der Lupe) **oder** Cmd/Ctrl-F
  (preventDefault, ersetzt die Browser-Suche auf dem Desk). Escape schließt.
- **Feld:** schwebendes Suchfeld oben mittig (Tisch-Panel-Optik wie DeskControls);
  Live-Ergebnisliste darunter (max. 8): Art-Kürzel + Name/Textanfang.
- **Suchraum:** Karten-Namen, Stapel-Namen, Zettel-Texte und -Badges
  (case-insensitive Teilstring). Ausschnitte/Korb nicht.
- **Springen:** Klick oder Enter (erster Treffer) zentriert das Objekt in der
  Ansicht; ist der Zoom < 0.5, wird auf 0.8 angehoben, sonst bleibt er.
  Das Ziel wird ~2 s mit einem pulsierenden Umriss hervorgehoben (Overlay-Div in
  Weltkoordinaten — keine Änderungen an den Kartenkomponenten).
- „Keine Treffer" als Leerzustand; Suche funktioniert in beiden Modi (auch Akten-Desks).

## Tests & Verifikation

Client-only. Gate: `npx vitest run` + `npm run check` + `npm run build`; E2E-Sichtprüfung
(Doppelklick legt Zettel an genau der Stelle an und ist sofort beschreibbar; Doppelklick
auf eine Karte legt KEINEN Zettel an; Suche findet Karte + Zettel, springt hin, Puls sichtbar;
Cmd-F öffnet, Escape schließt).

## UAT

Sammelliste + Runde-2-Checkliste um **A14 (3 Punkte)** ergänzen; Zählung 129 → 132 (A 106).
