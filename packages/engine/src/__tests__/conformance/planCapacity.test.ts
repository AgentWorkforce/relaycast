import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { EntitlementsProvider, PlanLimits, Workspace, WorkspacePlanLimits } from '../../ports/index.js';
import { workspaces } from '../../db/schema.js';
import { PLAN_LIMITS } from '../../providers/static-entitlements.js';
import { countRegistrations } from '../../engine/planCapacity.js';
import { createWorkspace, FakeSocket, makeNodeStack, registerAgent, type TestStack } from './harness.js';

type Created = { workspaceKey: string; workspaceId: string };

const INTRO = PLAN_LIMITS.intro!;

describe('plan registration caps', () => {
  let stack: TestStack;

  afterEach(async () => {
    vi.restoreAllMocks();
    await stack?.close();
  });

  async function workspaceOnPlan(name: string, plan: string, planLimits?: WorkspacePlanLimits): Promise<Created> {
    const ws = await createWorkspace(stack.app, name);
    await stack.runtime.handle.db
      .update(workspaces)
      .set({ plan, ...(planLimits ? { planLimits } : {}) })
      .where(eq(workspaces.id, ws.workspaceId));
    return ws;
  }

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

  const refusal = (limit: string, max: number, current: number, plan = 'intro') => ({
    ok: false,
    error: { code: 'plan_limit_exceeded' },
    error_code: 'plan_limit_exceeded',
    limit,
    max,
    current,
    plan,
  });

  it('allows the 5th device on intro and refuses the 6th with the machine-readable body', async () => {
    stack = makeNodeStack();
    const ws = await workspaceOnPlan('cap-devices', 'intro');
    expect(INTRO.devices).toBe(5);

    const tokens: string[] = [];
    for (let i = 1; i <= 5; i += 1) {
      const res = await enrollNode(ws, `node_${i}`, `device-${i}`);
      expect(res.status, `device ${i}`).toBe(201);
      tokens.push((await res.json() as { data: { token: string } }).data.token);
    }
    await expect(countRegistrations(stack.runtime.handle.db, ws.workspaceId, 'devices')).resolves.toBe(5);

    const sixth = await enrollNode(ws, 'node_6', 'device-6');
    expect(sixth.status).toBe(429);
    await expect(sixth.json()).resolves.toMatchObject(refusal('devices', 5, 5));

    // Re-enrolling (rotating) an established device is not a new registration.
    const rotate = await enrollNode(ws, 'node_1', 'device-1', tokens[0]);
    expect(rotate.status).toBe(201);
    await expect(countRegistrations(stack.runtime.handle.db, ws.workspaceId, 'devices')).resolves.toBe(5);
  });

  it('does not count an agent\'s implicit direct node as a device', async () => {
    stack = makeNodeStack();
    const ws = await workspaceOnPlan('cap-direct', 'intro', { devices: 1 });
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

  it('counts an explicitly enrolled direct node as a device, so a direct-then-broker re-enroll cannot bypass the cap', async () => {
    stack = makeNodeStack();
    const ws = await workspaceOnPlan('cap-explicit-direct', 'intro', { devices: 1 });
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

  it('allows the 15th agent on intro and refuses the 16th; humans are counted separately', async () => {
    stack = makeNodeStack();
    const ws = await workspaceOnPlan('cap-agents', 'intro');
    expect(INTRO.agents).toBe(15);
    expect(INTRO.humans).toBe(2);

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
    stack = makeNodeStack();
    const ws = await workspaceOnPlan('cap-conflict', 'intro', { agents: 1 });
    expect((await registerAgentRaw(ws, { name: 'only' })).status).toBe(201);
    const again = await registerAgentRaw(ws, { name: 'only' });
    expect(again.status).toBe(409);
    await expect(again.json()).resolves.toMatchObject({ error: { code: 'agent_already_exists' } });
  });

  it('applies a workspace plan_limits override over the plan table', async () => {
    stack = makeNodeStack();
    const ws = await workspaceOnPlan('cap-override', 'enterprise', { devices: 1, agents: null });
    expect((await enrollNode(ws, 'node_1', 'first')).status).toBe(201);
    const second = await enrollNode(ws, 'node_2', 'second');
    expect(second.status).toBe(429);
    await expect(second.json()).resolves.toMatchObject(refusal('devices', 1, 1, 'enterprise'));
    // `agents: null` is unlimited even though it was pushed explicitly.
    expect((await registerAgentRaw(ws, { name: 'free-agent' })).status).toBe(201);
  });

  it('refuses a WebSocket agent.register at the cap with the same detail on the error frame', async () => {
    stack = makeNodeStack();
    const ws = await workspaceOnPlan('cap-ws', 'intro', { agents: 1 });
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
      plan: 'intro',
    });

    // Re-registering the established name is a conflict, not a cap refusal.
    await handle.handleMessage(JSON.stringify({ v: 1, id: 'a3', type: 'agent.register', name: 'worker-1' }));
    expect(sock.ofType('error').at(-1)).toMatchObject({ id: 'a3', code: 'agent_already_exists' });
  });

  it('counts an A2A proxy identity as an agent', async () => {
    stack = makeNodeStack();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}', { status: 200 }));
    const ws = await workspaceOnPlan('cap-a2a', 'intro', { agents: 1 });
    expect((await registerAgentRaw(ws, { name: 'local' })).status).toBe(201);

    const register = () => stack.app.request('/v1/a2a/register', {
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
    const refused = await register();
    expect(refused.status).toBe(429);
    await expect(refused.json()).resolves.toMatchObject(refusal('agents', 1, 1));
  });

  it('leaves legacy and self-host tiers uncapped', async () => {
    stack = makeNodeStack();
    for (const plan of ['free', 'connect', 'selfhost', 'enterprise']) {
      const limits = PLAN_LIMITS[plan]!;
      expect(limits.devices, plan).toBeNull();
      expect(limits.humans, plan).toBeNull();
      expect(limits.agents, plan).toBe(Infinity);
    }
    const ws = await workspaceOnPlan('cap-legacy', 'free');
    for (let i = 1; i <= 6; i += 1) {
      expect((await enrollNode(ws, `node_${i}`, `device-${i}`)).status).toBe(201);
    }
  });

  it('fails open when the entitlements provider cannot answer', async () => {
    const broken: EntitlementsProvider = {
      async getLimits(): Promise<PlanLimits> {
        throw new Error('billing unavailable');
      },
      async getUsage() {
        return 0;
      },
    };
    stack = makeNodeStack({ entitlements: broken });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ws = await workspaceOnPlan('cap-fail-open', 'intro');
    expect((await enrollNode(ws, 'node_1', 'device')).status).toBe(201);
    expect(warn).toHaveBeenCalledWith('[plan-capacity] entitlements lookup failed; allowing registration', expect.objectContaining({ metric: 'devices' }));
  });

  it('reports the provider\'s effective plan in the refusal', async () => {
    const raised: EntitlementsProvider = {
      async getLimits(workspace: Workspace): Promise<PlanLimits> {
        return { ...PLAN_LIMITS.pro!, devices: 1, ...(workspace.planLimits ?? {}) } as PlanLimits;
      },
      getUsage: (workspaceId, metric) =>
        countRegistrations(stack.runtime.handle.db, workspaceId, metric as 'devices' | 'agents' | 'humans'),
      async getPlan() {
        return 'pro';
      },
    };
    stack = makeNodeStack({ entitlements: raised });
    const ws = await workspaceOnPlan('cap-effective-plan', 'intro');
    expect((await enrollNode(ws, 'node_1', 'first')).status).toBe(201);
    const second = await enrollNode(ws, 'node_2', 'second');
    expect(second.status).toBe(429);
    await expect(second.json()).resolves.toMatchObject(refusal('devices', 1, 1, 'pro'));
  });
});
