const assert = require("node:assert/strict");
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { isLocalConnectionString, runDevMigrate } = require("./dev-migrate.cjs");

test("isLocalConnectionString accepts local Postgres URLs with and without credentials", () => {
  assert.equal(isLocalConnectionString("postgres://localhost:5432/db"), true);
  assert.equal(isLocalConnectionString("postgresql://127.0.0.1/db"), true);
  assert.equal(isLocalConnectionString("postgres://user:pass@[::1]:5432/db"), true);
  assert.equal(isLocalConnectionString("postgres://user:pass@db.example.com:5432/db"), false);
  assert.equal(isLocalConnectionString("not a url"), false);
});

test("runDevMigrate executes drizzle migrate against a local fixture", () => {
  const root = mkdtempSync(path.join(tmpdir(), "dev-migrate-"));
  const webRoot = path.join(root, "packages", "web");
  const binDir = path.join(root, "node_modules", ".bin");
  mkdirSync(webRoot, { recursive: true });
  mkdirSync(binDir, { recursive: true });

  const markerPath = path.join(root, "drizzle-invocation.json");
  const drizzleBin = path.join(
    binDir,
    process.platform === "win32" ? "drizzle-kit.cmd" : "drizzle-kit",
  );
  writeFileSync(
    drizzleBin,
    [
      "#!/usr/bin/env node",
      "const { writeFileSync } = require('node:fs');",
      `writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify({`,
      "  argv: process.argv.slice(2),",
      "  cwd: process.cwd(),",
      "  databaseUrl: process.env.DATABASE_URL,",
      "}));",
    ].join("\n"),
    { mode: 0o755 },
  );

  const env = { DATABASE_URL: "postgres://localhost:5432/cloud_dev" };
  const status = runDevMigrate({ webRoot, repoRoot: root, env, stdio: "pipe" });
  const invocation = JSON.parse(readFileSync(markerPath, "utf8"));

  assert.equal(status, 0);
  assert.deepEqual(invocation.argv, ["migrate", "--config", "drizzle.config.ts"]);
  assert.equal(invocation.cwd, root);
  assert.equal(invocation.databaseUrl, "postgres://localhost:5432/cloud_dev");
});
