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
 * hostname verification against the configured host. node-postgres does not
 * pass the host to tls.connect, so for IP-literal hosts Node would otherwise
 * verify against "localhost"; checking against `config.host` explicitly makes
 * DNS names and IP SANs behave the same as libpq's verify-full.
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

/** Open a pool for `config`. Connections are made lazily. */
export function openPostgresPool(config: PostgresConfig): pg.Pool {
  const pool = new pg.Pool(postgresPoolOptions(config));
  // An idle client erroring (server restart, network) must not crash the process.
  pool.on("error", () => {});
  return pool;
}

export async function closePostgresPool(pool: pg.Pool): Promise<void> {
  await pool.end();
}
