import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const directory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": path.join(
        directory,
        "tests/support/cloudflare-workers-shim.ts",
      ),
    },
  },
  test: {
    environment: "node",
    exclude: [
      "**/node_modules/**",
      "**/.claude/**",
    ],
  },
});
