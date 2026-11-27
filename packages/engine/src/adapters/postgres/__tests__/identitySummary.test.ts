import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { IdentityCheck, IdentityResult, Queryable } from "../identity.js";

/** The fake pool the CLI opens instead of a real one (see the CLI test below). */
const fakePool: { current?: Queryable } = {};
vi.mock("../pool.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../pool.js")>()),
  openPostgresPool: () => fakePool.current,
  closePostgresPool: async () => {},
}));

const { verifyIdentity } = await import("../identity.js");
const {
  DB_LOGIN_DOCS_URL,
  DB_LOGIN_ERROR_CODE,
  summarizeIdentityFailure,
} = await import("../identitySummary.js");
const { EXIT_IDENTITY, runMigrateCommand, runVerifyDbCommand } = await import("../cli.js");
const { PostgresIdentityError } = await import("../engineDb.js");
const postgresIndex = await import("../index.js");

const LINK = "https://agentrelay.com/docs/self-hosting/troubleshooting#database-logins";

/**
 * The pg_catalog answers an AWS RDS master login (`postgres`: CREATEROLE,
 * CREATEDB, member of rds_superuser and the pg_* predefined roles) gives,
 * keyed by a distinctive fragment of each verifyIdentity query.
 */
function rdsMasterCatalog(): Queryable {
  const reachable = ["pg_monitor", "pg_signal_backend", "rds_superuser"];
  const answers: Array<[string, unknown[]]> = [
    [
      "AS subject",
      reachable.map((subject) => ({
        subject,
        schema_create: subject === "rds_superuser",
        schema_owner: false,
        owned: [],
        temp: subject === "rds_superuser",
        db_create: subject === "rds_superuser",
        foreign_schemas: [],
        public_create: false,
      })),
    ],
    ["pg_auth_members", reachable.map((rolname) => ({ rolname, privileged: false }))],
    ["session_user::text", [{ session_user: "postgres", current_user: "postgres" }]],
    [
      "rolcanlogin, rolsuper",
      [
        {
          rolcanlogin: true,
          rolsuper: false,
          rolcreaterole: true,
          rolcreatedb: true,
          rolreplication: false,
          rolbypassrls: false,
        },
      ],
    ],
    ["n.nspowner", [{ owner: "pg_database_owner", usage: true, create: true }]],
    ["n.nspname <> 'public'", []],
    ["n.nspname = 'public'", [{ create: true, readable: [] }]],
    ["'MEMBER') AS member", [{ member: false, usage: false }]],
    ["'relation' AS kind", []],
    ["current_database()", [{ temp: true, create: true }]],
    ["AS present", [{ present: false, sel: null, write: null }]],
  ];
  return {
    query: async (text: string) => {
      const hit = answers.find(([fragment]) => text.includes(fragment));
      if (!hit) throw new Error(`unscripted query: ${text}`);
      return { rows: hit[1] as never[] };
    },
  };
}

const check = (name: string, ok: boolean, detail: string): IdentityCheck => ({ name, ok, detail });
const result = (checks: IdentityCheck[]): IdentityResult => ({
  ok: checks.every((c) => c.ok),
  checks,
});

describe("summarizeIdentityFailure", () => {
  it("uses the shared code and link verbatim, and is exported from the adapter index", () => {
    expect(DB_LOGIN_ERROR_CODE).toBe("AR_DB_LOGIN");
    expect(DB_LOGIN_DOCS_URL).toBe(LINK);
    expect(postgresIndex.summarizeIdentityFailure).toBe(summarizeIdentityFailure);
    expect(postgresIndex.verifyIdentity).toBe(verifyIdentity);
  });

  it("returns null for a passing result", () => {
    expect(
      summarizeIdentityFailure(result([check("session_user", true, "session_user=r, expected r")]), "runtime", "r"),
    ).toBeNull();
  });

  it("names the RDS master login, why it is one, and the fix", async () => {
    const identity = await verifyIdentity(rdsMasterCatalog(), {
      expectedRole: "relaycast_owner",
      mode: "owner",
      schema: "public",
    });
    expect(identity.ok).toBe(false);
    expect(summarizeIdentityFailure(identity, "owner", "relaycast_owner")).toBe(
      'AR_DB_LOGIN: login "postgres" is the database master/superuser (has CREATEROLE, CREATEDB; can reach rds_superuser); ' +
        "relaycast needs a dedicated owner login (relaycast_owner). " +
        `Run scripts/selfhost/configure-rds.sh (AgentWorkforce/infra), or see ${LINK}`,
    );
  });

  it("treats SUPERUSER and privileged memberships as master-shaped", () => {
    const summary = summarizeIdentityFailure(
      result([
        check("session_user", false, "session_user=admin, expected relaycast_runtime"),
        check("not_superuser", false, "role has SUPERUSER"),
        check("no_privileged_memberships", false, "can reach privileged role(s): creator, ops"),
      ]),
      "runtime",
      "relaycast_runtime",
    );
    expect(summary).toBe(
      'AR_DB_LOGIN: login "admin" is the database master/superuser (has SUPERUSER; can reach creator, ops); ' +
        "relaycast needs a dedicated runtime login (relaycast_runtime). " +
        `Run scripts/selfhost/configure-rds.sh (AgentWorkforce/infra), or see ${LINK}`,
    );
  });

  it("says the expected login itself holds master privileges", () => {
    expect(
      summarizeIdentityFailure(
        result([
          check("session_user", true, "session_user=relaycast_owner, expected relaycast_owner"),
          check("not_createdb", false, "role has CREATEDB"),
        ]),
        "owner",
        "relaycast_owner",
      ),
    ).toBe(
      'AR_DB_LOGIN: login "relaycast_owner" has master/superuser privileges (has CREATEDB); ' +
        `a relaycast owner login must not. Run scripts/selfhost/configure-rds.sh (AgentWorkforce/infra), or see ${LINK}`,
    );
  });

  it("names the login used and the one expected when they differ", () => {
    expect(
      summarizeIdentityFailure(
        result([
          check("session_user", false, "session_user=relaycast_runtime, expected relaycast_owner"),
          check("current_user", false, "current_user=relaycast_runtime, expected relaycast_owner"),
          check("owns_schema", false, "schema public owner is relaycast_owner"),
        ]),
        "owner",
        "relaycast_owner",
      ),
    ).toBe(
      'AR_DB_LOGIN: logged in as "relaycast_runtime" but relaycast owner expects login "relaycast_owner" ' +
        `(failed: session_user, current_user, owns_schema). See ${LINK}`,
    );
  });

  it("lists the failed checks for any other mis-scoped login", () => {
    expect(
      summarizeIdentityFailure(
        result([
          check("session_user", true, "session_user=relaycast_runtime, expected relaycast_runtime"),
          check("no_schema_create", false, "has CREATE on public"),
          check("no_database_temp", false, "has TEMP on the database"),
        ]),
        "runtime",
      ),
    ).toBe(
      'AR_DB_LOGIN: login "relaycast_runtime" is not a correctly scoped relaycast runtime identity ' +
        `(failed: no_schema_create, no_database_temp). See ${LINK}`,
    );
  });
});

