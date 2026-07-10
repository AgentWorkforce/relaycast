import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    // The integration suite runs in workerd via vitest.integration.config.ts
    // (it imports `cloudflare:test`); keep it out of the default node run.
    exclude: [...configDefaults.exclude, 'test/integration/**'],
  },
});

