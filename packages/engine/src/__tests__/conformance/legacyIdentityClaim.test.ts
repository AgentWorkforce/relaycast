import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorkspace, makeNodeStack, registerAgent, type TestStack } from './harness.js';
import * as agentEngine from '../../engine/agent.js';

describe('legacy agent identity claim', () => {
  let stack: TestStack;

  beforeEach(() => {
    stack = makeNodeStack();
  });

  afterEach(() => stack.close());

  async function markOffline(workspaceKey: string, name: string): Promise<void> {
    const response = await stack.app.request(`/v1/agents/${name}`, {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${workspaceKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ status: 'offline' }),
    });
    expect(response.status).toBe(200);
  }

  function claim(workspaceKey: string, name: string, identityKeyHash: string) {
    return stack.app.request(`/v1/agents/${name}/legacy-identity`, {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${workspaceKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ identity_key_hash: identityKeyHash }),
    });
  }

  it('allows exactly one of two concurrent claims to stamp the identity', async () => {
    const workspace = await createWorkspace(stack.app, 'legacy-identity-race');
    await registerAgent(stack.app, workspace.workspaceKey, 'legacy-node');
    await markOffline(workspace.workspaceKey, 'legacy-node');

    const firstHash = 'a'.repeat(64);
    const secondHash = 'b'.repeat(64);
    const [first, second] = await Promise.all([
      claim(workspace.workspaceKey, 'legacy-node', firstHash),
      claim(workspace.workspaceKey, 'legacy-node', secondHash),
    ]);

    expect([first.status, second.status].sort()).toEqual([200, 409]);
    const winner = first.status === 200 ? first : second;
    const loser = first.status === 409 ? first : second;
    const winnerBody = await winner.json() as {
      data: { metadata: { identity_key: string } };
    };
    await expect(loser.json()).resolves.toMatchObject({
      error: { code: 'agent_identity_already_claimed' },
    });

    const current = await stack.app.request('/v1/agents/legacy-node', {
      headers: { authorization: `Bearer ${workspace.workspaceKey}` },
    });
    const currentBody = await current.json() as {
      data: { metadata: { identity_key: string } };
    };
    expect(currentBody.data.metadata.identity_key).toBe(winnerBody.data.metadata.identity_key);
    expect([firstHash, secondHash]).toContain(currentBody.data.metadata.identity_key);
  });

  it('fails closed when identity_key is present with a non-string value', async () => {
    const workspace = await createWorkspace(stack.app, 'legacy-identity-null');
    const registered = await stack.app.request('/v1/agents', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${workspace.workspaceKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'malformed-identity-node',
        metadata: { identity_key: null },
      }),
    });
    expect(registered.status).toBe(201);
    await markOffline(workspace.workspaceKey, 'malformed-identity-node');

    const response = await claim(
      workspace.workspaceKey,
      'malformed-identity-node',
      'c'.repeat(64),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'agent_identity_already_claimed' },
    });
  });

  it('rejects identity_key writes through the generic agent update endpoint', async () => {
    const workspace = await createWorkspace(stack.app, 'reserved-agent-metadata');
    await registerAgent(stack.app, workspace.workspaceKey, 'protected-node');

    const response = await stack.app.request('/v1/agents/protected-node', {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${workspace.workspaceKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ metadata: { identity_key: 'attacker-planted-proof' } }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'reserved_agent_metadata_key' },
    });
    const current = await stack.app.request('/v1/agents/protected-node', {
      headers: { authorization: `Bearer ${workspace.workspaceKey}` },
    });
    const currentBody = await current.json() as {
      data: { metadata: Record<string, unknown> };
    };
    expect(currentBody.data.metadata).not.toHaveProperty('identity_key');
  });

  it('preserves a winning claim against a generic metadata update built from a stale read', async () => {
    const workspace = await createWorkspace(stack.app, 'legacy-identity-stale-patch');
    await registerAgent(stack.app, workspace.workspaceKey, 'legacy-node');
    await markOffline(workspace.workspaceKey, 'legacy-node');

    // Model the generic PATCH route after it read the legacy row but before it
    // writes its merged metadata. The claim lands between those two steps.
    const staleMetadata = { operator_note: 'read-before-claim' };
    const claimedHash = 'e'.repeat(64);
    const winner = await claim(workspace.workspaceKey, 'legacy-node', claimedHash);
    expect(winner.status).toBe(200);

    const staleWrite = await agentEngine.updateAgent(
      stack.runtime.deps.db,
      workspace.workspaceId,
      'legacy-node',
      { metadata: staleMetadata },
    );

    expect(staleWrite?.metadata).toEqual({
      ...staleMetadata,
      identity_key: claimedHash,
    });
  });

  it('requires the target agent to be offline at the atomic write', async () => {
    const workspace = await createWorkspace(stack.app, 'legacy-identity-online');
    await registerAgent(stack.app, workspace.workspaceKey, 'online-node');

    const response = await claim(workspace.workspaceKey, 'online-node', 'd'.repeat(64));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'agent_not_offline' },
    });
  });
});
