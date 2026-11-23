/**
 * Pool recovery when the database goes away underneath it (relaycast#665).
 * Skipped unless RELAYCAST_PG_TEST_URL_OWNER, _URL_RUNTIME and
 * RELAYCAST_PG_TEST_CA_FILE are set (see postgres.integration.test.ts); the
 * backend-termination case also needs a superuser (RELAYCAST_PG_TEST_URL_ADMIN,
 * default: relaycast_admin with the dev fixture password).
 *
 * An RDS Multi-AZ failover leaves pooled sockets to the old primary half-open:
 * nothing answers and nothing closes. A TCP proxy in front of the server models
 * that by black-holing its existing connections while new ones pass through
 * (DNS now names the new primary). The pool must time out the stuck queries,
 * destroy those clients instead of reusing them, and serve again from fresh
 * connections, for plain queries and transactions alike.
 */
import { readFileSync } from "node:fs";
import net from "node:net";
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";
import { loadPostgresConfig } from "../config.js";
import { isConnectionFatal, openPostgresPool } from "../pool.js";

const OWNER_URL = process.env.RELAYCAST_PG_TEST_URL_OWNER;
const RUNTIME_URL = process.env.RELAYCAST_PG_TEST_URL_RUNTIME;
const CA_FILE = process.env.RELAYCAST_PG_TEST_CA_FILE;
const enabled = Boolean(OWNER_URL && RUNTIME_URL && CA_FILE);

function adminUrl(): string {
  if (process.env.RELAYCAST_PG_TEST_URL_ADMIN) return process.env.RELAYCAST_PG_TEST_URL_ADMIN;
  const url = new URL(OWNER_URL!);
  url.username = "relaycast_admin";
  url.password = "admin-dev-password";
  return url.toString();
}

