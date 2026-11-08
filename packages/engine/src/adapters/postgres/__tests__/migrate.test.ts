import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EXIT_CONFIG,
  runMigrateCommand,
  runVerifyDbCommand,
  type CliIo,
} from "../cli.js";
import { verifyIdentity, type Queryable } from "../identity.js";
import {
  bundleMigrations,
  loadBundledPostgresMigrations,
  runPostgresMigrations,
  splitPostgresStatements,
  verifyPostgresMigrations,
  assessLedger,
  MIGRATION_LOCK_NAMESPACE,
  migrationLockKey,
  type AppliedMigration,
  type ClientSource,
} from "../migrate.js";

describe("splitPostgresStatements", () => {
  it("splits on drizzle breakpoints and drops comment-only chunks", () => {
    const sql =
      "-- header only\n--> statement-breakpoint\nCREATE TABLE a (x int);--> statement-breakpoint\n-- c\nCREATE INDEX i ON a (x);\n";
    expect(splitPostgresStatements(sql)).toEqual([
      "CREATE TABLE a (x int);",
      "-- c\nCREATE INDEX i ON a (x);",
    ]);
  });
});

describe("bundleMigrations", () => {
  it("assigns generations and checksums, honouring min_compatible_generation", () => {
    const bundled = bundleMigrations([
      { name: "0000_a.sql", sql: "SELECT 1;" },
      { name: "0001_b.sql", sql: "-- min_compatible_generation: 1\nSELECT 2;" },
    ]);
    expect(
      bundled.map((m) => [m.generation, m.minCompatibleGeneration]),
    ).toEqual([
      [1, 1],
      [2, 1],
    ]);
    expect(bundled[0].checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses a min_compatible_generation above the file position", () => {
    expect(() =>
      bundleMigrations([
        {
          name: "0000_a.sql",
          sql: "-- min_compatible_generation: 2\nSELECT 1;",
        },
      ]),
    ).toThrow(/between 1 and 1/);
  });
});

describe("loadBundledPostgresMigrations", () => {
  it("loads the bundled files in journal order", () => {
    const bundled = loadBundledPostgresMigrations();
    expect(bundled.map((m) => m.name)).toEqual([
      "0000_init.sql",
      "0001_triggers.sql",
    ]);
    expect(bundled.every((m) => m.statements.length > 0)).toBe(true);
  });

  it("bundles no schema, role or privilege DDL", () => {
    for (const m of loadBundledPostgresMigrations()) {
      for (const statement of m.statements) {
        const code = statement.replace(/--[^\n]*/g, "");
        expect(code, m.name).not.toMatch(
          /\b(CREATE|ALTER|DROP)\s+(SCHEMA|ROLE|USER|GROUP)\b/i,
        );
        expect(code, m.name).not.toMatch(/^\s*(GRANT|REVOKE)\b/im);
        expect(code, m.name).not.toMatch(/\b(DROP|REASSIGN)\s+OWNED\b/i);
      }
    }
  });

  function journalDir(tags: string[], files: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), "relaycast-pg-journal-"));
    mkdirSync(join(dir, "meta"));
    writeFileSync(
      join(dir, "meta/_journal.json"),
      JSON.stringify({
        dialect: "postgresql",
        entries: tags.map((tag, idx) => ({ idx, tag })),
      }),
    );
    for (const f of files) writeFileSync(join(dir, f), "SELECT 1;");
    return dir;
  }

  it("refuses a journal and directory that disagree", () => {
    expect(() =>
      loadBundledPostgresMigrations(
        journalDir(["0000_a"], ["0000_a.sql", "0001_b.sql"]),
      ),
    ).toThrow(/unlisted: 0001_b.sql/);
    expect(() =>
      loadBundledPostgresMigrations(
        journalDir(["0000_a", "0001_b"], ["0000_a.sql"]),
      ),
    ).toThrow(/missing: 0001_b.sql/);
  });
});

