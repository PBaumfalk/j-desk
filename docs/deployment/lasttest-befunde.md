# Lasttest-Befunde: realistisch große Akte (OPS-04)

> Stand: Phase 14 (Betriebsreife & Produktisierung), Plan 14-03. Quelle für alle hier genannten
> Messwerte und Schwellen: `packages/server/src/desk-volume.perf.test.ts`. Weicht dieses Dokument
> jemals von den im Test gesetzten Konstanten (`KOMMANDOKETTE_SCHWELLE_MS`,
> `PROJEKTION_SCHWELLE_MS`, `AUSLIEFERUNG_SCHWELLE_MS`) ab, gilt der Test — bitte melden.

Die Forschungs-Flagge „Performance-Härtetest" stand seit Phase 4 offen (`.planning/research/SUMMARY.md`):
ohne Messung an Volumen war die Aussage „läuft gut" eine Vermutung. Dieses Dokument hält fest, was
gemessen wurde, mit welchem Ergebnis, und wie jeder gefundene Befund eingeordnet ist — OPS-04
verlangt wörtlich sowohl einen bestandenen Lasttest als auch behobene Befunde, nicht nur den einen
oder den anderen.

## 1. Was gemessen wurde

Ein Schreibtisch mit 800 Objekten über vier versionierte Arten (450 Dokumente, 150 Notizen, 100
Stempel, 100 Fahnen) wurde AUSSCHLIESSLICH über echte Kommandos aufgebaut (kein direktes Schreiben
in die Zustandsspalte, s. 14-RESEARCH.md Pitfall 4) — verteilt über drei Ebenen (Kanzlei implizit,
private Ebene eines Zweitnutzers, exportierbare Ebene), damit die Projektion echte Filterarbeit
leistet. Drei Pfade wurden gemessen, alle drei mit performance.now() bzw. über echte
`app.inject()`-Anfragen gegen die laufende App:

1. **Kommandokette:** der Aufbau selbst — ~1.140 Kommandos (800 erzeugende + 340 `changeLayerId`
   zur Ebenenverteilung), jedes mit Journalzeile im Betriebstakt.
2. **Projektion je Rolle:** `projectStateForActor()` einmal für den Eigentümer, einmal für einen
   externen Gast (der teurere Pfad — zieht zusätzlich die Freigabe-Auflösung je Objekt).
3. **Zustandsauslieferung:** `GET /api/v1/desks/:id/state` gegen die echte App, inklusive Guard,
   Datenbanklesung und Serialisierung — für dieselben zwei Rollen, mit erfasster Antwortgröße.

## 2. Messtabelle

Ausgangswerte über fünf lokale Läufe (`fnm exec --using=20 -- npx vitest run
packages/server/src/desk-volume.perf.test.ts --reporter=verbose`), alle Werte stabil im
angegebenen Bereich — keine Ausreißer beobachtet.

| Messfall | Aufbaugröße | Gemessener Wert (min–max) | Gesetzte Schwelle | Bewertung |
|----------|-------------|----------------------------|--------------------|-----------|
| Kommandokette (Aufbau) | 800 Objekte, ~1.140 Kommandos | 39,2–41,6 ms | 200 ms | bestanden, deutliche Reserve |
| Projektion Eigentümer | 800 Objekte (700 sichtbar) | 0,2–0,3 ms | 25 ms | bestanden, deutliche Reserve |
| Projektion externer Gast | 800 Objekte (170 sichtbar) | 0,3–0,7 ms | 25 ms | bestanden, deutliche Reserve |
| Auslieferung `GET /state` Eigentümer | 700 sichtbare Objekte, Antwort 141.997 Bytes | 4,1–4,3 ms | 100 ms | bestanden, deutliche Reserve |
| Auslieferung `GET /state` externer Gast | 170 sichtbare Objekte, Antwort 42.119 Bytes | 1,8–1,9 ms | 100 ms | bestanden, deutliche Reserve |

Schwellenwahl (14-03-PLAN.md Task 3, Vorgehen): erst gemessen, dann mit deutlicher Reserve über
dem beobachteten Höchstwert gesetzt. Die Reserve ist bewusst nicht überall exakt Faktor drei:

- **Kommandokette** (Faktor ~5 über dem Höchstwert): schreibt ~1.140 Journalzeilen synchron nach
  SQLite und ist damit der Pfad, der am empfindlichsten auf I/O-Streuung und langsamere
  Ausführungsumgebungen reagiert.
- **Projektion und Auslieferung** (absolute Untergrenze statt reinem Vielfachen): beide Pfade
  liegen im Sub-Millisekunden- bis niedrigen-einstelligen-Millisekunden-Bereich. Ein reines
  Vielfaches (z. B. Faktor drei von 0,7 ms = 2,1 ms) wäre so knapp, dass ein einzelner
  GC-Tick oder eine geringfügig langsamere CI-Maschine den Test grundlos rot färben würde — die
  Schwellen liegen deshalb bei 25 ms bzw. 100 ms, immer noch weit unter jedem Wert, der auf eine
  echte Regression hindeuten würde.

## 3. Befunde

### Befund 1 — Kein Performance-Problem gefunden

