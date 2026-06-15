import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  makeNodeStack,
  createWorkspace,
  registerAgent,
  FakeSocket,
  type TestStack,
} from './harness.js';

/**
 * Phase 6 rollout flag conformance. The per-workspace `fleet_nodes_enabled` flag
 * gates the whole node control surface. These assert:
 *   - flag OFF  → every node surface is inert (WS, roster, spawn placement, triggers)
 *   - flag ON   → the surfaces come alive via the per-workspace override
 *   - migration → an agent on the legacy per-agent WS path is never *also* delivered
 *                 via a node when the flag flips mid-stream (exclusive location).
 *
 * The `node adapter conformance` suite (node.test.ts) runs with the flag default-on
 * (set in the harness), proving "flag on → existing integration tests pass unchanged".
 */

function nodeRegisterFrame(opts: {
  id: string;
  name: string;
  capabilities: Array<{ name: string; kind?: string }>;
}) {
  return JSON.stringify({
    v: 1,
    id: `reg-${opts.id}`,
    type: 'node.register',
    name: opts.name,
    node_id: opts.id,
    capabilities: opts.capabilities,
    max_agents: 4,
    tags: ['test'],
    version: 'test-node',
    resume_cursor: null,
  });
}

async function setFleetFlag(stack: TestStack, workspaceKey: string, value: boolean | 'inherit') {
  const res = await stack.app.request('/v1/workspace/fleet-nodes', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${workspaceKey}` },
    body: JSON.stringify(value === 'inherit' ? { mode: 'inherit' } : { enabled: value }),
  });
  expect(res.status).toBe(200);
  return res.json() as Promise<{ data: { enabled: boolean; override: boolean | null } }>;
}

describe('fleet rollout flag', () => {
  describe('flag off — node surfaces inert', () => {
    let stack: TestStack;
    beforeEach(() => { stack = makeNodeStack({ fleetNodesEnabled: false, ttlMs: 1_000 }); });
    afterEach(() => stack.close());

    it('POST /v1/nodes is flagged off (404)', async () => {
      const ws = await createWorkspace(stack.app, 'off-ws');
      const res = await stack.app.request('/v1/nodes', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
        body: JSON.stringify({ node_id: 'n1', name: 'n1', capabilities: ['spawn:claude'] }),
      });
      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe('fleet_nodes_disabled');
    });

    it('GET /v1/nodes and /v1/nodes/:name are flagged off (404)', async () => {
      const ws = await createWorkspace(stack.app, 'off-ws');
      const list = await stack.app.request('/v1/nodes', {
        headers: { authorization: `Bearer ${ws.workspaceKey}` },
      });
      expect(list.status).toBe(404);
      expect((await list.json()).error.code).toBe('fleet_nodes_disabled');

      const single = await stack.app.request('/v1/nodes/anything', {
        headers: { authorization: `Bearer ${ws.workspaceKey}` },
      });
      expect(single.status).toBe(404);
      expect((await single.json()).error.code).toBe('fleet_nodes_disabled');
    });

    it('spawn placement refuses (404) while agent-handler actions stay available', async () => {
      const ws = await createWorkspace(stack.app, 'off-ws');
      const caller = await registerAgent(stack.app, ws.workspaceKey, 'caller');

      const spawn = await stack.app.request('/v1/actions/spawn/invoke', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${caller.token}` },
        body: JSON.stringify({ input: { cli: 'claude', name: 'worker-1' } }),
      });
      expect(spawn.status).toBe(404);
      expect((await spawn.json()).error.code).toBe('fleet_nodes_disabled');

      // An agent-handler action is unaffected by the fleet flag.
      const reg = await stack.app.request('/v1/actions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
        body: JSON.stringify({ name: 'ping', description: 'ping handler', handler_agent: 'caller' }),
      });
      expect(reg.status).toBeLessThan(300);
      const invoke = await stack.app.request('/v1/actions/ping/invoke', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${caller.token}` },
        body: JSON.stringify({ input: {} }),
      });
      expect(invoke.status).toBe(201);
    });

    it('declarative trigger evaluation is skipped', async () => {
      const ws = await createWorkspace(stack.app, 'off-ws');
      const caller = await registerAgent(stack.app, ws.workspaceKey, 'caller');

      const trigger = await stack.app.request('/v1/triggers', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
        body: JSON.stringify({ channel: 'general', pattern: 'ship', action_name: 'noop' }),
      });
      expect(trigger.status).toBe(201);
      const triggerId = (await trigger.json()).data.id as string;

      const post = await stack.app.request('/v1/channels/general/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${caller.token}` },
        body: JSON.stringify({ text: 'ship it' }),
      });
      expect(post.status).toBe(201);
      await new Promise((r) => setTimeout(r, 75));

      const after = await stack.app.request(`/v1/triggers/${triggerId}`, {
        headers: { authorization: `Bearer ${ws.workspaceKey}` },
      });
      // Trigger never fired → last_triggered_at stays null.
      expect((await after.json()).data.last_triggered_at).toBeNull();
    });
  });

  describe('per-workspace override flips the surface on', () => {
    let stack: TestStack;
    beforeEach(() => { stack = makeNodeStack({ fleetNodesEnabled: false, ttlMs: 1_000 }); });
    afterEach(() => stack.close());

    it('enables node enrollment + roster, and the WS gate follows the flag', async () => {
      const ws = await createWorkspace(stack.app, 'toggle-ws');

      // Default off → enable for this workspace only.
      const enabled = await setFleetFlag(stack, ws.workspaceKey, true);
      expect(enabled.data).toMatchObject({ enabled: true, override: true });

      const create = await stack.app.request('/v1/nodes', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
        body: JSON.stringify({ node_id: 'node_a', name: 'alpha', capabilities: ['spawn:claude'] }),
      });
      expect(create.status).toBe(201);
      const token = (await create.json()).data.token as string;
      expect(token.startsWith('nt_live_')).toBe(true);

      const roster = await stack.app.request('/v1/nodes', {
        headers: { authorization: `Bearer ${ws.workspaceKey}` },
      });
      expect(roster.status).toBe(200);

      // The node control WS accepts the token while enabled (node adapter answers
      // the post-gate upgrade with 426, never the flag's 404).
      const wsUp = await stack.app.request(`/v1/node/ws?token=${token}`, {
        headers: { Upgrade: 'websocket' },
      });
      expect(wsUp.status).not.toBe(404);

      // Flip back off → token unchanged, but the WS gate now rejects it.
      const disabled = await setFleetFlag(stack, ws.workspaceKey, false);
      expect(disabled.data).toMatchObject({ enabled: false, override: false });

      const wsBlocked = await stack.app.request(`/v1/node/ws?token=${token}`, {
        headers: { Upgrade: 'websocket' },
      });
      expect(wsBlocked.status).toBe(404);
      expect((await wsBlocked.json()).error.code).toBe('fleet_nodes_disabled');

      const rosterBlocked = await stack.app.request('/v1/nodes', {
        headers: { authorization: `Bearer ${ws.workspaceKey}` },
      });
      expect(rosterBlocked.status).toBe(404);
    });
  });

  describe('migration single-delivery guarantee', () => {
    let stack: TestStack;
    beforeEach(() => { stack = makeNodeStack({ fleetNodesEnabled: false, ttlMs: 1_000 }); });
    afterEach(() => stack.close());

    it('a legacy self-connected agent is never also delivered via a node when the flag flips mid-stream', async () => {
      const ws = await createWorkspace(stack.app, 'migrate-ws');
      const sender = await registerAgent(stack.app, ws.workspaceKey, 'sender');
      const legacy = await registerAgent(stack.app, ws.workspaceKey, 'legacy');

      // A shared channel both agents are in (general is auto-seeded + auto-joined).
      // Attach the legacy agent's per-agent WS — the pre-fleet delivery path.
      const legacySock = new FakeSocket();
      stack.runtime.realtime.attachAgentSocket(ws.workspaceId, legacy.agentId, legacySock);

      // --- Flag OFF: message flows over the legacy per-agent WS. ---
      const post1 = await stack.app.request('/v1/channels/general/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${sender.token}` },
        body: JSON.stringify({ text: 'before flip' }),
      });
      expect(post1.status).toBe(201);
      await new Promise((r) => setTimeout(r, 50));
      expect(legacySock.ofType('message.created').length).toBe(1);

      // --- Flag flips ON mid-stream and a node enrolls. ---
      await setFleetFlag(stack, ws.workspaceKey, true);
      const create = await stack.app.request('/v1/nodes', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
        body: JSON.stringify({ node_id: 'mover', name: 'mover', capabilities: ['spawn:claude'] }),
      });
      expect(create.status).toBe(201);

      const nodeSock = new FakeSocket();
      const nodeHandle = stack.runtime.realtime.attachNodeSocket(ws.workspaceId, 'mover', nodeSock);
      await nodeHandle.handleMessage(nodeRegisterFrame({
        id: 'mover',
        name: 'mover',
        capabilities: [{ name: 'spawn:claude', kind: 'spawn' }],
      }));
      await nodeHandle.handleMessage(JSON.stringify({
        v: 1, type: 'node.heartbeat', load: 0, active_agents: 0, handlers_live: true,
      }));

      // The node tries to claim the already-self-connected agent: rejected, because
      // an agent has exactly one active location. This is the single-delivery guard.
      await nodeHandle.handleMessage(JSON.stringify({
        v: 1, id: 'claim-legacy', type: 'agent.register', name: 'legacy',
      }));
      const claimError = nodeSock.ofType('error').find((e) => e.id === 'claim-legacy');
      expect(claimError).toMatchObject({ ok: false, code: 'agent_location_conflict' });

      // --- Another message after the flip: still legacy WS only, no node duplicate. ---
      const post2 = await stack.app.request('/v1/channels/general/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${sender.token}` },
        body: JSON.stringify({ text: 'after flip' }),
      });
      expect(post2.status).toBe(201);
      await new Promise((r) => setTimeout(r, 50));

      // Legacy agent received exactly two messages over its own socket...
      expect(legacySock.ofType('message.created').length).toBe(2);
      // ...and the node received ZERO deliveries for it (location is exclusive).
      const nodeDeliveries = nodeSock.ofType('deliver').filter((d) => d.agent === 'legacy');
      expect(nodeDeliveries.length).toBe(0);
    });
  });
});
