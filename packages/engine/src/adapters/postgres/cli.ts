import { ConfigError, secretFromEnv } from "../../bin/secretEnv.js";
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

/** Principal tables whose credentials must be ar_ before cutover, and their hash column. */
const LEGACY_CHECKED_PRINCIPALS = [
  ["agents", "token_hash"],
  ["nodes", "token_hash"],
  ["observer_tokens", "token_hash"],
  ["webhooks", "token_hash"],
] as const;

interface MigrationCliArgs {
  workspaces: string[];
  outDir?: string;
  runId?: string;
  blockRows?: number;
  fileDir?: string;
  arSince?: number;
  allowLegacy?: boolean;
  exportDir?: string;
}

function parseMigrationArgs(argv: readonly string[]): MigrationCliArgs {
  const args: MigrationCliArgs = { workspaces: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--allow-legacy") { args.allowLegacy = true; continue; }
    const value = argv[i + 1];
    const need = (): string => {
      if (value === undefined || value.startsWith("--")) throw new ConfigError(`${flag} needs a value`);
      i += 1;
      return value;
    };
    switch (flag) {
      case "--workspace": args.workspaces.push(need()); break;
      case "--out": args.outDir = need(); break;
      case "--run-id": args.runId = need(); break;
      case "--block-rows": args.blockRows = Number(need()); break;
      case "--file-dir": args.fileDir = need(); break;
      case "--ar-since": args.arSince = Number(need()); break;
      case "--export-dir": args.exportDir = need(); break;
      default: throw new ConfigError(`unknown argument ${flag}`);
    }
  }
  if (args.blockRows !== undefined && !(Number.isInteger(args.blockRows) && args.blockRows >= 1 && args.blockRows <= 10_000)) {
    throw new ConfigError("--block-rows must be an integer from 1 to 10000");
  }
  if (args.arSince !== undefined && !Number.isInteger(args.arSince)) {
    throw new ConfigError("--ar-since must be epoch seconds");
  }
  return args;
}

async function verifiedMigrations(pool: ReturnType<typeof openPostgresPool>, schema: string, io: CliIo): Promise<boolean> {
  const result = await verifyPostgresMigrations(pool, { schema, bundled: loadBundledPostgresMigrations() });
  for (const problem of result.problems) io.err(`  FAIL ${problem}`);
  if (!result.ok) io.err("database is not migrated for this image: export with the image the database runs");
  if (result.unknown.length > 0) {
    io.err(`database has migrations newer than this image (${result.unknown.join(", ")}): export with the image the database runs`);
    return false;
  }
  return result.ok;
}

/**
 * `relaycast-engine migration-preflight --ar-since <epoch s>`: read-only. Per
 * workspace, the row count of every table a migration copies, file objects
 * missing from `--file-dir`, and principals that may still hold a legacy
 * credential (`--ar-since`: when credentials.format=ar was enabled): agents,
 * nodes, observer tokens and webhooks created before then and never upgraded,
 * and a workspace key neither created nor rotated since. With `--export-dir`,
 * the free space there against twice the database's size. One JSON line per
 * workspace, then a summary line, on stdout; exit 1 when anything blocks a
 * migration (legacy principals only without `--allow-legacy`, whose holders
 * then re-register after the move).
 */
