import { afterEach, describe, expect, it } from 'vitest';
import { count, eq, inArray } from 'drizzle-orm';
import { makeNodeStack, type TestStack } from '../../__tests__/conformance/harness.js';
import {
  agents,
  channelMembers,
  channels,
  deliveries,
  workspaces,
} from '../../db/schema.js';
import type { EngineDb } from '../../ports/database.js';
import * as messageEngine from '../message.js';
import * as groupDmEngine from '../groupDm.js';
import { DEFAULT_OFFLINE_FANOUT_EXCLUDE_MS } from '../mailboxConfig.js';

/**
 * Regression: dead agents that never drain their mailbox keep consuming the
 * shared workspace delivery-depth budget forever, because every *new*
 * broadcast charges them one more row on top of their undrained backlog
 * (relaycast-cloud incident: `rw_7ccfea89` hit its delivery-depth cap because
 * ~35 long-offline agents' fanout deliveries alone summed to within a few
 * hundred rows of the ~4984-row cap). Fanout now excludes a recipient from
 * *new* deliveries once it has been continuously offline longer than the
 * configured `offlineExcludeMs` (default 24h), so a dead agent's footprint
 * stops growing instead of competing with live agents for the shared cap.
 */

const SENDER = 'agent_sender';
const LONG_OFFLINE_MS = DEFAULT_OFFLINE_FANOUT_EXCLUDE_MS + 60 * 60 * 1000; // 25h
const SHORT_OFFLINE_MS = 60 * 60 * 1000; // 1h, well within the default threshold

let stack: TestStack | undefined;
afterEach(async () => {
  await stack?.close();
  stack = undefined;
});

async function seedWorkspaceAndChannel(db: EngineDb, ws: string, channel: string) {
  await db.insert(workspaces).values({ id: ws, name: ws, apiKeyHash: `hash_${ws}` });
  await db.insert(channels).values({ id: channel, workspaceId: ws, name: 'general' });
  await db.insert(agents).values({ id: SENDER, workspaceId: ws, name: 'sender', tokenHash: `token_${SENDER}` });
  await db.insert(channelMembers).values({ channelId: channel, agentId: SENDER });
}

async function addMember(
  db: EngineDb,
  ws: string,
  channel: string,
  agentId: string,
  presence: { status: string; offlineForMs?: number },
) {
  await db.insert(agents).values({
    id: agentId,
    workspaceId: ws,
    name: agentId,
    tokenHash: `token_${agentId}`,
    status: presence.status,
    lastSeen: new Date(Date.now() - (presence.offlineForMs ?? 0)),
  });
  await db.insert(channelMembers).values({ channelId: channel, agentId });
}

async function deliveryCount(db: EngineDb, agentId: string): Promise<number> {
  const rows = await db.select({ c: count() }).from(deliveries).where(eq(deliveries.agentId, agentId));
  return Number(rows[0]?.c ?? 0);
}

