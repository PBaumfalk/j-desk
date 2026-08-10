# Sicherheit

J-DESK verarbeitet Mandatsdaten. Ein Fehler in dieser Software kann anwaltliche
Verschwiegenheitspflichten berühren (§ 43a BRAO, § 203 StGB). Sicherheitsmeldungen haben deshalb
Vorrang vor allen anderen Anliegen.

## Eine Schwachstelle melden

**Bitte nicht über öffentliche GitHub-Issues.** Eine öffentliche Meldung macht die Lücke bekannt,
bevor Kanzleien sie schließen können.

Stattdessen einer dieser Wege:

1. **GitHub Security Advisory** — auf der Registerkarte „Security" dieses Repositories
   „Report a vulnerability". Das ist der bevorzugte Weg; die Meldung bleibt vertraulich, bis ein
   Gegenmittel bereitsteht.
2. **E-Mail** an den Betreuer des Repositories, falls Ihnen der erste Weg nicht offensteht.

Hilfreich in der Meldung: betroffene Version, Schritte zum Nachvollziehen, die vermutete
Auswirkung und — falls vorhanden — ein Vorschlag zur Behebung. Ein knapper Hinweis ist besser als
keiner; bitte warten Sie nicht, bis Sie eine vollständige Analyse haben.

## Was Sie erwarten können

| Schritt | Zeitrahmen |
|---|---|
| Eingangsbestätigung | innerhalb von 3 Werktagen |
| Erste Einschätzung (betroffen ja/nein, Schweregrad) | innerhalb von 10 Werktagen |
| Gegenmittel oder Umgehungslösung bei hohem Schweregrad | so schnell wie möglich, Stand wird laufend mitgeteilt |

Dies ist ein Projekt mit begrenzten Kräften, keine Herstellerorganisation mit
Rufbereitschaft — die Angaben sind ein ernst gemeintes Ziel, keine vertragliche Zusage.

## Unterstützte Versionen

Sicherheitskorrekturen erhält die jeweils neueste veröffentlichte Nebenversion. Ältere Stände
werden nicht rückwirkend gepflegt; ein Update ist der vorgesehene Weg.

## Besonders schutzbedürftige Bereiche

Wer gezielt prüfen möchte, findet hier die Stellen, an denen ein Fehler den größten Schaden
anrichtet:

- **Schwärzungen** — eine Schwärzung muss den Text tatsächlich entfernen, nicht nur verdecken.
  Ein schwarzes Rechteck über weiterhin auslesbarem Text wäre ein schwerer Fehler.
- **Interne Annotationen in Exporten** — Notizen und Bewertungen, die nur für die eigene Akte
  gedacht sind, dürfen nie in einen Export für die Gegenseite oder das Gericht gelangen.
- **Trennung zwischen Nutzern und Schreibtischen** — Zugriffsprüfungen finden serverseitig statt;
  die Oberfläche blendet Bedienelemente nur zusätzlich aus. Wer über die HTTP-Schnittstelle an
  fremde Inhalte kommt, hat eine meldenswerte Lücke gefunden.
- **Anmeldung im j-lawyer-Betrieb** — Zugangsdaten werden an j-lawyer durchgereicht und dort
  geprüft. J-DESK darf keine eigene Hintertür daneben öffnen.

## Was keine Schwachstelle ist

- Berichte aus automatischen Prüfwerkzeugen ohne belegten Angriffsweg
- Fehlende Sicherheitskopfzeilen ohne konkrete Auswirkung
- Angriffe, die vollen Zugriff auf den Server oder das Kanzleinetz voraussetzen — wer dort ist,
  hat die Daten ohnehin
