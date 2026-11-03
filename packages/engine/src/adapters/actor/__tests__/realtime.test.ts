import { afterEach, describe, expect, it, vi } from 'vitest';
import { InProcessRealtime } from '../../node/realtime.js';
import {
  ACTOR_RESTARTED_CLOSE_CODE,
  INVALID_PRINCIPAL_CLOSE_CODE,
  SOCKET_GRANT_HEADER,
  SocketGrantSchema,
  UNAUTHORIZED_CLOSE_CODE,
  isSocketGrant,
  toActorCloseCode,
  toActorCloseReason,
  type SocketPrincipal,
} from '../index.js';
import type { ActorHttpRequest } from '../http.js';
import { FakeWorkspaceActor, jsonRequest } from './fakeActor.js';

const WORKSPACE_ID = '241764880589606912';

interface Envelope<T> { ok: boolean; data: T; error?: { code: string; message: string } }

async function call<T>(actor: FakeWorkspaceActor, method: string, path: string, body?: unknown, token?: string) {
  const response = await actor.handle(jsonRequest(method, path, body, token));
  return { status: response.status, json: (response.body ? JSON.parse(response.body) : null) as Envelope<T> };
}

function upgradeRequest(path: string, token: string, upgrade = true): ActorHttpRequest {
  return {
    method: 'GET',
    url: `https://armadillo.test${path}?token=${encodeURIComponent(token)}`,
    headers: upgrade ? [['upgrade', 'websocket'], ['connection', 'Upgrade']] : [],
    body: null,
  };
}

async function workspaceWithAgents(actor: FakeWorkspaceActor) {
  const created = await call<{ workspace_id: string; api_key: string }>(actor, 'POST', '/v1/workspaces', { name: 'armadillo' });
  expect(created.status).toBe(201);
  const key = created.json.data.api_key;
  const alice = await call<{ token: string; id: string }>(actor, 'POST', '/v1/agents', { name: 'alice' }, key);
  const bob = await call<{ token: string }>(actor, 'POST', '/v1/agents', { name: 'bob' }, key);
  return { key, alice: alice.json.data.token, aliceId: alice.json.data.id, bob: bob.json.data.token };
}

/** Alice's direct node token and the grant `GET /v1/node/ws` answers for it. */
async function nodeGrant(actor: FakeWorkspaceActor, agentToken: string) {
  const minted = await call<{ node_id: string; node_name: string; token: string }>(actor, 'POST', '/v1/agent/node-token', {}, agentToken);
  expect(minted.status).toBe(200);
  const response = await actor.handle(upgradeRequest('/v1/node/ws', minted.json.data.token));
  expect(response.status).toBe(200);
  expect(isSocketGrant(response)).toBe(true);
  const grant = SocketGrantSchema.parse(JSON.parse(response.body));
  return { ...minted.json.data, principal: grant.data.metadata };
}

/** The first frame a direct node sends (docs/self-hosting.md, "Connecting clients"). */
function nodeRegister(node: { node_id: string; node_name: string }) {
  return {
    v: 1, id: 'r1', type: 'node.register', node_id: node.node_id, name: node.node_name,
    capabilities: [], max_agents: 1, tags: ['implicit', 'direct'], version: 'actor-test/1',
  };
}

async function observerGrant(actor: FakeWorkspaceActor, key: string) {
  const minted = await call<{ id: string; token: string }>(actor, 'POST', '/v1/observer-tokens', {
    name: 'tap', scopes: ['stream:read', 'messages:read', 'dms:read'], filters: { include_dms: true },
  }, key);
  expect(minted.status).toBe(201);
  const response = await actor.handle(upgradeRequest('/v1/ws', minted.json.data.token));
  expect(response.status).toBe(200);
  const grant = SocketGrantSchema.parse(JSON.parse(response.body));
  return { ...minted.json.data, principal: grant.data.metadata };
}

function rows(actor: FakeWorkspaceActor, sql: string, ...bindings: string[]) {
  return actor.sql.raw.prepare(sql).all(...bindings) as Record<string, unknown>[];
}

