import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createWorkspace, makeNodeStack, registerAgent, type TestStack } from './harness.js';
import { workspaces } from '../../db/schema.js';
import { MIN_BOOTSTRAP_IDEMPOTENCY_KEY_LENGTH } from '../../engine/workspace.js';
import { authenticateNodeWs, authenticateRealtimeWs } from '../../engine/wsAuth.js';
import { sha256Hex } from '../../lib/crypto.js';

// Relay Connect hands out one expiring workspace per Connect as the room
// boundary, so "the link stops working at `expires_at`" has to hold without
// waiting for the reap batch to catch up (relaycast#464).
interface ExpiringRoom {
  workspaceId: string;
  workspaceKey: string;
  agentToken: string;
  agentId: string;
  nodeToken: string;
  observerToken: string;
}

// A `sender` route a node principal may call: it 404s on a live workspace, so
// the status flip to 401 isolates the expiry gate from route authorization.
const NODE_SENDER_PATH = '/v1/actions/spawn/invocations/inv_does_not_exist';

describe('workspace expiry at authentication', () => {
  let stack: TestStack;

  beforeEach(() => { stack = makeNodeStack(); });
  afterEach(() => stack.close());

  async function makeRoom(name: string): Promise<ExpiringRoom> {
    const created = await stack.app.request('/v1/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, expires_in_seconds: 60 }),
    });
    expect(created.status).toBe(201);
    const workspace = await created.json() as {
      data: { workspace_id: string; api_key: string; expires_at: string | null };
    };
    expect(workspace.data.expires_at).not.toBeNull();
    const workspaceKey = workspace.data.api_key;

    const agent = await registerAgent(stack.app, workspaceKey, 'room-member');

    const enrolled = await stack.app.request('/v1/nodes', {
      method: 'POST',
      headers: { authorization: `Bearer ${workspaceKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        node_id: 'expiry-node', name: 'expiry-node', role: 'broker',
        capabilities: [], max_agents: 2, tags: [], version: 'test',
      }),
    });
    expect(enrolled.status).toBe(201);
    const node = await enrolled.json() as { data: { token: string } };

    const minted = await stack.app.request('/v1/observer-tokens', {
      method: 'POST',
      headers: { authorization: `Bearer ${workspaceKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'room-observer', scopes: ['stream:read', 'agents:read'] }),
    });
    expect(minted.status).toBe(201);
    const observer = await minted.json() as { data: { token: string } };

    return {
      workspaceId: workspace.data.workspace_id,
      workspaceKey,
      agentToken: agent.token,
      agentId: agent.agentId,
      nodeToken: node.data.token,
      observerToken: observer.data.token,
    };
  }

  /** Move the stored deadline into the past without waiting for wall-clock. */
  async function setExpiry(workspaceId: string, expiresAt: Date | null): Promise<void> {
    await stack.runtime.handle.db
      .update(workspaces)
      .set({ expiresAt })
      .where(eq(workspaces.id, workspaceId));
  }

  function get(path: string, token: string): Promise<Response> {
    return stack.app.request(path, { headers: { authorization: `Bearer ${token}` } });
  }

  async function expectExpired(response: Response): Promise<void> {
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: 'workspace_expired' },
    });
  }

  it('rejects every credential kind once the workspace is past its deadline', async () => {
    const room = await makeRoom('expired-room');

    // Live workspace: the same calls that must fail after expiry pass before it.
    expect((await get('/v1/agents', room.workspaceKey)).status).toBe(200);
    expect((await get('/v1/inbox', room.agentToken)).status).toBe(200);
    // Node tokens are admitted on `sender` routes; a missing invocation 404s
    // while the workspace is live, so a 401 there is the expiry gate firing.
    expect((await get(NODE_SENDER_PATH, room.nodeToken)).status).toBe(404);
    expect((await get('/v1/agents', room.observerToken)).status).toBe(200);

    await setExpiry(room.workspaceId, new Date(Date.now() - 1_000));

    // Workspace key: reads and writes both stop.
    await expectExpired(await get('/v1/agents', room.workspaceKey));
    await expectExpired(await stack.app.request('/v1/agents', {
      method: 'POST',
      headers: { authorization: `Bearer ${room.workspaceKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'late-joiner' }),
    }));
    // Agent token.
    await expectExpired(await get('/v1/inbox', room.agentToken));
    // Node token.
    await expectExpired(await get(NODE_SENDER_PATH, room.nodeToken));
    // Observer token.
    await expectExpired(await get('/v1/agents', room.observerToken));
  });

  it('rejects both WebSocket upgrade paths once the workspace is past its deadline', async () => {
    const room = await makeRoom('expired-ws-room');
    const deps = { auth: stack.runtime.deps.auth, db: stack.runtime.deps.db };

    expect(await authenticateRealtimeWs(deps, room.observerToken)).toMatchObject({ ok: true });
    expect(await authenticateNodeWs(deps, room.nodeToken)).toMatchObject({ ok: true });

    await setExpiry(room.workspaceId, new Date(Date.now() - 1_000));

    expect(await authenticateRealtimeWs(deps, room.observerToken)).toMatchObject({
      ok: false, status: 401, code: 'workspace_expired', upgradeMessage: 'Unauthorized',
    });
    expect(await authenticateNodeWs(deps, room.nodeToken)).toMatchObject({
      ok: false, status: 401, code: 'workspace_expired', upgradeMessage: 'Unauthorized',
    });
  });

  it('treats the deadline itself as expired and an unset deadline as live', async () => {
    const room = await makeRoom('deadline-boundary-room');

    const now = new Date();
    await setExpiry(room.workspaceId, now);
    await expectExpired(await get('/v1/agents', room.workspaceKey));

    await setExpiry(room.workspaceId, new Date(now.getTime() + 60_000));
    expect((await get('/v1/agents', room.workspaceKey)).status).toBe(200);

    await setExpiry(room.workspaceId, null);
    expect((await get('/v1/agents', room.workspaceKey)).status).toBe(200);
  });

  it('leaves a workspace that never opted into expiry alone', async () => {
    const ws = await createWorkspace(stack.app, 'persistent-room');
    const [row] = await stack.runtime.handle.db
      .select({ expiresAt: workspaces.expiresAt })
      .from(workspaces)
      .where(eq(workspaces.id, ws.workspaceId));
    expect(row.expiresAt).toBeNull();
    expect((await get('/v1/agents', ws.workspaceKey)).status).toBe(200);
  });

  it('refuses a node whose workspace row is gone rather than admitting it', async () => {
    const room = await makeRoom('orphaned-node-room');
    const deps = { auth: stack.runtime.deps.auth, db: stack.runtime.deps.db };
    expect(await authenticateNodeWs(deps, room.nodeToken)).toMatchObject({ ok: true });

    // The expiry read is the node upgrade's only workspace lookup, so a missing
    // row must fail closed instead of falling through to `ok: true`.
    stack.runtime.handle.sqlite.pragma('foreign_keys = OFF');
    try {
      await stack.runtime.handle.db.delete(workspaces).where(eq(workspaces.id, room.workspaceId));
    } finally {
      stack.runtime.handle.sqlite.pragma('foreign_keys = ON');
    }

    expect(await authenticateNodeWs(deps, room.nodeToken)).toMatchObject({
      ok: false, status: 401, code: 'invalid_token',
    });
  });

  it('reports workspace expiry, not a recovery refusal, for an expired agent token', async () => {
    const room = await makeRoom('expired-recovery-token-room');

    await setExpiry(room.workspaceId, new Date(Date.now() - 1_000));

    await expectExpired(await stack.app.request('/v1/agents/room-member/recover', {
      method: 'POST',
      headers: { authorization: `Bearer ${room.agentToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ expected_agent_id: room.agentId }),
    }));
  });

  it('refuses work-unit proof recovery once the workspace is past its deadline', async () => {
    const room = await makeRoom('expired-recovery-proof-room');
    const proof = 'expiring-work-unit-proof';
    const registered = await stack.app.request('/v1/agents', {
      method: 'POST',
      headers: { authorization: `Bearer ${room.workspaceKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'proof-holder', recovery_proof_hash: await sha256Hex(proof) }),
    });
    expect(registered.status).toBe(201);
    const { data } = await registered.json() as { data: { id: string } };

    await setExpiry(room.workspaceId, new Date(Date.now() - 1_000));

    // The proof is valid and matches the identity, so only the expiry gate
    // stands between it and a freshly rotated token.
    await expectExpired(await stack.app.request('/v1/agents/proof-holder/recover', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expected_agent_id: data.id, recovery_proof: proof }),
    }));
  });

  it('refuses inbound A2A webhook delivery once the workspace is past its deadline', async () => {
    const room = await makeRoom('expired-a2a-room');
    const registered = await stack.app.request('/v1/a2a/register', {
      method: 'POST',
      headers: { authorization: `Bearer ${room.workspaceKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        agent_card: {
          name: 'peer',
          url: 'https://peer.example/a2a/rpc',
          version: '1.0.0',
          skills: [{ id: 'peer', name: 'peer' }],
        },
        target_agent: 'peer',
      }),
    });
    const registeredBody = await registered.json();
    expect(registered.status, JSON.stringify(registeredBody)).toBe(201);
    const { data } = registeredBody as { data: { relay_token: string; webhook_url: string } };
    const webhookPath = new URL(data.webhook_url, 'http://localhost').pathname;
    const deliver = () => stack.app.request(webhookPath, {
      method: 'POST',
      headers: { authorization: `Bearer ${data.relay_token}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    // Live: the token is accepted and the empty body fails JSON-RPC parsing.
    expect((await deliver()).status).toBe(400);

    await setExpiry(room.workspaceId, new Date(Date.now() - 1_000));

    await expectExpired(await deliver());
  });

  it('refuses to mint a child workspace from an expired owner key', async () => {
    const room = await makeRoom('expired-owner-room');
    await setExpiry(room.workspaceId, new Date(Date.now() - 1_000));

    const response = await stack.app.request('/v1/workspaces', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${room.workspaceKey}`,
        'content-type': 'application/json',
        'Idempotency-Key': `child:${'a'.repeat(MIN_BOOTSTRAP_IDEMPOTENCY_KEY_LENGTH)}`,
      },
      body: JSON.stringify({ name: 'child-of-expired' }),
    });
    await expectExpired(response);
  });
});

// Rejecting at auth is the boundary callers see; the reap is what stops an
// abandoned room from lingering in storage. It has to be periodic, because a
// deployment that never creates another workspace never triggers a lazy reap.
describe('periodic workspace expiry reap', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('deletes an expired workspace on the maintenance interval with no further API traffic', async () => {
    // Fake only the interval: the sweep must fire on a tick we control while
    // promises, Date, and better-sqlite3 stay on real time.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const stack = makeNodeStack();
    try {
      const ws = await createWorkspace(stack.app, 'reaped-room');
      await stack.runtime.handle.db
        .update(workspaces)
        .set({ expiresAt: new Date(Date.now() - 1_000) })
        .where(eq(workspaces.id, ws.workspaceId));

      vi.advanceTimersByTime(15_000);

      const deadline = Date.now() + 5_000;
      let rows = await stack.runtime.handle.db
        .select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, ws.workspaceId));
      while (rows.length > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        rows = await stack.runtime.handle.db
          .select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, ws.workspaceId));
      }
      expect(rows).toEqual([]);
    } finally {
      await stack.close();
    }
  });
});
