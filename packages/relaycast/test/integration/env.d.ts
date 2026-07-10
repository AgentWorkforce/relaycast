import type { D1Migration } from '@cloudflare/vitest-pool-workers';

// Extra bindings the integration harness injects into the worker env via
// cloudflare:test (beyond what wrangler.test.toml declares).
declare module 'cloudflare:test' {
  interface ProvidedEnv {
    DB: D1Database;
    TEST_MIGRATIONS: D1Migration[];
  }
}
