import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../../db/schema.js';
import { makeNodeStack, createWorkspace, registerAgent, FakeSocket, type TestStack } from './harness.js';
import { handleNodeControlMessage } from '../../node-control.js';
import { getAgentByName } from '../../engine/agent.js';
import { createTrigger, deleteTrigger, fireMessageTriggers, updateTrigger, type TriggerMessageInput } from '../../engine/trigger.js';
import { registerAction, deleteAction } from '../../engine/action.js';
import { advancingActionCatalog, configureActionCatalog } from '../../engine/actionCatalog.js';
import { MemoryActionCatalogStore } from '../../ports/actionCatalog.js';
import type { EngineDb } from '../../ports/database.js';

/**
 * The action catalog answers the hot-path action and trigger reads (node
 * heartbeat drift check, agent detail, message triggers) from the bound store,
 * reading the database once per revision; every writer advances the revision.
 */

const tables = (sql: string) => sql.replace(/\s+/g, ' ').match(/^select .*? from "(\w+)"/)?.[1];

describe('MemoryActionCatalogStore', () => {
  it('drops a fill whose revision an advance has passed', async () => {
    const store = new MemoryActionCatalogStore();
    const snapshot = { shape: 1, oversize: false as const, actions: [], triggers: [] };
    const { revision } = await store.read('ws');
    await store.advance('ws');
    await store.fill('ws', revision, snapshot);
    expect((await store.read('ws')).snapshot).toBeNull();

    const current = await store.read('ws');
    await store.fill('ws', current.revision, snapshot);
    expect((await store.read('ws')).snapshot).toEqual(snapshot);
    await store.advance('ws');
    expect((await store.read('ws')).snapshot).toBeNull();
  });

  it('releases a forgotten workspace without reviving a fill that predates it', async () => {
    const store = new MemoryActionCatalogStore();
    const snapshot = { shape: 1, oversize: false as const, actions: [], triggers: [] };
    const { revision } = await store.read('ws');
    await store.forget('ws');
    await store.fill('ws', revision, snapshot);
    const after = await store.read('ws');
    expect(after.snapshot).toBeNull();
    expect(after.revision).not.toBe(revision);
  });
});

describe('advancingActionCatalog', () => {
  it('returns the committed write when the store cannot advance', async () => {
    const db = {} as EngineDb;
    const store = new MemoryActionCatalogStore();
    let calls = 0;
    store.advance = async () => { calls++; throw new Error('store unavailable'); };
    configureActionCatalog(db, store);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(advancingActionCatalog(db, 'ws', async () => 'committed')).resolves.toBe('committed');
    expect(calls).toBe(2);
    expect(warn).toHaveBeenCalledWith('[actions] catalog advance failed', expect.objectContaining({ workspaceId: 'ws' }));
    warn.mockRestore();
  });
});

