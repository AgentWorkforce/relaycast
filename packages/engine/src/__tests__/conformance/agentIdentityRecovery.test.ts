import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { agentIdentityAudit } from '../../db/schema.js';
import { sha256Hex } from '../../lib/crypto.js';
import {
  attachDirectNodeSocket,
  contextUpdatesOfType,
  createWorkspace,
  makeNodeStack,
  registerAgent,
  type TestStack,
} from './harness.js';

describe('explicit agent identity recovery', () => {
  let stack: TestStack;

  beforeEach(() => { stack = makeNodeStack(); });
  afterEach(() => stack.close());

  function post(
    path: string,
    token: string,
    body: Record<string, unknown>,
  ): Promise<Response> {
    return stack.app.request(path, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-relaycast-origin-actor': 'conformance/operator/test',
      },
      body: JSON.stringify(body),
    });
  }

  async function authenticate(token: string): Promise<Response> {
    return stack.app.request('/v1/agent', {
      headers: { authorization: `Bearer ${token}` },
    });
  }

  async function responseToken(response: Response): Promise<string> {
    const body = await response.json() as { data?: { token?: string } };
    return body.data?.token ?? '';
  }

  it('recovers with the current agent token and refuses another agent token', async () => {
    const workspace = await createWorkspace(stack.app, 'current-token-recovery');
    const incumbent = await registerAgent(stack.app, workspace.workspaceKey, 'incumbent');
    const stranger = await registerAgent(stack.app, workspace.workspaceKey, 'stranger');

    const denied = await post('/v1/agents/incumbent/recover', stranger.token, {
      expected_agent_id: incumbent.agentId,
    });
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toMatchObject({
      error: { code: 'agent_recovery_not_authorized' },
    });
    expect((await authenticate(incumbent.token)).status).toBe(200);

    const recovered = await post('/v1/agents/incumbent/recover', incumbent.token, {
      expected_agent_id: incumbent.agentId,
    });
    expect(recovered.status).toBe(200);
    const replacement = await responseToken(recovered);
    expect(replacement).toMatch(/^at_live_[0-9a-f]{32}$/);
    expect((await authenticate(replacement)).status).toBe(200);
    // Authorised rollover retains #332's grace slot.
    expect((await authenticate(incumbent.token)).status).toBe(200);
  });

  it('recovers with a registered work-unit proof and refuses a bad proof', async () => {
    const workspace = await createWorkspace(stack.app, 'work-unit-recovery');
    const proof = 'stable-work-unit-proof';
    const registration = await stack.app.request('/v1/agents', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${workspace.workspaceKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'proof-holder',
        recovery_proof_hash: await sha256Hex(proof),
      }),
    });
    expect(registration.status).toBe(201);
    const registeredBody = await registration.json() as { data: { id: string; token: string } };

    const denied = await stack.app.request('/v1/agents/proof-holder/recover', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expected_agent_id: registeredBody.data.id,
        recovery_proof: 'wrong-proof',
      }),
    });
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toMatchObject({
      error: { code: 'agent_recovery_not_authorized' },
    });
    expect((await authenticate(registeredBody.data.token)).status).toBe(200);

    const recovered = await stack.app.request('/v1/agents/proof-holder/recover', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${workspace.workspaceKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        expected_agent_id: registeredBody.data.id,
        recovery_proof: proof,
      }),
    });
    expect(recovered.status).toBe(200);
    expect((await authenticate(await responseToken(recovered))).status).toBe(200);
  });

  it('requires an exact id and audit context for an owner takeover and notifies the incumbent', async () => {
    const workspace = await createWorkspace(stack.app, 'owner-takeover');
    const incumbent = await registerAgent(stack.app, workspace.workspaceKey, 'contested');
    const { sock } = await attachDirectNodeSocket(stack, workspace.workspaceId, incumbent);

    const incomplete = await post('/v1/agents/contested/takeover', workspace.workspaceKey, {
      expected_agent_id: incumbent.agentId,
      actor: 'operator-test',
      reason: 'missing incident context',
    });
    expect(incomplete.status).toBe(400);

    const stale = await post('/v1/agents/contested/takeover', workspace.workspaceKey, {
      expected_agent_id: 'agent_stale',
      actor: 'operator-test',
      reason: 'lost durable recovery state',
      session_ref: 'session-test',
      node_id: 'node-test',
    });
    expect(stale.status).toBe(409);
    expect((await authenticate(incumbent.token)).status).toBe(200);

    const taken = await post('/v1/agents/contested/takeover', workspace.workspaceKey, {
      expected_agent_id: incumbent.agentId,
      actor: 'operator-test',
      reason: 'lost durable recovery state',
      session_ref: 'session-test',
      node_id: 'node-test',
    });
    expect(taken.status).toBe(200);
    await expect(taken.clone().json()).resolves.toMatchObject({
      data: {
        agent_id: incumbent.agentId,
        audit_id: expect.stringMatching(/^aid_/),
      },
    });
    expect((await authenticate(await responseToken(taken))).status).toBe(200);

    const auditRows = await stack.runtime.deps.db
      .select()
      .from(agentIdentityAudit)
      .where(eq(agentIdentityAudit.agentId, incumbent.agentId));
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: 'takeover',
      authority: 'workspace_admin',
      actor: 'operator-test',
      reason: 'lost durable recovery state',
      sessionRef: 'session-test',
      nodeId: 'node-test',
      originActor: 'conformance/operator/test',
    });

    const notifications = contextUpdatesOfType(sock, 'agent.identity_taken_over');
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.data).toMatchObject({
      agent_id: incumbent.agentId,
      actor: 'operator-test',
      reason: 'lost durable recovery state',
      session_ref: 'session-test',
      node_id: 'node-test',
    });
  });

  it('immediately revokes both token slots without overloading rollover', async () => {
    const workspace = await createWorkspace(stack.app, 'immediate-revoke');
    const agent = await registerAgent(stack.app, workspace.workspaceKey, 'compromised');
    const rolled = await post('/v1/agents/compromised/recover', agent.token, {
      expected_agent_id: agent.agentId,
    });
    expect(rolled.status).toBe(200);
    const current = await responseToken(rolled);
    expect((await authenticate(agent.token)).status).toBe(200);
    expect((await authenticate(current)).status).toBe(200);

    const revoked = await post('/v1/agents/compromised/revoke-token', workspace.workspaceKey, {
      expected_agent_id: agent.agentId,
      actor: 'security-operator',
      reason: 'credential compromise',
    });
    expect(revoked.status).toBe(200);
    expect((await authenticate(agent.token)).status).toBe(401);
    expect((await authenticate(current)).status).toBe(401);
  });
});
