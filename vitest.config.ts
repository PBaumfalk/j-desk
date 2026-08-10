import { defineConfig } from 'vitest/config';
import { sveltekit } from '@sveltejs/kit/vite';

export default defineConfig({
  plugins: [sveltekit()],
  test: {
    // 'packages/*/test/**' (Phase 12, Pitfall 9): die ki-eval-Suiten aus Plan 12-09 liegen
    // außerhalb der src-Bäume und müssen in jedem Standard-Lauf mitlaufen (Release-Blocker).
    include: ['src/**/*.test.ts', 'packages/*/src/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
    environment: 'node',
    env: {
      // SAFE-06/D-13: die opportunistische .jdesk-Automatiksicherung nutzt denselben
      // Erfolgspfad wie GET /api/v1/cases/:id/desk. Ohne diese Abschaltung würde jeder
      // erste erfolgreiche Abgleich in JEDEM Testfall (auch in unabhängigen Suiten wie
      // jlawyer.test.ts) einen echten, unbeobachteten Hintergrund-Upload in die (Fake-)
      // Akte auslösen — ein Nebenläufigkeits-Zeitfenster, das mit Testannahmen über exakte
      // Dokumentzahlen/-reihenfolgen kollidiert. `0` ist der bereits vorgesehene
      // Abschalt-Wert (kein Sondermechanismus); packages/server/src/autoArchive.test.ts
      // testet das Verhalten dediziert über den expliziten intervallStunden-Parameter,
      // unabhängig von diesem Default.
      JDESK_ARCHIVE_INTERVAL_HOURS: '0',
    },
  },
});
