import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { makeNodeStack, createWorkspace, registerAgent, FakeSocket, type TestStack } from './harness.js';
import { agents, messages, nodes } from '../../db/schema.js';
import { parseAgentAddress, SENDER_ADDRESS_METADATA_KEY } from '../../engine/address.js';

type Json = Record<string, unknown>;

/**
 * POST /v1/to/:address — send a DM to `agent@machine`, where `machine` is the
 * agent's current broker node (by node name or machine_id), or `direct` for an
 * agent not hosted on a broker.
 */
describe('addressed send', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack({ ttlMs: 60_000 }); });
  afterEach(async () => {
    await stack.close();
  });

  async function enrollBroker(
    ws: { workspaceKey: string; workspaceId: string },
    nodeId: string,
    name: string,
    machineId?: string,
    tags: string[] = [],
  ) {
    const enroll = await stack.app.request('/v1/nodes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({
        node_id: nodeId, name, ...(machineId ? { machine_id: machineId } : {}), tags,
        capabilities: ['spawn:claude'], max_agents: 4, version: 'test-node',
      }),
    });
    expect(enroll.status).toBe(201);

    const sock = new FakeSocket();
    const handle = stack.runtime.realtime.attachNodeSocket(ws.workspaceId, nodeId, sock);
    await handle.handleMessage(JSON.stringify({
      v: 1, type: 'node.register', name, node_id: nodeId,
      capabilities: [{ name: 'spawn:claude', kind: 'capacity' }],
      max_agents: 4, tags: [], version: 'test-node', resume_cursor: null,
    }));
    await handle.handleMessage(JSON.stringify({
      v: 1, type: 'node.heartbeat', load: 0, active_agents: 0, handlers_live: true,
    }));
    return { sock, handle };
  }

  /** alice is self-connected; bob runs on broker node `laptop` (machine_id `mach-123`). */
  async function seed() {
    const ws = await createWorkspace(stack.app, 'address-ws');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const laptop = await enrollBroker(ws, 'node_laptop', 'laptop', 'mach-123');
    await laptop.handle.handleMessage(JSON.stringify({
      v: 1, type: 'agent.register', name: 'bob', resumable: true, session_ref: 'sess-bob',
    }));
    const reply = laptop.sock.ofType('reply').at(-1) as { ok: boolean; data: { agent_id: string; token: string } };
    expect(reply?.ok).toBe(true);
    const bob = { agentId: reply.data.agent_id, token: reply.data.token };
    return { ws, alice, bob, laptop };
  }

  function send(token: string, address: string, body: unknown, headers: Record<string, string> = {}) {
    return stack.app.request(`/v1/to/${encodeURIComponent(address)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers },
      body: JSON.stringify(body),
    });
  }

  async function errorCode(res: Response) {
    return ((await res.json()) as { error: { code: string } }).error.code;
  }

  function deliveredDms(sock: FakeSocket) {
    return sock.ofType('deliver')
      .map((frame) => (frame as { payload?: { type?: string; data?: { message?: Json } } }).payload)
      .filter((payload) => payload?.type === 'dm.received')
      .map((payload) => payload!.data!.message!);
  }

  async function moveAgent(agentId: string, nodeId: string) {
    await stack.runtime.deps.db.update(agents).set({ locationNodeId: nodeId }).where(eq(agents.id, agentId));
  }

  it('parses agent@machine on the last @', () => {
    expect(parseAgentAddress('bob@laptop')).toEqual({ agent: 'bob', machine: 'laptop' });
    expect(parseAgentAddress('a@b@laptop')).toEqual({ agent: 'a@b', machine: 'laptop' });
    expect(parseAgentAddress('bob')).toBeNull();
    expect(parseAgentAddress('@laptop')).toBeNull();
    expect(parseAgentAddress('bob@')).toBeNull();
  });

  it('routes to the agent by node name and by machine_id, delivering on that machine', async () => {
    const { alice, laptop } = await seed();

    for (const address of ['bob@laptop', 'bob@mach-123']) {
      const res = await send(alice.token, address, { text: `hi via ${address}` });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { ok: boolean; data: { text: string } };
      expect(body.ok).toBe(true);
      expect(body.data.text).toBe(`hi via ${address}`);
    }

    await stack.settle();
    expect(deliveredDms(laptop.sock).map((message) => message.text))
      .toEqual(['hi via bob@laptop', 'hi via bob@mach-123']);
  });

  it('accepts an unencoded @ in the path', async () => {
    const { alice } = await seed();
    const res = await stack.app.request('/v1/to/bob@laptop', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ text: 'raw' }),
    });
    expect(res.status).toBe(201);
  });

  it('addresses agents without a broker as agent@direct', async () => {
    const { alice, bob } = await seed();
    expect((await send(bob.token, 'alice@direct', { text: 'to a self-connected agent' })).status).toBe(201);

    // `direct` never matches an agent that is on a broker.
    expect(await errorCode(await send(alice.token, 'bob@direct', { text: 'x' }))).toBe('address_not_found');
    // A self-connected agent is not on any named machine.
    expect(await errorCode(await send(bob.token, 'alice@laptop', { text: 'x' }))).toBe('address_not_found');
  });

  it('rejects addresses that do not match the agent, without revealing which part failed', async () => {
    const { ws, alice } = await seed();
    for (const address of ['bob@desktop', 'carol@laptop', 'Bob@laptop', 'bob@Laptop', ' bob@laptop']) {
      const res = await send(alice.token, address, { text: 'x' });
      expect(res.status, address).toBe(404);
      expect(await errorCode(res)).toBe('address_not_found');
    }

    const deleted = await stack.app.request('/v1/agents/bob', {
      method: 'DELETE', headers: { authorization: `Bearer ${ws.workspaceKey}` },
    });
    expect(deleted.status).toBe(204);
    expect(await errorCode(await send(alice.token, 'bob@laptop', { text: 'x' }))).toBe('address_not_found');
  });

  it('rejects malformed addresses and missing text', async () => {
    const { alice } = await seed();
    for (const address of ['bob', '@laptop', 'bob@']) {
      const res = await send(alice.token, address, { text: 'x' });
      expect(res.status, address).toBe(400);
      expect(await errorCode(res)).toBe('invalid_address');
    }
    expect((await send(alice.token, 'bob@laptop', {})).status).toBe(400);
  });

  it('follows the agent when it moves: the old address fails, the new one routes', async () => {
    const { ws, alice, bob } = await seed();
    const desktop = await enrollBroker(ws, 'node_desktop', 'desktop', 'mach-456');
    await moveAgent(bob.agentId, 'node_desktop');

    expect(await errorCode(await send(alice.token, 'bob@laptop', { text: 'stale' }))).toBe('address_not_found');
    expect((await send(alice.token, 'bob@desktop', { text: 'moved' })).status).toBe(201);
    await stack.settle();
    expect(deliveredDms(desktop.sock).map((message) => message.text)).toEqual(['moved']);
  });

  it('queues for an offline machine and redelivers with the sender address on reconnect', async () => {
    const { ws, alice, bob, laptop } = await seed();
    await laptop.handle.handleClose();
    expect((await send(alice.token, 'bob@laptop', { text: 'while offline' })).status).toBe(201);

    const reconnected = await enrollBroker(ws, 'node_laptop', 'laptop', 'mach-123');
    await reconnected.handle.handleMessage(JSON.stringify({
      v: 1, type: 'inventory.sync', agents: [{ agent_id: bob.agentId, name: 'bob', session_ref: 'sess-bob' }],
    }));
    await stack.settle();
    expect(deliveredDms(reconnected.sock)).toEqual([
      expect.objectContaining({ text: 'while offline', agent_address: 'alice@direct' }),
    ]);
  });

  describe('cloud sandboxes', () => {
    // Cloud enrolls a sandbox as a broker node named `fleet-ensure-<id>` with
    // server-owned `cloud:*` tags and no machine_id, and tears it down by
    // deleting the node row, which nulls its agents' location.
    const SANDBOX = 'fleet-ensure-3f9a1c2d';

    async function seedSandbox() {
      const { ws, alice, bob } = await seed();
      const sandbox = await enrollBroker(ws, 'node_sandbox', SANDBOX, undefined,
        ['cloud:sandbox-provider:daytona', 'cloud:sandbox-id:sbx_123']);
      await sandbox.handle.handleMessage(JSON.stringify({
        v: 1, type: 'agent.register', name: 'worker', resumable: true, session_ref: 'sess-worker',
      }));
      const reply = sandbox.sock.ofType('reply').at(-1) as { ok: boolean; data: { token: string } };
      expect(reply?.ok).toBe(true);
      return { ws, alice, bob, sandbox, worker: { token: reply.data.token } };
    }

    async function addressOf(ws: { workspaceKey: string }, name: string) {
      const res = await stack.app.request(`/v1/agents/${name}`, {
        headers: { authorization: `Bearer ${ws.workspaceKey}` },
      });
      return ((await res.json()) as { data: Json }).data.address;
    }

    it('addresses a sandboxed agent by its sandbox node name, both ways', async () => {
      const { ws, alice, sandbox, worker } = await seedSandbox();
      expect(await addressOf(ws, 'worker')).toBe(`worker@${SANDBOX}`);

      expect((await send(alice.token, `worker@${SANDBOX}`, { text: 'into the sandbox' })).status).toBe(201);
      await stack.settle();
      expect(deliveredDms(sandbox.sock).map((message) => message.text)).toEqual(['into the sandbox']);

      // Out of the sandbox, carrying the sandbox address for the reply.
      const res = await send(worker.token, 'alice@direct', { text: 'from the sandbox' });
      expect(((await res.json()) as { data: { message: Json } }).data.message.agent_address)
        .toBe(`worker@${SANDBOX}`);
      // Server-owned cloud tags are not machine names.
      expect(await errorCode(await send(alice.token, 'worker@sbx_123', { text: 'x' }))).toBe('address_not_found');
    });

    it('leaves a torn-down sandbox agent with no address instead of falling back to direct', async () => {
      const { ws, alice } = await seedSandbox();
      await stack.runtime.deps.db.delete(nodes).where(eq(nodes.id, 'node_sandbox'));

      expect(await addressOf(ws, 'worker')).toBeNull();
      for (const address of [`worker@${SANDBOX}`, 'worker@direct']) {
        expect(await errorCode(await send(alice.token, address, { text: 'x' })), address).toBe('address_not_found');
      }
    });

    it('sends from an unhosted agent without an agent_address', async () => {
      const { ws, alice, bob } = await seedSandbox();
      await stack.runtime.deps.db.update(agents).set({ locationNodeId: null }).where(eq(agents.id, bob.agentId));
      const res = await send(bob.token, 'alice@direct', { text: 'from nowhere' });
      expect(res.status).toBe(201);
      expect(((await res.json()) as { data: { message: Json } }).data.message).not.toHaveProperty('agent_address');
      void ws; void alice;
    });
  });

  describe('idempotent retries', () => {
    it('replays an accepted send even after the agent moves', async () => {
      const { ws, alice, bob } = await seed();
      const key = { 'Idempotency-Key': 'retry-1' };
      const first = await send(alice.token, 'bob@laptop', { text: 'once' }, key);
      expect(first.status).toBe(201);
      const firstId = ((await first.json()) as { data: { id: string } }).data.id;

      await enrollBroker(ws, 'node_desktop', 'desktop', 'mach-456');
      await moveAgent(bob.agentId, 'node_desktop');

      const retry = await send(alice.token, 'bob@laptop', { text: 'once' }, key);
      expect(retry.status).toBe(201);
      expect(((await retry.json()) as { data: { id: string } }).data.id).toBe(firstId);

      const sent = await stack.runtime.deps.db.select().from(messages).where(eq(messages.body, 'once'));
      expect(sent).toHaveLength(1);
    });

    it('rejects reusing a key for a different address or for /v1/dm', async () => {
      const { alice } = await seed();
      const key = { 'Idempotency-Key': 'retry-2' };
      expect((await send(alice.token, 'bob@laptop', { text: 'same' }, key)).status).toBe(201);

      const otherAddress = await send(alice.token, 'bob@mach-123', { text: 'same' }, key);
      expect(otherAddress.status).toBe(409);
      expect(await errorCode(otherAddress)).toBe('idempotency_key_reused');

      const viaDm = await stack.app.request('/v1/dm', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}`, ...key },
        body: JSON.stringify({ to: 'bob', text: 'same' }),
      });
      expect(viaDm.status).toBe(409);
    });

    it('does not record a failed resolution, so a later send with the key can succeed', async () => {
      const { alice } = await seed();
      const key = { 'Idempotency-Key': 'retry-3' };
      expect((await send(alice.token, 'bob@desktop', { text: 'x' }, key)).status).toBe(404);
      // Nothing was accepted under the key yet, so a valid address is not a reuse conflict.
      expect((await send(alice.token, 'bob@laptop', { text: 'x' }, key)).status).toBe(201);
    });
  });

  describe('address discovery', () => {
    it('reports each agent\'s address on agent resources', async () => {
      const { ws, bob } = await seed();
      const auth = { authorization: `Bearer ${ws.workspaceKey}` };

      const list = (await (await stack.app.request('/v1/agents', { headers: auth })).json()) as { data: Json[] };
      expect(Object.fromEntries(list.data.map((agent) => [agent.name, agent.address])))
        .toMatchObject({ alice: 'alice@direct', bob: 'bob@laptop' });

      const one = (await (await stack.app.request('/v1/agents/bob', { headers: auth })).json()) as { data: Json };
      expect(one.data.address).toBe('bob@laptop');

      const self = (await (await stack.app.request('/v1/agent', {
        headers: { authorization: `Bearer ${bob.token}` },
      })).json()) as { data: Json };
      expect(self.data.address).toBe('bob@laptop');
    });

    it('carries the sender address on the DM response, live delivery, and history, and it round-trips', async () => {
      const { alice, bob, laptop } = await seed();
      const res = await send(alice.token, 'bob@laptop', { text: 'reply to me' });
      const sent = (await res.json()) as { data: { conversation_id: string; message: Json } };
      expect(sent.data.message.agent_address).toBe('alice@direct');

      await stack.settle();
      const [delivered] = deliveredDms(laptop.sock);
      expect(delivered.agent_address).toBe('alice@direct');

      const history = (await (await stack.app.request(`/v1/dm/${sent.data.conversation_id}/messages`, {
        headers: { authorization: `Bearer ${bob.token}` },
      })).json()) as { data: Json[] };
      expect(history.data[0].agent_address).toBe('alice@direct');

      // The recipient can answer on the address it was handed.
      expect((await send(bob.token, delivered.agent_address as string, { text: 'got it' })).status).toBe(201);
    });

    it('keeps the server-owned address out of public metadata and ignores a caller-supplied one', async () => {
      const { alice } = await seed();
      const res = await send(alice.token, 'bob@laptop', {
        text: 'spoof',
        data: { [SENDER_ADDRESS_METADATA_KEY]: 'mallory@elsewhere', topic: 'x' },
      });
      const message = ((await res.json()) as { data: { message: Json } }).data.message;
      expect(message.agent_address).toBe('alice@direct');
      expect(message.metadata).toEqual({ topic: 'x', injection_mode: 'wait' });
    });
  });
});
