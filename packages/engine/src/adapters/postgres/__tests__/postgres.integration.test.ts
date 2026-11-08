/**
 * Integration tests against a real PostgreSQL fixture. Skipped unless all of
 * these are set:
 *
 *   RELAYCAST_PG_TEST_URL_OWNER    postgres://relaycast_owner:...@host:port/db
 *   RELAYCAST_PG_TEST_URL_RUNTIME  postgres://relaycast_runtime:...@host:port/db
 *   RELAYCAST_PG_TEST_CA_FILE      CA bundle that signs the server certificate
 *
 * The fixture must already have schema `relaycast` owned by relaycast_owner,
 * default privileges giving relaycast_runtime DML on the owner's tables, and
 * the refusal roles relaycast_admin (superuser), relaycast_runtime_member
 * (member of relaycast_owner) and relaycast_creator (CREATE on relaycast).
 * Their URLs default to the owner URL with the dev fixture passwords and can be
 * overridden with RELAYCAST_PG_TEST_URL_ADMIN / _MEMBER / _CREATOR.
 *
 * WARNING: the tests drop every table, function, sequence and type that
 * relaycast_owner owns in schema relaycast. They never drop the schema and
 * never use DROP OWNED.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  EXIT_FAILURE,
  EXIT_IDENTITY,
  runMigrateCommand,
  runVerifyDbCommand,
  type CliIo,
} from "../cli.js";
import { loadPostgresConfig, type PostgresMode } from "../config.js";
import { verifyIdentity } from "../identity.js";
import {
  bundleMigrations,
  loadBundledPostgresMigrations,
  migrationLockKey,
  runPostgresMigrations,
  verifyPostgresMigrations,
} from "../migrate.js";
import { openPostgresPool } from "../pool.js";

const OWNER_URL = process.env.RELAYCAST_PG_TEST_URL_OWNER;
const RUNTIME_URL = process.env.RELAYCAST_PG_TEST_URL_RUNTIME;
const CA_FILE = process.env.RELAYCAST_PG_TEST_CA_FILE;
const enabled = Boolean(OWNER_URL && RUNTIME_URL && CA_FILE);

const SCHEMA = "relaycast";
const TRIGGER_FUNCTIONS = 28;

/** Dev fixture credentials (not secrets) for the refusal roles. */
function roleUrl(
  override: string | undefined,
  user: string,
  password: string,
): string {
  if (override) return override;
  const url = new URL(OWNER_URL!);
  url.username = user;
  url.password = password;
  return url.toString();
}

function envFor(url: string): NodeJS.ProcessEnv {
  return { RELAYCAST_DATABASE_URL: url, RELAYCAST_DATABASE_CA_FILE: CA_FILE };
}

const pools: pg.Pool[] = [];
function poolFor(url: string, mode: PostgresMode): pg.Pool {
  const pool = openPostgresPool(loadPostgresConfig(envFor(url), mode));
  pools.push(pool);
  return pool;
}

async function pgError(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (err) {
    return (err as { code?: string }).code;
  }
  return undefined;
}

/** Run `fn` inside a transaction that is always rolled back. */
async function rolledBack<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    return await fn(client);
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
}

