import { ConfigError } from "../../bin/secretEnv.js";
import {
  describePostgresConfig,
  loadPostgresConfig,
  type PostgresMode,
} from "./config.js";
import { verifyIdentity, type IdentityResult } from "./identity.js";
import {
  loadBundledPostgresMigrations,
  runPostgresMigrations,
  verifyPostgresMigrations,
} from "./migrate.js";
import { closePostgresPool, openPostgresPool } from "./pool.js";

/** EX_USAGE: configuration refused. */
export const EXIT_CONFIG = 64;
/** EX_DATAERR: the database identity or privileges are wrong. */
export const EXIT_IDENTITY = 65;
/** Migration or verification failure (including connection failures). */
export const EXIT_FAILURE = 1;

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

const stdio: CliIo = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function reportIdentity(io: CliIo, result: IdentityResult): void {
  for (const check of result.checks) {
    (check.ok ? io.out : io.err)(
      `  ${check.skipped ? "skip" : check.ok ? "ok  " : "FAIL"} ${check.name}: ${check.detail}`,
    );
  }
}

async function withVerifiedPool(
  env: NodeJS.ProcessEnv,
  mode: PostgresMode,
  io: CliIo,
  fn: (
    pool: ReturnType<typeof openPostgresPool>,
    config: ReturnType<typeof loadPostgresConfig>,
  ) => Promise<number>,
): Promise<number> {
  let config;
  try {
    config = loadPostgresConfig(env, mode);
  } catch (err) {
    if (err instanceof ConfigError) {
      io.err(`configuration error: ${err.message}`);
      return EXIT_CONFIG;
    }
    throw err;
  }
  const safe = describePostgresConfig(config);
  io.out(
    `postgres ${mode}: host=${safe.host} port=${safe.port} database=${safe.database} schema=${safe.schema} ` +
      `expected_role=${safe.expectedRole} ca_sha256=${safe.caSha256}`,
  );
  const pool = openPostgresPool(config, { log: io.err });
  try {
    let identity: IdentityResult;
    try {
      identity = await verifyIdentity(pool, {
        expectedRole: config.expectedRole,
        mode,
        schema: config.schema,
        ownerRole: config.ownerRole,
      });
    } catch (err) {
      io.err(
        `database connection or identity query failed: ${errorMessage(err)}`,
      );
      return EXIT_FAILURE;
    }
    io.out(`identity checks (${mode}):`);
    reportIdentity(io, identity);
    if (!identity.ok) {
      io.err(
        `refusing: the session is not a correctly scoped ${mode} identity`,
      );
      return EXIT_IDENTITY;
    }
    return await fn(pool, config);
  } finally {
    await closePostgresPool(pool).catch(() => {});
  }
}

/** `relaycast-engine migrate`: owner identity, then apply bundled migrations. */
export async function runMigrateCommand(
  env: NodeJS.ProcessEnv = process.env,
  io: CliIo = stdio,
): Promise<number> {
  return withVerifiedPool(env, "owner", io, async (pool, config) => {
    try {
      const bundled = loadBundledPostgresMigrations();
      const result = await runPostgresMigrations(pool, {
        schema: config.schema,
        bundled,
        runtimeRole: config.runtimeRole,
      });
      for (const name of result.applied) io.out(`applied ${name}`);
      io.out(
        `migrations: ${result.applied.length} applied, ${result.alreadyApplied.length} already applied (generation ${bundled.length})`,
      );
      return 0;
    } catch (err) {
      io.err(`migration failed: ${errorMessage(err)}`);
      return EXIT_FAILURE;
    }
  });
}

/** `relaycast-engine verify-db`: runtime identity and read-only ledger verification. */
export async function runVerifyDbCommand(
  env: NodeJS.ProcessEnv = process.env,
  io: CliIo = stdio,
): Promise<number> {
  return withVerifiedPool(env, "runtime", io, async (pool, config) => {
    try {
      const result = await verifyPostgresMigrations(pool, {
        schema: config.schema,
        bundled: loadBundledPostgresMigrations(),
      });
      for (const problem of result.problems) io.err(`  FAIL ${problem}`);
      for (const name of result.unknown)
        io.out(`  note: ${name} applied by a newer compatible image`);
      if (!result.ok) {
        io.err("database is not migrated for this image");
        return EXIT_FAILURE;
      }
      io.out(`database verified at generation ${result.generation}`);
      return 0;
    } catch (err) {
      io.err(`verification failed: ${errorMessage(err)}`);
      return EXIT_FAILURE;
    }
  });
}
