import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine } from '../../engine.js';
import { createNodeRuntime, type NodeRuntime } from '../../adapters/node/index.js';
import { nodes } from '../../db/schema.js';
import { enqueueEvent, sweepPendingEvents } from '../../engine/eventQueue.js';
import { FakeSocket, createWorkspace } from './harness.js';

// File-backed so transactions run on isolated connections like production
// self-host (not the shared :memory: connection). Two nodes registering at
// once open write transactions on separate connections while the node
// event-queue poll issues raw, non-transactional writes on the main
// connection. On synchronous better-sqlite3 a raw write that finds the file
// locked busy-waits and freezes the event loop, so the lock-holding
// transaction can never commit — it times out with SQLITE_BUSY and the losing
// write rolls back, silently dropping a provider's registration. This is the
// residual self-host deadlock (issue #250) that the single-node
// providerAttachRace suite cannot surface because it has no second node to
// contend the writer and no concurrent raw-write traffic.
function fileStack() {
  const dir = mkdtempSync(join(tmpdir(), 'relaycast-two-node-'));
  const runtime: NodeRuntime = createNodeRuntime({
    dbPath: join(dir, 'test.db'),
    baseUrl: 'http://localhost:0',
    migrate: true,
    config: { environment: 'test' },
    presence: { ttlMs: 60_000, sweepIntervalMs: 0 },
  });
  const app = createEngine(runtime.deps);
  return { app, runtime, close: () => { runtime.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function registerFrame(
  nodeId: string,
  name: string,
  provider: { name: string; instance_id: string },
  caps: Array<{ name: string; kind: string }>,
) {
  return JSON.stringify({
    v: 1, id: `reg-${nodeId}`, type: 'node.register', name, node_id: nodeId,
    provider, capabilities: caps, max_agents: 4, tags: ['t'], version: 'v1', resume_cursor: null,
  });
}

describe('two-node write contention (self-host)', () => {
  let stack: ReturnType<typeof fileStack>;
  beforeEach(() => { stack = fileStack(); });
  afterEach(() => stack.close());

  async function enroll(wsKey: string, nodeId: string, name: string) {
    const res = await stack.app.request('/v1/nodes', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${wsKey}` },
      body: JSON.stringify({ node_id: nodeId, name, role: 'broker', capabilities: [], max_agents: 4, tags: ['t'], version: 'v0' }),
    });
    expect(res.status).toBe(201);
  }

  async function nodeCapNames(workspaceId: string, nodeId: string): Promise<string[]> {
    const [row] = await stack.runtime.handle.db
      .select({ caps: nodes.capabilities })
      .from(nodes)
      .where(and(eq(nodes.workspaceId, workspaceId), eq(nodes.id, nodeId)));
    return (row?.caps ?? []).map((c) => c.name).sort();
  }

  // Raw, non-transactional writes on the main connection — the node
  // event-queue poll pattern (claim increments attempts via `db.update`).
  // These are the writes that busy-wait the event loop under the pre-fix
  // adapter while a register transaction holds the write lock.
  async function pollTraffic(workspaceId: string, rounds: number): Promise<void> {
    for (let i = 0; i < rounds; i++) {
      await enqueueEvent(stack.runtime.handle.db, workspaceId, 'contention.probe', { i });
      await sweepPendingEvents(stack.runtime.handle.db, { leaseMs: 1 });
    }
  }

  it('keeps both nodes\' broker providers when they register while the event-queue poll writes', async () => {
    for (let i = 0; i < 15; i++) {
      const ws = await createWorkspace(stack.app, `two-node-${i}`);
      const nodeA = `node_a_${i}`;
      const nodeB = `node_b_${i}`;
      await enroll(ws.workspaceKey, nodeA, `alpha${i}`);
      await enroll(ws.workspaceKey, nodeB, `beta${i}`);

      const sa = new FakeSocket();
      const ha = stack.runtime.realtime.attachNodeSocket(ws.workspaceId, nodeA, sa);
      const sb = new FakeSocket();
      const hb = stack.runtime.realtime.attachNodeSocket(ws.workspaceId, nodeB, sb);

      // Both nodes register their broker provider in the same instant, while raw
      // event-queue writes hammer the main connection. Pre-fix this deadlocks:
      // one node's transaction loses the SQLITE_BUSY race and rolls back,
      // dropping its capabilities from the aggregate (which node loses flips).
      await Promise.all([
        ha.handleMessage(registerFrame(nodeA, `alpha${i}`, { name: 'broker', instance_id: 'a1' }, [
          { name: 'spawn:claude', kind: 'capacity' },
          { name: 'release', kind: 'action' },
        ])),
        hb.handleMessage(registerFrame(nodeB, `beta${i}`, { name: 'broker', instance_id: 'b1' }, [
          { name: 'spawn:codex', kind: 'capacity' },
          { name: 'release', kind: 'action' },
        ])),
        pollTraffic(ws.workspaceId, 6),
      ]);

      // Neither node's registration may vanish: both keep their full broker
      // capability set.
      expect(await nodeCapNames(ws.workspaceId, nodeA)).toEqual(['release', 'spawn:claude']);
      expect(await nodeCapNames(ws.workspaceId, nodeB)).toEqual(['release', 'spawn:codex']);
    }
  });
});
