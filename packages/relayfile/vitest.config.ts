import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const packageDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(packageDir, "../..");

export default defineConfig({
  root: repoRoot,
  resolve: {
    alias: [
      {
        find: /^@cloud\/core\/(.+)\.js$/,
        replacement: `${resolve(repoRoot, "packages/core/src")}/$1.ts`,
      },
    ],
  },
  test: {
    environment: "node",
    include: ["packages/relayfile/test/**/*.test.ts"],
    globals: true,
  },
});
