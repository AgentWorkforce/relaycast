import { isIP } from "node:net";
import { checkServerIdentity, type PeerCertificate } from "node:tls";
import pg from "pg";
import type { PostgresConfig } from "./config.js";

const INT8_OID = 20;

/**
 * int8 -> number, refusing values a JS number cannot represent exactly. The
 * pg default returns strings; schema.pg.ts declares bigint columns with
 * `mode: 'number'`, matching the SQLite adapter's numbers.
 */
export function parseInt8(value: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n))
    throw new RangeError(`int8 value ${value} exceeds Number.MAX_SAFE_INTEGER`);
  return n;
}

/**
 * TLS options: the configured CA only, certificate verification on, and
 * hostname verification against the configured host. node-postgres 8.23
 * already passes `host` to tls.connect and sets `servername` (SNI) for DNS
 * names, but these options are merged into its tls.connect options, so the
 * engine pins verification itself rather than relying on that: `servername`
 * for DNS names only (SNI must not be an IP, RFC 6066), and an explicit
 * `checkServerIdentity` against `config.host`, so DNS names and IP SANs are
 * verified like libpq's verify-full whatever the driver version does.
 */
export function postgresTlsOptions(config: PostgresConfig) {
  return {
    ca: config.ca,
    rejectUnauthorized: true as const,
    minVersion: "TLSv1.2" as const,
    ...(isIP(config.host) === 0 ? { servername: config.host } : {}),
    checkServerIdentity: (_servername: string, cert: PeerCertificate) =>
      checkServerIdentity(config.host, cert),
  };
}

/** node-postgres pool options for a validated config (exported for tests). */
export function postgresPoolOptions(config: PostgresConfig): pg.PoolConfig {
  const types = new pg.TypeOverrides();
  types.setTypeParser(INT8_OID, parseInt8);
  return {
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    ssl: postgresTlsOptions(config),
    application_name: `relaycast-engine:${config.mode}`,
    // Convenience only: every engine statement, migration and trigger body
    // schema-qualifies its relations.
    options: `-c search_path=${config.schema}`,
    ...(config.statementTimeoutMs !== undefined
      ? { statement_timeout: config.statementTimeoutMs }
      : {}),
    ...(config.poolMax !== undefined ? { max: config.poolMax } : {}),
    types,
  };
}

export interface OpenPostgresPoolOptions {
  /**
   * Receives one line per idle-client error. Only the error message is
   * passed, never the config or connection string.
   */
  log?: (message: string) => void;
}

/** Open a pool for `config`. Connections are made lazily. */
export function openPostgresPool(
  config: PostgresConfig,
  opts: OpenPostgresPoolOptions = {},
): pg.Pool {
  const pool = new pg.Pool(postgresPoolOptions(config));
  // An idle client erroring (server restart, network) must not crash the
  // process; the pool discards that client. Report it, without config.
  pool.on("error", (err: Error) => {
    opts.log?.(
      `postgres pool: idle client error: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
  return pool;
}

export async function closePostgresPool(pool: pg.Pool): Promise<void> {
  await pool.end();
}
