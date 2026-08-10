# WebSocket-Protokoll

> Stand: Commit `bd996a6` — bei API-Änderungen mitpflegen.

Ein Schreibtisch sendet Live-Updates per WebSocket an alle verbundenen Clients — jeder
angenommene Command wird nach seiner Anwendung an alle Sockets desselben Schreibtischs
gebroadcastet (`packages/server/src/broadcast.ts`; „Räume" pro Desk-Id). So bleiben mehrere
Browser-Tabs bzw. Nutzer auf demselben Schreibtisch synchron, ohne pollen zu müssen.

Quelle für alle Angaben dieser Seite: `packages/server/src/app.ts` (Ticket-Route,
`/desks/:id/ws`-Handler, Auth-Hook, Broadcast-Aufrufe), `packages/server/src/broadcast.ts`
(Register/Broadcast) und `packages/server/src/auth.ts` (`createWsTickets`) sowie der
Referenz-Client `src/lib/store.svelte.ts` / `src/lib/api.ts`.

## 1. Ticket ausstellen

```
POST /api/v1/ws-ticket
```

Wie jede reguläre `/api/`-Route mit Bearer-Token aufgerufen (`authorization: Bearer <TOKEN>`).
Details/Fehlerformat siehe [rest.md → POST /api/v1/ws-ticket](rest.md#post-apiv1ws-ticket).

**Response 200**
```json
{ "ticket": "<TICKET>" }
```

Ausgestellt von `wsTickets.issue(userId)` (`packages/server/src/app.ts`, Zeile 545–547,
`createWsTickets` in `auth.ts`). Das Ticket ist **einmalig gültig** und läuft nach **30
Sekunden** ab (`createWsTickets(ttlMs = 30_000)`, `packages/server/src/auth.ts`, Zeile 96). Ein
zweiter Verbindungsversuch mit demselben Ticket schlägt fehl — pro Verbindungsaufbau muss ein
frisches Ticket geholt werden (siehe Abschnitt „Reconnect" unten).

## 2. Verbindung aufbauen

```
GET /api/v1/desks/:id/ws?ticket=<TICKET>
```

Der WebSocket-Upgrade läuft über einen eigenen Fastify-Handler mit `{ websocket: true }`
(`packages/server/src/app.ts`, Zeile 549–553). Browser-`WebSocket`-Objekte können keine
Header setzen, daher **kein Bearer-Token** für diese Route — stattdessen das Einmal-Ticket als
Query-Parameter `ticket`. Die Prüfung passiert im globalen `onRequest`-Hook, **bevor** der
WebSocket-Handler überhaupt aufgerufen wird (`app.ts`, Zeile 126, `WS_PATH`-Regex `Zeile 57`:
`/^\/api\/v1\/desks\/[^/]+\/ws$/`):

```ts
if (WS_PATH.test(path)) {
  const ticket = (req.query as { ticket?: string })?.ticket;
  const session = ticket ? wsTickets.consume(ticket) : null;
  if (!session) return reply.code(401).send({ error: 'Nicht angemeldet' });
  (req as FastifyRequest & { userId: string }).userId = session.userId;
  return;
}
```

Ein altes Session-Token (das gewöhnliche Bearer-Token) wird für diese Route **nicht**
akzeptiert — nur ein über `POST /ws-ticket` ausgestelltes Ticket funktioniert
(`packages/server/src/ws.test.ts`, Test „das Session-Token in der Query wird für den WS NICHT
mehr akzeptiert").

Referenz-Client, exakte URL-Konstruktion (`src/lib/api.ts`, Zeile 175–178):

```ts
wsUrl(deskId: string, ticket: string): string {
  const base = this.baseUrl || location.origin;
  return `${base.replace(/^http/, 'ws')}/api/v1/desks/${deskId}/ws?ticket=${ticket}`;
}
```

Also z. B. `ws://localhost:4810/api/v1/desks/<DESK_ID>/ws?ticket=<TICKET>`.

Nach dem Upgrade registriert der Handler den Socket im Room des Schreibtischs
(`register(id, socket)`, `broadcast.ts`) und trägt ihn beim Schließen wieder aus
(`socket.on('close', () => unregister(id, socket))`, `app.ts`, Zeile 551–552). Die Verbindung
selbst überträgt clientseitig **nichts** — der Handler liest keine eingehenden Nachrichten,
er dient ausschließlich dem Server-zu-Client-Broadcast.

## 3. Nachrichtenformat

Jeder angenommene Command auf `POST /api/v1/desks/:id/commands` (siehe
[commands.md](commands.md)) sowie der interne `addDoc`-Command aus
`POST /api/v1/cases/:id/documents` (jlawyer-Modus, siehe rest.md) löst nach der Anwendung
`broadcast(id, result)` aus (`app.ts`, Zeilen 290, 334, 454, 467). `result` ist dieselbe Form
wie die HTTP-Antwort der Command-Route:

```json
{ "rev": 4, "state": { "docs": [], "stacks": [], "notes": [] } }
```

`state` ist immer der **vollständige** neue Zustand (kein Diff), `rev` der um eins erhöhte
Revisionszähler (`packages/server/src/deskStore.ts`, `applyDeskCommand`). `broadcast()`
serialisiert per `JSON.stringify` und sendet an **alle** Sockets im Room des Schreibtischs —
inklusive des Sockets, der die auslösende Aktion selbst geschickt hat (`broadcast.ts`, Zeile
19–28); der Client verwendet den Broadcast trotzdem, ignoriert ihn aber effektiv, wenn er die
Server-Antwort der eigenen Anfrage bereits mit derselben oder höherer `rev` übernommen hat
(`rev >= vorhandene rev` in `src/lib/store.svelte.ts`, `acceptServerState` und
`socket.onmessage`, Zeile 264–268).

Fehlerhafte/nicht parsebare Nachrichten verwirft der Referenz-Client stillschweigend — der
nächste Broadcast bringt ohnehin wieder den vollen Zustand (`store.svelte.ts`, Zeile 256–263).

## 4. Verbindungsabbau

Der Server sendet **keine** eigenen Close-Codes — weder im Code von
`packages/server/src/app.ts` noch in `broadcast.ts` findet sich ein expliziter
`socket.close(code, …)`-Aufruf. Es gilt:

- **Ticket fehlt/unbekannt/abgelaufen:** Der Auth-Hook weist den Upgrade bereits per HTTP mit
  `401 { "error": "Nicht angemeldet" }` ab — der Client sieht dies als fehlgeschlagenen
  Verbindungsaufbau (`ws`-Client: `unexpected-response`; Browser-`WebSocket`: `error`- und
  danach `close`-Event), **nicht** als WebSocket-Close-Frame mit Anwendungscode. Verifiziert
  in `packages/server/src/ws.test.ts` (Tests „WS ohne gültiges Ticket wird abgewiesen", „das
  Session-Token in der Query wird für den WS NICHT mehr akzeptiert", „ein Ticket ist nur
  einmal verwendbar").
- **Normales Schließen:** Der Referenz-Client schließt selbst aktiv beim Verlassen des
  Schreibtischs bzw. beim Abmelden (`closeWs()`/`desktop.stop()`, `store.svelte.ts`, Zeile
  191–220) — Standard-Close-Code `1000`.
- **Verbindungsabbruch (Netzwerk, Server-Neustart o. Ä.):** kein Anwendungscode, der native
  `close`-Event feuert mit dem vom Browser/`ws`-Paket gesetzten Code (typischerweise `1006`
  bei abnormalem Abbruch).

> **Abweichung von der ursprünglichen Annahme:** Es gibt im aktuellen Code **keine**
> anwendungsspezifischen Close-Codes `4001`/`4003` — weder als Konstante noch als
> `socket.close(...)`-Aufruf. Ablehnungen laufen ausschließlich über den HTTP-401 beim Upgrade
> (siehe oben). Sollte das in einer künftigen Version anders sein, bitte diesen Abschnitt
> gegen den dann aktuellen Code prüfen.

## 5. Reconnect

Der Referenz-Client (`src/lib/store.svelte.ts`) behandelt **jedes** `close`-Event einheitlich
über `onDisconnected()` (Zeile 270–274, 277–292) und holt bei jedem Reconnect-Versuch ein
**frisches** Ticket — abgelaufene/verbrauchte Tickets sind sonst nutzlos:

```ts
// store.svelte.ts, Zeile 222–236 (gekürzt)
function connectWs(): void {
  if (!api || !deskId || stopped) return;
  const generation = ++wsGeneration;
  void (async () => {
    const ticket = (await api!.wsTicket()).ticket; // frisches Ticket je Versuch
    if (generation !== wsGeneration || stopped) return;
    openSocket(generation, api.wsUrl(deskId, ticket));
  })();
}
```

Backoff: Start bei `1000 ms`, Verdopplung pro fehlgeschlagenem Versuch, gedeckelt bei
`15000 ms` (`reconnectDelay`, Zeile 15, 283–284). Vor jedem Reconnect wird zusätzlich der
Schreibtisch-Zustand per REST neu geladen (`desktop.refresh()`, Zeile 288), damit während der
Downtime verpasste Broadcasts nicht zu einem veralteten `state` führen. Eine `generation`-
Zählung verhindert, dass ein überholter (z. B. durch Schreibtischwechsel verworfener) Socket
noch Zustand überschreibt (Zeile 224, 233, 247–251, 257, 273).

## Vollständiges Beispiel (Browser-`WebSocket`)

```js
const BASE = 'http://localhost:4810/api/v1';
const TOKEN = '<TOKEN>';
const DESK_ID = '<DESK_ID>';

async function connect() {
  const { ticket } = await fetch(`${BASE}/ws-ticket`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
  }).then((r) => r.json());

  const ws = new WebSocket(
    `${BASE.replace(/^http/, 'ws')}/desks/${DESK_ID}/ws?ticket=${ticket}`,
  );
  ws.onmessage = (ev) => {
    const { rev, state } = JSON.parse(ev.data);
    console.log('neue Revision', rev, state);
  };
  ws.onclose = () => setTimeout(connect, 1000); // frisches Ticket pro Versuch, s. o.
  return ws;
}

connect();
```
