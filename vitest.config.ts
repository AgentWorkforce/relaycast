import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(rootDir, "packages/web"),
      "server-only": path.resolve(rootDir, "tests/helpers/empty-module.ts"),
    },
  },
  test: {
    environment: "node",
    globals: true,
    passWithNoTests: true,
    testTimeout: 30_000,
    exclude: [
      "**/node_modules/**",
      "**/.next/**",
      "**/.open-next/**",
      "**/.open-next-cf/**",
      "**/.claude/**",
      "**/.agent-relay/**",
      // Sibling packages/services own their own vitest config or node:test
      // harness and run in dedicated CI steps (see the per-package
      // `--config <pkg>/vitest.config.ts` and `node --test` invocations in
      // package.json). A bare root `vitest run` must not sweep them: they need
      // runtimes the root node-env config does not provide (e.g.
      // services/agent-gateway imports `cloudflare:workers`, packages/acceptance
      // requires a live ACCEPTANCE_BASE_URL, packages/core tests are node:test).
      "services/**",
      // dev-stack/local-sandbox-runner owns its own vitest.config.ts and
      // devDependencies (supertest, dockerode); it runs via its own scoped
      // invocation, not this bare root sweep.
      "dev-stack/**",
      "packages/acceptance/**",
      "packages/webhook-worker/**",
      "packages/relayfile/**",
      "packages/platform/**",
      "packages/credential-proxy/**",
      "packages/cataloging-agent-core/**",
      "packages/core/**",
      "nango-integrations/**",
      "packages/relayauth/src/**",
      // Pre-existing tests that are NOT part of CI's curated test strategy
      // (none are referenced by any `*:test` script in package.json nor live
      // under `packages/web/test/handlers`, the only directory CI sweeps). They
      // require harnesses a bare node-env `vitest run` does not provide:
      // integration/e2e build artifacts (orchestrator-lib.tar.gz), live env
      // vars (NEXT_PUBLIC_APP_URL), or module mocks/provider-list fixtures that
      // have drifted from the production exports they stub. Running them in a
      // bare repo-wide sweep produces false failures unrelated to any change;
      // they are exercised — when exercised — via their own scoped invocations.
      "packages/web/app/api/v1/workspaces/[workspaceId]/workflows/run/route.integration.test.ts",
      "tests/agent-workspace-golden-path-routes.test.ts",
      "tests/github-clone-incremental-executor.test.ts",
      "tests/integrations-providers.test.ts",
      "tests/nango-sync-relayfile.test.ts",
      "tests/nango-webhook-router-incremental-sync.test.ts",
      "tests/proactive-runtime/vitest/deploy-manager.integration.test.ts",
      "tests/sdk-setup-client-routes.test.ts",
      "tests/unified-workspace.test.ts",
      "tests/workspaces-enumerate-route.test.ts",
    ],
  },
});
