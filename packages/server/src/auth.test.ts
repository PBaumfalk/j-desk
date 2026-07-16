import { describe, it, expect } from 'vitest';
import { openDb } from './db';
import { needsSetup, createUser, login, validateToken, logout, AuthError } from './auth';

describe('Auth', () => {
  it('needsSetup ist true ohne Benutzer und false danach', async () => {
    const db = openDb(':memory:');
    expect(needsSetup(db)).toBe(true);
    await createUser(db, 'patrick', 'geheim-genug');
    expect(needsSetup(db)).toBe(false);
  });

  it('lehnt leeren Namen und kurze Passwörter ab', async () => {
    const db = openDb(':memory:');
    await expect(createUser(db, '  ', 'geheim-genug')).rejects.toThrow(AuthError);
    await expect(createUser(db, 'patrick', 'kurz')).rejects.toThrow(AuthError);
  });

  it('Login liefert Token bei richtigem, null bei falschem Passwort', async () => {
    const db = openDb(':memory:');
    await createUser(db, 'patrick', 'geheim-genug');
    expect(await login(db, 'patrick', 'falsch-falsch')).toBeNull();
    expect(await login(db, 'unbekannt', 'geheim-genug')).toBeNull();
    const token = await login(db, 'patrick', 'geheim-genug');
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('validateToken erkennt gültige Tokens und aktualisiert last_used_at', async () => {
    const db = openDb(':memory:');
    await createUser(db, 'patrick', 'geheim-genug');
    const token = (await login(db, 'patrick', 'geheim-genug'))!;
    const before = db.prepare('SELECT last_used_at FROM sessions WHERE token = ?').get(token) as { last_used_at: number };
    db.prepare('UPDATE sessions SET last_used_at = ? WHERE token = ?').run(before.last_used_at - 1000, token);
    expect(validateToken(db, token)).toEqual({ userId: expect.any(String) });
    const after = db.prepare('SELECT last_used_at FROM sessions WHERE token = ?').get(token) as { last_used_at: number };
    expect(after.last_used_at).toBeGreaterThan(before.last_used_at - 1000);
    expect(validateToken(db, 'gibtsnicht')).toBeNull();
  });

  it('Sitzungen älter als 30 Tage Inaktivität verfallen', async () => {
    const db = openDb(':memory:');
    await createUser(db, 'patrick', 'geheim-genug');
    const token = (await login(db, 'patrick', 'geheim-genug'))!;
    const staleAge = 31 * 24 * 60 * 60 * 1000;
    db.prepare('UPDATE sessions SET last_used_at = ? WHERE token = ?').run(Date.now() - staleAge, token);
    expect(validateToken(db, token)).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 });
  });

  it('logout löscht die Sitzung', async () => {
    const db = openDb(':memory:');
    await createUser(db, 'patrick', 'geheim-genug');
    const token = (await login(db, 'patrick', 'geheim-genug'))!;
    logout(db, token);
    expect(validateToken(db, token)).toBeNull();
  });

  it('verweigert doppelten Benutzernamen', async () => {
    const db = openDb(':memory:');
    await createUser(db, 'patrick', 'geheim-genug');
    await expect(createUser(db, 'patrick', 'anderes-passwort')).rejects.toThrow(AuthError);
  });

  it('setzt das Admin-Flag, wenn isAdmin übergeben wird', async () => {
    const db = openDb(':memory:');
    await createUser(db, 'chef', 'geheim-genug', true);
    await createUser(db, 'normal', 'geheim-genug');
    expect((db.prepare("SELECT is_admin AS a FROM users WHERE username = 'chef'").get() as { a: number }).a).toBe(1);
    expect((db.prepare("SELECT is_admin AS a FROM users WHERE username = 'normal'").get() as { a: number }).a).toBe(0);
  });
});