/** In-memory stand-in for a pool: a ledger table plus a log of every statement. */
class FakePool implements ClientSource {
  ledger = new Map<string, AppliedMigration>();
  log: string[] = [];
  ledgerOwner = "relaycast_owner";
  failOn: string | undefined;
  schemaOid: number | undefined = 16_385;
  connections = 0;
  releases: unknown[] = [];
  locks: number[][] = [];
  unlocks: number[][] = [];
  /** Rows to seed the ledger with, bypassing the migrator (for malformed-metadata tests). */
  seed(rows: Record<string, unknown>[]) {
    for (const row of rows) this.ledger.set(String(row.name), row as never);
    this.log.push("CREATE TABLE IF NOT EXISTS (seeded)");
  }

  async connect() {
    this.connections++;
    const pending: AppliedMigration[] = [];
    let snapshot = new Map(this.ledger);
    const client: Queryable & { release(): void } = {
      query: async (text: string, values?: unknown[]) => {
        const sql = text.replace(/\s+/g, " ").trim();
        this.log.push(sql);
        if (this.failOn && sql.includes(this.failOn))
          throw new Error(`boom: ${this.failOn}`);
        if (sql === "BEGIN") {
          snapshot = new Map(this.ledger);
          pending.length = 0;
        } else if (sql === "COMMIT") {
          for (const row of pending) this.ledger.set(row.name, row);
        } else if (sql === "ROLLBACK") {
          pending.length = 0;
        } else if (sql.startsWith("SELECT n.oid::int8 AS oid")) {
          return {
            rows: (this.schemaOid === undefined
              ? []
              : [{ oid: this.schemaOid }]) as never[],
          };
        } else if (sql.includes("pg_advisory_lock(")) {
          this.locks.push(values as number[]);
        } else if (sql.includes("pg_advisory_unlock(")) {
          this.unlocks.push(values as number[]);
        } else if (sql.includes("pg_get_userbyid(c.relowner)")) {
          return {
            rows: [
              { owner: this.ledgerOwner, me: "relaycast_owner" },
            ] as never[],
          };
        } else if (sql.startsWith("SELECT name, applied_at")) {
          return { rows: [...snapshot.values()] as never[] };
        } else if (
          sql.startsWith('INSERT INTO "relaycast"."_engine_migrations"')
        ) {
          const [
            name,
            applied_at,
            generation,
            min_compatible_generation,
            checksum,
          ] = values as never[];
          pending.push({
            name,
            applied_at,
            generation,
            min_compatible_generation,
            checksum,
          });
        } else if (sql.startsWith("SELECT EXISTS")) {
          return {
            rows: [
              {
                present: this.log.some((l) =>
                  l.startsWith("CREATE TABLE IF NOT EXISTS"),
                ),
              },
            ] as never[],
          };
        }
        return { rows: [] };
      },
      release: (err?: unknown) => {
        this.releases.push(err);
      },
    };
    return client;
  }
}

const files = [
  {
    name: "0000_a.sql",
    sql: 'CREATE TABLE "relaycast"."a" (x int);--> statement-breakpoint\nCREATE INDEX "i" ON "relaycast"."a" (x);',
  },
  { name: "0001_b.sql", sql: 'CREATE TABLE "relaycast"."b" (y int);' },
];
const opts = {
  schema: "relaycast",
  runtimeRole: "relaycast_runtime",
  now: () => 1_700_000_000,
};

