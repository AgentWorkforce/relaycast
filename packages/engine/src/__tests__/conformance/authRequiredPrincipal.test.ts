import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEngine } from '../../engine.js';
import type { AuthProvider } from '../../ports/index.js';
import { createWorkspace, makeNodeStack, registerAgent, type TestStack } from './harness.js';

/**
 * A host auth provider may answer a workspace key with a workspace-only result
 * whatever `require` asked for (hosted cached workspace-key results this way).
 * A single-principal route must then reject the request with a 401 instead of
 * running its handler without that principal: `/agents/:name/rotate-token`
 * dereferenced the missing agent into a 500.
 */
describe('single-principal routes require that principal', () => {
  let stack: TestStack;

  beforeEach(() => { stack = makeNodeStack(); });
  afterEach(() => stack.close());

  function appWithWorkspaceOnlyAuth(): ReturnType<typeof createEngine> {
    const base = stack.runtime.deps.auth;
    // Resolve the token as if `require` were 'workspace', and drop any principal.
    const auth: AuthProvider = {
      hashToken: token => base.hashToken(token),
      async authenticate(args) {
        const result = await base.authenticate({ ...args, require: 'workspace' });
        return result.ok ? { ok: true, workspace: result.workspace } : result;
      },
    };
    return createEngine({ ...stack.runtime.deps, auth });
  }

  it('answers 401, not 500, when an agent route gets a workspace-only result', async () => {
    const ws = await createWorkspace(stack.app, 'auth-required-principal');
    await registerAgent(stack.app, ws.workspaceKey, 'rotating-agent');
    const app = appWithWorkspaceOnlyAuth();

    const res = await app.request('/v1/agents/rotating-agent/rotate-token', {
      method: 'POST',
      headers: { authorization: `Bearer ${ws.workspaceKey}`, 'content-type': 'application/json' },
      body: '{}',
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: 'unauthorized' } });
  });

  it('answers 401 when an observer token resolves without its observer identity', async () => {
    const ws = await createWorkspace(stack.app, 'auth-required-observer');
    const minted = await stack.app.request('/v1/observer-tokens', {
      method: 'POST',
      headers: { authorization: `Bearer ${ws.workspaceKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'scoped-observer', scopes: ['stream:read'] }),
    });
    expect(minted.status).toBe(201);
    const observer = (await minted.json() as { data: { token: string } }).data.token;
    const base = stack.runtime.deps.auth;
    // Resolve the token for the route's own requirement, then drop the principal.
    const auth: AuthProvider = {
      hashToken: token => base.hashToken(token),
      async authenticate(args) {
        const result = await base.authenticate(args);
        return result.ok ? { ok: true, workspace: result.workspace } : result;
      },
    };
    const app = createEngine({ ...stack.runtime.deps, auth });

    // Without the guard this unscoped token would list agents as the workspace.
    const res = await app.request('/v1/agents', { headers: { authorization: `Bearer ${observer}` } });

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: 'unauthorized' } });
  });

  it('still rotates for a real agent token', async () => {
    const ws = await createWorkspace(stack.app, 'auth-required-principal-ok');
    const agent = await registerAgent(stack.app, ws.workspaceKey, 'rotating-agent');

    const res = await stack.app.request('/v1/agents/rotating-agent/rotate-token', {
      method: 'POST',
      headers: { authorization: `Bearer ${agent.token}`, 'content-type': 'application/json' },
      body: '{}',
    });

    expect(res.status).toBe(200);
  });
});
