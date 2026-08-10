# tessdata

In diesem Verzeichnis muss die Datei `deu.traineddata` liegen, damit die deutsche
OCR-Erkennung (SEARCH-03) läuft. Sie liegt nicht im Repository, weil sie mit rund 15 MB ein
großes Binärartefakt ist, das sich nicht sinnvoll versionieren lässt und bei jedem Checkout
unnötig mitgeführt würde.

Beschaffung: entweder per Download-Befehl gegen die offizielle tessdata-Quelle des
Tesseract-Projekts, z. B.

```bash
curl -L -o packages/server/tessdata/deu.traineddata \
  https://github.com/tesseract-ocr/tessdata/raw/main/deu.traineddata
```

oder gleichwertig durch Kopieren der Datei aus einer bereits vorhandenen
Tesseract-Installation (z. B. `/usr/share/tesseract-ocr/*/tessdata/deu.traineddata` unter
Linux) — beide Wege liefern dieselbe Datei. Wichtig: unkomprimiert ablegen (`deu.traineddata`,
nicht `deu.traineddata.gz`), passend zur `gzip: false`-Konfiguration in `tessdata.ts`.

Fehlt die Datei, bleibt die OCR-Stufe ehrlich abgeschaltet: betroffene Dateien behalten den
Zustand `ocr-ausstehend`, es wird nichts von einem Netzdienst nachgeladen, und die Anwendung
läuft im Übrigen unverändert weiter. Sobald die Datei bereitgestellt wird, greift der nächste
Ingestionsdurchlauf.
