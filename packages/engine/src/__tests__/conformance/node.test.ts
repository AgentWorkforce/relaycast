import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { drainNodeInvocations, sweepTimedOutInvocations } from '../../index.js';
import {
  makeNodeStack,
  createWorkspace,
  registerAgent,
  FakeSocket,
  attachDirectNodeSocket,
  contextUpdatesOfType,
  deliverFramesOfType,
  type TestStack,
} from './harness.js';
import { actionInvocations, actions, agentNodeBindings, agents, deliveries, nodes } from '../../db/schema.js';
import { handleNodeControlMessage } from '../../node-control.js';
import type { NodeConnectionRegistry } from '../../ports/realtime.js';

function capability(name: string, kind?: string, metadata?: Record<string, unknown>) {
  return { name, ...(kind ? { kind } : {}), ...(metadata ? { metadata } : {}) };
}

/**
 * Conformance suite for the in-process Node adapter. These assert the
 * parity-critical realtime invariants for node transport, presence fanout,
 * workspace observer streams, rate limiting, and queued action drain.
 */
describe('node adapter conformance', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack({ ttlMs: 1_000 }); });
  afterEach(() => stack.close());

  describe('presence', () => {
    it('emits agent.status.active on connect and agent.status.offline on sweep', async () => {
      const ws = await createWorkspace(stack.app, 'presence-ws');
      const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
      const bob = await registerAgent(stack.app, ws.workspaceKey, 'bob');
      const presence = stack.runtime.presence;
      const { sock: bSock } = await attachDirectNodeSocket(stack, ws.workspaceId, bob);

      await presence.heartbeat(ws.workspaceId, alice.agentId, 'alice');
      await presence.heartbeat(ws.workspaceId, bob.agentId, 'bob');
      expect(await presence.getOnline(ws.workspaceId)).toEqual(expect.arrayContaining([alice.agentId, bob.agentId]));
      // Bob should have learned Alice (and itself) became active through node-scoped context.
      expect(contextUpdatesOfType(bSock, 'agent.status.active').length).toBeGreaterThanOrEqual(1);

      // Let Alice go stale (ttl 1s) and sweep.
      await new Promise((r) => setTimeout(r, 1100));
      await presence.heartbeat(ws.workspaceId, bob.agentId, 'bob'); // keep Bob alive
      bSock.received.length = 0;
      await presence.sweep();

      expect(await presence.getOnline(ws.workspaceId)).toEqual([bob.agentId]);
      const offline = contextUpdatesOfType(bSock, 'agent.status.offline');
      expect(offline.length).toBeGreaterThanOrEqual(1);
      expect(offline[0]).toMatchObject({
        type: 'context.update',
        event: 'agent.status.offline',
        data: { agent_name: 'alice', status: 'offline' },
      });
    });
  });

  describe('workspace stream', () => {
    it('fans out published events to workspace-stream sockets', async () => {
      const rt = stack.runtime.realtime;
      const sock = new FakeSocket();
      rt.attachWorkspaceSocket('w1', sock);
      await rt.publishToWorkspaceStream({ workspaceId: 'w1', event: { type: 'message.created', text: 'x' } });
      expect(sock.ofType('message.created')).toHaveLength(1);
    });
  });

  describe('rate limiter', () => {
    it('allows up to the limit then blocks within the window', async () => {
      const limiter = stack.runtime.deps.rateLimiter;
      const args = { bucketKey: 'k', limit: 3, windowMs: 60_000 };
      const r1 = await limiter.check(args);
      const r2 = await limiter.check(args);
      const r3 = await limiter.check(args);
      const r4 = await limiter.check(args);
      expect([r1.allowed, r2.allowed, r3.allowed]).toEqual([true, true, true]);
      expect(r4.allowed).toBe(false);
      expect(r4.remaining).toBe(0);
    });
  });

  describe('http integration: channel message delivery', () => {
    it('delivers message.created to joined channel members through the node route', async () => {
      const ws = await createWorkspace(stack.app, 'deliver-ws');
      const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
      const bob = await registerAgent(stack.app, ws.workspaceKey, 'bob');

      // Create channel + join both agents (this warms the member cache).
      // (workspace creation auto-seeds a "general" channel, so use another name)
      const createRes = await stack.app.request('/v1/channels', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
        body: JSON.stringify({ name: 'team-chat' }),
      });
      expect(createRes.status).toBeLessThan(300);
      for (const token of [alice.token, bob.token]) {
        const joinRes = await stack.app.request('/v1/channels/team-chat/join', {
          method: 'POST',
          headers: { authorization: `Bearer ${token}` },
        });
        expect(joinRes.status).toBeLessThan(300);
      }

      // Attach a live socket for bob, then alice posts a message.
      const { sock: bobSock } = await attachDirectNodeSocket(stack, ws.workspaceId, bob);

      const postRes = await stack.app.request('/v1/channels/team-chat/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
        body: JSON.stringify({ text: 'hello bob' }),
      });
      expect(postRes.status).toBeLessThan(300);
      const posted = await postRes.json() as { data: { id: string } };

      const [route] = await stack.runtime.deps.db
        .select({
          routeNodeKind: deliveries.routeNodeKind,
          routeNodeRole: deliveries.routeNodeRole,
          deliveryAdapter: deliveries.deliveryAdapter,
          nodeKind: nodes.kind,
          nodeRole: nodes.role,
          nodeDeliveryAdapter: nodes.deliveryAdapter,
        })
        .from(deliveries)
        .innerJoin(nodes, eq(deliveries.routeNodeId, nodes.id))
        .where(and(
          eq(deliveries.workspaceId, ws.workspaceId),
          eq(deliveries.messageId, posted.data.id),
          eq(deliveries.agentId, bob.agentId),
        ));
      expect(route).toMatchObject({
        routeNodeKind: 'ws',
        routeNodeRole: 'direct',
        deliveryAdapter: 'ws.node.v1',
        nodeKind: 'ws',
        nodeRole: 'direct',
        nodeDeliveryAdapter: 'ws.node.v1',
      });

      // fanout runs in background; give the event loop a tick.
      await new Promise((r) => setTimeout(r, 50));

      const delivered = deliverFramesOfType(bobSock, 'message.created');
      expect(delivered).toEqual([
        expect.objectContaining({
          type: 'deliver',
          msg_id: posted.data.id,
          agent: 'bob',
          payload: expect.objectContaining({
            type: 'message.created',
            data: expect.objectContaining({
              id: posted.data.id,
              channel_name: 'team-chat',
              from_name: 'alice',
              text: 'hello bob',
            }),
          }),
        }),
      ]);
      expect(typeof delivered[0].seq).toBe('number');
      expect(contextUpdatesOfType(bobSock, 'message.created')).toHaveLength(0);
    });

    it('does not create or push message deliveries for muted channel members', async () => {
      const ws = await createWorkspace(stack.app, 'muted-delivery-ws');
      const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
      const bob = await registerAgent(stack.app, ws.workspaceKey, 'bob');

      const createRes = await stack.app.request('/v1/channels', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
        body: JSON.stringify({ name: 'team-chat' }),
      });
      expect(createRes.status).toBeLessThan(300);
      for (const token of [alice.token, bob.token]) {
        const joinRes = await stack.app.request('/v1/channels/team-chat/join', {
          method: 'POST',
          headers: { authorization: `Bearer ${token}` },
        });
        expect(joinRes.status).toBeLessThan(300);
      }

      const muteRes = await stack.app.request('/v1/channels/team-chat/mute', {
        method: 'POST',
        headers: { authorization: `Bearer ${bob.token}` },
      });
      expect(muteRes.status).toBeLessThan(300);

      const { sock: bobSock } = await attachDirectNodeSocket(stack, ws.workspaceId, bob);
      bobSock.received.length = 0;

      const postRes = await stack.app.request('/v1/channels/team-chat/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
        body: JSON.stringify({ text: 'muted hello' }),
      });
      expect(postRes.status).toBeLessThan(300);
      const posted = await postRes.json() as { data: { id: string } };

      const rows = await stack.runtime.deps.db
        .select({ id: deliveries.id })
        .from(deliveries)
        .where(and(
          eq(deliveries.workspaceId, ws.workspaceId),
          eq(deliveries.messageId, posted.data.id),
          eq(deliveries.agentId, bob.agentId),
        ));

      expect(rows).toHaveLength(0);
      expect(deliverFramesOfType(bobSock, 'message.created')).toHaveLength(0);
    });

    it('creates a mention delivery for muted channel members when explicitly mentioned', async () => {
      const ws = await createWorkspace(stack.app, 'muted-mention-delivery-ws');
      const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
      const bob = await registerAgent(stack.app, ws.workspaceKey, 'bob');

      const createRes = await stack.app.request('/v1/channels', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
        body: JSON.stringify({ name: 'mentions-chat' }),
      });
      expect(createRes.status).toBeLessThan(300);
      for (const token of [alice.token, bob.token]) {
        const joinRes = await stack.app.request('/v1/channels/mentions-chat/join', {
          method: 'POST',
          headers: { authorization: `Bearer ${token}` },
        });
        expect(joinRes.status).toBeLessThan(300);
      }

      const muteRes = await stack.app.request('/v1/channels/mentions-chat/mute', {
        method: 'POST',
        headers: { authorization: `Bearer ${bob.token}` },
      });
      expect(muteRes.status).toBeLessThan(300);

      const { sock: bobSock } = await attachDirectNodeSocket(stack, ws.workspaceId, bob);
      bobSock.received.length = 0;

      const postRes = await stack.app.request('/v1/channels/mentions-chat/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
        body: JSON.stringify({ text: '@bob please look' }),
      });
      expect(postRes.status).toBeLessThan(300);
      const posted = await postRes.json() as { data: { id: string } };

      const rows = await stack.runtime.deps.db
        .select({ id: deliveries.id, reason: deliveries.reason })
        .from(deliveries)
        .where(and(
          eq(deliveries.workspaceId, ws.workspaceId),
          eq(deliveries.messageId, posted.data.id),
          eq(deliveries.agentId, bob.agentId),
        ));

      expect(rows).toEqual([
        expect.objectContaining({ reason: 'mention' }),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(deliverFramesOfType(bobSock, 'message.created')).toEqual([
        expect.objectContaining({
          type: 'deliver',
          msg_id: posted.data.id,
          payload: expect.objectContaining({
            type: 'message.created',
            data: expect.objectContaining({
              id: posted.data.id,
              channel_name: 'mentions-chat',
              from_name: 'alice',
              text: '@bob please look',
            }),
          }),
        }),
      ]);
    });

    it('creates a mention delivery for muted members mentioned in thread replies', async () => {
      const ws = await createWorkspace(stack.app, 'muted-thread-mention-delivery-ws');
      const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
      const bob = await registerAgent(stack.app, ws.workspaceKey, 'bob');

      const createRes = await stack.app.request('/v1/channels', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
        body: JSON.stringify({ name: 'thread-mentions-chat' }),
      });
      expect(createRes.status).toBeLessThan(300);
      for (const token of [alice.token, bob.token]) {
        const joinRes = await stack.app.request('/v1/channels/thread-mentions-chat/join', {
          method: 'POST',
          headers: { authorization: `Bearer ${token}` },
        });
        expect(joinRes.status).toBeLessThan(300);
      }

      const muteRes = await stack.app.request('/v1/channels/thread-mentions-chat/mute', {
        method: 'POST',
        headers: { authorization: `Bearer ${bob.token}` },
      });
      expect(muteRes.status).toBeLessThan(300);

      const parentRes = await stack.app.request('/v1/channels/thread-mentions-chat/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
        body: JSON.stringify({ text: 'parent message' }),
      });
      expect(parentRes.status).toBeLessThan(300);
      const parent = await parentRes.json() as { data: { id: string } };

      const { sock: bobSock } = await attachDirectNodeSocket(stack, ws.workspaceId, bob);
      bobSock.received.length = 0;

      const replyRes = await stack.app.request(`/v1/messages/${parent.data.id}/replies`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
        body: JSON.stringify({ text: '@bob please see this reply' }),
      });
      expect(replyRes.status).toBeLessThan(300);
      const reply = await replyRes.json() as { data: { id: string } };

      const rows = await stack.runtime.deps.db
        .select({ id: deliveries.id, reason: deliveries.reason })
        .from(deliveries)
        .where(and(
          eq(deliveries.workspaceId, ws.workspaceId),
          eq(deliveries.messageId, reply.data.id),
          eq(deliveries.agentId, bob.agentId),
        ));

      expect(rows).toEqual([
        expect.objectContaining({ reason: 'mention' }),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(deliverFramesOfType(bobSock, 'thread.reply')).toEqual([
        expect.objectContaining({
          type: 'deliver',
          msg_id: reply.data.id,
          payload: expect.objectContaining({
            type: 'thread.reply',
            data: expect.objectContaining({
              id: reply.data.id,
              channel_name: 'thread-mentions-chat',
              from_name: 'alice',
              text: '@bob please see this reply',
            }),
          }),
        }),
      ]);
      expect(contextUpdatesOfType(bobSock, 'thread.reply')).toHaveLength(0);

      bobSock.received.length = 0;
      const emailReplyRes = await stack.app.request(`/v1/messages/${parent.data.id}/replies`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
        body: JSON.stringify({ text: 'please email alice@bob.com' }),
      });
      expect(emailReplyRes.status).toBeLessThan(300);
      const emailReply = await emailReplyRes.json() as { data: { id: string } };

      const emailRows = await stack.runtime.deps.db
        .select({ id: deliveries.id, reason: deliveries.reason })
        .from(deliveries)
        .where(and(
          eq(deliveries.workspaceId, ws.workspaceId),
          eq(deliveries.messageId, emailReply.data.id),
          eq(deliveries.agentId, bob.agentId),
        ));

      expect(emailRows).toHaveLength(0);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(deliverFramesOfType(bobSock, 'thread.reply')).toHaveLength(0);
    });

    it('replays queued direct-node deliveries when the agent socket reconnects', async () => {
      const ws = await createWorkspace(stack.app, 'direct-node-reconnect-ws');
      const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
      const bob = await registerAgent(stack.app, ws.workspaceKey, 'bob');

      const postRes = await stack.app.request('/v1/channels/general/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
        body: JSON.stringify({ text: 'queued for direct reconnect' }),
      });
      expect(postRes.status).toBeLessThan(300);
      const posted = await postRes.json() as { data: { id: string } };
      await new Promise((resolve) => setTimeout(resolve, 50));

      let [queued] = await stack.runtime.deps.db
        .select({ status: deliveries.status })
        .from(deliveries)
        .where(and(
          eq(deliveries.workspaceId, ws.workspaceId),
          eq(deliveries.messageId, posted.data.id),
          eq(deliveries.agentId, bob.agentId),
        ));
      expect(queued).toMatchObject({ status: 'queued' });

      const { sock: bobSock } = await attachDirectNodeSocket(stack, ws.workspaceId, bob);
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(deliverFramesOfType(bobSock, 'message.created')).toEqual([
        expect.objectContaining({
          type: 'deliver',
          msg_id: posted.data.id,
          payload: expect.objectContaining({
            type: 'message.created',
            data: expect.objectContaining({
              id: posted.data.id,
              from_name: 'alice',
              text: 'queued for direct reconnect',
            }),
          }),
        }),
      ]);
      [queued] = await stack.runtime.deps.db
        .select({ status: deliveries.status })
        .from(deliveries)
        .where(and(
          eq(deliveries.workspaceId, ws.workspaceId),
          eq(deliveries.messageId, posted.data.id),
          eq(deliveries.agentId, bob.agentId),
        ));
      expect(queued).toMatchObject({ status: 'delivered' });
    });
  });

  describe('fleet node control', () => {
    async function enrollAndAttachNode(
      ws: { workspaceKey: string; workspaceId: string },
      opts: {
        id: string;
        name: string;
        capabilities: Array<ReturnType<typeof capability>>;
        load?: number;
        maxAgents?: number;
      },
    ) {
      const create = await stack.app.request('/v1/nodes', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
        body: JSON.stringify({
          node_id: opts.id,
          name: opts.name,
          capabilities: opts.capabilities.map((cap) => cap.name),
          max_agents: opts.maxAgents ?? 4,
          tags: ['test'],
          version: 'test-node',
        }),
      });
      expect(create.status).toBe(201);

      const sock = new FakeSocket();
      const handle = stack.runtime.realtime.attachNodeSocket(ws.workspaceId, opts.id, sock);
      await handle.handleMessage(JSON.stringify({
        v: 1,
        id: 'node-register-1',
        type: 'node.register',
        name: opts.name,
        node_id: opts.id,
        capabilities: opts.capabilities,
        max_agents: opts.maxAgents ?? 4,
        tags: ['test'],
        version: 'test-node',
        resume_cursor: null,
      }));
      expect(sock.ofType('reply')).toHaveLength(1);
      expect(sock.ofType('reply')[0]).toMatchObject({
        id: 'node-register-1',
        ok: true,
        data: expect.objectContaining({ name: opts.name }),
      });
      await handle.handleMessage(JSON.stringify({
        v: 1,
        id: 'node-register-bad',
        type: 'node.register',
        name: opts.name,
        node_id: 'wrong-node',
        capabilities: opts.capabilities,
        max_agents: opts.maxAgents ?? 4,
        tags: ['test'],
        version: 'test-node',
        resume_cursor: null,
      }));
      expect(sock.ofType('error')).toHaveLength(1);
      expect(sock.ofType('error')[0]).toMatchObject({
        id: 'node-register-bad',
        ok: false,
        code: 'node_id_mismatch',
      });
      await handle.handleMessage(JSON.stringify({
        v: 1,
        type: 'node.heartbeat',
        load: opts.load ?? 0,
        active_agents: 0,
        handlers_live: true,
      }));
      return { sock, handle };
    }

    it('drives node control directly without the websocket route wrapper', async () => {
      const ws = await createWorkspace(stack.app, 'node-control-direct-dispatch');
      const db = stack.runtime.handle.db;

      const createBroker = await stack.app.request('/v1/nodes', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
        body: JSON.stringify({
          node_id: 'node_control_broker',
          name: 'control-broker',
          role: 'broker',
          capabilities: [],
          max_agents: 4,
          tags: ['control'],
          version: 'control-v0',
        }),
      });
      expect(createBroker.status).toBe(201);

      const brokerSock = new FakeSocket();
      const sendBroker = (frame: Record<string, unknown>) => handleNodeControlMessage({
        db,
        registry: stack.runtime.realtime,
        completionDeps: stack.runtime.deps,
        workspaceId: ws.workspaceId,
        nodeId: 'node_control_broker',
        socket: brokerSock,
        raw: JSON.stringify(frame),
      });

      await sendBroker({
        v: 1,
        id: 'control-broker-register',
        type: 'node.register',
        name: 'control-broker',
        node_id: 'node_control_broker',
        capabilities: [capability('echo', 'tool')],
        max_agents: 4,
        tags: ['control'],
        version: 'control-v1',
        resume_cursor: null,
      });
      expect(brokerSock.ofType('reply').at(-1)).toMatchObject({
        id: 'control-broker-register',
        ok: true,
      });

      await sendBroker({
        v: 1,
        id: 'control-agent-register',
        type: 'agent.register',
        name: 'control-worker',
        session_ref: 'pty://control/worker',
        resumable: true,
      });
      const agentReply = brokerSock.ofType('reply').at(-1) as { data?: { agent_id?: string } };
      const controlAgentId = agentReply.data?.agent_id ?? '';
      expect(controlAgentId.length).toBeGreaterThan(0);

      const [activeBinding] = await db
        .select({
          nodeId: agentNodeBindings.nodeId,
          status: agentNodeBindings.status,
          sessionRef: agentNodeBindings.sessionRef,
        })
        .from(agentNodeBindings)
        .where(and(
          eq(agentNodeBindings.workspaceId, ws.workspaceId),
          eq(agentNodeBindings.agentId, controlAgentId),
          eq(agentNodeBindings.status, 'active'),
        ));
      expect(activeBinding).toMatchObject({
        nodeId: 'node_control_broker',
        status: 'active',
        sessionRef: 'pty://control/worker',
      });

      await sendBroker({
        v: 1,
        id: 'control-broker-heartbeat',
        type: 'node.heartbeat',
        load: 0.25,
        active_agents: 1,
        handlers_live: true,
        node_id: 'node_control_broker',
        name: 'control-broker-renamed',
        capabilities: [capability('echo', 'tool'), capability('spawn:claude', 'spawn')],
        max_agents: 6,
        version: 'control-v2',
      });
      const [brokerNode] = await db
        .select()
        .from(nodes)
        .where(and(eq(nodes.workspaceId, ws.workspaceId), eq(nodes.id, 'node_control_broker')));
      expect(brokerNode).toMatchObject({
        name: 'control-broker-renamed',
        maxAgents: 6,
        activeAgents: 1,
        handlersLive: true,
        version: 'control-v2',
      });
      expect(brokerNode.capabilities.map((cap) => cap.name).sort()).toEqual(['echo', 'spawn:claude']);

      await sendBroker({
        v: 1,
        id: 'control-agent-deregister',
        type: 'agent.deregister',
        agent_id: controlAgentId,
      });
      const activeBindingsAfterDeregister = await db
        .select({ id: agentNodeBindings.id })
        .from(agentNodeBindings)
        .where(and(
          eq(agentNodeBindings.workspaceId, ws.workspaceId),
          eq(agentNodeBindings.agentId, controlAgentId),
          eq(agentNodeBindings.nodeId, 'node_control_broker'),
          eq(agentNodeBindings.status, 'active'),
        ));
      expect(activeBindingsAfterDeregister).toHaveLength(0);

      const createDirect = await stack.app.request('/v1/nodes', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
        body: JSON.stringify({
          node_id: 'node_control_direct',
          name: 'control-direct',
          role: 'direct',
          capabilities: ['echo'],
          max_agents: 1,
          tags: ['direct'],
          version: 'direct-v0',
        }),
      });
      expect(createDirect.status).toBe(201);

      const directSock = new FakeSocket();
      const sendDirect = (frame: Record<string, unknown>) => handleNodeControlMessage({
        db,
        registry: stack.runtime.realtime,
        workspaceId: ws.workspaceId,
        nodeId: 'node_control_direct',
        socket: directSock,
        raw: JSON.stringify(frame),
      });

      await sendDirect({
        v: 1,
        id: 'control-direct-register',
        type: 'node.register',
        name: 'control-direct-live',
        node_id: 'node_control_direct',
        capabilities: [capability('echo', 'tool'), capability('spawn:claude', 'spawn')],
        max_agents: 99,
        tags: ['attempted-broker'],
        version: 'direct-v1',
        resume_cursor: null,
      });
      expect(directSock.ofType('reply').at(-1)).toMatchObject({
        id: 'control-direct-register',
        ok: true,
      });

      await sendDirect({
        v: 1,
        id: 'control-direct-heartbeat',
        type: 'node.heartbeat',
        load: 0.5,
        active_agents: 7,
        handlers_live: true,
        node_id: 'node_control_direct',
        name: 'control-direct-live',
        capabilities: [capability('echo', 'tool')],
        max_agents: 99,
        version: 'direct-v2',
      });
      const [directNode] = await db
        .select()
        .from(nodes)
        .where(and(eq(nodes.workspaceId, ws.workspaceId), eq(nodes.id, 'node_control_direct')));
      expect(directNode).toMatchObject({
        role: 'direct',
        maxAgents: 1,
        activeAgents: 1,
        handlersLive: false,
        version: 'direct-v2',
      });
      expect(directNode.capabilities).toEqual([]);
    });

    it('rejects delivery cursor negotiation when a realtime adapter lacks readiness hooks', async () => {
      const ws = await createWorkspace(stack.app, 'node-control-legacy-readiness');
      const db = stack.runtime.handle.db;
      const createBroker = await stack.app.request('/v1/nodes', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
        body: JSON.stringify({
          node_id: 'legacy_adapter_broker',
          name: 'legacy-adapter-broker',
          role: 'broker',
          capabilities: [],
          max_agents: 4,
          tags: ['control'],
          version: 'control-v0',
        }),
      });
      expect(createBroker.status).toBe(201);

      const realtime = stack.runtime.realtime;
      const legacyRegistry: NodeConnectionRegistry = {
        upgradeNode: (args) => realtime.upgradeNode(args),
        sendToNode: (...args) => realtime.sendToNode(...args),
        sendToProvider: (...args) => realtime.sendToProvider(...args),
        isNodeConnected: (...args) => realtime.isNodeConnected(...args),
        isProviderConnected: (...args) => realtime.isProviderConnected(...args),
        detachProvider: (...args) => realtime.detachProvider(...args),
        disconnectNode: (...args) => realtime.disconnectNode(...args),
        drainNode: (...args) => realtime.drainNode(...args),
      };
      const sock = new FakeSocket();
      const send = (frame: Record<string, unknown>) => handleNodeControlMessage({
        db,
        registry: legacyRegistry,
        workspaceId: ws.workspaceId,
        nodeId: 'legacy_adapter_broker',
        socket: sock,
        raw: JSON.stringify(frame),
      });

      await send({
        v: 1,
        id: 'legacy-node-register',
        type: 'node.register',
        name: 'legacy-adapter-broker',
        node_id: 'legacy_adapter_broker',
        capabilities: [capability('relay:delivery-cursor-v1', 'capacity')],
        max_agents: 4,
        tags: ['control'],
        version: 'control-v1',
        resume_cursor: null,
      });
      expect(sock.ofType('reply').at(-1)).toMatchObject({
        data: {
          accepted_capabilities: [expect.objectContaining({
            name: 'relay:delivery-cursor-v1',
            accepted: false,
            reason: 'delivery_readiness_unsupported',
          })],
        },
      });

      await send({
        v: 1,
        id: 'legacy-agent-register',
        type: 'agent.register',
        name: 'legacy-worker',
        session_ref: 'pty://legacy/worker',
        resumable: true,
      });
      const reply = sock.ofType('reply').at(-1) as { data?: Record<string, unknown> };
      expect(reply.data).not.toHaveProperty('delivery_ack_seq');
    });

    it('enforces node capacity for agents registered over node control', async () => {
      const ws = await createWorkspace(stack.app, 'fleet-agent-register-capacity');
      const alpha = await enrollAndAttachNode(ws, {
        id: 'node_capacity_one',
        name: 'capacity-one',
        capabilities: [capability('spawn:claude', 'spawn')],
        maxAgents: 1,
      });

      await alpha.handle.handleMessage(JSON.stringify({
        v: 1,
        id: 'agent-register-1',
        type: 'agent.register',
        name: 'worker-one',
        session_ref: 'pty://alpha/worker-one',
      }));
      expect(alpha.sock.ofType('reply').at(-1)).toMatchObject({
        id: 'agent-register-1',
        ok: true,
      });

      await alpha.handle.handleMessage(JSON.stringify({
        v: 1,
        id: 'agent-register-2',
        type: 'agent.register',
        name: 'worker-two',
        session_ref: 'pty://alpha/worker-two',
      }));
      expect(alpha.sock.ofType('error').at(-1)).toMatchObject({
        id: 'agent-register-2',
        code: 'node_capacity_exceeded',
      });

      const [node] = await stack.runtime.handle.db
        .select({ activeAgents: nodes.activeAgents })
        .from(nodes)
        .where(and(eq(nodes.workspaceId, ws.workspaceId), eq(nodes.id, 'node_capacity_one')));
      expect(node?.activeAgents).toBe(1);
    });

    it('registers a node, dispatches spawn, completes from action.result, fires triggers, and reschedules on node death', async () => {
      const ws = await createWorkspace(stack.app, 'fleet-node-ws');
      const caller = await registerAgent(stack.app, ws.workspaceKey, 'caller');

      const alpha = await enrollAndAttachNode(ws, {
        id: 'node_alpha',
        name: 'alpha',
        capabilities: [capability('spawn:claude', 'spawn', { agent: 'claude' }), capability('echo', 'tool')],
        load: 0,
      });

      const spawn = await stack.app.request('/v1/actions/spawn/invoke', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${caller.token}` },
        body: JSON.stringify({ input: { cli: 'claude', name: 'worker-1', task: 'say hi' } }),
      });
      expect(spawn.status).toBe(201);
      const spawnBody = await spawn.json() as { data: { invocation_id: string } };
      const spawnInvoke = alpha.sock.ofType('action.invoke').at(-1);
      expect(spawnInvoke).toMatchObject({
        invocation_id: spawnBody.data.invocation_id,
        action: 'spawn:claude',
      });

      const blockedCompletion = await stack.app.request(`/v1/actions/spawn/invocations/${spawnBody.data.invocation_id}/complete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${caller.token}` },
        body: JSON.stringify({ output: { agent: 'should-be-rejected' } }),
      });
      expect(blockedCompletion.status).toBe(403);

      await alpha.handle.handleMessage(JSON.stringify({
        v: 1,
        type: 'inventory.sync',
        agents: [
          {
            agent_id: 'agt_worker_1',
            name: 'worker-1',
            invocation_id: spawnBody.data.invocation_id,
            session_ref: 'pty://alpha/sessions/worker-1',
          },
        ],
      }));

      const spawnAfterInventory = await stack.app.request(`/v1/actions/spawn/invocations/${spawnBody.data.invocation_id}`, {
        headers: { authorization: `Bearer ${caller.token}` },
      });
      expect(spawnAfterInventory.status).toBe(200);
      expect(((await spawnAfterInventory.json()) as { data: { status: string } }).data.status).toBe('completed');

      await alpha.handle.handleMessage(JSON.stringify({
        v: 1,
        type: 'action.result',
        invocation_id: spawnBody.data.invocation_id,
        output: { agent: 'worker-1', token: 'at_live_child' },
      }));

      const spawnStatus = await stack.app.request(`/v1/actions/spawn/invocations/${spawnBody.data.invocation_id}`, {
        headers: { authorization: `Bearer ${caller.token}` },
      });
      expect(spawnStatus.status).toBe(200);
      expect(((await spawnStatus.json()) as { data: { status: string } }).data.status).toBe('completed');

      const echoScalar = await stack.app.request('/v1/actions/echo/invoke', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${caller.token}` },
        body: JSON.stringify({ input: { value: 'scalar' } }),
      });
      expect(echoScalar.status).toBe(201);
      const echoScalarBody = await echoScalar.json() as { data: { invocation_id: string } };
      await alpha.handle.handleMessage(JSON.stringify({
        v: 1,
        type: 'action.result',
        invocation_id: echoScalarBody.data.invocation_id,
        output: 'ok',
      }));
      const echoScalarStatus = await stack.app.request(`/v1/actions/echo/invocations/${echoScalarBody.data.invocation_id}`, {
        headers: { authorization: `Bearer ${caller.token}` },
      });
      expect((await echoScalarStatus.json() as { data: { output: unknown } }).data.output).toBe('ok');

      const echoArray = await stack.app.request('/v1/actions/echo/invoke', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${caller.token}` },
        body: JSON.stringify({ input: { value: 'array' } }),
      });
      expect(echoArray.status).toBe(201);
      const echoArrayBody = await echoArray.json() as { data: { invocation_id: string } };
      await alpha.handle.handleMessage(JSON.stringify({
        v: 1,
        type: 'action.result',
        invocation_id: echoArrayBody.data.invocation_id,
        output: ['a', 1, null],
      }));
      const echoArrayStatus = await stack.app.request(`/v1/actions/echo/invocations/${echoArrayBody.data.invocation_id}`, {
        headers: { authorization: `Bearer ${caller.token}` },
      });
      expect((await echoArrayStatus.json() as { data: { output: unknown } }).data.output).toEqual(['a', 1, null]);

      const echoNull = await stack.app.request('/v1/actions/echo/invoke', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${caller.token}` },
        body: JSON.stringify({ input: { value: 'null' } }),
      });
      expect(echoNull.status).toBe(201);
      const echoNullBody = await echoNull.json() as { data: { invocation_id: string } };
      await alpha.handle.handleMessage(JSON.stringify({
        v: 1,
        type: 'action.result',
        invocation_id: echoNullBody.data.invocation_id,
        output: null,
      }));
      const echoNullStatus = await stack.app.request(`/v1/actions/echo/invocations/${echoNullBody.data.invocation_id}`, {
        headers: { authorization: `Bearer ${caller.token}` },
      });
      expect((await echoNullStatus.json() as { data: { output: unknown } }).data.output).toBeNull();

      const roster = await stack.app.request('/v1/nodes?capability=spawn%3Aclaude', {
        headers: { authorization: `Bearer ${ws.workspaceKey}` },
      });
      expect(roster.status).toBe(200);
      const rosterBody = await roster.json() as { data: Array<{ name: string; live: boolean; handlers_live: boolean }> };
      expect(rosterBody.data).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'alpha', live: true, handlers_live: true }),
      ]));

      const trigger = await stack.app.request('/v1/triggers', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
        body: JSON.stringify({ channel: 'general', pattern: 'ship', action_name: 'echo' }),
      });
      expect(trigger.status).toBe(201);

      const post = await stack.app.request('/v1/channels/general/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${caller.token}` },
        body: JSON.stringify({ text: 'ship it' }),
      });
      expect(post.status).toBe(201);
      await new Promise((r) => setTimeout(r, 75));
      const triggerInvoke = alpha.sock.ofType('action.invoke').find((event) => event.action === 'echo');
      expect(triggerInvoke).toMatchObject({ action: 'echo' });

      const beta = await enrollAndAttachNode(ws, {
        id: 'node_beta',
        name: 'beta',
        capabilities: [capability('echo', 'tool')],
        load: 0,
      });

      await alpha.handle.handleMessage(JSON.stringify({
        v: 1,
        type: 'agent.register',
        name: 'claimed-agent',
        session_ref: 'pty://alpha/sessions/claimed-agent',
        resumable: true,
      }));
      expect(alpha.sock.ofType('reply').at(-1)).toMatchObject({
        ok: true,
        data: expect.objectContaining({ name: 'claimed-agent' }),
      });

      beta.sock.received.length = 0;
      await beta.handle.handleMessage(JSON.stringify({
        v: 1,
        type: 'inventory.sync',
        agents: [
          {
            agent_id: 'agt_conflict',
            name: 'claimed-agent',
            session_ref: 'pty://beta/sessions/claimed-agent',
          },
        ],
      }));
      expect(beta.sock.ofType('error').at(-1)).toMatchObject({
        code: 'agent_location_conflict',
      });

      const worker = await stack.runtime.handle.db
        .select({
          locationNodeId: agents.locationNodeId,
          locationType: agents.locationType,
          status: agents.status,
        })
        .from(agents)
        .where(and(eq(agents.workspaceId, ws.workspaceId), eq(agents.name, 'claimed-agent')))
        .then((rows) => rows[0]);
      expect(worker).toMatchObject({
        locationNodeId: 'node_alpha',
        locationType: 'via_node',
        status: 'active',
      });

      const echo = await stack.app.request('/v1/actions/echo/invoke', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${caller.token}` },
        body: JSON.stringify({ input: { value: 'reschedule me' } }),
      });
      expect(echo.status).toBe(201);
      const echoBody = await echo.json() as { data: { invocation_id: string } };
      expect(alpha.sock.ofType('action.invoke').at(-1)).toMatchObject({
        invocation_id: echoBody.data.invocation_id,
        action: 'echo',
      });

      await alpha.handle.handleClose();
      await new Promise((r) => setTimeout(r, 25));
      expect(beta.sock.ofType('action.invoke').at(-1)).toMatchObject({
        invocation_id: echoBody.data.invocation_id,
        action: 'echo',
      });

      await beta.handle.handleMessage(JSON.stringify({
        v: 1,
        type: 'action.result',
        invocation_id: echoBody.data.invocation_id,
        output: { winner: 'beta' },
      }));
      await alpha.handle.handleMessage(JSON.stringify({
        v: 1,
        type: 'action.result',
        invocation_id: echoBody.data.invocation_id,
        output: { winner: 'alpha-late' },
      }));

      const echoStatus = await stack.app.request(`/v1/actions/echo/invocations/${echoBody.data.invocation_id}`, {
        headers: { authorization: `Bearer ${caller.token}` },
      });
      expect(echoStatus.status).toBe(200);
      expect(((await echoStatus.json()) as {
        data: { status: string; output: { winner: string } };
      }).data).toMatchObject({
        status: 'completed',
        output: { winner: 'beta' },
      });
    });

    it('REST disconnect deregisters a node-hosted agent without a node socket', async () => {
      const ws = await createWorkspace(stack.app, 'agent-disconnect-helper-ws');
      const db = stack.runtime.handle.db;
      const alpha = await enrollAndAttachNode(ws, {
        id: 'node_disconnect_alpha',
        name: 'disconnect-alpha',
        capabilities: [],
        maxAgents: 1,
      });

      await alpha.handle.handleMessage(JSON.stringify({
        v: 1,
        id: 'agent-register-disconnect',
        type: 'agent.register',
        name: 'disconnect-worker',
        session_ref: 'pty://disconnect/worker',
      }));
      const reply = alpha.sock.ofType('reply').find((frame) => frame.id === 'agent-register-disconnect') as {
        data?: { agent_id?: string; token?: string };
      };
      const agentId = reply.data?.agent_id ?? '';
      expect(agentId.length).toBeGreaterThan(0);

      const beforeNode = await db
        .select({ activeAgents: nodes.activeAgents })
        .from(nodes)
        .where(and(eq(nodes.workspaceId, ws.workspaceId), eq(nodes.id, 'node_disconnect_alpha')))
        .then((rows) => rows[0]);
      expect(beforeNode?.activeAgents).toBe(1);

      const disconnect = await stack.app.request('/v1/agents/disconnect', {
        method: 'POST',
        headers: { authorization: `Bearer ${reply.data?.token ?? ''}` },
      });
      expect(disconnect.status).toBe(200);

      const worker = await db
        .select({
          status: agents.status,
          locationType: agents.locationType,
          locationNodeId: agents.locationNodeId,
        })
        .from(agents)
        .where(and(eq(agents.workspaceId, ws.workspaceId), eq(agents.id, agentId)))
        .then((rows) => rows[0]);
      const directNodeId = `node_direct_${agentId}`;
      expect(worker).toMatchObject({
        status: 'offline',
        locationType: 'via_node',
        locationNodeId: directNodeId,
      });

      const activeBindings = await db
        .select({ nodeId: agentNodeBindings.nodeId })
        .from(agentNodeBindings)
        .where(and(
          eq(agentNodeBindings.workspaceId, ws.workspaceId),
          eq(agentNodeBindings.agentId, agentId),
          eq(agentNodeBindings.status, 'active'),
        ));
      expect(activeBindings).toEqual([{ nodeId: directNodeId }]);

      const inactiveAlphaBindings = await db
        .select({ id: agentNodeBindings.id })
        .from(agentNodeBindings)
        .where(and(
          eq(agentNodeBindings.workspaceId, ws.workspaceId),
          eq(agentNodeBindings.agentId, agentId),
          eq(agentNodeBindings.nodeId, 'node_disconnect_alpha'),
          eq(agentNodeBindings.status, 'inactive'),
        ));
      expect(inactiveAlphaBindings).toHaveLength(1);

      const alphaNode = await db
        .select({
          id: nodes.id,
          activeAgents: nodes.activeAgents,
        })
        .from(nodes)
        .where(and(eq(nodes.workspaceId, ws.workspaceId), eq(nodes.id, 'node_disconnect_alpha')))
        .then((rows) => rows[0]);
      expect(alphaNode).toMatchObject({
        id: 'node_disconnect_alpha',
        activeAgents: 0,
      });

      const directNode = await db
        .select({
          id: nodes.id,
          status: nodes.status,
          activeAgents: nodes.activeAgents,
        })
        .from(nodes)
        .where(and(eq(nodes.workspaceId, ws.workspaceId), eq(nodes.id, directNodeId)))
        .then((rows) => rows[0]);
      expect(directNode).toMatchObject({
        id: directNodeId,
        status: 'offline',
        activeAgents: 1,
      });
    });

    it('drains an offline-queued invoke into dispatched state so the timeout sweep reschedules it', async () => {
      const ws = await createWorkspace(stack.app, 'fleet-drain-ws');
      const caller = await registerAgent(stack.app, ws.workspaceKey, 'caller');

      // alpha owns the `echo` action; beta is a live fallback handler.
      const alpha = await enrollAndAttachNode(ws, {
        id: 'node_alpha',
        name: 'alpha',
        capabilities: [capability('echo', 'tool')],
        load: 0,
      });
      const beta = await enrollAndAttachNode(ws, {
        id: 'node_beta',
        name: 'beta',
        capabilities: [capability('echo', 'tool')],
        load: 0,
      });

      // Take alpha offline so the next invoke can only be queued, not delivered.
      await alpha.handle.handleClose();

      const echo = await stack.app.request('/v1/actions/echo/invoke', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${caller.token}` },
        body: JSON.stringify({ input: { value: 'drain me' } }),
      });
      expect(echo.status).toBe(201);
      const invocationId = (await echo.json() as { data: { invocation_id: string } }).data.invocation_id;

      const db = stack.runtime.handle.db;
      const queued = await db
        .select()
        .from(actionInvocations)
        .where(eq(actionInvocations.id, invocationId))
        .then((rows) => rows[0]);
      // Queued for the offline node: pending, no dispatch timestamp yet.
      expect(queued).toMatchObject({ status: 'pending', dispatchedNodeId: 'node_alpha' });
      expect(queued.dispatchedAt).toBeNull();
      expect(queued.dispatchAttempts).toBe(1);
      expect(queued.attemptedNodeIds).toEqual(['node_alpha']);

      // alpha reconnects → the queued frame drains and the invocation moves to
      // dispatched via the shared transition (dispatched_at + retry_after_at set).
      const alphaSock = new FakeSocket();
      stack.runtime.realtime.attachNodeSocket(ws.workspaceId, 'node_alpha', alphaSock);
      await new Promise((r) => setTimeout(r, 25));
      expect(alphaSock.ofType('action.invoke').at(-1)).toMatchObject({ invocation_id: invocationId, action: 'echo' });

      const drained = await db
        .select()
        .from(actionInvocations)
        .where(eq(actionInvocations.id, invocationId))
        .then((rows) => rows[0]);
      expect(drained.status).toBe('dispatched');
      expect(drained.dispatchedAt).toBeInstanceOf(Date);
      expect(drained.retryAfterAt).toBeInstanceOf(Date);
      expect(drained.dispatchAttempts).toBe(1);
      expect(drained.attemptedNodeIds).toEqual(['node_alpha']);

      // With the invocation now in dispatched state, the dispatch-timeout sweep
      // (timeout 0 ⇒ already overdue) reschedules it onto the live fallback node.
      beta.sock.received.length = 0;
      const rescheduled = await sweepTimedOutInvocations(db, stack.runtime.realtime, { timeoutMs: 0 });
      expect(rescheduled).toBeGreaterThanOrEqual(1);
      expect(beta.sock.ofType('action.invoke').at(-1)).toMatchObject({ invocation_id: invocationId, action: 'echo' });
    });

    it('exported drain helper dispatches pending handler-agent invocations with v5 agent fields', async () => {
      const ws = await createWorkspace(stack.app, 'fleet-agent-drain-helper-ws');
      const caller = await registerAgent(stack.app, ws.workspaceKey, 'caller');
      const alpha = await enrollAndAttachNode(ws, {
        id: 'node_alpha',
        name: 'alpha',
        capabilities: [],
        load: 0,
      });

      await alpha.handle.handleMessage(JSON.stringify({
        v: 1,
        id: 'agent-register-drain-helper',
        type: 'agent.register',
        name: 'handler',
        session_ref: 'pty://alpha/handler',
      }));
      const agentReply = alpha.sock.ofType('reply').find((frame) => frame.id === 'agent-register-drain-helper') as {
        data?: { agent_id?: string };
      };
      const handlerAgentId = agentReply.data?.agent_id ?? '';
      expect(handlerAgentId.length).toBeGreaterThan(0);

      const register = await stack.app.request('/v1/actions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
        body: JSON.stringify({
          name: 'agent-echo',
          description: 'handler-agent drain test',
          handler_agent: 'handler',
        }),
      });
      expect(register.status).toBe(201);

      const db = stack.runtime.handle.db;
      const action = await db
        .select({ id: actions.id })
        .from(actions)
        .where(and(eq(actions.workspaceId, ws.workspaceId), eq(actions.name, 'agent-echo')))
        .then((rows) => rows[0]);
      expect(action?.id).toBeTruthy();

      const invocationId = 'inv_agent_drain_helper';
      await db.insert(actionInvocations).values({
        id: invocationId,
        workspaceId: ws.workspaceId,
        actionId: action!.id,
        actionName: 'agent-echo',
        callerId: caller.agentId,
        callerName: caller.name,
        input: { value: 'from-db' },
        status: 'pending',
      });

      alpha.sock.received.length = 0;
      const drained = await drainNodeInvocations(db, stack.runtime.realtime, ws.workspaceId, 'node_alpha');
      expect(drained).toBe(1);
      expect(alpha.sock.ofType('action.invoke').at(-1)).toMatchObject({
        invocation_id: invocationId,
        action: 'agent-echo',
        agent_id: handlerAgentId,
        agent_name: 'handler',
        input: { value: 'from-db' },
      });

      const updated = await db
        .select()
        .from(actionInvocations)
        .where(eq(actionInvocations.id, invocationId))
        .then((rows) => rows[0]);
      expect(updated).toMatchObject({
        status: 'dispatched',
        dispatchedNodeId: 'node_alpha',
        dispatchAttempts: 1,
      });
      expect(updated.dispatchedAt).toBeInstanceOf(Date);
      expect(updated.attemptedNodeIds).toEqual(['node_alpha']);
    });

    it('exported drain helper preserves spawn-prefixed actions and skips retry-delayed invocations', async () => {
      const ws = await createWorkspace(stack.app, 'fleet-spawn-prefix-drain-helper-ws');
      const caller = await registerAgent(stack.app, ws.workspaceKey, 'caller');
      const alpha = await enrollAndAttachNode(ws, {
        id: 'node_alpha',
        name: 'alpha',
        capabilities: [capability('spawn:python', 'spawn', { agent: 'python' })],
        load: 0,
      });

      const db = stack.runtime.handle.db;
      const retryLater = new Date(Date.now() + 60_000);
      await db.insert(actionInvocations).values([
        {
          id: 'inv_spawn_prefixed_drain',
          workspaceId: ws.workspaceId,
          actionName: 'spawn:python',
          callerId: caller.agentId,
          callerName: caller.name,
          input: { cli: 'python', name: 'worker-prefix', task: 'hi' },
          status: 'pending',
          dispatchedNodeId: 'node_alpha',
          attemptedNodeIds: ['node_alpha'],
          dispatchAttempts: 1,
        },
        {
          id: 'inv_spawn_future_retry',
          workspaceId: ws.workspaceId,
          actionName: 'spawn:python',
          callerId: caller.agentId,
          callerName: caller.name,
          input: { cli: 'python', name: 'worker-later', task: 'wait' },
          status: 'pending',
          dispatchedNodeId: 'node_alpha',
          attemptedNodeIds: ['node_alpha'],
          dispatchAttempts: 1,
          retryAfterAt: retryLater,
        },
      ]);

      alpha.sock.received.length = 0;
      const drained = await drainNodeInvocations(db, stack.runtime.realtime, ws.workspaceId, 'node_alpha');
      expect(drained).toBe(1);
      expect(alpha.sock.ofType('action.invoke')).toEqual([
        expect.objectContaining({
          invocation_id: 'inv_spawn_prefixed_drain',
          action: 'spawn:python',
          input: expect.objectContaining({ cli: 'python' }),
        }),
      ]);

      const prefixed = await db
        .select()
        .from(actionInvocations)
        .where(eq(actionInvocations.id, 'inv_spawn_prefixed_drain'))
        .then((rows) => rows[0]);
      expect(prefixed.status).toBe('dispatched');
      expect(prefixed.dispatchAttempts).toBe(1);
      expect(prefixed.attemptedNodeIds).toEqual(['node_alpha']);

      const delayed = await db
        .select()
        .from(actionInvocations)
        .where(eq(actionInvocations.id, 'inv_spawn_future_retry'))
        .then((rows) => rows[0]);
      expect(delayed.status).toBe('pending');
      expect(delayed.dispatchedAt).toBeNull();
      expect(delayed.spawnReservedAt).toBeNull();
      expect(delayed.retryAfterAt).toBeInstanceOf(Date);
      expect(delayed.retryAfterAt!.getTime()).toBeGreaterThan(Date.now());
    });

    it('exported drain helper releases spawn capacity when redispatch is rejected', async () => {
      const ws = await createWorkspace(stack.app, 'fleet-spawn-drain-reject-ws');
      const caller = await registerAgent(stack.app, ws.workspaceKey, 'caller');
      await enrollAndAttachNode(ws, {
        id: 'node_alpha',
        name: 'alpha',
        capabilities: [capability('spawn:python', 'spawn', { agent: 'python' })],
        load: 0,
        maxAgents: 1,
      });

      const db = stack.runtime.handle.db;
      await db.insert(actionInvocations).values({
        id: 'inv_spawn_rejected_drain',
        workspaceId: ws.workspaceId,
        actionName: 'spawn:python',
        callerId: caller.agentId,
        callerName: caller.name,
        input: { cli: 'python', name: 'worker-rejected', task: 'hi' },
        status: 'pending',
        dispatchedNodeId: 'node_alpha',
        attemptedNodeIds: ['node_alpha'],
        dispatchAttempts: 1,
      });

      const rejectingRegistry: NodeConnectionRegistry = {
        upgradeNode: async () => new Response(null, { status: 501 }),
        sendToNode: async () => false,
        sendToProvider: async () => false,
        isNodeConnected: () => true,
        isProviderConnected: () => true,
        setProviderDeliveryReadiness: () => {},
        markProviderAgentsDeliveryReady: () => {},
        isProviderAgentDeliveryReady: () => true,
        detachProvider: () => {},
        disconnectNode: async () => {},
        drainNode: async () => {},
      };

      const drained = await drainNodeInvocations(db, rejectingRegistry, ws.workspaceId, 'node_alpha');
      expect(drained).toBe(0);

      const node = await db
        .select({ reservedAgents: nodes.reservedAgents })
        .from(nodes)
        .where(and(eq(nodes.workspaceId, ws.workspaceId), eq(nodes.id, 'node_alpha')))
        .then((rows) => rows[0]);
      expect(node.reservedAgents ?? 0).toBe(0);

      const invocation = await db
        .select()
        .from(actionInvocations)
        .where(eq(actionInvocations.id, 'inv_spawn_rejected_drain'))
        .then((rows) => rows[0]);
      expect(invocation.status).toBe('pending');
      expect(invocation.spawnReservedAt).toBeNull();
      expect(invocation.dispatchedAt).toBeNull();
      expect(invocation.dispatchAttempts).toBe(1);
      expect(invocation.attemptedNodeIds).toEqual(['node_alpha']);
    });

    it('drains a queued spawn once the node registers without delaying the register-time drain', async () => {
      const ws = await createWorkspace(stack.app, 'fleet-spawn-drain-ws');
      const caller = await registerAgent(stack.app, ws.workspaceKey, 'caller');

      const alpha = await enrollAndAttachNode(ws, {
        id: 'node_alpha',
        name: 'alpha',
        capabilities: [capability('spawn:claude', 'spawn', { agent: 'claude' })],
        load: 0,
      });

      // Take alpha offline so a targeted spawn can only queue (not dispatch).
      await alpha.handle.handleClose();

      const spawn = await stack.app.request('/v1/actions/spawn/invoke', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${caller.token}` },
        body: JSON.stringify({ input: { cli: 'claude', name: 'worker-drain', task: 'hi', target_node: 'alpha' } }),
      });
      expect(spawn.status).toBe(201);
      const invocationId = (await spawn.json() as { data: { invocation_id: string } }).data.invocation_id;

      const db = stack.runtime.handle.db;
      const queued = await db
        .select()
        .from(actionInvocations)
        .where(eq(actionInvocations.id, invocationId))
        .then((rows) => rows[0]);
      expect(queued).toMatchObject({ status: 'pending', dispatchedNodeId: 'node_alpha' });
      expect(queued.spawnReservedAt).toBeNull();

      // Reconnect the socket but DO NOT register yet: the node is still offline,
      // so the drain can't reserve spawn capacity. It must keep the frame queued
      // without arming retry_after_at so node.register can drain immediately.
      const alphaSock = new FakeSocket();
      const alphaHandle = stack.runtime.realtime.attachNodeSocket(ws.workspaceId, 'node_alpha', alphaSock);
      await new Promise((r) => setTimeout(r, 25));
      expect(alphaSock.ofType('action.invoke')).toHaveLength(0);
      const stillQueued = await db
        .select()
        .from(actionInvocations)
        .where(eq(actionInvocations.id, invocationId))
        .then((rows) => rows[0]);
      expect(stillQueued.status).toBe('pending');
      expect(stillQueued.spawnReservedAt).toBeNull();
      expect(stillQueued.retryAfterAt).toBeNull();

      // Register → node is marked online and the post-register drain reserves
      // capacity and dispatches the queued spawn with the same invocation id.
      await alphaHandle.handleMessage(JSON.stringify({
        v: 1,
        id: 'reg-reconnect',
        type: 'node.register',
        name: 'alpha',
        node_id: 'node_alpha',
        capabilities: [capability('spawn:claude', 'spawn', { agent: 'claude' })],
        max_agents: 4,
        tags: ['test'],
        version: 'test-node',
        resume_cursor: null,
      }));

      expect(alphaSock.ofType('action.invoke').at(-1)).toMatchObject({ invocation_id: invocationId, action: 'spawn:claude' });
      const dispatched = await db
        .select()
        .from(actionInvocations)
        .where(eq(actionInvocations.id, invocationId))
        .then((rows) => rows[0]);
      expect(dispatched.status).toBe('dispatched');
      expect(dispatched.dispatchedAt).toBeInstanceOf(Date);
      expect(dispatched.spawnReservedAt).toBeInstanceOf(Date);

      const node = await db
        .select()
        .from(nodes)
        .where(eq(nodes.id, 'node_alpha'))
        .then((rows) => rows[0]);
      expect(node.reservedAgents ?? 0).toBeGreaterThanOrEqual(1);
    });

    it('reserves spawn capacity atomically across concurrent invocations', async () => {
      const ws = await createWorkspace(stack.app, 'fleet-node-capacity-ws');
      const caller = await registerAgent(stack.app, ws.workspaceKey, 'caller');

      const alpha = await enrollAndAttachNode(ws, {
        id: 'node_alpha',
        name: 'alpha',
        capabilities: [capability('spawn:claude', 'spawn', { agent: 'claude' })],
        load: 0,
        maxAgents: 1,
      });

      const beta = await enrollAndAttachNode(ws, {
        id: 'node_beta',
        name: 'beta',
        capabilities: [capability('spawn:claude', 'spawn', { agent: 'claude' })],
        load: 0,
        maxAgents: 1,
      });

      const [first, second] = await Promise.all([
        stack.app.request('/v1/actions/spawn/invoke', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${caller.token}` },
          body: JSON.stringify({ input: { cli: 'claude', name: 'worker-a', task: 'one' } }),
        }),
        stack.app.request('/v1/actions/spawn/invoke', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${caller.token}` },
          body: JSON.stringify({ input: { cli: 'claude', name: 'worker-b', task: 'two' } }),
        }),
      ]);

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      const spawnNodes = [await first.json(), await second.json()] as Array<{ data: { handler_node_id: string } }>;
      expect(new Set(spawnNodes.map((entry) => entry.data.handler_node_id))).toEqual(new Set(['node_alpha', 'node_beta']));
      expect(alpha.sock.ofType('action.invoke').filter((event) => event.action.startsWith('spawn')).length).toBe(1);
      expect(beta.sock.ofType('action.invoke').filter((event) => event.action.startsWith('spawn')).length).toBe(1);
    });

    it('fires a trigger only once when concurrent posts match the same rate-limited trigger', async () => {
      const ws = await createWorkspace(stack.app, 'fleet-trigger-ws');
      const caller = await registerAgent(stack.app, ws.workspaceKey, 'caller');

      const alpha = await enrollAndAttachNode(ws, {
        id: 'node_alpha',
        name: 'alpha',
        capabilities: [capability('echo', 'tool')],
        load: 0,
      });

      const trigger = await stack.app.request('/v1/triggers', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
        body: JSON.stringify({ channel: 'general', pattern: 'ship', action_name: 'echo' }),
      });
      expect(trigger.status).toBe(201);

      await Promise.all([
        stack.app.request('/v1/channels/general/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${caller.token}` },
          body: JSON.stringify({ text: 'ship it once' }),
        }),
        stack.app.request('/v1/channels/general/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${caller.token}` },
          body: JSON.stringify({ text: 'ship it twice' }),
        }),
      ]);

      await new Promise((r) => setTimeout(r, 75));
      const triggerInvokes = alpha.sock.ofType('action.invoke').filter((event) => event.action === 'echo');
      expect(triggerInvokes).toHaveLength(1);
    });

    it('refreshes the node roster snapshot from a roster-carrying heartbeat and stamps receipt time server-side', async () => {
      const ws = await createWorkspace(stack.app, 'fleet-heartbeat-roster-ws');

      const alpha = await enrollAndAttachNode(ws, {
        id: 'node_alpha',
        name: 'alpha',
        capabilities: [capability('spawn:claude', 'spawn', { agent: 'claude' })],
        maxAgents: 4,
      });

      // enrollAndAttachNode intentionally provokes one error frame (a bad
      // node.register), so baseline from the current count.
      const errorsBefore = alpha.sock.ofType('error').length;
      // lastHeartbeatAt is persisted at second granularity (unixepoch), so floor
      // the baseline to the second to compare against the server stamp.
      const before = Math.floor(Date.now() / 1000) * 1000;
      // Roster-carrying heartbeat: a new capability appears, capacity grows, and
      // the version bumps. The engine must adopt these from the heartbeat without
      // a fresh node.register, and must ignore any broker-sent last_heartbeat_at
      // in favor of its own server stamp.
      await alpha.handle.handleMessage(JSON.stringify({
        v: 1,
        type: 'node.heartbeat',
        load: 0.5,
        active_agents: 1,
        handlers_live: true,
        node_id: 'node_alpha',
        name: 'alpha',
        capabilities: [
          capability('spawn:claude', 'spawn', { agent: 'claude' }),
          capability('echo', 'tool'),
        ],
        max_agents: 8,
        version: 'test-node-v2',
      }));

      // No new error frame from the strict schema: the roster fields are accepted.
      expect(alpha.sock.ofType('error')).toHaveLength(errorsBefore);

      const [node] = await stack.runtime.handle.db
        .select()
        .from(nodes)
        .where(and(eq(nodes.workspaceId, ws.workspaceId), eq(nodes.id, 'node_alpha')));
      expect(node).toBeDefined();
      expect(node.maxAgents).toBe(8);
      expect(node.version).toBe('test-node-v2');
      expect(node.load).toBe(0.5);
      expect(node.activeAgents).toBe(1);
      expect(node.capabilities.map((cap) => cap.name).sort()).toEqual(['echo', 'spawn:claude']);
      // Receipt time is stamped server-side, not trusted from the wire.
      expect(node.lastHeartbeatAt?.getTime()).toBeGreaterThanOrEqual(before);

      // The newly-advertised capability became a node-handled action.
      const echoAction = await stack.app.request('/v1/nodes?capability=echo', {
        headers: { authorization: `Bearer ${ws.workspaceKey}` },
      });
      expect(echoAction.status).toBe(200);
      const echoBody = await echoAction.json() as { data: Array<{ id: string }> };
      expect(echoBody.data.map((n) => n.id)).toContain('node_alpha');

      // A roster_id mismatch on the heartbeat is rejected like node.register.
      await alpha.handle.handleMessage(JSON.stringify({
        v: 1,
        id: 'heartbeat-bad-node-id',
        type: 'node.heartbeat',
        load: 0,
        active_agents: 0,
        handlers_live: true,
        node_id: 'wrong-node',
      }));
      expect(alpha.sock.ofType('error').at(-1)).toMatchObject({
        id: 'heartbeat-bad-node-id',
        ok: false,
        code: 'node_id_mismatch',
      });

      // A minimal heartbeat (no roster) remains valid and preserves the roster.
      await alpha.handle.handleMessage(JSON.stringify({
        v: 1,
        type: 'node.heartbeat',
        load: 0.1,
        active_agents: 0,
        handlers_live: true,
      }));
      const [stillNode] = await stack.runtime.handle.db
        .select()
        .from(nodes)
        .where(and(eq(nodes.workspaceId, ws.workspaceId), eq(nodes.id, 'node_alpha')));
      expect(stillNode.maxAgents).toBe(8);
      expect(stillNode.version).toBe('test-node-v2');
      expect(stillNode.capabilities.map((cap) => cap.name).sort()).toEqual(['echo', 'spawn:claude']);
    });

    it('publishes action.invoked to the workspace observer stream', async () => {
      const ws = await createWorkspace(stack.app, 'fleet-action-invoked-observer-ws');
      const caller = await registerAgent(stack.app, ws.workspaceKey, 'caller');
      await enrollAndAttachNode(ws, {
        id: 'node_alpha',
        name: 'alpha',
        capabilities: [capability('spawn:claude', 'spawn', { agent: 'claude' })],
        load: 0,
      });

      // Observer dashboards watch the workspace stream; they should see the
      // invocation as it happens, not just its eventual completion.
      const observerSock = new FakeSocket();
      stack.runtime.realtime.attachWorkspaceSocket(ws.workspaceId, observerSock);

      const spawn = await stack.app.request('/v1/actions/spawn/invoke', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${caller.token}` },
        body: JSON.stringify({ input: { cli: 'claude', name: 'observed-worker', task: 'hi', target_node: 'alpha' } }),
      });
      expect(spawn.status).toBe(201);
      const invocationId = (await spawn.json() as { data: { invocation_id: string } }).data.invocation_id;

      // Fanout to the workspace stream runs in the request background
      // lifecycle (best-effort in tests), so poll rather than fixed-sleep.
      let invoked = observerSock.ofType('action.invoked');
      for (let i = 0; i < 20 && invoked.length === 0; i += 1) {
        await new Promise((r) => setTimeout(r, 5));
        invoked = observerSock.ofType('action.invoked');
      }
      expect(invoked).toHaveLength(1);
      expect(invoked[0]).toMatchObject({
        type: 'action.invoked',
        invocation_id: invocationId,
        action_name: 'spawn',
        caller_name: 'caller',
      });
    });
  });

  describe('node enrollment identity', () => {
    async function enroll(workspaceKey: string, body: Record<string, unknown>) {
      const res = await stack.app.request('/v1/nodes', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${workspaceKey}` },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() as { data?: { id: string; name: string; token: string }; error?: { code: string } } };
    }

    it('rejects enrolling a second node_id under an existing name instead of rewriting the other node', async () => {
      const ws = await createWorkspace(stack.app, 'enroll-name-conflict-ws');
      const first = await enroll(ws.workspaceKey, { node_id: 'node_a', name: 'host' });
      expect(first.status).toBe(201);

      const second = await enroll(ws.workspaceKey, { node_id: 'node_b', name: 'host' });
      expect(second.status).toBe(409);
      expect(second.body.error?.code).toBe('node_name_conflict');

      // Node A keeps its identity and token; node B was never created.
      const rows = await stack.runtime.deps.db
        .select()
        .from(nodes)
        .where(eq(nodes.workspaceId, ws.workspaceId));
      expect(rows.map((row) => row.id)).toEqual(['node_a']);
      expect(rows[0].name).toBe('host');
    });

    it('re-enrolling the same node_id rotates the token in place', async () => {
      const ws = await createWorkspace(stack.app, 'enroll-rotate-ws');
      const first = await enroll(ws.workspaceKey, { node_id: 'node_a', name: 'host', version: 'v1' });
      expect(first.status).toBe(201);

      const second = await enroll(ws.workspaceKey, { node_id: 'node_a', name: 'host', version: 'v2' });
      expect(second.status).toBe(201);
      expect(second.body.data?.id).toBe('node_a');
      expect(second.body.data?.token).not.toBe(first.body.data?.token);

      const rows = await stack.runtime.deps.db
        .select()
        .from(nodes)
        .where(eq(nodes.workspaceId, ws.workspaceId));
      expect(rows).toHaveLength(1);
      expect(rows[0].version).toBe('v2');
    });

    it('re-enrolling the same node_id under a new name renames the node', async () => {
      const ws = await createWorkspace(stack.app, 'enroll-rename-ws');
      const first = await enroll(ws.workspaceKey, { node_id: 'node_a', name: 'old-name' });
      expect(first.status).toBe(201);

      const renamed = await enroll(ws.workspaceKey, { node_id: 'node_a', name: 'new-name' });
      expect(renamed.status).toBe(201);
      expect(renamed.body.data?.id).toBe('node_a');
      expect(renamed.body.data?.name).toBe('new-name');

      const rows = await stack.runtime.deps.db
        .select()
        .from(nodes)
        .where(eq(nodes.workspaceId, ws.workspaceId));
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe('new-name');
    });

    it('rejects renaming a node onto a name held by a different node', async () => {
      const ws = await createWorkspace(stack.app, 'enroll-rename-conflict-ws');
      expect((await enroll(ws.workspaceKey, { node_id: 'node_a', name: 'alpha' })).status).toBe(201);
      expect((await enroll(ws.workspaceKey, { node_id: 'node_b', name: 'beta' })).status).toBe(201);

      const collide = await enroll(ws.workspaceKey, { node_id: 'node_b', name: 'alpha' });
      expect(collide.status).toBe(409);
      expect(collide.body.error?.code).toBe('node_name_conflict');
    });

    it('enrolling without node_id still rotates the existing node by name', async () => {
      const ws = await createWorkspace(stack.app, 'enroll-by-name-ws');
      const first = await enroll(ws.workspaceKey, { node_id: 'node_a', name: 'host' });
      expect(first.status).toBe(201);

      const rotated = await enroll(ws.workspaceKey, { name: 'host' });
      expect(rotated.status).toBe(201);
      expect(rotated.body.data?.id).toBe('node_a');
      expect(rotated.body.data?.token).not.toBe(first.body.data?.token);
    });
  });
});
