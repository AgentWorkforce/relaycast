import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { actionInvocations, agentNodeBindings, agents, nodes, workspaceEvents } from '../../db/schema.js';
import { AGENT_LIVENESS_TTL_MS, sweepStaleAgents } from '../../engine/agent.js';
import {
  attachDirectNodeSocket,
  createWorkspace,
  makeNodeStack,
  registerAgent,
  type TestStack,
} from './harness.js';
import { sha256Hex } from '../../lib/crypto.js';

describe('agent presence and release lifecycle', () => {
  let stack: TestStack;

  beforeEach(() => { stack = makeNodeStack(); });
  afterEach(() => stack.close());

  it('derives stale presence without writing during a roster read', async () => {
    const ws = await createWorkspace(stack.app, 'agent-presence-expiry');
    const stale = await registerAgent(stack.app, ws.workspaceKey, 'stale-agent');
    await stack.runtime.deps.db
      .update(agents)
      .set({
        status: 'active',
        lastSeen: new Date(Date.now() - AGENT_LIVENESS_TTL_MS - 1_000),
      })
      .where(eq(agents.id, stale.agentId));

    const response = await stack.app.request('/v1/agents?status=active', {
      headers: { authorization: `Bearer ${ws.workspaceKey}` },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { data: Array<{ name: string }> };
    expect(body.data.map((agent) => agent.name)).not.toContain('stale-agent');

    const [persisted] = await stack.runtime.deps.db
      .select({ status: agents.status })
      .from(agents)
      .where(eq(agents.id, stale.agentId));
    expect(persisted.status).toBe('active');

    expect(await sweepStaleAgents(stack.runtime.deps.db, ws.workspaceId)).toBe(1);
    const [swept] = await stack.runtime.deps.db
      .select({ status: agents.status })
      .from(agents)
      .where(eq(agents.id, stale.agentId));
    expect(swept.status).toBe('offline');
  });

  it('derives stale presence without writing during an agent detail read', async () => {
    const ws = await createWorkspace(stack.app, 'agent-detail-presence-expiry');
    const stale = await registerAgent(stack.app, ws.workspaceKey, 'stale-detail-agent');
    await stack.runtime.deps.db
      .update(agents)
      .set({
        status: 'active',
        lastSeen: new Date(Date.now() - AGENT_LIVENESS_TTL_MS - 1_000),
      })
      .where(eq(agents.id, stale.agentId));

    const response = await stack.app.request(`/v1/agents/${stale.name}`, {
      headers: { authorization: `Bearer ${ws.workspaceKey}` },
    });
    expect(response.status).toBe(200);
    expect((await response.json() as { data: { status: string } }).data.status).toBe('offline');

    const [persisted] = await stack.runtime.deps.db
      .select({ status: agents.status })
      .from(agents)
      .where(eq(agents.id, stale.agentId));
    expect(persisted.status).toBe('active');
  });

  it('leaves future last_seen untouched on reads and lets maintenance clamp it', async () => {
    const ws = await createWorkspace(stack.app, 'agent-future-presence');
    const target = await registerAgent(stack.app, ws.workspaceKey, 'future-agent');
    const beforeRead = Date.now();
    await stack.runtime.deps.db
      .update(agents)
      .set({
        status: 'active',
        lastSeen: new Date(beforeRead + 14 * 60 * 1000),
      })
      .where(eq(agents.id, target.agentId));

    const response = await stack.app.request(`/v1/agents/${target.name}`, {
      headers: { authorization: `Bearer ${ws.workspaceKey}` },
    });
    expect(response.status).toBe(200);
    expect((await response.json() as { data: { status: string } }).data.status).toBe('active');

    const [persisted] = await stack.runtime.deps.db
      .select({ lastSeen: agents.lastSeen })
      .from(agents)
      .where(eq(agents.id, target.agentId));
    expect(persisted.lastSeen.getTime()).toBeGreaterThan(beforeRead);

    expect(await sweepStaleAgents(stack.runtime.deps.db, ws.workspaceId)).toBe(1);
    const afterSweep = Date.now();
    const [normalized] = await stack.runtime.deps.db
      .select({ lastSeen: agents.lastSeen })
      .from(agents)
      .where(eq(agents.id, target.agentId));
    // SQLite timestamp mode stores whole seconds.
    expect(normalized.lastSeen.getTime()).toBeGreaterThanOrEqual(beforeRead - 1_000);
    expect(normalized.lastSeen.getTime()).toBeLessThanOrEqual(afterSweep);
  });

  it('atomically registers human rows with an implicit direct binding', async () => {
    const ws = await createWorkspace(stack.app, 'human-direct-registration');
    const response = await stack.app.request('/v1/agents', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ws.workspaceKey}`,
      },
      body: JSON.stringify({ name: 'direct-human', type: 'human' }),
    });
    expect(response.status).toBe(201);
    const body = await response.json() as { data: { id: string } };
    const nodeId = `node_direct_${body.data.id}`;

    const [agent] = await stack.runtime.deps.db
      .select({ type: agents.type, locationType: agents.locationType, locationNodeId: agents.locationNodeId })
      .from(agents)
      .where(eq(agents.id, body.data.id));
    expect(agent).toEqual({ type: 'human', locationType: 'via_node', locationNodeId: nodeId });
    expect(await stack.runtime.deps.db
      .select()
      .from(nodes)
      .where(and(eq(nodes.workspaceId, ws.workspaceId), eq(nodes.id, nodeId))))
      .toHaveLength(1);
    expect(await stack.runtime.deps.db
      .select()
      .from(agentNodeBindings)
      .where(and(
        eq(agentNodeBindings.workspaceId, ws.workspaceId),
        eq(agentNodeBindings.agentId, body.data.id),
        eq(agentNodeBindings.nodeId, nodeId),
        eq(agentNodeBindings.status, 'active'),
      )))
      .toHaveLength(1);

    const duplicate = await stack.app.request('/v1/agents', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ws.workspaceKey}`,
      },
      body: JSON.stringify({ name: 'direct-human', type: 'human' }),
    });
    expect(duplicate.status).toBe(409);
    // The failed batch inserted its generated direct node before it hit the
    // duplicate agent name; rollback must leave no orphan node behind.
    expect(await stack.runtime.deps.db
      .select()
      .from(nodes)
      .where(eq(nodes.workspaceId, ws.workspaceId)))
      .toHaveLength(1);
  });

  it('fails release explicitly when the agent has no live host', async () => {
    const ws = await createWorkspace(stack.app, 'hostless-agent-release');
    const target = await registerAgent(stack.app, ws.workspaceKey, 'hostless-agent');
    const nodeId = `node_direct_${target.agentId}`;

    const response = await stack.app.request('/v1/agents/release', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ws.workspaceKey}`,
      },
      body: JSON.stringify({ name: target.name, reason: 'stale cleanup' }),
    });
    expect(response.status).toBe(503);
    const body = await response.json() as { error: { code: string; message: string } };
    expect(body.error).toEqual({
      code: 'agent_host_unavailable',
      message: 'Agent "hostless-agent" has no live host node; cannot dispatch release',
    });

    const [agent] = await stack.runtime.deps.db
      .select({ status: agents.status, locationNodeId: agents.locationNodeId })
      .from(agents)
      .where(eq(agents.id, target.agentId));
    expect(agent).toMatchObject({ status: 'active', locationNodeId: nodeId });

    const [binding] = await stack.runtime.deps.db
      .select({ status: agentNodeBindings.status })
      .from(agentNodeBindings)
      .where(and(
        eq(agentNodeBindings.workspaceId, ws.workspaceId),
        eq(agentNodeBindings.agentId, target.agentId),
        eq(agentNodeBindings.nodeId, nodeId),
      ));
    expect(binding.status).toBe('active');

    const [invocation] = await stack.runtime.deps.db
      .select({ status: actionInvocations.status, error: actionInvocations.error })
      .from(actionInvocations)
      .where(and(
        eq(actionInvocations.workspaceId, ws.workspaceId),
        eq(actionInvocations.actionName, 'release'),
      ));
    expect(invocation).toMatchObject({
      status: 'failed',
      error: 'agent_host_unavailable',
    });
  });

  it('deletes a hostless agent and its implicit direct node', async () => {
    const ws = await createWorkspace(stack.app, 'hostless-agent-delete');
    const target = await registerAgent(stack.app, ws.workspaceKey, 'delete-me');
    const nodeId = `node_direct_${target.agentId}`;
    // Reproduce a legacy/orphaned roster row with no dispatchable location.
    await stack.runtime.deps.db
      .update(agents)
      .set({ locationType: 'self_connected', locationNodeId: null })
      .where(eq(agents.id, target.agentId));

    const response = await stack.app.request('/v1/agents/release', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ws.workspaceKey}`,
      },
      body: JSON.stringify({
        name: target.name,
        delete_agent: true,
        expected_token_hash: await sha256Hex(target.token),
      }),
    });
    expect(response.status).toBe(201);
    expect((await response.json() as { data: { status: string; handler_node_id: string | null } }).data)
      .toMatchObject({ status: 'completed', handler_node_id: nodeId });

    // The name is freed; the row is retained as a tombstone so the agent's
    // history keeps its author (relaycast#309).
    expect(await stack.runtime.deps.db
      .select()
      .from(agents)
      .where(and(eq(agents.workspaceId, ws.workspaceId), eq(agents.name, target.name))))
      .toHaveLength(0);
    const [tombstone] = await stack.runtime.deps.db
      .select({ name: agents.name, status: agents.status, tokenHash: agents.tokenHash })
      .from(agents)
      .where(eq(agents.id, target.agentId));
    expect(tombstone).toMatchObject({
      name: `${target.name}#released-${target.agentId}`,
      status: 'released',
    });
    expect(await stack.runtime.deps.db.select().from(nodes).where(eq(nodes.id, nodeId))).toHaveLength(0);
    const [exited] = await stack.runtime.deps.db
      .select({ payload: workspaceEvents.payload })
      .from(workspaceEvents)
      .where(and(
        eq(workspaceEvents.workspaceId, ws.workspaceId),
        eq(workspaceEvents.type, 'agent.exited'),
      ));
    expect(JSON.parse(exited.payload)).toMatchObject({
      agent_id: target.agentId,
      node_id: nodeId,
      reason: 'released',
    });
  });

  it('replays the handler node returned by a keyed local release', async () => {
    const ws = await createWorkspace(stack.app, 'hostless-agent-release-replay');
    const caller = await registerAgent(stack.app, ws.workspaceKey, 'caller');
    const target = await registerAgent(stack.app, ws.workspaceKey, 'release-replay-target');
    const nodeId = `node_direct_${target.agentId}`;
    const invoke = () => stack.app.request('/v1/actions/release/invoke', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${caller.token}`,
        'Idempotency-Key': 'local-release-replay',
      },
      body: JSON.stringify({ input: { name: target.name, delete_agent: true } }),
    });

    const first = await invoke();
    const replay = await invoke();
    expect([first.status, replay.status]).toEqual([201, 201]);
    expect(replay.headers.get('Idempotency-Replayed')).toBe('true');
    const [firstBody, replayBody] = await Promise.all([
      first.json() as Promise<{ data: Record<string, unknown> }>,
      replay.json() as Promise<{ data: Record<string, unknown> }>,
    ]);
    expect(firstBody.data.handler_node_id).toBe(nodeId);
    expect(replayBody).toEqual(firstBody);

    const [invocation] = await stack.runtime.deps.db
      .select({ status: actionInvocations.status, handlerNodeId: actionInvocations.handlerNodeId })
      .from(actionInvocations)
      .where(and(
        eq(actionInvocations.workspaceId, ws.workspaceId),
        eq(actionInvocations.actionName, 'release'),
      ));
    expect(invocation).toEqual({ status: 'completed', handlerNodeId: nodeId });
  });

  it('waits for a durable release dispatch outcome before answering a concurrent replay', async () => {
    const ws = await createWorkspace(stack.app, 'release-dispatch-race-replay');
    const caller = await registerAgent(stack.app, ws.workspaceKey, 'caller');
    const target = await registerAgent(stack.app, ws.workspaceKey, 'release-race-target');
    const targetNode = await attachDirectNodeSocket(stack, ws.workspaceId, target);

    const nodeConnections = stack.runtime.deps.nodeConnections!;
    const originalSend = nodeConnections.sendToProvider.bind(nodeConnections);
    let frameSent!: () => void;
    const frameSentPromise = new Promise<void>((resolve) => { frameSent = resolve; });
    let resumeSend!: () => void;
    const resumeSendPromise = new Promise<void>((resolve) => { resumeSend = resolve; });
    vi.spyOn(nodeConnections, 'sendToProvider').mockImplementation(async (...args) => {
      const sent = await originalSend(...args);
      if (args[3].type !== 'action.invoke' || args[3].action !== 'release') return sent;
      frameSent();
      await resumeSendPromise;
      return sent;
    });

    const invoke = () => stack.app.request('/v1/actions/release/invoke', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${caller.token}`,
        'Idempotency-Key': 'release-dispatch-race',
      },
      body: JSON.stringify({ input: { name: target.name, delete_agent: false } }),
    });

    const freshPromise = invoke();
    await frameSentPromise;
    let replaySettled = false;
    const replayPromise = invoke().then((response) => {
      replaySettled = true;
      return response;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(replaySettled).toBe(false);

    resumeSend();
    const [fresh, replay] = await Promise.all([freshPromise, replayPromise]);
    expect([fresh.status, replay.status]).toEqual([201, 201]);
    expect(replay.headers.get('Idempotency-Replayed')).toBe('true');
    const [freshBody, replayBody] = await Promise.all([
      fresh.json() as Promise<{ data: Record<string, unknown> }>,
      replay.json() as Promise<{ data: Record<string, unknown> }>,
    ]);
    expect(freshBody.data.handler_node_id).toBe(targetNode.nodeId);
    expect(replayBody).toEqual(freshBody);
    expect(targetNode.sock.ofType('action.invoke').filter((event) => event.action === 'release')).toHaveLength(1);
  });

  it('reaps a hostless agent that has already spoken', async () => {
    const ws = await createWorkspace(stack.app, 'hostless-agent-delete-with-history');
    const target = await registerAgent(stack.app, ws.workspaceKey, 'talkative-agent');
    const nodeId = `node_direct_${target.agentId}`;

    // Every agent worth reaping has history. Four FKs reference agents.id
    // without onDelete (channels.created_by, messages.agent_id, files.uploaded_by,
    // webhooks.created_by), so a bare DELETE on the row is refused for any agent
    // that has ever spoken — and inside runAtomicWrites that refusal aborts the
    // binding update and the invocation completion along with it.
    const posted = await stack.app.request('/v1/channels/general/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${target.token}`,
      },
      body: JSON.stringify({ text: 'i have said something' }),
    });
    expect(posted.status).toBe(201);

    await stack.runtime.deps.db
      .update(agents)
      .set({ locationType: 'self_connected', locationNodeId: null })
      .where(eq(agents.id, target.agentId));

    const response = await stack.app.request('/v1/agents/release', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ws.workspaceKey}`,
      },
      body: JSON.stringify({ name: target.name, delete_agent: true }),
    });
    expect(response.status).toBe(201);
    expect((await response.json() as { data: { status: string } }).data)
      .toMatchObject({ status: 'completed' });

    // The name is released and the implicit direct node is gone...
    expect(await stack.runtime.deps.db
      .select()
      .from(agents)
      .where(and(eq(agents.workspaceId, ws.workspaceId), eq(agents.name, target.name))))
      .toHaveLength(0);
    expect(await stack.runtime.deps.db.select().from(nodes).where(eq(nodes.id, nodeId))).toHaveLength(0);

    // ...and the invocation actually completed rather than being aborted.
    const [invocation] = await stack.runtime.deps.db
      .select({ status: actionInvocations.status })
      .from(actionInvocations)
      .where(and(
        eq(actionInvocations.workspaceId, ws.workspaceId),
        eq(actionInvocations.actionName, 'release'),
      ));
    expect(invocation.status).toBe('completed');
  });

  it('refuses to register into the reserved released-agent namespace', async () => {
    const ws = await createWorkspace(stack.app, 'reserved-tombstone-namespace');
    // The tombstone name is only collision-free while nothing else can occupy
    // that namespace. Agent names are otherwise arbitrary strings, so without
    // this guard a caller could pre-register `<victim>#released-<victimId>`
    // and make the victim's release abort the whole atomic unit — the exact
    // failure the tombstone exists to avoid.
    const squatted = await stack.app.request('/v1/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({ name: 'victim#released-12345' }),
    });
    expect(squatted.status).toBe(400);
    expect((await squatted.json() as { error: { code: string } }).error.code).toBe('invalid_agent_name');
  });

  it('keeps released tombstones out of the roster and the presence view', async () => {
    const ws = await createWorkspace(stack.app, 'tombstone-not-a-roster-member');
    const target = await registerAgent(stack.app, ws.workspaceKey, 'ghost-agent');
    await stack.runtime.deps.db
      .update(agents)
      .set({ locationType: 'self_connected', locationNodeId: null })
      .where(eq(agents.id, target.agentId));

    const released = await stack.app.request('/v1/agents/release', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({ name: target.name, delete_agent: true }),
    });
    expect(released.status).toBe(201);

    // A tombstone is retained only so history stays attributable. Every
    // consumer that answers "who is in this workspace" must exclude it —
    // otherwise releasing a name makes it look like a second, permanently
    // offline agent rather than making it disappear.
    const roster = await stack.app.request('/v1/agents', {
      headers: { authorization: `Bearer ${ws.workspaceKey}` },
    });
    const rosterNames = (await roster.json() as { data: Array<{ name: string }> }).data.map((a) => a.name);
    expect(rosterNames).not.toContain(target.name);
    expect(rosterNames.some((n) => n.includes('#released-'))).toBe(false);

    const presence = await stack.app.request('/v1/agents/presence', {
      headers: { authorization: `Bearer ${ws.workspaceKey}` },
    });
    expect(presence.status).toBe(200);
    const presenceNames = (await presence.json() as { data: Array<{ agent_name: string }> })
      .data.map((p) => p.agent_name);
    expect(presenceNames).not.toContain(target.name);
    expect(presenceNames.some((n) => n.includes('#released-'))).toBe(false);
  });

  it('records the caller-supplied release reason on the tombstone', async () => {
    const ws = await createWorkspace(stack.app, 'tombstone-release-reason');
    const target = await registerAgent(stack.app, ws.workspaceKey, 'audited-agent');
    await stack.runtime.deps.db
      .update(agents)
      .set({ locationType: 'self_connected', locationNodeId: null })
      .where(eq(agents.id, target.agentId));

    const response = await stack.app.request('/v1/agents/release', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({ name: target.name, delete_agent: true, reason: 'node decommissioned' }),
    });
    expect(response.status).toBe(201);

    const [tombstone] = await stack.runtime.deps.db
      .select({ metadata: agents.metadata })
      .from(agents)
      .where(eq(agents.id, target.agentId));
    // Same `release` shape the dispatched path writes, so an audit does not
    // have to know which path released the agent.
    expect((tombstone.metadata as { release?: Record<string, unknown> }).release)
      .toMatchObject({ reason: 'node decommissioned', previous_name: target.name });
  });

  it('releases capacity from the binding that local reaping deactivates', async () => {
    const ws = await createWorkspace(stack.app, 'hostless-agent-binding-capacity');
    const target = await registerAgent(stack.app, ws.workspaceKey, 'reap-bound-agent');
    const enrolled = await stack.app.request('/v1/nodes', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ws.workspaceKey}`,
      },
      body: JSON.stringify({
        node_id: 'node_reap_target',
        name: 'reap-target',
        role: 'broker',
        max_agents: 1,
      }),
    });
    expect(enrolled.status).toBe(201);
    const bound = await stack.app.request('/v1/nodes/reap-target/agents', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ws.workspaceKey}`,
      },
      body: JSON.stringify({ agent_name: target.name }),
    });
    expect(bound.status).toBe(201);

    const response = await stack.app.request('/v1/agents/release', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ws.workspaceKey}`,
      },
      body: JSON.stringify({ name: target.name, delete_agent: true }),
    });
    expect(response.status).toBe(201);

    const [node] = await stack.runtime.deps.db
      .select({ activeAgents: nodes.activeAgents })
      .from(nodes)
      .where(and(eq(nodes.workspaceId, ws.workspaceId), eq(nodes.id, 'node_reap_target')));
    expect(node.activeAgents).toBe(0);
    expect(await stack.runtime.deps.db
      .select()
      .from(agentNodeBindings)
      .where(and(
        eq(agentNodeBindings.workspaceId, ws.workspaceId),
        eq(agentNodeBindings.agentId, target.agentId),
        eq(agentNodeBindings.nodeId, 'node_reap_target'),
        eq(agentNodeBindings.status, 'active'),
      )))
      .toHaveLength(0);
  });

  it('rolls back every local reap mutation when invocation completion fails', async () => {
    const ws = await createWorkspace(stack.app, 'hostless-agent-delete-rollback');
    const target = await registerAgent(stack.app, ws.workspaceKey, 'keep-me');
    const nodeId = `node_direct_${target.agentId}`;
    await stack.runtime.deps.db
      .update(agents)
      .set({ locationType: 'self_connected', locationNodeId: null })
      .where(eq(agents.id, target.agentId));
    stack.runtime.handle.sqlite.exec(`
      CREATE TRIGGER fail_local_release_completion
      BEFORE UPDATE ON action_invocations
      WHEN NEW.status = 'completed' AND NEW.action_name = 'release'
      BEGIN
        SELECT RAISE(ABORT, 'forced invocation completion failure');
      END
    `);

    const response = await stack.app.request('/v1/agents/release', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ws.workspaceKey}`,
      },
      body: JSON.stringify({ name: target.name, delete_agent: true }),
    });
    expect(response.status).toBe(500);

    expect(await stack.runtime.deps.db.select().from(agents).where(eq(agents.id, target.agentId))).toHaveLength(1);
    expect(await stack.runtime.deps.db.select().from(nodes).where(eq(nodes.id, nodeId))).toHaveLength(1);
    const [binding] = await stack.runtime.deps.db
      .select({ status: agentNodeBindings.status })
      .from(agentNodeBindings)
      .where(and(
        eq(agentNodeBindings.workspaceId, ws.workspaceId),
        eq(agentNodeBindings.agentId, target.agentId),
        eq(agentNodeBindings.nodeId, nodeId),
      ));
    expect(binding.status).toBe('active');
    const [invocation] = await stack.runtime.deps.db
      .select({ status: actionInvocations.status })
      .from(actionInvocations)
      .where(and(
        eq(actionInvocations.workspaceId, ws.workspaceId),
        eq(actionInvocations.actionName, 'release'),
      ));
    expect(invocation.status).toBe('pending');
  });

  it('dispatches release through a live implicit direct binding', async () => {
    const ws = await createWorkspace(stack.app, 'live-agent-release');
    const target = await registerAgent(stack.app, ws.workspaceKey, 'live-agent');
    const { sock, handle, nodeId } = await attachDirectNodeSocket(stack, ws.workspaceId, target);
    // Legacy directly registered rows can lack a durable location even though
    // their implicit node binding and connection are both live.
    await stack.runtime.deps.db
      .update(agents)
      .set({ locationType: 'self_connected', locationNodeId: null })
      .where(eq(agents.id, target.agentId));

    const response = await stack.app.request('/v1/agents/release', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ws.workspaceKey}`,
      },
      body: JSON.stringify({ name: target.name }),
    });
    expect(response.status).toBe(201);
    const body = await response.json() as {
      data: { status: string; dispatched_node_id: string | null };
    };
    expect(body.data).toMatchObject({ status: 'dispatched', dispatched_node_id: nodeId });
    expect(sock.ofType('action.invoke').at(-1)).toMatchObject({ action: 'release' });
    await handle.handleClose();
  });

  it('rejects a guarded release after same-id takeover without dispatching it', async () => {
    const ws = await createWorkspace(stack.app, 'stale-release-after-takeover');
    const target = await registerAgent(stack.app, ws.workspaceKey, 'taken-over-agent');
    const { sock, handle } = await attachDirectNodeSocket(stack, ws.workspaceId, target);
    const expectedTokenHash = await sha256Hex(target.token);

    const takeover = await stack.app.request(`/v1/agents/${target.name}/takeover`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ws.workspaceKey}`,
      },
      body: JSON.stringify({
        expected_agent_id: target.agentId,
        actor: 'release-cas-test',
        reason: 'replace the process generation',
        session_ref: 'session-replacement',
        node_id: 'node-replacement',
      }),
    });
    expect(takeover.status).toBe(200);

    const response = await stack.app.request('/v1/agents/release', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ws.workspaceKey}`,
      },
      body: JSON.stringify({
        name: target.name,
        delete_agent: true,
        expected_token_hash: expectedTokenHash,
      }),
    });

    expect(response.status).toBe(409);
    expect((await response.json() as { error: { code: string } }).error.code)
      .toBe('agent_release_generation_conflict');
    expect(sock.ofType('action.invoke').filter((event) => event.action === 'release')).toHaveLength(0);
    expect(await stack.runtime.deps.db
      .select()
      .from(actionInvocations)
      .where(and(
        eq(actionInvocations.workspaceId, ws.workspaceId),
        eq(actionInvocations.actionName, 'release'),
      )))
      .toHaveLength(0);
    const [replacement] = await stack.runtime.deps.db
      .select({ id: agents.id, name: agents.name, tokenHash: agents.tokenHash })
      .from(agents)
      .where(eq(agents.id, target.agentId));
    expect(replacement).toMatchObject({ id: target.agentId, name: target.name });
    expect(replacement.tokenHash).not.toBe(expectedTokenHash);
    await handle.handleClose();
  });

  it('revalidates the guarded generation immediately before node dispatch', async () => {
    const ws = await createWorkspace(stack.app, 'release-generation-dispatch-race');
    const target = await registerAgent(stack.app, ws.workspaceKey, 'dispatch-race-agent');
    const { sock, handle } = await attachDirectNodeSocket(stack, ws.workspaceId, target);
    const expectedTokenHash = await sha256Hex(target.token);
    const replacementTokenHash = 'b'.repeat(64);
    const nodeConnections = stack.runtime.deps.nodeConnections!;
    const originalConnected = nodeConnections.isProviderConnected.bind(nodeConnections);
    let rotated = false;
    vi.spyOn(nodeConnections, 'isProviderConnected').mockImplementation((...args) => {
      if (!rotated) {
        rotated = true;
        stack.runtime.handle.sqlite
          .prepare('UPDATE agents SET token_hash = ? WHERE id = ?')
          .run(replacementTokenHash, target.agentId);
      }
      return originalConnected(...args);
    });

    const response = await stack.app.request('/v1/agents/release', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ws.workspaceKey}`,
      },
      body: JSON.stringify({
        name: target.name,
        delete_agent: true,
        expected_token_hash: expectedTokenHash,
      }),
    });

    expect(response.status).toBe(409);
    expect((await response.json() as { error: { code: string } }).error.code)
      .toBe('agent_release_generation_conflict');
    expect(sock.ofType('action.invoke').filter((event) => event.action === 'release')).toHaveLength(0);
    const [replacement] = await stack.runtime.deps.db
      .select({ name: agents.name, status: agents.status, tokenHash: agents.tokenHash })
      .from(agents)
      .where(eq(agents.id, target.agentId));
    expect(replacement).toMatchObject({
      name: target.name,
      status: 'active',
      tokenHash: replacementTokenHash,
    });
    const [invocation] = await stack.runtime.deps.db
      .select({ status: actionInvocations.status, error: actionInvocations.error })
      .from(actionInvocations)
      .where(and(
        eq(actionInvocations.workspaceId, ws.workspaceId),
        eq(actionInvocations.actionName, 'release'),
      ));
    expect(invocation).toEqual({ status: 'failed', error: 'agent_release_generation_conflict' });
    await handle.handleClose();
  });

  it('rejects a malformed release generation guard without dispatch', async () => {
    const ws = await createWorkspace(stack.app, 'invalid-release-generation');
    const target = await registerAgent(stack.app, ws.workspaceKey, 'invalid-guard-agent');
    const { sock, handle } = await attachDirectNodeSocket(stack, ws.workspaceId, target);

    const response = await stack.app.request('/v1/agents/release', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ws.workspaceKey}`,
      },
      body: JSON.stringify({
        name: target.name,
        delete_agent: true,
        expected_token_hash: 'not-a-sha256-hash',
      }),
    });

    expect(response.status).toBe(400);
    expect(sock.ofType('action.invoke').filter((event) => event.action === 'release')).toHaveLength(0);
    expect(await stack.runtime.deps.db
      .select()
      .from(actionInvocations)
      .where(and(
        eq(actionInvocations.workspaceId, ws.workspaceId),
        eq(actionInvocations.actionName, 'release'),
      )))
      .toHaveLength(0);
    await handle.handleClose();
  });
});
