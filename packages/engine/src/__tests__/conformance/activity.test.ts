import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { channels, messages } from '../../db/schema.js';
import { createWorkspace, makeNodeStack, registerAgent, type TestStack } from './harness.js';

describe('activity feed', () => {
  let stack: TestStack;

  beforeEach(() => {
    stack = makeNodeStack();
  });

  afterEach(() => stack.close());

  it('orders by monotonic message id through the workspace index', async () => {
    const workspace = await createWorkspace(stack.app, 'indexed-activity');
    const agent = await registerAgent(stack.app, workspace.workspaceKey, 'activity-author');
    const [general] = await stack.runtime.deps.db
      .select({ id: channels.id })
      .from(channels)
      .where(eq(channels.workspaceId, workspace.workspaceId));

    const lowerId = '100000000000000001';
    const higherId = '100000000000000002';
    await stack.runtime.deps.db.insert(messages).values([
      {
        id: lowerId,
        workspaceId: workspace.workspaceId,
        channelId: general.id,
        agentId: agent.agentId,
        body: 'lower snowflake',
        // Deliberately later: created_at-first ordering would return this row
        // first and make the regression test fail.
        createdAt: new Date('2030-01-02T00:00:00.000Z'),
      },
      {
        id: higherId,
        workspaceId: workspace.workspaceId,
        channelId: general.id,
        agentId: agent.agentId,
        body: 'higher snowflake',
        createdAt: new Date('2030-01-01T00:00:00.000Z'),
      },
    ]);

    const response = await stack.app.request('/v1/activity?limit=2', {
      headers: { authorization: `Bearer ${workspace.workspaceKey}` },
    });
    const body = await response.json() as { data: Array<{ id: string }> };

    expect(response.status).toBe(200);
    expect(body.data.map((item) => item.id)).toEqual([higherId, lowerId]);

    const plan = stack.runtime.handle.sqlite.prepare(`
      EXPLAIN QUERY PLAN
      SELECT messages.id
      FROM messages
      INNER JOIN channels ON messages.channel_id = channels.id
      INNER JOIN agents ON messages.agent_id = agents.id
      LEFT JOIN dm_conversations ON dm_conversations.channel_id = channels.id
      WHERE messages.workspace_id = ?
      ORDER BY messages.id DESC
      LIMIT 20
    `).all(workspace.workspaceId) as Array<{ detail: string }>;
    const details = plan.map((step) => step.detail).join('\n');
    expect(details).toContain('idx_messages_workspace');
    expect(details).toContain('idx_dm_conversations_channel');
    expect(details).not.toContain('USE TEMP B-TREE');
  });
});
