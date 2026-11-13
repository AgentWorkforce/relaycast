/**
 * Concurrent channel posts against the real PostgreSQL fixture (relaycast#651).
 * Skipped unless RELAYCAST_PG_TEST_URL_OWNER, _URL_RUNTIME and
 * RELAYCAST_PG_TEST_CA_FILE are set (see postgres.integration.test.ts).
 * Holds the fixture lock for its whole run; resets the schema as the owner.
 *
 * Every member of a channel also posts to it, while every member's agent row
 * takes liveness updates, so posts on shared channels contend on the same
 * recipients, alongside DMs. Asserts no post fails or is retried as a
 * deadlock victim, every member gets exactly one delivery per message it did
 * not send, and each recipient's delivery seq is a gapless 1..n run whose order
 * agrees with every other member's order for the same channel.
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

const WS = "ws_conc";
// The relaycast#651 bench shape: 5 channels of 20 members in one workspace.
const CHANNELS = 5;
const MEMBERS_PER_CHANNEL = 20;
const POSTS_PER_POSTER = 4;

const configFor = (url: string, mode: PostgresMode) =>
  loadPostgresConfig({ RELAYCAST_DATABASE_URL: url, RELAYCAST_DATABASE_CA_FILE: CA_FILE }, mode);

// setupFiles binds this process to 'sqlite'; load a fresh module graph that
// the PostgreSQL handle can bind to 'pg'.
async function freshModules() {
  vi.resetModules();
  return {
    handle: await import("../engineDb.js"),
    t: await import("../../../db/tables.js"),
    message: await import("../../../engine/message.js"),
    dm: await import("../../../engine/dm.js"),
  };
}

describe.skipIf(!enabled)("PostgreSQL concurrent channel posts (integration)", { timeout: 180_000 }, () => {
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

  it("posts concurrently to shared channels with no deadlock, loss, duplicate or reordering", async () => {
    const { db } = handle;
    const { t } = m;
    await db.insert(t.workspaces).values({ id: WS, name: WS, apiKeyHash: "hash_conc" });
    // Channels overlap: agent i is in channels i % CHANNELS and (i + 1) % CHANNELS,
    // so the member sets of different channels intersect in both id orders.
    const agentIds = Array.from({ length: (CHANNELS * MEMBERS_PER_CHANNEL) / 2 }, (_, i) => `agent_${String(i).padStart(3, "0")}`);
    const now = new Date();
    await db.insert(t.agents).values(agentIds.map((id) => ({
      id, workspaceId: WS, name: id, tokenHash: `token_${id}`, status: "online", lastSeen: now,
    })));
    const members = new Map<string, string[]>();
    for (let c = 0; c < CHANNELS; c += 1) {
      const id = `ch_${c}`;
      await db.insert(t.channels).values({ id, workspaceId: WS, name: `c${c}` });
      members.set(id, []);
    }
    agentIds.forEach((agentId, i) => {
      for (const c of [i % CHANNELS, (i + 1) % CHANNELS]) members.get(`ch_${c}`)!.push(agentId);
    });
    for (const [channelId, ids] of members) {
      await db.insert(t.channelMembers).values(ids.map((agentId) => ({ channelId, agentId })));
    }

    // Each poster posts sequentially to each of its channels (one request in
    // flight per channel, like the bench); all posters run at once.
    const warn = vi.spyOn(console, "warn");
    const failures: unknown[] = [];
    const posted: { channelId: string; sender: string; id: string }[] = [];
    const jobs: Promise<void>[] = [];
    for (const [channelId, ids] of members) {
      for (const sender of ids) {
        jobs.push((async () => {
          for (let n = 0; n < POSTS_PER_POSTER; n += 1) {
            try {
              const msg = await m.message.postMessage(db as never, WS, channelId, sender, { text: `${sender} ${n}` });
              posted.push({ channelId, sender, id: msg.id });
            } catch (err) {
              failures.push(err);
            }
          }
        })());
      }
    }
    // DMs between members, which lock the recipient and sender rows too.
    agentIds.forEach((sender, i) => {
      jobs.push((async () => {
        for (let n = 0; n < POSTS_PER_POSTER; n += 1) {
          try {
            await m.dm.sendDm(db as never, WS, sender, { to: agentIds[(i + 1 + n) % agentIds.length], text: `dm ${n}` });
          } catch (err) {
            failures.push(err);
          }
        }
      })());
    });
    // Liveness writes (the heartbeat/ack presence update's shape) on the same
    // agent rows while the posts run.
    let posting = true;
    const liveness = (async () => {
      while (posting) {
        await Promise.all(agentIds.map((id) => db.update(t.agents)
          .set({ lastSeen: new Date(), status: sql`CASE WHEN ${t.agents.status} = 'offline' THEN 'online' ELSE ${t.agents.status} END` })
          .where(sql`${t.agents.id} = ${id}`)));
      }
    })();
    await Promise.all(jobs);
    posting = false;
    await liveness;

    // The 40P01 retry is a safety net: a passing run must never need it.
    expect(warn.mock.calls.filter(([line]) => String(line).includes("deadlock victim"))).toEqual([]);
    warn.mockRestore();
    const failureText = failures.map((e) => String((e as { cause?: unknown }).cause ?? e)).slice(0, 3);
    expect(failureText).toEqual([]);
    expect(posted).toHaveLength(CHANNELS * MEMBERS_PER_CHANNEL * POSTS_PER_POSTER);

    const rows = (await db.execute<{ agent_id: string; message_id: string; seq: number; channel_id: string }>(sql`
      SELECT d.agent_id, d.message_id, d.seq, m.channel_id
      FROM deliveries d JOIN messages m ON m.id = d.message_id
      WHERE d.workspace_id = ${WS}
      ORDER BY d.agent_id, d.seq`)).rows;
    const all = rows.map((r) => `${r.agent_id}|${r.message_id}`);
    expect(new Set(all).size).toBe(all.length);
    expect(rows.filter((r) => r.channel_id.startsWith("dmch_"))).toHaveLength(agentIds.length * POSTS_PER_POSTER);

    // Exactly one delivery per (recipient, message) for every member but the sender.
    const expected = new Set<string>();
    for (const p of posted) {
      for (const agentId of members.get(p.channelId)!) if (agentId !== p.sender) expected.add(`${agentId}|${p.id}`);
    }
    expect(new Set(rows.filter((r) => !r.channel_id.startsWith("dmch_")).map((r) => `${r.agent_id}|${r.message_id}`))).toEqual(expected);

    // Per recipient, seq (channel and DM deliveries share it) is gapless 1..n;
    // and the relative order of any two channel messages is the same for every recipient that got both.
    const byAgent = new Map<string, typeof rows>();
    for (const r of rows) byAgent.set(r.agent_id, [...(byAgent.get(r.agent_id) ?? []), r]);
    const position = new Map<string, Map<string, number>>();
    for (const [agentId, list] of byAgent) {
      expect(list.map((r) => Number(r.seq))).toEqual(list.map((_, i) => i + 1));
      position.set(agentId, new Map(list.map((r, i) => [r.message_id, i])));
    }
    for (const [channelId, ids] of members) {
      let reference: string[] | undefined;
      for (const agentId of ids) {
        const pos = position.get(agentId)!;
        const order = posted.filter((p) => p.channelId === channelId && pos.has(p.id))
          .map((p) => p.id).sort((a, b) => pos.get(a)! - pos.get(b)!);
        if (!reference) { reference = order; continue; }
        const common = new Set(order.filter((id) => reference!.includes(id)));
        expect(order.filter((id) => common.has(id))).toEqual(reference.filter((id) => common.has(id)));
      }
    }
  });
});
