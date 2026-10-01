import { afterEach, describe, expect, it } from 'vitest';
import { and, count, eq, inArray, sql } from 'drizzle-orm';
import { makeNodeStack, type TestStack } from '../../__tests__/conformance/harness.js';
import { agents, channelMembers, channels, deliveries, messages, workspaces } from '../../db/schema.js';
import { runAtomicWrites } from '../../ports/database.js';
import { buildChannelDeliveryWrite } from '../deliveryWrites.js';
import type { EngineDb } from '../../ports/database.js';
import * as messageEngine from '../message.js';
import * as deliveryEngine from '../delivery.js';
import { WorkspaceDeliveryCapacityError, currentWorkspaceDepth, resolveWorkspaceDeliveryPolicyFor } from '../workspaceDeliveryPolicy.js';

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
      sql`(${deliveries.expiresAt} IS NULL OR ${deliveries.expiresAt} > unixepoch())`,
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

  it('reports active workspace depth for the A2A pre-egress check', async () => {
    stack = makeNodeStack();
    const db = stack.runtime.deps.db;
    const { ws, channel } = await seedWorkspace(db, 3);
    await send(db, ws, channel, 'msg_depth', { cap: CAP });
    expect(await currentWorkspaceDepth(db, ws)).toBe(3);
  });

  it('does not charge expired unswept rows against workspace capacity', async () => {
    stack = makeNodeStack();
    const db = stack.runtime.deps.db;
    const { ws, channel } = await seedWorkspace(db, 1);
    const policy = { cap: 1 };

    await send(db, ws, channel, 'msg_expired', policy);
    await db
      .update(deliveries)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(deliveries.workspaceId, ws));

    // The row deliberately remains stored as `queued`; capacity admission
    // must use effective (unexpired) depth rather than depend on a maintenance
    // sweep having rewritten its durable status first.
    expect(await db
      .select({ status: deliveries.status })
      .from(deliveries)
      .where(eq(deliveries.messageId, 'msg_expired')))
      .toEqual([{ status: 'queued' }]);
    expect(await currentWorkspaceDepth(db, ws)).toBe(0);

    await expect(send(db, ws, channel, 'msg_after_expiry', policy)).resolves.toBeUndefined();
    expect(await activeDepth(db, ws)).toBe(1);
  });

  it('resolves the dynamic host policy through the async resolver, clamped within cap', async () => {
    const config = {
      workspaceDelivery: {
        resolve: async (w: { id: string; plan: string }) =>
          ({ cap: w.plan === 'enterprise' ? 5000 : 500, reserve: 16 }),
      },
    };
    expect(await resolveWorkspaceDeliveryPolicyFor(config, { id: 'ws', plan: 'enterprise' }))
      .toEqual({ cap: 5000, reserve: 16 });
    expect(await resolveWorkspaceDeliveryPolicyFor(config, { id: 'ws', plan: 'free' }))
      .toEqual({ cap: 500, reserve: 16 });
    // No host policy => undefined (self-host has no workspace guard).
    expect(await resolveWorkspaceDeliveryPolicyFor(undefined, { id: 'ws', plan: 'free' })).toBeUndefined();
    // A reserve >= cap is clamped into `0 <= reserve < cap`.
    expect(await resolveWorkspaceDeliveryPolicyFor({ workspaceDelivery: { cap: 100, reserve: 200 } }, { id: 'ws', plan: 'free' }))
      .toEqual({ cap: 100, reserve: 99 });
  });

  it('GREEN: workspace overflow is a distinct capacity kind from mailbox overflow', async () => {
    stack = makeNodeStack();
    const db = stack.runtime.deps.db;
    const { ws, channel } = await seedWorkspace(db, CAP + 1);

    let caught: unknown;
    try {
      await send(db, ws, channel, 'msg_kind', { cap: CAP });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(WorkspaceDeliveryCapacityError);
    expect(caught).toMatchObject({ code: 'workspace_delivery_depth_exceeded', status: 429, retryable: true });
  });
});

describe('workspace delivery guard at real engine entry points', () => {
  it('GREEN: an overflowing broadcast rolls back its message row', async () => {
    stack = makeNodeStack();
    const db = stack.runtime.deps.db;
    const { ws, channel } = await seedWorkspace(db, CAP + 1);

    await expect(
      messageEngine.postMessage(
        db, ws, channel, SENDER, { text: 'overflow' },
        { workspaceDeliveryPolicy: { cap: CAP } },
      ),
    ).rejects.toThrow();

    const rows = await db.select({ c: count() }).from(messages).where(eq(messages.workspaceId, ws));
    expect(Number(rows[0]?.c ?? 0)).toBe(0);
    expect(await activeDepth(db, ws)).toBe(0);
  });

  it('GREEN: a duplicate delivery (zero new rows) is not rejected at capacity', async () => {
    stack = makeNodeStack();
    const db = stack.runtime.deps.db;
    const { ws, channel } = await seedWorkspace(db, FANOUT);
    const policy = { cap: CAP };

    const first = await messageEngine.postMessage(
      db, ws, channel, SENDER, { text: 'first' },
      { workspaceDeliveryPolicy: policy },
    );
    expect(await activeDepth(db, ws)).toBe(FANOUT);

    // Re-run the exact same message id: every candidate delivery already exists,
    // so the guard must charge zero new rows and admit without growth.
    await runAtomicWrites(db, (writeDb) => [
      buildChannelDeliveryWrite(writeDb, {
        workspaceId: ws,
        messageId: first.id,
        channelId: channel,
        senderAgentId: SENDER,
        mode: 'immediate',
        ttlMs: 3_600_000,
        depthCap: 1000,
        workspacePolicy: policy,
      }),
    ]);
    expect(await activeDepth(db, ws)).toBe(FANOUT);
  });

  it('GREEN: failed→queued defer is rejected at cap; delta=0 defer stays allowed', async () => {
    stack = makeNodeStack();
    const db = stack.runtime.deps.db;
    const { ws, channel } = await seedWorkspace(db, 1);
    const policy = { cap: 1 };
    const recipient = 'agent_0';

    const m1 = await messageEngine.postMessage(
      db, ws, channel, SENDER, { text: 'one' },
      { workspaceDeliveryPolicy: policy },
    );
    const d1 = `del_${m1.id}_${recipient}`;
    await deliveryEngine.failDelivery(db, ws, recipient, d1);
    expect(await activeDepth(db, ws)).toBe(0);

    // Fill back to the cap, then a failed→queued restoration would grow past it.
    const m2 = await messageEngine.postMessage(
      db, ws, channel, SENDER, { text: 'two' },
      { workspaceDeliveryPolicy: policy },
    );
    const d2 = `del_${m2.id}_${recipient}`;
    await expect(
      deliveryEngine.deferDelivery(db, ws, recipient, d1, {
        availableAt: new Date(),
        workspacePolicy: policy,
      }),
    ).rejects.toBeInstanceOf(WorkspaceDeliveryCapacityError);
    expect(await activeDepth(db, ws)).toBe(1);

    // Delta=0 (queued→queued) remains operable at/over cap.
    const queuedDefer = await deliveryEngine.deferDelivery(db, ws, recipient, d2, {
      availableAt: new Date(Date.now() + 60_000),
      workspacePolicy: policy,
    });
    expect(queuedDefer?.changed).toBe(true);
  });
});
