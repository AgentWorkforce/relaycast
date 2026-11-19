import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { agentDeviceTokens, messages } from '../../db/tables.js';
import { SENDER_DEVICE_METADATA_KEY } from '../../engine/address.js';
import { transformForClient } from '../../engine/wsTransform.js';
import { fetchQueuedWsBacklogEvents } from '../../engine/delivery.js';
import { attachAuthenticatedNodeSocket, authenticateNodeWs } from '../../engine/wsAuth.js';
import { handleNodeControlMessage } from '../../engine/node.js';
import { FakeSocket } from './harness.js';
import { createCredentialTagSigner } from '../../auth/credentialTags.js';
import { createWorkspace, registerAgent, makeNodeStack, type TestStack } from './harness.js';

type Json = Record<string, any>;

/**
 * Per-device person tokens (engine/agentDevice.ts) and the server-owned
 * sender device stamp: `__relaycast_sender_device` in storage, `agent_device`
 * on the wire, next to `agent_address`.
 */
describe('agent device tokens', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack({ ttlMs: 60_000 }); });
  afterEach(async () => { await stack.close(); });

  const laptop = { id: 'ada-laptop-3f2a91c0', name: "Ada's Laptop", kind: 'desktop' };
  const buildBox = { id: 'build-box-0c1d2e3f', name: 'build-box', kind: 'cli' };

  function request(method: string, path: string, token: string, body?: unknown) {
    return stack.app.request(path, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  const post = (path: string, token: string, body: unknown) => request('POST', path, token, body);
  async function data(response: Response): Promise<Json> {
    return ((await response.json()) as { data: Json }).data;
  }
  async function errorCode(response: Response): Promise<string | undefined> {
    return ((await response.json()) as { error?: { code?: string } }).error?.code;
  }

  async function seed() {
    const ws = await createWorkspace(stack.app, 'device-ws');
    const registered = await post('/v1/agents', ws.workspaceKey, { name: 'ada', type: 'human' });
    expect(registered.status).toBe(201);
    const ada = await data(registered) as { id: string; token: string };
    const bob = await registerAgent(stack.app, ws.workspaceKey, 'bob');
    return { ws, ada: { agentId: ada.id, token: ada.token }, bob };
  }

  async function mint(ws: { workspaceKey: string }, agentId: string, device: Json, extra: Json = {}) {
    return post('/v1/agents/ada/device-tokens', ws.workspaceKey, { agent_id: agentId, device, ...extra });
  }
  async function mintToken(ws: { workspaceKey: string }, agentId: string, device: Json, extra: Json = {}) {
    const response = await mint(ws, agentId, device, extra);
    expect(response.status).toBe(201);
    return (await data(response)).token as string;
  }

  async function dmFrom(token: string, to: string, body: Json = {}) {
    const response = await post('/v1/dm', token, { to, text: 'hello', ...body });
    expect(response.status).toBe(201);
    return data(response);
  }

  /** Every message `bob` was sent, as his own deliveries serve them. */
  async function deliveredToBob(bobToken: string): Promise<Json[]> {
    const response = await request('GET', '/v1/deliveries?limit=100', bobToken);
    expect(response.status).toBe(200);
    return ((await data(response)) as unknown as Json[]).map((delivery) => delivery.message);
  }

  async function storedMetadata(messageId: string) {
    const [row] = await stack.runtime.handle.db.select({ metadata: messages.metadata }).from(messages)
      .where(eq(messages.id, messageId));
    return row?.metadata as Json;
  }

  it('mints one token per device for the same person agent, shown once and stored only as a hash', async () => {
    const { ws, ada } = await seed();
    const minted = await mint(ws, ada.agentId, laptop, { ttl_seconds: 3600 });
    expect(minted.status).toBe(201);
    const body = await data(minted);
    expect(body).toMatchObject({ agent_id: ada.agentId, device: laptop });
    expect(body.token).toMatch(/^at_live_dv_[0-9a-f]{32}$/);
    expect(Date.parse(body.expires_at) - Date.now()).toBeGreaterThan(3500_000);
    const other = await mintToken(ws, ada.agentId, buildBox);
    expect(other).not.toBe(body.token);

    // Both authenticate as the same agent.
    for (const token of [body.token, other]) {
      const me = await request('GET', '/v1/agent', token);
      expect(me.status).toBe(200);
      expect((await data(me)).id).toBe(ada.agentId);
    }
    const rows = await stack.runtime.handle.db.select().from(agentDeviceTokens);
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toContain(body.token);
  });

  it('mints only with the workspace key, only for person agents, and only for the expected agent', async () => {
    const { ws, ada, bob } = await seed();
    const deviceToken = await mintToken(ws, ada.agentId, laptop);
    // Neither an agent's own token nor a device token can mint or revoke.
    for (const token of [ada.token, deviceToken]) {
      expect((await mint({ workspaceKey: token }, ada.agentId, buildBox)).status).toBe(401);
      expect((await request('DELETE', `/v1/agents/ada/device-tokens/${laptop.id}`, token)).status).toBe(401);
    }
    expect(await errorCode(await post('/v1/agents/bob/device-tokens', ws.workspaceKey, { agent_id: bob.agentId, device: laptop })))
      .toBe('not_a_person_agent');
    expect(await errorCode(await mint(ws, 'agent_someone_else', laptop))).toBe('agent_identity_conflict');
    expect(await errorCode(await post('/v1/agents/nobody/device-tokens', ws.workspaceKey, { agent_id: 'x', device: laptop })))
      .toBe('agent_not_found');
  });

  it('bounds what receivers will see: the id is address-safe, the name is cleaned, and kind is a closed set', async () => {
    const { ws, ada } = await seed();
    for (const device of [
      { ...laptop, id: 'ada@laptop' },
      { ...laptop, id: 'Ada-Laptop' },
      { ...laptop, id: 'unknown' },
      { ...laptop, id: 'direct' },
      { ...laptop, id: 'x'.repeat(65) },
      { ...laptop, kind: 'unknown' },
      { ...laptop, kind: 'phone' },
      { ...laptop, name: ' \u0007 ' },
    ]) {
      expect(await errorCode(await mint(ws, ada.agentId, device))).toBe('invalid_request');
    }
    expect(await errorCode(await mint(ws, ada.agentId, laptop, { ttl_seconds: 1 }))).toBe('invalid_request');
    const cleaned = await data(await mint(ws, ada.agentId, { ...laptop, name: `line\nbreak‮${'y'.repeat(200)}` }));
    expect(cleaned.device.name).toMatch(/^line break y+$/);
    expect(cleaned.device.name.length).toBeLessThanOrEqual(80);
  });

  it('stamps a DM with the device of the token that sent it, as agent_device next to agent_address', async () => {
    const { ws, ada, bob } = await seed();
    const laptopToken = await mintToken(ws, ada.agentId, laptop);
    const buildBoxToken = await mintToken(ws, ada.agentId, buildBox);
    const fromLaptop = await dmFrom(laptopToken, 'bob');
    const fromBuildBox = await dmFrom(buildBoxToken, 'bob');
    expect(fromLaptop.message).toMatchObject({ agent_id: ada.agentId, agent_address: `ada@${laptop.id}`, agent_device: laptop });
    expect(fromBuildBox.message).toMatchObject({ agent_address: `ada@${buildBox.id}`, agent_device: buildBox });

    const received = await deliveredToBob(bob.token);
    expect(received.map((message) => message.agent_device)).toEqual(expect.arrayContaining([laptop, buildBox]));
    expect((await storedMetadata(fromLaptop.message.id))[SENDER_DEVICE_METADATA_KEY]).toEqual(laptop);
    // No __relaycast_ key is ever served in metadata.
    expect(JSON.stringify(fromLaptop.message.metadata)).not.toContain('__relaycast_');
    for (const message of received) expect(JSON.stringify(message.metadata ?? {})).not.toContain('__relaycast_');

    const conversation = await request('GET', `/v1/dm/${fromLaptop.conversation_id}/messages`, bob.token);
    expect(conversation.status).toBe(200);
    const listed = await data(conversation) as unknown as Json[];
    expect(listed.find((message) => message.id === fromLaptop.message.id)?.agent_device ?? null).toEqual(laptop);
  });

  it('never lets a caller forge the stamp: a supplied __relaycast_sender_device or agent_device is dropped', async () => {
    const { ws, ada, bob } = await seed();
    const forged = { id: 'owners-desk', name: 'Owner desk', kind: 'desktop' };
    const laptopToken = await mintToken(ws, ada.agentId, laptop);
    const viaDevice = await dmFrom(laptopToken, 'bob', {
      data: { [SENDER_DEVICE_METADATA_KEY]: forged, __relaycast_sender_address: 'ada@owners-desk', agent_device: forged, note: 'kept' },
    });
    const viaShared = await dmFrom(ada.token, 'bob', { data: { [SENDER_DEVICE_METADATA_KEY]: forged } });
    // Top-level body fields are not part of the send schema either.
    const viaBody = await dmFrom(ada.token, 'bob', { agent_device: forged, agent_address: 'ada@owners-desk' });
    expect(viaBody.message.agent_device.kind).toBe('unknown');
    expect(viaBody.message.agent_address).toBe('ada@direct');
    expect(viaDevice.message.agent_device).toEqual(laptop);
    expect(viaDevice.message.agent_address).toBe(`ada@${laptop.id}`);
    expect(viaShared.message.agent_device).toEqual({ id: 'unknown', name: 'unknown', kind: 'unknown' });
    expect((await storedMetadata(viaDevice.message.id))[SENDER_DEVICE_METADATA_KEY]).toEqual(laptop);
    expect((await storedMetadata(viaShared.message.id))[SENDER_DEVICE_METADATA_KEY].kind).toBe('unknown');
    for (const message of await deliveredToBob(bob.token)) {
      expect(message.agent_device).not.toEqual(forged);
      expect(JSON.stringify(message)).not.toContain('owners-desk');
    }
    // Caller metadata that is not server-owned still arrives as sent (agent_device is just caller data there).
    expect(viaDevice.message.metadata).toMatchObject({ note: 'kept', agent_device: forged });
  });

  it('keeps the shared person token working, stamped as an unknown device at <person>@direct', async () => {
    const { ada, bob } = await seed();
    const sent = await dmFrom(ada.token, 'bob');
    expect(sent.message.agent_device).toEqual({ id: 'unknown', name: 'unknown', kind: 'unknown' });
    expect(sent.message.agent_address).toBe('ada@direct');
    // A non-person agent carries no device at all (absent, not null).
    const reply = await dmFrom(bob.token, 'ada');
    expect(reply.message).not.toHaveProperty('agent_device');
    expect(reply.message.agent_address).toBe('bob@direct');
  });

  it('stamps channel posts, group DMs and thread replies too', async () => {
    const { ws, ada, bob } = await seed();
    const laptopToken = await mintToken(ws, ada.agentId, laptop);
    expect((await post('/v1/channels', bob.token, { name: 'ops' })).status).toBe(201);
    expect((await post('/v1/channels/ops/join', laptopToken, {})).status).toBeLessThan(300);
    const posted = await post('/v1/channels/ops/messages', laptopToken, {
      text: 'from the laptop', data: { [SENDER_DEVICE_METADATA_KEY]: { id: 'forged', name: 'x', kind: 'web' } },
    });
    expect(posted.status).toBe(201);
    const channelMessage = await data(posted);
    expect(channelMessage.agent_device).toEqual(laptop);
    expect(channelMessage).not.toHaveProperty('agent_address');
    const history = await data(await request('GET', '/v1/channels/ops/messages', bob.token)) as unknown as Json[];
    expect(history.find((message) => message.id === channelMessage.id)?.agent_device).toEqual(laptop);

    const replied = await post(`/v1/messages/${channelMessage.id}/replies`, laptopToken, { text: 'thread' });
    expect(replied.status).toBe(201);
    expect(await data(replied)).toMatchObject({ agent_device: laptop, agent_address: `ada@${laptop.id}` });

    const group = await post('/v1/dm/group', laptopToken, { participants: ['bob'] });
    expect(group.status).toBe(201);
    const groupId = (await data(group)).id as string;
    const groupMessage = await post(`/v1/dm/${groupId}/messages`, laptopToken, { text: 'group' });
    expect(groupMessage.status).toBe(201);
    expect((await data(groupMessage)).message.agent_device).toEqual(laptop);

    const fromBob = await post('/v1/channels/ops/messages', bob.token, { text: 'agent post' });
    expect(await data(fromBob)).not.toHaveProperty('agent_device');
  });

  it('carries agent_device on realtime events and never invents one', () => {
    const base = { workspace_id: 'ws', timestamp: new Date().toISOString() };
    const dm = transformForClient({
      ...base, type: 'dm.received',
      data: { conversation_id: 'c', message: { id: 'm', agent_id: 'a', agent_name: 'ada', agent_address: 'ada@x', agent_device: laptop, text: 't' } },
    }) as Json;
    expect(dm.message.agent_device).toEqual(laptop);
    const channel = transformForClient({
      ...base, type: 'message.created',
      data: { id: 'm', agent_id: 'a', from_name: 'bob', channel_name: 'ops', text: 't', agent_device: { id: 1 } },
    }) as Json;
    expect(channel.message).not.toHaveProperty('agent_device');
  });

  it('revokes one device at once, leaving the others working', async () => {
    const { ws, ada } = await seed();
    const laptopToken = await mintToken(ws, ada.agentId, laptop);
    const buildBoxToken = await mintToken(ws, ada.agentId, buildBox);
    const revoked = await request('DELETE', `/v1/agents/ada/device-tokens/${buildBox.id}`, ws.workspaceKey);
    expect(revoked.status).toBe(200);
    expect(await data(revoked)).toEqual({ revoked: true });
    expect((await request('GET', '/v1/agent', buildBoxToken)).status).toBe(401);
    expect((await post('/v1/dm', buildBoxToken, { to: 'bob', text: 'x' })).status).toBe(401);
    expect((await request('GET', '/v1/agent', laptopToken)).status).toBe(200);
    expect((await request('GET', '/v1/agent', ada.token)).status).toBe(200);
    expect(await data(await request('DELETE', `/v1/agents/ada/device-tokens/${buildBox.id}`, ws.workspaceKey)))
      .toEqual({ revoked: false });
  });

  it('replaces a device token on re-mint, and refuses an expired one', async () => {
    const { ws, ada } = await seed();
    const first = await mintToken(ws, ada.agentId, laptop);
    const second = await mintToken(ws, ada.agentId, laptop, { ttl_seconds: 600 });
    expect((await request('GET', '/v1/agent', first)).status).toBe(401);
    expect((await request('GET', '/v1/agent', second)).status).toBe(200);
    await stack.runtime.handle.db.update(agentDeviceTokens).set({ expiresAt: new Date(Date.now() - 1000) });
    expect((await request('GET', '/v1/agent', second)).status).toBe(401);
  });

  it('drops every device token when the identity is taken over or revoked, but not on the shared token rotation', async () => {
    const { ws, ada } = await seed();
    const laptopToken = await mintToken(ws, ada.agentId, laptop);
    const rotated = await post('/v1/agents/ada/rotate-token', ada.token, {});
    expect(rotated.status).toBe(200);
    expect((await request('GET', '/v1/agent', laptopToken)).status).toBe(200);

    const takenOver = await post('/v1/agents/ada/takeover', ws.workspaceKey, {
      expected_agent_id: ada.agentId, actor: 'cloud-user:u1', reason: 'test', session_ref: 's1', node_id: 'cloud-dashboard',
    });
    expect(takenOver.status).toBe(200);
    expect((await request('GET', '/v1/agent', laptopToken)).status).toBe(401);

    const again = await mintToken(ws, ada.agentId, laptop);
    const revokedAll = await post('/v1/agents/ada/revoke-token', ws.workspaceKey, {
      expected_agent_id: ada.agentId, actor: 'admin', reason: 'compromise',
    });
    expect(revokedAll.status).toBe(200);
    expect((await request('GET', '/v1/agent', again)).status).toBe(401);
  });

  it('never lets a device token recover the shared token', async () => {
    const { ws, ada } = await seed();
    const laptopToken = await mintToken(ws, ada.agentId, laptop);
    const recovered = await post('/v1/agents/ada/recover', laptopToken, {
      expected_agent_id: ada.agentId, actor: 'agent:ada', reason: 'lost token', session_ref: 's1',
    });
    expect(recovered.status).toBe(403);
    expect(await errorCode(recovered)).toBe('device_token_forbidden');
    // Nothing changed: the shared token and the device token both still work.
    expect((await request('GET', '/v1/agent', ada.token)).status).toBe(200);
    expect((await request('GET', '/v1/agent', laptopToken)).status).toBe(200);
  });

  it('drops device tokens when the person is deleted (a tombstone keeps its row)', async () => {
    const { ws, ada } = await seed();
    const laptopToken = await mintToken(ws, ada.agentId, laptop);
    const deleted = await request('DELETE', '/v1/agents/ada', ws.workspaceKey);
    expect(deleted.status).toBeLessThan(300);
    expect((await request('GET', '/v1/agent', laptopToken)).status).toBe(401);
    expect((await post('/v1/dm', laptopToken, { to: 'bob', text: 'after delete' })).status).toBe(401);
    expect(await stack.runtime.handle.db.select().from(agentDeviceTokens)).toEqual([]);
  });

  it('keeps agent_device on replay of queued channel posts and group DMs, and in workspace DM history', async () => {
    const { ws, ada, bob } = await seed();
    const laptopToken = await mintToken(ws, ada.agentId, laptop);
    expect((await post('/v1/channels', bob.token, { name: 'ops' })).status).toBe(201);
    expect((await post('/v1/channels/ops/join', laptopToken, {})).status).toBeLessThan(300);
    expect((await post('/v1/channels/ops/messages', laptopToken, { text: 'queued channel post' })).status).toBe(201);
    const group = await data(await post('/v1/dm/group', laptopToken, { participants: ['bob'] }));
    expect((await post(`/v1/dm/${group.id}/messages`, laptopToken, { text: 'queued group dm' })).status).toBe(201);
    const direct = await dmFrom(laptopToken, 'bob');

    const replayed = await fetchQueuedWsBacklogEvents(stack.runtime.handle.db as never, ws.workspaceId, bob.agentId);
    const byType = (type: string) => replayed.filter((event) => event.eventType === type)
      .map((event) => event.eventData as Json);
    expect(byType('message.created').map((event) => event.agent_device)).toContainEqual(laptop);
    expect(byType('group_dm.received').map((event) => event.message.agent_device)).toContainEqual(laptop);
    expect(byType('dm.received').map((event) => event.message.agent_device)).toContainEqual(laptop);

    const history = await request('GET', `/v1/dm/conversations/${direct.conversation_id}/messages`, ws.workspaceKey);
    expect(history.status).toBe(200);
    const messagesOut = await data(history) as unknown as Json[];
    expect(messagesOut.find((message) => message.id === direct.message.id)?.agent_device).toEqual(laptop);
  });

  it('delivers an addressed DM to a person on a broker named "direct"', async () => {
    const { ws, ada, bob } = await seed();
    const enroll = await post('/v1/nodes', ws.workspaceKey, {
      node_id: 'node_brk', name: 'direct', machine_id: 'brk-machine', capabilities: [], max_agents: 4, version: 't',
    });
    expect(enroll.status).toBe(201);
    // Bind the person to that broker the way a host does.
    const { agents } = await import('../../db/tables.js');
    await stack.runtime.handle.db.update(agents)
      .set({ locationType: 'via_node', locationNodeId: 'node_brk' })
      .where(eq(agents.id, ada.agentId));
    for (const address of ['ada@brk-machine', 'ada@direct', 'ada@anything']) {
      expect((await post('/v1/dm', bob.token, { address, text: address })).status, address).toBe(201);
    }
  });

  it('never lets a device token manage credentials', async () => {
    const { ws, ada } = await seed();
    const laptopToken = await mintToken(ws, ada.agentId, laptop);
    expect(await errorCode(await post('/v1/agents/ada/rotate-token', laptopToken, {}))).toBe('device_token_forbidden');
    expect(await errorCode(await post('/v1/agent/recovery-credential', laptopToken, {
      recovery_proof_hash: 'a'.repeat(64), work_unit_id: 'wu',
    }))).toBe('device_token_forbidden');
    expect(await errorCode(await post('/v1/credentials/upgrade', laptopToken, {}))).toBe('device_token_forbidden');
    // The shared token is untouched by those attempts.
    expect((await request('GET', '/v1/agent', ada.token)).status).toBe(200);
  });

  describe('node tokens minted with a device token', () => {
    async function mintNodeToken(token: string) {
      const response = await post('/v1/agent/node-token', token, {});
      expect(response.status).toBe(200);
      return data(response) as Promise<{ node_id: string; token: string }>;
    }
    /** A node-token principal posting to a channel as `from`. */
    async function postAs(nodeToken: string, from = 'ada') {
      return post('/v1/channels/ops/messages', nodeToken, { text: 'via node', from });
    }
    async function seedWithChannel() {
      const seeded = await seed();
      expect((await post('/v1/channels', seeded.bob.token, { name: 'ops' })).status).toBe(201);
      expect((await post('/v1/channels/ops/join', seeded.ada.token, {})).status).toBeLessThan(300);
      return seeded;
    }
    const wsDeps = () => ({ auth: stack.runtime.deps.auth, db: stack.runtime.handle.db }) as never;

    it('stamps a bound node post with its device, and an unbound one as unknown', async () => {
      const { ws, ada } = await seedWithChannel();
      const laptopToken = await mintToken(ws, ada.agentId, laptop);
      const bound = await mintNodeToken(laptopToken);
      const viaBound = await postAs(bound.token);
      expect(viaBound.status).toBe(201);
      expect((await data(viaBound)).agent_device).toEqual(laptop);
      const unbound = await mintNodeToken(ada.token); // rotates the person's one direct node token
      const viaUnbound = await postAs(unbound.token);
      expect(viaUnbound.status).toBe(201);
      expect((await data(viaUnbound)).agent_device.kind).toBe('unknown');
      expect((await postAs(bound.token)).status).toBe(401); // rotated out, as before
    });

    for (const [path, end] of [
      ['device revoke', async (ctx: Json) => request('DELETE', `/v1/agents/ada/device-tokens/${laptop.id}`, ctx.ws.workspaceKey)],
      ['device re-mint', async (ctx: Json) => mint(ctx.ws, ctx.ada.agentId, laptop)],
      ['device expiry', async () => stack.runtime.handle.db.update(agentDeviceTokens).set({ expiresAt: new Date(Date.now() - 1000) })],
      ['takeover', async (ctx: Json) => post('/v1/agents/ada/takeover', ctx.ws.workspaceKey, {
        expected_agent_id: ctx.ada.agentId, actor: 'cloud-user:u1', reason: 'test', session_ref: 's1', node_id: 'cloud-dashboard',
      })],
      ['revoke-token', async (ctx: Json) => post('/v1/agents/ada/revoke-token', ctx.ws.workspaceKey, {
        expected_agent_id: ctx.ada.agentId, actor: 'admin', reason: 'compromise',
      })],
      ['agent delete', async (ctx: Json) => request('DELETE', '/v1/agents/ada', ctx.ws.workspaceKey)],
    ] as const) {
      it(`ends with its device: ${path}`, async () => {
        const ctx = await seedWithChannel();
        const laptopToken = await mintToken(ctx.ws, ctx.ada.agentId, laptop);
        const bound = await mintNodeToken(laptopToken);
        expect((await postAs(bound.token)).status).toBe(201);
        expect(await authenticateNodeWs(wsDeps(), bound.token)).toMatchObject({ ok: true });
        await end(ctx as Json);
        expect((await postAs(bound.token)).status).toBe(401);
        expect(await authenticateNodeWs(wsDeps(), bound.token)).toMatchObject({ ok: false });
      });
    }

    it('keeps an unbound (shared-token) node token working when a device is revoked', async () => {
      const { ws, ada } = await seedWithChannel();
      await mintToken(ws, ada.agentId, laptop);
      const unbound = await mintNodeToken(ada.token);
      await request('DELETE', `/v1/agents/ada/device-tokens/${laptop.id}`, ws.workspaceKey);
      expect((await postAs(unbound.token)).status).toBe(201);
    });

    /** Attach a node socket the way the transport does: it remembers the binding of the token that opened it. */
    async function openSocket(nodeId: string, openedWith: string, ada: { agentId: string }, wsId: string, register = true) {
      const auth = await authenticateNodeWs(wsDeps(), openedWith);
      if (!auth.ok) throw new Error('node token did not authenticate');
      expect(auth.node.id).toBe(nodeId);
      expect(auth.node.workspaceId).toBe(wsId);
      const sock = new FakeSocket();
      // The same attach the Node entrypoint performs after authenticateNodeWs.
      const handle = attachAuthenticatedNodeSocket(stack.runtime.realtime, auth, sock);
      if (register) await handle.handleMessage(JSON.stringify({
        v: 1, id: 'reg', type: 'node.register', node_id: nodeId, name: `direct-${ada.agentId}`,
        capabilities: [], max_agents: 1, tags: [], version: 't', resume_cursor: null,
      }));
      return { sock, handle };
    }
    const heartbeat = (handle: { handleMessage(raw: string): Promise<void> }) => handle.handleMessage(JSON.stringify({
      v: 1, id: 'hb', type: 'node.heartbeat', load: 0, active_agents: 0, handlers_live: false,
    }));
    const recoverOn = async (socket: { sock: FakeSocket; handle: { handleMessage(raw: string): Promise<void> } }, agentId: string) => {
      await socket.handle.handleMessage(JSON.stringify({
        v: 1, id: 'rec', type: 'agent.recover', name: 'ada', expected_agent_id: agentId, session_ref: 's1',
      }));
      return JSON.stringify([...socket.sock.ofType('reply'), ...socket.sock.ofType('error')].filter((frame) => frame.id === 'rec'));
    };

    it('closes a connected bound node socket when its device is revoked, and at its next heartbeat when it expires', async () => {
      const { ws, ada } = await seedWithChannel();
      const laptopToken = await mintToken(ws, ada.agentId, laptop);
      const bound = await mintNodeToken(laptopToken);
      const first = await openSocket(bound.node_id, bound.token, ada, ws.workspaceId);
      expect(first.sock.closed).toBe(false);
      await request('DELETE', `/v1/agents/ada/device-tokens/${laptop.id}`, ws.workspaceKey);
      expect(first.sock.closed).toBe(true);

      const again = await mintToken(ws, ada.agentId, laptop);
      const rebound = await mintNodeToken(again);
      const second = await openSocket(rebound.node_id, rebound.token, ada, ws.workspaceId);
      await stack.runtime.handle.db.update(agentDeviceTokens).set({ expiresAt: new Date(Date.now() - 1000) });
      await heartbeat(second.handle);
      expect(second.sock.closed).toBe(true);
    });

    it('judges a socket by the token that opened it, after the shared token re-mints the node token (B1)', async () => {
      const { ws, ada } = await seedWithChannel();
      const laptopToken = await mintToken(ws, ada.agentId, laptop);
      const bound = await mintNodeToken(laptopToken);
      const deviceSocket = await openSocket(bound.node_id, bound.token, ada, ws.workspaceId);
      // The shared-token holder mints the person's node token: the row is unbound now.
      await mintNodeToken(ada.token);
      // The device socket still may not recover the shared token...
      expect(await recoverOn(deviceSocket, ada.agentId)).toContain('device_token_forbidden');
      // ...and revoking its device closes it, row binding notwithstanding.
      await request('DELETE', `/v1/agents/ada/device-tokens/${laptop.id}`, ws.workspaceKey);
      expect(deviceSocket.sock.closed).toBe(true);
      await heartbeat(deviceSocket.handle).catch(() => undefined);
      expect((await request('GET', '/v1/agent', ada.token)).status).toBe(200);
    });

    it("closes only the revoked device's socket when another device minted the node token since (M1)", async () => {
      const { ws, ada } = await seedWithChannel();
      const aToken = await mintToken(ws, ada.agentId, laptop);
      const aNode = await mintNodeToken(aToken);
      const aSocket = await openSocket(aNode.node_id, aNode.token, ada, ws.workspaceId);
      const bToken = await mintToken(ws, ada.agentId, buildBox);
      const bNode = await mintNodeToken(bToken); // row now bound to B
      // B attaches without registering, so A is not superseded: only revocation decides.
      const bSocket = await openSocket(bNode.node_id, bNode.token, ada, ws.workspaceId, false);
      expect(aSocket.sock.closed).toBe(false);
      await request('DELETE', `/v1/agents/ada/device-tokens/${laptop.id}`, ws.workspaceKey);
      expect(aSocket.sock.closed).toBe(true);
      expect(bSocket.sock.closed).toBe(false);
    });

    it('never lets a bound socket register an agent whose token would outlive the device', async () => {
      const { ws, ada } = await seedWithChannel();
      const laptopToken = await mintToken(ws, ada.agentId, laptop);
      const bound = await mintNodeToken(laptopToken);
      const socket = await openSocket(bound.node_id, bound.token, ada, ws.workspaceId);
      await socket.handle.handleMessage(JSON.stringify({
        v: 1, id: 'newagent', type: 'agent.register', name: 'sidekick', resumable: true, session_ref: 's-x',
      }));
      const reply = JSON.stringify([...socket.sock.ofType('reply'), ...socket.sock.ofType('error')].filter((frame) => frame.id === 'newagent'));
      expect(reply).toContain('device_token_forbidden');
    });

    it("falls back to the node row's binding on a host that does not track sockets (B1a)", async () => {
      const { ws, ada } = await seedWithChannel();
      const laptopToken = await mintToken(ws, ada.agentId, laptop);
      const bound = await mintNodeToken(laptopToken);
      const replies: string[] = [];
      let closed = false;
      // An untracked host passes no connectionDeviceTokenHash (undefined, not null).
      const frame = (message: Json) => handleNodeControlMessage({
        db: stack.runtime.handle.db as never,
        registry: stack.runtime.realtime as never,
        workspaceId: ws.workspaceId,
        nodeId: bound.node_id,
        socket: { send: (data: string) => { replies.push(data); }, close: () => { closed = true; } } as never,
        raw: JSON.stringify(message),
      });
      await frame({
        v: 1, id: 'reg', type: 'node.register', node_id: bound.node_id, name: `direct-${ada.agentId}`,
        capabilities: [], max_agents: 1, tags: [], version: 't', resume_cursor: null,
      });
      await frame({ v: 1, id: 'agent', type: 'agent.register', name: 'sidekick', resumable: true, session_ref: 's-y' });
      expect(replies.join('\n')).toContain('device_token_forbidden');
      await frame({ v: 1, id: 'rec', type: 'agent.recover', name: 'ada', expected_agent_id: ada.agentId, session_ref: 's1' });
      expect(replies.filter((reply) => reply.includes('"rec"')).join('')).toContain('device_token_forbidden');
      // The device expires: the row's binding is dead, so the heartbeat is refused and the socket closed.
      await stack.runtime.handle.db.update(agentDeviceTokens).set({ expiresAt: new Date(Date.now() - 1000) });
      await frame({ v: 1, id: 'hb', type: 'node.heartbeat', load: 0, active_agents: 0, handlers_live: false });
      expect(closed).toBe(true);
      expect(replies.filter((reply) => reply.includes('"hb"')).join('')).toContain('node_token_invalid');
    });

    it('closes the direct node\'s sockets when the person is deleted', async () => {
      const { ws, ada } = await seedWithChannel();
      const laptopToken = await mintToken(ws, ada.agentId, laptop);
      const bound = await mintNodeToken(laptopToken);
      const socket = await openSocket(bound.node_id, bound.token, ada, ws.workspaceId);
      expect((await request('DELETE', '/v1/agents/ada', ws.workspaceKey)).status).toBeLessThan(300);
      expect(socket.sock.closed).toBe(true);
    });

    describe('on a host that closes sockets only by the hashes a revocation names', () => {
      // The hosted registry: disconnectNodeDeviceSockets, but no in-memory list of open bindings.
      function hashListHost() {
        const registry = stack.runtime.realtime as unknown as Record<string, unknown>;
        const original = registry.nodeConnectionDeviceTokenHashes;
        const calls: string[][] = [];
        const realClose = (registry.disconnectNodeDeviceSockets as (...args: unknown[]) => Promise<void>).bind(registry);
        let failures = 0;
        registry.nodeConnectionDeviceTokenHashes = undefined;
        registry.disconnectNodeDeviceSockets = async (workspaceId: string, nodeId: string, hashes: string[]) => {
          calls.push([...hashes].sort());
          if (failures > 0) { failures -= 1; throw new Error('do unreachable'); }
          return realClose(workspaceId, nodeId, hashes);
        };
        return {
          calls,
          failNext: (count: number) => { failures = count; },
          restore: () => {
            registry.nodeConnectionDeviceTokenHashes = original;
            registry.disconnectNodeDeviceSockets = realClose;
          },
        };
      }
      const sha = async (token: string) => (await import('../../lib/crypto.js')).sha256Hex(token);

      it('names the revoked, replaced or dropped device tokens on every revocation path', async () => {
        const { ws, ada } = await seedWithChannel();
        const host = hashListHost();
        try {
          const laptopToken = await mintToken(ws, ada.agentId, laptop);
          const replaced = await mintToken(ws, ada.agentId, laptop); // re-mint names the old token
          expect(host.calls.at(-1)).toEqual([await sha(laptopToken)]);
          await request('DELETE', `/v1/agents/ada/device-tokens/${laptop.id}`, ws.workspaceKey);
          expect(host.calls.at(-1)).toEqual([await sha(replaced)]);
          const a = await mintToken(ws, ada.agentId, laptop);
          const b = await mintToken(ws, ada.agentId, buildBox);
          await post('/v1/agents/ada/takeover', ws.workspaceKey, {
            expected_agent_id: ada.agentId, actor: 'cloud-user:u1', reason: 'test', session_ref: 's1', node_id: 'cloud-dashboard',
          });
          expect(host.calls.at(-1)).toEqual([await sha(a), await sha(b)].sort());
        } finally {
          host.restore();
        }
      });

      it('retries a failed close, so the revoked device\'s socket still goes', async () => {
        const { ws, ada } = await seedWithChannel();
        const laptopToken = await mintToken(ws, ada.agentId, laptop);
        const bound = await mintNodeToken(laptopToken);
        const socket = await openSocket(bound.node_id, bound.token, ada, ws.workspaceId);
        const host = hashListHost();
        try {
          host.failNext(1);
          await request('DELETE', `/v1/agents/ada/device-tokens/${laptop.id}`, ws.workspaceKey);
          expect(host.calls).toHaveLength(2);
          expect(socket.sock.closed).toBe(true);
        } finally {
          host.restore();
        }
      });
    });

    it('refuses node.register on a socket whose device token is gone', async () => {
      const { ws, ada } = await seedWithChannel();
      const laptopToken = await mintToken(ws, ada.agentId, laptop);
      const bound = await mintNodeToken(laptopToken);
      const socket = await openSocket(bound.node_id, bound.token, ada, ws.workspaceId, false);
      await stack.runtime.handle.db.update(agentDeviceTokens).set({ expiresAt: new Date(Date.now() - 1000) });
      await socket.handle.handleMessage(JSON.stringify({
        v: 1, id: 'reg', type: 'node.register', node_id: bound.node_id, name: `direct-${ada.agentId}`,
        capabilities: [], max_agents: 1, tags: [], version: 't', resume_cursor: null,
      }));
      expect(socket.sock.closed).toBe(true);
    });

    it('checks the row on checkpoint heartbeats of untracked sockets', async () => {
      const { ws, ada } = await seedWithChannel();
      const laptopToken = await mintToken(ws, ada.agentId, laptop);
      const bound = await mintNodeToken(laptopToken);
      let closed = false;
      const replies: string[] = [];
      const frame = (message: Json, extra: Json = {}) => handleNodeControlMessage({
        db: stack.runtime.handle.db as never,
        registry: stack.runtime.realtime as never,
        workspaceId: ws.workspaceId,
        nodeId: bound.node_id,
        socket: { send: (data: string) => { replies.push(data); }, close: () => { closed = true; } } as never,
        raw: JSON.stringify(message),
        ...extra,
      } as never);
      await frame({
        v: 1, id: 'reg', type: 'node.register', node_id: bound.node_id, name: `direct-${ada.agentId}`,
        capabilities: [], max_agents: 1, tags: [], version: 't', resume_cursor: null,
      });
      await stack.runtime.handle.db.update(agentDeviceTokens).set({ expiresAt: new Date(Date.now() - 1000) });
      await frame({ v: 1, id: 'hb', type: 'node.heartbeat', load: 0, active_agents: 0, handlers_live: false },
        { heartbeatCheckpoint: { role: 'direct' } });
      expect(closed).toBe(true);
      expect(replies.filter((reply) => reply.includes('"hb"')).join('')).toContain('node_token_invalid');
    });

    it('lets a direct node post only as its own agent (M2)', async () => {
      const { ws, ada, bob } = await seedWithChannel();
      expect((await post('/v1/channels/ops/join', bob.token, {})).status).toBeLessThan(300);
      const laptopToken = await mintToken(ws, ada.agentId, laptop);
      const bound = await mintNodeToken(laptopToken);
      const asBob = await postAs(bound.token, 'bob');
      expect(asBob.status).toBe(403);
      expect(await errorCode(asBob)).toBe('from_not_allowed');
      const unbound = await mintNodeToken(ada.token);
      expect((await postAs(unbound.token, 'bob')).status).toBe(403);
      expect((await postAs(unbound.token, 'ada')).status).toBe(201);
    });

    it('refuses an upgraded legacy node token on the WebSocket once its device is gone', async () => {
      // A deployment that issues legacy credentials but can upgrade them to ar_.
      await stack.close();
      stack = makeNodeStack({ ttlMs: 60_000, credentialTagger: createCredentialTagSigner({ current: 'a', keys: { a: 'device-test-tag-secret' } }) });
      const { ws, ada } = await seedWithChannel();
      const laptopToken = await mintToken(ws, ada.agentId, laptop);
      const bound = await mintNodeToken(laptopToken);
      expect(bound.token).toMatch(/^nt_live_/);
      const upgraded = await post('/v1/credentials/upgrade', bound.token, {});
      expect(upgraded.status, await upgraded.clone().text()).toBe(200);
      expect(await authenticateNodeWs(wsDeps(), bound.token)).toMatchObject({ ok: true }); // grace
      await request('DELETE', `/v1/agents/ada/device-tokens/${laptop.id}`, ws.workspaceKey);
      expect(await authenticateNodeWs(wsDeps(), bound.token)).toMatchObject({ ok: false });
    });

    it('refuses A2A registration with a device token', async () => {
      const { ws, ada } = await seed();
      const laptopToken = await mintToken(ws, ada.agentId, laptop);
      const registered = await post('/v1/a2a/register', laptopToken, { agent_card: { name: 'x', url: 'https://example.test/a2a' } });
      expect(registered.status).toBe(403);
      expect(await errorCode(registered)).toBe('device_token_forbidden');
    });

    it('never lets a bound node token recover the shared token or rotate itself after its device is gone', async () => {
      const { ws, ada } = await seedWithChannel();
      const laptopToken = await mintToken(ws, ada.agentId, laptop);
      const bound = await mintNodeToken(laptopToken);
      const recovered = await post('/v1/agents/ada/recover', bound.token, {
        expected_agent_id: ada.agentId, actor: 'node', reason: 'lost', session_ref: 's1',
      });
      expect(recovered.status).toBe(403);
      expect(await errorCode(recovered)).toBe('device_token_forbidden');
      // Over the node socket too.
      const sock = new FakeSocket();
      const handle = stack.runtime.realtime.attachNodeSocket(ws.workspaceId, bound.node_id, sock);
      await handle.handleMessage(JSON.stringify({
        v: 1, id: 'reg', type: 'node.register', node_id: bound.node_id, name: `direct-${ada.agentId}`,
        capabilities: [], max_agents: 1, tags: [], version: 't', resume_cursor: null,
      }));
      await handle.handleMessage(JSON.stringify({
        v: 1, id: 'rec', type: 'agent.recover', name: 'ada', expected_agent_id: ada.agentId, session_ref: 's1',
      }));
      const reply = sock.ofType('reply').find((frame) => frame.id === 'rec') ?? sock.ofType('error').find((frame) => frame.id === 'rec');
      expect(JSON.stringify(reply)).toContain('device_token_forbidden');
      expect((await request('GET', '/v1/agent', ada.token)).status).toBe(200);

      // A direct node's token is never rotated by proof: its id is reserved for
      // the agent's own mint, so a dead bound token cannot re-key itself either.
      await request('DELETE', `/v1/agents/ada/device-tokens/${laptop.id}`, ws.workspaceKey);
      const { createNodeToken } = await import('../../engine/node.js');
      const { sha256Hex } = await import('../../lib/crypto.js');
      await expect(createNodeToken(stack.runtime.handle.db as never, ws.workspaceId, {
        node_id: bound.node_id, name: `direct-${ada.agentId}`, kind: 'ws', role: 'direct', capabilities: [], max_agents: 1,
      }, { expectedTokenHash: await sha256Hex(bound.token) })).rejects.toMatchObject({ code: 'reserved_node_id' });
    });
  });

  it('answers an unknown route, or an unmatched method, with the exact 404 Cloud falls back on', async () => {
    const { ws } = await seed();
    // Cloud hands out the shared person token only for this envelope (an
    // engine that predates /device-tokens); everything else is an error there.
    for (const [method, path] of [
      ['POST', '/v1/agents/ada/no-such-route'],
      ['PUT', '/v1/agents/ada/device-tokens'],
    ] as const) {
      const response = await request(method, path, ws.workspaceKey, {});
      expect(response.status, `${method} ${path}`).toBe(404);
      expect(await response.json()).toEqual({ ok: false, error: { code: 'not_found', message: 'Route not found' } });
    }
  });

  it('routes any address form for a person to the person: device ids, web, direct, revoked ids and old machine ids', async () => {
    const { ws, ada, bob } = await seed();
    await mintToken(ws, ada.agentId, laptop);
    await mintToken(ws, ada.agentId, buildBox);
    await request('DELETE', `/v1/agents/ada/device-tokens/${buildBox.id}`, ws.workspaceKey);
    for (const address of [`ada@${laptop.id}`, 'ada@web', 'ada@direct', `ada@${buildBox.id}`, 'ada@khaliqs-old-macbook-a1b2c3']) {
      const sent = await post('/v1/dm', bob.token, { address, text: `to ${address}` });
      expect(sent.status, address).toBe(201);
      expect((await data(sent)).message.agent_address).toBe('bob@direct');
    }
    // A non-person's machine part still filters.
    expect(await errorCode(await post('/v1/dm', ada.token, { address: 'bob@somewhere-else', text: 'x' }))).toBe('address_not_found');
  });
});
