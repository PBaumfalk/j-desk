import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { openDb, instanceId } from './db';
import { createDesk, putDeskState } from './deskStore';
import { storeFile } from './files';
import { buildPackage, readPackage, PaketFehler, JDESK_FORMAT_VERSION } from './jdesk';

const pdf = Buffer.from('%PDF-1.4\ninhalt');

function aufbau() {
  const db = openDb(':memory:');
  db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)').run('u1', 'p', 'h', 0);
  const dataDir = mkdtempSync(join(tmpdir(), 'dd-jdesk-'));
  const desk = createDesk(db, 'u1', 'Mandat Meier');
  return { db, dataDir, deskId: desk.id };
}

describe('buildPackage', () => {
  it('schreibt Manifest und Zustand, im jl-Modus ohne Dateien', () => {
    const { db, dataDir, deskId } = aufbau();
    const paket = buildPackage(db, dataDir, deskId, { createdBy: 'anwalt', jlawyer: true });
    const eintraege = unzipSync(new Uint8Array(paket));
    expect(Object.keys(eintraege).sort()).toEqual(['manifest.json', 'workspace.json']);
    const manifest = JSON.parse(strFromU8(eintraege['manifest.json']));
    expect(manifest).toMatchObject({
      format: 'jdesk', formatVersion: JDESK_FORMAT_VERSION, mode: 'linked', createdBy: 'anwalt',
    });
    expect(manifest.source).toMatchObject({ kind: 'jlawyer', deskName: 'Mandat Meier' });
    expect(manifest.instanceId).toBe(instanceId(db));
  });

  it('legt im Eigenständig-Modus die Originalbytes bei', () => {
    const { db, dataDir, deskId } = aufbau();
    const meta = storeFile(db, dataDir, pdf, 'Akte.pdf');
    putDeskState(db, deskId, {
      docs: [{ id: 'd1', fileId: meta.id, name: 'Akte.pdf', position: { x: 0, y: 0 }, rotation: 0, zIndex: 1 }],
      links: [], stacks: [],
    });
    const eintraege = unzipSync(new Uint8Array(buildPackage(db, dataDir, deskId, { createdBy: 'a', jlawyer: false })));
    expect(Object.keys(eintraege)).toContain(`files/${meta.id}`);
    expect(Buffer.from(eintraege[`files/${meta.id}`])).toEqual(pdf);
    const dateien = JSON.parse(strFromU8(eintraege['files.json']));
    expect(dateien[meta.id]).toMatchObject({ name: 'Akte.pdf', sha256: meta.sha256, kind: 'pdf' });
  });

  it('entfernt Schwärzungs-Snapshots', () => {
    const { db, dataDir, deskId } = aufbau();
    putDeskState(db, deskId, {
      docs: [{ id: 'd1', fileId: 'f1', name: 'A.pdf', position: { x: 0, y: 0 }, rotation: 0, zIndex: 1 }],
      links: [], stacks: [],
      marks: [{ id: 'm1', docId: 'd1', page: 1, rect: { x: 1, y: 1, w: 5, h: 5 }, kind: 'redact', textSnapshot: 'geheim' }],
    });
    const paket = buildPackage(db, dataDir, deskId, { createdBy: 'a', jlawyer: true });
    // Bewusst NICHT im Roh-ZIP nach 'geheim' suchen: der Inhalt ist deflate-komprimiert,
    // die Zeichenkette tauchte dort auch dann nicht auf, wenn sie noch drin wäre.
    const eintraege = unzipSync(new Uint8Array(paket));
    const zustand = JSON.parse(strFromU8(eintraege['workspace.json']));
    expect(zustand.marks[0].textSnapshot).toBeUndefined();
    expect(zustand.marks[0].rect).toEqual({ x: 1, y: 1, w: 5, h: 5 });
  });
});

