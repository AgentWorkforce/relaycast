/**
 * The PostgreSQL engine handle: a drizzle node-postgres database over the
 * runtime pool, branded `engineDialect: 'pg'` and bound to the
 * schema-qualified tables of `db/schema.pg.ts`.
 *
 * {@link openPostgresEngineDb} only verifies before serving. It refuses unless
 * the session is the configured runtime role with exactly the runtime
 * privileges ({@link verifyIdentity}) and the ledger says the database is
 * migrated for this image ({@link verifyPostgresMigrations}). It takes no
 * advisory lock, runs no DDL, and never creates a schema or a role; migrating
 * is `relaycast-engine migrate`'s job, under the owner role. A failure is a
 * typed refusal, never a fallback to SQLite.
 *
 * Tables are in the default schema `public`, and the pool sets
 * `search_path=public` on every connection (see pool.ts).
 */
import { is } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { PgDialect } from "drizzle-orm/pg-core";
import pg from "pg";
import { ConfigError } from "../../bin/secretEnv.js";
import * as schema from "../../db/schema.pg.js";
import { bindSchema } from "../../db/tables.js";
import type { EngineDb, TransactionCapability } from "../../ports/database.js";
import type { EngineDatabase } from "../../ports/engineDb.js";
import type { PostgresConfig } from "./config.js";
import {
  verifyIdentity,
  type IdentityCheck,
  type IdentityResult,
} from "./identity.js";
import {
  loadBundledPostgresMigrations,
  verifyPostgresMigrations,
  type BundledMigration,
  type VerifyMigrationsResult,
} from "./migrate.js";
import { closePostgresPool, openPostgresPool, parseInt8 } from "./pool.js";

/** The drizzle node-postgres database type the engine handle is built from. */
export type PgDrizzleDb = NodePgDatabase<typeof schema>;

/** A branded PostgreSQL handle: its precise drizzle type, and an engine handle. */
export type PgBranded<T> = T & EngineDatabase & { readonly engineDialect: "pg" };

/** The engine handle `openPostgresEngineDb` returns. */
export type PostgresEngineDb = PgBranded<PgDrizzleDb & { $client: pg.Pool }> & TransactionCapability;

/** The database could not be reached, or a verification query failed. */
export class PostgresUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PostgresUnavailableError";
  }
}

/** The session is not a correctly scoped runtime identity. */
export class PostgresIdentityError extends Error {
  readonly checks: readonly IdentityCheck[];
  constructor(checks: readonly IdentityCheck[]) {
    const failed = checks.filter((check) => !check.ok);
    super(
      `refusing: the session is not a correctly scoped runtime identity (${failed
        .map((check) => `${check.name}: ${check.detail}`)
        .join("; ")})`,
    );
    this.name = "PostgresIdentityError";
    this.checks = checks;
  }
}

/** The ledger says the database is not migrated for this image. */
export class PostgresMigrationStateError extends Error {
  readonly problems: readonly string[];
  readonly generation: number;
  constructor(result: VerifyMigrationsResult) {
    super(
      `refusing: database is not migrated for this image (generation ${result.generation}): ${result.problems.join("; ")}`,
    );
    this.name = "PostgresMigrationStateError";
    this.problems = result.problems;
    this.generation = result.generation;
  }
}

/**
 * Brand a drizzle PostgreSQL database or transaction (in place) as an engine
 * handle of dialect `'pg'` and return it. Throws if `db` is not a drizzle
 * PostgreSQL database (its own `dialect` object must be a `PgDialect`), if it
 * already carries a different brand, or if the process schema is bound to
 * another dialect.
 */
export function brandPgEngineDb<T extends object>(db: T): PgBranded<T> {
  const drizzleDialect = (db as { dialect?: unknown }).dialect;
  if (!is(drizzleDialect, PgDialect)) {
    throw new Error("brandPgEngineDb: handle is not a drizzle PostgreSQL database");
  }
  bindSchema("pg");
  const existing = (db as { engineDialect?: unknown }).engineDialect;
  if (existing === "pg") return db as PgBranded<T>;
  if (existing !== undefined) {
    throw new Error(`brandPgEngineDb: handle is already branded ${JSON.stringify(existing)}`);
  }
  Object.defineProperty(db, "engineDialect", {
    value: "pg",
    enumerable: false,
    writable: false,
    configurable: false,
  });
  // The one PostgreSQL -> EngineDatabase cast, for the same reason as
  // brandSqliteEngineDb's: drizzle's pg builder classes are not
  // structurally the neutral interface, but the runtime check above
  // guarantees a drizzle PostgreSQL database.
  return db as PgBranded<T>;
}

