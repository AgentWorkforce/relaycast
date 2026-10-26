import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntitlementsProvider, Limits, Workspace } from '../../ports/index.js';
import { resolveLimits } from '../../ports/entitlements.js';
import { countRegistrations } from '../../engine/planCapacity.js';
import { createWorkspace, FakeSocket, makeNodeStack, registerAgent, type TestStack } from './harness.js';

type Created = { workspaceKey: string; workspaceId: string };

/** The caps a hosted tier might carry; the engine only knows the numbers. */
const CAPPED = { devices: 5, agents: 15, humans: 2 } as const;

describe('registration caps', () => {
  let stack: TestStack;

  afterEach(async () => {
    vi.restoreAllMocks();
    await stack?.close();
  });

  function enrollNode(ws: Created, nodeId: string, name: string, currentToken?: string) {
    return stack.app.request('/v1/nodes', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ws.workspaceKey}`,
        ...(currentToken ? { 'X-Relaycast-Node-Token': currentToken } : {}),
      },
      body: JSON.stringify({ node_id: nodeId, name, role: 'broker', capabilities: [], max_agents: 4, tags: ['test'], version: 'v0' }),
    });
  }

  function registerAgentRaw(ws: Created, body: Record<string, unknown>) {
    return stack.app.request('/v1/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify(body),
    });
  }

  const refusal = (limit: string, max: number, current: number) => ({
    ok: false,
    error: { code: 'plan_limit_exceeded' },
    error_code: 'plan_limit_exceeded',
    limit,
    max,
    current,
  });

  it('allows the 5th device and refuses the 6th with the machine-readable body', async () => {
    stack = makeNodeStack({ limits: CAPPED });
    const ws = await createWorkspace(stack.app, 'cap-devices');

    const tokens: string[] = [];
    for (let i = 1; i <= 5; i += 1) {
      const res = await enrollNode(ws, `node_${i}`, `device-${i}`);
      expect(res.status, `device ${i}`).toBe(201);
      tokens.push((await res.json() as { data: { token: string } }).data.token);
    }
    await expect(countRegistrations(stack.runtime.handle.db, ws.workspaceId, 'devices')).resolves.toBe(5);

    const sixth = await enrollNode(ws, 'node_6', 'device-6');
    expect(sixth.status).toBe(429);
    const body = await sixth.json() as Record<string, unknown>;
    expect(body).toMatchObject(refusal('devices', 5, 5));
    // The engine adds nothing it does not know: no tier name without a provider context.
    expect(body).not.toHaveProperty('plan');

    // Re-enrolling (rotating) an established device is not a new registration.
    const rotate = await enrollNode(ws, 'node_1', 'device-1', tokens[0]);
    expect(rotate.status).toBe(201);
    await expect(countRegistrations(stack.runtime.handle.db, ws.workspaceId, 'devices')).resolves.toBe(5);
  });

  it('does not count an agent\'s implicit direct node as a device', async () => {
    stack = makeNodeStack({ limits: { devices: 1 } });
    const ws = await createWorkspace(stack.app, 'cap-direct');
    expect((await enrollNode(ws, 'node_1', 'only-device')).status).toBe(201);

    const agent = await registerAgent(stack.app, ws.workspaceKey, 'worker');
    const nodeToken = await stack.app.request('/v1/agent/node-token', {
      method: 'POST',
      headers: { authorization: `Bearer ${agent.token}` },
    });
    expect(nodeToken.status).toBe(200);
    await expect(countRegistrations(stack.runtime.handle.db, ws.workspaceId, 'devices')).resolves.toBe(1);
    expect((await enrollNode(ws, 'node_2', 'second-device')).status).toBe(429);
  });

  it('refuses host enrollment into the reserved implicit-direct id namespace', async () => {
    stack = makeNodeStack({ limits: { devices: 1 } });
    const ws = await createWorkspace(stack.app, 'cap-reserved-id');
    expect((await enrollNode(ws, 'node_1', 'only-device')).status).toBe(201);

    const spoofed = await stack.app.request('/v1/nodes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({ node_id: 'node_direct_custom', name: 'spoof', role: 'direct', max_agents: 1 }),
    });
    expect(spoofed.status).toBe(400);
    await expect(spoofed.json()).resolves.toMatchObject({ error: { code: 'reserved_node_id' } });
    await expect(countRegistrations(stack.runtime.handle.db, ws.workspaceId, 'devices')).resolves.toBe(1);
  });

  it('counts an explicitly enrolled direct node as a device, so a direct-then-broker re-enroll cannot bypass the cap', async () => {
    stack = makeNodeStack({ limits: { devices: 1 } });
    const ws = await createWorkspace(stack.app, 'cap-explicit-direct');
    const direct = await stack.app.request('/v1/nodes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({ node_id: 'node_d', name: 'webhook', kind: 'http_push', role: 'direct', max_agents: 1, delivery: { url: 'https://hooks.example/relay' } }),
    });
    expect(direct.status).toBe(201);
    const token = (await direct.json() as { data: { token: string } }).data.token;
    await expect(countRegistrations(stack.runtime.handle.db, ws.workspaceId, 'devices')).resolves.toBe(1);

    const broker = await enrollNode(ws, 'node_b', 'broker');
    expect(broker.status).toBe(429);
    await expect(broker.json()).resolves.toMatchObject(refusal('devices', 1, 1));

    // Re-enrolling the counted node as a broker changes its shape, not the count.
    const reshaped = await enrollNode(ws, 'node_d', 'webhook', token);
    expect(reshaped.status).toBe(201);
    await expect(countRegistrations(stack.runtime.handle.db, ws.workspaceId, 'devices')).resolves.toBe(1);
    expect((await enrollNode(ws, 'node_b', 'broker')).status).toBe(429);
  });

  it('allows the 15th agent and refuses the 16th; humans are counted separately', async () => {
    stack = makeNodeStack({ limits: CAPPED });
    const ws = await createWorkspace(stack.app, 'cap-agents');

    for (let i = 1; i <= 15; i += 1) {
      expect((await registerAgentRaw(ws, { name: `agent-${i}` })).status, `agent ${i}`).toBe(201);
    }
    const sixteenth = await registerAgentRaw(ws, { name: 'agent-16' });
    expect(sixteenth.status).toBe(429);
    await expect(sixteenth.json()).resolves.toMatchObject(refusal('agents', 15, 15));

    // Humans have their own cap and do not consume agent slots.
    expect((await registerAgentRaw(ws, { name: 'will', type: 'human' })).status).toBe(201);
    expect((await registerAgentRaw(ws, { name: 'khaliq', type: 'human' })).status).toBe(201);
    const third = await registerAgentRaw(ws, { name: 'third-human', type: 'human' });
    expect(third.status).toBe(429);
    await expect(third.json()).resolves.toMatchObject(refusal('humans', 2, 2));
    await expect(countRegistrations(stack.runtime.handle.db, ws.workspaceId, 'agents')).resolves.toBe(15);
    await expect(countRegistrations(stack.runtime.handle.db, ws.workspaceId, 'humans')).resolves.toBe(2);
  });

  it('answers an established name with the conflict, never the cap', async () => {
    stack = makeNodeStack({ limits: { agents: 1 } });
    const ws = await createWorkspace(stack.app, 'cap-conflict');
    expect((await registerAgentRaw(ws, { name: 'only' })).status).toBe(201);
    const again = await registerAgentRaw(ws, { name: 'only' });
    expect(again.status).toBe(409);
    await expect(again.json()).resolves.toMatchObject({ error: { code: 'agent_already_exists' } });
  });

  it('refuses a WebSocket agent.register at the cap with the same detail on the error frame', async () => {
    stack = makeNodeStack({ limits: { agents: 1 } });
    const ws = await createWorkspace(stack.app, 'cap-ws');
    expect((await enrollNode(ws, 'node_a', 'alpha')).status).toBe(201);

    const sock = new FakeSocket();
    const handle = stack.runtime.realtime.attachNodeSocket(ws.workspaceId, 'node_a', sock);
    await handle.handleMessage(JSON.stringify({
      v: 1, id: 'reg', type: 'node.register', name: 'alpha', node_id: 'node_a',
      capabilities: [{ name: 'spawn:claude', kind: 'capacity' }],
      max_agents: 4, tags: [], version: 'test-node', resume_cursor: null,
    }));
    await handle.handleMessage(JSON.stringify({ v: 1, id: 'a1', type: 'agent.register', name: 'worker-1' }));
    expect(sock.ofType('reply').at(-1)).toMatchObject({ id: 'a1', ok: true });

    await handle.handleMessage(JSON.stringify({ v: 1, id: 'a2', type: 'agent.register', name: 'worker-2' }));
    expect(sock.ofType('error').at(-1)).toMatchObject({
      id: 'a2',
      ok: false,
      code: 'plan_limit_exceeded',
      error_code: 'plan_limit_exceeded',
      limit: 'agents',
      max: 1,
      current: 1,
    });

    // Re-registering the established name is a conflict, not a cap refusal.
    await handle.handleMessage(JSON.stringify({ v: 1, id: 'a3', type: 'agent.register', name: 'worker-1' }));
    expect(sock.ofType('error').at(-1)).toMatchObject({ id: 'a3', code: 'agent_already_exists' });
  });

  it('counts an A2A proxy identity as an agent', async () => {
    stack = makeNodeStack({ limits: { agents: 1 } });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}', { status: 200 }));
    const ws = await createWorkspace(stack.app, 'cap-a2a');
    expect((await registerAgentRaw(ws, { name: 'local' })).status).toBe(201);

    const refused = await stack.app.request('/v1/a2a/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({
        agent_card: {
          name: 'northwind',
          url: 'https://northwind.example/a2a/rpc',
          version: '1.0.0',
          skills: [{ id: 'lead', name: 'lead' }],
        },
      }),
    });
    expect(refused.status).toBe(429);
    await expect(refused.json()).resolves.toMatchObject(refusal('agents', 1, 1));
  });

  it('caps nothing by default', async () => {
    stack = makeNodeStack();
    const ws = await createWorkspace(stack.app, 'cap-default');
    for (let i = 1; i <= 6; i += 1) {
      expect((await enrollNode(ws, `node_${i}`, `device-${i}`)).status).toBe(201);
    }
    for (let i = 1; i <= 3; i += 1) {
      expect((await registerAgentRaw(ws, { name: `human-${i}`, type: 'human' })).status).toBe(201);
    }
  });

  it('fails open when the entitlements provider cannot answer', async () => {
    const broken: EntitlementsProvider = {
      async getLimits(): Promise<Limits> {
        throw new Error('billing unavailable');
      },
      async getUsage() {
        return 0;
      },
    };
    stack = makeNodeStack({ entitlements: broken });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ws = await createWorkspace(stack.app, 'cap-fail-open');
    expect((await enrollNode(ws, 'node_1', 'device')).status).toBe(201);
    expect(warn).toHaveBeenCalledWith('[plan-capacity] entitlements lookup failed; allowing registration', expect.objectContaining({ metric: 'devices' }));
  });

  it('spreads the provider\'s limit context onto the refusal, on HTTP and on the error frame', async () => {
    const hosted: EntitlementsProvider = {
      async getLimits(_workspace: Workspace): Promise<Limits> {
        return resolveLimits({ devices: 1, agents: 1 });
      },
      getUsage: (workspaceId, metric) =>
        countRegistrations(stack.runtime.handle.db, workspaceId, metric as 'devices' | 'agents' | 'humans'),
      async getLimitContext() {
        return { plan: 'tier-small', upgrade_url: 'https://host.example/upgrade', ok: 'cannot clobber' };
      },
    };
    stack = makeNodeStack({ entitlements: hosted });
    const ws = await createWorkspace(stack.app, 'cap-context');
    expect((await enrollNode(ws, 'node_1', 'first')).status).toBe(201);
    const second = await enrollNode(ws, 'node_2', 'second');
    expect(second.status).toBe(429);
    await expect(second.json()).resolves.toEqual({
      ...refusal('devices', 1, 1),
      error: { code: 'plan_limit_exceeded', message: expect.any(String) },
      plan: 'tier-small',
      upgrade_url: 'https://host.example/upgrade',
    });

    const sock = new FakeSocket();
    const handle = stack.runtime.realtime.attachNodeSocket(ws.workspaceId, 'node_1', sock);
    await handle.handleMessage(JSON.stringify({
      v: 1, id: 'reg', type: 'node.register', name: 'first', node_id: 'node_1',
      capabilities: [], max_agents: 4, tags: [], version: 'test-node', resume_cursor: null,
    }));
    expect((await registerAgentRaw(ws, { name: 'only-agent' })).status).toBe(201);
    await handle.handleMessage(JSON.stringify({ v: 1, id: 'a2', type: 'agent.register', name: 'second-agent' }));
    expect(sock.ofType('error').at(-1)).toMatchObject({
      id: 'a2',
      ok: false,
      code: 'plan_limit_exceeded',
      limit: 'agents',
      max: 1,
      current: 1,
      plan: 'tier-small',
      upgrade_url: 'https://host.example/upgrade',
    });
  });
});
