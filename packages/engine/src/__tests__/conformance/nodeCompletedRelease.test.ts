import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { attachDirectNodeSocket, createWorkspace, makeNodeStack, registerAgent, type TestStack } from './harness.js';
import { actionInvocations, agents, messages } from '../../db/schema.js';

/**
 * `relaycast#309` gave the LOCAL release path (`dispatchRelease` ->
 * `completeLocally`) a tombstone, because four FKs reference `agents.id` with
 * no ON DELETE action — `messages.agent_id`, `channels.created_by`,
 * `files.uploaded_by`, `webhooks.created_by` — so a bare DELETE is refused for
 * any agent that has ever spoken.
 *
 * The NODE-COMPLETED path (`applyReleaseCompletionEffect`) kept the bare
 * DELETE. Because it runs inside the completion's atomic unit, the FK refusal
 * aborts the invocation completion along with it: the invocation is stuck at
 * `dispatched` forever, the seat and the name stay claimed, and the caller sees
 * a plausible-looking receipt. Observed in production on 2026-08-15, where the
 * split was exactly "agent has authored messages / has not" across five agents.
 */
describe('node-completed release preserves attributed history', () => {
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

  async function release(workspaceKey: string, name: string) {
    const res = await stack.app.request('/v1/agents/release', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${workspaceKey}` },
      body: JSON.stringify({ name, delete_agent: true }),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as { data: { status: string; invocation_id: string } };
  }

  // MUST-FIRE: fails before the fix — the completion aborts on the FK and the
  // agent is never released.
  it('tombstones an agent that has spoken when a NODE completes the release', async () => {
    const ws = await createWorkspace(stack.app, 'node-release-with-history');
    const target = await registerAgent(stack.app, ws.workspaceKey, 'spoke-then-released');
    await post(target.token, 'this message must keep its author');
    // A LIVE node binding is what routes the release through
    // `applyReleaseCompletionEffect` instead of the local tombstone path.
    const { handle } = await attachDirectNodeSocket(stack, ws.workspaceId, target);

    const { data } = await release(ws.workspaceKey, target.name);
    expect(data.status).toBe('dispatched');

    // Drive the node side of the handshake: this is what the broker does.
    await handle.handleMessage(JSON.stringify({
      v: 1,
      type: 'action.result',
      invocation_id: data.invocation_id,
      output: { released: true },
    }));

    const [invocation] = await stack.runtime.deps.db
      .select({ status: actionInvocations.status })
      .from(actionInvocations)
      .where(eq(actionInvocations.id, data.invocation_id));
    expect(invocation.status).toBe('completed');

    // The name — the scarce resource — must be free for immediate reuse.
    expect(
      await stack.runtime.deps.db
        .select()
        .from(agents)
        .where(and(eq(agents.workspaceId, ws.workspaceId), eq(agents.name, target.name))),
    ).toHaveLength(0);

    // The row survives as a tombstone so history keeps its author.
    const [tombstone] = await stack.runtime.deps.db
      .select({ name: agents.name, status: agents.status, tokenHash: agents.tokenHash })
      .from(agents)
      .where(eq(agents.id, target.agentId));
    expect(tombstone).toMatchObject({
      name: `${target.name}#released-${target.agentId}`,
      status: 'released',
    });

    // Attribution intact, and the old credential is dead.
    expect(
      await stack.runtime.deps.db.select().from(messages).where(eq(messages.agentId, target.agentId)),
    ).toHaveLength(1);
    const reuse = await stack.app.request('/v1/channels/general/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${target.token}` },
      body: JSON.stringify({ text: 'should be rejected' }),
    });
    expect(reuse.status).toBeGreaterThanOrEqual(400);

    // And the freed name is genuinely reusable.
    const successor = await registerAgent(stack.app, ws.workspaceKey, target.name);
    expect(successor.agentId).not.toBe(target.agentId);
  });

  // MUST-NOT-FIRE: an agent with no history must release identically, so the
  // fix cannot pass by making the silent case behave differently.
  it('releases an agent that never spoke through the same node-completed path', async () => {
    const ws = await createWorkspace(stack.app, 'node-release-no-history');
    const target = await registerAgent(stack.app, ws.workspaceKey, 'never-spoke');
    const { handle } = await attachDirectNodeSocket(stack, ws.workspaceId, target);

    const { data } = await release(ws.workspaceKey, target.name);
    expect(data.status).toBe('dispatched');
    await handle.handleMessage(JSON.stringify({
      v: 1,
      type: 'action.result',
      invocation_id: data.invocation_id,
      output: { released: true },
    }));

    const [invocation] = await stack.runtime.deps.db
      .select({ status: actionInvocations.status })
      .from(actionInvocations)
      .where(eq(actionInvocations.id, data.invocation_id));
    expect(invocation.status).toBe('completed');
    expect(
      await stack.runtime.deps.db
        .select()
        .from(agents)
        .where(and(eq(agents.workspaceId, ws.workspaceId), eq(agents.name, target.name))),
    ).toHaveLength(0);
  });
});
