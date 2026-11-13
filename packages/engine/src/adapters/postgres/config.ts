import { createHash, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { ConfigError, secretFromEnv } from "../../bin/secretEnv.js";

/**
 * Which identity a process connects as. The migration Job is `owner`; the
 * server (and `verify-db`) is `runtime`.
 */
export type PostgresMode = "owner" | "runtime";

/** Validated Postgres connection settings. Never log this object; use {@link describePostgresConfig}. */
export interface PostgresConfig {
  mode: PostgresMode;
  host: string;
  port: number;
  database: string;
  /** Login user from the URL. Not trusted: identity checks compare against {@link expectedRole}. */
  user: string;
  password: string | undefined;
  /** CA bundle (PEM) that must sign the server certificate. */
  ca: string;
  /** sha256 (hex) of the CA file bytes, for logs. */
  caSha256: string;
  schema: string;
  ownerRole: string;
  runtimeRole: string;
  /** The role this process must be: ownerRole in owner mode, runtimeRole in runtime mode. */
  expectedRole: string;
  poolMax: number | undefined;
  statementTimeoutMs: number | undefined;
  /**
   * How long to wait for a new connection (TCP + TLS + startup). After a
   * failover the DNS name points at the new primary; a dial to an unreachable
   * address must fail fast so the pool retries instead of hanging.
   */
  connectTimeoutMs: number;
  /**
   * Client-side bound on one query, runtime mode only (undefined in owner
   * mode, where migrations may run long). A query on a half-open socket (the
   * old primary after a failover) otherwise never returns; on timeout the
   * client is destroyed rather than reused.
   */
  queryTimeoutMs: number | undefined;
  /** Server-side `idle_in_transaction_session_timeout`, runtime mode only. */
  idleInTransactionTimeoutMs: number | undefined;
}

/** Default {@link PostgresConfig.connectTimeoutMs}. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
/** Default {@link PostgresConfig.queryTimeoutMs} for the runtime. */
export const DEFAULT_QUERY_TIMEOUT_MS = 60_000;
/** Default {@link PostgresConfig.idleInTransactionTimeoutMs} for the runtime. */
export const DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS = 60_000;

/** The only schema the bundled migrations and schema.pg.ts target. */
export const DEFAULT_SCHEMA = "public";
export const DEFAULT_OWNER_ROLE = "relaycast_owner";
export const DEFAULT_RUNTIME_ROLE = "relaycast_runtime";

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;
const ALLOWED_SSLMODE = "verify-full";
const REFUSED_SSLMODES = new Set([
  "disable",
  "allow",
  "prefer",
  "require",
  "verify-ca",
]);
const TLS_FILE_PARAMS = new Set([
  "sslrootcert",
  "sslcert",
  "sslkey",
  "sslpassword",
  "sslcrl",
]);

function identifierFromEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: string,
): string {
  const value = env[name]?.trim() || fallback;
  if (!IDENTIFIER.test(value)) {
    throw new ConfigError(
      `${name} must be a lowercase SQL identifier ([a-z_][a-z0-9_]*, at most 63 characters)`,
    );
  }
  return value;
}

function positiveIntFromEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  { min, max }: { min: number; max: number },
): number | undefined {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  if (!/^\d+$/.test(raw)) throw new ConfigError(`${name} must be an integer`);
  const n = Number(raw);
  if (n < min || n > max)
    throw new ConfigError(`${name} must be between ${min} and ${max}`);
  return n;
}

interface ParsedUrl {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string | undefined;
}

/**
 * Parse RELAYCAST_DATABASE_URL. Errors name the variable and the offending
 * part, never the URL or password. TLS settings are not taken from the URL:
 * the only accepted query parameter is `sslmode=verify-full`.
 */
