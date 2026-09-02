// Unit tests run under vitest (already the right runner here: the repo is
// ESM + `.ts` extension imports, which vitest resolves the same way tsx does).
//
// Tests live NEXT TO the code they cover as `<file>.test.ts`, so a module and
// its tests move together. Scope is pure logic — pricing, stat aggregation,
// noise, mapgen invariants. Anything needing a live world, a socket, or an LLM
// belongs in the harnesses under tools/ (npm run test:gen), not here.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['{client,forge,pipeline,server,shared,tools}/**/*.test.ts'],
    // Content and generated output, not source.
    exclude: ['**/node_modules/**', 'archive/**', 'forge/out/**', 'world/**'],
    environment: 'node',
  },
});
