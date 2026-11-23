/**
 * The PostgreSQL engine handle and SQLSTATE decoding against the real
 * fixture. Skipped unless RELAYCAST_PG_TEST_URL_OWNER, _URL_RUNTIME and
 * RELAYCAST_PG_TEST_CA_FILE are set (see postgres.integration.test.ts).
 * Holds the fixture lock for its whole run; resets the schema as the owner.
 */
import { sql } from "drizzle-orm";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { EngineDb } from "../../../ports/database.js";
import { loadPostgresConfig, type PostgresMode } from "../config.js";
import { loadBundledPostgresMigrations, runPostgresMigrations } from "../migrate.js";
import { openPostgresPool } from "../pool.js";
import { holdFixtureLock, resetSchema, SCHEMA } from "./fixture.js";

const OWNER_URL = process.env.RELAYCAST_PG_TEST_URL_OWNER;
const RUNTIME_URL = process.env.RELAYCAST_PG_TEST_URL_RUNTIME;
const CA_FILE = process.env.RELAYCAST_PG_TEST_CA_FILE;
const enabled = Boolean(OWNER_URL && RUNTIME_URL && CA_FILE);

const configFor = (url: string, mode: PostgresMode) =>
  loadPostgresConfig({ RELAYCAST_DATABASE_URL: url, RELAYCAST_DATABASE_CA_FILE: CA_FILE }, mode);

// setupFiles binds this process to 'sqlite'; load a fresh module graph that
// the PostgreSQL handle can bind to 'pg'.
async function freshModules() {
  vi.resetModules();
  return {
    handle: await import("../engineDb.js"),
    t: await import("../../../db/tables.js"),
    ports: await import("../../../ports/database.js"),
  };
}

/** The settled rejection of `promise` (fails the test if it resolves). */
async function rejection(promise: PromiseLike<unknown>): Promise<unknown> {
  return Promise.resolve(promise).then(
    () => expect.fail("expected a rejection"),
    (err: unknown) => err,
  );
}