describe('workspace actor realtime', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('answers an authenticated node upgrade with a socket grant and refuses a bad token', async () => {
    const actor = new FakeWorkspaceActor(WORKSPACE_ID);
    const { alice } = await workspaceWithAgents(actor);
    const node = await nodeGrant(actor, alice);
    expect(node.principal).toEqual({ v: 1, kind: 'node', workspace_id: WORKSPACE_ID, node_id: node.node_id });

    const response = await actor.handle(upgradeRequest('/v1/node/ws', node.token));
    expect(new Headers(response.headers).get(SOCKET_GRANT_HEADER)).toBe('1');
    expect(JSON.parse(response.body)).toEqual({ ok: true, data: { metadata: node.principal } });

    const forged = await actor.handle(upgradeRequest('/v1/node/ws', `${node.token.slice(0, -4)}zzzz`));
    expect(forged.status).toBe(401);
    expect(isSocketGrant(forged)).toBe(false);
    // An agent token cannot open the node transport either.
    expect((await actor.handle(upgradeRequest('/v1/node/ws', alice))).status).toBe(401);
    // The engine route still wants a WebSocket upgrade.
    expect((await actor.handle(upgradeRequest('/v1/node/ws', node.token, false))).status).toBe(426);
  });

  it('answers an observer upgrade with a grant carrying only the token id', async () => {
    const actor = new FakeWorkspaceActor(WORKSPACE_ID);
    const { key } = await workspaceWithAgents(actor);
    const observer = await observerGrant(actor, key);
    expect(observer.principal).toEqual({ v: 1, kind: 'observer', workspace_id: WORKSPACE_ID, observer_token_id: observer.id });
    expect(JSON.stringify(observer.principal)).not.toContain(observer.token);
    // A workspace key is not an observer.
    expect((await actor.handle(upgradeRequest('/v1/ws', key))).status).toBe(401);
  });

  it('drives node.register over the actor socket and delivers a DM as a deliver frame', async () => {
    const actor = new FakeWorkspaceActor(WORKSPACE_ID);
    const { alice, bob } = await workspaceWithAgents(actor);
    const node = await nodeGrant(actor, alice);

    const socket = await actor.connect(node.principal);
    expect(socket.rejected).toBeNull();
    expect(socket.tags).toEqual([`c:${socket.id}`, 'kind:node', `node:${node.node_id}`]);
    expect(actor.runtime.deps.nodeConnections.isNodeConnected(WORKSPACE_ID, node.node_id)).toBe(true);

    await actor.message(socket, nodeRegister(node));
    const reply = socket.ofType('reply').find((frame) => frame.id === 'r1');
    expect(reply).toMatchObject({ ok: true });

    expect((await call(actor, 'POST', '/v1/dm', { to: 'alice', text: 'ping over the actor socket' }, bob)).status).toBe(201);
    const delivered = socket.ofType('deliver');
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ v: 1, agent: 'alice', payload: { type: 'dm.received' } });
    expect(delivered[0].delivery_id).toMatch(/^del_/);

    // Acks go the other way over the same socket.
    await actor.message(socket, { v: 1, type: 'delivery.ack', agent: 'alice', up_to_seq: delivered[0].seq });
    expect(rows(actor, "SELECT status FROM deliveries WHERE id = ?", delivered[0].delivery_id as string)).toEqual([{ status: 'acked' }]);

    // Every socket operation happened inside an actor call.
    expect(actor.sockets.violations).toEqual([]);
  });

  it('publishes workspace-stream events to an observer socket and refuses a revoked token at connect', async () => {
    const actor = new FakeWorkspaceActor(WORKSPACE_ID);
    const { key, alice } = await workspaceWithAgents(actor);
    const observer = await observerGrant(actor, key);

    const socket = await actor.connect(observer.principal);
    expect(socket.rejected).toBeNull();
    expect(socket.tags).toEqual([`c:${socket.id}`, 'kind:observer']);

    expect((await call(actor, 'POST', '/v1/channels/general/messages', { text: 'seen by the observer' }, alice)).status).toBe(201);
    expect(socket.ofType('message.created')).toHaveLength(1);
    expect(socket.ofType('message.created')[0]).toMatchObject({ channel: 'general', message: expect.objectContaining({ agent_name: 'alice', text: 'seen by the observer' }) });

    // `{ type: 'ping' }` is answered by the engine, not the control plane.
    await actor.message(socket, { type: 'ping' });
    expect(socket.ofType('pong')).toHaveLength(1);

    expect((await call(actor, 'DELETE', `/v1/observer-tokens/${observer.id}`, undefined, key)).status).toBe(204);
    const again = await actor.connect(observer.principal);
    expect(again.rejected).toEqual({ code: UNAUTHORIZED_CLOSE_CODE, reason: 'observer token unusable' });
    expect(actor.sockets.violations).toEqual([]);
  });

  it('rejects a socket whose metadata is not a principal for this workspace', async () => {
    const actor = new FakeWorkspaceActor(WORKSPACE_ID);
    const { alice } = await workspaceWithAgents(actor);
    const node = await nodeGrant(actor, alice);

    const garbage = await actor.connect({ user: 'ada' });
    expect(garbage.rejected).toEqual({ code: INVALID_PRINCIPAL_CLOSE_CODE, reason: 'invalid socket principal' });

    const foreign: SocketPrincipal = { ...node.principal, workspace_id: '241764880589606913' };
    const other = await actor.connect(foreign);
    expect(other.rejected?.code).toBe(INVALID_PRINCIPAL_CLOSE_CODE);

    const gone: SocketPrincipal = { v: 1, kind: 'node', workspace_id: WORKSPACE_ID, node_id: 'node_never_enrolled' };
    expect((await actor.connect(gone)).rejected).toEqual({ code: UNAUTHORIZED_CLOSE_CODE, reason: 'unknown node' });
    expect(actor.sockets.connections.size).toBe(0);
  });

  it('closes a control-plane socket its registry never saw and tears down one the control plane lost', async () => {
    const actor = new FakeWorkspaceActor(WORKSPACE_ID);
    const { alice, key } = await workspaceWithAgents(actor);
    const node = await nodeGrant(actor, alice);

    // (a) The socket survived an actor restart: the registry cannot know it.
    const orphan = actor.sockets.open(node.principal);
    expect((await call(actor, 'GET', '/v1/agents', undefined, key)).status).toBe(200);
    expect(orphan.closed).toEqual({ code: ACTOR_RESTARTED_CLOSE_CODE, reason: 'actor restarted' });
    expect(actor.sockets.connections.has(orphan.id)).toBe(false);

    // A frame from such a socket is dropped, never dispatched.
    const late = actor.sockets.open(node.principal);
    await actor.message(late, nodeRegister(node));
    expect(late.closed?.code).toBe(ACTOR_RESTARTED_CLOSE_CODE);
    expect(late.sent).toEqual([]);

    // (b) The control plane lost a known socket without an onDisconnect.
    const socket = await actor.connect(node.principal);
    await actor.message(socket, nodeRegister(node));
    expect(rows(actor, 'SELECT status FROM nodes WHERE id = ?', node.node_id)).toEqual([{ status: 'online' }]);
    actor.sockets.drop(socket);
    expect((await call(actor, 'GET', '/v1/agents', undefined, key)).status).toBe(200);
    expect(actor.runtime.deps.nodeConnections.isNodeConnected(WORKSPACE_ID, node.node_id)).toBe(false);
    expect(rows(actor, 'SELECT status FROM nodes WHERE id = ?', node.node_id)).toEqual([{ status: 'offline' }]);

    // A regular disconnect tears down once, through the same path.
    const next = await actor.connect(node.principal);
    await actor.message(next, nodeRegister(node));
    await actor.disconnect(next);
    expect(actor.runtime.deps.nodeConnections.isNodeConnected(WORKSPACE_ID, node.node_id)).toBe(false);
    expect(rows(actor, 'SELECT status FROM nodes WHERE id = ?', node.node_id)).toEqual([{ status: 'offline' }]);
    expect(actor.sockets.violations).toEqual([]);
  });

  it('maps engine close codes to ones durable-actors accepts', async () => {
    expect(toActorCloseCode(undefined)).toBe(1000);
    expect(toActorCloseCode(1000)).toBe(1000);
    expect(toActorCloseCode(1008)).toBe(4008);
    expect(toActorCloseCode(1012)).toBe(4012);
    expect(toActorCloseCode(4401)).toBe(4401);
    expect(toActorCloseCode(3000)).toBe(3000);
    expect(toActorCloseCode(2500)).toBe(4000);
    expect(toActorCloseReason(undefined)).toBe('');
    expect(toActorCloseReason('x'.repeat(200))).toHaveLength(123);
    const accented = toActorCloseReason('é'.repeat(100));
    expect(Buffer.byteLength(accented)).toBeLessThanOrEqual(123);
    expect(accented).toMatch(/^é+$/);

    // End to end: the engine closes a revoked observer with 1008 on the next publish.
    vi.useFakeTimers({ toFake: ['Date'] });
    const actor = new FakeWorkspaceActor(WORKSPACE_ID);
    const { key, alice } = await workspaceWithAgents(actor);
    const observer = await observerGrant(actor, key);
    const socket = await actor.connect(observer.principal);
    expect((await call(actor, 'DELETE', `/v1/observer-tokens/${observer.id}`, undefined, key)).status).toBe(204);
    vi.setSystemTime(Date.now() + 6_000);
    expect((await call(actor, 'POST', '/v1/channels/general/messages', { text: 'after revocation' }, alice)).status).toBe(201);
    expect(socket.closed).toEqual({ code: 4008, reason: 'observer token revoked' });
    expect(socket.ofType('message.created')).toEqual([]);
  });

  it("settles the registry's background drain before the call returns", async () => {
    const actor = new FakeWorkspaceActor(WORKSPACE_ID);
    const { alice } = await workspaceWithAgents(actor);
    const node = await nodeGrant(actor, alice);

    // The early drain after attachNodeSocket is handed to the scheduler, not detached.
    const scheduled: Promise<unknown>[] = [];
    const bare = new InProcessRealtime(actor.runtime.deps.db);
    bare.setBackgroundScheduler((promise) => { scheduled.push(promise); });
    bare.attachNodeSocket(WORKSPACE_ID, node.node_id, { send() {}, close() {} });
    expect(scheduled).toHaveLength(1);
    await expect(scheduled[0]).resolves.toBeUndefined();

    // Inside the actor, the drain has finished by the time onConnect resolves.
    let drains = 0;
    const drainNode = InProcessRealtime.prototype.drainNode;
    const spy = vi.spyOn(InProcessRealtime.prototype, 'drainNode').mockImplementation(function (this: InProcessRealtime, ...args) {
      return drainNode.apply(this, args).then(() => { drains += 1; });
    });
    try {
      await actor.connect(node.principal);
      expect(drains).toBe(1);
    } finally {
      spy.mockRestore();
    }
    expect(actor.sockets.violations).toEqual([]);
  });
});
