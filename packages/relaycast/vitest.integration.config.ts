import { fileURLToPath } from 'node:url';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// Integration suite: boots the real Cloudflare worker (engine + Durable Objects +
// D1 + KV + R2 + Queues) in workerd via @cloudflare/vitest-pool-workers and drives
// it over SELF.fetch. Kept separate from the default (node) vitest config so the
// fast unit tests don't pay the workerd startup cost.
export default defineConfig(async () => {
  const migrationsDir = fileURLToPath(new URL('./src/db/migrations', import.meta.url));
  const migrations = await readD1Migrations(migrationsDir);

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.test.toml' },
        miniflare: {
          // Surfaced to the apply-migrations setup file via cloudflare:test env.
          bindings: { TEST_MIGRATIONS: migrations },
        },
      }),
    ],
    test: {
      include: ['test/integration/**/*.test.ts'],
      setupFiles: ['./test/integration/apply-migrations.ts'],
      testTimeout: 30_000,
      hookTimeout: 30_000,
    },
  };
});