describe.skipIf(!enabled)("PostgreSQL engine handle (integration)", { timeout: 120_000 }, () => {
  let owner: pg.Pool;
  let releaseFixture: (() => Promise<void>) | undefined;
  let m: Awaited<ReturnType<typeof freshModules>>;
  let handle: Awaited<ReturnType<typeof m.handle.openPostgresEngineDb>>;

  beforeAll(async () => {
    m = await freshModules();
    owner = openPostgresPool(configFor(OWNER_URL!, "owner"));
    releaseFixture = await holdFixtureLock(owner);
    await resetSchema(owner);
  });

  afterAll(async () => {
    await handle?.close().catch(() => {});
    if (owner) await resetSchema(owner).catch(() => {});
    await releaseFixture?.().catch(() => {});
    await owner?.end().catch(() => {});
  });

  it("refuses an unmigrated database with a typed error, and binds nothing", async () => {
    const err = await rejection(m.handle.openPostgresEngineDb(configFor(RUNTIME_URL!, "runtime")));
    expect(err).toBeInstanceOf(m.handle.PostgresMigrationStateError);
    expect((err as Error).message).toMatch(/_engine_migrations does not exist/);
    expect(m.t.currentSchemaDialect()).toBeUndefined();
  });

  it("refuses owner credentials presented as the runtime identity", async () => {
    await runPostgresMigrations(owner, {
      schema: SCHEMA,
      bundled: loadBundledPostgresMigrations(),
      runtimeRole: "relaycast_runtime",
    });
    const err = await rejection(m.handle.openPostgresEngineDb(configFor(OWNER_URL!, "runtime")));
    expect(err).toBeInstanceOf(m.handle.PostgresIdentityError);
    expect((err as InstanceType<typeof m.handle.PostgresIdentityError>).checks.some((c) => !c.ok)).toBe(true);
    for (const secret of [new URL(OWNER_URL!).password, new URL(RUNTIME_URL!).password]) {
      expect((err as Error).message).not.toContain(secret);
    }
  });

  it("opens a verified, branded runtime handle that reads and writes through the neutral API", async () => {
    handle = await m.handle.openPostgresEngineDb(configFor(RUNTIME_URL!, "runtime"));
    const { db } = handle;
    expect(db.engineDialect).toBe("pg");
    expect(handle.identity.ok).toBe(true);
    expect(handle.ledger.ok).toBe(true);
    expect(m.ports.hasTransactionCapability(db)).toBe(true);
    expect(m.t.currentSchemaDialect()).toBe("pg");

    const who = await db.execute<{ u: string; big: number }>(sql`SELECT current_user AS u, 9007199254740991::int8 AS big`);
    expect(who.rows[0]).toEqual({ u: "relaycast_runtime", big: 9007199254740991 });

    await db.insert(m.t.workspaces).values({ id: "ws_a", name: "A", apiKeyHash: "hash_a" });
    const rows = await db.select({ id: m.t.workspaces.id, name: m.t.workspaces.name }).from(m.t.workspaces);
    expect(rows).toEqual([{ id: "ws_a", name: "A" }]);

    const neutral: EngineDb = db;
    const [{ n }] = await neutral.select({ n: sql<number>`count(*)` }).from(m.t.workspaces);
    expect(n).toBe(1);
  });

  it("withTransaction commits and rolls back on one pooled client", async () => {
    const { db } = handle;
    const pids = await db.withTransaction(async (tx) => {
      await tx.insert(m.t.workspaces).values({ id: "ws_b", name: "B", apiKeyHash: "hash_b" });
      const pidOf = async () => (await (tx as typeof db).execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`)).rows[0].pid;
      return [await pidOf(), await pidOf()];
    });
    expect(pids[0]).toBe(pids[1]);

    const boom = new Error("rollback please");
    await expect(
      db.withTransaction(async (tx) => {
        await tx.insert(m.t.workspaces).values({ id: "ws_c", name: "C", apiKeyHash: "hash_c" });
        throw boom;
      }),
    ).rejects.toBe(boom);
    const ids = (await db.select({ id: m.t.workspaces.id }).from(m.t.workspaces)).map((r) => r.id).sort();
    expect(ids).toEqual(["ws_a", "ws_b"]);
  });

  it("runAtomicWrites rolls the whole batch back and decodes a 23505 by constraint name", async () => {
    const { db } = handle;
    const err = await rejection(
      m.ports.runAtomicWrites(
        db,
        (tx) => [
          tx.insert(m.t.workspaces).values({ id: "ws_d", name: "D", apiKeyHash: "hash_d" }),
          tx.insert(m.t.workspaces).values({ id: "ws_e", name: "E", apiKeyHash: "hash_a" }),
        ],
        { requireAtomic: true },
      ),
    );
    expect(m.ports.databaseUniqueViolation(err)).toEqual({
      table: "workspaces",
      columns: ["api_key_hash"],
      constraint: "workspaces_api_key_hash_unique",
    });
    expect(m.ports.databaseConstraintKind(err)).toBeUndefined();
    const ids = (await db.select({ id: m.t.workspaces.id }).from(m.t.workspaces)).map((r) => r.id).sort();
    expect(ids).toEqual(["ws_a", "ws_b"]);
  });

  it("decodes a 23502 on a sentinel column to the SQLite kind, and not on other columns", async () => {
    const { db } = handle;
    await db.insert(m.t.nodes).values({ id: "node_a", workspaceId: "ws_a", name: "n", tokenHash: "node_hash_a" });
    const sentinel = await rejection(
      db.update(m.t.nodes).set({ activeAgents: sql`NULL` }).where(sql`${m.t.nodes.id} = 'node_a'`),
    );
    expect((sentinel as { cause?: { code?: string } }).cause?.code).toBe("23502");
    expect(m.ports.databaseConstraintKind(sentinel)).toBe("node_capacity");

    const other = await rejection(db.update(m.t.nodes).set({ name: sql`NULL` }).where(sql`${m.t.nodes.id} = 'node_a'`));
    expect(m.ports.databaseConstraintKind(other)).toBeUndefined();
  });

  it("decodes the agent_node_bindings trigger refusal (23000)", async () => {
    const { db } = handle;
    await db.insert(m.t.agents).values({ id: "agent_b", workspaceId: "ws_b", name: "b", tokenHash: "agent_hash_b" });
    const err = await rejection(
      db.insert(m.t.agentNodeBindings).values({ id: "bind_x", workspaceId: "ws_a", agentId: "agent_b", nodeId: "node_a" }),
    );
    expect((err as { cause?: { code?: string } }).cause?.code).toBe("23000");
    expect(m.ports.databaseTriggerRefusal(err)).toBe("binding_agent_workspace_mismatch");
    expect(m.ports.databaseConstraintKind(err)).toBeUndefined();
    expect(m.ports.databaseUniqueViolation(err)).toBeUndefined();
  });

  it("the unique-constraint map names exactly the migrated catalog's unique indexes", async () => {
    const { rows } = await owner.query<{ name: string; tbl: string; cols: string[] }>(
      `SELECT i.relname AS name, t.relname AS tbl,
              array(SELECT a.attname FROM unnest(x.indkey) WITH ORDINALITY k(attnum, ord)
                    JOIN pg_catalog.pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
                    ORDER BY k.ord)::text[] AS cols
       FROM pg_catalog.pg_index x
       JOIN pg_catalog.pg_class i ON i.oid = x.indexrelid
       JOIN pg_catalog.pg_class t ON t.oid = x.indrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = $1 AND x.indisunique AND t.relname <> '_engine_migrations'`,
      [SCHEMA],
    );
    // The *_fts full-text mirrors (0001_triggers.sql) are written only by
    // triggers and are not engine tables; their rowid keys are not mapped.
    const mirrors = rows.filter((r) => r.tbl.endsWith("_fts"));
    expect(mirrors.map((r) => r.name).sort()).toEqual(mirrors.map((r) => `${r.tbl}_pkey`).sort());
    expect(mirrors.length).toBeGreaterThan(0);
    const catalog = Object.fromEntries(rows.filter((r) => !r.tbl.endsWith("_fts")).map((r) => [r.name, [r.tbl, r.cols]]));
    expect(m.ports.PG_UNIQUE_CONSTRAINTS).toEqual(catalog);
  });
});
