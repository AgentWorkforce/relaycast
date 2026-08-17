import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorkspace, makeNodeStack, registerAgent, type TestStack } from './harness.js';

/**
 * Regression coverage for relay#1542. Two clients that concurrently reclaim the
 * same agent name each receive a fresh token from POST /agents/:name/rotate-token.
 * The stored `token_hash` is a single slot, so the later rotate would invalidate
 * the earlier caller's token silently — the caller was handed a 200 response
 * plus a credential that stopped working microseconds later.
 *
 * The fix keeps the previous credential live for a short grace window so both
 * callers can present the token they were handed and be recognised as the agent
 * they registered under. Once the grace window elapses, only the most recent
 * token authenticates and everything older stays revoked.
 */
describe('registerOrRotate concurrency', () => {
  let stack: TestStack;

  beforeEach(() => { stack = makeNodeStack(); });
  afterEach(() => stack.close());

  async function rotate(workspaceKey: string, name: string): Promise<Response> {
    return stack.app.request(`/v1/agents/${name}/rotate-token`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${workspaceKey}`,
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
    await registerAgent(stack.app, workspace.workspaceKey, 'chief');

    const [rotateA, rotateB] = await Promise.all([
      rotate(workspace.workspaceKey, 'chief'),
      rotate(workspace.workspaceKey, 'chief'),
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
    const rotateRes = await rotate(workspace.workspaceKey, 'ephemeral');
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

    const rotateA = await rotate(workspace.workspaceKey, 'chained');
    const tokenA = await tokenFrom(rotateA);
    const rotateB = await rotate(workspace.workspaceKey, 'chained');
    const tokenB = await tokenFrom(rotateB);

    // The token from before the first rotation is fully retired.
    expect((await authenticate(initial.token)).status).toBe(401);
    // Both the intermediate and current tokens still authenticate during the grace window.
    expect((await authenticate(tokenA)).status).toBe(200);
    expect((await authenticate(tokenB)).status).toBe(200);
  });
});
