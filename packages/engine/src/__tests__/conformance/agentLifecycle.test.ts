import { invokeWithConcurrentReplay } from './invocationReplay.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { actionInvocations, agentNodeBindings, agents, channelMembers, deliveries, nodeProviders, nodes, pendingEvents, workspaceEvents } from '../../db/schema.js';
import { AGENT_LIVENESS_TTL_MS, sweepStaleAgents } from '../../engine/agent.js';
import { bindAgentToNode } from '../../engine/node.js';
import { NODE_LIVENESS_TTL_MS } from '../../engine/placement.js';
import {
  attachDirectNodeSocket,
  attachFakeBatch,
  createWorkspace,
  deliverFramesOfType,
  FakeSocket,
  injectInsertFailure,
  injectUpdateFailure,
  makeNodeStack,
  registerAgent,
  stripTransactionCapability,
  type TestStack,
} from './harness.js';
import { sha256Hex } from '../../lib/crypto.js';
import type { EngineDb, TransactionCapability } from '../../ports/database.js';

describe('agent presence and release lifecycle', () => {
  let stack: TestStack;

  beforeEach(() => { stack = makeNodeStack(); });
  afterEach(() => stack.close());

  it('suppresses implicit membership by explicit registration contract and invalidates default membership cache', async () => {
    const ws = await createWorkspace(stack.app, 'registration-isolation');
    const readGeneral = async () => {
      const response = await stack.app.request('/v1/channels/general', {
        headers: { authorization: `Bearer ${ws.workspaceKey}` },
      });
      expect(response.status).toBe(200);
      return (await response.json()).data;
    };
    await readGeneral(); // Prime the cache before registration.
    const response = await stack.app.request('/v1/agents', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({ name: 'isolated', auto_join_general: false }),
    });
    expect(response.status).toBe(201);
    const isolated = (await response.json()).data;
    expect(await stack.runtime.deps.db.select().from(channelMembers)
      .where(eq(channelMembers.agentId, isolated.id))).toEqual([]);
    const ordinary = await registerAgent(stack.app, ws.workspaceKey, 'ordinary');
    expect((await readGeneral()).members.map((member: { agent_id: string }) => member.agent_id))
      .toContain(ordinary.agentId);
  });

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

  it('requires a durable key and replays an exact immutable-id release only once', async () => {
    const ws = await createWorkspace(stack.app, 'exact-release-idempotency');
    const target = await registerAgent(stack.app, ws.workspaceKey, 'exact-target');
    const subscription = await stack.app.request('/v1/subscriptions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({ events: ['action.invoked'], url: 'http://127.0.0.1:1/hook' }),
    });
    expect(subscription.status).toBe(201);
    const body = {
      name: target.name,
      expected_agent_id: target.agentId,
      delete_agent: true,
    };
    const request = (key?: string) => stack.app.request('/v1/agents/release-exact', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ws.workspaceKey}`,
        ...(key ? { 'Idempotency-Key': key } : {}),
      },
      body: JSON.stringify(body),
    });

    expect((await request()).status).toBe(400);
    const first = await request('exact-release-key');
    const replay = await request('exact-release-key');
    expect([first.status, replay.status]).toEqual([201, 201]);
    expect(replay.headers.get('Idempotency-Replayed')).toBe('true');
    expect(await stack.runtime.deps.db.select().from(actionInvocations).where(and(
      eq(actionInvocations.workspaceId, ws.workspaceId),
      eq(actionInvocations.actionName, 'release'),
    ))).toHaveLength(1);
    expect(await stack.runtime.deps.db.select({ eventType: pendingEvents.eventType })
      .from(pendingEvents)
      .where(and(
        eq(pendingEvents.workspaceId, ws.workspaceId),
        eq(pendingEvents.eventType, 'action.invoked'),
      ))).toHaveLength(1);
  });

  it('accepts a node credential for exact release without making self-delete unreplayable', async () => {
    const ws = await createWorkspace(stack.app, 'exact-release-node-auth');
    const target = await registerAgent(stack.app, ws.workspaceKey, 'node-release-target');
    const nodeResponse = await stack.app.request('/v1/nodes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({ node_id: 'node-release-caller', name: 'release-caller', role: 'broker', max_agents: 1 }),
    });
    expect(nodeResponse.status).toBe(201);
    const node = await nodeResponse.json() as { data: { token: string } };

    const response = await stack.app.request('/v1/agents/release-exact', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${node.data.token}`,
        'Idempotency-Key': 'node-exact-release',
      },
      body: JSON.stringify({ name: target.name, expected_agent_id: target.agentId, delete_agent: true }),
    });
    expect(response.status).toBe(201);
    expect((await response.json() as { data: { status: string } }).data.status).toBe('completed');
  });

  it('rejects agent-token self-delete before claiming an unreplayable operation', async () => {
    const ws = await createWorkspace(stack.app, 'exact-release-self-delete');
    const target = await registerAgent(stack.app, ws.workspaceKey, 'self-delete-target');
    const response = await stack.app.request('/v1/agents/release-exact', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${target.token}`,
        'Idempotency-Key': 'self-delete-key',
      },
      body: JSON.stringify({ name: target.name, expected_agent_id: target.agentId, delete_agent: true }),
    });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: { code: string } }).error.code)
      .toBe('agent_self_release_requires_workspace_key');
    expect(await stack.runtime.deps.db.select().from(actionInvocations).where(and(
      eq(actionInvocations.workspaceId, ws.workspaceId),
      eq(actionInvocations.actionName, 'release'),
    ))).toHaveLength(0);
  });

  it('fails an identity-only release at the provider boundary without synthetic completion', async () => {
    const ws = await createWorkspace(stack.app, 'exact-release-identity-owner-race');
    const target = await registerAgent(stack.app, ws.workspaceKey, 'identity-owner-race');
    const { handle } = await attachDirectNodeSocket(stack, ws.workspaceId, target);
    const nodeConnections = stack.runtime.deps.nodeConnections!;
    const originalSend = nodeConnections.sendAuthorizedActionToProvider!.bind(nodeConnections);
    let invalidated = false;
    vi.spyOn(nodeConnections, 'sendAuthorizedActionToProvider').mockImplementation(async (...args) => {
      if (!invalidated && args[3].action === 'release') {
        invalidated = true;
        stack.runtime.handle.sqlite.prepare(
          `UPDATE agent_node_bindings SET status = 'inactive', updated_at = unixepoch()
           WHERE workspace_id = ? AND agent_id = ?`,
        ).run(ws.workspaceId, target.agentId);
      }
      return originalSend(...args);
    });

    const response = await stack.app.request('/v1/agents/release-exact', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ws.workspaceKey}`,
        'Idempotency-Key': 'identity-owner-race',
      },
      body: JSON.stringify({ name: target.name, expected_agent_id: target.agentId, delete_agent: true }),
    });
    expect(invalidated).toBe(true);
    expect(response.status).toBe(409);
    expect((await response.json() as { error: { code: string } }).error.code)
      .toBe('agent_identity_mismatch');
    const [agent] = await stack.runtime.deps.db.select({ name: agents.name, status: agents.status })
      .from(agents).where(eq(agents.id, target.agentId));
    expect(agent).toEqual({ name: target.name, status: 'active' });
    const [invocation] = await stack.runtime.deps.db.select({ status: actionInvocations.status, error: actionInvocations.error })
      .from(actionInvocations).where(and(
        eq(actionInvocations.workspaceId, ws.workspaceId),
        eq(actionInvocations.actionName, 'release'),
      ));
    expect(invocation).toEqual({ status: 'failed', error: 'agent_identity_mismatch' });
    await handle.handleClose();
  });

  it('persists and replays an identity-only local CAS conflict', async () => {
    const ws = await createWorkspace(stack.app, 'exact-release-identity-cas-replay');
    const target = await registerAgent(stack.app, ws.workspaceKey, 'identity-cas-replay');
    const { handle } = await attachDirectNodeSocket(stack, ws.workspaceId, target);
    const nodeConnections = stack.runtime.deps.nodeConnections!;
    const originalConnected = nodeConnections.isProviderConnected.bind(nodeConnections);
    let invalidated = false;
    vi.spyOn(nodeConnections, 'isProviderConnected').mockImplementation((...args) => {
      if (!invalidated) {
        invalidated = true;
        stack.runtime.handle.sqlite.pragma('foreign_keys = OFF');
        stack.runtime.handle.sqlite.prepare('UPDATE agents SET id = ? WHERE id = ?')
          .run('identity-cas-replaced', target.agentId);
        stack.runtime.handle.sqlite.prepare('UPDATE agent_node_bindings SET agent_id = ? WHERE agent_id = ?')
          .run('identity-cas-replaced', target.agentId);
        stack.runtime.handle.sqlite.prepare('UPDATE channel_members SET agent_id = ? WHERE agent_id = ?')
          .run('identity-cas-replaced', target.agentId);
        stack.runtime.handle.sqlite.pragma('foreign_keys = ON');
      }
      return originalConnected(...args) && false;
    });

    const invoke = () => stack.app.request('/v1/agents/release-exact', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ws.workspaceKey}`,
        'Idempotency-Key': 'identity-cas-replay',
      },
      body: JSON.stringify({ name: target.name, expected_agent_id: target.agentId, delete_agent: true }),
    });
    const first = await invoke();
    expect(invalidated).toBe(true);
    expect(first.status).toBe(409);
    expect((await first.json() as { error: { code: string } }).error.code)
      .toBe('agent_identity_mismatch');
    const replay = await invoke();
    expect(replay.status).toBe(409);
    expect((await replay.json() as { error: { code: string } }).error.code)
      .toBe('agent_identity_mismatch');
    const [invocation] = await stack.runtime.deps.db.select({ status: actionInvocations.status, error: actionInvocations.error })
      .from(actionInvocations).where(and(
        eq(actionInvocations.workspaceId, ws.workspaceId),
        eq(actionInvocations.actionName, 'release'),
      ));
    expect(invocation).toEqual({ status: 'failed', error: 'agent_identity_mismatch' });
    await handle.handleClose();
  });

  it('fails closed on a replacement identity and rejects an idempotency-key payload swap', async () => {
    const ws = await createWorkspace(stack.app, 'exact-release-replacement');
    const oldAgent = await registerAgent(stack.app, ws.workspaceKey, 'old-agent');
    const replacement = await registerAgent(stack.app, ws.workspaceKey, 'replacement-agent');
    const request = (body: Record<string, unknown>) => stack.app.request('/v1/agents/release-exact', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ws.workspaceKey}`,
        'Idempotency-Key': 'exact-release-payload-swap',
      },
      body: JSON.stringify(body),
    });

    const first = await request({ name: oldAgent.name, expected_agent_id: oldAgent.agentId, delete_agent: true });
    expect(first.status).toBe(201);
    const swapped = await request({ name: replacement.name, expected_agent_id: replacement.agentId, delete_agent: true });
    expect(swapped.status).toBe(409);
    expect((await swapped.json() as { error: { code: string } }).error.code).toBe('idempotency_key_reused');

    const mismatch = await stack.app.request('/v1/agents/release-exact', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ws.workspaceKey}`,
        'Idempotency-Key': 'exact-release-mismatch',
      },
      body: JSON.stringify({ name: replacement.name, expected_agent_id: oldAgent.agentId, delete_agent: true }),
    });
    expect(mismatch.status).toBe(409);
    expect((await mismatch.json() as { error: { code: string } }).error.code).toBe('agent_identity_mismatch');
    const [stillReplacement] = await stack.runtime.deps.db.select({ id: agents.id, status: agents.status })
      .from(agents).where(eq(agents.id, replacement.agentId));
    expect(stillReplacement).toEqual({ id: replacement.agentId, status: 'active' });
  });

  it('cannot alter a same-name replacement that wins after an exact release starts', async () => {
    const ws = await createWorkspace(stack.app, 'exact-release-dispatch-race');
    const oldAgent = await registerAgent(stack.app, ws.workspaceKey, 'race-agent');
    await attachDirectNodeSocket(stack, ws.workspaceId, oldAgent);
    const nodeConnections = stack.runtime.deps.nodeConnections!;
    const originalConnected = nodeConnections.isProviderConnected.bind(nodeConnections);
    let replaced = false;
    vi.spyOn(nodeConnections, 'isProviderConnected').mockImplementation((...args) => {
      if (!replaced) {
        replaced = true;
        // This synchronous hook is after dispatchRelease's exact name/id
        // snapshot but before its provider-send guard. It models a new agent
        // taking the released name while the old operation is in flight.
        stack.runtime.handle.sqlite.prepare('UPDATE agents SET name = ? WHERE id = ?')
          .run('race-agent#old', oldAgent.agentId);
        stack.runtime.handle.sqlite.prepare(
          `INSERT INTO agents (id, workspace_id, name, type, token_hash, status, location_type, provider_name, metadata, created_at, last_seen)
           VALUES (?, ?, ?, 'agent', ?, 'active', 'self_connected', 'default', '{}', unixepoch(), unixepoch())`,
        ).run('agent_race_replacement', ws.workspaceId, 'race-agent', 'f'.repeat(64));
      }
      return originalConnected(...args);
    });

    const response = await stack.app.request('/v1/agents/release-exact', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ws.workspaceKey}`,
        'Idempotency-Key': 'exact-release-dispatch-race',
      },
      body: JSON.stringify({ name: 'race-agent', expected_agent_id: oldAgent.agentId, delete_agent: true }),
    });
    expect(response.status).toBe(409);
    expect((await response.json() as { error: { code: string } }).error.code)
      .toBe('agent_identity_mismatch');
    expect(replaced).toBe(true);
    const [replacement] = await stack.runtime.deps.db.select({ id: agents.id, name: agents.name, status: agents.status })
      .from(agents).where(eq(agents.id, 'agent_race_replacement'));
    expect(replacement).toEqual({ id: 'agent_race_replacement', name: 'race-agent', status: 'active' });
  });

  it('settles a guarded no-host fallback as a generation conflict after takeover', async () => {
    const ws = await createWorkspace(stack.app, 'hostless-release-generation-race');
    const caller = await registerAgent(stack.app, ws.workspaceKey, 'hostless-release-caller');
    const target = await registerAgent(stack.app, ws.workspaceKey, 'hostless-generation-agent');
    const expectedTokenHash = await sha256Hex(target.token);
    const replacementTokenHash = 'a'.repeat(64);
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

    const invoke = () => stack.app.request('/v1/actions/release/invoke', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${caller.token}`,
        'Idempotency-Key': 'hostless-release-generation-race',
      },
      body: JSON.stringify({
        input: {
          name: target.name,
          delete_agent: false,
          expected_token_hash: expectedTokenHash,
        },
      }),
    });
    const response = await invoke();

    expect(rotated).toBe(true);
    expect(response.status).toBe(409);
    expect((await response.json() as { error: { code: string } }).error.code)
      .toBe('agent_release_generation_conflict');
    const replay = await invoke();
    expect(replay.status).toBe(409);
    expect((await replay.json() as { error: { code: string } }).error.code)
      .toBe('agent_release_generation_conflict');
    const [replacement] = await stack.runtime.deps.db
      .select({ status: agents.status, tokenHash: agents.tokenHash })
      .from(agents)
      .where(eq(agents.id, target.agentId));
    expect(replacement).toEqual({ status: 'active', tokenHash: replacementTokenHash });
    const [invocation] = await stack.runtime.deps.db
      .select({ status: actionInvocations.status, error: actionInvocations.error })
      .from(actionInvocations)
      .where(and(
        eq(actionInvocations.workspaceId, ws.workspaceId),
        eq(actionInvocations.actionName, 'release'),
      ));
    expect(invocation).toEqual({ status: 'failed', error: 'agent_release_generation_conflict' });
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

    const [fresh, replay] = await invokeWithConcurrentReplay(invoke, frameSentPromise, resumeSend);
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

  it('records the binding that local reaping actually deactivates after a concurrent rebind', async () => {
    const ws = await createWorkspace(stack.app, 'hostless-agent-rebind-race');
    const target = await registerAgent(stack.app, ws.workspaceKey, 'rebound-release-agent');
    for (const [nodeId, name] of [['node_release_old', 'release-old'], ['node_release_new', 'release-new']] as const) {
      const enrolled = await stack.app.request('/v1/nodes', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
        body: JSON.stringify({ node_id: nodeId, name, role: 'broker', max_agents: 1 }),
      });
      expect(enrolled.status).toBe(201);
    }
    const bound = await stack.app.request('/v1/nodes/release-old/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({ agent_name: target.name }),
    });
    expect(bound.status).toBe(201);

    const nodeConnections = stack.runtime.deps.nodeConnections!;
    let rebound = false;
    vi.spyOn(nodeConnections, 'isProviderConnected').mockImplementation(() => {
      if (!rebound) {
        rebound = true;
        const sqlite = stack.runtime.handle.sqlite;
        sqlite.transaction(() => {
          sqlite.prepare(`
            UPDATE agent_node_bindings
            SET status = 'inactive', updated_at = unixepoch()
            WHERE workspace_id = ? AND agent_id = ? AND status = 'active'
          `).run(ws.workspaceId, target.agentId);
          sqlite.prepare(`
            INSERT INTO agent_node_bindings (id, workspace_id, agent_id, node_id, status)
            VALUES (?, ?, ?, 'node_release_new', 'active')
            ON CONFLICT(agent_id, node_id) DO UPDATE
            SET status = 'active', updated_at = unixepoch()
          `).run('binding_release_race', ws.workspaceId, target.agentId);
          sqlite.prepare(`
            UPDATE agents
            SET location_type = 'via_node', location_node_id = 'node_release_new'
            WHERE workspace_id = ? AND id = ?
          `).run(ws.workspaceId, target.agentId);
          sqlite.prepare(`
            UPDATE nodes
            SET active_agents = CASE id WHEN 'node_release_old' THEN 0 ELSE 1 END
            WHERE workspace_id = ? AND id IN ('node_release_old', 'node_release_new')
          `).run(ws.workspaceId);
        })();
      }
      return false;
    });

    const response = await stack.app.request('/v1/agents/release', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({
        name: target.name,
        delete_agent: true,
        expected_token_hash: await sha256Hex(target.token),
      }),
    });
    expect(rebound).toBe(true);
    expect(response.status).toBe(201);
    expect((await response.json() as { data: { handler_node_id: string | null } }).data.handler_node_id)
      .toBe('node_release_new');

    const [invocation] = await stack.runtime.deps.db
      .select({ handlerNodeId: actionInvocations.handlerNodeId })
      .from(actionInvocations)
      .where(and(
        eq(actionInvocations.workspaceId, ws.workspaceId),
        eq(actionInvocations.actionName, 'release'),
      ));
    expect(invocation.handlerNodeId).toBe('node_release_new');
    const [exited] = await stack.runtime.deps.db
      .select({ payload: workspaceEvents.payload })
      .from(workspaceEvents)
      .where(and(
        eq(workspaceEvents.workspaceId, ws.workspaceId),
        eq(workspaceEvents.type, 'agent.exited'),
      ));
    expect(JSON.parse(exited.payload)).toMatchObject({ node_id: 'node_release_new' });
    const nodeRows = await stack.runtime.deps.db
      .select({ id: nodes.id, activeAgents: nodes.activeAgents })
      .from(nodes)
      .where(and(eq(nodes.workspaceId, ws.workspaceId), eq(nodes.role, 'broker')));
    expect(nodeRows).toEqual(expect.arrayContaining([
      { id: 'node_release_old', activeAgents: 0 },
      { id: 'node_release_new', activeAgents: 0 },
    ]));
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

  it('does not let a registered release action shadow the guarded agent endpoint', async () => {
    const ws = await createWorkspace(stack.app, 'guarded-release-shadow');
    const target = await registerAgent(stack.app, ws.workspaceKey, 'shadow-target');
    const handler = await registerAgent(stack.app, ws.workspaceKey, 'shadow-handler');
    const { sock, handle } = await attachDirectNodeSocket(stack, ws.workspaceId, handler);
    const expectedTokenHash = await sha256Hex(target.token);
    const replacementTokenHash = 'a'.repeat(64);

    const register = await stack.app.request('/v1/actions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${handler.token}`,
      },
      body: JSON.stringify({
        name: 'release',
        description: 'A user-defined action that must not shadow the agent lifecycle endpoint',
        handler_agent: handler.name,
      }),
    });
    expect(register.status).toBe(201);

    await stack.runtime.deps.db
      .update(agents)
      .set({ tokenHash: replacementTokenHash })
      .where(eq(agents.id, target.agentId));

    const response = await stack.app.request('/v1/agents/release', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ws.workspaceKey}`,
      },
      body: JSON.stringify({
        name: target.name,
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
      .select({ id: agents.id, tokenHash: agents.tokenHash })
      .from(agents)
      .where(eq(agents.id, target.agentId));
    expect(replacement).toEqual({ id: target.agentId, tokenHash: replacementTokenHash });
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
        delete_agent: false,
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
        delete_agent: false,
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

  it('socket owner rejects a takeover at the send boundary and replays the same 409', async () => {
    const ws = await createWorkspace(stack.app, 'release-generation-owner-race');
    const caller = await registerAgent(stack.app, ws.workspaceKey, 'release-owner-caller');
    const target = await registerAgent(stack.app, ws.workspaceKey, 'owner-race-agent');
    const { sock, handle } = await attachDirectNodeSocket(stack, ws.workspaceId, target);
    const expectedTokenHash = await sha256Hex(target.token);
    const replacementTokenHash = 'c'.repeat(64);
    const nodeConnections = stack.runtime.deps.nodeConnections!;
    const originalSend = nodeConnections.sendAuthorizedActionToProvider!.bind(nodeConnections);
    let rotated = false;
    vi.spyOn(nodeConnections, 'sendAuthorizedActionToProvider').mockImplementation(async (...args) => {
      if (!rotated && args[3].action === 'release') {
        rotated = true;
        stack.runtime.handle.sqlite
          .prepare('UPDATE agents SET token_hash = ? WHERE id = ?')
          .run(replacementTokenHash, target.agentId);
      }
      return originalSend(...args);
    });

    const invoke = () => stack.app.request('/v1/actions/release/invoke', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${caller.token}`,
        'Idempotency-Key': 'release-generation-owner-race',
      },
      body: JSON.stringify({
        input: {
          name: target.name,
          delete_agent: false,
          expected_token_hash: expectedTokenHash,
        },
      }),
    });

    const first = await invoke();
    const replay = await invoke();
    expect([first.status, replay.status]).toEqual([409, 409]);
    const [firstBody, replayBody] = await Promise.all([
      first.json() as Promise<{ error: { code: string } }>,
      replay.json() as Promise<{ error: { code: string } }>,
    ]);
    expect(firstBody.error.code).toBe('agent_release_generation_conflict');
    expect(replayBody.error.code).toBe('agent_release_generation_conflict');
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

  it('authorizes a guarded release against its current dispatched route after a handoff', async () => {
    const ws = await createWorkspace(stack.app, 'release-generation-route-handoff');
    const oldHost = await registerAgent(stack.app, ws.workspaceKey, 'old-release-host');
    const target = await registerAgent(stack.app, ws.workspaceKey, 'release-route-target');
    const oldNode = await attachDirectNodeSocket(stack, ws.workspaceId, oldHost);
    const currentNode = await attachDirectNodeSocket(stack, ws.workspaceId, target);
    const expectedTokenHash = await sha256Hex(target.token);
    const invocationId = 'inv_release_route_handoff';
    await stack.runtime.deps.db.insert(actionInvocations).values({
      id: invocationId,
      workspaceId: ws.workspaceId,
      actionName: 'release',
      invocationOrigin: 'builtin',
      input: { name: target.name, expected_token_hash: expectedTokenHash },
      status: 'dispatched',
      handlerNodeId: oldNode.nodeId,
      dispatchedNodeId: currentNode.nodeId,
      dispatchedProvider: 'default',
      attemptedNodeIds: [oldNode.nodeId, currentNode.nodeId],
      dispatchAttempts: 2,
    });

    const sent = await stack.runtime.realtime.sendAuthorizedActionToProvider(
      ws.workspaceId,
      currentNode.nodeId,
      'default',
      {
        v: 1,
        type: 'action.invoke',
        invocation_id: invocationId,
        action: 'release',
        input: { name: target.name, expected_token_hash: expectedTokenHash },
      },
      {
        kind: 'release-generation-v1',
        invocationId,
        agentName: target.name,
        expectedTokenHash,
      },
    );

    expect(sent).toBe(true);
    expect(currentNode.sock.ofType('action.invoke')).toHaveLength(1);
    expect(oldNode.sock.ofType('action.invoke')).toHaveLength(0);
  });

  it('requires every supplied release proof to match the persisted invocation', async () => {
    const ws = await createWorkspace(stack.app, 'release-generation-dual-proof');
    const target = await registerAgent(stack.app, ws.workspaceKey, 'dual-proof-target');
    const targetNode = await attachDirectNodeSocket(stack, ws.workspaceId, target);
    const expectedTokenHash = await sha256Hex(target.token);
    const invocationId = 'inv_release_dual_proof';
    await stack.runtime.deps.db.insert(actionInvocations).values({
      id: invocationId,
      workspaceId: ws.workspaceId,
      actionName: 'release',
      invocationOrigin: 'builtin',
      input: {
        name: target.name,
        expected_token_hash: expectedTokenHash,
        expected_agent_id: 'agent_persisted_different',
      },
      status: 'dispatched',
      handlerNodeId: targetNode.nodeId,
      dispatchedNodeId: targetNode.nodeId,
      dispatchedProvider: 'default',
      dispatchAttempts: 1,
    });

    const sent = await stack.runtime.realtime.sendAuthorizedActionToProvider(
      ws.workspaceId,
      targetNode.nodeId,
      'default',
      {
        v: 1,
        type: 'action.invoke',
        invocation_id: invocationId,
        action: 'release',
        input: {
          name: target.name,
          expected_token_hash: expectedTokenHash,
          expected_agent_id: target.agentId,
        },
      },
      {
        kind: 'release-generation-v1',
        invocationId,
        agentName: target.name,
        expectedTokenHash,
        expectedAgentId: target.agentId,
      },
    );

    expect(sent).toBe(false);
    expect(targetNode.sock.ofType('action.invoke')).toHaveLength(0);
    const [invocation] = await stack.runtime.deps.db
      .select({ status: actionInvocations.status, error: actionInvocations.error })
      .from(actionInvocations)
      .where(eq(actionInvocations.id, invocationId));
    expect(invocation).toEqual({ status: 'failed', error: 'agent_identity_mismatch' });
    await targetNode.handle.handleClose();
  });

  it('does not accept a release-generation proof for a registered action', async () => {
    const ws = await createWorkspace(stack.app, 'release-generation-origin-boundary');
    const target = await registerAgent(stack.app, ws.workspaceKey, 'release-origin-target');
    const targetNode = await attachDirectNodeSocket(stack, ws.workspaceId, target);
    const expectedTokenHash = await sha256Hex(target.token);
    const invocationId = 'inv_registered_release_generation';
    await stack.runtime.deps.db.insert(actionInvocations).values({
      id: invocationId,
      workspaceId: ws.workspaceId,
      actionName: 'release',
      invocationOrigin: 'registered_action',
      input: { name: target.name, expected_token_hash: expectedTokenHash },
      status: 'dispatched',
      handlerNodeId: targetNode.nodeId,
      dispatchedNodeId: targetNode.nodeId,
      dispatchedProvider: 'default',
      attemptedNodeIds: [targetNode.nodeId],
      dispatchAttempts: 1,
    });

    const sent = await stack.runtime.realtime.sendAuthorizedActionToProvider(
      ws.workspaceId,
      targetNode.nodeId,
      'default',
      {
        v: 1,
        type: 'action.invoke',
        invocation_id: invocationId,
        action: 'release',
        input: { name: target.name, expected_token_hash: expectedTokenHash },
      },
      {
        kind: 'release-generation-v1',
        invocationId,
        agentName: target.name,
        expectedTokenHash,
      },
    );

    expect(sent).toBe(false);
    expect(targetNode.sock.ofType('action.invoke')).toHaveLength(0);
    const [invocation] = await stack.runtime.deps.db
      .select({ status: actionInvocations.status, error: actionInvocations.error })
      .from(actionInvocations)
      .where(eq(actionInvocations.id, invocationId));
    expect(invocation).toEqual({ status: 'failed', error: 'agent_release_generation_conflict' });
  });

  it('replays a guarded release completion conflict as the same 409 after dispatch', async () => {
    const ws = await createWorkspace(stack.app, 'release-generation-completion-replay');
    const caller = await registerAgent(stack.app, ws.workspaceKey, 'release-completion-caller');
    const target = await registerAgent(stack.app, ws.workspaceKey, 'completion-race-agent');
    const { handle } = await attachDirectNodeSocket(stack, ws.workspaceId, target);
    const expectedTokenHash = await sha256Hex(target.token);
    const replacementTokenHash = 'd'.repeat(64);
    const invoke = () => stack.app.request('/v1/actions/release/invoke', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${caller.token}`,
        'Idempotency-Key': 'release-generation-completion-replay',
      },
      body: JSON.stringify({
        input: {
          name: target.name,
          delete_agent: true,
          expected_token_hash: expectedTokenHash,
        },
      }),
    });

    const first = await invoke();
    expect(first.status).toBe(201);
    const firstBody = await first.json() as { data: { invocation_id: string } };
    await stack.runtime.deps.db
      .update(agents)
      .set({ tokenHash: replacementTokenHash })
      .where(eq(agents.id, target.agentId));
    await handle.handleMessage(JSON.stringify({
      v: 1,
      type: 'action.result',
      invocation_id: firstBody.data.invocation_id,
      output: { released: true },
    }));

    const replay = await invoke();
    expect(replay.status).toBe(409);
    expect((await replay.json() as { error: { code: string } }).error.code)
      .toBe('agent_release_generation_conflict');
    const [invocation] = await stack.runtime.deps.db
      .select({ status: actionInvocations.status, error: actionInvocations.error })
      .from(actionInvocations)
      .where(eq(actionInvocations.id, firstBody.data.invocation_id));
    expect(invocation).toEqual({ status: 'failed', error: 'agent_release_generation_conflict' });
    await handle.handleClose();
  });

  it('acknowledges a guarded release completed before the post-send dispatch stamp', async () => {
    const ws = await createWorkspace(stack.app, 'release-generation-fast-completion');
    const target = await registerAgent(stack.app, ws.workspaceKey, 'fast-completion-agent');
    const { sock, handle } = await attachDirectNodeSocket(stack, ws.workspaceId, target);
    const nodeConnections = stack.runtime.deps.nodeConnections!;
    const originalSend = nodeConnections.sendAuthorizedActionToProvider!.bind(nodeConnections);
    vi.spyOn(nodeConnections, 'sendAuthorizedActionToProvider').mockImplementation(async (...args) => {
      const sent = await originalSend(...args);
      if (!sent || args[3].action !== 'release') return sent;
      // A remote socket owner can durably record provider acceptance before
      // this engine resumes from its authorized send call.
      await stack.runtime.deps.db
        .update(actionInvocations)
        .set({
          status: 'dispatched',
          dispatchedNodeId: args[1],
          dispatchedProvider: args[2],
        })
        .where(eq(actionInvocations.id, args[3].invocation_id));
      await handle.handleMessage(JSON.stringify({
        v: 1,
        type: 'action.result',
        invocation_id: args[3].invocation_id,
        output: { released: true },
      }));
      return sent;
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
        expected_token_hash: await sha256Hex(target.token),
      }),
    });

    expect(response.status).toBe(201);
    expect((await response.json() as { data: { status: string } }).data.status).toBe('completed');
    expect(sock.ofType('action.invoke').filter((event) => event.action === 'release')).toHaveLength(1);
    const [invocation] = await stack.runtime.deps.db
      .select({ status: actionInvocations.status, error: actionInvocations.error })
      .from(actionInvocations)
      .where(and(
        eq(actionInvocations.workspaceId, ws.workspaceId),
        eq(actionInvocations.actionName, 'release'),
      ));
    expect(invocation).toEqual({ status: 'completed', error: null });
    expect(await stack.runtime.deps.db
      .select()
      .from(agents)
      .where(and(eq(agents.workspaceId, ws.workspaceId), eq(agents.name, target.name))))
      .toHaveLength(0);
    await handle.handleClose();
  });

  it('completes a generation-authorized delete locally when the implicit direct node is a never-attached ghost', async () => {
    const ws = await createWorkspace(stack.app, 'release-direct-ghost-node');
    const target = await registerAgent(stack.app, ws.workspaceKey, 'ghost-direct-agent');
    // The liveness signal the fix keys off: the implicit direct node is a
    // never-attached ghost -> offline with a null heartbeat.
    const [ghostNode] = await stack.runtime.deps.db
      .select({ status: nodes.status, lastHeartbeatAt: nodes.lastHeartbeatAt })
      .from(nodes)
      .where(and(eq(nodes.workspaceId, ws.workspaceId), eq(nodes.name, `direct-${target.agentId}`)));
    expect(ghostNode).toEqual({ status: 'offline', lastHeartbeatAt: null });
    const nodeConnections = stack.runtime.deps.nodeConnections!;
    // Mirror the deployed Cloud edge: `isProviderConnected` cannot see the DO and
    // reports connected, and the direct node adapter cannot deliver the guarded
    // frame. Pre-fix this returned 503 `node_dispatch_unavailable` and stranded the
    // identity; the node row (offline, null heartbeat) is the only liveness signal.
    const originalConnected = nodeConnections.isProviderConnected.bind(nodeConnections);
    nodeConnections.isProviderConnected = () => true;
    const authorizedSend = vi.spyOn(nodeConnections, 'sendAuthorizedActionToProvider').mockResolvedValue(false);
    let response!: Response;
    try {
      response = await stack.app.request('/v1/agents/release', {
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
    } finally {
      nodeConnections.isProviderConnected = originalConnected;
    }

    expect(response.status).toBe(201);
    expect((await response.json() as { data: { status: string } }).data.status).toBe('completed');
    expect(authorizedSend).not.toHaveBeenCalled();
    expect(await stack.runtime.deps.db
      .select()
      .from(agents)
      .where(and(eq(agents.workspaceId, ws.workspaceId), eq(agents.name, target.name))))
      .toHaveLength(0);
    const [invocation] = await stack.runtime.deps.db
      .select({ status: actionInvocations.status, error: actionInvocations.error })
      .from(actionInvocations)
      .where(and(
        eq(actionInvocations.workspaceId, ws.workspaceId),
        eq(actionInvocations.actionName, 'release'),
      ));
    expect(invocation).toEqual({ status: 'completed', error: null });
  });

  it('keeps the guarded dispatch fence for a live implicit direct node when the adapter cannot deliver', async () => {
    const ws = await createWorkspace(stack.app, 'release-direct-live-node');
    const target = await registerAgent(stack.app, ws.workspaceKey, 'live-direct-agent');
    const { handle } = await attachDirectNodeSocket(stack, ws.workspaceId, target);
    // The liveness signal the fix keys off: the direct node is genuinely online
    // with a fresh heartbeat (unlike the ghost), so it must stay in the guarded
    // dispatch path rather than being released locally.
    const [liveNode] = await stack.runtime.deps.db
      .select({ status: nodes.status, lastHeartbeatAt: nodes.lastHeartbeatAt })
      .from(nodes)
      .where(and(eq(nodes.workspaceId, ws.workspaceId), eq(nodes.name, `direct-${target.agentId}`)));
    expect(liveNode?.status).toBe('online');
    expect(liveNode?.lastHeartbeatAt).toBeInstanceOf(Date);
    expect(Date.now() - (liveNode!.lastHeartbeatAt!.getTime())).toBeLessThan(60_000);
    const nodeConnections = stack.runtime.deps.nodeConnections!;
    // Same Cloud edge signal, but the direct node is genuinely online with a fresh
    // heartbeat: the liveness check must not bypass the guard, so the failing
    // authorized adapter still yields 503 and the identity survives.
    const originalConnected = nodeConnections.isProviderConnected.bind(nodeConnections);
    nodeConnections.isProviderConnected = () => true;
    vi.spyOn(nodeConnections, 'sendAuthorizedActionToProvider').mockResolvedValue(false);
    let response!: Response;
    try {
      response = await stack.app.request('/v1/agents/release', {
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
    } finally {
      nodeConnections.isProviderConnected = originalConnected;
    }

    expect(response.status).toBe(503);
    expect((await response.json() as { error: { code: string } }).error.code)
      .toBe('node_dispatch_unavailable');
    const [current] = await stack.runtime.deps.db
      .select({ name: agents.name, status: agents.status })
      .from(agents)
      .where(eq(agents.id, target.agentId));
    expect(current).toMatchObject({ name: target.name, status: 'active' });
    await handle.handleClose();
  });

  it('fails closed when the socket owner cannot enforce a guarded release', async () => {
    const ws = await createWorkspace(stack.app, 'release-generation-owner-required');
    const target = await registerAgent(stack.app, ws.workspaceKey, 'owner-required-agent');
    const { sock, handle } = await attachDirectNodeSocket(stack, ws.workspaceId, target);
    const nodeConnections = stack.runtime.deps.nodeConnections!;
    const ownerAuthorizedSend = nodeConnections.sendAuthorizedActionToProvider;
    nodeConnections.sendAuthorizedActionToProvider = undefined;
    let response!: Response;
    try {
      response = await stack.app.request('/v1/agents/release', {
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
    } finally {
      nodeConnections.sendAuthorizedActionToProvider = ownerAuthorizedSend;
    }

    expect(response.status).toBe(503);
    expect((await response.json() as { error: { code: string } }).error.code)
      .toBe('node_dispatch_unavailable');
    expect(sock.ofType('action.invoke').filter((event) => event.action === 'release')).toHaveLength(0);
    const [current] = await stack.runtime.deps.db
      .select({ name: agents.name, status: agents.status })
      .from(agents)
      .where(eq(agents.id, target.agentId));
    expect(current).toMatchObject({ name: target.name, status: 'active' });
    await handle.handleClose();
  });

  it('fails closed when an older socket owner rejects the generation proof', async () => {
    const ws = await createWorkspace(stack.app, 'release-generation-owner-old-contract');
    const target = await registerAgent(stack.app, ws.workspaceKey, 'old-owner-contract-agent');
    const { sock, handle } = await attachDirectNodeSocket(stack, ws.workspaceId, target);
    const nodeConnections = stack.runtime.deps.nodeConnections!;
    vi.spyOn(nodeConnections, 'sendAuthorizedActionToProvider').mockResolvedValue(false);

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

    expect(response.status).toBe(503);
    expect((await response.json() as { error: { code: string } }).error.code)
      .toBe('node_dispatch_unavailable');
    expect(sock.ofType('action.invoke').filter((event) => event.action === 'release')).toHaveLength(0);
    const [current] = await stack.runtime.deps.db
      .select({ name: agents.name, status: agents.status })
      .from(agents)
      .where(eq(agents.id, target.agentId));
    expect(current).toMatchObject({ name: target.name, status: 'active' });
    const [invocation] = await stack.runtime.deps.db
      .select({ status: actionInvocations.status, error: actionInvocations.error })
      .from(actionInvocations)
      .where(and(
        eq(actionInvocations.workspaceId, ws.workspaceId),
        eq(actionInvocations.actionName, 'release'),
      ));
    expect(invocation).toEqual({ status: 'failed', error: 'node_dispatch_unavailable' });
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

/**
 * A node bind is a location move, not just a roster row. The broker's spawn
 * path HTTP-registers an agent first (leaving it on its implicit `direct-*`
 * pseudo-node), then falls back to this endpoint when its create-only
 * `agent.register` loses to the row that already exists. Delivery routing
 * joins bindings only where `agents.location_node_id` matches the bound node,
 * so a bind that leaves the agent row untouched strands the spawned agent on a
 * dead pseudo-node and it is never woken.
 */
describe('node agent binding adopts the agent location', () => {
  let stack: TestStack;

  beforeEach(() => { stack = makeNodeStack(); });
  afterEach(() => stack.close());

  async function enrollNode(workspaceKey: string, nodeId: string, name: string) {
    const res = await stack.app.request('/v1/nodes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${workspaceKey}` },
      body: JSON.stringify({ node_id: nodeId, name, role: 'broker', max_agents: 4, tags: ['test'], version: 'v0' }),
    });
    expect(res.status).toBe(201);
    return (await res.json() as { data: { token: string } }).data.token;
  }

  function bindAgent(
    workspaceKey: string,
    nodeName: string,
    agentName: string,
    body: Record<string, unknown> = {},
  ) {
    return stack.app.request(`/v1/nodes/${nodeName}/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${workspaceKey}` },
      body: JSON.stringify({ agent_name: agentName, ...body }),
    });
  }

  /** Every agent column the bind path writes. */
  async function readAgent(agentId: string) {
    const [row] = await stack.runtime.deps.db
      .select({
        locationType: agents.locationType,
        locationNodeId: agents.locationNodeId,
        status: agents.status,
        providerName: agents.providerName,
        originNodeId: agents.originNodeId,
        sessionRef: agents.sessionRef,
        lastSeen: agents.lastSeen,
      })
      .from(agents)
      .where(eq(agents.id, agentId));
    return row;
  }

  async function activeBindingNodeIds(workspaceId: string, agentId: string): Promise<string[]> {
    const rows = await stack.runtime.deps.db
      .select({ nodeId: agentNodeBindings.nodeId })
      .from(agentNodeBindings)
      .where(and(
        eq(agentNodeBindings.workspaceId, workspaceId),
        eq(agentNodeBindings.agentId, agentId),
        eq(agentNodeBindings.status, 'active'),
      ));
    return rows.map((row) => row.nodeId).sort();
  }

  /** The capacity counters a bind reserves on its target and releases elsewhere. */
  async function nodeSlots(nodeId: string) {
    const [row] = await stack.runtime.deps.db
      .select({ activeAgents: nodes.activeAgents, reservedAgents: nodes.reservedAgents })
      .from(nodes)
      .where(eq(nodes.id, nodeId));
    return row;
  }

  /** Age a node's heartbeat past the liveness TTL, leaving its bindings alone. */
  async function expireNode(workspaceId: string, nodeId: string) {
    await stack.runtime.deps.db
      .update(nodes)
      .set({ lastHeartbeatAt: new Date(Date.now() - NODE_LIVENESS_TTL_MS - 60_000) })
      .where(and(eq(nodes.workspaceId, workspaceId), eq(nodes.id, nodeId)));
  }

  /** HTTP registration always mints `default`; other providers come from a node. */
  async function setAgentProvider(agentId: string, providerName: string) {
    await stack.runtime.deps.db
      .update(agents)
      .set({ providerName })
      .where(eq(agents.id, agentId));
  }

  /** Attach a node-control socket and register `providerName` on the node. */
  async function attachProvider(
    workspaceId: string,
    nodeId: string,
    nodeName: string,
    providerName: string,
    capabilities: Array<{ name: string; kind?: string }> = [{ name: 'spawn:claude', kind: 'capacity' }],
  ) {
    const sock = new FakeSocket();
    const handle = stack.runtime.realtime.attachNodeSocket(workspaceId, nodeId, sock);
    await handle.handleMessage(JSON.stringify({
      v: 1,
      id: `reg-${nodeId}-${providerName}`,
      type: 'node.register',
      node_id: nodeId,
      name: nodeName,
      provider: { name: providerName, instance_id: `${providerName}-i1` },
      capabilities,
      max_agents: 4,
      tags: ['test'],
      version: 'v1',
      resume_cursor: null,
    }));
    expect(sock.ofType('error')).toEqual([]);
    return { sock, handle };
  }

  it('moves an HTTP-registered agent off its implicit direct node onto the bound node', async () => {
    const ws = await createWorkspace(stack.app, 'bind-adopts-location');
    const target = await registerAgent(stack.app, ws.workspaceKey, 'fallback-bound-agent');
    await enrollNode(ws.workspaceKey, 'node_broker', 'broker-host');

    // The HTTP registration parked the agent on its implicit pseudo-node.
    const [before] = await stack.runtime.deps.db
      .select({ locationType: agents.locationType, locationNodeId: agents.locationNodeId })
      .from(agents)
      .where(eq(agents.id, target.agentId));
    expect(before).toEqual({ locationType: 'via_node', locationNodeId: `node_direct_${target.agentId}` });

    expect((await bindAgent(ws.workspaceKey, 'broker-host', target.name)).status).toBe(201);

    const [located] = await stack.runtime.deps.db
      .select({
        locationType: agents.locationType,
        locationNodeId: agents.locationNodeId,
        status: agents.status,
        originNodeId: agents.originNodeId,
      })
      .from(agents)
      .where(eq(agents.id, target.agentId));
    expect(located).toEqual({
      locationType: 'via_node',
      locationNodeId: 'node_broker',
      status: 'active',
      // Location moves; origin does not. HTTP registration stamped the
      // pseudo-node as this agent's origin and that is where identity
      // recovery authority stays.
      originNodeId: `node_direct_${target.agentId}`,
    });
    expect(await stack.runtime.deps.db
      .select({ id: agentNodeBindings.id })
      .from(agentNodeBindings)
      .where(and(
        eq(agentNodeBindings.workspaceId, ws.workspaceId),
        eq(agentNodeBindings.agentId, target.agentId),
        eq(agentNodeBindings.nodeId, 'node_broker'),
        eq(agentNodeBindings.status, 'active'),
      )))
      .toHaveLength(1);
  });

  it('routes a channel delivery for a fallback-bound agent through its bound node', async () => {
    const ws = await createWorkspace(stack.app, 'bind-adopts-routing');
    const speaker = await registerAgent(stack.app, ws.workspaceKey, 'speaker');
    const target = await registerAgent(stack.app, ws.workspaceKey, 'routed-bound-agent');
    await enrollNode(ws.workspaceKey, 'node_broker', 'broker-host');
    const { sock } = await attachProvider(ws.workspaceId, 'node_broker', 'broker-host', 'broker');

    expect((await bindAgent(ws.workspaceKey, 'broker-host', target.name)).status).toBe(201);

    const posted = await stack.app.request('/v1/channels/general/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${speaker.token}` },
      body: JSON.stringify({ text: 'wake up' }),
    });
    expect(posted.status).toBe(201);
    const message = await posted.json() as { data: { id: string } };

    const [route] = await stack.runtime.deps.db
      .select({ routeNodeId: deliveries.routeNodeId })
      .from(deliveries)
      .where(and(
        eq(deliveries.workspaceId, ws.workspaceId),
        eq(deliveries.messageId, message.data.id),
        eq(deliveries.agentId, target.agentId),
      ));
    expect(route).toEqual({ routeNodeId: 'node_broker' });

    // Fanout publishes its completion through waitUntil.
    await stack.settle();
    expect(deliverFramesOfType(sock, 'message.created')).toEqual([
      expect.objectContaining({
        type: 'deliver',
        msg_id: message.data.id,
        agent: target.name,
      }),
    ]);
  });

  it('refuses to steal an agent that is active on another live node', async () => {
    const ws = await createWorkspace(stack.app, 'bind-location-conflict');
    const target = await registerAgent(stack.app, ws.workspaceKey, 'contested-agent');
    await enrollNode(ws.workspaceKey, 'node_owner', 'owner-host');
    await enrollNode(ws.workspaceKey, 'node_thief', 'thief-host');
    await attachProvider(ws.workspaceId, 'node_owner', 'owner-host', 'broker');

    expect((await bindAgent(ws.workspaceKey, 'owner-host', target.name)).status).toBe(201);

    const stolen = await bindAgent(ws.workspaceKey, 'thief-host', target.name);
    expect(stolen.status).toBe(409);
    expect((await stolen.json() as { error: { code: string } }).error)
      .toMatchObject({ code: 'agent_location_conflict' });

    const [held] = await stack.runtime.deps.db
      .select({ locationNodeId: agents.locationNodeId })
      .from(agents)
      .where(eq(agents.id, target.agentId));
    expect(held).toEqual({ locationNodeId: 'node_owner' });
    expect(await stack.runtime.deps.db
      .select({ id: agentNodeBindings.id })
      .from(agentNodeBindings)
      .where(and(
        eq(agentNodeBindings.workspaceId, ws.workspaceId),
        eq(agentNodeBindings.agentId, target.agentId),
        eq(agentNodeBindings.nodeId, 'node_thief'),
        eq(agentNodeBindings.status, 'active'),
      )))
      .toHaveLength(0);
  });

  it('adopts the sole provider of the node it is bound to', async () => {
    const ws = await createWorkspace(stack.app, 'bind-adopts-provider');
    const target = await registerAgent(stack.app, ws.workspaceKey, 'adopted-agent');
    await enrollNode(ws.workspaceKey, 'node_broker', 'broker-host');
    await attachProvider(ws.workspaceId, 'node_broker', 'broker-host', 'broker');

    const [registered] = await stack.runtime.deps.db
      .select({ providerName: agents.providerName })
      .from(agents)
      .where(eq(agents.id, target.agentId));
    expect(registered).toEqual({ providerName: 'default' });
    expect(await stack.runtime.deps.db
      .select({ name: nodeProviders.name })
      .from(nodeProviders)
      .where(and(eq(nodeProviders.workspaceId, ws.workspaceId), eq(nodeProviders.nodeId, 'node_broker'))))
      .toEqual([{ name: 'broker' }]);

    expect((await bindAgent(ws.workspaceKey, 'broker-host', target.name)).status).toBe(201);

    const [adopted] = await stack.runtime.deps.db
      .select({ providerName: agents.providerName, locationNodeId: agents.locationNodeId })
      .from(agents)
      .where(eq(agents.id, target.agentId));
    expect(adopted).toEqual({ providerName: 'broker', locationNodeId: 'node_broker' });
  });

  it('adopts the live provider when the agent\u2019s own provider row is offline', async () => {
    const ws = await createWorkspace(stack.app, 'bind-live-provider-only');
    const target = await registerAgent(stack.app, ws.workspaceKey, 'stale-provider-agent');
    await enrollNode(ws.workspaceKey, 'node_broker', 'broker-host');

    // The node's `default` provider disconnected: its row persists as history
    // while `broker` keeps the node serving. Adoption must see only the live
    // side — keeping `default` would point the agent at a socket that is gone.
    const stale = await attachProvider(ws.workspaceId, 'node_broker', 'broker-host', 'default');
    await stale.handle.handleClose();
    const [offline] = await stack.runtime.deps.db
      .select({ status: nodeProviders.status, handlersLive: nodeProviders.handlersLive })
      .from(nodeProviders)
      .where(and(
        eq(nodeProviders.workspaceId, ws.workspaceId),
        eq(nodeProviders.nodeId, 'node_broker'),
        eq(nodeProviders.name, 'default'),
      ));
    expect(offline).toEqual({ status: 'offline', handlersLive: false });
    await attachProvider(ws.workspaceId, 'node_broker', 'broker-host', 'broker');

    expect((await bindAgent(ws.workspaceKey, 'broker-host', target.name)).status).toBe(201);

    const [adopted] = await stack.runtime.deps.db
      .select({ providerName: agents.providerName })
      .from(agents)
      .where(eq(agents.id, target.agentId));
    expect(adopted).toEqual({ providerName: 'broker' });
  });

  it('marks a bound agent delivery-ready on a cursor-aware provider and drains its queue', async () => {
    const ws = await createWorkspace(stack.app, 'bind-cursor-readiness');
    const speaker = await registerAgent(stack.app, ws.workspaceKey, 'speaker');
    const target = await registerAgent(stack.app, ws.workspaceKey, 'cursor-bound-agent');
    await enrollNode(ws.workspaceKey, 'node_broker', 'broker-host');
    const { sock } = await attachProvider(ws.workspaceId, 'node_broker', 'broker-host', 'broker', [
      { name: 'spawn:claude', kind: 'capacity' },
      { name: 'relay:delivery-cursor-v1', kind: 'capacity' },
    ]);

    // A message lands while the agent still sits on its implicit pseudo-node:
    // the durable delivery is queued with no socket to push through.
    const posted = await stack.app.request('/v1/channels/general/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${speaker.token}` },
      body: JSON.stringify({ text: 'queued while unroutable' }),
    });
    expect(posted.status).toBe(201);
    await stack.settle();
    expect(deliverFramesOfType(sock, 'message.created')).toEqual([]);
    expect(
      stack.runtime.realtime.isProviderAgentDeliveryReady(ws.workspaceId, 'node_broker', 'broker', target.agentId),
    ).toBe(false);

    const bound = await bindAgent(ws.workspaceKey, 'broker-host', target.name);
    expect(bound.status).toBe(201);
    // The bind response hands the caller the agent's authoritative cursor, the
    // same contract the agent.register/agent.recover replies carry.
    expect((await bound.json() as { data: { delivery_ack_seq: number } }).data.delivery_ack_seq)
      .toBe(0);

    // Agent-scoped readiness now names the adopted identity, and the bind's own
    // drain replays the delivery that queued before the move.
    expect(
      stack.runtime.realtime.isProviderAgentDeliveryReady(ws.workspaceId, 'node_broker', 'broker', target.agentId),
    ).toBe(true);
    await stack.settle();
    expect(deliverFramesOfType(sock, 'message.created')).toEqual([
      expect.objectContaining({ type: 'deliver', agent: target.name }),
    ]);
  });

  it('stamps session, liveness and origin with the move, and keeps the first origin on a later one', async () => {
    const ws = await createWorkspace(stack.app, 'bind-stamps-identity');
    const target = await registerAgent(stack.app, ws.workspaceKey, 'stamped-agent');
    await enrollNode(ws.workspaceKey, 'node_first', 'first-host');
    await enrollNode(ws.workspaceKey, 'node_second', 'second-host');
    const before = await readAgent(target.agentId);

    expect((await bindAgent(ws.workspaceKey, 'first-host', target.name, { session_ref: 'sess-1' })).status).toBe(201);

    const stamped = await readAgent(target.agentId);
    expect(stamped).toMatchObject({
      locationNodeId: 'node_first',
      status: 'active',
      sessionRef: 'sess-1',
      originNodeId: `node_direct_${target.agentId}`,
    });
    expect(stamped.lastSeen.getTime()).toBeGreaterThanOrEqual(before.lastSeen.getTime());
    expect(await stack.runtime.deps.db
      .select({ sessionRef: agentNodeBindings.sessionRef })
      .from(agentNodeBindings)
      .where(and(
        eq(agentNodeBindings.agentId, target.agentId),
        eq(agentNodeBindings.nodeId, 'node_first'),
      )))
      .toEqual([{ sessionRef: 'sess-1' }]);

    // A second move omits the session ref: the binding row for the new node
    // carries none, while the agent keeps the session it is still running.
    expect((await bindAgent(ws.workspaceKey, 'second-host', target.name)).status).toBe(201);

    expect(await readAgent(target.agentId)).toMatchObject({
      locationNodeId: 'node_second',
      sessionRef: 'sess-1',
      // Origin records where the agent came from, so a move never rewrites it.
      originNodeId: `node_direct_${target.agentId}`,
    });
    expect(await activeBindingNodeIds(ws.workspaceId, target.agentId)).toEqual(['node_second']);
  });

  it('moves an agent off its implicit direct node even while that pseudo-node is live', async () => {
    const ws = await createWorkspace(stack.app, 'bind-live-direct-node');
    const target = await registerAgent(stack.app, ws.workspaceKey, 'connected-agent');
    await enrollNode(ws.workspaceKey, 'node_broker', 'broker-host');
    const direct = await attachDirectNodeSocket(stack, ws.workspaceId, target);

    // The pseudo-node is as live as a node gets — online with a fresh
    // heartbeat. It still never owns the agent against a real node, or the
    // spawn fallback could never bind an agent that is already connected.
    const [directNode] = await stack.runtime.deps.db
      .select({ status: nodes.status, lastHeartbeatAt: nodes.lastHeartbeatAt })
      .from(nodes)
      .where(eq(nodes.id, direct.nodeId));
    expect(directNode.status).toBe('online');
    expect(Date.now() - directNode.lastHeartbeatAt!.getTime()).toBeLessThan(NODE_LIVENESS_TTL_MS);

    expect((await bindAgent(ws.workspaceKey, 'broker-host', target.name)).status).toBe(201);

    expect(await readAgent(target.agentId)).toMatchObject({ locationNodeId: 'node_broker' });
    expect(await activeBindingNodeIds(ws.workspaceId, target.agentId)).toEqual(['node_broker']);
    await direct.handle.handleClose();
  });

  it('takes over an agent whose owning node has gone stale, releasing its slot', async () => {
    const ws = await createWorkspace(stack.app, 'bind-stale-owner');
    const target = await registerAgent(stack.app, ws.workspaceKey, 'stranded-agent');
    await enrollNode(ws.workspaceKey, 'node_owner', 'owner-host');
    await enrollNode(ws.workspaceKey, 'node_rescue', 'rescue-host');
    await attachProvider(ws.workspaceId, 'node_owner', 'owner-host', 'broker');

    expect((await bindAgent(ws.workspaceKey, 'owner-host', target.name)).status).toBe(201);
    expect(await nodeSlots('node_owner')).toEqual({ activeAgents: 1, reservedAgents: 0 });

    // The host stopped heartbeating: its claim on the agent expires with it.
    await expireNode(ws.workspaceId, 'node_owner');
    expect((await bindAgent(ws.workspaceKey, 'rescue-host', target.name)).status).toBe(201);

    expect(await readAgent(target.agentId)).toMatchObject({ locationNodeId: 'node_rescue' });
    expect(await activeBindingNodeIds(ws.workspaceId, target.agentId)).toEqual(['node_rescue']);
    expect(await nodeSlots('node_owner')).toEqual({ activeAgents: 0, reservedAgents: 0 });
    expect(await nodeSlots('node_rescue')).toEqual({ activeAgents: 1, reservedAgents: 0 });
  });

  it('takes over an agent whose location node was pruned out from under it', async () => {
    const ws = await createWorkspace(stack.app, 'bind-pruned-owner');
    const target = await registerAgent(stack.app, ws.workspaceKey, 'orphaned-agent');
    await enrollNode(ws.workspaceKey, 'node_rescue', 'rescue-host');
    // Deleting a node nulls the location it owned (`on delete set null`), so a
    // pruned host leaves an active agent nowhere. Nothing is left to hold the
    // identity: the bind is a recovery, not a steal.
    await stack.runtime.deps.db
      .update(agents)
      .set({ locationNodeId: null, status: 'active' })
      .where(eq(agents.id, target.agentId));

    expect((await bindAgent(ws.workspaceKey, 'rescue-host', target.name)).status).toBe(201);
    expect(await readAgent(target.agentId)).toMatchObject({
      locationType: 'via_node',
      locationNodeId: 'node_rescue',
    });
    // A legacy row with no origin gets one stamped by the node adopting it.
    await stack.runtime.deps.db
      .update(agents)
      .set({ originNodeId: null })
      .where(eq(agents.id, target.agentId));
    await enrollNode(ws.workspaceKey, 'node_later', 'later-host');
    expect((await bindAgent(ws.workspaceKey, 'later-host', target.name)).status).toBe(201);
    expect(await readAgent(target.agentId)).toMatchObject({ originNodeId: 'node_later' });
  });

  /**
   * Provider adoption keeps the agent addressable: deliveries are pushed to
   * the `(node, provider)` socket named by `agents.provider_name`, so the bind
   * may only rewrite it when the node's own providers make the answer clear.
   */
  const providerAdoption = [
    {
      what: 'adopts the only provider a node serves',
      providers: ['broker'],
      current: 'default',
      expected: 'broker',
    },
    {
      what: 'falls back to the synthetic default when the node serves several and none is the agent\'s',
      providers: ['broker', 'default'],
      current: 'codex',
      expected: 'default',
    },
    {
      what: 'keeps a provider the node already serves instead of the default',
      providers: ['broker', 'default'],
      current: 'broker',
      expected: 'broker',
    },
    {
      what: 'keeps the agent provider when a multi-provider node offers no default',
      providers: ['broker', 'codex'],
      current: 'default',
      expected: 'default',
    },
    {
      what: 'keeps the agent provider when the node has registered no providers',
      providers: [],
      current: 'codex',
      expected: 'codex',
    },
  ];

  for (const [index, adoption] of providerAdoption.entries()) {
    it(adoption.what, async () => {
      const ws = await createWorkspace(stack.app, `bind-provider-${index}`);
      const target = await registerAgent(stack.app, ws.workspaceKey, 'provider-agent');
      await enrollNode(ws.workspaceKey, 'node_broker', 'broker-host');
      for (const providerName of adoption.providers) {
        await attachProvider(ws.workspaceId, 'node_broker', 'broker-host', providerName);
      }
      await setAgentProvider(target.agentId, adoption.current);

      expect(await stack.runtime.deps.db
        .select({ name: nodeProviders.name })
        .from(nodeProviders)
        .where(and(
          eq(nodeProviders.workspaceId, ws.workspaceId),
          eq(nodeProviders.nodeId, 'node_broker'),
        ))
        .then((rows) => rows.map((row) => row.name).sort()))
        .toEqual([...adoption.providers].sort());

      expect((await bindAgent(ws.workspaceKey, 'broker-host', target.name)).status).toBe(201);

      expect(await readAgent(target.agentId)).toMatchObject({
        providerName: adoption.expected,
        locationNodeId: 'node_broker',
      });
    });
  }

  /**
   * The bind writes a binding row, the agent's location/provider/origin, the
   * slot it reserves on the node it moves onto and the slot it gives back on
   * the node it moves off. A failure anywhere in that sequence must leave none
   * of it behind, on every adapter shape — including D1, which has no
   * interactive transaction and keeps whatever already ran.
   *
   * Half a move is worse than no move, because the retry cannot see that it is
   * half done and reads the leftovers as work already finished:
   *
   *  - a binding that committed while its reservation was compensated away
   *    looks bound-and-charged, so the retry reserves nothing and the node runs
   *    one agent over `max_agents` forever;
   *  - a binding retired without its slot being given back looks released, so
   *    the retry finds nothing active on the old node and never refunds it.
   *
   * So the move commits as one unit, and every failure point below is checked
   * for exactly that: nothing changed, and the retry still completes the move
   * with both slot counters right.
   */
  describe('a failed bind leaves nothing behind', () => {
    const INJECTED = 'injected bind failure';

    /**
     * Park the agent on `owner-host`, then let that host go stale so the bind
     * to `rescue-host` is a genuine move: it reserves a slot on the rescue
     * node, retires the owner's binding and refunds the owner's slot.
     */
    async function stagedMove(label: string) {
      const ws = await createWorkspace(stack.app, `bind-failure-${label}`);
      const target = await registerAgent(stack.app, ws.workspaceKey, 'moved-agent');
      await enrollNode(ws.workspaceKey, 'node_owner', 'owner-host');
      await enrollNode(ws.workspaceKey, 'node_rescue', 'rescue-host');
      await attachProvider(ws.workspaceId, 'node_owner', 'owner-host', 'broker');
      await attachProvider(ws.workspaceId, 'node_rescue', 'rescue-host', 'rescue');

      expect((await bindAgent(ws.workspaceKey, 'owner-host', target.name)).status).toBe(201);
      expect(await nodeSlots('node_owner')).toEqual({ activeAgents: 1, reservedAgents: 0 });
      await expireNode(ws.workspaceId, 'node_owner');

      return { ws, target, db: stack.runtime.deps.db as unknown as EngineDb };
    }

    /** Everything the move touches, in one comparable value. */
    async function snapshot(workspaceId: string, agentId: string) {
      return {
        agent: await readAgent(agentId),
        bindings: await activeBindingNodeIds(workspaceId, agentId),
        owner: await nodeSlots('node_owner'),
        rescue: await nodeSlots('node_rescue'),
      };
    }

    const shapes = [
      {
        what: 'transactional',
        // The Node adapter's handle rolls the whole move back.
        apply: () => {},
      },
      {
        what: 'D1 batch',
        // D1 has no interactive transaction; its atomicity is `batch()`.
        apply: (db: EngineDb) => { attachFakeBatch(stack, db); },
      },
    ];

    const failurePoints = [
      {
        at: 'the binding insert',
        inject: (db: EngineDb) => injectInsertFailure(db, agentNodeBindings, INJECTED),
      },
      {
        at: 'the agent location move',
        inject: (db: EngineDb) => injectUpdateFailure(db, agents, INJECTED),
      },
      {
        at: 'the old binding retirement',
        inject: (db: EngineDb) => injectUpdateFailure(db, agentNodeBindings, INJECTED),
      },
      {
        at: 'the old slot refund',
        // Both slot writes update `nodes`: the rescue reservation is built
        // first, the owner's refund second. One shot only, so the reservation's
        // own compensating release still runs.
        inject: (db: EngineDb) => injectUpdateFailure(db, nodes, INJECTED, { skip: 1, times: 1 }),
      },
    ];

    for (const shape of shapes) {
      for (const point of failurePoints) {
        it(`restores every row and both slot counters when ${point.at} fails (${shape.what})`, async () => {
          const { ws, target, db } = await stagedMove(`${shape.what}-${point.at}`.replace(/\s+/g, '-'));
          shape.apply(db);
          const before = await snapshot(ws.workspaceId, target.agentId);

          const restore = point.inject(db);
          await expect(bindAgentToNode(db, ws.workspaceId, 'rescue-host', target.name))
            .rejects.toThrow(INJECTED);
          restore();

          expect(await snapshot(ws.workspaceId, target.agentId)).toEqual(before);

          // The retry reads untouched state, so it reserves and refunds exactly
          // once and the move lands whole.
          await bindAgentToNode(db, ws.workspaceId, 'rescue-host', target.name);
          expect(await snapshot(ws.workspaceId, target.agentId)).toMatchObject({
            agent: expect.objectContaining({ locationNodeId: 'node_rescue', providerName: 'rescue' }),
            bindings: ['node_rescue'],
            owner: { activeAgents: 0, reservedAgents: 0 },
            rescue: { activeAgents: 1, reservedAgents: 0 },
          });
        });
      }
    }

    it('refuses the move on a handle that can neither roll back nor batch', async () => {
      const { ws, target, db } = await stagedMove('bare-handle');
      const capability = (db as EngineDb & TransactionCapability).withTransaction;
      stripTransactionCapability(db);
      const before = await snapshot(ws.workspaceId, target.agentId);

      // Nothing can undo a half-applied move here, so the bind never starts
      // one: it is refused before the first statement and the reservation it
      // took is handed straight back.
      await expect(bindAgentToNode(db, ws.workspaceId, 'rescue-host', target.name))
        .rejects.toThrow(/Atomic write capability required/);
      expect(await snapshot(ws.workspaceId, target.agentId)).toEqual(before);

      (db as EngineDb & TransactionCapability).withTransaction = capability;
      await bindAgentToNode(db, ws.workspaceId, 'rescue-host', target.name);
      expect(await snapshot(ws.workspaceId, target.agentId)).toMatchObject({
        bindings: ['node_rescue'],
        owner: { activeAgents: 0, reservedAgents: 0 },
        rescue: { activeAgents: 1, reservedAgents: 0 },
      });
    });
  });
});
