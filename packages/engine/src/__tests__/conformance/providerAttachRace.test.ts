import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine } from '../../engine.js';
import { createNodeRuntime, type NodeRuntime } from '../../adapters/node/index.js';
import { nodeProviders, nodes } from '../../db/schema.js';
import { FakeSocket, createWorkspace } from './harness.js';

// File-backed so runAtomic uses isolated transactions like production (not the
// shared :memory: connection). This is what lets a concurrent register and
// teardown expose the per-node race — before the serialization fix the register's
// isolated transaction deadlocks the teardown's write, and on async backends the
// teardown's recompute clobbers the register's aggregate.
function fileStack() {
  const dir = mkdtempSync(join(tmpdir(), 'relaycast-attach-race-'));
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

function registerFrame(nodeId: string, name: string, provider: { name: string; instance_id: string }, caps: Array<{ name: string; kind: string }>) {
  return JSON.stringify({
    v: 1, id: `reg-${provider.name}`, type: 'node.register', name, node_id: nodeId,
    provider, capabilities: caps, max_agents: 4, tags: ['t'], version: 'v1', resume_cursor: null,
  });
}

describe('provider attach race', () => {
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
  async function providerNames(workspaceId: string, nodeId: string): Promise<string[]> {
    const rows = await stack.runtime.handle.db
      .select({ name: nodeProviders.name })
      .from(nodeProviders)
      .where(and(eq(nodeProviders.workspaceId, workspaceId), eq(nodeProviders.nodeId, nodeId)));
    return rows.map((r) => r.name).sort();
  }

  it('keeps both providers in the node aggregate when two attach concurrently', async () => {
    for (let i = 0; i < 25; i++) {
      const ws = await createWorkspace(stack.app, `attach-${i}`);
      const nodeId = `node_${i}`;
      await enroll(ws.workspaceKey, nodeId, `alpha${i}`);
      const a = new FakeSocket(); const ha = stack.runtime.realtime.attachNodeSocket(ws.workspaceId, nodeId, a);
      const b = new FakeSocket(); const hb = stack.runtime.realtime.attachNodeSocket(ws.workspaceId, nodeId, b);
      await Promise.all([
        ha.handleMessage(registerFrame(nodeId, `alpha${i}`, { name: 'broker', instance_id: 'b1' }, [{ name: 'spawn:claude', kind: 'capacity' }])),
        hb.handleMessage(registerFrame(nodeId, `alpha${i}`, { name: 'py', instance_id: 'p1' }, [{ name: 'run-etl', kind: 'action' }])),
      ]);
      expect(await providerNames(ws.workspaceId, nodeId)).toEqual(['broker', 'py']);
      expect(await nodeCapNames(ws.workspaceId, nodeId)).toEqual(['run-etl', 'spawn:claude']);
    }
  });

  it('keeps a stable aggregate when a register races another provider disconnecting', async () => {
    for (let i = 0; i < 25; i++) {
      const ws = await createWorkspace(stack.app, `disc-${i}`);
      const nodeId = `node_${i}`;
      await enroll(ws.workspaceKey, nodeId, `alpha${i}`);
      const a = new FakeSocket(); const ha = stack.runtime.realtime.attachNodeSocket(ws.workspaceId, nodeId, a);
      await ha.handleMessage(registerFrame(nodeId, `alpha${i}`, { name: 'broker', instance_id: 'b1' }, [{ name: 'spawn:claude', kind: 'capacity' }]));
      const b = new FakeSocket(); const hb = stack.runtime.realtime.attachNodeSocket(ws.workspaceId, nodeId, b);
      // The broker disconnects at the same instant the py provider registers.
      await Promise.all([
        hb.handleMessage(registerFrame(nodeId, `alpha${i}`, { name: 'py', instance_id: 'p1' }, [{ name: 'run-etl', kind: 'action' }])),
        ha.handleClose(),
      ]);
      // The broker's row persists offline (manifest), py is online; neither cap
      // set is clobbered out of the aggregate.
      expect(await providerNames(ws.workspaceId, nodeId)).toEqual(['broker', 'py']);
      expect(await nodeCapNames(ws.workspaceId, nodeId)).toEqual(['run-etl', 'spawn:claude']);
    }
  });

  it('resolves two providers claiming the same name deterministically, without silent cap loss', async () => {
    const winners = new Set<string>();
    for (let i = 0; i < 25; i++) {
      const ws = await createWorkspace(stack.app, `dup-${i}`);
      const nodeId = `node_${i}`;
      await enroll(ws.workspaceKey, nodeId, `alpha${i}`);
      const a = new FakeSocket(); const ha = stack.runtime.realtime.attachNodeSocket(ws.workspaceId, nodeId, a);
      const b = new FakeSocket(); const hb = stack.runtime.realtime.attachNodeSocket(ws.workspaceId, nodeId, b);
      await Promise.all([
        ha.handleMessage(registerFrame(nodeId, `alpha${i}`, { name: 'dup', instance_id: 'a1' }, [{ name: 'spawn:claude', kind: 'capacity' }])),
        hb.handleMessage(registerFrame(nodeId, `alpha${i}`, { name: 'dup', instance_id: 'b1' }, [{ name: 'run-etl', kind: 'action' }])),
      ]);
      // Exactly one provider row survives; the loser is rejected loudly (not a
      // silent overwrite), and the winner's caps are intact.
      expect(await providerNames(ws.workspaceId, nodeId)).toEqual(['dup']);
      const caps = await nodeCapNames(ws.workspaceId, nodeId);
      expect(caps.length).toBe(1);
      winners.add(caps[0]);
      const errors = [...a.ofType('error'), ...b.ofType('error')];
      expect(errors.some((e) => e.code === 'provider_instance_conflict')).toBe(true);
    }
    // Deterministic across runs: the first registrant always wins (no ~50% flip).
    expect(winners).toEqual(new Set(['spawn:claude']));
  });
});