/**
 * Build the engine handle over an already verified runtime pool. Exposed for
 * tests; production code goes through {@link openPostgresEngineDb}, which
 * verifies first.
 *
 * `withTransaction` runs `fn` inside one drizzle transaction, which holds a
 * single pooled client from BEGIN to COMMIT/ROLLBACK; the `tx` handle passed
 * to `fn` is branded too. `runAtomicWrites` prefers this capability, so an
 * atomic batch on PostgreSQL is one transaction on one client.
 *
 * int8: drizzle-orm's node-postgres session (0.45) passes its own `types` on
 * every query and falls back to the process-global `pg.types` parsers, so the
 * pool's TypeOverrides never apply to drizzle queries. Columns declared
 * `bigint({ mode: 'number' })` are mapped by drizzle itself, but raw `sql`
 * results such as `count(*)` are int8 and would otherwise arrive as strings.
 * The same safe parser is therefore installed globally (idempotent; values
 * beyond Number.MAX_SAFE_INTEGER throw instead of losing precision).
 */
export function buildPostgresEngineDb(pool: pg.Pool): PostgresEngineDb {
  pg.types.setTypeParser(pg.types.builtins.INT8, parseInt8);
  const db = brandPgEngineDb(drizzle(pool, { schema }));
  const capability: TransactionCapability = {
    withTransaction: <T>(fn: (tx: EngineDb) => Promise<T>): Promise<T> =>
      db.transaction((tx) => fn(brandPgEngineDb(tx))),
  };
  return Object.assign(db, capability);
}

export interface OpenPostgresEngineDbOptions {
  /** One line per idle-client error; never receives config or credentials. */
  log?: (message: string) => void;
  /** The migration bundle to verify against (defaults to this image's). */
  bundled?: readonly BundledMigration[];
}

export interface PostgresEngineHandle {
  db: PostgresEngineDb;
  pool: pg.Pool;
  identity: IdentityResult;
  ledger: VerifyMigrationsResult;
  close(): Promise<void>;
}

/**
 * Open the runtime pool, verify identity and ledger state with the runtime
 * credentials, and return the engine handle. Refuses (closing the pool) with
 * {@link ConfigError} for a non-runtime config, {@link PostgresUnavailableError}
 * when the database cannot be queried, {@link PostgresIdentityError} or
 * {@link PostgresMigrationStateError} when verification fails.
 */
export async function openPostgresEngineDb(
  config: PostgresConfig,
  opts: OpenPostgresEngineDbOptions = {},
): Promise<PostgresEngineHandle> {
  if (config.mode !== "runtime") {
    throw new ConfigError(
      `the engine handle needs runtime credentials; got a ${config.mode} config`,
    );
  }
  const bundled = opts.bundled ?? loadBundledPostgresMigrations();
  const pool = openPostgresPool(config, { log: opts.log });
  try {
    let identity: IdentityResult;
    let ledger: VerifyMigrationsResult;
    try {
      identity = await verifyIdentity(pool, {
        expectedRole: config.expectedRole,
        mode: "runtime",
        schema: config.schema,
        ownerRole: config.ownerRole,
      });
    } catch (err) {
      throw new PostgresUnavailableError(
        `database connection or identity query failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    if (!identity.ok) throw new PostgresIdentityError(identity.checks);
    try {
      ledger = await verifyPostgresMigrations(pool, { schema: config.schema, bundled });
    } catch (err) {
      throw new PostgresUnavailableError(
        `migration ledger query failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    if (!ledger.ok) throw new PostgresMigrationStateError(ledger);
    const db = buildPostgresEngineDb(pool);
    return { db, pool, identity, ledger, close: () => closePostgresPool(pool) };
  } catch (err) {
    await closePostgresPool(pool).catch(() => {});
    throw err;
  }
}
