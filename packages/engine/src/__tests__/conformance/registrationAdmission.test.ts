import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdmissionContext, AdmissionHooks, RegistrationAdmissionAction } from '../../ports/index.js';
import { countRegistrations } from '../../engine/registrationAdmission.js';
import { createWorkspace, FakeSocket, makeNodeStack, registerAgent, type TestStack } from './harness.js';

type Created = { workspaceKey: string; workspaceId: string };
type Caps = Partial<Record<RegistrationAdmissionAction, number>>;

/** Caps a host might set; the engine only reports the live count. */
const CAPPED: Caps = { register_device: 5, register_agent: 15, register_human: 2 };

const LIMIT_NAME: Record<RegistrationAdmissionAction, string> = {
  register_device: 'devices',
  register_agent: 'agents',
  register_human: 'humans',
};

/** A host that denies a registration once `registered` reaches its cap. */
function cappingHost(caps: Caps, seen: AdmissionContext[] = []): AdmissionHooks {
  return {
    async admit(ctx) {
      seen.push(ctx);
      if (ctx.action === 'request' || ctx.action === 'message') return null;
      const max = caps[ctx.action];
      if (max === undefined || (ctx.registered ?? 0) < max) return null;
      return {
        status: 429,
        code: 'limit_reached',
        message: `${LIMIT_NAME[ctx.action]} limit reached`,
        details: { limit: LIMIT_NAME[ctx.action], max, current: ctx.registered },
      };
    },
  };
}