describe('readPackage', () => {
  it('liest zurück, was buildPackage geschrieben hat', () => {
    const { db, dataDir, deskId } = aufbau();
    const meta = storeFile(db, dataDir, pdf, 'Akte.pdf');
    putDeskState(db, deskId, {
      docs: [{ id: 'd1', fileId: meta.id, name: 'Akte.pdf', position: { x: 0, y: 0 }, rotation: 0, zIndex: 1 }],
      links: [], stacks: [],
    });
    const gelesen = readPackage(buildPackage(db, dataDir, deskId, { createdBy: 'a', jlawyer: false }));
    expect(gelesen.state.docs[0].fileId).toBe(meta.id);
    expect(gelesen.files.get(meta.id)!.bytes).toEqual(pdf);
    expect(gelesen.files.get(meta.id)!.name).toBe('Akte.pdf');
  });

  it('weist Nicht-ZIPs ab', () => {
    expect(() => readPackage(Buffer.from('kein zip'))).toThrow(PaketFehler);
  });

  it('weist eine zu neue Formatversion ab', () => {
    const { db, dataDir, deskId } = aufbau();
    const eintraege = unzipSync(new Uint8Array(buildPackage(db, dataDir, deskId, { createdBy: 'a', jlawyer: true })));
    const manifest = { ...JSON.parse(strFromU8(eintraege['manifest.json'])), formatVersion: 99 };
    const kaputt = Buffer.from(zipSync({
      'manifest.json': strToU8(JSON.stringify(manifest)),
      'workspace.json': eintraege['workspace.json'],
    }));
    expect(() => readPackage(kaputt)).toThrow(/neueren J-DESK-Fassung/);
  });

  it('weist einen Zustand mit kaputter Verknüpfung ab', () => {
    const manifest = { format: 'jdesk', formatVersion: 1, mode: 'linked' };
    const zustand = {
      docs: [{ id: 'd1', fileId: 'f1', name: 'A.pdf', position: { x: 0, y: 0 }, rotation: 0, zIndex: 1 }],
      links: [{ id: 'l1', fromId: 'd1', toId: 'weg', note: '' }], stacks: [],
    };
    const paket = Buffer.from(zipSync({
      'manifest.json': strToU8(JSON.stringify(manifest)),
      'workspace.json': strToU8(JSON.stringify(zustand)),
    }));
    expect(() => readPackage(paket)).toThrow(/Verknüpfung/);
  });

  const gueltigesManifest = { format: 'jdesk', formatVersion: 1, mode: 'linked' };
  const leererZustand = { docs: [], links: [], stacks: [] };

  it('weist ein Paket mit syntaktisch kaputter files.json ab', () => {
    const paket = Buffer.from(zipSync({
      'manifest.json': strToU8(JSON.stringify(gueltigesManifest)),
      'workspace.json': strToU8(JSON.stringify(leererZustand)),
      'files.json': strToU8('{ kaputt'),
    }));
    expect(() => readPackage(paket)).toThrow(PaketFehler);
  });

  it('weist ein Paket ab, dessen files.json nur das Literal null enthält', () => {
    const paket = Buffer.from(zipSync({
      'manifest.json': strToU8(JSON.stringify(gueltigesManifest)),
      'workspace.json': strToU8(JSON.stringify(leererZustand)),
      'files.json': strToU8('null'),
      'files/f1': pdf,
    }));
    expect(() => readPackage(paket)).toThrow(PaketFehler);
  });

  it('weist ein Paket ab, dessen manifest.json nur das Literal null enthält', () => {
    const paket = Buffer.from(zipSync({
      'manifest.json': strToU8('null'),
      'workspace.json': strToU8(JSON.stringify(leererZustand)),
    }));
    expect(() => readPackage(paket)).toThrow(PaketFehler);
  });

  it('weist ein Manifest ohne source ab', () => {
    const paket = Buffer.from(zipSync({
      'manifest.json': strToU8(JSON.stringify(gueltigesManifest)),
      'workspace.json': strToU8(JSON.stringify(leererZustand)),
    }));
    expect(() => readPackage(paket)).toThrow(PaketFehler);
    expect(() => readPackage(paket)).toThrow(/source/);
  });

  it('weist ein Manifest ab, dessen source ein Skalar oder ein Array statt eines echten Objekts ist', () => {
    const skalar = Buffer.from(zipSync({
      'manifest.json': strToU8(JSON.stringify({ ...gueltigesManifest, source: 'jlawyer' })),
      'workspace.json': strToU8(JSON.stringify(leererZustand)),
    }));
    const array = Buffer.from(zipSync({
      'manifest.json': strToU8(JSON.stringify({ ...gueltigesManifest, source: ['jlawyer'] })),
      'workspace.json': strToU8(JSON.stringify(leererZustand)),
    }));
    expect(() => readPackage(skalar)).toThrow(PaketFehler);
    expect(() => readPackage(array)).toThrow(PaketFehler);
  });

  it('weist eine source vom kind "jlawyer" ohne caseId ab', () => {
    const paket = Buffer.from(zipSync({
      'manifest.json': strToU8(JSON.stringify({
        ...gueltigesManifest, source: { kind: 'jlawyer', deskName: 'Akte ohne caseId' },
      })),
      'workspace.json': strToU8(JSON.stringify(leererZustand)),
    }));
    expect(() => readPackage(paket)).toThrow(PaketFehler);
    expect(() => readPackage(paket)).toThrow(/caseId/);
  });

  const manifestMitStandaloneSource = {
    ...gueltigesManifest, mode: 'self-contained', source: { kind: 'standalone', deskName: 'Test' },
  };

  it('überspringt einen Verzeichniseintrag im ZIP (files/) und liefert die übrige Datei unversehrt', () => {
    const zustandMitDatei = {
      docs: [{ id: 'd1', fileId: 'fileA', name: 'A.pdf', position: { x: 0, y: 0 }, rotation: 0, zIndex: 1 }],
      links: [], stacks: [],
    };
    const paket = Buffer.from(zipSync({
      'manifest.json': strToU8(JSON.stringify(manifestMitStandaloneSource)),
      'workspace.json': strToU8(JSON.stringify(zustandMitDatei)),
      'files.json': strToU8(JSON.stringify({ fileA: { name: 'A.pdf' } })),
      // Echter Verzeichniseintrag, wie ihn ein extern neu gepacktes ZIP mitliefert.
      'files/': new Uint8Array(0),
      'files/fileA': pdf,
    }));
    const gelesen = readPackage(paket);
    expect(gelesen.files.size).toBe(1);
    expect(gelesen.files.get('fileA')!.bytes).toEqual(pdf);
    expect(gelesen.files.get('fileA')!.name).toBe('A.pdf');
  });

  it('weist ein Paket mit files/-Einträgen ohne files.json ab', () => {
    const zustandMitDatei = {
      docs: [{ id: 'd1', fileId: 'fileA', name: 'A.pdf', position: { x: 0, y: 0 }, rotation: 0, zIndex: 1 }],
      links: [], stacks: [],
    };
    const paket = Buffer.from(zipSync({
      'manifest.json': strToU8(JSON.stringify(manifestMitStandaloneSource)),
      'workspace.json': strToU8(JSON.stringify(zustandMitDatei)),
      // Bewusst keine files.json, obwohl Dateibytes im Paket liegen.
      'files/fileA': pdf,
    }));
    expect(() => readPackage(paket)).toThrow(PaketFehler);
    expect(() => readPackage(paket)).toThrow(/Dateiliste/);
  });

  it('weist ein Manifest mit fehlender formatVersion mit einer Beschädigt-Meldung ab (nicht "neuere Fassung")', () => {
    const manifestOhneFormatVersion = { format: 'jdesk', mode: 'linked' };
    const paket = Buffer.from(zipSync({
      'manifest.json': strToU8(JSON.stringify(manifestOhneFormatVersion)),
      'workspace.json': strToU8(JSON.stringify(leererZustand)),
    }));
    expect(() => readPackage(paket)).toThrow(PaketFehler);
    expect(() => readPackage(paket)).toThrow(/beschädigt/);
    expect(() => readPackage(paket)).not.toThrow(/neueren J-DESK-Fassung/);
  });
});