export function parseDatabaseUrl(raw: string): ParsedUrl {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // URL's own error carries the input; never surface it.
    throw new ConfigError("RELAYCAST_DATABASE_URL is not a valid URL");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new ConfigError(
      "RELAYCAST_DATABASE_URL must use the postgres:// or postgresql:// scheme",
    );
  }
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  if (!host)
    throw new ConfigError(
      "RELAYCAST_DATABASE_URL must name a TCP host (Unix sockets are not supported)",
    );
  if (host.includes(","))
    throw new ConfigError("RELAYCAST_DATABASE_URL must name exactly one host");
  const port = url.port ? Number(url.port) : 5432;
  let database: string;
  let user: string;
  let password: string | undefined;
  try {
    database = decodeURIComponent(url.pathname.replace(/^\//, ""));
    user = decodeURIComponent(url.username);
    password = url.password ? decodeURIComponent(url.password) : undefined;
  } catch {
    throw new ConfigError(
      "RELAYCAST_DATABASE_URL has invalid percent-encoding",
    );
  }
  if (!database || database.includes("/"))
    throw new ConfigError("RELAYCAST_DATABASE_URL must name a database");
  if (!user)
    throw new ConfigError("RELAYCAST_DATABASE_URL must include a user");
  // node-postgres falls back to PGPASSWORD / ~/.pgpass for a missing password;
  // credentials come only from the URL.
  if (password === undefined)
    throw new ConfigError("RELAYCAST_DATABASE_URL must include a password");

  for (const [key, value] of url.searchParams) {
    if (key === "sslmode") {
      if (value === ALLOWED_SSLMODE) continue;
      if (REFUSED_SSLMODES.has(value)) {
        throw new ConfigError(
          `RELAYCAST_DATABASE_URL sets sslmode=${value}; only verify-full is accepted (or omit sslmode)`,
        );
      }
      throw new ConfigError(
        "RELAYCAST_DATABASE_URL has an unknown sslmode; only verify-full is accepted",
      );
    }
    if (TLS_FILE_PARAMS.has(key)) {
      throw new ConfigError(
        `RELAYCAST_DATABASE_URL sets ${key}; TLS material comes only from RELAYCAST_DATABASE_CA_FILE`,
      );
    }
    if (key === "ssl") {
      throw new ConfigError(
        "RELAYCAST_DATABASE_URL sets ssl; TLS is always on with certificate verification",
      );
    }
    throw new ConfigError(
      `RELAYCAST_DATABASE_URL has unsupported parameter ${JSON.stringify(key)}`,
    );
  }
  return { host, port, database, user, password };
}

/**
 * PG* environment variables node-postgres reads for settings the pool cannot
 * pin (it only consults them when the explicit option is falsy). Host, port,
 * user, password, database, options, application_name and ssl are always set
 * explicitly, so PGHOST, PGSSLMODE, PGOPTIONS and friends cannot alter the
 * connection; these could, so their presence is refused.
 */
const UNPINNABLE_PG_ENV = [
  "PGREPLICATION",
  "PGBINARY",
  "PGCLIENT_ENCODING",
  "PGSSLNEGOTIATION",
] as const;

function refuseUnpinnablePgEnv(env: NodeJS.ProcessEnv): void {
  const set = UNPINNABLE_PG_ENV.filter(
    (name) => env[name] !== undefined && env[name] !== "",
  );
  if (set.length) {
    throw new ConfigError(
      `${set.join(", ")} must be unset: they would alter the PostgreSQL connection`,
    );
  }
}

/**
 * Read and validate the CA bundle: PEM certificates only (no private keys),
 * each one parseable, at least one a CA certificate.
 */
export function readCaFile(path: string): { ca: string; caSha256: string } {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (err) {
    const code =
      err instanceof Error && "code" in err ? String(err.code) : "read error";
    throw new ConfigError(`RELAYCAST_DATABASE_CA_FILE is unreadable (${code})`);
  }
  const pem = bytes.toString("utf8");
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(pem)) {
    throw new ConfigError(
      "RELAYCAST_DATABASE_CA_FILE contains a private key; it must hold CA certificates only",
    );
  }
  const blocks =
    pem.match(
      /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g,
    ) ?? [];
  if (blocks.length === 0) {
    throw new ConfigError(
      "RELAYCAST_DATABASE_CA_FILE is not a PEM certificate bundle",
    );
  }
  let anyCa = false;
  for (const block of blocks) {
    let cert: X509Certificate;
    try {
      cert = new X509Certificate(block);
    } catch {
      throw new ConfigError(
        "RELAYCAST_DATABASE_CA_FILE contains a certificate that does not parse",
      );
    }
    if (cert.ca) anyCa = true;
  }
  if (!anyCa)
    throw new ConfigError(
      "RELAYCAST_DATABASE_CA_FILE has no CA certificate (basicConstraints CA:TRUE)",
    );
  return {
    ca: pem,
    caSha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

/**
 * Build the Postgres config from the environment.
 *
 * - `RELAYCAST_DATABASE_URL` / `RELAYCAST_DATABASE_URL_FILE` (required)
 * - `RELAYCAST_DATABASE_CA_FILE` (required, PEM)
 * - `RELAYCAST_DATABASE_SCHEMA` (default `relaycast`; the bundled migrations
 *   target only `relaycast`, so any other value is refused)
 * - `RELAYCAST_DATABASE_OWNER_ROLE` (default `relaycast_owner`)
 * - `RELAYCAST_DATABASE_RUNTIME_ROLE` (default `relaycast_runtime`)
 * - `RELAYCAST_DATABASE_POOL_MAX` (optional, 1-100)
 * - `RELAYCAST_DATABASE_STATEMENT_TIMEOUT_MS` (optional, 0-86400000)
 */
export function loadPostgresConfig(
  env: NodeJS.ProcessEnv,
  mode: PostgresMode,
): PostgresConfig {
  refuseUnpinnablePgEnv(env);
  if (env !== process.env) refuseUnpinnablePgEnv(process.env);
  const rawUrl = secretFromEnv(env, "RELAYCAST_DATABASE_URL");
  if (!rawUrl)
    throw new ConfigError(
      "RELAYCAST_DATABASE_URL (or RELAYCAST_DATABASE_URL_FILE) is required",
    );
  const url = parseDatabaseUrl(rawUrl);

  // NODE_EXTRA_CA_CERTS is how a platform that already mounts a CA for every
  // Node service delivers it. Either way the file below is the only trust root.
  const caFile =
    env.RELAYCAST_DATABASE_CA_FILE?.trim() || env.NODE_EXTRA_CA_CERTS?.trim();
  if (!caFile)
    throw new ConfigError(
      "RELAYCAST_DATABASE_CA_FILE (or NODE_EXTRA_CA_CERTS) is required (PEM CA bundle for verify-full TLS)",
    );
  const { ca, caSha256 } = readCaFile(caFile);

  const schema = identifierFromEnv(
    env,
    "RELAYCAST_DATABASE_SCHEMA",
    DEFAULT_SCHEMA,
  );
  if (schema !== DEFAULT_SCHEMA) {
    throw new ConfigError(
      `RELAYCAST_DATABASE_SCHEMA must be ${DEFAULT_SCHEMA}; the bundled migrations target only that schema`,
    );
  }
  const ownerRole = identifierFromEnv(
    env,
    "RELAYCAST_DATABASE_OWNER_ROLE",
    DEFAULT_OWNER_ROLE,
  );
  const runtimeRole = identifierFromEnv(
    env,
    "RELAYCAST_DATABASE_RUNTIME_ROLE",
    DEFAULT_RUNTIME_ROLE,
  );
  if (ownerRole === runtimeRole) {
    throw new ConfigError(
      "RELAYCAST_DATABASE_OWNER_ROLE and RELAYCAST_DATABASE_RUNTIME_ROLE must differ",
    );
  }

  const statementTimeoutMs = positiveIntFromEnv(
    env,
    "RELAYCAST_DATABASE_STATEMENT_TIMEOUT_MS",
    { min: 0, max: 86_400_000 },
  );
  const queryTimeoutMs = positiveIntFromEnv(env, "RELAYCAST_DATABASE_QUERY_TIMEOUT_MS", {
    min: 1_000,
    max: 86_400_000,
  });

  return {
    mode,
    ...url,
    ca,
    caSha256,
    schema,
    ownerRole,
    runtimeRole,
    expectedRole: mode === "owner" ? ownerRole : runtimeRole,
    poolMax: positiveIntFromEnv(env, "RELAYCAST_DATABASE_POOL_MAX", {
      min: 1,
      max: 100,
    }),
    statementTimeoutMs,
    connectTimeoutMs: positiveIntFromEnv(env, "RELAYCAST_DATABASE_CONNECT_TIMEOUT_MS", {
      min: 1_000,
      max: 300_000,
    }) ?? DEFAULT_CONNECT_TIMEOUT_MS,
    queryTimeoutMs: mode === "runtime"
      // A client bound shorter than the server's statement_timeout would cut
      // off statements the operator allowed; keep it just above.
      ? Math.max(queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS, statementTimeoutMs ? statementTimeoutMs + 5_000 : 0)
      : undefined,
    idleInTransactionTimeoutMs: mode === "runtime"
      ? positiveIntFromEnv(env, "RELAYCAST_DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS", { min: 1_000, max: 86_400_000 })
        ?? DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS
      : undefined,
  };
}

/** Log-safe summary: no URL, user or password. */
export function describePostgresConfig(
  config: PostgresConfig,
): Record<string, string | number> {
  return {
    mode: config.mode,
    host: config.host,
    port: config.port,
    database: config.database,
    schema: config.schema,
    expectedRole: config.expectedRole,
    caSha256: config.caSha256,
  };
}
