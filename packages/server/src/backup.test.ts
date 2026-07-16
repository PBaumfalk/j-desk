import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rotateBackup } from './backup';

describe('rotateBackup', () => {
  it('tut nichts ohne DB-Datei', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dd-bak-'));
    rotateBackup(dir);
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it('legt Backups an und behält nur die letzten 5', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dd-bak-'));
    writeFileSync(join(dir, 'desktop.sqlite'), 'daten');
    for (let i = 0; i < 7; i++) {
      rotateBackup(dir);
      await new Promise((r) => setTimeout(r, 5)); // eindeutige Zeitstempel
    }
    const backups = readdirSync(join(dir, 'backup')).filter((f) => f.endsWith('.sqlite'));
    expect(backups).toHaveLength(5);
  });
});
