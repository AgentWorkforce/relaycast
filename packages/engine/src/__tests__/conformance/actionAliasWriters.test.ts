import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeNodeStack, createWorkspace, registerAgent, FakeSocket, type TestStack } from './harness.js';
import { deleteAction, registerAction } from '../../engine/action.js';
import { deregisterProvider, heartbeatNode } from '../../engine/node.js';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../../db/schema.js';
import type { EngineDb } from '../../ports/database.js';

/**
 * Every write that changes which row may claim an action name's
 * workspace-global alias settles the alias itself, in the same atomic unit:
 * a node heartbeat never re-reads action rows to repair them.
 */
type Cap = { name: string; kind: 'action'; global?: boolean };

describe('action alias writers', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack({ ttlMs: 60_000 }); });
  afterEach(() => stack.close());

  async function enrollNode(workspaceKey: string, nodeId: string) {
    const res = await stack.app.request('/v1/nodes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${workspaceKey}` },
      body: JSON.stringify({ node_id: nodeId, name: nodeId, role: 'broker', capabilities: [], max_agents: 4, tags: [], version: 'v0' }),
    });
    expect(res.status).toBe(201);
  }

  /** Attach `nodeId`'s `provider` and register `names` as its action capabilities. */
  async function provide(workspaceId: string, nodeId: string, names: Array<string | Cap>, provider = 'default') {
    const handle = stack.runtime.realtime.attachNodeSocket(workspaceId, nodeId, new FakeSocket());
    const caps = (entries: Array<string | Cap>): Cap[] =>
      entries.map((entry) => (typeof entry === 'string' ? { name: entry, kind: 'action' } : entry));
    const register = (entries: Array<string | Cap>) => handle.handleMessage(JSON.stringify({
      v: 1, id: `reg-${Math.random()}`, type: 'node.register', name: nodeId, node_id: nodeId,
      provider: { name: provider, instance_id: `${nodeId}-${provider}` },
      capabilities: caps(entries), max_agents: 4, tags: [], version: 'v1', resume_cursor: null,
    }));
    const beat = (entries: Array<string | Cap>) => handle.handleMessage(JSON.stringify({
      v: 1, type: 'node.heartbeat', load: 0, active_agents: 0, handlers_live: true, capabilities: caps(entries),
    }));
    await register(names);
    return { register, beat };
  }

  function isGlobal(workspaceId: string, nodeId: string, name: string): number | undefined {
    const row = stack.runtime.handle.sqlite
      .prepare('SELECT is_global FROM actions WHERE workspace_id = ? AND handler_node_id = ? AND name = ?')
      .get(workspaceId, nodeId, name) as { is_global: number } | undefined;
    return row?.is_global;
  }

  it('demotes a default provider alias when an agent registers the same name', async () => {
    const ws = await createWorkspace(stack.app, 'alias-agent-register');
    const agent = await registerAgent(stack.app, ws.workspaceKey, 'handler');
    await enrollNode(ws.workspaceKey, 'node_a');
    await provide(ws.workspaceId, 'node_a', ['echo']);
    expect(isGlobal(ws.workspaceId, 'node_a', 'echo')).toBe(1);

    await registerAction(stack.runtime.handle.db, ws.workspaceId, { name: 'echo', description: 'echo', handler_agent: agent.name });
    expect(isGlobal(ws.workspaceId, 'node_a', 'echo')).toBe(0);
  });

  it('passes the alias to a default provider when the agent-hosted action is deleted', async () => {
    const ws = await createWorkspace(stack.app, 'alias-agent-delete');
    const agent = await registerAgent(stack.app, ws.workspaceKey, 'handler');
    await registerAction(stack.runtime.handle.db, ws.workspaceId, { name: 'beep', description: 'beep', handler_agent: agent.name });
    await enrollNode(ws.workspaceKey, 'node_a');
    await provide(ws.workspaceId, 'node_a', ['beep']);
    expect(isGlobal(ws.workspaceId, 'node_a', 'beep')).toBe(0);

    expect(await deleteAction(stack.runtime.handle.db, ws.workspaceId, 'beep')).toBe(true);
    expect(isGlobal(ws.workspaceId, 'node_a', 'beep')).toBe(1);
  });

  it('passes the alias to the next default provider when its owner stops offering it', async () => {
    const ws = await createWorkspace(stack.app, 'alias-owner-prune');
    await enrollNode(ws.workspaceKey, 'node_a');
    await enrollNode(ws.workspaceKey, 'node_b');
    const a = await provide(ws.workspaceId, 'node_a', ['etl']);
    await provide(ws.workspaceId, 'node_b', ['etl']);
    expect([isGlobal(ws.workspaceId, 'node_a', 'etl'), isGlobal(ws.workspaceId, 'node_b', 'etl')]).toEqual([1, 0]);

    await a.register([]);
    expect(isGlobal(ws.workspaceId, 'node_a', 'etl')).toBeUndefined();
    expect(isGlobal(ws.workspaceId, 'node_b', 'etl')).toBe(1);
  });

  it('passes the alias to the next default provider when its owner deregisters', async () => {
    const ws = await createWorkspace(stack.app, 'alias-owner-deregister');
    await enrollNode(ws.workspaceKey, 'node_a');
    await enrollNode(ws.workspaceKey, 'node_b');
    await provide(ws.workspaceId, 'node_a', ['etl']);
    await provide(ws.workspaceId, 'node_b', ['etl']);

    await deregisterProvider(stack.runtime.handle.db, stack.runtime.realtime, ws.workspaceId, 'node_a', 'default');
    expect(isGlobal(ws.workspaceId, 'node_a', 'etl')).toBeUndefined();
    expect(isGlobal(ws.workspaceId, 'node_b', 'etl')).toBe(1);
  });

  it('passes the alias to a default provider when its explicit owner stops claiming it', async () => {
    const ws = await createWorkspace(stack.app, 'alias-explicit-release');
    await enrollNode(ws.workspaceKey, 'node_a');
    await enrollNode(ws.workspaceKey, 'node_b');
    const a = await provide(ws.workspaceId, 'node_a', [{ name: 'etl', kind: 'action', global: true }], 'py');
    await provide(ws.workspaceId, 'node_b', ['etl']);
    expect([isGlobal(ws.workspaceId, 'node_a', 'etl'), isGlobal(ws.workspaceId, 'node_b', 'etl')]).toEqual([1, 0]);

    await a.register([{ name: 'etl', kind: 'action', global: false }]);
    expect([isGlobal(ws.workspaceId, 'node_a', 'etl'), isGlobal(ws.workspaceId, 'node_b', 'etl')]).toEqual([0, 1]);
  });

  it('retries a materialization that failed when the next heartbeat repeats the capabilities', async () => {
    const ws = await createWorkspace(stack.app, 'alias-materialize-retry');
    await enrollNode(ws.workspaceKey, 'node_a');
    await enrollNode(ws.workspaceKey, 'node_b');
    const etl: Cap = { name: 'etl', kind: 'action', global: true };
    const a = await provide(ws.workspaceId, 'node_a', [etl], 'py');
    // A handle without transactions, like D1: a failed write is not rolled back.
    const d1Like = drizzle(stack.runtime.handle.sqlite, { schema }) as unknown as EngineDb;
    const beat = () => heartbeatNode(d1Like, ws.workspaceId, 'node_b', 'py', {
      type: 'node.heartbeat', load: 0, active_agents: 0, handlers_live: true, capabilities: [etl], max_agents: 4,
    });

    // node_a owns the explicit alias, so node_b's claim fails and writes no row.
    await expect(beat()).rejects.toMatchObject({ code: 'action_name_conflict' });
    expect(isGlobal(ws.workspaceId, 'node_b', 'etl')).toBeUndefined();

    await a.register([]);
    await beat();
    expect(isGlobal(ws.workspaceId, 'node_b', 'etl')).toBe(1);
  });

  it('settles a released alias even when a later capability in the same pass fails', async () => {
    const ws = await createWorkspace(stack.app, 'alias-release-then-fail');
    for (const node of ['node_a', 'node_b', 'node_c']) await enrollNode(ws.workspaceKey, node);
    await provide(ws.workspaceId, 'node_a', [{ name: 'etl', kind: 'action', global: true }], 'py');
    await provide(ws.workspaceId, 'node_b', [{ name: 'sync', kind: 'action', global: true }], 'py');
    await provide(ws.workspaceId, 'node_c', ['etl']);
    expect(isGlobal(ws.workspaceId, 'node_c', 'etl')).toBe(0);

    // node_a drops `global` on etl, then claims sync, which node_b owns. The
    // pass fails without rollback, as on D1, after the etl demotion committed.
    const d1Like = drizzle(stack.runtime.handle.sqlite, { schema }) as unknown as EngineDb;
    await expect(heartbeatNode(d1Like, ws.workspaceId, 'node_a', 'py', {
      type: 'node.heartbeat', load: 0, active_agents: 0, handlers_live: true, max_agents: 4,
      capabilities: [{ name: 'etl', kind: 'action', global: false }, { name: 'sync', kind: 'action', global: true }],
    })).rejects.toMatchObject({ code: 'action_name_conflict' });
    expect(isGlobal(ws.workspaceId, 'node_a', 'etl')).toBe(0);
    expect(isGlobal(ws.workspaceId, 'node_c', 'etl')).toBe(1);
  });

  it('refuses to delete an action a node provider owns, and deletes only the rows it does not', async () => {
    const ws = await createWorkspace(stack.app, 'alias-provider-owned');
    const agent = await registerAgent(stack.app, ws.workspaceKey, 'handler');
    await enrollNode(ws.workspaceKey, 'node_a');
    await provide(ws.workspaceId, 'node_a', ['echo', 'shared']);
    const del = (name: string) => stack.app.request(`/v1/actions/${name}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${ws.workspaceKey}` },
    });

    const refused = await del('echo');
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('action_provider_owned');
    expect(isGlobal(ws.workspaceId, 'node_a', 'echo')).toBe(1);

    await registerAction(stack.runtime.handle.db, ws.workspaceId, { name: 'shared', description: 'shared', handler_agent: agent.name });
    expect((await del('shared')).status).toBe(204);
    expect(isGlobal(ws.workspaceId, 'node_a', 'shared')).toBe(1);
  });
});
