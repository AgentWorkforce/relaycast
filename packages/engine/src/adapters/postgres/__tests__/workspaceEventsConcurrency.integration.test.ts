/**
 * Concurrent workspace event appends against the real PostgreSQL fixture
 * (relaycast#658). Skipped unless RELAYCAST_PG_TEST_URL_OWNER, _URL_RUNTIME
 * and RELAYCAST_PG_TEST_CA_FILE are set (see postgres.integration.test.ts).
 * Holds the fixture lock for its whole run; resets the schema as the owner.
 *
 * Appends on a pool handle are group-committed per workspace. Asserts every
 * caller gets the seq of its own row, each workspace's seq is gapless from 1,
 * a reader tailing the log never sees a seq appear behind its cursor, guarded
 * appends interleave correctly, and the events share far fewer commits than
 * there are events.
 */
import { sql } from "drizzle-orm";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadPostgresConfig, type PostgresMode } from "../config.js";
import { loadBundledPostgresMigrations, runPostgresMigrations } from "../migrate.js";
import { openPostgresPool } from "../pool.js";
import { holdFixtureLock, resetSchema, SCHEMA } from "./fixture.js";

const OWNER_URL = process.env.RELAYCAST_PG_TEST_URL_OWNER;
const RUNTIME_URL = process.env.RELAYCAST_PG_TEST_URL_RUNTIME;
const CA_FILE = process.env.RELAYCAST_PG_TEST_CA_FILE;
const enabled = Boolean(OWNER_URL && RUNTIME_URL && CA_FILE);

const WORKSPACES = ["ws_ev_a", "ws_ev_b", "ws_ev_c"];
const SINGLE_APPENDS = 600;
const BATCH_APPENDS = 60;
const BATCH_SIZE = 5;
const GUARDED_APPENDS = 30;

const configFor = (url: string, mode: PostgresMode) =>
  loadPostgresConfig({ RELAYCAST_DATABASE_URL: url, RELAYCAST_DATABASE_CA_FILE: CA_FILE }, mode);

// setupFiles binds this process to 'sqlite'; load a fresh module graph that
// the PostgreSQL handle can bind to 'pg'.
async function freshModules() {
  vi.resetModules();
  return {
    handle: await import("../engineDb.js"),
    t: await import("../../../db/tables.js"),
    events: await import("../../../engine/workspaceEvents.js"),
  };
}

describe.skipIf(!enabled)("PostgreSQL concurrent workspace event appends (integration)", { timeout: 180_000 }, () => {
  let owner: pg.Pool;
  let releaseFixture: (() => Promise<void>) | undefined;
  let m: Awaited<ReturnType<typeof freshModules>>;
  let handle: Awaited<ReturnType<typeof m.handle.openPostgresEngineDb>>;

  beforeAll(async () => {
    m = await freshModules();
    owner = openPostgresPool(configFor(OWNER_URL!, "owner"));
    releaseFixture = await holdFixtureLock(owner);
    await resetSchema(owner);
    await runPostgresMigrations(owner, {
      schema: SCHEMA,
      bundled: loadBundledPostgresMigrations(),
      runtimeRole: "relaycast_runtime",
    });
    handle = await m.handle.openPostgresEngineDb(configFor(RUNTIME_URL!, "runtime"));
    // Waits for the fixture lock while other PostgreSQL test files hold it.
  }, 180_000);

  afterAll(async () => {
    await handle?.close().catch(() => {});
    if (owner) await resetSchema(owner).catch(() => {});
    await releaseFixture?.().catch(() => {});
    await owner?.end().catch(() => {});
  });

  it("group-commits appends with gapless, caller-exact, reader-monotonic seqs", async () => {
    const { db } = handle;
    for (const id of WORKSPACES) await db.insert(m.t.workspaces).values({ id, name: id, apiKeyHash: `hash_${id}` });

    const realtime = { publishToWorkspaceStream: async () => {} };
    const claimed: { workspaceId: string; tag: string; seq: number | null }[] = [];
    const jobs: Promise<unknown>[] = [];
    for (let i = 0; i < SINGLE_APPENDS; i += 1) {
      const workspaceId = WORKSPACES[i % WORKSPACES.length];
      const tag = `single-${i}`;
      jobs.push(m.events.appendWorkspaceEvent(db, workspaceId, { type: "test.single", payload: { tag } })
        .then((seq) => claimed.push({ workspaceId, tag, seq })));
    }
    for (let i = 0; i < BATCH_APPENDS; i += 1) {
      const items = Array.from({ length: BATCH_SIZE }, (_, k) => ({
        workspaceId: WORKSPACES[(i + k) % WORKSPACES.length],
        input: { type: "test.batch", payload: { tag: `batch-${i}-${k}` } },
      }));
      jobs.push(m.events.appendWorkspaceEventBatch(db, items).then((seqs) => items.forEach((item, k) =>
        claimed.push({ workspaceId: item.workspaceId, tag: item.input.payload.tag, seq: seqs[k] }))));
    }
    // Guarded appends take the same lock directly; half of their predicates are false.
    let guardedTrue = 0;
    for (let i = 0; i < GUARDED_APPENDS; i += 1) {
      const workspaceId = WORKSPACES[i % WORKSPACES.length];
      if (i % 2 === 0) guardedTrue += 1;
      jobs.push(m.events.appendAndPublishWorkspaceEventWhen({ db, realtime }, workspaceId,
        { type: "test.guarded", payload: { tag: `guarded-${i}` } }, i % 2 === 0 ? sql`TRUE` : sql`FALSE`));
    }

    // A reader tailing one workspace: once it has read up to `cursor`, no
    // event at or below `cursor` may appear later (no gap filled behind it).
    let done = false;
    const tail = (async () => {
      let cursor = 0;
      const seen: number[] = [];
      while (true) {
        const finished = done;
        const page = await m.events.listWorkspaceEvents(db, WORKSPACES[0], { since: cursor, limit: 500 });
        for (const event of page.events) {
          expect(event.seq).toBe(cursor + 1);
          cursor = event.seq;
          seen.push(event.seq);
        }
        if (finished && page.events.length === 0) return seen;
      }
    })();
    await Promise.all(jobs);
    done = true;
    const tailed = await tail;

    expect(claimed.filter((c) => c.seq === null)).toEqual([]);
    const rows = (await db.execute<{ workspace_id: string; seq: number; payload: string }>(sql`
      SELECT workspace_id, seq, payload FROM workspace_events ORDER BY workspace_id, seq`)).rows;
    const total = SINGLE_APPENDS + BATCH_APPENDS * BATCH_SIZE + guardedTrue;
    expect(rows).toHaveLength(total);
    for (const workspaceId of WORKSPACES) {
      const seqs = rows.filter((r) => r.workspace_id === workspaceId).map((r) => Number(r.seq));
      expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    }
    // Every caller's seq names the row holding its own payload.
    const tagAt = new Map(rows.map((r) => [`${r.workspace_id}|${r.seq}`, JSON.parse(r.payload).tag as string]));
    for (const c of claimed) expect(tagAt.get(`${c.workspaceId}|${c.seq}`)).toBe(c.tag);
    expect(tailed).toEqual(rows.filter((r) => r.workspace_id === WORKSPACES[0]).map((r) => Number(r.seq)));
    // Coalesced: the events share far fewer writing transactions than there are events.
    const [{ n: transactions }] = (await db.execute<{ n: number }>(sql`
      SELECT count(DISTINCT xmin::text)::int AS n FROM workspace_events`)).rows;
    expect(transactions).toBeLessThan(total / 4);
  });
});
