import { describe, it, expect, vi, afterEach } from 'vitest';
import { ApiClient } from './api';

afterEach(() => vi.unstubAllGlobals());

describe('ApiClient Mitglieder-Routen (Teilen-Dialog, PERM-03/PERM-04, 02-08 Task 1)', () => {
  it('listMembers ruft GET /desks/:id/members', async () => {
    const calls: { url: string; method?: string }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, opts?: RequestInit) => {
        calls.push({ url: String(url), method: opts?.method });
        return { ok: true, json: async () => [{ userId: 'u1', username: 'anna', rolle: 'Eigentümer' }, { userId: 'u2', username: 'yvonne', rolle: 'Bearbeiter' }] } as unknown as Response;
      }),
    );
    const result = await new ApiClient('', 'tok').listMembers('desk-1');
    expect(calls[0].url).toContain('/api/v1/desks/desk-1/members');
    expect(calls[0].method).toBe('GET');
    expect(result).toEqual([
      { userId: 'u1', username: 'anna', rolle: 'Eigentümer' },
      { userId: 'u2', username: 'yvonne', rolle: 'Bearbeiter' },
    ]);
  });

  it('addMember ruft POST /desks/:id/members mit username+rolle im Body', async () => {
    const calls: { url: string; opts?: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, opts?: RequestInit) => {
        calls.push({ url: String(url), opts });
        return { ok: true, json: async () => ({ ok: true }) } as unknown as Response;
      }),
    );
    await new ApiClient('', 'tok').addMember('desk-1', 'yvonne', 'Bearbeiter');
    expect(calls[0].url).toContain('/api/v1/desks/desk-1/members');
    expect(calls[0].opts?.method).toBe('POST');
    expect(JSON.parse(String(calls[0].opts?.body))).toEqual({ username: 'yvonne', rolle: 'Bearbeiter' });
  });

  it('addMember parst 404 bei unbekanntem Nutzernamen und 400 bei unbekannter Rolle wie bestehende Methoden', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({ error: 'Unbekannter Nutzer: nemo' }) }));
    await expect(new ApiClient('', 'tok').addMember('desk-1', 'nemo', 'Bearbeiter')).rejects.toThrow('Unbekannter Nutzer: nemo');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: 'Unbekannte Rolle: Superadmin' }) }));
    await expect(new ApiClient('', 'tok').addMember('desk-1', 'yvonne', 'Superadmin' as never)).rejects.toThrow('Unbekannte Rolle: Superadmin');
  });

  it('setMemberRolle ruft PUT /desks/:id/members/:userId und parst 403', async () => {
    const calls: { url: string; opts?: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, opts?: RequestInit) => {
        calls.push({ url: String(url), opts });
        return { ok: false, status: 403, json: async () => ({ error: 'Nur der Eigentümer darf Rollen vergeben' }) } as unknown as Response;
      }),
    );
    await expect(new ApiClient('', 'tok').setMemberRolle('desk-1', 'u2', 'Kommentator')).rejects.toThrow(
      'Nur der Eigentümer darf Rollen vergeben',
    );
    expect(calls[0].url).toContain('/api/v1/desks/desk-1/members/u2');
    expect(calls[0].opts?.method).toBe('PUT');
    expect(JSON.parse(String(calls[0].opts?.body))).toEqual({ rolle: 'Kommentator' });
  });

  it('removeMember ruft DELETE /desks/:id/members/:userId', async () => {
    const calls: { url: string; opts?: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, opts?: RequestInit) => {
        calls.push({ url: String(url), opts });
        return { ok: true, json: async () => ({ ok: true }) } as unknown as Response;
      }),
    );
    await new ApiClient('', 'tok').removeMember('desk-1', 'u2');
    expect(calls[0].url).toContain('/api/v1/desks/desk-1/members/u2');
    expect(calls[0].opts?.method).toBe('DELETE');
  });

  it('bei Netzwerkfehler (nicht 403) wirft setMemberRolle einen Fehler, den die UI für den Fallback-Toast + optimistischen Rücksprung nutzt', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(new ApiClient('', 'tok').setMemberRolle('desk-1', 'u2', 'Kommentator')).rejects.toThrow('Failed to fetch');
  });
});

