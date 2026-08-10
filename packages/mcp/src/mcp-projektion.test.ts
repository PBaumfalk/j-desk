import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestSetup, type TestSetup } from './testServer';
import { sendCommand } from './deskApi';

/**
 * PERM-05, Pfad 10 (MCP-Lesezugriff, 02-RESEARCH.md): MCP ruft `getState`/`sendCommand` über
 * dieselben REST-Endpunkte auf wie das Frontend (`packages/mcp/src/deskApi.ts:59-61`) — kein
 * eigener Projektions-Code nötig, sobald 2+3 projizieren (02-04/02-05). Dieser Test belegt genau
 * das: das MCP-Token eines Nutzers OHNE Sichtrecht liefert das private Objekt eines anderen
 * Nutzers nicht; ein Token ohne jede Rolle wird verweigert (kein impliziter Vollzugriff, A2).
 */

const MARKER = 'MARKER-MCP-GEHEIM-4d2c8a';

let ts: TestSetup;
beforeAll(async () => {
  ts = await startTestSetup();
});
afterAll(async () => {
  await ts.stop();
});

describe('Task 2: MCP-Projektionstest (Pfad 10) + Rollen-403-Abdeckung', () => {
  it('MCP getState (get_desk) mit dem Token von Nutzer B liefert nur Bs projizierte Sicht — ein privates Objekt von A fehlt', async () => {
    const deskId = await ts.createDesk('Akte A (MCP-Trace)');
    const layerId = await ts.setzePrivateEbene(deskId);
    await sendCommand(ts.deskUrl, ts.token, deskId, {
      type: 'addNote',
      payload: { id: 'n-mcp-marker', kind: 'notiz', text: MARKER, position: { x: 0, y: 0 } },
    });
    await sendCommand(ts.deskUrl, ts.token, deskId, {
      type: 'changeLayerId',
      payload: { objectId: 'n-mcp-marker', layerId },
    });

    const { token: tokenB, userId: userIdB } = await ts.zweitBenutzer();
    ts.gewaehreRolle(deskId, userIdB, 'Bearbeiter');
    const clientB = await ts.clientMitToken(tokenB);

    const rB = await clientB.callTool({ name: 'get_desk', arguments: { deskId } });
    expect(rB.isError).toBeFalsy();
    const textB = (rB.content as { type: string; text: string }[]).map((c) => c.text).join('');
    expect(textB).not.toContain(MARKER);

    // Positivkontrolle: der Eigentümer (Standard-Testnutzer, `ts.token`) sieht die eigene private Notiz weiterhin.
    const rEigentuemer = await ts.mcpClient.callTool({ name: 'get_desk', arguments: { deskId } });
    expect(rEigentuemer.isError).toBeFalsy();
    const textEigentuemer = (rEigentuemer.content as { type: string; text: string }[]).map((c) => c.text).join('');
    expect(textEigentuemer).toContain(MARKER);
  });

  it('MCP-Token eines Nutzers ohne desk_roles-Zeile → verweigert (kein impliziter Vollzugriff, Assumption A2)', async () => {
    const deskId = await ts.createDesk('Nicht geteilte Akte (MCP)');
    const { token: tokenOhneRolle } = await ts.zweitBenutzer();
    const clientOhneRolle = await ts.clientMitToken(tokenOhneRolle);

    const r = await clientOhneRolle.callTool({ name: 'get_desk', arguments: { deskId } });
    expect(r.isError).toBe(true);
  });

  it('die Rolle des Token-Inhabers gilt 1:1 für MCP: Kommentator darf lesend zugreifen, aber keine unzureichenden Commands über MCP-Wege umgehen', async () => {
    const deskId = await ts.createDesk('Kommentator-Rollen-Test (MCP)');
    const { token: tokenKommentator, userId: userIdKommentator } = await ts.zweitBenutzer();
    ts.gewaehreRolle(deskId, userIdKommentator, 'Kommentator');
    const clientKommentator = await ts.clientMitToken(tokenKommentator);

    const rLesen = await clientKommentator.callTool({ name: 'get_desk', arguments: { deskId } });
    expect(rLesen.isError).toBeFalsy();

    // MCP hat keinen eigenen Schreibpfad in dieser Phase (nur Lese-Tools) — die REST-Rechteprüfung
    // (02-04 Task 2) gilt aber unverändert 1:1, falls ein Folgeplan Schreib-Tools ergänzt.
    await expect(
      sendCommand(ts.deskUrl, tokenKommentator, deskId, {
        type: 'removeNote',
        payload: { id: 'nie-existent' },
      }),
    ).rejects.toThrow();
  });
});
