import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createWorkspace, makeNodeStack, registerAgent, type TestStack } from './harness.js';
import * as a2aEngine from '../../engine/a2a.js';
import * as agentEngine from '../../engine/agent.js';
import { a2aAgents, agents } from '../../db/schema.js';

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
    await registerAgent(stack.app, workspace.workspaceKey, 'malformed-identity-node');
    await markOffline(workspace.workspaceKey, 'malformed-identity-node');
    // Seed a malformed historical row below the API boundary. Registration
    // must continue accepting a valid string verifier because that is how new
    // brokers establish ownership; this fixture specifically models old or
    // corrupted data that the claim must reject by key presence.
    await stack.runtime.deps.db
      .update(agents)
      .set({ metadata: { identity_key: null } })
      .where(and(
        eq(agents.workspaceId, workspace.workspaceId),
        eq(agents.name, 'malformed-identity-node'),
      ));

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

  it('rejects malformed registration verifiers while retaining valid ownership bootstrap', async () => {
    const workspace = await createWorkspace(stack.app, 'registration-identity-verifier');
    const invalid = await stack.app.request('/v1/agents', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${workspace.workspaceKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'malformed-verifier',
        metadata: { identity_key: null },
      }),
    });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({
      error: { code: 'invalid_agent_identity_key' },
    });

    const validHash = 'f'.repeat(64);
    const valid = await stack.app.request('/v1/agents', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${workspace.workspaceKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'valid-verifier',
        metadata: { identity_key: validHash },
      }),
    });
    expect(valid.status).toBe(201);
    const registered = await agentEngine.getAgentByName(
      stack.runtime.deps.db,
      workspace.workspaceId,
      'valid-verifier',
    );
    expect(registered?.metadata).toMatchObject({ identity_key: validHash });
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

  it('preserves a winning claim when an A2A proxy is removed', async () => {
    const workspace = await createWorkspace(stack.app, 'legacy-identity-a2a-remove');
    const proxy = await registerAgent(stack.app, workspace.workspaceKey, 'legacy-a2a-proxy');
    await stack.runtime.deps.db.insert(a2aAgents).values({
      id: 'a2a_legacy_identity_test',
      workspaceId: workspace.workspaceId,
      relayAgentId: proxy.agentId,
      agentCard: {
        name: 'legacy-a2a-proxy',
        url: 'https://example.com/a2a/rpc',
        version: '1.0.0',
        skills: [{ id: 'echo', name: 'echo' }],
      },
      externalUrl: 'https://example.com/a2a/rpc',
    });
    await markOffline(workspace.workspaceKey, 'legacy-a2a-proxy');

    const claimedHash = '9'.repeat(64);
    const winner = await claim(workspace.workspaceKey, 'legacy-a2a-proxy', claimedHash);
    expect(winner.status).toBe(200);

    await expect(a2aEngine.removeA2aAgent(
      stack.runtime.deps.db,
      workspace.workspaceId,
      'legacy-a2a-proxy',
    )).resolves.toBe(true);
    const current = await agentEngine.getAgentByName(
      stack.runtime.deps.db,
      workspace.workspaceId,
      'legacy-a2a-proxy',
    );
    expect(current?.metadata).toMatchObject({
      a2a: true,
      a2a_active: false,
      identity_key: claimedHash,
    });
  });

  it('does not redirect an id-scoped cleanup update to a same-name replacement', async () => {
    const workspace = await createWorkspace(stack.app, 'legacy-identity-id-scoped-update');
    const oldProxy = await registerAgent(stack.app, workspace.workspaceKey, 'reused-proxy-name');
    await agentEngine.deleteAgent(
      stack.runtime.deps.db,
      workspace.workspaceId,
      'reused-proxy-name',
    );
    const replacement = await registerAgent(
      stack.app,
      workspace.workspaceKey,
      'reused-proxy-name',
    );

    const staleUpdate = await agentEngine.updateAgentById(
      stack.runtime.deps.db,
      workspace.workspaceId,
      oldProxy.agentId,
      { status: 'offline', metadata: { a2a: true, a2a_active: false } },
    );

    expect(staleUpdate).toBeNull();
    const current = await agentEngine.getAgentByName(
      stack.runtime.deps.db,
      workspace.workspaceId,
      'reused-proxy-name',
    );
    expect(current?.id).toBe(replacement.agentId);
    expect(current?.status).toBe('active');
    expect(current?.metadata).not.toHaveProperty('a2a_active');
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