/** A TCP proxy to `target` that can black-hole every connection it holds. */
async function blackholeProxy(target: { host: string; port: number }) {
  const live = new Set<{ client: net.Socket; upstream: net.Socket }>();
  const every = new Set<net.Socket>();
  const server = net.createServer((client) => {
    const upstream = net.connect(target.port, target.host);
    every.add(client);
    every.add(upstream);
    const pair = { client, upstream };
    live.add(pair);
    client.pipe(upstream);
    upstream.pipe(client);
    const drop = () => { live.delete(pair); client.destroy(); upstream.destroy(); };
    client.on("error", drop);
    upstream.on("error", drop);
    client.on("close", drop);
    upstream.on("close", drop);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    /** Stop forwarding on every current connection without closing any. */
    blackhole() {
      for (const { client, upstream } of live) {
        client.unpipe(upstream);
        upstream.unpipe(client);
        client.pause();
        upstream.pause();
      }
      const held = live.size;
      live.clear();
      return held;
    },
    async close() {
      for (const socket of every) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe.skipIf(!enabled)("PostgreSQL pool failover recovery (integration)", { timeout: 120_000 }, () => {
  // One proxy per pool, so black-holing one test's connections leaves the
  // others alone.
  let proxy: Awaited<ReturnType<typeof blackholeProxy>>;
  const proxies: Awaited<ReturnType<typeof blackholeProxy>>[] = [];
  const pools: pg.Pool[] = [];

  afterAll(async () => {
    for (const each of proxies) await each.close();
    for (const pool of pools) await pool.end().catch(() => {});
  });

  /** A runtime pool through a fresh proxy, with short failover bounds. */
  async function poolThroughProxy() {
    const runtime = new URL(RUNTIME_URL!);
    proxy = await blackholeProxy({ host: runtime.hostname, port: Number(runtime.port || 5432) });
    proxies.push(proxy);
    const url = new URL(RUNTIME_URL!);
    url.port = String(proxy.port);
    const config = loadPostgresConfig({
      RELAYCAST_DATABASE_URL: url.toString(),
      RELAYCAST_DATABASE_CA_FILE: CA_FILE,
      RELAYCAST_DATABASE_QUERY_TIMEOUT_MS: "1500",
      RELAYCAST_DATABASE_CONNECT_TIMEOUT_MS: "5000",
      RELAYCAST_DATABASE_POOL_MAX: "4",
    }, "runtime");
    const pool = openPostgresPool(config);
    pools.push(pool);
    vi.resetModules();
    const { buildPostgresEngineDb } = await import("../engineDb.js");
    return { pool, db: buildPostgresEngineDb(pool) };
  }

  async function pid(pool: pg.Pool): Promise<number> {
    return (await pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  }

  it("times out queries on half-open connections, drops those clients, and serves from fresh ones", async () => {
    const { pool, db } = await poolThroughProxy();
    // Fill the pool: concurrent plain queries and transactions.
    await Promise.all([
      ...Array.from({ length: 4 }, () => pool.query("SELECT pg_sleep(0.05)")),
      ...Array.from({ length: 4 }, () => db.withTransaction((tx) => tx.execute(sql`SELECT 1`))),
    ]);
    expect(pool.totalCount).toBe(4);
    const before = new Set(await Promise.all(Array.from({ length: 4 }, () => pid(pool))));

    expect(proxy.blackhole()).toBe(4);

    // Work handed a dead client fails within the query bound instead of
    // hanging, as a connection-fatal error. (Work queued behind it may already
    // succeed on a fresh connection: that is the recovery.)
    const started = Date.now();
    const stuck = await Promise.allSettled([
      ...Array.from({ length: 4 }, () => pool.query("SELECT 1")),
      ...Array.from({ length: 4 }, () => db.withTransaction((tx) => tx.execute(sql`SELECT 1`))),
    ]);
    expect(Date.now() - started).toBeLessThan(15_000);
    const failures = stuck.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(failures.length).toBeGreaterThan(0);
    for (const failure of failures) expect(isConnectionFatal(failure.reason)).toBe(true);

    // Recovery: fresh connections, never one of the black-holed clients.
    const recovered = Date.now();
    await vi.waitFor(async () => {
      await pool.query("SELECT 1");
    }, { timeout: 10_000, interval: 200 });
    const results = await Promise.all([
      ...Array.from({ length: 4 }, () => pool.query("SELECT 1 AS ok")),
      ...Array.from({ length: 4 }, () => db.withTransaction((tx) => tx.execute(sql`SELECT 1 AS ok`))),
    ]);
    expect(results).toHaveLength(8);
    expect(Date.now() - recovered).toBeLessThan(10_000);
    const after = await Promise.all(Array.from({ length: 4 }, () => pid(pool)));
    for (const backend of after) expect(before.has(backend)).toBe(false);
  });

  it("does not leak pool slots when transactions start on dead connections (BEGIN never answers)", async () => {
    // drizzle's transaction() runs BEGIN outside its try/finally, so a BEGIN
    // that fails used to leave its client checked out forever; with every
    // slot leaked the pool hung for good. Only transactions touch the dead
    // clients here.
    const { pool, db } = await poolThroughProxy();
    await Promise.all(Array.from({ length: 4 }, () => db.withTransaction((tx) => tx.execute(sql`SELECT pg_sleep(0.05)`))));
    expect(pool.totalCount).toBe(4);
    expect(proxy.blackhole()).toBe(4);

    const first = await Promise.allSettled(Array.from({ length: 4 }, () => db.withTransaction((tx) => tx.execute(sql`SELECT 1`))));
    for (const result of first) {
      if (result.status === "rejected") expect(isConnectionFatal(result.reason)).toBe(true);
    }
    // Every slot came back: nothing waits, nothing stays checked out.
    await vi.waitFor(() => {
      expect(pool.waitingCount).toBe(0);
      expect(pool.idleCount).toBe(pool.totalCount);
    }, { timeout: 10_000, interval: 100 });
    const again = await Promise.all(Array.from({ length: 8 }, () => db.withTransaction((tx) => tx.execute(sql`SELECT 1 AS ok`))));
    expect(again).toHaveLength(8);
    await vi.waitFor(() => expect(pool.idleCount).toBe(pool.totalCount), { timeout: 5_000, interval: 100 });
  });

  it("re-dials after the server terminates every backend (restart / failover / pg_terminate_backend)", async () => {
    const { pool, db } = await poolThroughProxy();
    await Promise.all(Array.from({ length: 4 }, () => db.withTransaction((tx) => tx.execute(sql`SELECT pg_sleep(0.05)`))));
    const victims = new Set(await Promise.all(Array.from({ length: 4 }, () => pid(pool))));

    const target = new URL(adminUrl());
    const admin = new pg.Client({
      host: target.hostname,
      port: Number(target.port || 5432),
      user: decodeURIComponent(target.username),
      password: decodeURIComponent(target.password),
      database: target.pathname.slice(1),
      ssl: { ca: readFileSync(CA_FILE!, "utf8"), rejectUnauthorized: true },
    });
    await admin.connect();
    try {
      await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid = ANY($1::int[])", [[...victims]]);
    } finally {
      await admin.end();
    }

    // At most the first use of each dead client fails (57P01 / terminated);
    // nothing hangs, and the pool then serves from new backends.
    await Promise.allSettled(Array.from({ length: 4 }, () => db.withTransaction((tx) => tx.execute(sql`SELECT 1`))));
    const after = await Promise.all(Array.from({ length: 4 }, () => pid(pool)));
    for (const backend of after) expect(victims.has(backend)).toBe(false);
    const ok = await Promise.all(Array.from({ length: 4 }, () => db.withTransaction((tx) => tx.execute(sql`SELECT 1 AS ok`))));
    expect(ok).toHaveLength(4);
  });
});
