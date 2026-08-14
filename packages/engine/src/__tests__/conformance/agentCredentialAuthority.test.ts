import { afterEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { agents, workspaces } from '../../db/schema.js';
import { createWorkspace as createWorkspaceRecord } from '../../engine/workspace.js';
import { registerAgent as registerAgentRecord } from '../../engine/agent.js';
import { handleNodeControlMessage } from '../../engine/node.js';
import { authorizeNewNamedAgentCredential } from '../../engine/agentCredentialAuthority.js';
import {
  FakeSocket,
  createWorkspace,
  makeNodeStack,
  registerAgent,
  type TestStack,
} from './harness.js';
import {
  agentAuthority,
  mintSponsorProof,
  testCredentialAuthorityConfig,
  workspaceAuthority,
} from './credentialAuthorityFixture.js';

interface ErrorEnvelope {
  error?: { code?: string; message?: string };
}

describe('agent credential authority', () => {
  const stacks: TestStack[] = [];

  function stack(): TestStack {
    const created = makeNodeStack({ agentCredentialAuthority: testCredentialAuthorityConfig() });
    stacks.push(created);
    return created;
  }

  afterEach(() => {
    while (stacks.length > 0) stacks.pop()!.close();
  });

  it('rejects a direct registration made with only a workspace key', async () => {
    const current = stack();
    const proof = await mintSponsorProof();
    const workspace = await createWorkspace(current.app, 'direct-api-proof', workspaceAuthority(proof));

    const bypass = await current.app.request('/v1/agents', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${workspace.workspaceKey}`,
      },
      body: JSON.stringify({ name: 'workspace-key-only' }),
    });
    expect(bypass.status).toBe(403);
    expect((await bypass.json() as ErrorEnvelope).error?.code).toBe('invalid_sponsor_proof');
    expect(await current.runtime.deps.db.select().from(agents)).toHaveLength(0);

    const created = await registerAgent(
      current.app,
      workspace.workspaceKey,
      'sponsored-agent',
      agentAuthority(proof),
    );
    expect(created.token).toMatch(/^at_live_/u);
  });

  it('does not trust rewritten metadata for rotation or identity reclaim', async () => {
    const current = stack();
    const ownerProof = await mintSponsorProof({ sponsorId: 'user_owner' });
    const workspace = await createWorkspace(current.app, 'immutable-binding', workspaceAuthority(ownerProof));
    await registerAgent(
      current.app,
      workspace.workspaceKey,
      'protected-agent',
      agentAuthority(ownerProof, 'owner-work-unit-key-00000000000000000001'),
    );

    const forgedMetadata = await current.app.request('/v1/agents/protected-agent', {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${workspace.workspaceKey}`,
      },
      body: JSON.stringify({
        metadata: {
          identity_key: 'attacker-controlled-hash',
          relayauth_sponsor_id: 'user_attacker',
          relayauth_sponsor_binding: 'oidc',
        },
      }),
    });
    expect(forgedMetadata.status).toBe(400);
    expect((await forgedMetadata.json() as ErrorEnvelope).error?.code).toBe('reserved_agent_metadata');

    const attackerProof = await mintSponsorProof({ sponsorId: 'user_attacker' });
    const hijack = await current.app.request('/v1/agents/protected-agent/rotate-token', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${workspace.workspaceKey}`,
      },
      body: JSON.stringify({
        registration_authority: agentAuthority(
          attackerProof,
          'attacker-work-unit-key-000000000000000001',
        ),
      }),
    });
    expect(hijack.status).toBe(409);
    expect((await hijack.json() as ErrorEnvelope).error?.code).toBe('agent_credential_authority_mismatch');

    const deleteWithoutAuthority = await current.app.request('/v1/agents/protected-agent', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${workspace.workspaceKey}` },
    });
    expect(deleteWithoutAuthority.status).toBe(403);

    const attackerDelete = await current.app.request('/v1/agents/protected-agent', {
      method: 'DELETE',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${workspace.workspaceKey}`,
      },
      body: JSON.stringify({
        registration_authority: agentAuthority(
          attackerProof,
          'attacker-work-unit-key-000000000000000001',
        ),
      }),
    });
    expect(attackerDelete.status).toBe(409);

    const stillProtected = await current.runtime.deps.db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.workspaceId, workspace.workspaceId), eq(agents.name, 'protected-agent')));
    expect(stillProtected).toHaveLength(1);

    const ownerDelete = await current.app.request('/v1/agents/protected-agent', {
      method: 'DELETE',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${workspace.workspaceKey}`,
      },
      body: JSON.stringify({
        registration_authority: agentAuthority(
          ownerProof,
          'owner-work-unit-key-00000000000000000001',
        ),
      }),
    });
    expect(ownerDelete.status).toBe(204);

    const recreateByAttacker = await current.app.request('/v1/agents', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${workspace.workspaceKey}`,
      },
      body: JSON.stringify({
        name: 'protected-agent',
        registration_authority: agentAuthority(
          attackerProof,
          'attacker-work-unit-key-000000000000000001',
        ),
      }),
    });
    expect(recreateByAttacker.status).toBe(409);
    expect((await recreateByAttacker.json() as ErrorEnvelope).error?.code)
      .toBe('agent_credential_authority_mismatch');

    await registerAgent(
      current.app,
      workspace.workspaceKey,
      'protected-agent',
      agentAuthority(ownerProof, 'owner-work-unit-key-00000000000000000001'),
    );

    const ownerRotation = await current.app.request('/v1/agents/protected-agent/rotate-token', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${workspace.workspaceKey}`,
      },
      body: JSON.stringify({
        registration_authority: agentAuthority(
          ownerProof,
          'owner-work-unit-key-00000000000000000001',
        ),
      }),
    });
    expect(ownerRotation.status).toBe(200);
    expect((await ownerRotation.json() as { data: { token: string } }).data.token).toMatch(/^at_live_/u);
  });

  it('does not bypass destructive authority through generic release invocation', async () => {
    const current = stack();
    const ownerProof = await mintSponsorProof({ sponsorId: 'user_release_owner' });
    const workspace = await createWorkspace(current.app, 'release-action-authority', workspaceAuthority(ownerProof));
    await registerAgent(
      current.app,
      workspace.workspaceKey,
      'release-target',
      agentAuthority(ownerProof, 'release-owner-work-unit-key-00000000000000001'),
    );
    const caller = await registerAgent(
      current.app,
      workspace.workspaceKey,
      'release-caller',
      agentAuthority(ownerProof, 'release-caller-work-unit-key-0000000000000001'),
    );

    const bypass = await current.app.request('/v1/actions/release/invoke', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${caller.token}`,
      },
      body: JSON.stringify({ input: { name: 'release-target', delete_agent: true } }),
    });
    expect(bypass.status).toBe(403);
    expect((await bypass.json() as ErrorEnvelope).error?.code).toBe('invalid_sponsor_proof');

    const attackerProof = await mintSponsorProof({ sponsorId: 'user_release_attacker' });
    const hijack = await current.app.request('/v1/actions/release/invoke', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${caller.token}`,
      },
      body: JSON.stringify({
        input: { name: 'release-target', delete_agent: true },
        registration_authority: agentAuthority(
          attackerProof,
          'release-attacker-work-unit-key-0000000000000001',
        ),
      }),
    });
    expect(hijack.status).toBe(409);

    const nodeEnroll = await current.app.request('/v1/nodes', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${workspace.workspaceKey}`,
      },
      body: JSON.stringify({ name: 'release-node', role: 'broker', max_agents: 1 }),
    });
    expect(nodeEnroll.status).toBe(201);
    const nodeAliasBypass = await current.app.request('/v1/nodes/release-node/actions/release/invoke', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${caller.token}`,
      },
      body: JSON.stringify({ input: { name: 'release-target', delete_agent: true } }),
    });
    expect(nodeAliasBypass.status).toBe(403);
    expect((await nodeAliasBypass.json() as ErrorEnvelope).error?.code).toBe('invalid_sponsor_proof');

    const stillProtected = await current.runtime.deps.db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.workspaceId, workspace.workspaceId), eq(agents.name, 'release-target')));
    expect(stillProtected).toHaveLength(1);
  });

  it('rejects a stale preflight decision after another binding claims the name', async () => {
    const current = stack();
    const ownerProof = await mintSponsorProof({ sponsorId: 'user_race_owner' });
    const attackerProof = await mintSponsorProof({ sponsorId: 'user_race_attacker' });
    const workspace = await createWorkspace(current.app, 'claim-race', workspaceAuthority(ownerProof));
    const ownerAuthority = agentAuthority(
      ownerProof,
      'race-owner-work-unit-key-0000000000000001',
    );
    const attackerAuthority = agentAuthority(
      attackerProof,
      'race-attacker-work-unit-key-0000000000001',
    );

    // Both checks happen before either request writes. The second decision is
    // therefore stale once the owner transaction establishes the name claim.
    const ownerDecision = await authorizeNewNamedAgentCredential(
      current.runtime.deps.db,
      current.runtime.deps.config ?? {},
      workspace.workspaceId,
      'raced-agent',
      ownerAuthority,
    );
    const staleAttackerDecision = await authorizeNewNamedAgentCredential(
      current.runtime.deps.db,
      current.runtime.deps.config ?? {},
      workspace.workspaceId,
      'raced-agent',
      attackerAuthority,
    );
    await registerAgentRecord(
      current.runtime.deps.db,
      workspace.workspaceId,
      { name: 'raced-agent' },
      ownerDecision,
    );

    const ownerDelete = await current.app.request('/v1/agents/raced-agent', {
      method: 'DELETE',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${workspace.workspaceKey}`,
      },
      body: JSON.stringify({ registration_authority: ownerAuthority }),
    });
    expect(ownerDelete.status).toBe(204);

    await expect(registerAgentRecord(
      current.runtime.deps.db,
      workspace.workspaceId,
      { name: 'raced-agent' },
      staleAttackerDecision,
    )).rejects.toThrow(/agent_credential_claim_mismatch/u);
    expect(await current.runtime.deps.db
      .select()
      .from(agents)
      .where(and(eq(agents.workspaceId, workspace.workspaceId), eq(agents.name, 'raced-agent'))))
      .toHaveLength(0);
  });

  it('verifies sponsor proof before workspace creation has any side effect', async () => {
    const current = stack();
    const response = await current.app.request('/v1/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'must-not-leak' }),
    });
    expect(response.status).toBe(403);
    expect((await response.json() as ErrorEnvelope).error?.code).toBe('invalid_sponsor_proof');
    expect(await current.runtime.deps.db.select().from(workspaces)).toHaveLength(0);

    const expired = await mintSponsorProof({ issuedAt: Math.floor(Date.now() / 1000) - 600, expiresInSeconds: 1 });
    const expiredResponse = await current.app.request('/v1/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'expired-must-not-leak',
        registration_authority: workspaceAuthority(expired),
      }),
    });
    expect(expiredResponse.status).toBe(403);
    expect(await current.runtime.deps.db.select().from(workspaces)).toHaveLength(0);

    const overlong = await mintSponsorProof({ expiresInSeconds: 15 * 60 + 1 });
    const overlongResponse = await current.app.request('/v1/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'overlong-must-not-leak',
        registration_authority: workspaceAuthority(overlong),
      }),
    });
    expect(overlongResponse.status).toBe(403);
    expect(await current.runtime.deps.db.select().from(workspaces)).toHaveLength(0);
  });

  it('migrates a legacy agent only with its incumbent agent token', async () => {
    const current = stack();
    const legacyWorkspace = await createWorkspaceRecord(current.runtime.deps.db, 'legacy-binding');
    const legacyAgent = await registerAgentRecord(
      current.runtime.deps.db,
      legacyWorkspace.workspace_id,
      { name: 'legacy-agent' },
      { mode: 'unenforced' },
    );
    const proof = await mintSponsorProof({ sponsorId: 'user_legacy_owner' });
    const authority = agentAuthority(proof, 'legacy-work-unit-key-0000000000000000001');

    const preMigrationRotation = await current.app.request('/v1/agents/legacy-agent/rotate-token', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${legacyWorkspace.api_key}`,
      },
      body: JSON.stringify({ registration_authority: authority }),
    });
    expect(preMigrationRotation.status).toBe(409);
    expect((await preMigrationRotation.json() as ErrorEnvelope).error?.code).toBe('agent_sponsor_migration_required');

    const workspaceKeyMigration = await current.app.request('/v1/agent/credential-authority', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${legacyWorkspace.api_key}`,
      },
      body: JSON.stringify({ registration_authority: authority }),
    });
    expect(workspaceKeyMigration.status).toBe(401);

    const migration = await current.app.request('/v1/agent/credential-authority', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${legacyAgent.token}`,
      },
      body: JSON.stringify({ registration_authority: authority }),
    });
    expect(migration.status).toBe(200);

    const [bound] = await current.runtime.deps.db
      .select({ sponsorId: agents.sponsorId, workUnitKeyHash: agents.workUnitKeyHash })
      .from(agents)
      .where(eq(agents.id, legacyAgent.id));
    expect(bound.sponsorId).toBe('user_legacy_owner');
    expect(bound.workUnitKeyHash).toMatch(/^[a-f0-9]{64}$/u);

    const rotation = await current.app.request('/v1/agents/legacy-agent/rotate-token', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${legacyWorkspace.api_key}`,
      },
      body: JSON.stringify({ registration_authority: authority }),
    });
    expect(rotation.status).toBe(200);

    const attackerProof = await mintSponsorProof({ sponsorId: 'user_attacker' });
    const secondBinding = await current.app.request('/v1/agent/credential-authority', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${(await rotation.json() as { data: { token: string } }).data.token}`,
      },
      body: JSON.stringify({ registration_authority: agentAuthority(attackerProof) }),
    });
    expect(secondBinding.status).toBe(409);
    expect((await secondBinding.json() as ErrorEnvelope).error?.code).toBe('agent_credential_authority_mismatch');
  });

  it('rejects the node-control registration bypass without a sponsor grant', async () => {
    const current = stack();
    const proof = await mintSponsorProof();
    const workspace = await createWorkspace(current.app, 'node-control-proof', workspaceAuthority(proof));
    const enroll = await current.app.request('/v1/nodes', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${workspace.workspaceKey}`,
      },
      body: JSON.stringify({
        node_id: 'node_sponsor_test',
        name: 'sponsor-test',
        role: 'broker',
        capabilities: [],
        max_agents: 4,
      }),
    });
    expect(enroll.status).toBe(201);

    const socket = new FakeSocket();
    const send = (frame: Record<string, unknown>) => handleNodeControlMessage({
      db: current.runtime.deps.db,
      registry: current.runtime.realtime,
      completionDeps: current.runtime.deps,
      workspaceId: workspace.workspaceId,
      nodeId: 'node_sponsor_test',
      socket,
      raw: JSON.stringify(frame),
    });
    await send({
      v: 1,
      id: 'node-register',
      type: 'node.register',
      node_id: 'node_sponsor_test',
      name: 'sponsor-test',
      capabilities: [],
      max_agents: 4,
      tags: [],
      version: 'test',
      resume_cursor: null,
    });

    await send({ v: 1, id: 'bypass', type: 'agent.register', name: 'bypass-agent' });
    expect(socket.ofType('error').at(-1)).toMatchObject({
      id: 'bypass',
      code: 'invalid_sponsor_proof',
    });
    expect(await current.runtime.deps.db
      .select()
      .from(agents)
      .where(and(eq(agents.workspaceId, workspace.workspaceId), eq(agents.name, 'bypass-agent'))))
      .toHaveLength(0);

    await send({
      v: 1,
      id: 'sponsored',
      type: 'agent.register',
      name: 'sponsored-node-agent',
      registration_authority: agentAuthority(proof),
    });
    expect(socket.ofType('reply').at(-1)).toMatchObject({
      id: 'sponsored',
      ok: true,
      data: { name: 'sponsored-node-agent', token: expect.stringMatching(/^at_live_/u) },
    });
  });
});
