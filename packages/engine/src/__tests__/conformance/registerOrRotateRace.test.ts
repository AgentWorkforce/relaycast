import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { agents } from '../../db/schema.js';
import { rotateAgentToken } from '../../engine/tokenRotate.js';
import { createWorkspace, makeNodeStack, registerAgent, type TestStack } from './harness.js';

/**
 * Regression coverage for relay#1542. Two clients that concurrently roll over
 * the same currently authenticated identity each receive a fresh token.
 * The stored `token_hash` is a single slot, so the later rotate would invalidate
 * the earlier caller's token silently — the caller was handed a 200 response
 * plus a credential that stopped working microseconds later.
 *
 * The fix keeps the previous credential live for a short grace window so both
 * callers can present the token they were handed and be recognised as the agent
 * they registered under. Once the grace window elapses, only the most recent
 * token authenticates and everything older stays revoked.
 */
describe('authenticated agent token rollover concurrency', () => {
  let stack: TestStack;

  beforeEach(() => { stack = makeNodeStack(); });
  afterEach(() => stack.close());

  async function rotate(agentToken: string, name: string): Promise<Response> {
    return stack.app.request(`/v1/agents/${name}/rotate-token`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${agentToken}`,
        'content-type': 'application/json',
      },
      body: '{}',
    });
  }

  async function tokenFrom(res: Response): Promise<string> {
    const body = await res.json() as { data?: { token?: string } };
    return body.data?.token ?? '';
  }

  async function authenticate(agentToken: string): Promise<Response> {
    return stack.app.request('/v1/agent', {
      headers: { authorization: `Bearer ${agentToken}` },
    });
  }

  it('both concurrent rotations yield tokens that authenticate', async () => {
    const workspace = await createWorkspace(stack.app, 'race-both-authenticate');
    const initial = await registerAgent(stack.app, workspace.workspaceKey, 'chief');

    const [rotateA, rotateB] = await Promise.all([
      rotate(initial.token, 'chief'),
      rotate(initial.token, 'chief'),
    ]);

    expect(rotateA.status).toBe(200);
    expect(rotateB.status).toBe(200);

    const tokenA = await tokenFrom(rotateA);
    const tokenB = await tokenFrom(rotateB);
    expect(tokenA).toMatch(/^at_live_[0-9a-f]{32}$/);
    expect(tokenB).toMatch(/^at_live_[0-9a-f]{32}$/);
    expect(tokenA).not.toBe(tokenB);

    // MUST-FIRE: both callers keep working credentials after the race.
    const [authA, authB] = await Promise.all([
      authenticate(tokenA),
      authenticate(tokenB),
    ]);
    expect(authA.status).toBe(200);
    expect(authB.status).toBe(200);
  });

  it('rejects a revoked (deleted-agent) token even during a grace window', async () => {
    const workspace = await createWorkspace(stack.app, 'race-revoked-token');
    const initial = await registerAgent(stack.app, workspace.workspaceKey, 'ephemeral');
    expect((await authenticate(initial.token)).status).toBe(200);

    // Rotate once first so the grace slot (`previous_token_hash`) is actually
    // populated. Without this, the delete path is trivially satisfied by a
    // null slot and the test would pass even if release never cleared grace.
    const rotateRes = await rotate(initial.token, 'ephemeral');
    expect(rotateRes.status).toBe(200);
    const currentToken = await tokenFrom(rotateRes);
    // Both slots hold a live credential before the delete: the initial token
    // is now in the grace slot; `currentToken` is in the current slot.
    expect((await authenticate(initial.token)).status).toBe(200);
    expect((await authenticate(currentToken)).status).toBe(200);

    const del = await stack.app.request('/v1/agents/ephemeral', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${workspace.workspaceKey}` },
    });
    expect(del.status).toBe(204);

    // MUST-NOT-FIRE: a revoked identity is not rescued by either slot — the
    // current token AND the token still inside its grace window are both
    // rejected. If release stops clearing grace, this second assertion goes
    // red immediately.
    expect((await authenticate(currentToken)).status).toBe(401);
    expect((await authenticate(initial.token)).status).toBe(401);
  });

  it('only the two most recent tokens stay valid under chained rotations', async () => {
    const workspace = await createWorkspace(stack.app, 'race-chained-rotations');
    const initial = await registerAgent(stack.app, workspace.workspaceKey, 'chained');

    const rotateA = await rotate(initial.token, 'chained');
    const tokenA = await tokenFrom(rotateA);
    const rotateB = await rotate(tokenA, 'chained');
    const tokenB = await tokenFrom(rotateB);

    // The token from before the first rotation is fully retired.
    expect((await authenticate(initial.token)).status).toBe(401);
    // Both the intermediate and current tokens still authenticate during the grace window.
    expect((await authenticate(tokenA)).status).toBe(200);
    expect((await authenticate(tokenB)).status).toBe(200);
  });

  it('refuses proofless workspace-key and foreign-agent rotation', async () => {
    const workspace = await createWorkspace(stack.app, 'rollover-auth-boundary');
    const incumbent = await registerAgent(stack.app, workspace.workspaceKey, 'incumbent');
    const stranger = await registerAgent(stack.app, workspace.workspaceKey, 'stranger');

    expect((await rotate(workspace.workspaceKey, incumbent.name)).status).toBe(401);
    expect((await rotate(stranger.token, incumbent.name)).status).toBe(403);
    expect((await authenticate(incumbent.token)).status).toBe(200);
  });

  it('rejects an expired agent token and reports a bounded new expiry', async () => {
    const workspace = await createWorkspace(stack.app, 'short-lived-expiry');
    const initial = await registerAgent(stack.app, workspace.workspaceKey, 'short-lived');
    const [row] = await stack.runtime.deps.db.select().from(agents).where(eq(agents.name, initial.name));
    expect(row?.tokenExpiresAt).toBeInstanceOf(Date);
    const remaining = row!.tokenExpiresAt!.getTime() - Date.now();
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(15 * 60_000);

    await stack.runtime.deps.db.update(agents)
      .set({ tokenExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(agents.id, row!.id));
    expect((await authenticate(initial.token)).status).toBe(401);
    expect((await rotate(initial.token, initial.name)).status).toBe(401);

    // Migration leaves existing credentials without a deadline until the
    // holder can rotate; expiry enforcement must not cut those clients off.
    await stack.runtime.deps.db.update(agents)
      .set({ tokenExpiresAt: null })
      .where(eq(agents.id, row!.id));
    expect((await authenticate(initial.token)).status).toBe(200);
  });

  it('does not revive an expired token in the previous-token grace slot', async () => {
    const workspace = await createWorkspace(stack.app, 'short-lived-grace');
    const initial = await registerAgent(stack.app, workspace.workspaceKey, 'grace-bound');
    const [row] = await stack.runtime.deps.db.select().from(agents).where(eq(agents.name, initial.name));
    await stack.runtime.deps.db.update(agents)
      .set({ tokenExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(agents.id, row!.id));

    const rotated = await rotateAgentToken(stack.runtime.deps.db, workspace.workspaceId, initial.name);
    expect(Date.parse(rotated.token_expires_at) - Date.now()).toBeLessThanOrEqual(15 * 60_000);
    expect((await authenticate(initial.token)).status).toBe(401);
    expect((await authenticate(rotated.token)).status).toBe(200);
  });
});