describe('ApiClient.wsUrl', () => {
  it('baut aus expliziter http-Basis eine ws-URL mit Ticket', () => {
    expect(new ApiClient('http://x:4810', 'tok').wsUrl('d1', 'tic-1')).toBe(
      'ws://x:4810/api/v1/desks/d1/ws?ticket=tic-1',
    );
  });

  it('baut aus https-Basis eine wss-URL', () => {
    expect(new ApiClient('https://kanzlei.example', 'tok').wsUrl('d1', 'tic-1')).toBe(
      'wss://kanzlei.example/api/v1/desks/d1/ws?ticket=tic-1',
    );
  });

  it('nutzt bei leerer Basis den Origin der Seite', () => {
    vi.stubGlobal('location', { origin: 'https://kanzlei.example' });
    expect(new ApiClient('', 'tok').wsUrl('d1', 'tic-1')).toBe(
      'wss://kanzlei.example/api/v1/desks/d1/ws?ticket=tic-1',
    );
  });
});

describe('ApiClient.fetchPreview', () => {
  it('liefert bei 200 die PDF-Bytes als ready', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: async () => bytes.buffer,
      }),
    );
    await expect(new ApiClient('http://x', 'tok').fetchPreview('f1')).resolves.toEqual({
      status: 'ready',
      bytes,
    });
  });

  it('meldet bei 202 converting', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 202 }));
    await expect(new ApiClient('http://x', 'tok').fetchPreview('f1')).resolves.toEqual({
      status: 'converting',
    });
  });

  it('meldet bei 409 error mit der Server-Meldung', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: async () => ({ error: 'Konvertierung fehlgeschlagen', reason: 'failed' }),
      }),
    );
    await expect(new ApiClient('http://x', 'tok').fetchPreview('f1')).resolves.toEqual({
      status: 'error',
      message: 'Konvertierung fehlgeschlagen',
    });
  });

  it('wirft bei 404 wie gehabt einen ApiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({ error: 'Datei nicht gefunden' }),
      }),
    );
    await expect(new ApiClient('http://x', 'tok').fetchPreview('f1')).rejects.toThrow('Datei nicht gefunden');
  });
});

describe('ApiClient.listJournal', () => {
  it('listJournal hängt limit und before als Query an', async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      calls.push(String(url));
      return { ok: true, json: async () => ({ entries: [] }) } as unknown as Response;
    }) as typeof fetch;

    const client = new ApiClient('');
    await client.listJournal('desk-1', { limit: 50, before: 900 });

    expect(calls[0]).toContain('/api/v1/desks/desk-1/journal');
    expect(calls[0]).toContain('limit=50');
    expect(calls[0]).toContain('before=900');
  });

  it('listJournal lässt leere Optionen weg (Server setzt Standardwerte)', async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      calls.push(String(url));
      return { ok: true, json: async () => ({ entries: [] }) } as unknown as Response;
    }) as typeof fetch;

    await new ApiClient('').listJournal('desk-1');

    expect(calls[0]).not.toContain('limit=');
    expect(calls[0]).not.toContain('before=');
  });
});

