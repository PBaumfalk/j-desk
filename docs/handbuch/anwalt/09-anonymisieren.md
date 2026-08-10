# Anonymisieren

*Namen und Daten durch Platzhalter ersetzen, bevor etwas das Haus verlässt.*

---

## Worum geht es?

Wenn Sie eine KI zu Rate ziehen, verlassen die übermittelten Inhalte Ihre Kanzlei. Bei
Mandatsdaten ist das die heikelste Stelle der ganzen Anwendung.

Die Anonymisierung setzt genau dort an: Bevor ein Text hinausgeht, werden Namen und
personenbezogene Angaben durch **Platzhalter** ersetzt. Aus „Frau Meier" wird
`[[person-XYZ]]`. Die KI arbeitet mit dem Platzhalter, Sie bekommen die Antwort zurück —
und J-DESK setzt die echten Namen wieder ein.

Die Zuordnung, welcher Platzhalter für welchen Namen steht, bleibt dabei **in Ihrer
Kanzlei**.

---

## Anonymisieren ist nicht Schwärzen

Die beiden werden oft verwechselt, tun aber Verschiedenes — und die Verwechslung kann teuer
werden:

| | **Schwärzen** | **Anonymisieren** |
|---|---|---|
| Was passiert | Text wird **entfernt** | Text wird **ersetzt** |
| Umkehrbar | **Nein**, endgültig | **Ja**, über die Zuordnung |
| Wozu | Unterlagen, die aus dem Haus gehen (Gericht, Gegenseite) | Inhalte, die zur KI gehen und deren Antwort Sie zurückbrauchen |
| Ergebnis | schwarzer Balken, Text ist weg | lesbarer Text mit `[[person-XYZ]]` |

**Faustregel:** Was das Gericht sieht, wird geschwärzt. Was die KI sieht, wird anonymisiert.

Für das Schwärzen siehe [Export und Schwärzen](07-export-und-schwaerzen.md).

---

## Was wird anonymisiert?

Drei Wege, je nachdem, womit Sie arbeiten:

- **Namen** einzeln — etwa Beteiligte einer Akte
- **Freitext** — ein Absatz, eine Behauptung, eine Notiz
- **Dokumenttext** — der ausgelesene Text einer Datei

Erkannt werden personenbezogene Angaben. Was genau gefunden wird, entscheidet der
Anonymisierungsdienst; J-DESK übergibt den Text und setzt das Ergebnis ein.

---

## Kann ich die echten Namen zurückbekommen?

**In der Regel ja.** Das ist der Unterschied zum Schwärzen: Die Zuordnung von Platzhalter zu
Original wird gespeichert, und die Rückübersetzung setzt die echten Namen wieder ein.

**Zwei Fälle, in denen es nicht geht:**

1. **Ihre Kanzlei hat die Rückübersetzung abgeschaltet.** Das ist eine bewusste
   Einstellung — wenn Vertraulichkeit über Bequemlichkeit gehen soll, kann die
   Technikbetreuung sie deaktivieren.

2. **Ihr Anonymisierungskonto speichert nichts** („Zero Data Retention"). Dann existiert
   die Zuordnung beim Dienst gar nicht erst. Sie erhalten die Meldung *„De-Anonymisierung
   nicht verfügbar"*.

Der zweite Fall ist kein Fehler, sondern eine Sicherheitseinstellung. Wenn Sie die
Rückübersetzung brauchen, klären Sie das mit Ihrer Technikbetreuung, **bevor** Sie mit
anonymisierten Texten arbeiten.

---

## Wo landet der Schlüssel?

Der Zugangsschlüssel für den Anonymisierungsdienst liegt **auf Ihrem Server**, nicht im
Browser. Alle Anfragen laufen über den Server Ihrer Kanzlei.

Das gilt auch fürs **Diktat**: Die Aufnahme geht an Ihren Server, der sie zur Umwandlung in
Text weiterreicht. Der Schlüssel erreicht den Browser nie, und die Aufnahme wird nirgends
abgelegt.

Praktisch bedeutet das: Ein Angreifer, der einen Arbeitsplatzrechner übernimmt, findet dort
keinen Zugang zum Anonymisierungsdienst.

---

## Was die Anonymisierung nicht leistet

Drei Grenzen, die Sie kennen sollten:

**Sie ersetzt nicht Ihr Urteil.** Der Dienst erkennt Namen und typische personenbezogene
Angaben. Er erkennt nicht, dass sich aus „der Geschäftsführer der einzigen Molkerei im
Landkreis" die Person zweifelsfrei ergibt. Solche Umschreibungen bleiben stehen.

**Sie ist keine Zusage nach außen.** Ob eine Übermittlung an einen KI-Dienst berufsrechtlich
zulässig ist, entscheidet nicht die Technik. Anonymisierung senkt das Risiko, sie beseitigt
die Prüfpflicht nicht.

**Sie greift nur, wo sie angewandt wird.** Ein Dokument, das Sie ohne Anonymisierung an die
KI geben, geht so hinaus, wie es ist.

---

## Ist der Dienst nicht erreichbar?

Dann bricht der Vorgang ab, statt den Text ungeschützt weiterzugeben. Sie erhalten eine
Meldung — je nachdem, ob der Dienst nicht antwortet, die Verarbeitung fehlschlug oder die
Wartezeit überschritten wurde.

Das ist die richtige Richtung: Lieber kein Ergebnis als ein Klartext-Versand.

---

**Zurück:** [Termin und KI](08-termin-und-ki.md) ·
[Vertraulichkeit](06-vertraulichkeit.md) · *[Schnellhilfe](README.md)*
