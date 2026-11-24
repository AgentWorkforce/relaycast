import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inArray, sql } from 'drizzle-orm';
import { createWorkspace, makeNodeStack, registerAgent, type TestStack } from './harness.js';
import { channels, dmConversations, dmParticipants, messages } from '../../db/tables.js';
import { listConversations } from '../../engine/dm.js';
import { latestMessageIdsByChannel, listAllDmConversations } from '../../engine/dmAll.js';
import { queryInChunks } from '../../lib/queryChunks.js';
import type { EngineDb } from '../../ports/database.js';

// More than one D1-safe IN chunk (90), so the per-chunk lookup is exercised.
const CONVERSATIONS = 95;

describe('DM conversation last-message preview', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack(); });
  afterEach(async () => { await stack.close(); });

  // The pre-fix shape: max(id) per channel over the whole IN list.
  async function groupedMax(db: EngineDb, channelIds: string[]) {
    const rows = await queryInChunks(channelIds, (ids) => db
      .select({ channelId: messages.channelId, lastId: sql<string>`max(${messages.id})` })
      .from(messages)
      .where(inArray(messages.channelId, ids))
      .groupBy(messages.channelId));
    return new Map(rows.map(row => [row.channelId, row.lastId]));
  }

  it('picks the same latest message per channel as max(id) GROUP BY, including empty channels', async () => {
    const ws = await createWorkspace(stack.app, 'dm-preview');
    const me = await registerAgent(stack.app, ws.workspaceKey, 'me');
    const peer = await registerAgent(stack.app, ws.workspaceKey, 'peer');
    const db = stack.runtime.deps.db;
    const pad = (n: number) => String(n).padStart(3, '0');
    const channelIds = Array.from({ length: CONVERSATIONS }, (_, i) => `dm_channel_${pad(i)}`);
    await db.insert(channels).values(channelIds.map(id => ({ id, workspaceId: ws.workspaceId, name: id, channelType: 1 })));
    await db.insert(dmConversations).values(channelIds.map((channelId, i) => ({
      id: `dm_${pad(i)}`, workspaceId: ws.workspaceId, channelId, dmType: '1:1', createdAt: new Date(1_700_000_000_000 + i * 1000),
    })));
    await db.insert(dmParticipants).values(channelIds.flatMap((_, i) => [me.agentId, peer.agentId].map(agentId => ({ conversationId: `dm_${pad(i)}`, agentId }))));
    // Every 7th channel stays empty; the rest get 1..5 messages. Mixed-length
    // ids pin text ordering ('m9' sorts after 'm10'), which max() also uses.
    const rows = channelIds.flatMap((channelId, i) => i % 7 === 0 ? [] : Array.from({ length: (i % 5) + 1 }, (_, n) => ({
      id: `m${i}_${n === 0 ? 10 : 9 - n}`, workspaceId: ws.workspaceId, channelId, agentId: n % 2 ? me.agentId : peer.agentId, body: `body ${i}/${n}`,
    })));
    for (let at = 0; at < rows.length; at += 50) await db.insert(messages).values(rows.slice(at, at + 50));

    const expected = await groupedMax(db, channelIds);
    expect(expected.size).toBe(CONVERSATIONS - Math.ceil(CONVERSATIONS / 7));
    expect(expected.get('dm_channel_001')).toBe('m1_8');

    const latest = await latestMessageIdsByChannel(db, channelIds);
    expect(latest).toHaveLength(CONVERSATIONS);
    expect(new Map(latest.filter(row => row.lastId !== null).map(row => [row.channelId, row.lastId]))).toEqual(expected);
    expect(latest.filter(row => row.lastId === null).map(row => row.channelId).sort())
      .toEqual(channelIds.filter(id => !expected.has(id)));

    const previews = new Map((await listConversations(db, ws.workspaceId, me.agentId, {}))
      .map(conv => [conv.id, conv.last_message?.id ?? null]));
    expect(previews.size).toBe(CONVERSATIONS);
    for (const [i, channelId] of channelIds.entries()) expect(previews.get(`dm_${pad(i)}`)).toBe(expected.get(channelId) ?? null);

    const workspaceView = await listAllDmConversations(db, ws.workspaceId);
    expect(workspaceView).toHaveLength(CONVERSATIONS);
    const bodyById = new Map(rows.map(row => [row.id, row.body]));
    for (const conv of workspaceView) {
      const lastId = expected.get(conv.channel_id);
      expect(conv.last_message?.text ?? null).toBe(lastId ? bodyById.get(lastId) : null);
    }
  });
});
