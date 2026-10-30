import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { agents } from '../../db/schema.js';
import { sha256Hex } from '../../lib/crypto.js';
import { SqliteApiKeyAuthProvider } from '../../auth/index.js';
import { createWorkspace, makeNodeStack, registerAgent, type TestStack } from './harness.js';

const SECRET = 'ab'.repeat(32);

async function get(stack: TestStack, path: string, token: string): Promise<number> {
  return (await stack.app.request(path, { headers: { authorization: `Bearer ${token}` } })).status;
}

/** Give an existing agent `token` as its credential (no deployment mints the other family). */
async function setAgentToken(stack: TestStack, agentId: string, token: string): Promise<void> {
  await stack.runtime.deps.db.update(agents).set({ tokenHash: await sha256Hex(token) }).where(eq(agents.id, agentId));
}

describe('credential families', () => {
  it('a live-minting deployment mints live credentials and verifies both families', async () => {
    const stack = makeNodeStack();
    const workspace = await createWorkspace(stack.app, 'live-mint');
    const agent = await registerAgent(stack.app, workspace.workspaceKey, 'alice');
    expect(workspace.workspaceKey).toMatch(/^rk_live_[0-9a-f]{32}$/);
    expect(agent.token).toMatch(/^at_live_[0-9a-f]{32}$/);
    expect(await get(stack, '/v1/inbox', agent.token)).toBe(200);

    const routed = `relaycast_ag_${workspace.workspaceId}_${SECRET}`;
    await setAgentToken(stack, agent.agentId, routed);
    expect(await get(stack, '/v1/inbox', routed)).toBe(200);
    expect(await get(stack, '/v1/inbox', agent.token)).toBe(401);
  });

  it('a self-routing deployment mints self-routing credentials and verifies both families', async () => {
    const stack = makeNodeStack({ credentialFormat: 'self_routing' });
    const workspace = await createWorkspace(stack.app, 'routed-mint');
    const agent = await registerAgent(stack.app, workspace.workspaceKey, 'alice');
    expect(workspace.workspaceKey).toMatch(new RegExp(`^relaycast_ws_${workspace.workspaceId}_[0-9a-f]{64}$`));
    expect(agent.token).toMatch(new RegExp(`^relaycast_ag_${workspace.workspaceId}_[0-9a-f]{64}$`));
    expect(await get(stack, '/v1/agents', workspace.workspaceKey)).toBe(200);
    expect(await get(stack, '/v1/inbox', agent.token)).toBe(200);

    const legacy = `at_live_${'cd'.repeat(16)}`;
    await setAgentToken(stack, agent.agentId, legacy);
    expect(await get(stack, '/v1/inbox', legacy)).toBe(200);
  });

  it('rejects a self-routing credential of the wrong kind or naming another workspace', async () => {
    const stack = makeNodeStack();
    const a = await createWorkspace(stack.app, 'scope-a');
    const b = await createWorkspace(stack.app, 'scope-b');
    const agentB = await registerAgent(stack.app, b.workspaceKey, 'bob');

    // B's agent holds a credential that names workspace A.
    const namesA = `relaycast_ag_${a.workspaceId}_${SECRET}`;
    await setAgentToken(stack, agentB.agentId, namesA);
    expect(await get(stack, '/v1/inbox', namesA)).toBe(401);

    // The right workspace, but presented as a workspace key: the workspaces table holds no such hash.
    const namesB = `relaycast_ag_${b.workspaceId}_${SECRET}`;
    await setAgentToken(stack, agentB.agentId, namesB);
    expect(await get(stack, '/v1/inbox', namesB)).toBe(200);
    const wrongKind = `relaycast_ws_${b.workspaceId}_${SECRET}`;
    await stack.runtime.deps.db.update(agents).set({ tokenHash: await sha256Hex(wrongKind) }).where(eq(agents.id, agentB.agentId));
    expect(await get(stack, '/v1/agents', wrongKind)).toBe(401);
    expect(await get(stack, '/v1/inbox', wrongKind)).toBe(401);
  });

  it('verifies a self-routing credential with a single query', async () => {
    const stack = makeNodeStack({ credentialFormat: 'self_routing' });
    const workspace = await createWorkspace(stack.app, 'one-query');
    const agent = await registerAgent(stack.app, workspace.workspaceKey, 'alice');
    const { db } = stack.runtime.deps;
    const auth = new SqliteApiKeyAuthProvider();
    const prepare = vi.spyOn(stack.runtime.handle.sqlite, 'prepare');

    for (const [token, require] of [[workspace.workspaceKey, 'workspace'], [agent.token, 'agent']] as const) {
      prepare.mockClear();
      const result = await auth.authenticate({ token, require, db });
      expect(result.ok).toBe(true);
      expect(prepare).toHaveBeenCalledTimes(1);
    }

    prepare.mockClear();
    const unknown = await auth.authenticate({ token: `relaycast_ag_${workspace.workspaceId}_${SECRET}`, require: 'agent', db });
    expect(unknown.ok).toBe(false);
    expect(prepare).toHaveBeenCalledTimes(1);
  });
});
