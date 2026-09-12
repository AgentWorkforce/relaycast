import { afterEach, describe, expect, it } from 'vitest';
import { and, count, eq, inArray } from 'drizzle-orm';
import { makeNodeStack, type TestStack } from '../../__tests__/conformance/harness.js';
import { agents, channelMembers, channels, deliveries, messages, workspaces } from '../../db/schema.js';
import { runAtomicWrites } from '../../ports/database.js';
import { buildChannelDeliveryWrite } from '../deliveryWrites.js';
import type { EngineDb } from '../../ports/database.js';

/**
 * Incident regression: `rw_7ccfea89` accumulated 9,778 active rows from two
 * 4,889-recipient broadcasts against a 5,000 cap. The engine bounded only
 * per-recipient mailbox depth, so a single request could grow the workspace
 * aggregate without limit.
 *
 * These are actual-engine tests: they import the real channel delivery builder,
 * run it through `runAtomicWrites` on the real migrated engine schema, and
 * assert workspace-scoped enforcement. The no-policy case characterizes the
 * defect (RED); the policy case proves the atomic guard (GREEN).
 */

const CAP = 5000;
const FANOUT = 4889;
const SENDER = 'agent_sender';

let stack: TestStack | undefined;
afterEach(async () => {
  await stack?.close();
  stack = undefined;
});

async function seedWorkspace(db: EngineDb, fanout: number): Promise<{ ws: string; channel: string }> {
  const ws = 'ws_depth';
  const channel = 'chan_general';
  await db.insert(workspaces).values({ id: ws, name: 'depth-ws', apiKeyHash: 'hash_depth_ws' });
  await db.insert(channels).values({ id: channel, workspaceId: ws, name: 'general' });

  const members: Array<{ id: string; workspaceId: string; name: string; tokenHash: string }> = [
    { id: SENDER, workspaceId: ws, name: 'sender', tokenHash: 'token_sender' },
  ];
  for (let i = 0; i < fanout; i++) {
    members.push({ id: `agent_${i}`, workspaceId: ws, name: `agent_${i}`, tokenHash: `token_${i}` });
  }
  // Chunk to stay well under SQLite's bind-variable ceiling.
  for (let i = 0; i < members.length; i += 500) {
    await db.insert(agents).values(members.slice(i, i + 500));
  }
  for (let i = 0; i < members.length; i += 500) {
    await db.insert(channelMembers).values(
      members.slice(i, i + 500).map((m) => ({ channelId: channel, agentId: m.id })),
    );
  }
  return { ws, channel };
}

async function activeDepth(db: EngineDb, workspaceId: string): Promise<number> {
  const rows = await db
    .select({ depth: count() })
    .from(deliveries)
    .where(and(
      eq(deliveries.workspaceId, workspaceId),
      inArray(deliveries.status, ['queued', 'delivered']),
    ));
  return Number(rows[0]?.depth ?? 0);
}

async function send(
  db: EngineDb,
  ws: string,
  channel: string,
  messageId: string,
  workspacePolicy?: { cap: number; reserve?: number },
): Promise<void> {
  // Deliveries carry a message FK; the real engine writes both in one atomic
  // unit. Seed the message row first so only the delivery guard is under test.
  await db.insert(messages).values({
    id: messageId,
    workspaceId: ws,
    channelId: channel,
    agentId: SENDER,
    body: 'guard-fixture',
  });
  await runAtomicWrites(db, (writeDb) => [
    buildChannelDeliveryWrite(writeDb, {
      workspaceId: ws,
      messageId,
      channelId: channel,
      senderAgentId: SENDER,
      mode: 'immediate',
      ttlMs: 3_600_000,
      depthCap: 1000,
      workspacePolicy,
    }),
  ]);
}

describe('workspace delivery growth guard (channel broadcast)', () => {
  it('RED: without a workspace policy, two broadcasts overshoot the cap', async () => {
    stack = makeNodeStack();
    const db = stack.runtime.deps.db;
    const { ws, channel } = await seedWorkspace(db, FANOUT);

    await send(db, ws, channel, 'msg_a');
    await send(db, ws, channel, 'msg_b');

    const depth = await activeDepth(db, ws);
    expect(depth).toBe(FANOUT * 2);
    expect(depth).toBeGreaterThan(CAP);
  });

  it('GREEN: with a workspace policy, the second broadcast is rejected atomically', async () => {
    stack = makeNodeStack();
    const db = stack.runtime.deps.db;
    const { ws, channel } = await seedWorkspace(db, FANOUT);

    await send(db, ws, channel, 'msg_a', { cap: CAP });
    expect(await activeDepth(db, ws)).toBe(FANOUT);

    await expect(send(db, ws, channel, 'msg_b', { cap: CAP })).rejects.toThrow();

    // The rejected broadcast left no partial fanout: depth stays at one fanout.
    expect(await activeDepth(db, ws)).toBe(FANOUT);
    expect(await activeDepth(db, ws)).toBeLessThanOrEqual(CAP);
  });

  it('GREEN: an oversized single broadcast is rejected at depth zero', async () => {
    stack = makeNodeStack();
    const db = stack.runtime.deps.db;
    const { ws, channel } = await seedWorkspace(db, CAP + 1);

    await expect(send(db, ws, channel, 'msg_big', { cap: CAP })).rejects.toThrow();
    expect(await activeDepth(db, ws)).toBe(0);
  });
});
