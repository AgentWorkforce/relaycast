#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const packageDir = join(process.cwd(), "nango-integrations");
const requiredModules = [
  "nango",
  "vitest",
  "zod",
  join("@notionhq", "client"),
];

const hasRequiredModules = requiredModules.every((modulePath) =>
  existsSync(join(packageDir, "node_modules", modulePath)),
);

if (hasRequiredModules) {
  process.exit(0);
}

const result = spawnSync("npm", ["ci", "--prefix", packageDir], {
  stdio: "inherit",
});

process.exit(result.status ?? 1);
