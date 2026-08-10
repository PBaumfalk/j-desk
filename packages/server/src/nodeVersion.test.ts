import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Wächtertest gegen die Node-Versionsdrift (OPS-01, D-A): die Zielversion **Node 22** ist an vier
 * Stellen verankert — `engines.node` in der Root-`package.json`, `.nvmrc`, `.node-version` und das
 * Basisimage in `packages/server/Dockerfile`. Der Entwicklungs-Workaround `fnm exec --using=20`
 * (STATE.md-Blocker „Node-Versionsdrift") entstand genau daraus, dass diese vier Stellen nie
 * miteinander abgeglichen waren. Dieser Test bricht, sobald eine der vier wieder ausschert —
 * statt die Drift erst beim nächsten `npm ci`-Fehlschlag eines Betreibers zu bemerken
 * (14-RESEARCH.md Pitfall 1: die aktuelle 20/22/24-Kompatibilität des better-sqlite3-Binaries ist
 * zufällig, nicht garantiert).
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function leseDatei(pfad: string, bezeichner: string): string {
  if (!existsSync(pfad)) {
    throw new Error(`Node-Versions-Wächter: ${bezeichner} fehlt (erwartet unter ${pfad})`);
  }
  return readFileSync(pfad, 'utf8');
}

function hauptversion(bezeichner: string, wert: string): number {
  const treffer = wert.match(/(\d+)/);
  if (!treffer) {
    throw new Error(`Node-Versions-Wächter: ${bezeichner} enthält keine Hauptversionsnummer ("${wert}")`);
  }
  return Number(treffer[1]);
}

describe('Node-Zielversion (OPS-01, D-A) — Drift-Wächter', () => {
  it('engines.node, .nvmrc, .node-version und das Dockerfile-Basisimage bezeichnen dieselbe Hauptversion', () => {
    const pkgRoh = leseDatei(join(REPO_ROOT, 'package.json'), 'Root-package.json');
    const pkg = JSON.parse(pkgRoh) as { engines?: { node?: string } };
    if (!pkg.engines?.node) {
      throw new Error('Node-Versions-Wächter: Root-package.json — Feld "engines.node" fehlt');
    }
    const ausEngines = hauptversion('package.json engines.node', pkg.engines.node);

    const ausNvmrc = hauptversion('.nvmrc', leseDatei(join(REPO_ROOT, '.nvmrc'), '.nvmrc').trim());
    const ausNodeVersion = hauptversion(
      '.node-version',
      leseDatei(join(REPO_ROOT, '.node-version'), '.node-version').trim(),
    );

    const dockerfile = leseDatei(join(REPO_ROOT, 'packages/server/Dockerfile'), 'packages/server/Dockerfile');
    const fromZeile = dockerfile.match(/^FROM node:(\d+)/m);
    if (!fromZeile) {
      throw new Error('Node-Versions-Wächter: packages/server/Dockerfile — keine "FROM node:<Version>"-Zeile gefunden');
    }
    const ausDockerfile = Number(fromZeile[1]);

    // Vier Stellen, eine Hauptversion — driftet eine, kehrt genau der Zustand zurück, den dieser
    // Plan beendet (STATE.md-Blocker „Node-Versionsdrift").
    expect(ausNvmrc).toBe(ausEngines);
    expect(ausNodeVersion).toBe(ausEngines);
    expect(ausDockerfile).toBe(ausEngines);
  });
});
