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
    // Fixed at connect time: the engine schema is `public`, and only its owner
    // can create in it. Trigger bodies still qualify their relations.
    options: `-c search_path=${config.schema}`
      + (config.idleInTransactionTimeoutMs !== undefined
        ? ` -c idle_in_transaction_session_timeout=${config.idleInTransactionTimeoutMs}`
        : ""),
    ...(config.statementTimeoutMs !== undefined
      ? { statement_timeout: config.statementTimeoutMs }
      : {}),
    ...(config.poolMax !== undefined ? { max: config.poolMax } : {}),
    // Failover recovery (an RDS Multi-AZ failover leaves pooled sockets to the
    // old primary half-open): TCP keepalive so the kernel notices a dead peer,
    // a bounded dial so connecting to the new primary fails fast and retries,
    // and a client-side query bound so an in-flight query cannot hang forever.
    keepAlive: true,
    keepAliveInitialDelayMillis: KEEPALIVE_INITIAL_DELAY_MS,
    connectionTimeoutMillis: config.connectTimeoutMs,
    ...(config.queryTimeoutMs !== undefined ? { query_timeout: config.queryTimeoutMs } : {}),
    types,
  };
}

/** Idle time before the first TCP keepalive probe on a pooled connection. */
export const KEEPALIVE_INITIAL_DELAY_MS = 10_000;

/** SQLSTATE classes/codes after which a connection must not be reused. */
const FATAL_SQLSTATE = /^(08|57P0[1-3]|53300)/;
/** Socket-level error codes after which a connection must not be reused. */
const FATAL_ERRNO = new Set(["ECONNRESET", "ETIMEDOUT", "EPIPE", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH"]);

/**
 * True when `err` means the client's connection is unusable: a lost or reset
 * socket, the server shutting the backend down (failover, restart,
 * pg_terminate_backend), or our own query timeout firing on a socket that
 * stopped answering.
 */
export function isConnectionFatal(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const { code, message } = err as { code?: unknown; message?: unknown };
  if (typeof code === "string" && (FATAL_SQLSTATE.test(code) || FATAL_ERRNO.has(code))) return true;
  return typeof message === "string" && (
    message === "Query read timeout"
    || message.startsWith("Connection terminated")
    || message === "Client was closed and is not queryable"
  );
}

/**
 * Make `client` destroy its socket after a connection-fatal error, so the
 * pool discards it on release instead of handing it out again. node-postgres
 * leaves a client "queryable" after its own query timeout, and drizzle
 * releases transaction clients without an error, so without this a client
 * stuck on the old primary keeps coming back.
 */
export function evictOnFatalErrors(client: pg.PoolClient): void {
  const destroy = (err: unknown) => {
    if (!isConnectionFatal(err)) return;
    const stream = (client as unknown as { connection?: { stream?: { destroy?: () => void } } }).connection?.stream;
    stream?.destroy?.();
    // Checked out: give the slot back now. A caller may never release it
    // (drizzle's transaction() runs BEGIN outside its try/finally, so a BEGIN
    // on a dead connection leaked the client and, one by one, the whole pool).
    checkedOut.get(client)?.(err);
  };
  // A checked-out client's 'error' event has no pool listener; never let it
  // crash the process.
  client.on("error", destroy);
  const query = client.query.bind(client) as (...args: unknown[]) => unknown;
  (client as unknown as { query: (...args: unknown[]) => unknown }).query = (...args: unknown[]) => {
    const last = args[args.length - 1];
    if (typeof last === "function") {
      args[args.length - 1] = (err: unknown, res: unknown) => {
        if (err) destroy(err);
        (last as (e: unknown, r: unknown) => void)(err, res);
      };
      return query(...args);
    }
    const result = query(...args);
    if (result && typeof (result as Promise<unknown>).then === "function") {
      (result as Promise<unknown>).then(undefined, destroy);
    }
    return result;
  };
}

export interface OpenPostgresPoolOptions {
  /**
   * Receives one line per idle-client error. Only the error message is
   * passed, never the config or connection string.
   */
  log?: (message: string) => void;
}

/** Checked-out clients: their idempotent release (see {@link guardCheckout}). */
const checkedOut = new WeakMap<pg.PoolClient, (err?: unknown) => void>();

/**
 * Make a checked-out client's release idempotent and reachable from
 * {@link evictOnFatalErrors}, which releases a dead client with its error
 * (removing it from the pool) even when the caller never does.
 */
function guardCheckout(client: pg.PoolClient): pg.PoolClient {
  const release = client.release.bind(client) as (err?: Error | boolean) => void;
  let released = false;
  const once = (err?: unknown) => {
    if (released) return;
    released = true;
    checkedOut.delete(client);
    release(err instanceof Error ? err : err === undefined ? undefined : new Error(String(err)));
  };
  checkedOut.set(client, once);
  client.release = once as pg.PoolClient["release"];
  return client;
}

/** Open a pool for `config`. Connections are made lazily. */
export function openPostgresPool(
  config: PostgresConfig,
  opts: OpenPostgresPoolOptions = {},
): pg.Pool {
  const pool = new pg.Pool(postgresPoolOptions(config));
  pool.on("connect", (client) => evictOnFatalErrors(client));
  // pool.connect() without a callback is how callers (drizzle transactions)
  // check a client out; pool.query() uses the callback form and releases with
  // the error itself.
  const connect = pool.connect.bind(pool) as (...args: unknown[]) => unknown;
  (pool as unknown as { connect: (...args: unknown[]) => unknown }).connect = (...args: unknown[]) => {
    if (args.length > 0) return connect(...args);
    return (connect() as Promise<pg.PoolClient>).then(guardCheckout);
  };
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
