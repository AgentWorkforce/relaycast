import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { nodes } from '../../db/tables.js';
import { listNodes, NODE_ONLINE_CANDIDATE_RECENCY_MS } from '../../engine/node.js';
import { configureNodeLiveness } from '../../engine/nodeLiveness.js';
import { NODE_LIVENESS_TTL_MS } from '../../engine/placement.js';
import { NODE_LIVENESS_CHECKPOINT_INTERVAL_MS, type NodeLivenessSnapshot } from '../../ports/nodeLiveness.js';
import { createWorkspace, FakeSocket, makeNodeStack, type TestStack } from './harness.js';

const T0 = Date.UTC(2026, 10, 2, 12, 0, 0);

const live = (): NodeLivenessSnapshot => ({ status: 'online', providers: [{
  name: 'default', live: true, handlers_live: true, last_received_at: Date.now() - 1_000, expires_at: Date.now() + 44_000,
}] });

describe('GET /v1/nodes?status=online under a liveness authority', () => {
  let stack: TestStack;
  let workspaceId: string;
  let workspaceKey: string;
  let inspected: string[];
  let liveIds: Set<string>;
  let unknownIds: Set<string>;
  /** Replaces the default probe for a node; the default answers from `liveIds`. */
  let probeOverride: (nodeId: string) => Promise<NodeLivenessSnapshot> | undefined;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    stack = makeNodeStack();
    ({ workspaceId, workspaceKey } = await createWorkspace(stack.app, 'node-list-bound'));
    inspected = [];
    liveIds = new Set();
    unknownIds = new Set();
    probeOverride = () => undefined;
    configureNodeLiveness(stack.runtime.deps.db, {
      inspect: async (_workspace, nodeId) => {
        inspected.push(nodeId);
        const overridden = probeOverride(nodeId);
        if (overridden) return overridden;
        if (unknownIds.has(nodeId)) return { status: 'unknown', providers: [] };
        return liveIds.has(nodeId) ? live() : { status: 'offline', providers: [] };
      },
    });
  });
  afterEach(async () => {
    await stack.close();
    vi.useRealTimers();
  });

  /** Enroll, register and heartbeat through the node socket: a real checkpoint. */
  async function checkpointedNode(nodeId: string) {
    const res = await stack.app.request('/v1/nodes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${workspaceKey}` },
      body: JSON.stringify({ node_id: nodeId, name: nodeId, role: 'broker', capabilities: [], max_agents: 4, tags: [], version: 'v1' }),
    });
    expect(res.status).toBe(201);
    const handle = stack.runtime.realtime.attachNodeSocket(workspaceId, nodeId, new FakeSocket());
    await handle.handleMessage(JSON.stringify({
      v: 1, id: `reg-${nodeId}`, type: 'node.register', name: nodeId, node_id: nodeId,
      provider: { name: 'default', instance_id: 'i1' }, capabilities: [], max_agents: 4, tags: [], version: 'v1', resume_cursor: null,
    }));
    await handle.handleMessage(JSON.stringify({
      v: 1, type: 'node.heartbeat', provider: { name: 'default', instance_id: 'i1' }, active_agents: 0, handlers_live: true,
    }));
    const [row] = await stack.runtime.deps.db.select().from(nodes).where(eq(nodes.id, nodeId));
    expect(row).toMatchObject({ status: 'online' });
    liveIds.add(nodeId);
  }

  /** Long-dead rows a large hosted workspace retains: offline, or never claimed offline. */
  function seedStaleRows(count: number) {
    const insert = stack.runtime.handle.sqlite.prepare(
      'INSERT INTO nodes (id, workspace_id, name, token_hash, status, last_heartbeat_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const staleSecond = Math.floor((T0 - NODE_ONLINE_CANDIDATE_RECENCY_MS) / 1_000) - 60;
    for (let i = 0; i < count; i += 1) {
      insert.run(`nd_stale_${String(i).padStart(3, '0')}`, workspaceId, `stale-${i}`, `hash-${i}`, i % 3 === 0 ? 'online' : 'offline', staleSecond - i);
    }
  }

  /** Rows inside the online candidate bound that the authority answers for: checkpointed recently, stored offline. */
  function seedRecentRows(count: number) {
    const insert = stack.runtime.handle.sqlite.prepare(
      'INSERT INTO nodes (id, workspace_id, name, token_hash, status, last_heartbeat_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const recentSecond = Math.floor(T0 / 1_000) - 10;
    for (let i = 0; i < count; i += 1) {
      insert.run(`nd_recent_${String(i).padStart(3, '0')}`, workspaceId, `recent-${i}`, `rhash-${i}`, 'offline', recentSecond);
    }
  }

  it('probes only checkpoint-recent online rows: 3 live among 303 rows costs 3 probes', async () => {
    seedStaleRows(300);
    for (const id of ['nd_live_a', 'nd_live_b', 'nd_live_c']) await checkpointedNode(id);
    inspected = [];

    const page = await listNodes(stack.runtime.deps.db, workspaceId, { status: 'online' });

    expect(page.nodes.map(node => node.id)).toEqual(['nd_live_a', 'nd_live_b', 'nd_live_c']);
    expect(page.nodes.every(node => node.status === 'online' && node.live)).toBe(true);
    expect(inspected.sort()).toEqual(['nd_live_a', 'nd_live_b', 'nd_live_c']);
  });

  it('still lists a node whose last checkpoint is a full interval plus lease old', async () => {
    await checkpointedNode('nd_quiet');
    // The authority absorbs unchanged heartbeats for up to the checkpoint
    // interval and holds the last receipt for the lease after that: this is
    // the oldest checkpoint an online node can have.
    vi.setSystemTime(T0 + NODE_LIVENESS_CHECKPOINT_INTERVAL_MS + NODE_LIVENESS_TTL_MS);
    expect((await listNodes(stack.runtime.deps.db, workspaceId, { status: 'online' })).nodes.map(node => node.id)).toEqual(['nd_quiet']);
    // The hosted authority sheds a checkpoint refused under database pressure
    // and retries nothing: the next heartbeat, 30 s later, is the next
    // attempt. Three shed in a row (the old 60 s slack ends at 405 s) still
    // leave the node listed, as does a run of nearly four minutes.
    vi.setSystemTime(T0 + NODE_LIVENESS_CHECKPOINT_INTERVAL_MS + NODE_LIVENESS_TTL_MS + 3 * 30_000);
    expect((await listNodes(stack.runtime.deps.db, workspaceId, { status: 'online' })).nodes.map(node => node.id)).toEqual(['nd_quiet']);
    expect(NODE_ONLINE_CANDIDATE_RECENCY_MS).toBe(NODE_LIVENESS_TTL_MS + NODE_LIVENESS_CHECKPOINT_INTERVAL_MS + 240_000);
    vi.setSystemTime(T0 + NODE_ONLINE_CANDIDATE_RECENCY_MS - 1_000);
    expect((await listNodes(stack.runtime.deps.db, workspaceId, { status: 'online' })).nodes.map(node => node.id)).toEqual(['nd_quiet']);
    // Past the bound the authority cannot report it online; it is not probed.
    inspected = [];
    vi.setSystemTime(T0 + NODE_ONLINE_CANDIDATE_RECENCY_MS + 2_000);
    expect((await listNodes(stack.runtime.deps.db, workspaceId, { status: 'online' })).nodes).toEqual([]);
    expect(inspected).toEqual([]);
  });

  it('lists a checkpoint-recent node the authority reports online whatever its stored status', async () => {
    await checkpointedNode('nd_projection');
    await stack.runtime.deps.db.update(nodes).set({ status: 'offline' }).where(eq(nodes.id, 'nd_projection'));
    vi.setSystemTime(T0 + NODE_LIVENESS_CHECKPOINT_INTERVAL_MS);
    expect((await listNodes(stack.runtime.deps.db, workspaceId, { status: 'online' })).nodes.map(node => node.id)).toEqual(['nd_projection']);
  });

  it('keeps offline selection over every row, probing only checkpoint-recent ones', async () => {
    seedStaleRows(4);
    await checkpointedNode('nd_recent_down');
    await checkpointedNode('nd_recent_up');
    liveIds.delete('nd_recent_down');
    inspected = [];
    const page = await listNodes(stack.runtime.deps.db, workspaceId, { status: 'offline' });
    expect(page.nodes.map(node => node.id)).toEqual(['nd_recent_down', 'nd_stale_000', 'nd_stale_001', 'nd_stale_002', 'nd_stale_003']);
    // Rows past the online bound cannot be online: listed offline, unprobed,
    // whatever their stored status (nd_stale_000 and nd_stale_003 store online).
    expect(inspected.sort()).toEqual(['nd_recent_down', 'nd_recent_up']);
    expect(page.nodes.every(node => node.status === 'offline' && !node.live)).toBe(true);
  });

  it('stops probing at limit matches and returns the first matches in id order', async () => {
    seedRecentRows(30);
    const page = await listNodes(stack.runtime.deps.db, workspaceId, { status: 'offline', limit: 5 });
    expect(page.nodes.map(node => node.id)).toEqual(['nd_recent_000', 'nd_recent_001', 'nd_recent_002', 'nd_recent_003', 'nd_recent_004']);
    // Eight probes are in flight when the fifth match lands; none start after.
    expect(inspected.length).toBeGreaterThanOrEqual(5);
    expect(inspected.length).toBeLessThanOrEqual(5 + 7);
  });

  it('returns the first limit matches in id order even when a later probe resolves first', async () => {
    for (const id of ['nd_a', 'nd_b', 'nd_c', 'nd_d']) await checkpointedNode(id);
    inspected = [];
    // nd_a's probe is held until every other probe has been issued and
    // answered; nd_b..nd_d match first and reach the limit while it hangs.
    let releaseA: (snapshot: NodeLivenessSnapshot) => void = () => {};
    let lastIssued: () => void = () => {};
    const lastProbeIssued = new Promise<void>((resolve) => { lastIssued = resolve; });
    probeOverride = (nodeId) => {
      if (nodeId === 'nd_d') lastIssued();
      if (nodeId !== 'nd_a') return undefined;
      return new Promise<NodeLivenessSnapshot>((resolve) => { releaseA = resolve; });
    };
    const pending = listNodes(stack.runtime.deps.db, workspaceId, { status: 'online', limit: 2 });
    await lastProbeIssued;
    // Let nd_b..nd_d's answers land (and reach the limit) while nd_a hangs.
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(inspected).toEqual(['nd_a', 'nd_b', 'nd_c', 'nd_d']);
    releaseA(live());
    expect((await pending).nodes.map(node => node.id)).toEqual(['nd_a', 'nd_b']);
  });

  it('skips an unknown snapshot under limit instead of counting it', async () => {
    for (const id of ['nd_a', 'nd_b', 'nd_c']) await checkpointedNode(id);
    unknownIds.add('nd_a');
    const page = await listNodes(stack.runtime.deps.db, workspaceId, { status: 'online', limit: 2 });
    expect(page.nodes.map(node => node.id)).toEqual(['nd_b', 'nd_c']);
  });


  it('applies limit to the authority-filtered result, not to the candidate rows', async () => {
    for (const id of ['nd_a', 'nd_b', 'nd_c', 'nd_d']) await checkpointedNode(id);
    liveIds.delete('nd_a');
    liveIds.delete('nd_c');
    const page = await listNodes(stack.runtime.deps.db, workspaceId, { status: 'online', limit: 2 });
    expect(page.nodes.map(node => node.id)).toEqual(['nd_b', 'nd_d']);
  });
});

describe('GET /v1/nodes status limit without an authority', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack(); });
  afterEach(async () => { await stack.close(); });

  it('honors limit in SQL over id order', async () => {
    const { workspaceId, workspaceKey } = await createWorkspace(stack.app, 'node-list-limit');
    const insert = stack.runtime.handle.sqlite.prepare(
      'INSERT INTO nodes (id, workspace_id, name, token_hash, status, last_heartbeat_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const now = Math.floor(Date.now() / 1_000);
    for (const id of ['nd_c', 'nd_a', 'nd_d', 'nd_b']) insert.run(id, workspaceId, id, `hash-${id}`, 'online', now);
    const res = await stack.app.request('/v1/nodes?status=online&limit=2', { headers: { authorization: `Bearer ${workspaceKey}` } });
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Array<{ id: string }> };
    expect(body.data.map(node => node.id)).toEqual(['nd_a', 'nd_b']);
  });
});
