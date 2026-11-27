import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dmConversations, messages } from '../../db/tables.js';
import { createWorkspace, makeNodeStack, registerAgent, type TestStack } from './harness.js';
import { conformancePgDb } from './pgMode.js';

/**
 * Snowflake ids are decimal TEXT that widened from 17 to 18 digits in 2025-10.
 * History spanning that change must page in numeric order: bare text order
 * puts every `9…` 17-digit id after (newer than) any `1…` 18-digit id, and
 * text `before`/`after` cursors skip across the boundary.
 */
const NARROW = ['98000000000000001', '98000000000000002', '98000000000000003']; // 17 digits, older
const WIDE = ['100000000000000001', '100000000000000002', '100000000000000003']; // 18 digits, newer

describe('message history across the snowflake width change', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack(); });
  afterEach(async () => { await stack.close(); });

  const get = async (token: string, path: string) => {
    const res = await stack.app.request(path, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    return ((await res.json()).data as Array<{ id: string }>).map((m) => m.id);
  };

  async function seed(workspaceId: string, channelId: string, agentId: string) {
    const ids = [...NARROW, ...WIDE];
    await stack.runtime.deps.db.insert(messages).values(ids.map((id, i) => ({
      id,
      workspaceId,
      channelId,
      agentId,
      body: `m-${id}`,
      createdAt: new Date(Date.UTC(2025, 9, 1, 0, 0, i)),
    })));
  }

  /** Every cursor shape a client uses, against one history endpoint. */
  async function expectNumericPaging(token: string, path: string, newest: string[]) {
    const all = [...newest, ...[...WIDE].reverse(), ...[...NARROW].reverse()];
    const q = (params: string) => get(token, `${path}?${params}`);

    expect(await q('limit=100')).toEqual(all);
    // `before` crossing the width boundary, entirely and mid-page.
    expect(await q(`limit=100&before=${WIDE[0]}`)).toEqual([...NARROW].reverse());
    expect(await q(`limit=2&before=${WIDE[1]}`)).toEqual([WIDE[0], NARROW[2]]);
    // `after` crossing it (newest-first page of everything newer).
    expect(await q(`limit=100&after=${NARROW[2]}`)).toEqual([...newest, ...[...WIDE].reverse()]);
    expect(await q(`limit=100&after=${NARROW[0]}&before=${WIDE[1]}`)).toEqual([WIDE[0], NARROW[2], NARROW[1]]);
    // Equal-width cursors are unchanged.
    expect(await q(`limit=1&before=${WIDE[2]}`)).toEqual([WIDE[1]]);
    expect(await q(`limit=100&before=${NARROW[2]}`)).toEqual([NARROW[1], NARROW[0]]);
    expect(await q(`limit=100&after=${WIDE[0]}`)).toEqual([...newest, WIDE[2], WIDE[1]]);
    // Polling after the newest seeded id, and cursors that leave no interval.
    expect(await q(`limit=100&after=${WIDE[2]}`)).toEqual(newest);
    expect(await q(`limit=100&after=${WIDE[0]}&before=${NARROW[2]}`)).toEqual([]);
    expect(await q(`limit=100&after=${WIDE[1]}&before=${WIDE[1]}`)).toEqual([]);

    // Walking `before` pages visits every message exactly once, in order.
    const walked: string[] = [];
    let page = await q('limit=2');
    while (page.length > 0) {
      walked.push(...page);
      page = await q(`limit=2&before=${page[page.length - 1]}`);
    }
    expect(walked).toEqual(all);
  }

  it('pages channel history numerically through the channel length-id index', async () => {
    const ws = await createWorkspace(stack.app, 'mixed-width-channel');
    const agent = await registerAgent(stack.app, ws.workspaceKey, 'author');
    const created = await stack.app.request('/v1/channels', {
      method: 'POST',
      headers: { authorization: `Bearer ${agent.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'history' }),
    });
    expect(created.status).toBe(201);
    const channelId = (await created.json()).data.id as string;
    await seed(ws.workspaceId, channelId, agent.agentId);

    await expectNumericPaging(agent.token, '/v1/channels/history/messages', []);

    if (conformancePgDb()) return;
    // Every statement each cursor shape runs is an index range read
    // newest-first: never a scan of the whole channel, never a sort. An empty
    // poll after the newest id is the common case to keep cheap.
    const sqlite = stack.runtime.handle.sqlite;
    const prepare = sqlite.prepare.bind(sqlite);
    const plans = async (params: string) => {
      const seen: string[] = [];
      sqlite.prepare = ((source: string) => {
        if (/from "messages"/i.test(source) && source.includes('length(')) seen.push(source);
        return prepare(source);
      }) as typeof sqlite.prepare;
      try {
        await get(agent.token, `/v1/channels/history/messages?${params}`);
      } finally {
        sqlite.prepare = prepare;
      }
      expect(seen.length).toBeGreaterThan(0);
      return seen.map((source) => {
        const nulls = Array.from(source.matchAll(/\?/g), () => null);
        return (prepare(`EXPLAIN QUERY PLAN ${source}`).all(...nulls) as Array<{ detail: string }>)
          .map((step) => step.detail).join('\n');
      });
    };
    for (const params of [`after=${WIDE[2]}`, `before=${WIDE[1]}`, `after=${NARROW[0]}&before=${WIDE[1]}`, 'limit=2']) {
      for (const plan of await plans(`limit=50&${params}`)) {
        expect(plan, params).not.toContain('TEMP B-TREE');
        if (params === 'limit=2') expect(plan).toContain('idx_messages_channel_length_id (channel_id=?)');
        else expect(plan, params).toMatch(/idx_messages_channel_length_id \(channel_id=\? AND <expr>[<>=]/);
      }
    }
  });

  it('pages DM history numerically on the agent and workspace-key routes', async () => {
    const ws = await createWorkspace(stack.app, 'mixed-width-dm');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    await registerAgent(stack.app, ws.workspaceKey, 'bob');
    const sent = await stack.app.request('/v1/dm', {
      method: 'POST',
      headers: { authorization: `Bearer ${alice.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ to: 'bob', text: 'opener' }),
    });
    expect(sent.status).toBe(201);
    const opener = (await sent.json()).data as { id: string; conversation_id: string };
    // The opener has a real, current (18+ digit) id: newest of all.
    expect(opener.id.length).toBeGreaterThanOrEqual(18);
    const [conv] = await stack.runtime.deps.db
      .select({ channelId: dmConversations.channelId })
      .from(dmConversations)
      .where(eq(dmConversations.id, opener.conversation_id));
    await seed(ws.workspaceId, conv.channelId, alice.agentId);

    await expectNumericPaging(alice.token, `/v1/dm/${opener.conversation_id}/messages`, [opener.id]);
    await expectNumericPaging(
      ws.workspaceKey,
      `/v1/dm/conversations/${opener.conversation_id}/messages`,
      [opener.id],
    );
  });
});