/** Drop everything the owner owns in the schema (never the schema itself, never DROP OWNED). */
async function resetSchema(owner: pg.Pool): Promise<void> {
  const client = await owner.connect();
  try {
    const q = async (sql: string) =>
      (await client.query<{ stmt: string }>(sql, [SCHEMA])).rows.map(
        (r) => r.stmt,
      );
    const me = `(SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)`;
    const drops = [
      ...(await q(
        `SELECT format('DROP TABLE IF EXISTS %I.%I CASCADE', n.nspname, c.relname) AS stmt
         FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') AND c.relowner = ${me}`,
      )),
      ...(await q(
        `SELECT format('DROP FUNCTION IF EXISTS %s CASCADE', p.oid::regprocedure) AS stmt
         FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = $1 AND p.proowner = ${me}`,
      )),
      ...(await q(
        `SELECT format('DROP SEQUENCE IF EXISTS %I.%I CASCADE', n.nspname, c.relname) AS stmt
         FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relkind = 'S' AND c.relowner = ${me}`,
      )),
      ...(await q(
        `SELECT format('DROP VIEW IF EXISTS %I.%I CASCADE', n.nspname, c.relname) AS stmt
         FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relkind IN ('v', 'm') AND c.relowner = ${me}`,
      )),
    ];
    for (const stmt of drops) await client.query(stmt);
    const types = await q(
      `SELECT format('DROP TYPE IF EXISTS %I.%I CASCADE', n.nspname, t.typname) AS stmt
       FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = $1 AND t.typrelid = 0 AND t.typelem = 0 AND t.typowner = ${me}`,
    );
    for (const stmt of types) await client.query(stmt);
    const left = await client.query(
      `SELECT c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1`,
      [SCHEMA],
    );
    if (left.rowCount)
      throw new Error(
        `schema ${SCHEMA} still has relations: ${left.rows.map((r) => r.relname).join(", ")}`,
      );
  } finally {
    client.release();
  }
}

function capture(): CliIo & { lines: string[] } {
  const lines: string[] = [];
  return { lines, out: (l) => lines.push(l), err: (l) => lines.push(l) };
}

/** The migrator's advisory lock key for a schema, from its OID (as the migrator derives it). */
async function lockKeyFor(client: pg.ClientBase, schema: string) {
  const { rows } = await client.query<{ oid: number }>(
    "SELECT oid::int8 AS oid FROM pg_catalog.pg_namespace WHERE nspname = $1",
    [schema],
  );
  return migrationLockKey(rows[0].oid);
}

/** Every value a test credential could leak as. */
const SECRETS = () =>
  [
    new URL(OWNER_URL!).password,
    new URL(RUNTIME_URL!).password,
    OWNER_URL!,
    RUNTIME_URL!,
  ].filter(Boolean);
function expectNoCredentials(text: string) {
  for (const secret of SECRETS()) expect(text).not.toContain(secret);
}

const failed = (result: { checks: { name: string; ok: boolean }[] }) =>
  result.checks.filter((c) => !c.ok).map((c) => c.name);

