import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { agents, nodes, observerTokens, workspaces } from '../../db/tables.js';
import { SqliteApiKeyAuthProvider, WORKSPACE_EXPIRED_CODE } from '../../auth/index.js';
import type { AuthRequire } from '../../ports/auth.js';
import { createWorkspace, makeNodeStack, registerAgent, type TestStack } from './harness.js';

async function post(stack: TestStack, path: string, token: string, body: unknown): Promise<Record<string, string>> {
  const res = await stack.app.request(path, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(res.status).toBeLessThan(300);
  return ((await res.json()) as { data: Record<string, string> }).data;
}

/** A legacy workspace with one credential of every kind, plus an agent token inside its rotation grace. */
async function legacyCredentials() {
  const stack = makeNodeStack();
  const workspace = await createWorkspace(stack.app, 'legacy-lookup');
  const agent = await registerAgent(stack.app, workspace.workspaceKey, 'alice');
  const rotated = await registerAgent(stack.app, workspace.workspaceKey, 'bob');
  const replacement = await post(stack, '/v1/agents/bob/rotate-token', rotated.token, {});
  const node = await post(stack, '/v1/nodes', workspace.workspaceKey, { node_id: 'node_a', name: 'host' });
  const observer = await post(stack, '/v1/observer-tokens', workspace.workspaceKey, { name: 'obs', scopes: ['files:read'] });
  expect(replacement.token).not.toBe(rotated.token);
  const credentials: Array<[label: string, token: string, require: AuthRequire]> = [
    ['workspace key', workspace.workspaceKey, 'workspace'],
    ['agent token', agent.token, 'agent'],
    ['agent token in rotation grace', rotated.token, 'agent'],
    ['node token', node.token!, 'node'],
    ['observer token', observer.token!, 'observer'],
  ];
  for (const [, token] of credentials) expect(token).toMatch(/^(rk|at|nt|ot)_live_/);
  return { stack, workspace, agent, rotated, node, observer, credentials };
}

describe('legacy credential lookup', () => {
  it('resolves every legacy kind with one query', async () => {
    const { stack, credentials } = await legacyCredentials();
    const { db } = stack.runtime.deps;
    const auth = new SqliteApiKeyAuthProvider();
    const prepare = vi.spyOn(stack.runtime.handle.sqlite, 'prepare');
    // An observer lookup may also schedule its debounced last_used_at write.
    const selects = () => prepare.mock.calls.filter(([sql]) => /^\s*select/i.test(String(sql))).length;

    for (const [label, token, require] of credentials) {
      prepare.mockClear();
      const result = await auth.authenticate({ token, require, db });
      expect(result.ok, label).toBe(true);
      expect(selects(), label).toBe(1);
    }
  });

  it('returns the same principal and workspace rows the separate reads did', async () => {
    const { stack, workspace, agent, rotated, node, observer } = await legacyCredentials();
    const { db } = stack.runtime.deps;
    const auth = new SqliteApiKeyAuthProvider();
    await db.update(workspaces).set({ expiresAt: new Date(Date.now() + 3_600_000) })
      .where(eq(workspaces.id, workspace.workspaceId));
    const [workspaceRow] = await db.select().from(workspaces).where(eq(workspaces.id, workspace.workspaceId));
    const row = async <T>(query: Promise<T[]>) => (await query)[0];

    expect(await auth.authenticate({ token: workspace.workspaceKey, require: 'workspace', db }))
      .toEqual({ ok: true, workspace: workspaceRow });
    expect(await auth.authenticate({ token: agent.token, require: 'agent', db })).toEqual({
      ok: true,
      workspace: workspaceRow,
      agent: await row(db.select().from(agents).where(eq(agents.id, agent.agentId))),
    });
    expect(await auth.authenticate({ token: rotated.token, require: 'agent', db })).toEqual({
      ok: true,
      workspace: workspaceRow,
      agent: await row(db.select().from(agents).where(eq(agents.id, rotated.agentId))),
    });
    expect(await auth.authenticate({ token: node.token!, require: 'node', db })).toEqual({
      ok: true,
      workspace: workspaceRow,
      node: await row(db.select().from(nodes).where(eq(nodes.id, node.id!))),
    });
    const observerResult = await auth.authenticate({ token: observer.token!, require: 'observer', db });
    expect(observerResult).toEqual({
      ok: true,
      workspace: workspaceRow,
      observerToken: { ...(await row(db.select().from(observerTokens).where(eq(observerTokens.id, observer.id!))))!, lastUsedAt: null },
    });
  });

  it('rejects every legacy kind once its workspace is tombstoned', async () => {
    const { stack, workspace, credentials } = await legacyCredentials();
    const { db } = stack.runtime.deps;
    const auth = new SqliteApiKeyAuthProvider();
    await db.update(workspaces).set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(workspaces.id, workspace.workspaceId));

    for (const [label, token, require] of credentials) {
      const result = await auth.authenticate({ token, require, db });
      expect(result.ok ? 'ok' : result.code, label).toBe(WORKSPACE_EXPIRED_CODE);
    }
  });

  it('stops honouring an agent token once its rotation grace ends', async () => {
    const { stack, rotated } = await legacyCredentials();
    const { db } = stack.runtime.deps;
    await db.update(agents).set({ previousTokenExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(agents.id, rotated.agentId));

    const result = await new SqliteApiKeyAuthProvider().authenticate({ token: rotated.token, require: 'agent', db });
    expect(result.ok ? 'ok' : result.code).toBe('agent_token_invalid');
  });
});
