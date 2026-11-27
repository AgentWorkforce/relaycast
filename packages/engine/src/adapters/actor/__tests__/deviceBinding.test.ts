import { describe, expect, it, vi } from 'vitest';
import { InProcessRealtime } from '../../node/realtime.js';
import { createHash } from 'node:crypto';
import { SocketGrantSchema, UNAUTHORIZED_CLOSE_CODE, isSocketGrant, type SocketPrincipal } from '../index.js';
import type { ActorHttpRequest } from '../http.js';
import { FAKE_FILE_SECRET, FakeWorkspaceActor, jsonRequest } from './fakeActor.js';
import { verifySocketPrincipal } from '../socket-grant.js';

/**
 * The actor runtime keeps the device-token binding of the node token that
 * opened each socket (engine/agentDevice.ts): in the signed socket grant and
 * in `_actor_sockets.device_token_hash`, so it survives the actor sleeping.
 */
const WORKSPACE_ID = '241764880589606912';
const laptop = { id: 'ada-laptop-3f2a91c0', name: "Ada's Laptop", kind: 'desktop' };
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

interface Envelope<T> { ok: boolean; data: T; error?: { code: string } }

async function call<T>(actor: FakeWorkspaceActor, method: string, path: string, body?: unknown, token?: string) {
  const response = await actor.handle(jsonRequest(method, path, body, token));
  return { status: response.status, json: (response.body ? JSON.parse(response.body) : null) as Envelope<T> };
}

function upgradeRequest(token: string): ActorHttpRequest {
  return {
    method: 'GET',
    url: `https://armadillo.test/v1/node/ws?token=${encodeURIComponent(token)}`,
    headers: [['upgrade', 'websocket'], ['connection', 'Upgrade']],
    body: null,
  };
}

async function person(actor: FakeWorkspaceActor) {
  const created = await call<{ api_key: string }>(actor, 'POST', '/v1/workspaces', { name: 'armadillo' });
  expect(created.status).toBe(201);
  const key = created.json.data.api_key;
  const ada = await call<{ id: string; token: string }>(actor, 'POST', '/v1/agents', { name: 'ada', type: 'human' }, key);
  expect(ada.status).toBe(201);
  const device = await call<{ token: string }>(actor, 'POST', '/v1/agents/ada/device-tokens', { agent_id: ada.json.data.id, device: laptop }, key);
  expect(device.status).toBe(201);
  return { key, agentId: ada.json.data.id, shared: ada.json.data.token, device: device.json.data.token };
}

/** A node token minted with `agentToken`, and the grant `GET /v1/node/ws` answers for it. */
async function grantFor(actor: FakeWorkspaceActor, agentToken: string) {
  const minted = await call<{ node_id: string; node_name: string; token: string }>(actor, 'POST', '/v1/agent/node-token', {}, agentToken);
  expect(minted.status).toBe(200);
  const response = await actor.handle(upgradeRequest(minted.json.data.token));
  expect(isSocketGrant(response)).toBe(true);
  return { ...minted.json.data, principal: SocketGrantSchema.parse(JSON.parse(response.body)).data.metadata };
}

const register = (node: { node_id: string; node_name: string }) => ({
  v: 1, id: 'r1', type: 'node.register', node_id: node.node_id, name: node.node_name,
  capabilities: [], max_agents: 1, tags: ['implicit', 'direct'], version: 'actor-test/1',
});

