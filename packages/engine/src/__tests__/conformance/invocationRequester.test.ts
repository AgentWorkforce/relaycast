import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { makeNodeStack, createWorkspace, registerAgent, FakeSocket, type TestStack } from './harness.js';
import { actionInvocations } from '../../db/tables.js';

/**
 * Optional on-behalf-of requester identity on action invocations. The
 * authenticated agent stays caller_id/caller_name; requester_agent_id must
 * name an agent in the caller's workspace and is returned on every
 * serialized invocation shape.
 */
describe('invocation requester identity', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack({ ttlMs: 60_000 }); });
  afterEach(async () => { vi.restoreAllMocks(); await stack.close(); });

  async function setup(slug: string) {
    const ws = await createWorkspace(stack.app, slug);
    const launcher = await registerAgent(stack.app, ws.workspaceKey, 'launcher');
    const owner = await registerAgent(stack.app, ws.workspaceKey, 'owner');
    const created = await stack.app.request('/v1/nodes', {
      method: 'POST', headers: { authorization: `Bearer ${ws.workspaceKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ node_id: 'node_a', name: 'alpha', role: 'broker', capabilities: [], max_agents: 4, tags: [], version: 'v1' }),
    });
    expect(created.status).toBe(201);
    const nodeToken = (await created.json() as { data: { token: string } }).data.token;
    const sock = new FakeSocket();
    const handle = stack.runtime.realtime.attachNodeSocket(ws.workspaceId, 'node_a', sock);
    await handle.handleMessage(JSON.stringify({
      v: 1, id: 'register', type: 'node.register', node_id: 'node_a', name: 'alpha',
      capabilities: [
        { name: 'echo', kind: 'action', global: true },
        { name: 'spawn:claude', kind: 'spawn', metadata: { agent: 'claude' } },
      ],
      max_agents: 4, tags: [], version: 'v1', resume_cursor: null,
    }));
    expect(sock.ofType('reply').at(-1)).toMatchObject({ ok: true });
    await handle.handleMessage(JSON.stringify({ v: 1, type: 'node.heartbeat', active_agents: 0, handlers_live: true }));

    const invoke = (action: string, body: Record<string, unknown>, key?: string, path = `/v1/actions/${action}/invoke`) =>
      stack.app.request(path, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${launcher.token}`, 'content-type': 'application/json',
          ...(key ? { 'Idempotency-Key': key } : {}),
        },
        body: JSON.stringify(body),
      });
    const read = async (action: string, id: string, credential = launcher.token) => {
      const response = await stack.app.request(`/v1/actions/${action}/invocations/${id}`, {
        headers: { authorization: `Bearer ${credential}` },
      });
      expect(response.status).toBe(200);
      return (await response.json() as { data: Record<string, unknown> }).data;
    };
    return { ...ws, launcher, owner, sock, handle, nodeToken, invoke, read };
  }

  it('persists and returns both fields on the invoke response and GET, keeping caller as the authenticated agent', async () => {
    const t = await setup('requester-both');
    const res = await t.invoke('echo', {
      input: { text: 'hi' }, requester_agent_id: t.owner.agentId, requester_name: 'Owner Display',
    });
    expect(res.status).toBe(201);
    const body = (await res.json() as { data: Record<string, unknown> }).data;
    expect(body).toMatchObject({ requester_agent_id: t.owner.agentId, requester_name: 'Owner Display' });
    expect(await t.read('echo', body.invocation_id as string)).toMatchObject({
      caller_id: t.launcher.agentId,
      caller_name: 'launcher',
      requester_agent_id: t.owner.agentId,
      requester_name: 'Owner Display',
    });
  });

  it('defaults requester_name to the requester agent name and returns it to the node on a spawn', async () => {
    const t = await setup('requester-spawn');
    const res = await t.invoke('spawn', {
      input: { name: 'worker', cli: 'claude', task: 'review' }, requester_agent_id: t.owner.agentId,
    });
    expect(res.status).toBe(201);
    const body = (await res.json() as { data: Record<string, unknown> }).data;
    expect(body).toMatchObject({ action_name: 'spawn', requester_agent_id: t.owner.agentId, requester_name: 'owner' });
    expect(t.sock.ofType('action.invoke').at(-1)).toMatchObject({ invocation_id: body.invocation_id, action: 'spawn:claude' });
    // The dispatched node reads its spawn invocation with its own credential.
    expect(await t.read('spawn', body.invocation_id as string, t.nodeToken)).toMatchObject({
      caller_id: t.launcher.agentId,
      caller_name: 'launcher',
      requester_agent_id: t.owner.agentId,
      requester_name: 'owner',
      dispatched_node_id: 'node_a',
    });
  });

  it('accepts requester_name without an id and returns explicit nulls when omitted', async () => {
    const t = await setup('requester-optional');
    const named = await t.invoke('echo', { input: {}, requester_name: 'external-user' });
    expect(named.status).toBe(201);
    const namedBody = (await named.json() as { data: Record<string, unknown> }).data;
    expect(namedBody).toMatchObject({ requester_agent_id: null, requester_name: 'external-user' });

    const plain = await t.invoke('echo', { input: {} });
    expect(plain.status).toBe(201);
    const plainBody = (await plain.json() as { data: Record<string, unknown> }).data;
    expect(plainBody).toMatchObject({ requester_agent_id: null, requester_name: null });
    expect(await t.read('echo', plainBody.invocation_id as string)).toMatchObject({
      caller_id: t.launcher.agentId, requester_agent_id: null, requester_name: null,
    });
  });

  it('rejects a requester outside the caller workspace or malformed fields before any dispatch', async () => {
    const t = await setup('requester-invalid');
    const foreign = await createWorkspace(stack.app, 'requester-invalid-foreign');
    const stranger = await registerAgent(stack.app, foreign.workspaceKey, 'stranger');
    for (const requester of ['agent_does_not_exist', stranger.agentId]) {
      const res = await t.invoke('echo', { input: {}, requester_agent_id: requester });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        ok: false,
        error: { code: 'invalid_request', message: 'requester_agent_id does not match an agent in this workspace' },
      });
    }
    for (const bad of [{ requester_agent_id: '' }, { requester_name: '' }, { requester_agent_id: 'x'.repeat(129) }, { requester_name: 'x'.repeat(257) }]) {
      expect((await t.invoke('echo', { input: {}, ...bad })).status).toBe(400);
    }
    expect(t.sock.ofType('action.invoke')).toHaveLength(0);
    const rows = await stack.runtime.handle.db
      .select({ id: actionInvocations.id })
      .from(actionInvocations)
      .where(eq(actionInvocations.workspaceId, t.workspaceId));
    expect(rows).toEqual([]);
  });

  it('rejects Idempotency-Key reuse with a different requester and replays the same one', async () => {
    const t = await setup('requester-idempotency');
    const other = await registerAgent(stack.app, t.workspaceKey, 'other');
    const first = await t.invoke('echo', { input: { n: 1 }, requester_agent_id: t.owner.agentId }, 'key-1');
    expect(first.status).toBe(201);
    const firstId = (await first.json() as { data: { invocation_id: string } }).data.invocation_id;

    const replay = await t.invoke('echo', { input: { n: 1 }, requester_agent_id: t.owner.agentId }, 'key-1');
    expect(replay.status).toBe(201);
    expect((await replay.json() as { data: Record<string, unknown> }).data).toMatchObject({
      invocation_id: firstId, requester_agent_id: t.owner.agentId, requester_name: 'owner',
    });

    for (const body of [
      { input: { n: 1 }, requester_agent_id: other.agentId },
      { input: { n: 1 } },
    ]) {
      const reused = await t.invoke('echo', body, 'key-1');
      expect(reused.status).toBe(409);
      expect(await reused.json()).toMatchObject({ error: { code: 'idempotency_key_reused' } });
    }
    expect(t.sock.ofType('action.invoke')).toHaveLength(1);
  });

  it('carries the requester on strict spawn, its idempotent replay, and the spawn replay route', async () => {
    const t = await setup('requester-strict');
    const other = await registerAgent(stack.app, t.workspaceKey, 'other');
    const logical = {
      schema: 'relay.spawn.invoke.logical/1', target_node_id: 'node_a', target_node: 'alpha',
      name: 'worker', cli: 'claude', task: 'review', directory: '/repo', verify_ready: true,
    };
    const input = {
      spawn_contract: 'relay.spawn.invoke.logical/1', target_node_id: 'node_a', target_node: 'alpha',
      name: 'worker', cli: 'claude', task: 'review', worker_cwd: '/repo', verify_ready: true,
      logical_request: logical,
    };
    const strict = (body: Record<string, unknown>) =>
      t.invoke('spawn', { input, ...body }, 'strict-key', '/v1/actions/spawn/strict-invoke');

    const first = await strict({ requester_agent_id: t.owner.agentId, requester_name: 'Owner' });
    expect(first.status).toBe(201);
    const firstBody = (await first.json() as { data: Record<string, unknown> }).data;
    expect(firstBody).toMatchObject({ requester_agent_id: t.owner.agentId, requester_name: 'Owner' });
    expect(t.sock.ofType('action.invoke')).toHaveLength(1);

    const again = await strict({ requester_agent_id: t.owner.agentId, requester_name: 'Owner' });
    expect(again.status).toBe(201);
    expect((await again.json() as { data: Record<string, unknown> }).data).toMatchObject({
      invocation_id: firstBody.invocation_id, requester_agent_id: t.owner.agentId, requester_name: 'Owner',
    });
    expect((await strict({ requester_agent_id: other.agentId })).status).toBe(409);
    expect((await strict({ requester_agent_id: 'missing-agent' })).status).toBe(400);

    const replayed = await stack.app.request('/v1/actions/spawn/replay', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${t.launcher.token}`, 'content-type': 'application/json', 'Idempotency-Key': 'strict-key',
      },
      body: JSON.stringify({ logical_request: logical }),
    });
    expect(replayed.status).toBe(200);
    expect((await replayed.json() as { data: Record<string, unknown> }).data).toMatchObject({
      invocation_id: firstBody.invocation_id, requester_agent_id: t.owner.agentId, requester_name: 'Owner',
    });
    expect(t.sock.ofType('action.invoke')).toHaveLength(1);
  });

  it('nulls the requester id when the requester agent is deleted, keeping the recorded name', async () => {
    const t = await setup('requester-delete');
    const res = await t.invoke('echo', { input: {}, requester_agent_id: t.owner.agentId });
    const id = (await res.json() as { data: { invocation_id: string } }).data.invocation_id;
    const { agents } = await import('../../db/tables.js');
    await stack.runtime.handle.db.delete(agents).where(and(eq(agents.workspaceId, t.workspaceId), eq(agents.id, t.owner.agentId)));
    expect(await t.read('echo', id)).toMatchObject({ requester_agent_id: null, requester_name: 'owner' });
  });
});