describe('broadcast fanout excludes long-offline recipients', () => {
  it('skips a long-offline channel member, delivers to an online one, and reports the exclusion', async () => {
    stack = makeNodeStack();
    const db = stack.runtime.deps.db;
    const ws = 'ws_offline_exclude';
    const channel = 'chan_general';
    await seedWorkspaceAndChannel(db, ws, channel);
    await addMember(db, ws, channel, 'agent_online', { status: 'active' });
    await addMember(db, ws, channel, 'agent_dead', { status: 'offline', offlineForMs: LONG_OFFLINE_MS });

    const result = await messageEngine.postMessage(db, ws, channel, SENDER, { text: 'hello' });

    expect(result._deliveries.map((d) => d.agentId)).toEqual(['agent_online']);
    expect(result._delivery_rejections).toEqual([
      expect.objectContaining({ agentId: 'agent_dead', reason: 'recipient_offline' }),
    ]);
    expect(await deliveryCount(db, 'agent_dead')).toBe(0);
    expect(await deliveryCount(db, 'agent_online')).toBe(1);
  });

  it('still delivers to a recently-offline member within the exclusion threshold', async () => {
    stack = makeNodeStack();
    const db = stack.runtime.deps.db;
    const ws = 'ws_recent_offline';
    const channel = 'chan_general';
    await seedWorkspaceAndChannel(db, ws, channel);
    await addMember(db, ws, channel, 'agent_blip', { status: 'offline', offlineForMs: SHORT_OFFLINE_MS });

    const result = await messageEngine.postMessage(db, ws, channel, SENDER, { text: 'hello' });

    expect(result._deliveries.map((d) => d.agentId)).toEqual(['agent_blip']);
    expect(result._delivery_rejections).toEqual([]);
  });

  it('does not let a dead agent accumulate new deliveries across repeated sends', async () => {
    stack = makeNodeStack();
    const db = stack.runtime.deps.db;
    const ws = 'ws_repeated_send';
    const channel = 'chan_general';
    await seedWorkspaceAndChannel(db, ws, channel);
    await addMember(db, ws, channel, 'agent_online', { status: 'active' });
    await addMember(db, ws, channel, 'agent_dead', { status: 'offline', offlineForMs: LONG_OFFLINE_MS });

    for (let i = 0; i < 5; i++) {
      await messageEngine.postMessage(db, ws, channel, SENDER, { text: `msg_${i}` });
    }

    expect(await deliveryCount(db, 'agent_dead')).toBe(0);
    expect(await deliveryCount(db, 'agent_online')).toBe(5);
  });

  it('excludes a long-offline group-DM participant the same way', async () => {
    stack = makeNodeStack();
    const db = stack.runtime.deps.db;
    const ws = 'ws_group_dm_offline';
    await db.insert(workspaces).values({ id: ws, name: ws, apiKeyHash: `hash_${ws}` });
    await db.insert(agents).values([
      { id: SENDER, workspaceId: ws, name: 'sender', tokenHash: `token_${SENDER}` },
      { id: 'agent_online', workspaceId: ws, name: 'agent_online', tokenHash: 'token_online' },
      {
        id: 'agent_dead',
        workspaceId: ws,
        name: 'agent_dead',
        tokenHash: 'token_dead',
        status: 'offline',
        lastSeen: new Date(Date.now() - LONG_OFFLINE_MS),
      },
    ]);

    const conversation = await groupDmEngine.createGroupDm(db, ws, SENDER, {
      participants: ['agent_online', 'agent_dead'],
    });
    const result = await groupDmEngine.postGroupMessage(db, ws, conversation.id, SENDER, { text: 'hi group' });

    expect(result._deliveries.map((d) => d.agentId)).toEqual(['agent_online']);
    expect(result._delivery_rejections).toEqual([
      expect.objectContaining({ agentId: 'agent_dead', reason: 'recipient_offline' }),
    ]);
  });

  it('incident regression: excluding dead members keeps a new broadcast under the workspace cap', async () => {
    stack = makeNodeStack();
    const db = stack.runtime.deps.db;
    const ws = 'ws_cap_regression';
    const channel = 'chan_general';
    await seedWorkspaceAndChannel(db, ws, channel);

    const CAP = 5;
    const DEAD_COUNT = CAP - 1;
    const deadIds = Array.from({ length: DEAD_COUNT }, (_, i) => `agent_dead_${i}`);
    for (const id of deadIds) {
      // Seed while still online, so the earlier broadcast's deliveries are
      // real pre-existing backlog, matching how an agent actually goes dark:
      // it drops off *after* accumulating a mailbox, not before.
      await addMember(db, ws, channel, id, { status: 'active' });
    }
    await messageEngine.postMessage(db, ws, channel, SENDER, { text: 'while everyone was online' }, {
      workspaceDeliveryPolicy: { cap: CAP },
    });
    expect(await db.select({ c: count() }).from(deliveries).then((r) => Number(r[0]?.c ?? 0))).toBe(DEAD_COUNT);

    // Now every one of those agents has gone dark for weeks, and a fresh
    // online agent joins the channel.
    await db.update(agents)
      .set({ status: 'offline', lastSeen: new Date(Date.now() - LONG_OFFLINE_MS) })
      .where(inArray(agents.id, deadIds));
    await addMember(db, ws, channel, 'agent_online', { status: 'active' });

    // Without excluding the dead members, this broadcast would need
    // DEAD_COUNT + 1 new rows on top of the existing DEAD_COUNT depth,
    // overshoot the cap, and roll back entirely — so the online agent would
    // receive nothing. With the exclusion, it needs only 1 new row.
    const result = await messageEngine.postMessage(db, ws, channel, SENDER, { text: 'new message' }, {
      workspaceDeliveryPolicy: { cap: CAP },
    });

    expect(result._deliveries.map((d) => d.agentId)).toEqual(['agent_online']);
    expect(await deliveryCount(db, 'agent_online')).toBe(1);
    for (const id of deadIds) {
      expect(await deliveryCount(db, id)).toBe(1); // only their original, pre-offline delivery
    }
  });
});
