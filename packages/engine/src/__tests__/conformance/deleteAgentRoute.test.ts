import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createWorkspace, makeNodeStack, registerAgent, type TestStack } from './harness.js';
import { agents, messages } from '../../db/schema.js';

/**
 * `DELETE /v1/agents/:name` -> `agentEngine.deleteAgent` was the last release
 * path still doing a bare DELETE, after `relaycast#309` fixed the local release
 * path and `relaycast#330` fixed the node-completed one.
 *
 * Four FKs reference `agents.id` with no ON DELETE action
 * (`messages.agent_id`, `channels.created_by`, `files.uploaded_by`,
 * `webhooks.created_by`), so the delete is refused for any agent that has ever
 * spoken — and the refusal reaches the operator as raw SQL with the row id in
 * it, observed in production as:
 *
 *   Failed query: delete from "agents" where "agents"."id" = ? params: 2144…
 *
 * This route is what older CLIs call, so it stays reachable after the other two
 * fixes ship.
 */
describe('DELETE /v1/agents/:name preserves attributed history', () => {
  let stack: TestStack;

  beforeEach(() => {
    stack = makeNodeStack();
  });

  afterEach(() => stack.close());

  async function post(token: string, text: string) {
    const res = await stack.app.request('/v1/channels/general/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ text }),
    });
    expect(res.status).toBe(201);
  }

  function removeAgent(workspaceKey: string, name: string) {
    return stack.app.request(`/v1/agents/${name}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${workspaceKey}` },
    });
  }

  // MUST-FIRE: fails before the fix — the bare DELETE is refused by the FK.
  it('removes an agent that has authored messages, keeping the attribution', async () => {
    const ws = await createWorkspace(stack.app, 'route-delete-with-history');
    const target = await registerAgent(stack.app, ws.workspaceKey, 'talkative');
    await post(target.token, 'this message must keep its author');

    const res = await removeAgent(ws.workspaceKey, target.name);
    expect(res.status).toBeLessThan(300);

    // The name is the scarce resource and must be free immediately.
    expect(
      await stack.runtime.deps.db
        .select()
        .from(agents)
        .where(and(eq(agents.workspaceId, ws.workspaceId), eq(agents.name, target.name))),
    ).toHaveLength(0);

    // The row survives as a tombstone so history keeps its author.
    const [tombstone] = await stack.runtime.deps.db
      .select({ name: agents.name, status: agents.status })
      .from(agents)
      .where(eq(agents.id, target.agentId));
    expect(tombstone).toMatchObject({
      name: `${target.name}#released-${target.agentId}`,
      status: 'released',
    });

    // Attribution intact; the old credential is dead; the name is reusable.
    expect(
      await stack.runtime.deps.db.select().from(messages).where(eq(messages.agentId, target.agentId)),
    ).toHaveLength(1);
    const reuse = await stack.app.request('/v1/channels/general/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${target.token}` },
      body: JSON.stringify({ text: 'should be rejected' }),
    });
    expect(reuse.status).toBeGreaterThanOrEqual(400);
    const successor = await registerAgent(stack.app, ws.workspaceKey, target.name);
    expect(successor.agentId).not.toBe(target.agentId);
  });

  // MUST-NOT-FIRE: the silent case must behave identically, so the fix cannot
  // pass by treating one class of agent specially.
  it('removes an agent that never spoke through the same route', async () => {
    const ws = await createWorkspace(stack.app, 'route-delete-no-history');
    const target = await registerAgent(stack.app, ws.workspaceKey, 'silent');

    const res = await removeAgent(ws.workspaceKey, target.name);
    expect(res.status).toBeLessThan(300);
    expect(
      await stack.runtime.deps.db
        .select()
        .from(agents)
        .where(and(eq(agents.workspaceId, ws.workspaceId), eq(agents.name, target.name))),
    ).toHaveLength(0);
  });
});