describe('ApiClient.aufnehmenTextAblage (EXT-01, 13-06)', () => {
  it('POSTet JSON auf /cases/:id/aufnahme mit Bearer-Header und parst die projizierte Antwort', async () => {
    const calls: { url: string; opts?: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, opts?: RequestInit) => {
        calls.push({ url: String(url), opts });
        return { ok: true, json: async () => ({ rev: 3, state: { docs: [] }, rolle: 'Bearbeiter' }) } as unknown as Response;
      }),
    );
    const result = await new ApiClient('', 'tok').aufnehmenTextAblage('akte-2', {
      art: 'urteil', felder: { gericht: 'Amtsgericht', aktenzeichen: '1 C 2/26' }, name: 'Urteil',
    });
    expect(calls[0].url).toContain('/api/v1/cases/akte-2/aufnahme');
    expect(calls[0].opts?.method).toBe('POST');
    expect(calls[0].opts?.headers).toMatchObject({ authorization: 'Bearer tok' });
    expect(JSON.parse(String(calls[0].opts?.body))).toEqual({
      art: 'urteil', felder: { gericht: 'Amtsgericht', aktenzeichen: '1 C 2/26' }, name: 'Urteil',
    });
    expect(result).toEqual({ rev: 3, state: { docs: [] }, rolle: 'Bearbeiter' });
  });

  it('wirft bei 400 einen ApiError mit der Server-Meldung', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: 'Feld "felder.gericht" fehlt' }) }),
    );
    const promise = new ApiClient('', 'tok').aufnehmenTextAblage('akte-2', { art: 'urteil', felder: {} });
    await expect(promise).rejects.toThrow('Feld "felder.gericht" fehlt');
    await expect(promise.catch((e) => e)).resolves.toMatchObject({ status: 400 });
  });
});

describe('ApiClient.restoreDesk (04-01)', () => {
  it('schickt POST auf /desks/:id/restore mit toEntryId im JSON-Body', async () => {
    const calls: { url: string; opts?: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, opts?: RequestInit) => {
        calls.push({ url: String(url), opts });
        return { ok: true, json: async () => ({ ok: true, rev: 4 }) } as unknown as Response;
      }),
    );
    const result = await new ApiClient('', 'tok').restoreDesk('desk-1', 42);
    expect(calls[0].url).toContain('/api/v1/desks/desk-1/restore');
    expect(calls[0].opts?.method).toBe('POST');
    expect(JSON.parse(String(calls[0].opts?.body))).toEqual({ toEntryId: 42 });
    expect(result).toEqual({ ok: true, rev: 4 });
  });

  it('wirft bei 403 einen ApiError mit status === 403', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: 'Berechtigung verweigert für diese Aktion: manage' }) }),
    );
    const promise = new ApiClient('', 'tok').restoreDesk('desk-1', 42);
    await expect(promise).rejects.toThrow('Berechtigung verweigert für diese Aktion: manage');
    await expect(promise.catch((e) => e)).resolves.toMatchObject({ status: 403 });
  });
});

describe('ApiClient.fetchFileText (COMP-01/02, 09-08)', () => {
  it('ruft GET /desks/:id/file-text/:fileId und liefert die Seitenliste', async () => {
    const calls: { url: string; method?: string }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, opts?: RequestInit) => {
        calls.push({ url: String(url), method: opts?.method });
        return {
          ok: true,
          json: async () => ({ stand: 'pdf-text', seiten: [{ seite: 1, text: 'Erste Seite', quelle: 'pdf-text' }] }),
        } as unknown as Response;
      }),
    );
    const result = await new ApiClient('', 'tok').fetchFileText('desk-1', 'file-1');
    expect(calls[0].url).toContain('/api/v1/desks/desk-1/file-text/file-1');
    expect(calls[0].method).toBe('GET');
    expect(result).toEqual({ stand: 'pdf-text', seiten: [{ seite: 1, text: 'Erste Seite', quelle: 'pdf-text' }] });
  });

  it('wirft bei einer Ablehnung (404) einen ApiError mit der Server-Meldung', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({ error: 'Datei nicht gefunden oder nicht sichtbar.' }) }),
    );
    const promise = new ApiClient('', 'tok').fetchFileText('desk-1', 'file-unsichtbar');
    await expect(promise).rejects.toThrow('Datei nicht gefunden oder nicht sichtbar.');
    await expect(promise.catch((e) => e)).resolves.toMatchObject({ status: 404 });
  });

  it('kodiert die Datei-id im Pfad', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(String(url));
        return { ok: true, json: async () => ({ stand: 'unbekannt', seiten: [] }) } as unknown as Response;
      }),
    );
    await new ApiClient('', 'tok').fetchFileText('desk-1', 'file/mit spezial?zeichen');
    expect(calls[0]).toContain(encodeURIComponent('file/mit spezial?zeichen'));
  });
});