describe("runPostgresMigrations", () => {
  it("applies pending files under the advisory lock and records the ledger", async () => {
    const pool = new FakePool();
    const bundled = bundleMigrations(files);
    const result = await runPostgresMigrations(pool, { ...opts, bundled });
    expect(result).toEqual({
      applied: ["0000_a.sql", "0001_b.sql"],
      alreadyApplied: [],
    });
    expect([...pool.ledger.values()]).toEqual([
      {
        name: "0000_a.sql",
        applied_at: 1_700_000_000,
        generation: 1,
        min_compatible_generation: 1,
        checksum: bundled[0].checksum,
      },
      {
        name: "0001_b.sql",
        applied_at: 1_700_000_000,
        generation: 2,
        min_compatible_generation: 2,
        checksum: bundled[1].checksum,
      },
    ]);
    // One dedicated client takes the schema-scoped session lock before anything else and releases it at the end.
    expect(pool.connections).toBe(1);
    expect(pool.log[1]).toMatch(
      /^SELECT pg_catalog.pg_advisory_lock\(\$1::int4, \$2::int4\)$/,
    );
    expect(pool.locks).toEqual([[MIGRATION_LOCK_NAMESPACE, 16_385]]);
    expect(pool.unlocks).toEqual(pool.locks);
    expect(pool.log.at(-1)).toMatch(/pg_advisory_unlock/);
    expect(pool.releases).toEqual([undefined]);
    expect(pool.log.filter((s) => s === "BEGIN")).toHaveLength(3);
    expect(pool.log).toContain(
      'REVOKE ALL ON "relaycast"."_engine_migrations" FROM PUBLIC',
    );
    expect(pool.log).toContain(
      'GRANT SELECT ON "relaycast"."_engine_migrations" TO "relaycast_runtime"',
    );
  });

  it("is idempotent on replay", async () => {
    const pool = new FakePool();
    const bundled = bundleMigrations(files);
    await runPostgresMigrations(pool, { ...opts, bundled });
    pool.log = [];
    const again = await runPostgresMigrations(pool, { ...opts, bundled });
    expect(again).toEqual({
      applied: [],
      alreadyApplied: ["0000_a.sql", "0001_b.sql"],
    });
    expect(pool.log.some((s) => s.includes('"relaycast"."a" (x int)'))).toBe(
      false,
    );
  });

  it("rolls back a failing file and leaves it unrecorded", async () => {
    const pool = new FakePool();
    pool.failOn = '"relaycast"."b"';
    await expect(
      runPostgresMigrations(pool, {
        ...opts,
        bundled: bundleMigrations(files),
      }),
    ).rejects.toThrow(/boom/);
    expect([...pool.ledger.keys()]).toEqual(["0000_a.sql"]);
    expect(pool.log.at(-2)).toBe("ROLLBACK");
    expect(pool.unlocks).toHaveLength(1);
  });

  it("refuses a changed checksum", async () => {
    const pool = new FakePool();
    await runPostgresMigrations(pool, {
      ...opts,
      bundled: bundleMigrations(files),
    });
    const edited = bundleMigrations([
      { ...files[0], sql: `${files[0].sql}\n-- edited` },
      files[1],
    ]);
    await expect(
      runPostgresMigrations(pool, { ...opts, bundled: edited }),
    ).rejects.toThrow(/different checksum/);
  });

  it("refuses a missing schema before locking", async () => {
    const pool = new FakePool();
    pool.schemaOid = undefined;
    await expect(
      runPostgresMigrations(pool, {
        ...opts,
        bundled: bundleMigrations(files),
      }),
    ).rejects.toThrow(/does not exist/);
    expect(pool.locks).toEqual([]);
    expect(pool.releases).toHaveLength(1);
  });

  it("admits an older image after a newer compatible additive migration and refuses one after a floor increase", async () => {
    const pool = new FakePool();
    const additive = bundleMigrations([
      ...files,
      { name: "0002_c.sql", sql: "-- min_compatible_generation: 2\nSELECT 3;" },
    ]);
    await runPostgresMigrations(pool, { ...opts, bundled: additive });
    expect(
      await runPostgresMigrations(pool, {
        ...opts,
        bundled: bundleMigrations(files),
      }),
    ).toEqual({
      applied: [],
      alreadyApplied: ["0000_a.sql", "0001_b.sql"],
    });
    const raised = bundleMigrations([
      ...additive.map(({ name, sql }) => ({ name, sql })),
      { name: "0003_d.sql", sql: "SELECT 4;" },
    ]);
    await runPostgresMigrations(pool, { ...opts, bundled: raised });
    await expect(
      runPostgresMigrations(pool, {
        ...opts,
        bundled: bundleMigrations(files),
      }),
    ).rejects.toThrow(
      /0003_d.sql requires image generation >= 4 \(this image is 2\)/,
    );
  });

  it("refuses malformed ledger metadata", async () => {
    const pool = new FakePool();
    pool.seed([
      {
        name: "0000_a.sql",
        applied_at: 1,
        generation: 1,
        min_compatible_generation: null,
        checksum: "x",
      },
    ]);
    await expect(
      runPostgresMigrations(pool, {
        ...opts,
        bundled: bundleMigrations(files),
      }),
    ).rejects.toThrow(
      /ledger row 0000_a.sql has malformed min_compatible_generation, checksum/,
    );
  });

  it("refuses a database migrated by an incompatible newer image", async () => {
    const pool = new FakePool();
    await runPostgresMigrations(pool, {
      ...opts,
      bundled: bundleMigrations(files),
    });
    await expect(
      runPostgresMigrations(pool, {
        ...opts,
        bundled: bundleMigrations(files.slice(0, 1)),
      }),
    ).rejects.toThrow(
      /0001_b.sql requires image generation >= 2 \(this image is 1\)/,
    );
  });

  it("refuses a ledger owned by another role", async () => {
    const pool = new FakePool();
    pool.ledgerOwner = "someone_else";
    await expect(
      runPostgresMigrations(pool, {
        ...opts,
        bundled: bundleMigrations(files),
      }),
    ).rejects.toThrow(/owned by someone_else/);
  });
});

