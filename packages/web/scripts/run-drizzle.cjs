#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const path = require("node:path");

const [, , command, ...forwardedArgs] = process.argv;
const repoRoot = path.resolve(__dirname, "..", "..", "..");

if (!command || !["generate", "migrate", "studio"].includes(command)) {
  console.error("Usage: node scripts/run-drizzle.cjs <generate|migrate|studio> [sst flags]");
  process.exit(1);
}

const sstFlags = [];
const drizzleArgs = [];

for (let i = 0; i < forwardedArgs.length; i += 1) {
  const arg = forwardedArgs[i];

  if (arg === "--stage" || arg === "--config" || arg === "--target") {
    sstFlags.push(arg);
    if (i + 1 < forwardedArgs.length) {
      sstFlags.push(forwardedArgs[i + 1]);
      i += 1;
    }
    continue;
  }

  if (
    arg === "--print-logs" ||
    arg === "--verbose" ||
    arg === "--help"
  ) {
    sstFlags.push(arg);
    continue;
  }

  drizzleArgs.push(arg);
}

function resolveBin(name) {
  const executable = process.platform === "win32" ? `${name}.cmd` : name;
  const candidates = [
    path.resolve(__dirname, "..", "node_modules", ".bin", executable),
    path.resolve(__dirname, "..", "..", "..", "node_modules", ".bin", executable),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Unable to find ${name} binary in workspace or repo root node_modules/.bin`);
}

const sstBin = resolveBin("sst");
const drizzleBin = resolveBin("drizzle-kit");

const child = spawnSync(
  sstBin,
  [
    "shell",
    ...sstFlags,
    "--",
    drizzleBin,
    command,
    "--config",
    "drizzle.config.ts",
    ...drizzleArgs,
  ],
  {
    cwd: repoRoot,
    stdio: "inherit",
  },
);

if (child.error) {
  console.error(child.error);
  process.exit(1);
}

process.exit(child.status ?? 1);
