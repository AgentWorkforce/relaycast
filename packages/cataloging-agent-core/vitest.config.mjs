import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const packageDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(packageDir, "../..");

export default defineConfig({
  root: repoRoot,
  resolve: {
    alias: {
      "cloudflare:workers": resolve(packageDir, "src/test-shims/cloudflare-workers.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["packages/cataloging-agent-core/src/**/*.test.ts"],
    globals: true,
  },
});