describe("migrationLockKey", () => {
  it("scopes the lock to the schema OID under a fixed namespace, wrapping to int4", () => {
    expect(migrationLockKey(16_385)).toEqual({
      namespace: MIGRATION_LOCK_NAMESPACE,
      key: 16_385,
    });
    expect(migrationLockKey(16_386).key).not.toBe(migrationLockKey(16_385).key);
    expect(migrationLockKey(0xffffffff).key).toBe(-1);
    expect(() => migrationLockKey(0)).toThrow(/invalid schema OID/);
  });
});

describe("assessLedger", () => {
  const bundled = bundleMigrations(files);
  const row = (
    m: (typeof bundled)[number],
    over: Record<string, unknown> = {},
  ) => ({
    name: m.name,
    applied_at: 1,
    generation: m.generation,
    min_compatible_generation: m.minCompatibleGeneration,
    checksum: m.checksum,
    ...over,
  });

  it("accepts a prefix and reports the pending suffix", () => {
    expect(assessLedger([row(bundled[0])], bundled)).toEqual({
      problems: [],
      pending: ["0001_b.sql"],
      unknown: [],
    });
  });

  it.each([
    [
      "missing generation",
      [{ ...row(bundled[0]), generation: undefined }],
      /malformed generation/,
    ],
    [
      "string generation",
      [row(bundled[0], { generation: "1" })],
      /malformed generation/,
    ],
    [
      "floor above generation",
      [row(bundled[0], { min_compatible_generation: 2 })],
      /malformed min_compatible_generation/,
    ],
    ["bad name", [row(bundled[0], { name: "init.sql" })], /malformed name/],
    [
      "bad checksum",
      [row(bundled[0], { checksum: "abc" })],
      /malformed checksum/,
    ],
    [
      "gap",
      [row(bundled[1])],
      /missing generation\(s\) 1 below 2: dirty or interrupted/,
    ],
    [
      "duplicate generation",
      [
        row(bundled[0]),
        row(bundled[1], { generation: 1, min_compatible_generation: 1 }),
      ],
      /two rows at generation 1/,
    ],
    [
      "divergent history",
      [row(bundled[0], { name: "0000_other.sql" })],
      /generation 1 is 0000_other.sql in the database but 0000_a.sql/,
    ],
    [
      "edited file",
      [row(bundled[0], { checksum: "f".repeat(64) })],
      /different checksum/,
    ],
  ])("refuses %s", (_label, rows, message) => {
    expect(assessLedger(rows as never, bundled).problems.join("; ")).toMatch(
      message,
    );
  });

  it("orders by the integer generation, not by name or checksum", () => {
    // A newer image's row sorts lexically before ours but is generation 3 and declares floor 2.
    const newer = {
      name: "0002_a.sql",
      applied_at: 1,
      generation: 3,
      min_compatible_generation: 2,
      checksum: "0".repeat(64),
    };
    expect(
      assessLedger([row(bundled[0]), row(bundled[1]), newer], bundled),
    ).toEqual({
      problems: [],
      pending: [],
      unknown: ["0002_a.sql"],
    });
  });
});

