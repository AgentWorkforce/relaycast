import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkspace, makeNodeStack, registerAgent, type TestStack } from './harness.js';

/**
 * Workspace-key rotation (POST /v1/workspace/rotate-key).
 *
 * Same handoff contract as agent-token rollover: the superseded key is
 * captured into a previous slot and keeps authenticating for a bounded grace
 * window so peers and in-flight callers survive the cutover. `grace_seconds:
 * 0` is the compromise mode — the old key is dead the moment the rotation
 * commits, on reads and mutations alike. When the canonical credential lives
 * in an external control plane (hosted), self-serve rotation is refused so a
 * locally minted key can never be clobbered or resurrected by that plane.
 */
describe('workspace key rotation', () => {
  let stack: TestStack;

  beforeEach(() => { stack = makeNodeStack({ allowWorkspaceKeyRotation: true }); });
  afterEach(() => stack.close());

  async function rotateKey(key: string, graceSeconds?: number): Promise<Response> {
    return stack.app.request('/v1/workspace/rotate-key', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(graceSeconds === undefined ? {} : { grace_seconds: graceSeconds }),
    });
  }

  async function keyFrom(res: Response): Promise<string> {
    const body = await res.json() as { data?: { api_key?: string } };
    return body.data?.api_key ?? '';
  }

  async function readWorkspace(key: string): Promise<Response> {
    return stack.app.request('/v1/workspace', {
      headers: { authorization: `Bearer ${key}` },
    });
  }

  async function mutateWorkspace(key: string): Promise<Response> {
    return stack.app.request('/v1/workspace', {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ metadata: { probe: 'workspace-key-rotation' } }),
    });
  }

  it('observes committed rotation as domain facts without either credential', async () => {
    const { workspaceKey, workspaceId } = await createWorkspace(stack.app, 'rotate-observation');
    const capture = vi.spyOn(stack.runtime.deps.telemetry!, 'capture');
    const res = await rotateKey(workspaceKey, 0);
    expect(res.status).toBe(200);
    const newKey = await keyFrom(res);
    const observation = capture.mock.calls.map(([event]) => event).find(event => event.kind === 'workspace.key.rotated');
    expect(observation).toMatchObject({ kind: 'workspace.key.rotated', workspaceId, facts: { grace_seconds: 0 }, occurredAt: expect.any(String) });
    expect(observation).not.toHaveProperty('authenticatedActor');
    expect(JSON.stringify(observation)).not.toContain(workspaceKey);
    expect(JSON.stringify(observation)).not.toContain(newKey);
  });

  it('authenticates the replacement immediately on reads and mutations', async () => {
    const { workspaceKey } = await createWorkspace(stack.app, 'rotate-replacement-works');

    const res = await rotateKey(workspaceKey);
    expect(res.status).toBe(200);
    const body = await res.json() as { data?: Record<string, unknown> };
    const newKey = body.data?.api_key ?? '';
    expect(newKey).toMatch(/^rk_live_[0-9a-f]{32}$/);
    expect(newKey).not.toBe(workspaceKey);
    // The response carries no copy of the superseded key.
    expect(JSON.stringify(body)).not.toContain(workspaceKey);

    expect((await readWorkspace(newKey)).status).toBe(200);
    expect((await mutateWorkspace(newKey)).status).toBe(200);
  });

  it('keeps the superseded key authenticatable during the grace window', async () => {
    const { workspaceKey } = await createWorkspace(stack.app, 'rotate-grace-continuity');

    const res = await rotateKey(workspaceKey, 60);
    expect(res.status).toBe(200);
    const newKey = await keyFrom(res);

    // Grace is continuity, not an error: both keys are live credentials
    // inside the window, for reads and mutations.
    expect((await readWorkspace(workspaceKey)).status).toBe(200);
    expect((await mutateWorkspace(workspaceKey)).status).toBe(200);
    expect((await readWorkspace(newKey)).status).toBe(200);
  });

  it('kills the superseded key immediately with grace_seconds = 0', async () => {
    const { workspaceKey } = await createWorkspace(stack.app, 'rotate-zero-grace');

    const res = await rotateKey(workspaceKey, 0);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      data?: { api_key?: string; previous_key_expires_at?: string | null };
    };
    expect(body.data?.previous_key_expires_at).toBeNull();
    const newKey = body.data?.api_key ?? '';
    expect(newKey).not.toBe('');

    // Compromise mode: the old credential refuses on both reads and
    // mutations — there is no stale or grace path that revives it.
    expect((await readWorkspace(workspaceKey)).status).toBe(401);
    expect((await mutateWorkspace(workspaceKey)).status).toBe(401);
    expect((await readWorkspace(newKey)).status).toBe(200);
  });

  it('expires the superseded key when the grace window elapses', async () => {
    const { workspaceKey } = await createWorkspace(stack.app, 'rotate-grace-expiry');
    // The schema bounds grace_seconds at >= 1 to observe the boundary; 1s is
    // the shortest representable window.
    const res = await rotateKey(workspaceKey, 1);
    expect(res.status).toBe(200);

    expect((await readWorkspace(workspaceKey)).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect((await readWorkspace(workspaceKey)).status).toBe(401);
    expect((await mutateWorkspace(workspaceKey)).status).toBe(401);
  });

  it('both concurrent rotations yield keys that authenticate', async () => {
    const { workspaceKey } = await createWorkspace(stack.app, 'rotate-race');

    const [resA, resB] = await Promise.all([
      rotateKey(workspaceKey, 60),
      rotateKey(workspaceKey, 60),
    ]);
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    const keyA = await keyFrom(resA);
    const keyB = await keyFrom(resB);
    expect(keyA).not.toBe(keyB);

    // The race loser captured the winner's predecessor, so the key it was
    // handed still authenticates during grace rather than dying silently.
    const [authA, authB] = await Promise.all([readWorkspace(keyA), readWorkspace(keyB)]);
    expect(authA.status).toBe(200);
    expect(authB.status).toBe(200);
  });

  it('retires the oldest key under chained rotations', async () => {
    const { workspaceKey } = await createWorkspace(stack.app, 'rotate-chained');

    const keyA = await keyFrom(await rotateKey(workspaceKey, 60));
    const keyB = await keyFrom(await rotateKey(keyA, 60));

    expect((await readWorkspace(workspaceKey)).status).toBe(401);
    expect((await readWorkspace(keyA)).status).toBe(200);
    expect((await readWorkspace(keyB)).status).toBe(200);
  });

  it('leaves agent and observer credentials untouched', async () => {
    const { workspaceKey } = await createWorkspace(stack.app, 'rotate-agent-continuity');
    const agent = await registerAgent(stack.app, workspaceKey, 'survivor');

    const res = await rotateKey(workspaceKey, 0);
    expect(res.status).toBe(200);

    // Identity credentials outlive a workspace-key cutover: names, tokens and
    // sessions are not the rotated surface.
    const me = await stack.app.request('/v1/agent', {
      headers: { authorization: `Bearer ${agent.token}` },
    });
    expect(me.status).toBe(200);
  });

  it('rejects out-of-range and malformed grace values', async () => {
    const { workspaceKey } = await createWorkspace(stack.app, 'rotate-grace-bounds');

    for (const graceSeconds of [-1, 3601, 1.5, 'forever' as unknown as number]) {
      const res = await rotateKey(workspaceKey, graceSeconds);
      expect(res.status).toBe(400);
    }
    // The key was never rotated by rejected requests.
    expect((await readWorkspace(workspaceKey)).status).toBe(200);
  });

  it('refuses rotation without a workspace key', async () => {
    const res = await stack.app.request('/v1/workspace/rotate-key', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });
});

// The route is opt-in and stays off by default: hosted deployments — where a
// control plane owns the canonical key and this store holds a pushed copy —
// never set the flag, so a self-serve mint here could not reach that plane and
// its repair path would resurrect the old credential.
describe('workspace key rotation disabled (default / hosted posture)', () => {
  let stack: TestStack;

  beforeEach(() => { stack = makeNodeStack(); });
  afterEach(() => stack.close());

  it('refuses self-serve rotation so the canonical control plane stays authoritative', async () => {
    const { workspaceKey } = await createWorkspace(stack.app, 'rotate-disabled');

    const res = await stack.app.request('/v1/workspace/rotate-key', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${workspaceKey}`,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    expect(res.status).toBe(403);
    const body = await res.json() as { error?: { code?: string } };
    expect(body.error?.code).toBe('workspace_key_rotation_disabled');

    // The existing key is untouched — a refused rotation changes nothing.
    const check = await stack.app.request('/v1/workspace', {
      headers: { authorization: `Bearer ${workspaceKey}` },
    });
    expect(check.status).toBe(200);
  });
});
