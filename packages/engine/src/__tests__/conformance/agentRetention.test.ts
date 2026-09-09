import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { attachDirectNodeSocket, createWorkspace, makeNodeStack, registerAgent, type TestStack } from './harness.js';
import { agents, agentNodeBindings, channels, files, messages, nodes, webhooks } from '../../db/schema.js';
import { retainAgents } from '../../engine/agentRetention.js';

const now = new Date('2026-09-08T12:00:00Z');
const old = new Date('2026-08-01T00:00:00Z');
const cutoff = new Date('2026-09-01T12:00:00Z');

describe('bulk agent retention', () => {
  let stack: TestStack;
  let ws: Awaited<ReturnType<typeof createWorkspace>>;
  beforeEach(async () => {
    stack = makeNodeStack();
    ws = await createWorkspace(stack.app, 'retention');
  });
  afterEach(async () => { vi.restoreAllMocks(); await stack.close(); });
  const db = () => stack.runtime.deps.db;
  const options = { retention_days: 7 };

  async function seed(id: string, values: Partial<typeof agents.$inferInsert> = {}) {
    await db().insert(agents).values({
      id, name: id, workspaceId: ws.workspaceId, tokenHash: id,
      status: 'offline', lastSeen: old, createdAt: old, ...values,
    });
  }
  async function node(id = 'broker') {
    await db().insert(nodes).values({
      id, workspaceId: ws.workspaceId, name: id, tokenHash: id,
      role: 'broker', status: 'offline', lastHeartbeatAt: old,
    });
  }
  const remaining = async () => (await db().select({ id: agents.id }).from(agents)).map(row => row.id).sort();

  it('defaults to a read-only report and physically deletes only eligible rows with an explicit flag', async () => {
    await seed('stale');
    await seed('released', { status: 'released' });
    await seed('recent', { lastSeen: now });
    const before = await remaining();
    const preview = await retainAgents(db(), ws.workspaceId, options, now);
    expect(preview).toMatchObject({ dry_run: true, scanned: 3, deleted: 0, counts: { eligible: 2 } });
    expect(await remaining()).toEqual(before);
    const result = await retainAgents(db(), ws.workspaceId, { ...options, delete: true }, now);
    expect(result).toMatchObject({ deleted: 2, skipped_changed: 0 });
    expect(await remaining()).toEqual(['recent']);
    expect((await retainAgents(db(), ws.workspaceId, { ...options, delete: true }, now)).deleted).toBe(0);
  });

  it('never selects live statuses, recent observations, exact-boundary observations, or new identities', async () => {
    for (const status of ['active', 'online', 'idle', 'blocked', 'waiting', 'unknown']) {
      await seed(status, { status });
    }
    await seed('boundary', { lastSeen: cutoff });
    await seed('recent', { lastSeen: now });
    await seed('new', { createdAt: now });
    await seed('future', { lastSeen: new Date('2030-01-01') });
    const before = await remaining();
    for (const remove of [false, true]) {
      expect(await retainAgents(db(), ws.workspaceId, { ...options, delete: remove }, now))
        .toMatchObject({ candidates: [], deleted: 0 });
      expect(await remaining()).toEqual(before);
    }
  });

  it('fails closed for every broker ownership signal, even disconnected or inactive owners', async () => {
    await node();
    await seed('located', { locationNodeId: 'broker' });
    await seed('origin', { originNodeId: 'broker' });
    await seed('missing-location', { locationType: 'via_node' });
    await seed('unknown-location', { locationType: 'unknown' });
    for (const status of ['active', 'inactive', 'unknown']) {
      await seed(`binding-${status}`);
      await db().insert(agentNodeBindings).values({
        id: status, workspaceId: ws.workspaceId, agentId: `binding-${status}`, nodeId: 'broker', status,
      });
    }
    for (const metadata of [{ fleet: {} }, { broker: null }, { node_id: 'lost' }]) {
      await seed(`legacy-${Object.keys(metadata)[0]}`, { metadata });
    }
    await seed('direct');
    await node('node_direct_direct');
    const before = await remaining();
    // No connection-registry call is trusted to establish absence. An old
    // remote adapter or failed broker lookup cannot turn an association safe.
    vi.spyOn(stack.runtime.deps.nodeConnections, 'isNodeConnected').mockImplementation(() => {
      throw new Error('broker owner unavailable');
    });
    const result = await retainAgents(db(), ws.workspaceId, { ...options, delete: true }, now);
    expect(result).toMatchObject({ deleted: 0, candidates: [], counts: { ownership_protected: before.length } });
    expect(await remaining()).toEqual(before);
  });

  it('preserves a real registered direct agent even with stale offline database status', async () => {
    const agent = await registerAgent(stack.app, ws.workspaceKey, 'direct-agent');
    const { sock, handle } = await attachDirectNodeSocket(stack, ws.workspaceId, agent);
    await stack.settle();
    await db().update(agents).set({ status: 'offline', lastSeen: old, createdAt: old })
      .where(eq(agents.id, agent.agentId));
    expect(await retainAgents(db(), ws.workspaceId, { ...options, delete: true }, now))
      .toMatchObject({ candidates: [], deleted: 0, counts: { ownership_protected: 1 } });
    expect(await remaining()).toEqual([agent.agentId]);
    expect(sock.closed).toBe(false);
    await handle.handleClose();
  });

  it('protects malformed ownership and age data, and aborts on unavailable ownership evidence', async () => {
    await seed('bad-json');
    await seed('bad-age');
    await seed('array-metadata');
    await db().run(sql`UPDATE agents SET metadata = '{' WHERE id = 'bad-json'`);
    await db().run(sql`UPDATE agents SET last_seen = 'unknown' WHERE id = 'bad-age'`);
    await db().run(sql`UPDATE agents SET metadata = '[]' WHERE id = 'array-metadata'`);
    expect(await retainAgents(db(), ws.workspaceId, { ...options, delete: true }, now))
      .toMatchObject({ deleted: 0, counts: { ownership_protected: 2, recent_or_unknown: 1 } });
    await seed('potential-candidate');
    vi.spyOn(db(), 'all').mockRejectedValue(new Error('ownership database unavailable'));
    await expect(retainAgents(db(), ws.workspaceId, { ...options, delete: true }, now)).rejects.toThrow('unavailable');
    expect(await remaining()).toHaveLength(4);
  });

  it.each(['agent_node_bindings', 'nodes'] as const)('fails closed when the %s ownership table is missing', async (table) => {
    await seed('potential-candidate');
    await db().run(sql.raw(`ALTER TABLE ${table} RENAME TO unavailable_ownership`));
    for (const remove of [false, true]) {
      await expect(retainAgents(db(), ws.workspaceId, { ...options, delete: remove }, now))
        .rejects.toThrow();
      expect(await remaining()).toEqual(['potential-candidate']);
    }
  });

  it.each(['last_seen', 'created_at'] as const)('protects unknown, fractional, negative and boundary %s values', async (column) => {
    for (const [id, value] of [['text', 'unknown'], ['fraction', 1.5], ['negative', -1], ['boundary', cutoff.getTime() / 1000]] as const) {
      await seed(id);
      await db().run(sql`UPDATE agents SET ${sql.identifier(column)} = ${value} WHERE id = ${id}`);
    }
    const before = await remaining();
    expect(await retainAgents(db(), ws.workspaceId, { ...options, delete: true }, now))
      .toMatchObject({ deleted: 0, candidates: [], counts: { recent_or_unknown: 4 } });
    expect(await remaining()).toEqual(before);
  });

  it('indexes implicit foreign-key probes for physical deletion', async () => {
    const plan = await db().all<{ detail: string }>(sql`EXPLAIN QUERY PLAN DELETE FROM agents WHERE id = 'unused'`);
    expect(plan.filter(row => /SCAN (messages|channels|webhooks|reactions|directory_ratings|routing_failures)\b/.test(row.detail))).toEqual([]);
    expect(plan.some(row => row.detail.includes('idx_messages_agent'))).toBe(true);
  });

  it('does not scan history or delete before the required indexes are deployed', async () => {
    await seed('unowned');
    await db().run(sql`DROP INDEX idx_messages_agent`);
    expect(await retainAgents(db(), ws.workspaceId, options, now)).toMatchObject({
      candidates: [], deleted: 0, counts: { history_unverified: 1 },
    });
    await expect(retainAgents(db(), ws.workspaceId, { ...options, delete: true }, now))
      .rejects.toThrow('requires migration');
    expect(await remaining()).toEqual(['unowned']);
  });

  it.each(['messages', 'channels', 'files', 'webhooks'] as const)('preserves %s authorship and progresses past it', async (table) => {
    await seed('author');
    await seed('unused');
    await db().insert(channels).values({ id: 'history', workspaceId: ws.workspaceId, name: 'history',
      createdBy: table === 'channels' ? 'author' : null });
    if (table === 'messages') await db().insert(messages).values({
      id: 'message', workspaceId: ws.workspaceId, channelId: 'history', agentId: 'author', body: 'retained',
    });
    if (table === 'files') await db().insert(files).values({
      id: 'file', workspaceId: ws.workspaceId, uploadedBy: 'author', filename: 'retained.txt',
      contentType: 'text/plain', sizeBytes: 1, storageKey: 'retained',
    });
    if (table === 'webhooks') await db().insert(webhooks).values({
      id: 'webhook', workspaceId: ws.workspaceId, name: 'retained', channelId: 'history',
      createdBy: 'author', tokenHash: 'webhook-token',
    });
    const history = { messages, channels, files, webhooks }[table];
    const before = await db().select().from(history);
    const result = await retainAgents(db(), ws.workspaceId, { ...options, delete: true }, now);
    expect(result).toMatchObject({ deleted: 1, counts: { history_referenced: 1, eligible: 1 } });
    expect(await remaining()).toEqual(['author']);
    expect(await db().select().from(history)).toEqual(before);
  });

  it.each(['heartbeat', 'status', 'binding', 'history', 'origin', 'location', 'metadata', 'direct_node'] as const)(
    'rechecks a concurrent %s in the DELETE without interactive transaction support', async (change) => {
      await seed('racing');
      await node();
      const original = db().all.bind(db());
      vi.spyOn(db(), 'all').mockImplementation(async (query) => {
        const rows = await original(query);
        if (Array.isArray(rows) && rows.some(row => (row as { reason?: string }).reason === 'eligible')) {
          if (change === 'heartbeat') await db().update(agents).set({ lastSeen: now }).where(eq(agents.id, 'racing'));
          if (change === 'status') await db().update(agents).set({ status: 'active' }).where(eq(agents.id, 'racing'));
          if (change === 'origin') await db().update(agents).set({ originNodeId: 'broker' }).where(eq(agents.id, 'racing'));
          if (change === 'location') await db().update(agents).set({ locationNodeId: 'broker' }).where(eq(agents.id, 'racing'));
          if (change === 'metadata') await db().update(agents).set({ metadata: { broker: null } }).where(eq(agents.id, 'racing'));
          if (change === 'direct_node') await node('node_direct_racing');
          if (change === 'binding') await db().insert(agentNodeBindings).values({
            id: 'racing-binding', workspaceId: ws.workspaceId, agentId: 'racing', nodeId: 'broker',
          });
          if (change === 'history') await db().insert(channels).values({
            id: 'racing-channel', workspaceId: ws.workspaceId, name: 'racing', createdBy: 'racing',
          });
        }
        return rows;
      });
      expect(await retainAgents(db(), ws.workspaceId, { ...options, delete: true }, now))
        .toMatchObject({ deleted: 0, skipped_changed: 1 });
      expect(await remaining()).toEqual(['racing']);
    },
  );

  it('keeps the entire page when ownership becomes unavailable after preview', async () => {
    await seed('racing');
    const original = db().all.bind(db());
    vi.spyOn(db(), 'all').mockImplementation(async (query) => {
      const rows = await original(query);
      if (rows.some(row => (row as { reason?: string }).reason === 'eligible')) {
        await db().run(sql`ALTER TABLE agent_node_bindings RENAME TO unavailable_ownership`);
      }
      return rows;
    });
    await expect(retainAgents(db(), ws.workspaceId, { ...options, delete: true }, now)).rejects.toThrow();
    expect(await remaining()).toEqual(['racing']);
  });

  it('bounds pages, resumes past protected rows, and safely replays a page after interruption', async () => {
    for (let i = 0; i < 2570; i += 50) {
      await db().insert(agents).values(Array.from({ length: Math.min(50, 2570 - i) }, (_, j) => {
        const id = `backlog-${String(i + j).padStart(4, '0')}`;
        return { id, name: id, workspaceId: ws.workspaceId, tokenHash: id,
          status: (i + j) % 10 === 0 ? 'active' : 'offline', createdAt: old, lastSeen: old };
      }));
    }
    let cursor: NonNullable<Parameters<typeof retainAgents>[2]>['cursor'];
    let deleted = 0;
    let pages = 0;
    do {
      const result = await retainAgents(db(), ws.workspaceId, { ...options, delete: true, cursor }, now);
      expect(result.scanned).toBeLessThanOrEqual(100);
      deleted += result.deleted;
      pages++;
      cursor = result.next_cursor ?? undefined;
    } while (cursor);
    expect(deleted).toBe(2313);
    expect(pages).toBe(26);
    expect(await remaining()).toHaveLength(257);
    const replay = await retainAgents(db(), ws.workspaceId, { ...options, delete: true }, now);
    expect(replay.deleted).toBe(0);
    expect(replay.next_cursor).not.toBeNull();
  });

  it('rejects cross-workspace or shortened-window resume cursors and scopes all writes', async () => {
    await seed('stale');
    const other = await createWorkspace(stack.app, 'other');
    await seed('other', { workspaceId: other.workspaceId });
    const cursor = { workspace_id: other.workspaceId, cutoff: cutoff.getTime() / 1000, after: '', through: 'z' };
    await expect(retainAgents(db(), ws.workspaceId, { ...options, delete: true, cursor }, now)).rejects.toThrow('cursor');
    await expect(retainAgents(db(), other.workspaceId, { retention_days: 30, cursor }, now)).rejects.toThrow('cursor');
    expect((await retainAgents(db(), ws.workspaceId, { ...options, delete: true }, now)).deleted).toBe(1);
    expect(await remaining()).toEqual(['other']);
  });

  it('requires a workspace key and validates destructive input strictly', async () => {
    const agent = await registerAgent(stack.app, ws.workspaceKey, 'caller');
    for (const token of ['', agent.token]) {
      const res = await stack.app.request('/v1/agents/retention', {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}',
      });
      expect([401, 403]).toContain(res.status);
    }
    for (const body of [{ delete: 'true' }, { retention_days: 0 }, { retention_days: -1 }, { limit: 101 }, { dry_run: false }]) {
      const res = await stack.app.request('/v1/agents/retention', {
        method: 'POST', headers: { authorization: `Bearer ${ws.workspaceKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
    await seed('expired');
    const res = await stack.app.request('/v1/agents/retention', {
      method: 'POST', headers: { authorization: `Bearer ${ws.workspaceKey}`, 'content-type': 'application/json' }, body: '{}',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, data: { dry_run: true, deleted: 0 } });
    expect(await remaining()).toContain('expired');
  });
});
