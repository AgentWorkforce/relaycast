import { defineConfig } from 'vitest/config';

// PostgreSQL conformance mode (`npm run test:conformance:pg`): the conformance
// suite against a real PostgreSQL fixture through the verified runtime handle.
// Requires RELAYCAST_TEST_DATABASE_URL, RELAYCAST_TEST_DATABASE_OWNER_URL and
// RELAYCAST_TEST_DATABASE_CA_FILE (see src/__tests__/setup/conformancePgEnv.ts);
// fails without them. One shared schema, so files run one at a time.
export default defineConfig({
  test: {
    include: ['src/__tests__/conformance/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['src/__tests__/setup/conformancePgGlobal.ts'],
    setupFiles: ['src/__tests__/setup/conformancePg.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
