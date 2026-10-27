import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Under the Bun runtime (`npm run test:bun`), run the suite against bun:sqlite —
// the driver the standalone binary ships — instead of the better-sqlite3 addon.
const isBun = typeof process.versions.bun === 'string';
const standalone = (path: string) => fileURLToPath(new URL(`./standalone/${path}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: isBun
      ? [
          { find: /^\.\/sqlite-driver\.js$/, replacement: standalone('sqlite-driver.ts') },
          { find: /^better-sqlite3$/, replacement: standalone('test-shims/better-sqlite3.ts') },
          { find: /^drizzle-orm\/better-sqlite3$/, replacement: standalone('test-shims/drizzle-better-sqlite3.ts') },
        ]
      : [],
  },
  test: {
    include: ['src/**/*.test.ts'],
    // These spawn the repo's Node maintenance scripts (better-sqlite3) as child
    // processes; they are not part of the standalone binary.
    exclude: isBun
      ? ['src/__tests__/conformance/agentRetentionCli.test.ts', 'src/db/__tests__/compactMigrations.test.ts']
      : [],
    environment: 'node',
    // vitest's module runner is slower under Bun; the heavier conformance
    // fixtures need more headroom there.
    testTimeout: isBun ? 60_000 : 20_000,
    hookTimeout: isBun ? 60_000 : 20_000,
    // zod's `export { z }` namespace re-export resolves to undefined through
    // vitest's externalized import path under Bun; inlining it avoids that.
    server: { deps: { inline: isBun ? ['zod'] : [] } },
  },
});