describe('ApiClient.anlagenpaketPruefung (KONV-03, 10-05)', () => {
  it('sendet POST auf den erwarteten Pfad mit JSON-Körper und gibt die Antwort unverändert zurück', async () => {
    const calls: { url: string; opts?: RequestInit }[] = [];
    const antwort = {
      dubletten: [{ docId: 'd1', lokaleSeite: 2, gleichWieDocId: 'd1', gleichWieLokaleSeite: 1 }],
      leerseiten: [{ docId: 'd2', lokaleSeite: 3 }],
      unbeurteilbar: [],
      seitenGesamt: 5,
      ausgelassen: 0,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, opts?: RequestInit) => {
        calls.push({ url: String(url), opts });
        return { ok: true, json: async () => antwort } as unknown as Response;
      }),
    );
    const wunsch = { deckblattTitel: 'Anlagen zu Test', eintraege: [{ docId: 'd1', bezeichnung: 'Eins' }] };
    const result = await new ApiClient('', 'tok').anlagenpaketPruefung('desk-1', wunsch);
    expect(calls[0].url).toContain('/api/v1/desks/desk-1/export/anlagenpaket/pruefung');
    expect(calls[0].opts?.method).toBe('POST');
    expect(JSON.parse(String(calls[0].opts?.body))).toEqual(wunsch);
    expect(result).toEqual(antwort);
  });

  it('die gesendete Anfrage enthält kein Feld für ausgeschlossene Seiten', async () => {
    const calls: { opts?: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, opts?: RequestInit) => {
        calls.push({ opts });
        return {
          ok: true,
          json: async () => ({ dubletten: [], leerseiten: [], unbeurteilbar: [], seitenGesamt: 0, ausgelassen: 0 }),
        } as unknown as Response;
      }),
    );
    await new ApiClient('', 'tok').anlagenpaketPruefung('desk-1', {
      deckblattTitel: 'T',
      eintraege: [{ docId: 'd1', bezeichnung: 'Eins' }],
    });
    const gesendet = JSON.parse(String(calls[0].opts?.body));
    expect(gesendet).not.toHaveProperty('ausgeschlosseneSeiten');
  });

  it('eine Antwort mit Status 422 führt zu einem ApiError mit Statuscode und Meldung', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        json: async () => ({ error: 'Es wurde keine Unterlage ausgewählt.', reason: 'ungueltige-anfrage' }),
      }),
    );
    const promise = new ApiClient('', 'tok').anlagenpaketPruefung('desk-1', { deckblattTitel: 'T', eintraege: [] });
    await expect(promise).rejects.toThrow('Es wurde keine Unterlage ausgewählt.');
    await expect(promise.catch((e) => e)).resolves.toMatchObject({ status: 422 });
  });
});

