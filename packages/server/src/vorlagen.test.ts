import { describe, it, expect } from 'vitest';
import { createTestApp } from './testUtils';
import { MANDATS_VORLAGEN } from './vorlagen';

describe('GET /api/v1/vorlagen', () => {
  it('ohne Token: 401', async () => {
    const { app } = await createTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/vorlagen' });
    expect(res.statusCode).toBe(401);
  });

  it('liefert die drei kuratierten Vorlagen mit id, name, beschreibung und Inhalts-Aufzählung', async () => {
    const { app, authHeaders } = await createTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/vorlagen', headers: authHeaders });
    expect(res.statusCode).toBe(200);
    const { vorlagen } = res.json();
    expect(vorlagen).toHaveLength(3);
    expect(vorlagen.map((v: { id: string }) => v.id).sort()).toEqual(
      ['kuendigungsschutz', 'strafverfahren', 'vertragspruefung'].sort(),
    );
    const kuendigung = vorlagen.find((v: { id: string }) => v.id === 'kuendigungsschutz');
    expect(kuendigung).toMatchObject({
      id: 'kuendigungsschutz',
      name: 'Kündigungsschutz',
    });
    expect(typeof kuendigung.beschreibung).toBe('string');
    expect(kuendigung.beschreibung.length).toBeGreaterThan(0);
    expect(kuendigung.zonen).toEqual(
      MANDATS_VORLAGEN.find((v) => v.id === 'kuendigungsschutz')!.zonen.map((z) => z.name),
    );
    expect(kuendigung.hinweise).toEqual(
      MANDATS_VORLAGEN.find((v) => v.id === 'kuendigungsschutz')!.hinweise.map((h) => h.text),
    );
  });
});

describe('POST /api/v1/desks mit vorlageId (TMPL-01)', () => {
  it('liefert den Bestands-Antwortvertrag; State enthält Vorlagen-Zonen + Hinweis-Notizen mit Provenienz; Rolle + Journal', async () => {
    const { app, db, authHeaders, userId } = await createTestApp();
    const res = await app.inject({
      method: 'POST', url: '/api/v1/desks', headers: authHeaders,
      payload: { name: 'Mandat Müller', vorlageId: 'kuendigungsschutz' },
    });
    expect(res.statusCode).toBe(201);
    const desk = res.json();
    // Bestands-Antwortvertrag: id, name, ownerId — kein zusätzliches Feld verrät die Vorlagenherkunft.
    expect(desk).toMatchObject({ name: 'Mandat Müller', ownerId: userId });
    expect(typeof desk.id).toBe('string');

    const stateRes = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/state`, headers: authHeaders });
    const { state } = stateRes.json();
    const vorlage = MANDATS_VORLAGEN.find((v) => v.id === 'kuendigungsschutz')!;
    expect(state.zones).toHaveLength(vorlage.zonen.length);
    expect(state.zones.map((z: { name: string }) => z.name)).toEqual(vorlage.zonen.map((z) => z.name));
    for (const zone of state.zones) {
      expect(zone.createdBy).toBe('test');
      expect(zone.createdById).toBe(userId);
      expect(typeof zone.id).toBe('string');
    }
    const hinweisNotizen = state.notes.filter((n: { kind: string }) => n.kind === 'eigen');
    expect(hinweisNotizen).toHaveLength(vorlage.hinweise.length);
    expect(hinweisNotizen.map((n: { text: string }) => n.text)).toEqual(vorlage.hinweise.map((h) => h.text));
    for (const notiz of hinweisNotizen) {
      expect(notiz.createdBy).toBe('test');
      expect(notiz.createdById).toBe(userId);
    }

    // Eigentümer-Rolle in derselben Transaktion (T-02-06-Präzedenz).
    const rolle = db.prepare('SELECT rolle FROM desk_roles WHERE desk_id = ? AND user_id = ?').get(desk.id, userId) as
      | { rolle: string }
      | undefined;
    expect(rolle?.rolle).toBe('Eigentümer');

    // deskCreated-Journal (Transaktions-Integrität, T-13-07-01).
    const journalRes = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/journal`, headers: authHeaders });
    const { entries } = journalRes.json();
    const created = entries.find((e: { type: string }) => e.type === 'deskCreated');
    expect(created).toMatchObject({ type: 'deskCreated', actorName: 'test', rev: 0 });
  });

  it('unbekannte vorlageId: 400 mit deutschem Feldnamen, KEINE desks-Zeile geschrieben', async () => {
    const { app, db, authHeaders } = await createTestApp();
    const vorher = (db.prepare('SELECT COUNT(*) AS n FROM desks').get() as { n: number }).n;
    const res = await app.inject({
      method: 'POST', url: '/api/v1/desks', headers: authHeaders,
      payload: { name: 'X', vorlageId: 'gibtsnicht' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('vorlageId');
    const nachher = (db.prepare('SELECT COUNT(*) AS n FROM desks').get() as { n: number }).n;
    expect(nachher).toBe(vorher);
  });

  it('ohne vorlageId: Desk-State bleibt byte-identisch zum Bestandsweg (Rückwärts-Kompatibilität)', async () => {
    const { app, authHeaders } = await createTestApp();
    const mitVorlage = (await app.inject({
      method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'A' },
    })).json();
    const ohneVorlage = (await app.inject({
      method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'B', vorlageId: undefined },
    })).json();

    const stateA = (await app.inject({ method: 'GET', url: `/api/v1/desks/${mitVorlage.id}/state`, headers: authHeaders })).json().state;
    const stateB = (await app.inject({ method: 'GET', url: `/api/v1/desks/${ohneVorlage.id}/state`, headers: authHeaders })).json().state;
    expect(stateA).toEqual(stateB);
    expect(stateA.zones ?? []).toEqual([]);
  });

  it('zwei Anlagen aus derselben Vorlage erzeugen unterschiedliche Zonen-ids (kein geteilter Referenz-Unfall)', async () => {
    const { app, authHeaders } = await createTestApp();
    const deskEins = (await app.inject({
      method: 'POST', url: '/api/v1/desks', headers: authHeaders,
      payload: { name: 'Eins', vorlageId: 'strafverfahren' },
    })).json();
    const deskZwei = (await app.inject({
      method: 'POST', url: '/api/v1/desks', headers: authHeaders,
      payload: { name: 'Zwei', vorlageId: 'strafverfahren' },
    })).json();

    const stateEins = (await app.inject({ method: 'GET', url: `/api/v1/desks/${deskEins.id}/state`, headers: authHeaders })).json().state;
    const stateZwei = (await app.inject({ method: 'GET', url: `/api/v1/desks/${deskZwei.id}/state`, headers: authHeaders })).json().state;

    const idsEins = new Set(stateEins.zones.map((z: { id: string }) => z.id));
    const idsZwei = new Set(stateZwei.zones.map((z: { id: string }) => z.id));
    for (const id of idsZwei) expect(idsEins.has(id)).toBe(false);
  });
});
