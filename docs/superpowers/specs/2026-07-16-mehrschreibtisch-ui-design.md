# Digital Desktop v2 — Mehrschreibtisch-UI (Teilprojekt 2)

**Datum:** 2026-07-16
**Status:** Vom Nutzer freigegeben
**Baut auf:** Teilprojekt 1 (Client-Server, auf `main` gemergt); Server-API `/desks` (CRUD) existiert vollständig und ist getestet.

## Ziel

Der Nutzer kann in der App mehrere Schreibtische anlegen, benennen, löschen und zwischen ihnen wechseln — über ein Dropdown-Menü links in der Toolbar. Der zuletzt aktive Schreibtisch wird pro Gerät gemerkt.

## Umfang

**API-Client (`src/lib/api.ts`):** neue Methoden `renameDesk(deskId, name)` → `PATCH /desks/:id` und `deleteDesk(deskId)` → `DELETE /desks/:id`.

**Session (`src/lib/session.ts`):** `Session` bekommt optionales Feld `lastDeskId?: string`. `parseSession` bleibt abwärtskompatibel (Feld fehlt → gültig; falscher Typ → verwerfen des Feldes, nicht der Session). Neue Helper-Funktion `saveLastDeskId(deskId)` aktualisiert nur dieses Feld.

**Store (`src/lib/store.svelte.ts`):**
- Neu im Zustand: `desks: DeskInfo[]` (reaktiv), gefüllt in `start()` und nach jeder Desk-Operation.
- `start()` wählt statt „immer der erste": `lastDeskId` aus der Session, falls vorhanden und noch existent; sonst erster; sonst „Schreibtisch 1" anlegen.
- `switchDesk(deskId)`: aktuellen WebSocket trennen (ohne `stopped`/`loggedOut` zu setzen — eigener `closeWs()`-Helfer), `getState` laden und dabei den internen `rev`-Zähler auf den geladenen Stand des NEUEN Schreibtischs setzen (nicht vergleichen — der alte rev gehört zum alten Desk), neuen WebSocket verbinden, `saveLastDeskId` aufrufen.
- `createDesk(name)`: anlegen, Liste aktualisieren, direkt hinwechseln.
- `renameDesk(deskId, name)`, `deleteDesk(deskId)`: API-Aufruf + Liste aktualisieren. Beim Löschen des aktiven Schreibtischs: zum ersten verbleibenden wechseln; war es der letzte, automatisch „Schreibtisch 1" anlegen und hinwechseln.
- Alle Operationen respektieren den Offline-Guard (Toast „Offline — Aktion nicht möglich") und melden Fehler als deutsche Toasts.

**Neue Komponente `src/lib/components/DeskSwitcher.svelte`:** links in der Toolbar (Desktop.svelte). Zeigt den Namen des aktiven Schreibtischs als Knopf; Klick öffnet ein Menü:
- Liste aller Schreibtische, aktiver mit Häkchen, Klick wechselt.
- Trennlinie, dann „Neuer Schreibtisch…", „Umbenennen…", „Löschen…".
- Namenseingaben (neu/umbenennen) über ein Eingabefeld direkt im Menü (Enter bestätigt, Escape bricht ab). Bewusst kein `window.prompt` (blockiert die Webview).
- „Löschen…" nutzt `ask()` aus plugin-dialog mit dem Hinweis: „Karten und Verknüpfungen dieses Schreibtischs werden entfernt. Die PDF-Dateien bleiben in der Server-Ablage erhalten." 
- Menü schließt bei Klick außerhalb und bei Escape.

## Nicht im Umfang

- Server-Änderungen (API existiert), Rechteprüfung (Teilprojekt 3), Duplizieren/Sortieren von Schreibtischen, Aufräumen verwaister Dateien in der Server-Ablage.

## Tests

- Vitest: `parseSession`-Abwärtskompatibilität (ohne/mit/mit falsch typisiertem `lastDeskId`).
- Server-API: bereits abgedeckt (Teilprojekt 1).
- Dropdown, Wechsel-Verhalten, Lösch-Kaskade: manuelle Verifikation in der laufenden App.
