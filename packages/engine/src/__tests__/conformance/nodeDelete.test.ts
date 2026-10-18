import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { makeNodeStack, createWorkspace, registerAgent, type TestStack } from './harness.js';
import { actions, agentNodeBindings, agents, nodes } from '../../db/schema.js';
import { NODE_LIVENESS_TTL_MS } from '../../engine/placement.js';

/**
 * DELETE /v1/nodes/:name implements the contract `relay.nodes.delete()` and
 * openapi.yaml already publish, so self-hosted rosters can be pruned too.
 */
describe('DELETE /v1/nodes/:name', () => {
  let stack: TestStack;
  let ws: Awaited<ReturnType<typeof createWorkspace>>;
  beforeEach(async () => {
    stack = makeNodeStack();
    ws = await createWorkspace(stack.app, 'node-delete-ws');
  });
  afterEach(async () => { await stack.close(); });

  const db = () => stack.runtime.deps.db;

  async function enroll(id: string, name: string) {
    const res = await stack.app.request('/v1/nodes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({ node_id: id, name, max_agents: 4, tags: ['test'] }),
    });
    expect(res.status).toBe(201);
  }

  function deleteNode(idOrName: string, opts: { force?: boolean; token?: string } = {}) {
    return stack.app.request(`/v1/nodes/${encodeURIComponent(idOrName)}${opts.force ? '?force=true' : ''}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${opts.token ?? ws.workspaceKey}` },
    });
  }

  async function errorCode(res: Response) {
    return ((await res.json()) as { error: { code: string } }).error.code;
  }

  async function nodeRow(id: string) {
    const [row] = await db().select().from(nodes).where(eq(nodes.id, id));
    return row;
  }

  async function hostAction(nodeId: string, name: string) {
    await db().insert(actions).values({
      id: `action_${nodeId}_${name}`, workspaceId: ws.workspaceId, name, description: name, handlerNodeId: nodeId,
    });
  }

  it('deletes an offline node by name and drops it from the roster', async () => {
    await enroll('node_dead', 'dead-probe');

    const res = await deleteNode('dead-probe');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      data: { id: 'node_dead', name: 'dead-probe', deleted: true, cascaded_actions: 0 },
    });
    expect(await nodeRow('node_dead')).toBeUndefined();

    const get = await stack.app.request('/v1/nodes/dead-probe', {
      headers: { authorization: `Bearer ${ws.workspaceKey}` },
    });
    expect(get.status).toBe(404);
  });

  it('resolves an exact id before a name', async () => {
    await enroll('node_a', 'alpha');
    // A second node whose *name* is the first node's id.
    await enroll('node_b', 'node_a');

    const res = await deleteNode('node_a');
    expect(res.status).toBe(200);
    expect(await nodeRow('node_a')).toBeUndefined();
    expect(await nodeRow('node_b')).toBeDefined();
  });

  it('deletes a node whose heartbeat lapsed even though its status still reads online', async () => {
    await enroll('node_lapsed', 'lapsed');
    await db().update(nodes)
      .set({ status: 'online', lastHeartbeatAt: new Date(Date.now() - NODE_LIVENESS_TTL_MS - 60_000) })
      .where(eq(nodes.id, 'node_lapsed'));

    expect((await deleteNode('lapsed')).status).toBe(200);
    expect(await nodeRow('node_lapsed')).toBeUndefined();
  });

  it('cascades bindings and clears agent references', async () => {
    await enroll('node_bound', 'bound');
    const agent = await registerAgent(stack.app, ws.workspaceKey, 'bound-agent');
    await db().insert(agentNodeBindings).values({
      id: 'binding_bound', workspaceId: ws.workspaceId, agentId: agent.agentId, nodeId: 'node_bound', status: 'active',
    });
    await db().update(agents).set({ locationNodeId: 'node_bound' }).where(eq(agents.id, agent.agentId));

    expect((await deleteNode('bound')).status).toBe(200);
    expect(await db().select().from(agentNodeBindings).where(eq(agentNodeBindings.id, 'binding_bound'))).toEqual([]);
    const [kept] = await db().select().from(agents).where(eq(agents.id, agent.agentId));
    expect(kept).toMatchObject({ id: agent.agentId, locationNodeId: null });
  });

  it('returns 404 for an unknown node', async () => {
    const res = await deleteNode('never-enrolled');
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe('node_not_found');
  });

  it('requires the workspace key', async () => {
    await enroll('node_guarded', 'guarded');
    const agent = await registerAgent(stack.app, ws.workspaceKey, 'not-an-admin');

    const res = await deleteNode('guarded', { token: agent.token });
    expect(res.status).toBeGreaterThanOrEqual(401);
    expect(res.status).toBeLessThanOrEqual(403);
    expect(await nodeRow('node_guarded')).toBeDefined();
  });

  it('refuses an online node unless forced', async () => {
    await enroll('node_live', 'live');
    await db().update(nodes).set({ status: 'online', lastHeartbeatAt: new Date() }).where(eq(nodes.id, 'node_live'));

    const res = await deleteNode('live');
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('node_online');
    expect(await nodeRow('node_live')).toBeDefined();

    expect((await deleteNode('live', { force: true })).status).toBe(200);
    expect(await nodeRow('node_live')).toBeUndefined();
  });

  it('treats a heartbeat skewed into the future as online', async () => {
    await enroll('node_skewed', 'skewed');
    await db().update(nodes)
      .set({ status: 'online', lastHeartbeatAt: new Date(Date.now() + 60_000) })
      .where(eq(nodes.id, 'node_skewed'));

    const res = await deleteNode('skewed');
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('node_online');
  });

  it('refuses a node hosting actions unless forced, then cascades them', async () => {
    await enroll('node_host', 'host');
    await hostAction('node_host', 'echo');
    await hostAction('node_host', 'deploy');

    const res = await deleteNode('host');
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('node_has_actions');
    expect(await nodeRow('node_host')).toBeDefined();

    const forced = await deleteNode('host', { force: true });
    expect(forced.status).toBe(200);
    expect(((await forced.json()) as { data: { cascaded_actions: number } }).data.cascaded_actions).toBe(2);
    expect(await db().select().from(actions).where(eq(actions.handlerNodeId, 'node_host'))).toEqual([]);
  });
});
