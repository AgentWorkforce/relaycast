#!/usr/bin/env node
/**
 * `predev` hook: auto-apply Drizzle migrations to the LOCAL dev database before
 * `next dev` starts, so a freshly pulled branch's new tables exist without a
 * manual `db:migrate` step.
 *
 * Safety: this only ever runs against a local Postgres (localhost / 127.0.0.1).
 * If DATABASE_URL is unset or points anywhere remote (e.g. a Neon endpoint), it
 * skips entirely — it must never auto-mutate a deployed database. The deployed
 * Lambda/Worker never run `next dev`, so this path is local-only by design.
 *
 * It loads packages/web/.env.local itself because npm runs `predev` as its own
 * process before Next loads the env files.
 */
const { spawnSync } = require("node:child_process");
const { existsSync, readFileSync } = require("node:fs");
const path = require("node:path");

const defaultWebRoot = path.resolve(__dirname, "..");
const defaultRepoRoot = path.resolve(defaultWebRoot, "..", "..");

function loadEnvLocal(webRoot, env) {
  const envPath = path.join(webRoot, ".env.local");
  if (!existsSync(envPath)) return;
  for (const rawLine of readFileSync(envPath, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // .env.local is the source of truth for local dev; let it win.
    env[key] = value;
  }
}

function isLocalConnectionString(connectionString) {
  try {
    const { hostname } = new URL(connectionString);
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "[::1]"
    );
  } catch {
    return false;
  }
}

function runDevMigrate(options = {}) {
  const webRoot = options.webRoot ?? defaultWebRoot;
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  const env = options.env ?? process.env;
  const stdio = options.stdio ?? "inherit";

  loadEnvLocal(webRoot, env);

  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    console.log("[dev-migrate] DATABASE_URL not set - skipping auto-migrate.");
    return 0;
  }
  if (!isLocalConnectionString(databaseUrl)) {
    console.log(
      "[dev-migrate] DATABASE_URL is not local (localhost/127.0.0.1) - skipping auto-migrate for safety.",
    );
    return 0;
  }

  const drizzleBin = path.join(
    repoRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "drizzle-kit.cmd" : "drizzle-kit",
  );
  if (!existsSync(drizzleBin)) {
    console.log("[dev-migrate] drizzle-kit not found - skipping auto-migrate.");
    return 0;
  }

  console.log("[dev-migrate] applying migrations to local database...");
  const result = spawnSync(
    drizzleBin,
    ["migrate", "--config", "drizzle.config.ts"],
    { cwd: repoRoot, stdio, env },
  );

  if (result.status !== 0) {
    console.error("[dev-migrate] migration failed - aborting `next dev`.");
    return result.status ?? 1;
  }
  console.log("[dev-migrate] migrations up to date.");
  return 0;
}

if (require.main === module) {
  process.exit(runDevMigrate());
}

module.exports = {
  isLocalConnectionString,
  runDevMigrate,
};
