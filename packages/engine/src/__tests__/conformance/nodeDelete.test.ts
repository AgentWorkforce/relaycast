import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { makeNodeStack, createWorkspace, registerAgent, type TestStack } from './harness.js';
import { actionInvocations, actions, agentNodeBindings, agents, nodes, workspaceEvents } from '../../db/schema.js';
import { deleteNode as deleteNodeById } from '../../engine/node.js';
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

  it('does not fall back to a name when the resolved id is already gone', async () => {
    await enroll('node_a', 'alpha');
    await enroll('node_b', 'node_a');
    // A queued delete that resolved node_a before a concurrent delete removed it.
    await db().delete(nodes).where(eq(nodes.id, 'node_a'));

    const result = await deleteNodeById(db(), stack.runtime.deps, ws.workspaceId, 'node_a', { force: true });
    expect(result).toEqual({ ok: false, code: 'node_not_found' });
    expect(await nodeRow('node_b')).toBeDefined();
  });

  it('takes hosted agents offline instead of leaving them active without a route', async () => {
    await enroll('node_host', 'agent-host');
    const agent = await registerAgent(stack.app, ws.workspaceKey, 'hosted-worker');
    await db().update(agents)
      .set({ status: 'active', lastSeen: new Date(), locationType: 'via_node', locationNodeId: 'node_host' })
      .where(eq(agents.id, agent.agentId));
    // The host stopped heartbeating but nothing has settled it yet.
    await db().update(nodes)
      .set({ status: 'online', lastHeartbeatAt: new Date(Date.now() - NODE_LIVENESS_TTL_MS - 60_000) })
      .where(eq(nodes.id, 'node_host'));

    expect((await deleteNode('agent-host')).status).toBe(200);
    const [after] = await db().select().from(agents).where(eq(agents.id, agent.agentId));
    expect(after.status).toBe('offline');
    expect(after.locationNodeId).toBeNull();
    const events = await db().select().from(workspaceEvents).where(eq(workspaceEvents.workspaceId, ws.workspaceId));
    expect(events.map((event) => event.type)).toContain('node.status.offline');
  });

  it('fails a parked invocation bound to an action the forced delete removes', async () => {
    await enroll('node_parked', 'parked');
    await hostAction('node_parked', 'echo');
    await db().insert(actionInvocations).values({
      id: 'inv_parked',
      workspaceId: ws.workspaceId,
      actionId: 'action_node_parked_echo',
      actionName: 'echo',
      invocationOrigin: 'registered_action',
      status: 'pending',
      handlerNodeId: 'node_parked',
      dispatchAttempts: 1,
    });

    expect((await deleteNode('parked', { force: true })).status).toBe(200);
    const [inv] = await db().select().from(actionInvocations).where(eq(actionInvocations.id, 'inv_parked'));
    expect(inv).toMatchObject({ status: 'failed', error: 'node_deleted', actionId: null });
    const events = await db().select().from(workspaceEvents).where(eq(workspaceEvents.workspaceId, ws.workspaceId));
    expect(events.map((event) => event.type)).toContain('action.failed');
  });

  it('touches nothing when the node changed after the checks', async () => {
    await enroll('node_raced', 'raced');
    const agent = await registerAgent(stack.app, ws.workspaceKey, 'raced-worker');
    await db().update(agents)
      .set({ status: 'active', locationType: 'via_node', locationNodeId: 'node_raced' })
      .where(eq(agents.id, agent.agentId));
    await db().update(nodes)
      .set({ status: 'online', lastHeartbeatAt: new Date(Date.now() - NODE_LIVENESS_TTL_MS - 60_000) })
      .where(eq(nodes.id, 'node_raced'));
    // Another isolate's heartbeat lands between the liveness check and the
    // offline claim: the claim's CAS on the observed epoch must miss.
    const realDb = db();
    let refreshed = false;
    const racingDb = new Proxy(realDb, {
      get(target, prop, receiver) {
        if (prop === 'update' && !refreshed) {
          refreshed = true;
          return (table: unknown) => {
            const pending = target.update(nodes)
              .set({ lastHeartbeatAt: new Date(), livenessRevision: 99 })
              .where(eq(nodes.id, 'node_raced'));
            return {
              set: (values: unknown) => ({
                where: (cond: unknown) => ({
                  returning: async (cols: unknown) => {
                    await pending;
                    return (target.update(table as typeof nodes).set(values as never).where(cond as never) as never as {
                      returning: (c: unknown) => Promise<unknown[]>;
                    }).returning(cols);
                  },
                }),
              }),
            };
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const result = await deleteNodeById(racingDb, stack.runtime.deps, ws.workspaceId, 'node_raced');
    expect(result).toEqual({ ok: false, code: 'node_delete_conflict' });
    expect(await nodeRow('node_raced')).toBeDefined();
    const [kept] = await db().select().from(agents).where(eq(agents.id, agent.agentId));
    expect(kept).toMatchObject({ status: 'active', locationNodeId: 'node_raced' });
  });

  it('fails an open invocation the node took with it', async () => {
    await enroll('node_gone', 'gone');
    // A dispatched built-in release is pinned to its node and is never
    // rescheduled, so deleting the node strands it.
    await db().insert(actionInvocations).values({
      id: 'inv_pinned',
      workspaceId: ws.workspaceId,
      actionName: 'release',
      invocationOrigin: 'builtin',
      input: { name: 'someone' },
      status: 'dispatched',
      handlerNodeId: 'node_gone',
      dispatchedNodeId: 'node_gone',
      dispatchedProvider: 'default',
      attemptedNodeIds: ['node_gone'],
      dispatchAttempts: 1,
    });

    expect((await deleteNode('gone')).status).toBe(200);
    const [inv] = await db().select().from(actionInvocations).where(eq(actionInvocations.id, 'inv_pinned'));
    expect(inv).toMatchObject({ status: 'failed', error: 'node_deleted', dispatchedNodeId: null });
  });

  it('takes an agent bound to an already-offline node offline', async () => {
    await enroll('node_cold', 'cold');
    const agent = await registerAgent(stack.app, ws.workspaceKey, 'cold-worker');
    await db().update(agents)
      .set({ status: 'active', lastSeen: new Date(), locationNodeId: 'node_cold' })
      .where(eq(agents.id, agent.agentId));
    expect((await nodeRow('node_cold')).status).toBe('offline');

    expect((await deleteNode('cold')).status).toBe(200);
    const [after] = await db().select().from(agents).where(eq(agents.id, agent.agentId));
    expect(after).toMatchObject({ status: 'offline', locationNodeId: null });
  });

  it('leaves agents and invocations untouched when the delete no longer matches', async () => {
    await enroll('node_kept', 'kept');
    const agent = await registerAgent(stack.app, ws.workspaceKey, 'kept-worker');
    await db().update(agents)
      .set({ status: 'active', locationNodeId: 'node_kept' })
      .where(eq(agents.id, agent.agentId));
    await db().insert(actionInvocations).values({
      id: 'inv_kept', workspaceId: ws.workspaceId, actionName: 'echo', status: 'dispatched',
      handlerNodeId: 'node_kept', dispatchedNodeId: 'node_kept',
    });
    // An action registered after the checks: the guarded group must not run.
    const realDb = db();
    let registered = false;
    const racingDb = new Proxy(realDb, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if ((prop === 'withTransaction' || prop === 'batch') && typeof value === 'function' && !registered) {
          return async (...args: unknown[]) => {
            registered = true;
            await target.insert(actions).values({
              id: 'action_late', workspaceId: ws.workspaceId, name: 'late', description: 'late', handlerNodeId: 'node_kept',
            });
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return value;
      },
    });

    const result = await deleteNodeById(racingDb, stack.runtime.deps, ws.workspaceId, 'node_kept');
    expect(registered).toBe(true);
    expect(result).toEqual({ ok: false, code: 'node_delete_conflict' });
    expect(await nodeRow('node_kept')).toBeDefined();
    const [kept] = await db().select().from(agents).where(eq(agents.id, agent.agentId));
    expect(kept).toMatchObject({ status: 'active', locationNodeId: 'node_kept' });
    const [inv] = await db().select().from(actionInvocations).where(eq(actionInvocations.id, 'inv_kept'));
    expect(inv.status).toBe('dispatched');
  });

  it('fails an accepted task and an unsent native spawn pinned to the node', async () => {
    await enroll('node_worker', 'worker');
    await db().insert(actionInvocations).values([
      {
        id: 'inv_task', workspaceId: ws.workspaceId, actionName: 'build', status: 'running',
        handlerNodeId: 'node_worker', dispatchedNodeId: 'node_worker', dispatchedProvider: 'default', dispatchAttempts: 1,
      },
      {
        id: 'inv_spawn', workspaceId: ws.workspaceId, actionName: 'spawn:claude', status: 'pending',
        handlerNodeId: 'node_worker',
      },
      // Unpinned generic work stays pending for placement on another node.
      {
        id: 'inv_generic', workspaceId: ws.workspaceId, actionName: 'echo', status: 'pending',
        handlerNodeId: 'node_worker',
      },
      // A spawn sent before and since unpinned for retry: handler_node_id is
      // only its 201 snapshot.
      {
        id: 'inv_unpinned_spawn', workspaceId: ws.workspaceId, actionName: 'spawn:claude', status: 'pending',
        handlerNodeId: 'node_worker', dispatchAttempts: 1,
      },
    ]);

    expect((await deleteNode('worker')).status).toBe(200);
    const rows = await db().select().from(actionInvocations).where(eq(actionInvocations.workspaceId, ws.workspaceId));
    const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
    expect(byId.inv_task).toMatchObject({ status: 'failed', error: 'node_deleted' });
    expect(byId.inv_spawn).toMatchObject({ status: 'failed', error: 'node_deleted' });
    expect(byId.inv_generic.status).toBe('pending');
    expect(byId.inv_unpinned_spawn.status).toBe('pending');
  });

  it('a forced delete still goes through when a heartbeat beats its offline claim', async () => {
    await enroll('node_beating', 'beating');
    await db().update(nodes).set({ status: 'online', lastHeartbeatAt: new Date() }).where(eq(nodes.id, 'node_beating'));
    const realDb = db();
    let raced = false;
    const racingDb = new Proxy(realDb, {
      get(target, prop, receiver) {
        if (prop === 'update' && !raced) {
          raced = true;
          return (table: unknown) => {
            const heartbeat = target.update(nodes)
              .set({ lastHeartbeatAt: new Date(Date.now() + 1_000), livenessRevision: 42 })
              .where(eq(nodes.id, 'node_beating'));
            return {
              set: (values: unknown) => ({
                where: (cond: unknown) => ({
                  returning: async (cols: unknown) => {
                    await heartbeat;
                    return (target.update(table as typeof nodes).set(values as never).where(cond as never) as never as {
                      returning: (c: unknown) => Promise<unknown[]>;
                    }).returning(cols);
                  },
                }),
              }),
            };
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const result = await deleteNodeById(racingDb, stack.runtime.deps, ws.workspaceId, 'node_beating', { force: true });
    expect(raced).toBe(true);
    expect(result).toMatchObject({ ok: true, id: 'node_beating' });
    expect(await nodeRow('node_beating')).toBeUndefined();
  });
});
