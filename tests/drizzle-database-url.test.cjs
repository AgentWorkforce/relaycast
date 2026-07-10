const assert = require("node:assert/strict");
const test = require("node:test");

const {
  loadDatabaseUrl,
  resolveDrizzleDatabaseUrl,
  toDirectEndpoint,
} = require("../packages/web/scripts/drizzle-database-url.cjs");

const pooled =
  "postgres://user:pw@ep-red-tree-123-pooler.us-east-1.aws.neon.tech/db?sslmode=require";
const direct =
  "postgres://user:pw@ep-red-tree-123.us-east-1.aws.neon.tech/db?sslmode=require";

test("resolveDrizzleDatabaseUrl prefers DATABASE_URL and converts pooled Neon URLs to direct endpoints", () => {
  assert.equal(
    resolveDrizzleDatabaseUrl({
      DATABASE_URL: pooled,
      NEON_DATABASE_URL: "postgres://other@ignored/db",
    }),
    direct,
  );
});

test("resolveDrizzleDatabaseUrl reads NEON_DATABASE_URL before SST_RESOURCE_NeonDatabaseUrl", () => {
  assert.equal(
    resolveDrizzleDatabaseUrl({
      NEON_DATABASE_URL: pooled,
      SST_RESOURCE_NeonDatabaseUrl: JSON.stringify({
        value: "postgres://other@ignored/db",
      }),
    }),
    direct,
  );
});

test("resolveDrizzleDatabaseUrl prefers NEON_MIGRATIONS_DATABASE_URL (owner) over NEON_DATABASE_URL and the SST resource", () => {
  // Credential split: migrations must use the schema-owning role, never the
  // DML-only app role that the NeonDatabaseUrl SST resource now points at.
  assert.equal(
    resolveDrizzleDatabaseUrl({
      NEON_MIGRATIONS_DATABASE_URL: pooled,
      NEON_DATABASE_URL: "postgres://app-role@ignored/db",
      SST_RESOURCE_NeonDatabaseUrl: JSON.stringify({
        value: "postgres://app-role@ignored/db",
      }),
    }),
    direct,
  );
});

test("DATABASE_URL still wins over NEON_MIGRATIONS_DATABASE_URL (local/CI override)", () => {
  assert.equal(
    resolveDrizzleDatabaseUrl({
      DATABASE_URL: pooled,
      NEON_MIGRATIONS_DATABASE_URL: "postgres://owner@ignored/db",
    }),
    direct,
  );
});

test("resolveDrizzleDatabaseUrl reads SST JSON and raw fallback values", () => {
  assert.equal(
    resolveDrizzleDatabaseUrl({
      SST_RESOURCE_NeonDatabaseUrl: JSON.stringify({ value: pooled }),
    }),
    direct,
  );
  assert.equal(
    resolveDrizzleDatabaseUrl({ SST_RESOURCE_NeonDatabaseUrl: pooled }),
    direct,
  );
});

test("loadDatabaseUrl builds a libpq URL from PG vars", () => {
  assert.equal(
    loadDatabaseUrl({
      PGHOST: "localhost",
      PGDATABASE: "cloud",
      PGUSER: "agent user",
      PGPASSWORD: "p@ss word",
    }),
    "postgres://agent%20user:p%40ss%20word@localhost:5432/cloud",
  );
});

test("toDirectEndpoint leaves local and unparsable connection strings unchanged", () => {
  assert.equal(
    toDirectEndpoint("postgres://postgres@localhost:5432/db"),
    "postgres://postgres@localhost:5432/db",
  );
  assert.equal(toDirectEndpoint("not a url"), "not a url");
});
