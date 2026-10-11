import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { agentIdentityAudit, agentRecoveryCredentials, agents } from '../../db/schema.js';
import { sha256Hex } from '../../lib/crypto.js';
import { RELEASED_AGENT_STATUS } from '../../engine/agent.js';
import {
  attachDirectNodeSocket,
  contextUpdatesOfType,
  createWorkspace,
  FakeSocket,
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

  async function registerViaNode(
    workspace: { workspaceKey: string; workspaceId: string },
    nodeId: string,
    nodeName: string,
    agentName: string,
  ): Promise<{ agentId: string; nodeToken: string }> {
    const enrolled = await stack.app.request('/v1/nodes', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${workspace.workspaceKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        node_id: nodeId,
        name: nodeName,
        role: 'broker',
        capabilities: [],
        max_agents: 2,
        tags: ['identity-recovery-test'],
        version: 'v1',
      }),
    });
    expect(enrolled.status).toBe(201);
    const nodeToken = (await enrolled.json() as { data: { token: string } }).data.token;
    const socket = new FakeSocket();
    const handle = stack.runtime.realtime.attachNodeSocket(workspace.workspaceId, nodeId, socket);
    await handle.handleMessage(JSON.stringify({
      v: 1,
      id: `register-${nodeId}`,
      type: 'node.register',
      node_id: nodeId,
      name: nodeName,
      capabilities: [],
      max_agents: 2,
      tags: ['identity-recovery-test'],
      version: 'v1',
      resume_cursor: null,
    }));
    await handle.handleMessage(JSON.stringify({
      v: 1,
      id: `agent-${nodeId}`,
      type: 'agent.register',
      name: agentName,
    }));
    const reply = socket.received.findLast((frame) => frame.id === `agent-${nodeId}`) as {
      ok?: boolean;
      data?: { agent_id?: string };
    } | undefined;
    expect(reply).toMatchObject({ ok: true });
    return { agentId: reply?.data?.agent_id ?? '', nodeToken };
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

  it('only reclaims the tombstone belonging to the SAME name', async () => {
    // Review caught this: workspace + released status alone would let any new
    // name in the workspace consume a different agent's verifier and inherit
    // recovery authority backed by that agent's proof. Reclaiming `foo` must
    // only ever consume what `foo` left behind.
    const workspace = await createWorkspace(stack.app, 'cross-name-reclaim-workspace');
    const verifierHash = 'e'.repeat(64);
    const register = (name: string) => stack.app.request('/v1/agents', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${workspace.workspaceKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name, recovery_proof_hash: verifierHash }),
    });

    expect((await register('original-name')).status).toBe(201);
    expect((await stack.app.request('/v1/agents/original-name', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${workspace.workspaceKey}` },
    })).status).toBe(204);

    // A DIFFERENT name must not inherit the tombstone's verifier.
    const other = await register('unrelated-name');
    expect(other.status).toBe(409);
    await expect(other.json()).resolves.toMatchObject({
      error: { code: 'agent_recovery_proof_conflict' },
    });

    // ...and the tombstone's credential is still there, so the rightful name
    // can still reclaim it afterwards.
    expect((await register('original-name')).status).toBe(201);
  });

  it('never takes a verifier from a LIVE identity in the same workspace', async () => {
    // The guard that matters. Reclaim only applies to a tombstoned holder; if
    // it ever applied to a live one it would hand that agent's recovery
    // authority to whoever registered next. The existing reuse test is
    // cross-workspace, where the workspace scope alone would block it, so this
    // one is deliberately SAME-workspace: it fails if the released check is
    // dropped while every other test still passes.
    const workspace = await createWorkspace(stack.app, 'live-verifier-workspace');
    const verifierHash = 'd'.repeat(64);
    const register = (name: string) => stack.app.request('/v1/agents', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${workspace.workspaceKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name, recovery_proof_hash: verifierHash }),
    });

    const live = await register('live-holder');
    expect(live.status).toBe(201);
    const liveAgent = await live.json() as { data: { id: string } };

    const stolen = await register('would-be-thief');
    expect(stolen.status).toBe(409);
    await expect(stolen.json()).resolves.toMatchObject({
      error: { code: 'agent_recovery_proof_conflict' },
    });

    // The holder keeps its credential: refusing the request is not enough if
    // the row was already deleted on the way to refusing it.
    const rows = await stack.runtime.deps.db
      .select()
      .from(agentRecoveryCredentials)
      .where(eq(agentRecoveryCredentials.verifierHash, verifierHash));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.agentId).toBe(liveAgent.data.id);
  });

  it('lets a released name be registered again with the same derived verifier', async () => {
    // Release tombstones the agent but keeps its credential enrolled, and the
    // verifier is globally unique. A caller deriving the verifier from stable
    // inputs -- workspace, owner, agent name -- re-presents the same value on
    // every attempt, so without reclaim a released name is unregisterable
    // forever and no retry can clear it.
    const workspace = await createWorkspace(stack.app, 'released-verifier-workspace');
    const verifierHash = 'c'.repeat(64);
    const register = () => stack.app.request('/v1/agents', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${workspace.workspaceKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'recycled-name', recovery_proof_hash: verifierHash }),
    });

    expect((await register()).status).toBe(201);

    const released = await stack.app.request('/v1/agents/recycled-name', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${workspace.workspaceKey}` },
    });
    expect(released.status).toBe(204);

    // Before the reclaim this was a permanent 409.
    const again = await register();
    expect(again.status).toBe(201);

    // The reclaim must take exactly one credential, not leave a duplicate or
    // strand the tombstone's row: the new identity owns the verifier now.
    const rows = await stack.runtime.deps.db
      .select()
      .from(agentRecoveryCredentials)
      .where(eq(agentRecoveryCredentials.verifierHash, verifierHash));
    expect(rows).toHaveLength(1);
  });

  it('reports verifier reuse accurately and rejects cross-workspace credential rows', async () => {
    const firstWorkspace = await createWorkspace(stack.app, 'proof-owner-workspace');
    const secondWorkspace = await createWorkspace(stack.app, 'proof-attacker-workspace');
    const verifierHash = 'a'.repeat(64);

    const first = await stack.app.request('/v1/agents', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${firstWorkspace.workspaceKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'proof-owner', recovery_proof_hash: verifierHash }),
    });
    expect(first.status).toBe(201);
    const firstAgent = await first.json() as { data: { id: string } };

    const duplicate = await stack.app.request('/v1/agents', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${secondWorkspace.workspaceKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'different-name', recovery_proof_hash: verifierHash }),
    });
    expect(duplicate.status).toBe(409);
    await expect(duplicate.json()).resolves.toMatchObject({
      error: { code: 'agent_recovery_proof_conflict' },
    });

    await expect(stack.runtime.deps.db.insert(agentRecoveryCredentials).values({
      workspaceId: secondWorkspace.workspaceId,
      agentId: firstAgent.data.id,
      proofKind: 'work_unit',
      verifierHash: 'b'.repeat(64),
    })).rejects.toThrow();
  });

  it('recovers through HTTP only with the server-owned origin node token', async () => {
    const workspace = await createWorkspace(stack.app, 'origin-node-http-recovery');
    const origin = await registerViaNode(workspace, 'node_origin', 'origin', 'node-worker');
    const foreign = await registerViaNode(workspace, 'node_foreign', 'foreign', 'other-worker');

    const denied = await post('/v1/agents/node-worker/recover', foreign.nodeToken, {
      expected_agent_id: origin.agentId,
      node_id: 'node_foreign',
    });
    expect(denied.status).toBe(403);

    const recovered = await post('/v1/agents/node-worker/recover', origin.nodeToken, {
      expected_agent_id: origin.agentId,
      node_id: 'node_origin',
    });
    expect(recovered.status).toBe(200);
    expect((await authenticate(await responseToken(recovered))).status).toBe(200);
  });

  it('never issues a token for a terminal released identity', async () => {
    const workspace = await createWorkspace(stack.app, 'released-agent-recovery');
    const proof = 'released-agent-proof';
    const registration = await stack.app.request('/v1/agents', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${workspace.workspaceKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'released-worker',
        recovery_proof_hash: await sha256Hex(proof),
      }),
    });
    const registered = await registration.json() as { data: { id: string } };
    await stack.runtime.deps.db
      .update(agents)
      .set({ status: RELEASED_AGENT_STATUS })
      .where(eq(agents.id, registered.data.id));

    const recovered = await stack.app.request('/v1/agents/released-worker/recover', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expected_agent_id: registered.data.id,
        recovery_proof: proof,
      }),
    });
    expect(recovered.status).toBe(409);
    await expect(recovered.json()).resolves.toMatchObject({
      error: { code: 'agent_identity_conflict' },
    });
    expect(await stack.runtime.deps.db.select().from(agentIdentityAudit)).toHaveLength(0);
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
