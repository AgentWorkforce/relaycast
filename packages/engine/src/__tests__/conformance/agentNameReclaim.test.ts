import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createWorkspace, FakeSocket, makeNodeStack, type TestStack } from './harness.js';
import { agents } from '../../db/schema.js';
import { AGENT_LIVENESS_TTL_MS, AGENT_RECLAIM_GRACE_MS } from '../../engine/agent.js';

/**
 * Who may take an agent's name and be issued a token for it.
 *
 * `registerAgentViaNode` overwrites `token_hash` on conflict, so a permitted
 * reclaim is a full credential handover: the incumbent's token stops working
 * and the claiming node is handed a live one for the same row. The guard on
 * that decision therefore reads observed silence (`last_seen`) rather than the
 * `status` column, which `sweepStaleAgents` rewrites on every roster read.
 */
describe('agent name reclaim across nodes', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack(); });
  afterEach(() => stack.close());

  const db = () => stack.runtime.deps.db;

  async function bringNodeOnline(
    ws: { workspaceKey: string; workspaceId: string },
    nodeId: string,
    name: string,
  ) {
    const enrolled = await stack.app.request('/v1/nodes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({
        node_id: nodeId, name, role: 'broker',
        capabilities: ['spawn:claude'], max_agents: 4, tags: ['test'], version: 'v0',
      }),
    });
    expect(enrolled.status).toBe(201);
    const sock = new FakeSocket();
    const handle = stack.runtime.realtime.attachNodeSocket(ws.workspaceId, nodeId, sock);
    await handle.handleMessage(JSON.stringify({
      v: 1, type: 'node.register', name, node_id: nodeId,
      capabilities: [{ name: 'spawn:claude', kind: 'capacity' }],
      max_agents: 4, tags: ['test'], version: 'v1', resume_cursor: null,
    }));
    await handle.handleMessage(JSON.stringify({
      v: 1, type: 'node.heartbeat', load: 0, active_agents: 0, handlers_live: true,
    }));
    return { sock, handle };
  }

  async function registerViaNode(
    node: { sock: FakeSocket; handle: { handleMessage(raw: string): Promise<void> } },
    name: string,
  ) {
    await node.handle.handleMessage(JSON.stringify({
      v: 1, type: 'agent.register', name, resumable: true,
    }));
  }

  async function agentRow(workspaceId: string, name: string) {
    const [row] = await db()
      .select({
        id: agents.id,
        tokenHash: agents.tokenHash,
        locationNodeId: agents.locationNodeId,
        status: agents.status,
      })
      .from(agents)
      .where(and(eq(agents.workspaceId, workspaceId), eq(agents.name, name)));
    return row;
  }

  /** Backdate observed activity without touching anything else. */
  async function silentFor(agentId: string, ms: number) {
    await db().update(agents).set({ lastSeen: new Date(Date.now() - ms) }).where(eq(agents.id, agentId));
  }

  it('a roster read does not make a recently-active agent reclaimable by another node', async () => {
    const ws = await createWorkspace(stack.app, 'reclaim-roster-read');
    const alpha = await bringNodeOnline(ws, 'node_alpha', 'alpha');
    const beta = await bringNodeOnline(ws, 'node_beta', 'beta');

    await registerViaNode(alpha, 'contested');
    const before = await agentRow(ws.workspaceId, 'contested');
    expect(before.locationNodeId).toBe('node_alpha');

    // Silent long enough to be absent from the roster, far short of the
    // reclaim grace. This is the ordinary state of a working agent between
    // bursts of activity.
    await silentFor(before.id, AGENT_LIVENESS_TTL_MS * 2);

    // A plain roster read. This sweeps, so it rewrites `status` — which is
    // exactly the write that used to widen the reclaim guard.
    const roster = await stack.app.request('/v1/agents', {
      headers: { authorization: `Bearer ${ws.workspaceKey}` },
    });
    expect(roster.status).toBe(200);
    const swept = await agentRow(ws.workspaceId, 'contested');
    // Confirm the read really did flip the column, so this test cannot pass
    // by the sweep silently not running.
    expect(swept.status).toBe('offline');

    // A foreign node now claims the name.
    await registerViaNode(beta, 'contested');

    const after = await agentRow(ws.workspaceId, 'contested');
    expect(after.locationNodeId).toBe('node_alpha');
    expect(after.tokenHash).toBe(before.tokenHash);
    expect(after.id).toBe(before.id);
  });

  it('an agent silent beyond the reclaim grace can be reclaimed by another node', async () => {
    const ws = await createWorkspace(stack.app, 'reclaim-after-grace');
    const alpha = await bringNodeOnline(ws, 'node_alpha', 'alpha');
    const beta = await bringNodeOnline(ws, 'node_beta', 'beta');

    await registerViaNode(alpha, 'abandoned');
    const before = await agentRow(ws.workspaceId, 'abandoned');
    await silentFor(before.id, AGENT_RECLAIM_GRACE_MS + 60_000);

    await registerViaNode(beta, 'abandoned');

    // The grace window must expire into something, or a name stranded by a
    // dead node would be unrecoverable.
    const after = await agentRow(ws.workspaceId, 'abandoned');
    expect(after.locationNodeId).toBe('node_beta');
    expect(after.tokenHash).not.toBe(before.tokenHash);
  });

  it('the owning node can re-register its own agent inside the grace window', async () => {
    const ws = await createWorkspace(stack.app, 'reclaim-own-node');
    const alpha = await bringNodeOnline(ws, 'node_alpha', 'alpha');

    await registerViaNode(alpha, 'restarted');
    const before = await agentRow(ws.workspaceId, 'restarted');
    await silentFor(before.id, AGENT_LIVENESS_TTL_MS * 2);

    // A node restart must never be blocked by the grace window — that would
    // make the guard a fail-closed gate with no recovery path.
    await registerViaNode(alpha, 'restarted');

    const after = await agentRow(ws.workspaceId, 'restarted');
    expect(after.id).toBe(before.id);
    expect(after.locationNodeId).toBe('node_alpha');
    expect(after.status).toBe('active');
  });
});
