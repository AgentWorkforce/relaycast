import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: rootDir,
  test: {
    environment: "node",
    globals: true,
    fileParallelism: false,
    passWithNoTests: true,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    globalSetup: path.resolve(rootDir, "globalSetup.ts"),
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**"],
  },
});
