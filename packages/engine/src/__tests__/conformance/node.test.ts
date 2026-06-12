import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  makeNodeStack,
  createWorkspace,
  registerAgent,
  FakeSocket,
  type TestStack,
} from './harness.js';
import { agents } from '../../db/schema.js';

function capability(name: string, kind?: string, metadata?: Record<string, unknown>) {
  return { name, ...(kind ? { kind } : {}), ...(metadata ? { metadata } : {}) };
}

/**
 * Conformance suite for the in-process Node adapter. These assert the
 * parity-critical realtime invariants the Cloudflare DOs guarantee — sequence
 * monotonicity, mute filtering, resync (ring + DB gap-fill), presence sweep,
 * rate limiting, and force-disconnect — so the same suite
 * can later run against the DO adapter to prove cross-runtime parity.
 */
describe('node adapter conformance', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack({ ttlMs: 1_000 }); });
  afterEach(() => stack.close());

  describe('sequence monotonicity', () => {
    it('stamps strictly-increasing agent_seq under 100 concurrent pushes', async () => {
      const rt = stack.runtime.realtime;
      const results = await Promise.all(
        Array.from({ length: 100 }, (_, i) =>
          rt.pushToAgent('w1', 'a1', { type: 'message', n: i }),
        ),
      );
      const seqs = results.map((r) => r.agentSeq).sort((a, b) => a - b);
      expect(seqs).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
      expect(new Set(seqs).size).toBe(100); // no duplicates
    });

    it('stamps strictly-increasing channel_seq under concurrent broadcasts', async () => {
      const rt = stack.runtime.realtime;
      await rt.setChannelMembers('w1', 'c1', []); // no members → just sequence
      const results = await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          rt.broadcastToChannel({ workspaceId: 'w1', channelId: 'c1', event: { type: 'message', n: i } }),
        ),
      );
      const seqs = results.map((r) => r.channelSeq).sort((a, b) => a - b);
      expect(seqs).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    });
  });

  describe('mute filtering', () => {
    it('suppresses message events for muted members but delivers control events', async () => {
      const rt = stack.runtime.realtime;
      const aSock = new FakeSocket();
      const bSock = new FakeSocket();
      rt.attachAgentSocket('w1', 'a', aSock);
      rt.attachAgentSocket('w1', 'b', bSock);
      await rt.setChannelMembers('w1', 'c1', ['a', 'b']);
      await rt.setChannelMuted('w1', 'c1', ['b']);

      await rt.broadcastToChannel({ workspaceId: 'w1', channelId: 'c1', event: { type: 'message.created', text: 'hi' } });
      await rt.broadcastToChannel({ workspaceId: 'w1', channelId: 'c1', event: { type: 'channel.updated', topic: 't' } });

      // a (unmuted) gets both; b (muted) gets only the control event.
      expect(aSock.ofType('message.created')).toHaveLength(1);
      expect(aSock.ofType('channel.updated')).toHaveLength(1);
      expect(bSock.ofType('message.created')).toHaveLength(0);
      expect(bSock.ofType('channel.updated')).toHaveLength(1);
    });
  });

  describe('resync', () => {
    it('replays buffered events after last_seen_seq with no gap', async () => {
      const rt = stack.runtime.realtime;
      const sock = new FakeSocket();
      const handle = rt.attachAgentSocket('w1', 'a', sock);
      for (let i = 0; i < 5; i++) {
        await rt.pushToAgent('w1', 'a', { type: 'message', n: i });
      }
      sock.received.length = 0; // clear live deliveries

      await handle.handleMessage(JSON.stringify({ type: 'resync', last_seen_seq: 2 }));

      const replayed = sock.received.filter((e) => typeof e.agent_seq === 'number');
      expect(replayed.map((e) => e.agent_seq)).toEqual([3, 4, 5]);
      const ack = sock.received.find((e) => e.type === 'resync_ack');
      expect(ack).toMatchObject({ last_seen_seq: 2, current_seq: 5, gap_detected: false });
    });

    it('detects a gap beyond the 500-event ring and falls back to the DB', async () => {
      const rt = stack.runtime.realtime;
      const sock = new FakeSocket();
      const handle = rt.attachAgentSocket('w1', 'a', sock);
      // Overflow the ring so seq=1 is evicted.
      for (let i = 0; i < 600; i++) {
        await rt.pushToAgent('w1', 'a', { type: 'message', n: i });
      }
      sock.received.length = 0;

      await handle.handleMessage(JSON.stringify({ type: 'resync', last_seen_seq: 1, since: new Date(0).toISOString() }));

      const ack = sock.received.find((e) => e.type === 'resync_ack');
      expect(ack).toMatchObject({ gap_detected: true, current_seq: 600 });
    });
  });

  describe('presence', () => {
    it('emits agent.status.active on connect and agent.status.offline on sweep', async () => {
      const rt = stack.runtime.realtime;
      const presence = stack.runtime.presence;
      const aSock = new FakeSocket();
      const bSock = new FakeSocket();
      rt.attachAgentSocket('w1', 'a', aSock);
      rt.attachAgentSocket('w1', 'b', bSock);

      await presence.heartbeat('w1', 'a', 'A');
      await presence.heartbeat('w1', 'b', 'B');
      expect(await presence.getOnline('w1')).toEqual(expect.arrayContaining(['a', 'b']));
      // 'b' should have learned 'a' (and itself) became active.
      expect(bSock.ofType('agent.status.active').length).toBeGreaterThanOrEqual(1);

      // Let 'a' go stale (ttl 1s) and sweep.
      await new Promise((r) => setTimeout(r, 1100));
      await presence.heartbeat('w1', 'b', 'B'); // keep b alive
      bSock.received.length = 0;
      await presence.sweep();

      expect(await presence.getOnline('w1')).toEqual(['b']);
      const offline = bSock.ofType('agent.status.offline');
      expect(offline.length).toBeGreaterThanOrEqual(1);
      expect(offline[0]).toMatchObject({ subject_agent_id: 'a' });
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

  describe('force-disconnect', () => {
    it('closes an agent\'s sockets', async () => {
      const rt = stack.runtime.realtime;
      const sock = new FakeSocket();
      rt.attachAgentSocket('w1', 'a', sock);
      await rt.disconnectAgent('w1', 'a');
      expect(sock.closed).toBe(true);
    });
  });

  describe('http integration: channel message delivery', () => {
    it('delivers message.created to joined channel members with both seqs', async () => {
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
      const bobSock = new FakeSocket();
      stack.runtime.realtime.attachAgentSocket(ws.workspaceId, bob.agentId, bobSock);

      const postRes = await stack.app.request('/v1/channels/team-chat/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
        body: JSON.stringify({ text: 'hello bob' }),
      });
      expect(postRes.status).toBeLessThan(300);

      // fanout runs in background; give the event loop a tick.
      await new Promise((r) => setTimeout(r, 50));

      const delivered = bobSock.ofType('message.created');
      expect(delivered.length).toBeGreaterThanOrEqual(1);
      expect(typeof delivered[0].channel_seq).toBe('number');
      expect(typeof delivered[0].agent_seq).toBe('number');
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
  });
});