describe.skipIf(!enabled)(
  "postgres adapter (integration)",
  { timeout: 120_000 },
  () => {
    let owner: pg.Pool;
    let runtime: pg.Pool;
    const bundled = enabled ? loadBundledPostgresMigrations() : [];

    beforeAll(async () => {
      owner = poolFor(OWNER_URL!, "owner");
      runtime = poolFor(RUNTIME_URL!, "runtime");
      await resetSchema(owner);
    });

    afterAll(async () => {
      if (owner) await resetSchema(owner).catch(() => {});
      await Promise.all(pools.map((p) => p.end().catch(() => {})));
    });

    it("connects over verify-full TLS", async () => {
      const { rows } = await owner.query<{ ssl: boolean }>(
        "SELECT ssl FROM pg_catalog.pg_stat_ssl WHERE pid = pg_backend_pid()",
      );
      expect(rows[0].ssl).toBe(true);
    });

    it("(a) owner and runtime identities pass on a fresh fixture", async () => {
      const ownerResult = await verifyIdentity(owner, {
        expectedRole: "relaycast_owner",
        mode: "owner",
        schema: SCHEMA,
      });
      expect(failed(ownerResult)).toEqual([]);
      const runtimeResult = await verifyIdentity(runtime, {
        expectedRole: "relaycast_runtime",
        mode: "runtime",
        schema: SCHEMA,
        ownerRole: "relaycast_owner",
      });
      expect(failed(runtimeResult)).toEqual([]);
      expect(
        runtimeResult.checks.find((c) => c.name === "ledger_read_only")?.detail,
      ).toMatch(/^not applicable: .*absent/);
      expect(
        runtimeResult.checks.find((c) => c.name === "ledger_read_only")?.skipped,
      ).toBe(true);
    });

    describe("(b) refuses mis-scoped identities with a named failing check", () => {
      const runtimeAs = (url: string, expectedRole: string) =>
        verifyIdentity(poolFor(url, "runtime"), {
          expectedRole,
          mode: "runtime",
          schema: SCHEMA,
          ownerRole: "relaycast_owner",
        });

      it("relaycast_admin (superuser)", async () => {
        const url = roleUrl(
          process.env.RELAYCAST_PG_TEST_URL_ADMIN,
          "relaycast_admin",
          "admin-dev-password",
        );
        const result = await runtimeAs(url, "relaycast_admin");
        expect(result.ok).toBe(false);
        expect(failed(result)).toContain("not_superuser");
      });

      it("relaycast_runtime_member (member of the owner role)", async () => {
        const url = roleUrl(
          process.env.RELAYCAST_PG_TEST_URL_MEMBER,
          "relaycast_runtime_member",
          "member-dev-password",
        );
        const result = await runtimeAs(url, "relaycast_runtime_member");
        expect(result.ok).toBe(false);
        expect(failed(result)).toContain("not_member_of_owner");
      });

      it("relaycast_creator (CREATE on the schema)", async () => {
        const url = roleUrl(
          process.env.RELAYCAST_PG_TEST_URL_CREATOR,
          "relaycast_creator",
          "creator-dev-password",
        );
        const result = await runtimeAs(url, "relaycast_creator");
        expect(result.ok).toBe(false);
        expect(failed(result)).toContain("no_schema_create");
      });

      it("relaycast_runtime with a NOINHERIT membership (reachable only by SET ROLE)", async () => {
        // A NOINHERIT membership confers no privileges through has_*_privilege
        // on the member, so only the reachable-role checks can see it. Run as a
        // superuser inside a transaction that is always rolled back, switch to
        // relaycast_runtime with SET LOCAL ROLE, and verify on that client.
        const admin = poolFor(
          roleUrl(
            process.env.RELAYCAST_PG_TEST_URL_ADMIN,
            "relaycast_admin",
            "admin-dev-password",
          ),
          "runtime",
        );
        const { result, inherits } = await rolledBack(admin, async (client) => {
          await client.query(
            "GRANT relaycast_creator TO relaycast_runtime WITH INHERIT FALSE, SET TRUE",
          );
          await client.query("SET LOCAL ROLE relaycast_runtime");
          const inherits = (
            await client.query<{ create: boolean }>(
              "SELECT pg_catalog.has_schema_privilege(current_user, $1, 'CREATE') AS create",
              [SCHEMA],
            )
          ).rows[0].create;
          const result = await verifyIdentity(client, {
            expectedRole: "relaycast_runtime",
            mode: "runtime",
            schema: SCHEMA,
            ownerRole: "relaycast_owner",
          });
          return { result, inherits };
        });
        // The membership really is NOINHERIT: the role's own privileges are unchanged.
        expect(inherits).toBe(false);
        expect(result.ok).toBe(false);
        expect(failed(result)).toEqual(
          expect.arrayContaining(["no_role_memberships", "no_schema_create"]),
        );
        expect(
          result.checks.find((c) => c.name === "no_role_memberships")?.detail,
        ).toBe("can reach role(s) by membership or SET ROLE: relaycast_creator");
        // Rolled back: the real runtime identity is clean again.
        const after = await verifyIdentity(runtime, {
          expectedRole: "relaycast_runtime",
          mode: "runtime",
          schema: SCHEMA,
          ownerRole: "relaycast_owner",
        });
        expect(failed(after)).toEqual([]);
      });

      it("relaycast_owner used as the runtime identity", async () => {
        const asRuntime = await runtimeAs(OWNER_URL!, "relaycast_runtime");
        expect(failed(asRuntime)).toEqual(
          expect.arrayContaining([
            "session_user",
            "current_user",
            "not_schema_owner",
            "no_schema_create",
          ]),
        );
        // Even when told to expect the owner, runtime mode refuses the schema owner.
        const named = await runtimeAs(OWNER_URL!, "relaycast_owner");
        expect(failed(named)).toEqual(
          expect.arrayContaining(["not_schema_owner", "no_schema_create"]),
        );
        expect(failed(named)).not.toContain("session_user");
      });

      it("verify-db with the owner URL exits 65", async () => {
        const io = capture();
        expect(await runVerifyDbCommand(envFor(OWNER_URL!), io)).toBe(
          EXIT_IDENTITY,
        );
        expect(io.lines.join("\n")).toMatch(/FAIL session_user/);
        expect(io.lines.join("\n")).not.toContain(new URL(OWNER_URL!).password);
      });

      it("migrate with the runtime URL exits 65", async () => {
        const io = capture();
        expect(await runMigrateCommand(envFor(RUNTIME_URL!), io)).toBe(
          EXIT_IDENTITY,
        );
        expect(io.lines.join("\n")).toMatch(/FAIL owns_schema/);
      });
    });

    it("(d) runtime verify fails before migrate", async () => {
      const result = await verifyPostgresMigrations(runtime, {
        schema: SCHEMA,
        bundled,
      });
      expect(result.ok).toBe(false);
      expect(result.problems[0]).toMatch(/_engine_migrations does not exist/);
      const io = capture();
      expect(await runVerifyDbCommand(envFor(RUNTIME_URL!), io)).toBe(
        EXIT_FAILURE,
      );
      expect(io.lines.join("\n")).toMatch(/not migrated for this image/);
    });

    it("(c) concurrent migrators on a fresh schema apply each file exactly once", async () => {
      const opts = {
        schema: SCHEMA,
        bundled,
        runtimeRole: "relaycast_runtime",
      };
      const [a, b] = await Promise.all([
        runPostgresMigrations(owner, opts),
        runPostgresMigrations(poolFor(OWNER_URL!, "owner"), opts),
      ]);
      const names = bundled.map((m) => m.name);
      expect([...a.applied, ...b.applied].sort()).toEqual(names);
      expect([...a.alreadyApplied, ...b.alreadyApplied].sort()).toEqual(names);
      const ledger = await owner.query(
        `SELECT name, generation, min_compatible_generation, checksum FROM ${SCHEMA}._engine_migrations ORDER BY generation`,
      );
      expect(ledger.rows).toEqual(
        bundled.map((m) => ({
          name: m.name,
          generation: m.generation,
          min_compatible_generation: m.minCompatibleGeneration,
          checksum: m.checksum,
        })),
      );
    });

    it("(c) replay through the CLI is idempotent", async () => {
      const io = capture();
      expect(await runMigrateCommand(envFor(OWNER_URL!), io)).toBe(0);
      expect(io.lines).toContain(
        `migrations: 0 applied, ${bundled.length} already applied (generation ${bundled.length})`,
      );
      expect(io.lines.join("\n")).not.toContain(new URL(OWNER_URL!).password);
      expect(io.lines[0]).toMatch(
        /^postgres owner: host=\S+ port=\d+ database=\S+ schema=relaycast expected_role=relaycast_owner ca_sha256=[0-9a-f]{64}$/,
      );
    });

    it("(c) a second migrator on the same schema waits on the schema-OID lock; other schemas and the runtime are unaffected", async () => {
      const holder = await owner.connect();
      const { namespace, key } = await lockKeyFor(holder, SCHEMA);
      try {
        await holder.query(
          "SELECT pg_catalog.pg_advisory_lock($1::int4, $2::int4)",
          [namespace, key],
        );
        let settled = false;
        const second = runPostgresMigrations(poolFor(OWNER_URL!, "owner"), {
          schema: SCHEMA,
          bundled,
          runtimeRole: "relaycast_runtime",
        }).finally(() => {
          settled = true;
        });
        // Wait until the second migrator is blocked on exactly this (namespace, schema OID) key.
        const waitingOn = async () =>
          (
            await holder.query<{ n: number }>(
              `SELECT count(*)::int AS n FROM pg_catalog.pg_locks
             WHERE locktype = 'advisory' AND NOT granted AND classid = $1::int4::oid AND objid = $2::int4::oid AND objsubid = 2`,
              [namespace, key],
            )
          ).rows[0].n;
        let waiting = 0;
        for (let i = 0; i < 50 && waiting === 0; i++) {
          await new Promise((r) => setTimeout(r, 100));
          waiting = await waitingOn();
        }
        expect(waiting).toBe(1);
        await new Promise((r) => setTimeout(r, 300));
        expect(settled).toBe(false);

        // A different schema's key is independent: it is free while relaycast's is held.
        const other = await lockKeyFor(holder, "control");
        expect(other.namespace).toBe(namespace);
        expect(other.key).not.toBe(key);
        const probe = await owner.connect();
        try {
          expect(
            (
              await probe.query(
                "SELECT pg_catalog.pg_try_advisory_lock($1::int4, $2::int4) AS ok",
                [other.namespace, other.key],
              )
            ).rows[0].ok,
          ).toBe(true);
          await probe.query(
            "SELECT pg_catalog.pg_advisory_unlock($1::int4, $2::int4)",
            [other.namespace, other.key],
          );
        } finally {
          probe.release();
        }
        // A migrator aimed at another schema is not blocked by relaycast's lock: it fails fast on its own schema
        // (the fixture owner has no rights on control) instead of queueing behind the held key.
        const started = Date.now();
        expect(
          await pgError(
            runPostgresMigrations(poolFor(OWNER_URL!, "owner"), {
              schema: "control",
              bundled,
              runtimeRole: "relaycast_runtime",
            }),
          ),
        ).toBe("42501");
        expect(Date.now() - started).toBeLessThan(5_000);

        // The runtime takes no migration lock: verify completes while the lock is held and leaves no advisory locks.
        expect(
          (await verifyPostgresMigrations(runtime, { schema: SCHEMA, bundled }))
            .ok,
        ).toBe(true);
        const runtimeLocks = await holder.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_catalog.pg_locks l JOIN pg_catalog.pg_stat_activity a ON a.pid = l.pid
         WHERE l.locktype = 'advisory' AND a.usename = 'relaycast_runtime'`,
        );
        expect(runtimeLocks.rows[0].n).toBe(0);
        expect(await waitingOn()).toBe(1);

        await holder.query(
          "SELECT pg_catalog.pg_advisory_unlock($1::int4, $2::int4)",
          [namespace, key],
        );
        expect(await second).toEqual({
          applied: [],
          alreadyApplied: bundled.map((m) => m.name),
        });
        // The migrator released its session lock in finally.
        const held = await holder.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_catalog.pg_locks WHERE locktype = 'advisory' AND classid = $1::int4::oid`,
          [namespace],
        );
        expect(held.rows[0].n).toBe(0);
      } finally {
        holder.release();
      }
    });

    it("(d) runtime verify passes after migrate", async () => {
      const result = await verifyPostgresMigrations(runtime, {
        schema: SCHEMA,
        bundled,
      });
      expect(result).toEqual({
        ok: true,
        generation: bundled.length,
        problems: [],
        unknown: [],
      });
      const identity = await verifyIdentity(runtime, {
        expectedRole: "relaycast_runtime",
        mode: "runtime",
        schema: SCHEMA,
        ownerRole: "relaycast_owner",
      });
      expect(failed(identity)).toEqual([]);
      expect(
        identity.checks.find((c) => c.name === "ledger_read_only")?.detail,
      ).toMatch(/SELECT only/);
      const io = capture();
      expect(await runVerifyDbCommand(envFor(RUNTIME_URL!), io)).toBe(0);
      expect(io.lines).toContain(
        `database verified at generation ${bundled.length}`,
      );
    });

    it("(e) runtime cannot create tables, write the ledger, or read other schemas", async () => {
      const attempt = (sql: string) => rolledBack(runtime, (c) => c.query(sql));
      expect(
        await pgError(attempt(`CREATE TABLE ${SCHEMA}.intruder (x int)`)),
      ).toBe("42501");
      expect(
        await pgError(
          attempt(
            `INSERT INTO ${SCHEMA}._engine_migrations VALUES ('9999_evil.sql', 0, 99, 1, 'x')`,
          ),
        ),
      ).toBe("42501");
      expect(
        await pgError(
          attempt(`UPDATE ${SCHEMA}._engine_migrations SET checksum = 'x'`),
        ),
      ).toBe("42501");
      expect(
        await pgError(attempt(`DELETE FROM ${SCHEMA}._engine_migrations`)),
      ).toBe("42501");
      expect(
        await pgError(attempt(`TRUNCATE ${SCHEMA}._engine_migrations`)),
      ).toBe("42501");
      expect(await pgError(attempt("SELECT * FROM control.tenants"))).toBe(
        "42501",
      );
      expect(await pgError(attempt("SELECT * FROM pipeline.runs"))).toBe(
        "42501",
      );
      expect(await pgError(attempt(`DROP TABLE ${SCHEMA}.agents`))).toBe(
        "42501",
      );
      // ...while ordinary DML on engine tables works.
      expect(
        await pgError(
          attempt(
            `INSERT INTO ${SCHEMA}.workspaces (id, name, api_key_hash) VALUES ('w-dml', 'w', 'h')`,
          ),
        ),
      ).toBeUndefined();
    });

    it("(f) the DDL applied cleanly with all trigger functions in place", async () => {
      const { rows: fns } = await owner.query<{
        proname: string;
        triggers: number;
      }>(
        `SELECT p.proname, (SELECT count(*)::int FROM pg_catalog.pg_trigger t WHERE t.tgfoid = p.oid AND NOT t.tgisinternal) AS triggers
       FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = $1 AND p.prorettype = 'pg_catalog.trigger'::regtype ORDER BY 1`,
        [SCHEMA],
      );
      expect(fns).toHaveLength(TRIGGER_FUNCTIONS);
      for (const fn of fns) expect(fn.triggers, fn.proname).toBe(1);
      const { rows: named } = await owner.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
       JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = $1 AND NOT t.tgisinternal AND t.tgname = p.proname`,
        [SCHEMA],
      );
      expect(named[0].n).toBe(TRIGGER_FUNCTIONS);
      const { rows: tables } = await owner.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relkind = 'r'`,
        [SCHEMA],
      );
      // 46 schema.ts tables + 4 FTS mirrors + the ledger.
      expect(tables[0].n).toBe(51);
      const { rows: invalid } = await owner.query(
        `SELECT c.relname FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND NOT i.indisvalid`,
        [SCHEMA],
      );
      expect(invalid).toEqual([]);
    });

    it("(f) triggers and NOT NULL sentinels behave like SQLite for the runtime role", async () => {
      await rolledBack(runtime, async (c) => {
        await c.query(
          `INSERT INTO ${SCHEMA}.workspaces (id, name, api_key_hash) VALUES ('w1', 'w', 'h')`,
        );
        await c.query(
          `INSERT INTO ${SCHEMA}.agents (id, workspace_id, name, token_hash) VALUES ('a1', 'w1', 'alice', 't')`,
        );
        await c.query(
          `INSERT INTO ${SCHEMA}.channels (id, workspace_id, name) VALUES ('c1', 'w1', 'general')`,
        );
        await c.query(
          `INSERT INTO ${SCHEMA}.messages (id, workspace_id, channel_id, agent_id, body) VALUES ('m1', 'w1', 'c1', 'a1', 'hello relaycast')`,
        );
        await c.query(
          `INSERT INTO ${SCHEMA}.messages (id, workspace_id, channel_id, agent_id, body) VALUES ('m2', 'w1', 'c1', 'a1', 'second')`,
        );
        // FTS mirror keyed by messages.rowid.
        const fts = await c.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM ${SCHEMA}.messages_fts f JOIN ${SCHEMA}.messages m ON m.rowid = f.rowid
         WHERE m.id = 'm1' AND f.document @@ to_tsquery('simple', 'relaycast')`,
        );
        expect(fts.rows[0].n).toBe(1);
        // Delivery sequence high-water only moves forward.
        await c.query(
          `INSERT INTO ${SCHEMA}.deliveries (id, workspace_id, message_id, agent_id, seq) VALUES ('d1', 'w1', 'm1', 'a1', 5), ('d2', 'w1', 'm2', 'a1', 3)`,
        );
        const seq = await c.query<{ delivery_seq: number }>(
          `SELECT delivery_seq FROM ${SCHEMA}.agents WHERE id = 'a1'`,
        );
        expect(seq.rows[0].delivery_seq).toBe(5);
        // rowid is identity-assigned and returned as a JS number.
        const rowid = await c.query<{ rowid: number }>(
          `SELECT rowid FROM ${SCHEMA}.messages WHERE id = 'm1'`,
        );
        expect(typeof rowid.rows[0].rowid).toBe("number");
        await c.query("SAVEPOINT s");
        const err = await c
          .query(
            `INSERT INTO ${SCHEMA}.messages (id, workspace_id, channel_id, agent_id, body) VALUES ('m3', 'w1', 'c1', NULL, 'x')`,
          )
          .catch((e: { code?: string; column?: string }) => e);
        expect(err).toMatchObject({ code: "23502", column: "agent_id" });
        await c.query("ROLLBACK TO SAVEPOINT s");
      });
    });

    describe("native TLS and URL refusals (no credentials in output)", () => {
      const wrongCa = fileURLToPath(
        new URL("./fixtures/test-ca.pem", import.meta.url),
      );

      it("refuses a server certificate not signed by the configured CA", async () => {
        const io = capture();
        expect(
          await runVerifyDbCommand(
            { ...envFor(RUNTIME_URL!), RELAYCAST_DATABASE_CA_FILE: wrongCa },
            io,
          ),
        ).toBe(EXIT_FAILURE);
        const text = io.lines.join("\n");
        expect(text).toMatch(
          /connection or identity query failed: .*(self[- ]signed|unable to verify|certificate)/i,
        );
        expectNoCredentials(text);
      });

      it("refuses a host the certificate does not name (127.0.0.2 is loopback but not in the SAN)", async () => {
        const url = new URL(RUNTIME_URL!);
        url.hostname = "127.0.0.2";
        const pool = poolFor(url.toString(), "runtime");
        const err = await pool.query("SELECT 1").then(
          () => undefined,
          (e: { code?: string; message: string }) => e,
        );
        expect(err?.code).toBe("ERR_TLS_CERT_ALTNAME_INVALID");
        const io = capture();
        expect(await runVerifyDbCommand(envFor(url.toString()), io)).toBe(
          EXIT_FAILURE,
        );
        expect(io.lines.join("\n")).toMatch(
          /127\.0\.0\.2.*(not in the cert|altnames)/i,
        );
        expectNoCredentials(io.lines.join("\n"));
      });

      it.each([
        ["sslmode=disable"],
        ["sslmode=require"],
        ["sslmode=verify-ca"],
        ["sslrootcert=system"],
        ["sslcert=%2Ftmp%2Fc.pem"],
        ["sslkey=%2Ftmp%2Fk.pem"],
        ["options=-c%20search_path%3Dpublic"],
        ["host=evil.example.test"],
        ["ssl=false"],
      ])("exits 64 for a URL carrying %s", async (param) => {
        const io = capture();
        expect(
          await runVerifyDbCommand(envFor(`${RUNTIME_URL!}?${param}`), io),
        ).toBe(64);
        expect(io.lines.join("\n")).toMatch(/^configuration error: /);
        expectNoCredentials(io.lines.join("\n"));
      });

      it("refuses a URL login that is not the independently expected role (owner and runtime)", async () => {
        const asRuntime = capture();
        expect(await runVerifyDbCommand(envFor(OWNER_URL!), asRuntime)).toBe(
          EXIT_IDENTITY,
        );
        const asOwner = capture();
        expect(await runMigrateCommand(envFor(RUNTIME_URL!), asOwner)).toBe(
          EXIT_IDENTITY,
        );
        // A URL that names the right role with a password for another login never reaches the identity checks.
        const swapped = new URL(RUNTIME_URL!);
        swapped.password = new URL(OWNER_URL!).password;
        const bad = capture();
        expect(await runVerifyDbCommand(envFor(swapped.toString()), bad)).toBe(
          EXIT_FAILURE,
        );
        expect(bad.lines.join("\n")).toMatch(/password authentication failed/);
        for (const io of [asRuntime, asOwner, bad])
          expectNoCredentials(io.lines.join("\n"));
      });
    });

    // Runs last: it leaves an extra table and ledger rows behind (afterAll resets the schema).
    describe("compatibility floor", () => {
      const files = () => bundled.map(({ name, sql }) => ({ name, sql }));
      const G = bundled.length;
      const additive = () =>
        bundleMigrations([
          ...files(),
          {
            name: `${String(G).padStart(4, "0")}_compat_probe.sql`,
            sql: `-- min_compatible_generation: ${G}\nCREATE TABLE relaycast.compat_probe (id bigint PRIMARY KEY);`,
          },
        ]);

      it("admits the older image after a newer compatible additive migration", async () => {
        await runPostgresMigrations(owner, {
          schema: SCHEMA,
          bundled: additive(),
          runtimeRole: "relaycast_runtime",
        });
        const result = await verifyPostgresMigrations(runtime, {
          schema: SCHEMA,
          bundled,
        });
        expect(result).toEqual({
          ok: true,
          generation: G,
          problems: [],
          unknown: [`${String(G).padStart(4, "0")}_compat_probe.sql`],
        });
        expect(
          await runPostgresMigrations(owner, {
            schema: SCHEMA,
            bundled,
            runtimeRole: "relaycast_runtime",
          }),
        ).toEqual({
          applied: [],
          alreadyApplied: bundled.map((m) => m.name),
        });
        const io = capture();
        expect(await runVerifyDbCommand(envFor(RUNTIME_URL!), io)).toBe(0);
        expect(io.lines.join("\n")).toMatch(
          /note: \d{4}_compat_probe.sql applied by a newer compatible image/,
        );
      });

      it("refuses the older image after an incompatible floor increase (verify-db exits 1, migrate exits 1)", async () => {
        const raised = bundleMigrations([
          ...additive().map(({ name, sql }) => ({ name, sql })),
          {
            name: `${String(G + 1).padStart(4, "0")}_floor_raise.sql`,
            sql: "ALTER TABLE relaycast.compat_probe ADD COLUMN note text;",
          },
        ]);
        await runPostgresMigrations(owner, {
          schema: SCHEMA,
          bundled: raised,
          runtimeRole: "relaycast_runtime",
        });
        const result = await verifyPostgresMigrations(runtime, {
          schema: SCHEMA,
          bundled,
        });
        expect(result.ok).toBe(false);
        expect(result.problems).toEqual([
          `${String(G + 1).padStart(4, "0")}_floor_raise.sql requires image generation >= ${G + 2} (this image is ${G})`,
        ]);
        await expect(
          runPostgresMigrations(owner, {
            schema: SCHEMA,
            bundled,
            runtimeRole: "relaycast_runtime",
          }),
        ).rejects.toThrow(/refusing to migrate: .*requires image generation/);
        const verify = capture();
        expect(await runVerifyDbCommand(envFor(RUNTIME_URL!), verify)).toBe(
          EXIT_FAILURE,
        );
        const migrate = capture();
        expect(await runMigrateCommand(envFor(OWNER_URL!), migrate)).toBe(
          EXIT_FAILURE,
        );
        expect(migrate.lines.join("\n")).toMatch(
          /migration failed: refusing to migrate/,
        );
      });

      it("refuses dirty history: a ledger row with a gap below it", async () => {
        const client = await owner.connect();
        try {
          await client.query("BEGIN");
          await client.query(
            `DELETE FROM ${SCHEMA}._engine_migrations WHERE generation = 1`,
          );
          const result = await verifyPostgresMigrations(client, {
            schema: SCHEMA,
            bundled,
          });
          expect(result.problems.join("; ")).toMatch(/dirty or interrupted/);
        } finally {
          await client.query("ROLLBACK");
          client.release();
        }
      });
    });
  },
);
