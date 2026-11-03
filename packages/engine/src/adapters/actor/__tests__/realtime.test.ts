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
import { FakeWorkspaceActor, jsonRequest, type FakeActorSocket } from './fakeActor.js';

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

    // (a) A socket neither the memory nor the socket table accounts for.
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

  it('keeps a direct agent online and invokable after its client reconnects into a warm actor', async () => {
    const actor = new FakeWorkspaceActor(WORKSPACE_ID);
    const { key, alice, bob } = await workspaceWithAgents(actor);
    const node = await nodeGrant(actor, alice);
    const agentStatus = async () => {
      const list = await call<{ name: string; status: string }[]>(actor, 'GET', '/v1/agents', undefined, key);
      expect(list.status).toBe(200);
      return list.json.data.find((agent) => agent.name === 'alice')?.status;
    };

    // First connection: the SDK agent registers its direct node and publishes an action.
    const first = await actor.connect(node.principal);
    await actor.message(first, nodeRegister(node));
    expect(first.ofType('reply').find((frame) => frame.id === 'r1')).toMatchObject({ ok: true });
    expect((await call(actor, 'POST', '/v1/actions', { name: 'crm.lookup', description: 'Look someone up', handler_agent: 'alice' }, key)).status).toBe(201);
    expect(await agentStatus()).toBe('active');
    await actor.message(first, { v: 1, id: 'h1', type: 'node.heartbeat', active_agents: 1, handlers_live: false });

    // The client reconnects: the control plane reports the old socket gone, then a new one.
    // The old socket's teardown took the node and its agent offline.
    await actor.disconnect(first);
    expect(await agentStatus()).toBe('offline');
    const second = await actor.connect(node.principal);
    expect(second.rejected).toBeNull();
    await actor.message(second, { ...nodeRegister(node), id: 'r2' });
    expect(second.ofType('reply').find((frame) => frame.id === 'r2')).toMatchObject({ ok: true });

    // node.register brought the node back, and the agent bound to it, without waiting for a heartbeat.
    expect(actor.runtime.deps.nodeConnections.isNodeConnected(WORKSPACE_ID, node.node_id)).toBe(true);
    expect(actor.runtime.deps.nodeConnections.isProviderConnected(WORKSPACE_ID, node.node_id, 'default')).toBe(true);
    expect(rows(actor, 'SELECT status FROM nodes WHERE id = ?', node.node_id)).toEqual([{ status: 'online' }]);
    expect(await agentStatus()).toBe('active');

    const invoked = await call<{ status: string; invocation_id: string }>(actor, 'POST', '/v1/actions/crm.lookup/invoke', { input: { name: 'ada' } }, bob);
    expect(invoked.status, JSON.stringify(invoked.json)).toBe(201);
    expect(invoked.json.data.status).toBe('dispatched');
    expect(second.ofType('action.invoke')).toEqual([expect.objectContaining({ action: 'crm.lookup', invocation_id: invoked.json.data.invocation_id })]);
    expect(first.ofType('action.invoke')).toEqual([]);
    expect(actor.sockets.violations).toEqual([]);
  });

  /** A direct agent with a published action, whose status and node the assertions read. */
  async function directAgentWithAction(actor: FakeWorkspaceActor) {
    const { key, alice, bob, aliceId } = await workspaceWithAgents(actor);
    const node = await nodeGrant(actor, alice);
    expect((await call(actor, 'POST', '/v1/actions', { name: 'crm.lookup', description: 'Look someone up', handler_agent: 'alice' }, key)).status).toBe(201);
    const agentStatus = async (on: FakeWorkspaceActor = actor) => {
      const list = await call<{ name: string; status: string }[]>(on, 'GET', '/v1/agents', undefined, key);
      expect(list.status).toBe(200);
      return list.json.data.find((agent) => agent.name === 'alice')?.status;
    };
    const statusEvents = () => rows(actor, "SELECT type FROM workspace_events WHERE type LIKE 'node.status.%' ORDER BY seq").map((row) => row.type);
    const socketRows = () => rows(actor, 'SELECT socket_id, provider_name FROM _actor_sockets ORDER BY attached_at, rowid');
    const expectOnline = async (on: FakeWorkspaceActor) => {
      const registry = on.runtime.deps.nodeConnections;
      expect(registry.isNodeConnected(WORKSPACE_ID, node.node_id)).toBe(true);
      expect(registry.isProviderConnected(WORKSPACE_ID, node.node_id, 'default')).toBe(true);
      expect(registry.isProviderAttached?.(WORKSPACE_ID, node.node_id, 'default')).toBe(true);
      expect(rows(actor, 'SELECT status FROM nodes WHERE id = ?', node.node_id)).toEqual([{ status: 'online' }]);
      expect(await agentStatus(on)).toBe('active');
      expect(statusEvents()).toEqual(['node.status.online']);
    };
    const expectOfflineOnce = async (on: FakeWorkspaceActor) => {
      expect(on.runtime.deps.nodeConnections.isNodeConnected(WORKSPACE_ID, node.node_id)).toBe(false);
      expect(rows(actor, 'SELECT status FROM nodes WHERE id = ?', node.node_id)).toEqual([{ status: 'offline' }]);
      expect(await agentStatus(on)).toBe('offline');
      expect(statusEvents()).toEqual(['node.status.online', 'node.status.offline']);
      expect(socketRows()).toEqual([]);
    };
    const invoke = async (on: FakeWorkspaceActor, handler: FakeActorSocket, others: FakeActorSocket[]) => {
      const invoked = await call<{ status: string; invocation_id: string }>(on, 'POST', '/v1/actions/crm.lookup/invoke', { input: { name: 'ada' } }, bob);
      expect(invoked.status, JSON.stringify(invoked.json)).toBe(201);
      expect(invoked.json.data.status).toBe('dispatched');
      expect(handler.ofType('action.invoke')).toEqual([expect.objectContaining({ action: 'crm.lookup', invocation_id: invoked.json.data.invocation_id })]);
      for (const other of others) expect(other.ofType('action.invoke')).toEqual([]);
    };
    return { key, alice, aliceId, bob, node, agentStatus, statusEvents, socketRows, expectOnline, expectOfflineOnce, invoke };
  }

  it('ignores the late disconnect of a socket a reconnect already superseded', async () => {
    const actor = new FakeWorkspaceActor(WORKSPACE_ID);
    const { node, socketRows, expectOnline, expectOfflineOnce, invoke } = await directAgentWithAction(actor);

    // The SDK reconnects by closing its socket and opening a new one; through a
    // gateway the actor sees the new socket connect and register before the
    // old socket's disconnect arrives.
    const first = await actor.connect(node.principal);
    await actor.message(first, nodeRegister(node));
    await actor.message(first, { v: 1, id: 'h1', type: 'node.heartbeat', active_agents: 1, handlers_live: false });
    const second = await actor.connect(node.principal);
    await actor.message(second, { ...nodeRegister(node), id: 'r2' });
    expect(second.sent).toEqual([expect.objectContaining({ id: 'r2', type: 'reply', ok: true })]);
    // The registry closed the superseded socket and forgot its row.
    expect(first.closed).toEqual({ code: 1000, reason: 'superseded' });
    expect(socketRows()).toEqual([{ socket_id: second.id, provider_name: 'default' }]);

    await actor.disconnect(first);
    await expectOnline(actor);
    expect(socketRows()).toEqual([{ socket_id: second.id, provider_name: 'default' }]);
    await invoke(actor, second, [first]);

    await actor.disconnect(second);
    await expectOfflineOnce(actor);
    expect(actor.sockets.violations).toEqual([]);
  });

  it('ignores the late disconnect of a superseded socket after the actor restarted in between', async () => {
    const actor = new FakeWorkspaceActor(WORKSPACE_ID);
    const { node, agentStatus, socketRows, expectOnline, expectOfflineOnce, invoke } = await directAgentWithAction(actor);

    const first = await actor.connect(node.principal);
    await actor.message(first, nodeRegister(node));
    const second = await actor.connect(node.principal);
    await actor.message(second, { ...nodeRegister(node), id: 'r2' });
    expect(second.sent).toEqual([expect.objectContaining({ id: 'r2', type: 'reply', ok: true })]);

    // The actor sleeps; the next activation replays the surviving socket's row
    // before the old socket's disconnect is delivered to it.
    const woken = actor.restart();
    expect(await agentStatus(woken)).toBe('active');
    expect(second.closed).toBeNull();
    expect(socketRows()).toEqual([{ socket_id: second.id, provider_name: 'default' }]);

    await woken.disconnect(first);
    await expectOnline(woken);
    expect(socketRows()).toEqual([{ socket_id: second.id, provider_name: 'default' }]);
    await invoke(woken, second, [first]);

    await woken.disconnect(second);
    await expectOfflineOnce(woken);
    expect(actor.sockets.violations).toEqual([]);
  });

  it('rebuilds the registry from the socket table when the actor restarts, closing nothing', async () => {
    const actor = new FakeWorkspaceActor(WORKSPACE_ID);
    const { key, alice, bob } = await workspaceWithAgents(actor);
    const node = await nodeGrant(actor, alice);
    const observer = await observerGrant(actor, key);
    const statusEvents = () => rows(actor, "SELECT type FROM workspace_events WHERE type LIKE 'node.status.%' ORDER BY seq").map((row) => row.type);

    const socket = await actor.connect(node.principal);
    await actor.message(socket, nodeRegister(node));
    const tap = await actor.connect(observer.principal);
    expect(statusEvents()).toEqual(['node.status.online']);
    expect(rows(actor, 'SELECT kind, node_id, provider_name, delivery_mode, delivery_ready, caller_aware_actions FROM _actor_sockets WHERE socket_id = ?', socket.id))
      .toEqual([{ kind: 'node', node_id: node.node_id, provider_name: 'default', delivery_mode: 'immediate', delivery_ready: null, caller_aware_actions: '[]' }]);
    expect(rows(actor, 'SELECT kind, observer_token_id FROM _actor_sockets WHERE socket_id = ?', tap.id))
      .toEqual([{ kind: 'observer', observer_token_id: observer.id }]);

    // The actor stopped idle; the control plane still holds both sockets.
    const woken = actor.restart();
    expect((await call(woken, 'POST', '/v1/dm', { to: 'alice', text: 'after the sleep' }, bob)).status).toBe(201);
    expect(socket.closed).toBeNull();
    expect(tap.closed).toBeNull();
    const delivered = socket.ofType('deliver');
    expect(delivered).toEqual([expect.objectContaining({ agent: 'alice', payload: expect.objectContaining({ type: 'dm.received' }) })]);
    const registry = woken.runtime.deps.nodeConnections;
    expect(registry.isNodeConnected(WORKSPACE_ID, node.node_id)).toBe(true);
    expect(registry.isProviderConnected(WORKSPACE_ID, node.node_id, 'default')).toBe(true);
    expect(registry.providerDeliveryReadinessMode?.(WORKSPACE_ID, node.node_id, 'default', socket.id)).toBe('immediate');
    // A memory rebuild, not a reconnect: no presence flap.
    expect(statusEvents()).toEqual(['node.status.online']);
    expect(rows(actor, 'SELECT status FROM nodes WHERE id = ?', node.node_id)).toEqual([{ status: 'online' }]);

    // The observer keeps its stream, and the rebuilt node connection handles frames.
    expect((await call(woken, 'POST', '/v1/channels/general/messages', { text: 'seen after the sleep' }, alice)).status).toBe(201);
    expect(tap.ofType('message.created')).toHaveLength(1);
    await woken.message(socket, { v: 1, type: 'delivery.ack', agent: 'alice', up_to_seq: delivered[0].seq });
    expect(rows(actor, 'SELECT status FROM deliveries WHERE id = ?', delivered[0].delivery_id as string)).toEqual([{ status: 'acked' }]);

    // A disconnect after the rebuild tears down once.
    await woken.disconnect(socket);
    expect(registry.isNodeConnected(WORKSPACE_ID, node.node_id)).toBe(false);
    expect(statusEvents()).toEqual(['node.status.online', 'node.status.offline']);
    expect(rows(actor, 'SELECT socket_id FROM _actor_sockets')).toEqual([{ socket_id: tap.id }]);
    expect(actor.sockets.violations).toEqual([]);
  });

  it('restores agent-scoped delivery readiness and the liveness timestamp across a restart', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const actor = new FakeWorkspaceActor(WORKSPACE_ID);
    const { key, alice, aliceId } = await workspaceWithAgents(actor);
    const node = await nodeGrant(actor, alice);
    const socket = await actor.connect(node.principal);
    await actor.message(socket, nodeRegister(node));
    const seenAt = Date.now();

    // What a cursor-handshake register and the agent's `agent.register` leave in the registry.
    const registry = actor.runtime.deps.nodeConnections;
    await actor.sql.atomic(async () => {
      registry.setProviderDeliveryReadiness?.(WORKSPACE_ID, node.node_id, 'default', socket.id, 'agent_scoped');
      registry.markProviderAgentsDeliveryReady?.(WORKSPACE_ID, node.node_id, 'default', undefined, [aliceId]);
    });
    expect(rows(actor, 'SELECT delivery_ready, last_seen FROM _actor_sockets WHERE socket_id = ?', socket.id))
      .toEqual([{ delivery_ready: JSON.stringify([aliceId]), last_seen: seenAt }]);

    vi.setSystemTime(seenAt + 60_000);
    const woken = actor.restart();
    expect((await call(woken, 'GET', '/v1/agents', undefined, key)).status).toBe(200);
    const rebuilt = woken.runtime.deps.nodeConnections;
    expect(rebuilt.providerDeliveryReadinessMode?.(WORKSPACE_ID, node.node_id, 'default', socket.id)).toBe('agent_scoped');
    expect(rebuilt.isProviderAgentDeliveryReady?.(WORKSPACE_ID, node.node_id, 'default', aliceId)).toBe(true);
    expect(rebuilt.isProviderAgentDeliveryReady?.(WORKSPACE_ID, node.node_id, 'default', 'agent_other')).toBe(false);
    // The restored timestamp is the one arbitration reads: a different instance registering now is a stale-incumbent takeover, not a duplicate.
    expect(rebuilt.providerAttachConflict?.(WORKSPACE_ID, node.node_id, 'default', 'other-instance', 'another-conn')).toBeNull();
    expect(socket.closed).toBeNull();
  });

  it('after a restart, still closes a socket without a row and tears down a row whose socket vanished, once', async () => {
    const actor = new FakeWorkspaceActor(WORKSPACE_ID);
    const { key, alice } = await workspaceWithAgents(actor);
    const node = await nodeGrant(actor, alice);
    const observer = await observerGrant(actor, key);
    const statusEvents = () => rows(actor, "SELECT type FROM workspace_events WHERE type LIKE 'node.status.%' ORDER BY seq").map((row) => row.type);

    const socket = await actor.connect(node.principal);
    await actor.message(socket, nodeRegister(node));
    const tap = await actor.connect(observer.principal);
    // The control plane lost the node socket while the actor slept (no onDisconnect) ...
    actor.sockets.drop(socket);
    // ... holds one the actor never recorded ...
    const orphan = actor.sockets.open(node.principal);
    // ... and the observer's token was revoked meanwhile.
    actor.sql.exec("UPDATE observer_tokens SET status = 'revoked' WHERE id = ?", observer.id);

    const woken = actor.restart();
    expect((await call(woken, 'GET', '/v1/agents', undefined, key)).status).toBe(200);
    expect(orphan.closed).toEqual({ code: ACTOR_RESTARTED_CLOSE_CODE, reason: 'actor restarted' });
    expect(tap.closed).toEqual({ code: UNAUTHORIZED_CLOSE_CODE, reason: 'socket principal no longer valid' });
    expect(woken.runtime.deps.nodeConnections.isNodeConnected(WORKSPACE_ID, node.node_id)).toBe(false);
    expect(rows(actor, 'SELECT status FROM nodes WHERE id = ?', node.node_id)).toEqual([{ status: 'offline' }]);
    expect(statusEvents()).toEqual(['node.status.online', 'node.status.offline']);
    expect(rows(actor, 'SELECT socket_id FROM _actor_sockets')).toEqual([]);

    // Nothing is torn down twice.
    expect((await call(woken, 'GET', '/v1/agents', undefined, key)).status).toBe(200);
    expect(statusEvents()).toEqual(['node.status.online', 'node.status.offline']);
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