describe("verifyPostgresMigrations", () => {
  const verifyOpts = { schema: "relaycast" };

  it("fails before migrate and passes after", async () => {
    const pool = new FakePool();
    const bundled = bundleMigrations(files);
    const client = await pool.connect();
    const before = await verifyPostgresMigrations(client, {
      ...verifyOpts,
      bundled,
    });
    expect(before.ok).toBe(false);
    expect(before.problems[0]).toMatch(
      /does not exist; run relaycast-engine migrate/,
    );
    await runPostgresMigrations(pool, { ...opts, bundled });
    const after = await verifyPostgresMigrations(await pool.connect(), {
      ...verifyOpts,
      bundled,
    });
    expect(after).toEqual({
      ok: true,
      generation: 2,
      problems: [],
      unknown: [],
    });
    // Read-only: no lock, no DDL, no writes.
    const verifyLog = pool.log.slice(pool.log.lastIndexOf("COMMIT") + 1);
    expect(verifyLog.every((s) => s.startsWith("SELECT"))).toBe(true);
  });

  it("reports pending files, checksum drift, newer-image rows and unknown rows", async () => {
    const pool = new FakePool();
    await runPostgresMigrations(pool, {
      ...opts,
      bundled: bundleMigrations(files),
    });
    const client = await pool.connect();

    const older = await verifyPostgresMigrations(client, {
      ...verifyOpts,
      bundled: bundleMigrations(files.slice(0, 1)),
    });
    expect(older.ok).toBe(false);
    expect(older.unknown).toEqual(["0001_b.sql"]);
    expect(older.problems).toEqual([
      "0001_b.sql requires image generation >= 2 (this image is 1)",
    ]);

    const newer = bundleMigrations([
      ...files,
      { name: "0002_c.sql", sql: "SELECT 3;" },
    ]);
    expect(
      (
        await verifyPostgresMigrations(client, {
          ...verifyOpts,
          bundled: newer,
        })
      ).problems,
    ).toEqual(["pending migrations: 0002_c.sql"]);

    const edited = bundleMigrations([
      files[0],
      { ...files[1], sql: "SELECT 4;" },
    ]);
    expect(
      (
        await verifyPostgresMigrations(client, {
          ...verifyOpts,
          bundled: edited,
        })
      ).problems,
    ).toEqual([
      "0001_b.sql was applied with a different checksum; bundled migrations must never change",
    ]);
  });

  it("tolerates rows from a newer image that declares itself compatible", async () => {
    const pool = new FakePool();
    const newer = bundleMigrations([
      ...files,
      { name: "0002_c.sql", sql: "-- min_compatible_generation: 2\nSELECT 3;" },
    ]);
    await runPostgresMigrations(pool, { ...opts, bundled: newer });
    const result = await verifyPostgresMigrations(await pool.connect(), {
      ...verifyOpts,
      bundled: bundleMigrations(files),
    });
    expect(result).toMatchObject({ ok: true, unknown: ["0002_c.sql"] });
  });
});

/** Scripted pg_catalog answers for verifyIdentity, keyed by a distinctive fragment of each query. */
function catalog(overrides: Record<string, unknown[]> = {}): Queryable {
  const base: Record<string, unknown[]> = {
    "session_user::text": [
      { session_user: "relaycast_runtime", current_user: "relaycast_runtime" },
    ],
    "rolcanlogin, rolsuper": [
      {
        rolcanlogin: true,
        rolsuper: false,
        rolcreaterole: false,
        rolcreatedb: false,
        rolreplication: false,
        rolbypassrls: false,
      },
    ],
    "r.rolname <> current_user": [],
    "n.nspowner": [{ owner: "relaycast_owner", usage: true, create: false }],
    "n.nspname <> 'public'": [
      { nspname: "control", usage: false, create: false },
    ],
    "n.nspname = 'public'": [{ create: false, readable: [] }],
    "'MEMBER') AS member": [{ member: false, usage: false }],
    "'relation' AS kind": [],
    "current_database()": [{ temp: false, create: false }],
    "AS present": [{ present: true, sel: true, write: false }],
    ...overrides,
  };
  return {
    query: async (text: string) => {
      const key = Object.keys(base).find((k) => text.includes(k));
      if (!key) throw new Error(`unscripted query: ${text}`);
      return { rows: base[key] as never[] };
    },
  };
}