describe('actor runtime device binding', () => {
  it('puts the opening token\'s binding in the signed grant, and leaves it out for an unbound token', async () => {
    const actor = new FakeWorkspaceActor(WORKSPACE_ID);
    const ada = await person(actor);
    const bound = await grantFor(actor, ada.device);
    expect(bound.principal).toMatchObject({ kind: 'node', device_token_hash: sha256(ada.device) });
    const unbound = await grantFor(actor, ada.shared);
    expect(unbound.principal).not.toHaveProperty('device_token_hash');
  });

  it('signs the binding: a grant whose binding is changed or dropped does not verify', async () => {
    const actor = new FakeWorkspaceActor(WORKSPACE_ID);
    const ada = await person(actor);
    const { principal } = await grantFor(actor, ada.device);
    expect(await verifySocketPrincipal(FAKE_FILE_SECRET, principal)).toBe('ok');
    const { device_token_hash: _dropped, ...withoutBinding } = principal as SocketPrincipal & { device_token_hash?: string };
    expect(await verifySocketPrincipal(FAKE_FILE_SECRET, withoutBinding as SocketPrincipal)).toBe('bad_signature');
    expect(await verifySocketPrincipal(FAKE_FILE_SECRET, { ...principal, device_token_hash: 'f'.repeat(64) } as SocketPrincipal))
      .toBe('bad_signature');
    // Presented as-is, a stripped grant is refused at connect.
    const socket = await actor.connect(withoutBinding, { asIs: true });
    expect(socket.rejected?.code).toBe(UNAUTHORIZED_CLOSE_CODE);
  });

  it('records the binding on the socket row, and closes that socket when its device is revoked', async () => {
    const actor = new FakeWorkspaceActor(WORKSPACE_ID);
    const ada = await person(actor);
    const node = await grantFor(actor, ada.device);
    const socket = await actor.connect(node.principal);
    await actor.message(socket, register(node));
    expect(actor.sql.raw.prepare('SELECT device_token_hash FROM _actor_sockets WHERE socket_id = ?').all(socket.id))
      .toEqual([{ device_token_hash: sha256(ada.device) }]);
    expect(socket.closed).toBeNull();
    expect((await call(actor, 'DELETE', `/v1/agents/ada/device-tokens/${laptop.id}`, undefined, ada.key)).status).toBe(200);
    expect(socket.closed).not.toBeNull();
  });

  it('refuses a grant issued before its device was revoked', async () => {
    const actor = new FakeWorkspaceActor(WORKSPACE_ID);
    const ada = await person(actor);
    const node = await grantFor(actor, ada.device);
    expect((await call(actor, 'DELETE', `/v1/agents/ada/device-tokens/${laptop.id}`, undefined, ada.key)).status).toBe(200);
    const socket = await actor.connect(node.principal);
    expect(socket.rejected).toEqual({ code: UNAUTHORIZED_CLOSE_CODE, reason: 'device token revoked' });
  });

  it('does not replay a bound socket whose device is gone after the actor slept, and takes the node offline', async () => {
    const actor = new FakeWorkspaceActor(WORKSPACE_ID);
    const ada = await person(actor);
    const node = await grantFor(actor, ada.device);
    const socket = await actor.connect(node.principal);
    await actor.message(socket, register(node));
    // The device expires while the actor sleeps: no event, so nothing closed it yet.
    actor.sql.raw.prepare('UPDATE agent_device_tokens SET expires_at = ?').run(Math.floor(Date.now() / 1000) - 10);
    const woken = actor.restart();
    expect((await call(woken, 'GET', '/v1/agents', undefined, ada.key)).status).toBe(200);
    expect(socket.closed?.code).toBe(UNAUTHORIZED_CLOSE_CODE);
    expect(woken.sql.raw.prepare('SELECT COUNT(*) AS n FROM _actor_sockets WHERE socket_id = ?').get(socket.id)).toEqual({ n: 0 });
    expect(woken.sql.raw.prepare('SELECT status FROM nodes WHERE id = ?').get(node.node_id)).toEqual({ status: 'offline' });
  });

  it('never takes a node offline under a healthy socket when a dead-device socket is torn down after sleep', async () => {
    const actor = new FakeWorkspaceActor(WORKSPACE_ID);
    const ada = await person(actor);
    // A: opened with the device's node token, never registered, so it holds no provider.
    const bound = await grantFor(actor, ada.device);
    const dead = await actor.connect(bound.principal);
    // B: opened with the shared token's node token; it holds the provider, so the node is online through it.
    const unbound = await grantFor(actor, ada.shared);
    const healthy = await actor.connect(unbound.principal);
    await actor.message(healthy, register(unbound));
    expect(actor.sql.raw.prepare('SELECT status FROM nodes WHERE id = ?').get(unbound.node_id)).toEqual({ status: 'online' });
    // A's device expires while the actor sleeps; A's row is replayed first (older).
    actor.sql.raw.prepare('UPDATE agent_device_tokens SET expires_at = ?').run(Math.floor(Date.now() / 1000) - 10);
    const woken = actor.restart();
    expect((await call(woken, 'GET', '/v1/agents', undefined, ada.key)).status).toBe(200);
    expect(dead.closed?.code).toBe(UNAUTHORIZED_CLOSE_CODE);
    expect(healthy.closed).toBeNull();
    expect(woken.sql.raw.prepare('SELECT status FROM nodes WHERE id = ?').get(unbound.node_id)).toEqual({ status: 'online' });
  });

  it('keeps tearing down the rest of the batch when one dead-device teardown throws', async () => {
    const actor = new FakeWorkspaceActor(WORKSPACE_ID);
    const ada = await person(actor);
    const other = await call<{ token: string }>(actor, 'POST', '/v1/agents/ada/device-tokens', {
      agent_id: ada.agentId, device: { id: 'ada-desk-0c1d2e3f', name: 'desk', kind: 'cli' },
    }, ada.key);
    const first = await grantFor(actor, ada.device);
    const a = await actor.connect(first.principal);
    const second = await grantFor(actor, other.json.data.token);
    const b = await actor.connect(second.principal);
    await actor.message(b, register(second));
    actor.sql.raw.prepare('UPDATE agent_device_tokens SET expires_at = ?').run(Math.floor(Date.now() / 1000) - 10);
    const original = InProcessRealtime.prototype.attachNodeSocket;
    let thrown = 0;
    const tornDown: string[] = [];
    const spy = vi.spyOn(InProcessRealtime.prototype, 'attachNodeSocket').mockImplementation(function (this: InProcessRealtime, ...args) {
      const handle = original.apply(this, args);
      const options = args[3] as { connectionId?: string; earlyDrain?: boolean; deviceTokenHash?: string | null } | undefined;
      if (options?.earlyDrain !== false || !options.deviceTokenHash) return handle;
      if (thrown === 0) {
        thrown += 1;
        return { ...handle, handleClose: async () => { throw new Error('teardown failed'); } };
      }
      return { ...handle, handleClose: async () => { tornDown.push(options.connectionId ?? ''); await handle.handleClose(); } };
    });
    try {
      const woken = actor.restart();
      expect((await call(woken, 'GET', '/v1/agents', undefined, ada.key)).status).toBe(200);
      expect(thrown).toBe(1);
      expect(a.closed).not.toBeNull();
      expect(b.closed).not.toBeNull();
      // The first teardown threw; the second still ran.
      expect(tornDown).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('replays a bound socket whose device is still live, keeping its binding', async () => {
    const actor = new FakeWorkspaceActor(WORKSPACE_ID);
    const ada = await person(actor);
    const node = await grantFor(actor, ada.device);
    const socket = await actor.connect(node.principal);
    await actor.message(socket, register(node));
    const woken = actor.restart();
    expect((await call(woken, 'GET', '/v1/agents', undefined, ada.key)).status).toBe(200);
    expect(socket.closed).toBeNull();
    // The binding survived the sleep: revoking the device still closes exactly this socket.
    expect((await call(woken, 'DELETE', `/v1/agents/ada/device-tokens/${laptop.id}`, undefined, ada.key)).status).toBe(200);
    expect(socket.closed).not.toBeNull();
  });
});