**Kandidaten geprüft** (14-03-PLAN.md Task 3, Punkt (2)): wiederholte lineare Ebenensuche je
Objekt in der Projektion (`findeEbene()` in `layers.ts`, aufgerufen aus `istObjektSichtbarFuer()`)
und die wiederholte Freigabe-Auflösung im Gast-Pfad (`effektiveFreigabe()` in `freigabe.ts`, ruft
`findeEbene()` intern ein zweites Mal auf).

**Ursache, warum das in der Praxis nicht trägt:** `findeEbene()` sucht linear über
`state.layers` (benutzerdefinierte + private Instanzen) plus die vier `SYSTEM_EBENEN` — in
diesem Lasttest maximal 5 Einträge (4 System-Ebenen + 1 materialisierte private Instanz), nicht
proportional zur Objektzahl. Bei 800 Objekten und doppelter Auflösung im Gast-Pfad ergibt das
rund 8.000 Vergleichsoperationen über ein 5-elementiges Array — gemessen als 0,3–0,7 ms
(Messtabelle oben). Die Iteration über `VERSIONIERTE_ARTEN` selbst (15 Arten, davon 11 in diesem
Fixture leer und per `if (!liste) continue` übersprungen) trägt ebenfalls nicht spürbar bei.

**Entscheidung: unkritisch.** Eine Änderung an `projection.ts` oder `deskStore.ts` ist durch
keine Messung gestützt — beide Pfade liegen mit 35- bis 80-facher Reserve unter ihrer Schwelle
(0,7 ms gegen 25 ms; 4,3 ms gegen 100 ms). „Behebe nur, was eine Messung stützt — eine
Optimierung ohne Befund ist Risiko ohne Ertrag" (14-03-PLAN.md Task 3, Punkt 2): eine
Cache-Struktur für Ebenen-Lookups oder eine gemeinsame Freigabe-Auflösung zwischen
`istObjektSichtbarFuer()` und `effektiveFreigabe()` wären reines Rückfallrisiko für den
Vertrauensvertrag von `projectStateForActor()` (T-14-03-01) ohne messbaren Ertrag. Die
Kandidaten bleiben dokumentiert für den Fall, dass eine künftige Akte deutlich mehr
benutzerdefinierte Ebenen trägt (dann wächst `state.layers`, nicht die Objektzahl, als
Kostentreiber) — bis dahin kein Handlungsbedarf.

### Befund 2 — Kommandokette am empfindlichsten für I/O-Streuung, aber weit unter Schwelle

**Beobachtung:** Die Kommandokette (39,2–41,6 ms) ist der einzige der drei Pfade, dessen Kosten
mit der Objektzahl linear wachsen (jedes `applyCommand` plus eine synchrone `appendJournal`-
Zeile). Bei den hier gewählten 800 Objekten liegt sie dennoch bei nur ~20 % der gesetzten
Schwelle.

**Entscheidung: unkritisch, mit dokumentiertem Folgeschritt für deutlich größere Akten.** Für
die im Objective genannte Größenordnung („mehrere hundert Dokumente", Roadmap wörtlich) besteht
kein Handlungsbedarf. Sollte eine künftige Akte in den Bereich mehrerer Tausend Objekte wachsen
(vergleichbar mit dem 5.000-Zeilen-Journal aus `restore.perf.test.ts`), ist die Journalisierung
selbst (nicht die Projektion) der erste Ort für eine erneute Messung — dieser Test liefert dafür
bereits die Fixture-Bausteine (`baueVolumen()`), nur mit größeren `*_COUNT`-Konstanten.

### Befund 3 — Kein neues Lastwerkzeug nötig

**Bestätigung der Planner-Entscheidung D-D** (14-03-PLAN.md): `autocannon` wurde geprüft und
bewusst nicht aufgenommen (14-COVERAGE.md). Der Vitest-Perf-Rahmen (Analog
`restore.perf.test.ts`) deckt den entschiedenen Umfang — Datenvolumen, kein
Mehrnutzer-Netzwerklasttest — vollständig ab; dieser Plan bestätigt das durch die Umsetzung ohne
neue Abhängigkeit.

**Entscheidung: unkritisch, kein Folgeschritt in dieser Phase.** Ein Nebenläufigkeitstest
(gleichzeitige Schreibzugriffe mehrerer Nutzer) bleibt ein möglicher künftiger Schritt, ist aber
nicht Gegenstand von OPS-04 (die Roadmap-Formulierung beschreibt wörtlich eine große Akte, nicht
viele gleichzeitige Nutzer).

## 4. Wie dieser Test erneut läuft

```bash
fnm exec --using=20 -- npx vitest run packages/server/src/desk-volume.perf.test.ts
```

Für den vollen Nachweis (Verhalten von Projektion/Ebenen/Freigabe unverändert nach der Bewertung
in Abschnitt 3, plus die Gesamtsuite):

```bash
fnm exec --using=20 -- npx vitest run packages/server/src/desk-volume.perf.test.ts \
  packages/core/src/projection.test.ts packages/core/src/freigabe.test.ts packages/core/src/layers.test.ts
fnm exec --using=20 -- npm test
```

Beide Kommandos liefen bei Abschluss dieses Plans grün (162 Testdateien, 2.596 bestanden, 2
vorbestehende `it.skip`-Fälle außerhalb dieses Plans übersprungen) — kein Erstlauf-Flake bei den
bekannten Kandidaten (`export/uebersichten.test.ts`, `restore.perf.test.ts`) beobachtet.