const runtime = {
  expectedRole: "relaycast_runtime",
  mode: "runtime" as const,
  schema: "relaycast",
  ownerRole: "relaycast_owner",
};

describe("verifyIdentity (fake catalog)", () => {
  it("passes a correctly scoped runtime role", async () => {
    const result = await verifyIdentity(catalog(), runtime);
    expect(result.checks.filter((c) => !c.ok)).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.checks.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        "session_user",
        "not_superuser",
        "not_member_of_owner",
        "no_schema_create",
        "ledger_read_only",
      ]),
    );
  });

  const failing = async (
    overrides: Record<string, unknown[]>,
    opts = runtime,
  ) =>
    (await verifyIdentity(catalog(overrides), opts)).checks
      .filter((c) => !c.ok)
      .map((c) => c.name);

  it.each([
    [
      "session_user",
      {
        "session_user::text": [
          {
            session_user: "relaycast_owner",
            current_user: "relaycast_runtime",
          },
        ],
      },
    ],
    [
      "not_superuser",
      {
        "rolcanlogin, rolsuper": [
          {
            rolcanlogin: true,
            rolsuper: true,
            rolcreaterole: false,
            rolcreatedb: false,
            rolreplication: false,
            rolbypassrls: false,
          },
        ],
      },
    ],
    [
      "no_privileged_memberships",
      { "r.rolname <> current_user": [{ rolname: "pg_admin" }] },
    ],
    [
      "not_member_of_owner",
      { "'MEMBER') AS member": [{ member: true, usage: true }] },
    ],
    [
      "no_schema_create",
      {
        "n.nspowner": [{ owner: "relaycast_owner", usage: true, create: true }],
      },
    ],
    [
      "no_foreign_schema_access",
      {
        "n.nspname <> 'public'": [
          { nspname: "control", usage: true, create: false },
        ],
      },
    ],
    [
      "public_schema_locked",
      { "n.nspname = 'public'": [{ create: true, readable: [] }] },
    ],
    [
      "owns_no_objects_in_schema",
      { "'relation' AS kind": [{ kind: "relation", name: "agents" }] },
    ],
    [
      "no_database_temp",
      { "current_database()": [{ temp: true, create: false }] },
    ],
    [
      "ledger_read_only",
      { "AS present": [{ present: true, sel: true, write: true }] },
    ],
  ])("fails %s", async (name, overrides) => {
    expect(await failing(overrides)).toEqual([name]);
  });

  it("reports a missing schema", async () => {
    expect(await failing({ "n.nspowner": [] })).toEqual(["schema_exists"]);
  });

  it("passes an owner that owns the schema and fails one that does not", async () => {
    const owner = {
      ...runtime,
      expectedRole: "relaycast_owner",
      mode: "owner" as const,
    };
    const who = {
      "session_user::text": [
        { session_user: "relaycast_owner", current_user: "relaycast_owner" },
      ],
    };
    expect(
      await failing(
        {
          ...who,
          "n.nspowner": [
            { owner: "relaycast_owner", usage: true, create: true },
          ],
        },
        owner,
      ),
    ).toEqual([]);
    expect(
      await failing(
        {
          ...who,
          "n.nspowner": [{ owner: "postgres", usage: true, create: false }],
        },
        owner,
      ),
    ).toEqual(["owns_schema", "schema_create"]);
  });
});

describe("CLI configuration errors", () => {
  const capture = () => {
    const lines: string[] = [];
    const io: CliIo = { out: (l) => lines.push(l), err: (l) => lines.push(l) };
    return { io, lines };
  };

  it("exits 64 without connecting when the configuration is refused", async () => {
    const secret = "pw-dev-only-456";
    for (const command of [runMigrateCommand, runVerifyDbCommand]) {
      const { io, lines } = capture();
      const code = await command(
        {
          RELAYCAST_DATABASE_URL: `postgres://u:${secret}@db.example.test/app?sslmode=require`,
          RELAYCAST_DATABASE_CA_FILE: "/x",
        },
        io,
      );
      expect(code).toBe(EXIT_CONFIG);
      expect(lines.join("\n")).toMatch(
        /configuration error: .*sslmode=require/,
      );
      expect(lines.join("\n")).not.toContain(secret);
    }
  });
});