describe('registration admission', () => {
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
    error: { code: 'limit_reached', limit, max, current },
  });

  it('admits the 5th device and denies the 6th with the host\'s details', async () => {
    stack = makeNodeStack({ admission: cappingHost(CAPPED) });
    const ws = await createWorkspace(stack.app, 'cap-devices');

    const tokens: string[] = [];
    for (let i = 1; i <= 5; i += 1) {
      const res = await enrollNode(ws, `node_${i}`, `device-${i}`);
      expect(res.status, `device ${i}`).toBe(201);
      tokens.push((await res.json() as { data: { token: string } }).data.token);
    }
    await expect(countRegistrations(stack.runtime.handle.db, ws.workspaceId, 'register_device')).resolves.toBe(5);

    const sixth = await enrollNode(ws, 'node_6', 'device-6');
    expect(sixth.status).toBe(429);
    const body = await sixth.json() as Record<string, unknown>;
    expect(body).toMatchObject(refusal('devices', 5, 5));
    // The engine adds nothing the host did not put on the denial.
    expect(Object.keys(body).sort()).toEqual(['error', 'ok']);

    // Re-enrolling (rotating) an established device is not a new registration.
    const rotate = await enrollNode(ws, 'node_1', 'device-1', tokens[0]);
    expect(rotate.status).toBe(201);
    await expect(countRegistrations(stack.runtime.handle.db, ws.workspaceId, 'register_device')).resolves.toBe(5);
  });

  it('does not count an agent\'s implicit direct node as a device', async () => {
    stack = makeNodeStack({ admission: cappingHost({ register_device: 1 }) });
    const ws = await createWorkspace(stack.app, 'cap-direct');
    expect((await enrollNode(ws, 'node_1', 'only-device')).status).toBe(201);

    const agent = await registerAgent(stack.app, ws.workspaceKey, 'worker');
    const nodeToken = await stack.app.request('/v1/agent/node-token', {
      method: 'POST',
      headers: { authorization: `Bearer ${agent.token}` },
    });
    expect(nodeToken.status).toBe(200);
    await expect(countRegistrations(stack.runtime.handle.db, ws.workspaceId, 'register_device')).resolves.toBe(1);
    expect((await enrollNode(ws, 'node_2', 'second-device')).status).toBe(429);
  });

  it('refuses host enrollment into the reserved implicit-direct id namespace', async () => {
    stack = makeNodeStack({ admission: cappingHost({ register_device: 1 }) });
    const ws = await createWorkspace(stack.app, 'cap-reserved-id');
    expect((await enrollNode(ws, 'node_1', 'only-device')).status).toBe(201);

    const spoofed = await stack.app.request('/v1/nodes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({ node_id: 'node_direct_custom', name: 'spoof', role: 'direct', max_agents: 1 }),
    });
    expect(spoofed.status).toBe(400);
    await expect(spoofed.json()).resolves.toMatchObject({ error: { code: 'reserved_node_id' } });
    await expect(countRegistrations(stack.runtime.handle.db, ws.workspaceId, 'register_device')).resolves.toBe(1);

    // A near miss on the prefix (`_` is a LIKE wildcard, not a GLOB one) is an
    // ordinary host-enrolled direct node: not reserved, and counted.
    const nearMiss = await stack.app.request('/v1/nodes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({ node_id: 'nodeXdirectXcustom', name: 'near-miss', role: 'direct', max_agents: 1 }),
    });
    expect(nearMiss.status).toBe(429);
    await expect(nearMiss.json()).resolves.toMatchObject(refusal('devices', 1, 1));
  });

  it('counts an explicitly enrolled direct node as a device, so a direct-then-broker re-enroll cannot bypass the cap', async () => {
    stack = makeNodeStack({ admission: cappingHost({ register_device: 1 }) });
    const ws = await createWorkspace(stack.app, 'cap-explicit-direct');
    const direct = await stack.app.request('/v1/nodes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({ node_id: 'node_d', name: 'webhook', kind: 'http_push', role: 'direct', max_agents: 1, delivery: { url: 'https://hooks.example/relay' } }),
    });
    expect(direct.status).toBe(201);
    const token = (await direct.json() as { data: { token: string } }).data.token;
    await expect(countRegistrations(stack.runtime.handle.db, ws.workspaceId, 'register_device')).resolves.toBe(1);

    const broker = await enrollNode(ws, 'node_b', 'broker');
    expect(broker.status).toBe(429);
    await expect(broker.json()).resolves.toMatchObject(refusal('devices', 1, 1));

    // Re-enrolling the counted node as a broker changes its shape, not the count.
    const reshaped = await enrollNode(ws, 'node_d', 'webhook', token);
    expect(reshaped.status).toBe(201);
    await expect(countRegistrations(stack.runtime.handle.db, ws.workspaceId, 'register_device')).resolves.toBe(1);
    expect((await enrollNode(ws, 'node_b', 'broker')).status).toBe(429);
  });

  it('admits the 15th agent and denies the 16th; humans are counted separately', async () => {
    stack = makeNodeStack({ admission: cappingHost(CAPPED) });
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
    await expect(countRegistrations(stack.runtime.handle.db, ws.workspaceId, 'register_agent')).resolves.toBe(15);
    await expect(countRegistrations(stack.runtime.handle.db, ws.workspaceId, 'register_human')).resolves.toBe(2);
  });

  it('answers an established name with the conflict, never a denial', async () => {
    stack = makeNodeStack({ admission: cappingHost({ register_agent: 1 }) });
    const ws = await createWorkspace(stack.app, 'cap-conflict');
    expect((await registerAgentRaw(ws, { name: 'only' })).status).toBe(201);
    const again = await registerAgentRaw(ws, { name: 'only' });
    expect(again.status).toBe(409);
    await expect(again.json()).resolves.toMatchObject({ error: { code: 'agent_already_exists' } });
  });

  it('denies a WebSocket agent.register with the same details on the error frame', async () => {
    stack = makeNodeStack({ admission: cappingHost({ register_agent: 1 }) });
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
      code: 'limit_reached',
      limit: 'agents',
      max: 1,
      current: 1,
    });

    // Re-registering the established name is a conflict, not a cap refusal.
    await handle.handleMessage(JSON.stringify({ v: 1, id: 'a3', type: 'agent.register', name: 'worker-1' }));
    expect(sock.ofType('error').at(-1)).toMatchObject({ id: 'a3', code: 'agent_already_exists' });
  });

  it('counts an A2A proxy identity as an agent', async () => {
    stack = makeNodeStack({ admission: cappingHost({ register_agent: 1 }) });
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

  it('admits every registration without an admit hook', async () => {
    stack = makeNodeStack();
    const ws = await createWorkspace(stack.app, 'cap-default');
    for (let i = 1; i <= 6; i += 1) {
      expect((await enrollNode(ws, `node_${i}`, `device-${i}`)).status).toBe(201);
    }
    for (let i = 1; i <= 3; i += 1) {
      expect((await registerAgentRaw(ws, { name: `human-${i}`, type: 'human' })).status).toBe(201);
    }
  });

  it('admits when the hook throws', async () => {
    stack = makeNodeStack({
      admission: {
        async admit() {
          throw new Error('metering unavailable');
        },
      },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ws = await createWorkspace(stack.app, 'cap-fail-open');
    expect((await enrollNode(ws, 'node_1', 'device')).status).toBe(201);
    expect(warn).toHaveBeenCalledWith(
      '[admission] registration admission failed; admitting',
      expect.objectContaining({ action: 'register_device' }),
    );
  });

  it('passes the workspace, action and live count to the hook', async () => {
    const seen: AdmissionContext[] = [];
    stack = makeNodeStack({ admission: cappingHost({}, seen) });
    const ws = await createWorkspace(stack.app, 'cap-context');
    expect((await enrollNode(ws, 'node_1', 'first')).status).toBe(201);
    expect((await enrollNode(ws, 'node_2', 'second')).status).toBe(201);
    expect((await registerAgentRaw(ws, { name: 'h', type: 'human' })).status).toBe(201);

    const registrations = seen.filter((ctx) => ctx.action.startsWith('register_'));
    expect(registrations.map((ctx) => [ctx.action, ctx.registered])).toEqual([
      ['register_device', 0],
      ['register_device', 1],
      ['register_human', 0],
    ]);
    expect(registrations.every((ctx) => ctx.workspace.id === ws.workspaceId)).toBe(true);
  });
});