describe('action catalog', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack({ ttlMs: 60_000 }); });
  afterEach(() => stack.close());

  /**
   * A handle bound to the runtime's store. `take()` returns the catalog-table
   * reads since the last call; `fills()` the snapshots read from the database.
   */
  function counting() {
    const reads: string[] = [];
    let filled = 0;
    const store = stack.runtime.deps.actionCatalog!;
    const fill = store.fill.bind(store);
    store.fill = async (...args) => { filled++; return fill(...args); };
    const sqlite = stack.runtime.handle.sqlite;
    const db = drizzle(sqlite, { schema, logger: { logQuery: (sql) => {
      const table = tables(sql);
      if (table === 'actions' || table === 'triggers') reads.push(table);
    } } }) as unknown as EngineDb;
    configureActionCatalog(db, store);
    return { db, take: () => reads.splice(0), fills: () => { const n = filled; filled = 0; return n; } };
  }

  function message(caller: { agentId: string; name: string }): TriggerMessageInput {
    return {
      id: `msg_${Math.random().toString(36).slice(2)}`,
      channel_id: 'chan_general',
      channel_name: 'general',
      agent_id: caller.agentId,
      agent_name: caller.name,
      text: 'run the etl',
      created_at: new Date().toISOString(),
    };
  }

  it('reads a workspace without triggers once, and sees a trigger as soon as it is written', async () => {
    const ws = await createWorkspace(stack.app, 'catalog-triggers');
    const caller = await registerAgent(stack.app, ws.workspaceKey, 'caller');
    const handler = await registerAgent(stack.app, ws.workspaceKey, 'handler');
    const { db, take, fills } = counting();
    const fire = () => fireMessageTriggers({
      db, nodeConnections: stack.runtime.realtime, workspaceId: ws.workspaceId, message: message(caller),
    });

    expect(await fire()).toEqual([]);
    expect(take()).toEqual(['actions', 'triggers']);
    expect(await fire()).toEqual([]);
    expect(take()).toEqual([]);

    await registerAction(db, ws.workspaceId, { name: 'etl', description: 'etl', handler_agent: handler.name });
    const trigger = await createTrigger(db, ws.workspaceId, { channel: 'general', action_name: 'etl' });
    const lastTriggeredAt = () => (stack.runtime.handle.sqlite
      .prepare('SELECT last_triggered_at AS at FROM triggers WHERE id = ?').get(trigger.id) as { at: number | null }).at;
    fills();
    await fire();
    expect(fills()).toBe(1);
    expect(lastTriggeredAt()).not.toBeNull();

    // Each trigger write advances the catalog: the next message reads it again.
    await updateTrigger(db, ws.workspaceId, trigger.id, { enabled: false });
    await fire();
    expect(fills()).toBe(1);
    await deleteTrigger(db, ws.workspaceId, trigger.id);
    await fire();
    expect(fills()).toBe(1);
    take();
    await fire();
    expect(take()).toEqual([]);
  });

  it('serves agent detail actions from the catalog until an action write', async () => {
    const ws = await createWorkspace(stack.app, 'catalog-agent');
    const handler = await registerAgent(stack.app, ws.workspaceKey, 'handler');
    await registerAgent(stack.app, ws.workspaceKey, 'reader');
    const { db, take } = counting();

    expect((await getAgentByName(db, ws.workspaceId, 'reader'))?.actions_available_to).toEqual([]);
    expect(take()).toEqual(['actions', 'triggers']);
    await getAgentByName(db, ws.workspaceId, 'reader');
    expect(take()).toEqual([]);

    await registerAction(db, ws.workspaceId, { name: 'summarize', description: 'summarize', handler_agent: handler.name });
    expect((await getAgentByName(db, ws.workspaceId, 'reader'))?.actions_available_to)
      .toEqual([expect.objectContaining({ name: 'summarize' })]);
    expect((await getAgentByName(db, ws.workspaceId, 'handler'))?.actions_provided)
      .toEqual([expect.objectContaining({ name: 'summarize' })]);

    await deleteAction(db, ws.workspaceId, 'summarize');
    expect((await getAgentByName(db, ws.workspaceId, 'reader'))?.actions_available_to).toEqual([]);
  });

  it('keeps an unchanged heartbeat off the actions table and heals an engine-deleted action', async () => {
    const ws = await createWorkspace(stack.app, 'catalog-heartbeat');
    const enrolled = await stack.app.request('/v1/nodes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({ node_id: 'nb', name: 'nb', role: 'broker', capabilities: [], max_agents: 4, tags: [], version: 'v0' }),
    });
    expect(enrolled.status).toBe(201);
    const { db, take, fills } = counting();
    const sock = new FakeSocket();
    const capabilities = [{ name: 'spawn:claude', kind: 'capacity' }, { name: 'echo', kind: 'action' }];
    const broker = (frame: Record<string, unknown>) => handleNodeControlMessage({
      db, registry: stack.runtime.realtime, workspaceId: ws.workspaceId, nodeId: 'nb', socket: sock, raw: JSON.stringify(frame),
    });
    const beat = { v: 1, type: 'node.heartbeat', provider: { name: 'broker', instance_id: 'i1' }, name: 'nb', node_id: 'nb', capabilities, max_agents: 4, version: 'v1', load: 0, active_agents: 0, handlers_live: true };
    const echoRows = () => stack.runtime.handle.sqlite
      .prepare('SELECT name FROM actions WHERE workspace_id = ? AND handler_node_id = ?').all(ws.workspaceId, 'nb');

    await broker({ v: 1, id: 'r', type: 'node.register', name: 'nb', node_id: 'nb', provider: { name: 'broker', instance_id: 'i1' }, capabilities, max_agents: 4, tags: [], version: 'v1', resume_cursor: null });
    await broker(beat);
    take();
    await broker(beat);
    expect(take()).toEqual([]);

    await deleteAction(db, ws.workspaceId, 'echo');
    expect(echoRows()).toEqual([]);
    await broker(beat);
    expect(echoRows()).toEqual([{ name: 'echo' }]);
    // The re-materialization advanced the catalog; the next beat refills it once.
    fills();
    await broker(beat);
    expect(fills()).toBe(1);
    take();
    await broker(beat);
    expect(take()).toEqual([]);
  });
});
