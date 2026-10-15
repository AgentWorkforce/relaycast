import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { agents } from '../../db/schema.js';
import { invokeAction } from '../../engine/action.js';
import { createTrigger, fireMessageTriggers, type TriggerMessageInput } from '../../engine/trigger.js';
import { createWorkspace, makeNodeStack, registerAgent, type TestStack } from './harness.js';

// Builtin release is destructive. The trigger input shape (`{trigger_id, message}`)
// is not the guard: a payload that already carries `name` and `delete_agent`
// still must not tombstone an agent. Only the actions invoke route opts in.
describe('message triggers cannot invoke builtin release', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack({ ttlMs: 60_000 }); });
  afterEach(() => stack.close());

  async function agentRow(agentId: string) {
    const [row] = await stack.runtime.deps.db
      .select({ name: agents.name, status: agents.status })
      .from(agents)
      .where(eq(agents.id, agentId));
    return row;
  }

  it('does not tombstone an agent when a release trigger payload includes name and delete_agent', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const ws = await createWorkspace(stack.app, 'trg-release-auth');
      const caller = await registerAgent(stack.app, ws.workspaceKey, 'caller');
      const target = await registerAgent(stack.app, ws.workspaceKey, 'victim');
      const db = stack.runtime.handle.db;
      await createTrigger(db, ws.workspaceId, { channel: 'general', action_name: 'release' });

      const message: TriggerMessageInput = {
        id: 'msg_release',
        channel_id: 'chan_general',
        channel_name: 'general',
        agent_id: caller.agentId,
        agent_name: caller.name,
        text: 'release victim',
        created_at: new Date().toISOString(),
      };
      // Extra fields ride on the trigger payload. Nesting them under `message`
      // is today's input shape; the direct invoke below is that same caller
      // with `name` and `delete_agent` at the top level.
      const payload = { ...message, name: target.name, delete_agent: true };

      const invoked = await fireMessageTriggers({
        db,
        nodeConnections: stack.runtime.realtime,
        workspaceId: ws.workspaceId,
        message: payload,
      });
      expect(invoked).toHaveLength(0);
      expect(warn).toHaveBeenCalledWith('[trigger] action dispatch failed', expect.objectContaining({
        actionName: 'release',
        code: 'action_not_found',
        workspaceId: ws.workspaceId,
      }));

      await expect(invokeAction(
        db,
        ws.workspaceId,
        'release',
        {
          caller_id: caller.agentId,
          caller_name: caller.name,
          input: {
            trigger_id: 'trg_widened',
            message: payload,
            name: target.name,
            delete_agent: true,
          },
        },
        { nodeConnections: stack.runtime.realtime, includeNodeScoped: true },
      )).rejects.toMatchObject({ code: 'action_not_found' });

      expect(await agentRow(target.agentId)).toEqual({ name: target.name, status: 'active' });
    } finally {
      warn.mockRestore();
    }
  });

  it('still releases through POST /v1/actions/release/invoke', async () => {
    const ws = await createWorkspace(stack.app, 'action-release-still');
    const caller = await registerAgent(stack.app, ws.workspaceKey, 'caller');
    const target = await registerAgent(stack.app, ws.workspaceKey, 'action-victim');

    const response = await stack.app.request('/v1/actions/release/invoke', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${caller.token}`,
      },
      body: JSON.stringify({ input: { name: target.name, delete_agent: true } }),
    });
    expect(response.status).toBe(201);
    expect((await response.json() as { data: { status: string } }).data.status).toBe('completed');
    expect(await agentRow(target.agentId)).toEqual({
      name: `${target.name}#released-${target.agentId}`,
      status: 'released',
    });
  });

  it('still releases through POST /v1/agents/release', async () => {
    const ws = await createWorkspace(stack.app, 'agent-release-still');
    const target = await registerAgent(stack.app, ws.workspaceKey, 'route-victim');

    const response = await stack.app.request('/v1/agents/release', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ws.workspaceKey}`,
      },
      body: JSON.stringify({ name: target.name, delete_agent: true }),
    });
    expect(response.status).toBe(201);
    expect((await response.json() as { data: { status: string } }).data.status).toBe('completed');
    expect(await agentRow(target.agentId)).toEqual({
      name: `${target.name}#released-${target.agentId}`,
      status: 'released',
    });
  });
});