describe('ApiClient Benachrichtigungen-Routen (NOTIF-01, 13-01 Task 2)', () => {
  it('listBenachrichtigungen fragt GET /api/v1/benachrichtigungen mit Bearer-Header (user-scoped, kein deskId-Segment)', async () => {
    const calls: { url: string; opts?: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, opts?: RequestInit) => {
        calls.push({ url: String(url), opts });
        return {
          ok: true,
          json: async () => ({ benachrichtigungen: [{ id: 'z1', user_id: 'u1', desk_id: 'd1', art: 'erwaehnung', payload: {}, created_at: 1, read_at: null }] }),
        } as unknown as Response;
      }),
    );
    const result = await new ApiClient('', 'tok').listBenachrichtigungen();
    expect(calls[0].url).toBe('/api/v1/benachrichtigungen');
    expect(calls[0].opts?.method).toBe('GET');
    expect((calls[0].opts?.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(result.benachrichtigungen).toHaveLength(1);
  });

  it('markiereBenachrichtigungGelesen POSTet auf /benachrichtigungen/:id/gelesen', async () => {
    const calls: { url: string; opts?: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, opts?: RequestInit) => {
        calls.push({ url: String(url), opts });
        return { ok: true, json: async () => ({ ok: true }) } as unknown as Response;
      }),
    );
    await new ApiClient('', 'tok').markiereBenachrichtigungGelesen('z1');
    expect(calls[0].url).toBe('/api/v1/benachrichtigungen/z1/gelesen');
    expect(calls[0].opts?.method).toBe('POST');
    expect((calls[0].opts?.headers as Record<string, string>).authorization).toBe('Bearer tok');
  });

  it('markiereAlleBenachrichtigungenGelesen POSTet auf /benachrichtigungen/alle-gelesen', async () => {
    const calls: { url: string; opts?: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, opts?: RequestInit) => {
        calls.push({ url: String(url), opts });
        return { ok: true, json: async () => ({ ok: true }) } as unknown as Response;
      }),
    );
    await new ApiClient('', 'tok').markiereAlleBenachrichtigungenGelesen();
    expect(calls[0].url).toBe('/api/v1/benachrichtigungen/alle-gelesen');
    expect(calls[0].opts?.method).toBe('POST');
  });

  it('eine Antwort mit Status 404 (fremde/unbekannte Zeile) führt zu einem ApiError mit Meldung', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({ error: 'Benachrichtigung nicht gefunden' }),
      }),
    );
    await expect(new ApiClient('', 'tok').markiereBenachrichtigungGelesen('fremd')).rejects.toThrow(
      'Benachrichtigung nicht gefunden',
    );
  });
});

describe('ApiClient Mandatsvorlagen (TMPL-01, 13-07 Task 1)', () => {
  it('listVorlagen ruft GET /vorlagen mit Bearer-Header', async () => {
    const calls: { url: string; opts?: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, opts?: RequestInit) => {
        calls.push({ url: String(url), opts });
        return {
          ok: true,
          json: async () => ({ vorlagen: [{ id: 'kuendigungsschutz', name: 'Kündigungsschutz', beschreibung: 'x', zonen: ['Fristen'], hinweise: ['h'] }] }),
        } as unknown as Response;
      }),
    );
    const result = await new ApiClient('', 'tok').listVorlagen();
    expect(calls[0].url).toBe('/api/v1/vorlagen');
    expect(calls[0].opts?.method).toBe('GET');
    expect((calls[0].opts?.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(result).toEqual([{ id: 'kuendigungsschutz', name: 'Kündigungsschutz', beschreibung: 'x', zonen: ['Fristen'], hinweise: ['h'] }]);
  });

  it('createDesk übergibt das optionale vorlageId-Feld im Body', async () => {
    const calls: { url: string; opts?: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, opts?: RequestInit) => {
        calls.push({ url: String(url), opts });
        return { ok: true, json: async () => ({ id: 'd1', name: 'Mandat', ownerId: 'u1' }) } as unknown as Response;
      }),
    );
    await new ApiClient('', 'tok').createDesk('Mandat', 'kuendigungsschutz');
    expect(calls[0].url).toBe('/api/v1/desks');
    expect(calls[0].opts?.method).toBe('POST');
    expect(JSON.parse(String(calls[0].opts?.body))).toEqual({ name: 'Mandat', vorlageId: 'kuendigungsschutz' });
  });

  it('createDesk ohne vorlageId sendet weiterhin nur den Namen (Rückwärts-Kompatibilität)', async () => {
    const calls: { url: string; opts?: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, opts?: RequestInit) => {
        calls.push({ url: String(url), opts });
        return { ok: true, json: async () => ({ id: 'd1', name: 'Mandat', ownerId: 'u1' }) } as unknown as Response;
      }),
    );
    await new ApiClient('', 'tok').createDesk('Mandat');
    expect(JSON.parse(String(calls[0].opts?.body))).toEqual({ name: 'Mandat' });
  });
});
