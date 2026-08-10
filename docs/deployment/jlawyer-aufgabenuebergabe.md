# Aufgaben an j-lawyer übergeben (TASK-02)

> Stand: Phase 08 (Juristische Objekttypen, Verknüpfungen & Aufgaben). Quelle für alle hier
> genannten Umgebungsvariablen, Standardwerte und Verhaltensweisen: `packages/server/src/jlawyer.ts`
> (`createDueDate`), `packages/server/src/app.ts` (Übergaberoute), `packages/server/src/main.ts`.

Dieses Dokument beschreibt die Übergabe einer J-DESK-Aufgabe an j-lawyer: wozu sie dient, welche
Konfiguration sie zwingend voraussetzt, was genau übertragen wird — und was ausdrücklich nicht.

## 1. Wozu die Übergabe dient

J-DESK erzeugt Aufgaben aus der Fallanalyse (TASK-01), ersetzt aber bewusst kein
Kanzlei-Aufgabensystem (`REQUIREMENTS.md`, Out-of-Scope: „Vollständiges Aufgabenmanagement"). Eine
Aufgabe, die tatsächlich fristgebunden nachverfolgt werden soll, muss dort ankommen, wo die Kanzlei
ohnehin ihre Fristen führt — sonst entsteht eine zweite, ungepflegte Aufgabenwelt. Die Übergabe legt
dafür eine **Wiedervorlage** in j-lawyer an (`PUT /rest/v6/cases/duedate/create`,
`RestfulDueDateV6`). Sie ist ein bewusster, bestätigungspflichtiger Grenzübertritt: Daten verlassen
die eigene Kontrolle und werden Teil der j-lawyer-Akte.

## 2. Zwingende Voraussetzung: die Kalender-Kennung

j-lawyers Wiedervorlage-Endpunkt verlangt eine `calendar`-Kennung (eine `CalendarSetup`-id), in
welchem Kalender die Wiedervorlage angelegt werden soll. j-lawyers REST-API bietet **keinen**
Endpunkt, um verfügbare Kalender aufzulisten — nur der j-lawyer-Desktop-Client kennt sie. Diese
Kennung kann J-DESK deshalb nicht automatisch ermitteln; sie muss von einem Menschen einmalig
konfiguriert werden.

**Wo im j-lawyer-Desktop-Client abzulesen:** Verwaltung → Kalender. Der Zielkalender muss außerdem
vom übergebenden j-lawyer-Nutzerkonto beschreibbar sein.

Ist die Kennung nicht konfiguriert, ruft J-DESK j-lawyer bei einem Übergabeversuch **gar nicht
erst** auf — die Route antwortet stattdessen mit:

```
JLAWYER_TASK_CALENDAR_ID ist nicht konfiguriert — siehe docs/deployment/jlawyer-aufgabenuebergabe.md.
```

## 3. Konfigurationswege

Zwei gleichwertige Wege, dieselbe Fallback-Kette wie `JLAWYER_URL`/`jlawyer_url` (Umgebungsvariable
hat Vorrang, sonst die Datenbank-Einstellung — eine gesetzte, aber leere Umgebungsvariable maskiert
die Einstellung nicht):

1. **Umgebungsvariable** `JLAWYER_TASK_CALENDAR_ID` — für Docker-Deployments, unverändert bei
   jedem Neustart.
2. **Datenbank-Einstellung** `jlawyer_task_calendar_id` — für dieselben Fälle, in denen bereits
   `jlawyer_url` per Setup-Dialog statt per Umgebungsvariable gesetzt wird. Für diese Einstellung
   existiert (Stand dieser Phase) **kein** eigener Setup-Dialog; sie wird direkt in der
   `settings`-Tabelle der SQLite-Datenbank hinterlegt:

   ```sql
   INSERT INTO settings (key, value) VALUES ('jlawyer_task_calendar_id', '<Kalender-Kennung>')
     ON CONFLICT(key) DO UPDATE SET value = excluded.value;
   ```

   (Server neu starten, damit die Einstellung wirksam wird — dieselbe Betriebsregel wie bei
   `jlawyer_url`.)

## 4. Was genau übertragen wird — und was nicht

Die Übergabe überträgt **ausschließlich** die drei Angaben, die auch im Bestätigungsdialog genannt
werden:

| Feld | Herkunft | j-lawyer-Feld |
|------|----------|----------------|
| Aufgabentitel | erste Zeile des Aufgabentexts (gekürzt) | `summary` |
| Verantwortliche/r | Aufgabenfeld `assignee` (fehlt, wenn nicht gesetzt) | `assignee` |
| Fälligkeit | Aufgabenfeld `dueDate` | `beginDate` |
| Bezug zu Dokument/Fundstelle | Dokumentname + Seitenzahl aus dem Aufgaben-Bezug (`docRef`) | `description` |

**Ausdrücklich NICHT übertragen:**

- **Kein Annotationstext, kein Ausschnitt-Textauszug, kein Ebenenname, kein Inhalt verknüpfter
  Objekte.** Die `description` enthält ausschließlich den Anzeigenamen des verknüpften Dokuments
  und ggf. die Seitenzahl — niemals den Inhalt einer daran hängenden Annotation.
- **Keine Priorität.** J-DESKs Aufgaben kennen eine Priorität (Hoch/Mittel/Niedrig, TASK-01);
  j-lawyers Wiedervorlage-Modell (`RestfulDueDateV6`) hat **kein** Prioritätsfeld. Die Priorität
  bleibt deshalb ausschließlich lokal in J-DESK und wird bei der Übergabe nicht mitgeschickt — der
  Bestätigungsdialog nennt sie deshalb bewusst nicht.
- **Keine internen Notizen, keine Kommentare, keine sonstigen Objekte der Fallanalyse.**

Zwei feste Werte werden serverseitig immer mitgeschickt und sind nicht konfigurierbar: `type` trägt
den Wert für eine Wiedervorlage (nicht die Fristen-Variante — die ist ausdrücklich nicht Teil
dieser Phase), `reminderMinutes` trägt den Wert für „keine Erinnerung".

## 5. Ablauf und Fehlerverhalten

1. Der Nutzer wählt im Aufgaben-Kontextmenü „An j-lawyer übergeben" und bestätigt.
2. J-DESK prüft: j-lawyer-Modus aktiv? Kalender-Kennung konfiguriert? Beides fehlend beendet die
   Anfrage sofort mit einer verständlichen 400-Meldung — j-lawyer wird in diesen Fällen **nicht**
   kontaktiert.
3. Erst **nach** erfolgreicher Bestätigung durch j-lawyer setzt J-DESK den Aufgabenstatus auf „An
   j-lawyer übergeben" und hinterlegt Zeitpunkt und die von j-lawyer vergebene Kennung. Schlägt die
   Übergabe fehl (Netzwerkfehler, j-lawyer nicht erreichbar, Berechtigungsfehler, unbekannter
   Kalender), bleibt der Status unverändert — es gibt **keinen** optimistischen Statuswechsel vor
   der Serverbestätigung. Der Fehler erscheint als Toast mit der etablierten Fehlermeldung, nie mit
   dem rohen Ausnahmetext.
4. Trägt eine Aufgabe bereits eine frühere Übergabe-Provenienz, weist der Bestätigungstext
   ausdrücklich darauf hin, damit nicht versehentlich eine zweite Wiedervorlage entsteht.

Die Route ist an dasselbe Recht gebunden wie der Dokument-Upload nach j-lawyer (`upload`,
gefährliche Aktion, nur Eigentümer/Bearbeiter) — sie erzeugt schließlich ebenfalls neuen Inhalt in
einem fremden System.

## 6. Vor dem Produktivbetrieb: gegen die eigene j-lawyer-Fassung prüfen

Der oben beschriebene Feldsatz (`RestfulDueDateV6`) wurde aus dem offenen j-lawyer-Quellcode
abgeleitet, **nicht** aus einem Lauf gegen eine echte, laufende Instanz. Für einen anderen
Endpunkt (`changeDate`) hat sich bereits einmal gezeigt, dass die reale j-lawyer-Instanz vom
Quellcode abweichende Serialisierung verwendet (Klammersuffix im Datumsformat, siehe Kommentar in
`packages/server/src/jlawyer.ts`). Vor dem Produktivbetrieb sollte ein Betriebsverantwortlicher
deshalb einmalig gegen die eigene j-lawyer-Fassung verifizieren, dass eine Wiedervorlage über
`createDueDate()` tatsächlich mit dem erwarteten Datum und den erwarteten Feldern ankommt — analog
zur Live-Verifikation anderer j-lawyer-Endpunkte in dieser Kanzleiumgebung. Bis zu dieser
Verifikation gilt der Feldsatz als gegen den Attrappen-Server abgesichert, nicht als gegen eine
echte Instanz bestätigt.