describe("CLI refusal output", () => {
  const ca = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "test-ca.pem");
  const env = (user: string) => ({
    RELAYCAST_DATABASE_URL: `postgres://${user}:pw-dev-only-789@db.example.test:5432/app`,
    RELAYCAST_DATABASE_CA_FILE: ca,
  });
  const capture = () => {
    const out: string[] = [];
    const err: string[] = [];
    const all: string[] = [];
    return {
      io: {
        out: (l: string) => (out.push(l), all.push(l)),
        err: (l: string) => (err.push(l), all.push(l)),
      },
      out,
      err,
      all,
    };
  };

  it("migrate with the RDS master login: summary first, then the unchanged list, refusal and exit 65", async () => {
    fakePool.current = rdsMasterCatalog();
    const io = capture();
    expect(await runMigrateCommand(env("postgres"), io.io)).toBe(EXIT_IDENTITY);
    expect(EXIT_IDENTITY).toBe(65);
    const summaryAt = io.all.findIndex((l) => l.startsWith("AR_DB_LOGIN: "));
    const listAt = io.all.indexOf("identity checks (owner):");
    expect(summaryAt).toBeGreaterThan(0);
    expect(summaryAt).toBeLessThan(listAt);
    expect(io.err).toContain(io.all[summaryAt]);
    expect(io.all[summaryAt]).toMatch(/^AR_DB_LOGIN: login "postgres" is the database master\/superuser/);
    expect(io.all).toContain("  FAIL not_createdb: role has CREATEDB");
    expect(io.all.at(-1)).toBe("refusing: the session is not a correctly scoped owner identity");
    expect(io.all.join("\n")).not.toContain("pw-dev-only-789");
  });

  it("verify-db with the master login prints the runtime summary", async () => {
    fakePool.current = rdsMasterCatalog();
    const io = capture();
    expect(await runVerifyDbCommand(env("postgres"), io.io)).toBe(EXIT_IDENTITY);
    expect(io.err[0]).toMatch(
      /^AR_DB_LOGIN: login "postgres" is the database master\/superuser \(has CREATEROLE, CREATEDB; can reach rds_superuser\); relaycast needs a dedicated runtime login \(relaycast_runtime\)\./,
    );
    expect(io.all.at(-1)).toBe("refusing: the session is not a correctly scoped runtime identity");
  });
});

describe("PostgresIdentityError", () => {
  it("leads with the summary and keeps the refusal naming every failed check", async () => {
    const identity = await verifyIdentity(rdsMasterCatalog(), {
      expectedRole: "relaycast_runtime",
      mode: "runtime",
      schema: "public",
    });
    const err = new PostgresIdentityError(identity.checks, "relaycast_runtime");
    const [first, second] = err.message.split("\n");
    expect(err.summary).toBe(first);
    expect(first).toMatch(/^AR_DB_LOGIN: login "postgres" is the database master\/superuser/);
    expect(second).toMatch(/^refusing: the session is not a correctly scoped runtime identity \(session_user: /);
    expect(second).toContain("not_createrole: role has CREATEROLE");
    expect(err.name).toBe("PostgresIdentityError");
  });

  it("falls back to the role named in the session_user check", () => {
    const err = new PostgresIdentityError([
      check("session_user", false, "session_user=postgres, expected relaycast_runtime"),
      check("not_createdb", false, "role has CREATEDB"),
    ]);
    expect(err.summary).toContain("dedicated runtime login (relaycast_runtime)");
  });
});