export async function runMigrationPreflightCommand(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  io: CliIo = stdio,
): Promise<number> {
  let args: MigrationCliArgs;
  try {
    args = parseMigrationArgs(argv);
    if (args.arSince === undefined) throw new ConfigError("--ar-since is required: the epoch second credentials.format=ar was enabled");
  } catch (err) {
    io.err(`configuration error: ${errorMessage(err)}`);
    return EXIT_CONFIG;
  }
  return withVerifiedPool(env, "runtime", io, async (pool, config) => {
    const { access, statfs } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { countWorkspace, listWorkspaces } = await import("../migration/export.js");
    if (!(await verifiedMigrations(pool, config.schema, io))) return EXIT_FAILURE;
    const client = await pool.connect();
    let blocked = false;
    try {
      const workspaces = args.workspaces.length > 0 ? args.workspaces : await listWorkspaces(client);
      for (const workspaceId of workspaces) {
        const counts = await countWorkspace(client, workspaceId);
        if (counts.workspaces !== 1) {
          io.err(`workspace ${workspaceId}: not found`);
          blocked = true;
          continue;
        }
        let missingFiles: number | null = null;
        if (args.fileDir !== undefined) {
          missingFiles = 0;
          const files = await client.query<{ storage_key: string }>(
            "SELECT storage_key FROM files WHERE workspace_id = $1 AND status = 'complete'", [workspaceId]);
          for (const file of files.rows) {
            try {
              await access(join(args.fileDir, file.storage_key));
            } catch {
              missingFiles += 1;
            }
          }
          if (missingFiles > 0) blocked = true;
        }
        const legacy: Record<string, number> = {};
        for (const [table, hash] of LEGACY_CHECKED_PRINCIPALS) {
          const result = await client.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM ${table} p
              WHERE p.workspace_id = $1 AND p.${hash} IS NOT NULL AND p.created_at < $2
                AND NOT EXISTS (SELECT 1 FROM credential_upgrades u WHERE u.ar_hash = p.${hash})`,
            [workspaceId, args.arSince]);
          legacy[table] = Number(result.rows[0]?.n ?? 0);
        }
        // The workspace key: legacy unless created after the switch, upgraded, or
        // rotated since (relaycast-rekey rotates with a grace, which stamps
        // previous_api_key_expires_at after the switch).
        const key = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM workspaces w
            WHERE w.id = $1 AND w.created_at < $2
              AND (w.previous_api_key_expires_at IS NULL OR w.previous_api_key_expires_at < $2)
              AND NOT EXISTS (SELECT 1 FROM credential_upgrades u WHERE u.ar_hash = w.api_key_hash)`,
          [workspaceId, args.arSince]);
        legacy.workspace_key = Number(key.rows[0]?.n ?? 0);
        if (!args.allowLegacy && Object.values(legacy).some((n) => n > 0)) blocked = true;
        io.out(JSON.stringify({ workspace_id: workspaceId, counts, missing_files: missingFiles, legacy_principals: legacy }));
      }
      if (args.exportDir !== undefined) {
        // The export is the rows as JSON: bounded well under twice the database's on-disk size.
        const size = Number((await client.query<{ n: string }>("SELECT pg_database_size(current_database())::text AS n")).rows[0]?.n ?? 0);
        const fs = await statfs(args.exportDir);
        const free = Number(fs.bavail) * Number(fs.bsize);
        const enough = free >= 2 * size;
        if (!enough) blocked = true;
        io.out(JSON.stringify({ export_capacity: { database_bytes: size, free_bytes: free, required_bytes: 2 * size, ok: enough } }));
      }
    } finally {
      client.release();
    }
    return blocked ? EXIT_FAILURE : 0;
  });
}

/**
 * `relaycast-engine export-for-actors --out <dir> --run-id <id>`: export
 * workspaces (all, or each `--workspace`) from one snapshot for
 * `relaycast-migrate import`. Run it with writers stopped.
 */
export async function runMigrationExportCommand(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  io: CliIo = stdio,
): Promise<number> {
  let args: MigrationCliArgs;
  try {
    args = parseMigrationArgs(argv);
    if (!args.outDir) throw new ConfigError("--out is required");
    const { IMPORT_RUN_ID } = await import("../migration/protocol.js");
    if (!args.runId || !IMPORT_RUN_ID.test(args.runId)) throw new ConfigError("--run-id must be 8-64 URL-safe characters");
  } catch (err) {
    io.err(`configuration error: ${errorMessage(err)}`);
    return EXIT_CONFIG;
  }
  let internalSecret: string | undefined;
  try {
    internalSecret = secretFromEnv(env, "RELAYCAST_INTERNAL_SECRET");
    if (!internalSecret) throw new ConfigError("RELAYCAST_INTERNAL_SECRET(_FILE) is required: export blocks are sealed with a key derived from it");
  } catch (err) {
    io.err(`configuration error: ${errorMessage(err)}`);
    return EXIT_CONFIG;
  }
  return withVerifiedPool(env, "runtime", io, async (pool, config) => {
    const { beginSnapshot, exportWorkspaces, listWorkspaces } = await import("../migration/export.js");
    if (!(await verifiedMigrations(pool, config.schema, io))) return EXIT_FAILURE;
    const client = await pool.connect();
    try {
      await beginSnapshot(client);
      const workspaceIds = args.workspaces.length > 0 ? args.workspaces : await listWorkspaces(client);
      const manifests = await exportWorkspaces(client, {
        runId: args.runId!,
        outDir: args.outDir!,
        workspaceIds,
        internalSecret: internalSecret!,
        ...(args.blockRows === undefined ? {} : { blockRows: args.blockRows }),
        log: io.out,
      });
      await client.query("COMMIT");
      for (const manifest of manifests) {
        const rows = manifest.tables.reduce((sum, table) => sum + table.count, 0);
        io.out(`exported ${manifest.workspace_id}: ${rows} rows in ${manifest.tables.length} tables`);
      }
      return 0;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      io.err(`export failed: ${errorMessage(err)}`);
      return EXIT_FAILURE;
    } finally {
      client.release();
    }
  });
}
