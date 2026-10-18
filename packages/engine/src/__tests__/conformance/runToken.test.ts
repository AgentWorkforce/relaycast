import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { agents, nodes, runTokens } from '../../db/schema.js';
import { authenticateNodeWs, authenticateRealtimeWs } from '../../engine/wsAuth.js';
import { sha256Hex } from '../../lib/crypto.js';
import { createWorkspace, FakeSocket, makeNodeStack, registerAgent, type TestStack } from './harness.js';

/** Synthetic credentials only; token values are never logged by these tests. */
describe('run-scoped tokens (rt_live_)', () => {
  let stack: TestStack;

  beforeEach(() => {
    stack = makeNodeStack();
  });

  afterEach(async () => {
    await stack.close();
  });

  function request(method: string, path: string, token: string, body?: unknown) {
    return stack.app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async function mint(workspaceKey: string, runId: string, body?: unknown) {
    const res = await request('POST', `/v1/runs/${runId}/tokens`, workspaceKey, body);
    const json = await res.json() as { ok: boolean; data: { token: string; token_expires_at: string; run_id: string } };
    return { res, json };
  }

  async function mintToken(workspaceKey: string, runId: string): Promise<string> {
    const { res, json } = await mint(workspaceKey, runId);
    expect(res.status).toBe(201);
    return json.data.token;
  }

  async function registerWithRunToken(runToken: string, name: string) {
    const res = await request('POST', '/v1/agents', runToken, { name });
    const json = await res.json() as { data: { id: string; token: string; token_expires_at: string; run_id?: string } };
    return { res, json };
  }

  async function enrollNodeWithRunToken(runToken: string, name: string) {
    const res = await request('POST', '/v1/nodes', runToken, {
      name,
      kind: 'ws',
      role: 'broker',
      max_agents: 4,
      capabilities: [],
      tags: ['test'],
      version: 'test',
    });
    const json = await res.json() as { data: { id: string; token: string } };
    return { res, json };
  }

  describe('mint', () => {
    it('defaults to a 900 second lifetime and caps requests at 3600 seconds', async () => {
      const ws = await createWorkspace(stack.app, 'run-mint-defaults');

      const before = Date.now();
      const defaulted = await mint(ws.workspaceKey, 'run-default');
      expect(defaulted.res.status).toBe(201);
      expect(defaulted.json.data.run_id).toBe('run-default');
      expect(defaulted.json.data.token).toMatch(/^rt_live_[0-9a-f]{48}$/);
      const defaultTtl = Date.parse(defaulted.json.data.token_expires_at) - before;
      expect(defaultTtl).toBeGreaterThan(899_000 - 1_000);
      expect(defaultTtl).toBeLessThanOrEqual(900_000);

      const capped = await mint(ws.workspaceKey, 'run-capped', { ttl_seconds: 86_400 });
      expect(capped.res.status).toBe(201);
      const cappedTtl = Date.parse(capped.json.data.token_expires_at) - before;
      expect(cappedTtl).toBeGreaterThan(3_599_000 - 1_000);
      expect(cappedTtl).toBeLessThanOrEqual(3_600_000);

      const custom = await mint(ws.workspaceKey, 'run-custom', { ttl_seconds: 120 });
      expect(Date.parse(custom.json.data.token_expires_at) - before).toBeLessThanOrEqual(120_000);

      expect((await mint(ws.workspaceKey, 'run-bad', { ttl_seconds: 5 })).res.status).toBe(400);
      expect((await mint(ws.workspaceKey, 'run-bad', { ttl_seconds: 'soon' })).res.status).toBe(400);
    });

    it('stores only the token hash and re-mints a fresh token for an active run', async () => {
      const ws = await createWorkspace(stack.app, 'run-mint-refresh');
      const first = await mintToken(ws.workspaceKey, 'run-refresh');
      const second = await mintToken(ws.workspaceKey, 'run-refresh');
      expect(second).not.toBe(first);

      const rows = await stack.runtime.deps.db.select().from(runTokens).where(eq(runTokens.runId, 'run-refresh'));
      expect(rows).toHaveLength(2);
      const hashes = rows.map((row) => row.tokenHash);
      expect(hashes).toContain(await sha256Hex(first));
      expect(hashes).not.toContain(first);
      // Both are live until they expire; refresh does not cut the old one off.
      expect((await registerWithRunToken(first, 'refresh-a')).res.status).toBe(201);
      expect((await registerWithRunToken(second, 'refresh-b')).res.status).toBe(201);
    });

    it('requires the workspace key and a valid run id', async () => {
      const ws = await createWorkspace(stack.app, 'run-mint-auth');
      const agent = await registerAgent(stack.app, ws.workspaceKey, 'not-admin');
      const runToken = await mintToken(ws.workspaceKey, 'run-auth');
      expect((await mint(agent.token, 'run-auth')).res.status).toBe(401);
      expect((await mint(runToken, 'run-auth')).res.status).toBe(401);
      expect((await mint(ws.workspaceKey, '%20bad%20id')).res.status).toBe(400);
    });
  });

  describe('accepted routes', () => {
    it('POST /v1/agents stamps the run id and issues a bounded agent token', async () => {
      const ws = await createWorkspace(stack.app, 'run-register');
      const runToken = await mintToken(ws.workspaceKey, 'run-reg');
      const { res, json } = await registerWithRunToken(runToken, 'run-worker');
      expect(res.status).toBe(201);
      expect(json.data.run_id).toBe('run-reg');
      expect(json.data.token).toMatch(/^at_live_/);
      expect(Date.parse(json.data.token_expires_at) - Date.now()).toBeLessThanOrEqual(15 * 60_000);

      const [row] = await stack.runtime.deps.db.select().from(agents).where(eq(agents.id, json.data.id));
      expect(row?.runId).toBe('run-reg');
      // The issued agent token works as a normal agent credential.
      expect((await request('GET', '/v1/inbox', json.data.token)).status).toBe(200);
    });

    it('DELETE /v1/agents/:name removes an agent of the same run', async () => {
      const ws = await createWorkspace(stack.app, 'run-delete');
      const runToken = await mintToken(ws.workspaceKey, 'run-del');
      expect((await registerWithRunToken(runToken, 'doomed')).res.status).toBe(201);
      expect((await request('DELETE', '/v1/agents/doomed', runToken)).status).toBe(204);
      expect((await request('GET', '/v1/agents/doomed', ws.workspaceKey)).status).toBe(404);
    });

    it('POST /v1/nodes stamps the run id on a new node', async () => {
      const ws = await createWorkspace(stack.app, 'run-node');
      const runToken = await mintToken(ws.workspaceKey, 'run-node');
      const { res, json } = await enrollNodeWithRunToken(runToken, 'run-broker');
      expect(res.status).toBe(201);
      expect(json.data.token).toMatch(/^nt_live_/);
      const [row] = await stack.runtime.deps.db.select().from(nodes).where(eq(nodes.id, json.data.id));
      expect(row?.runId).toBe('run-node');
      expect(await authenticateNodeWs(
        { auth: stack.runtime.deps.auth, db: stack.runtime.deps.db },
        json.data.token,
      )).toMatchObject({ ok: true });
    });

    it('refuses to re-enroll a node owned by the workspace or another run', async () => {
      const ws = await createWorkspace(stack.app, 'run-node-scope');
      const workspaceNode = await request('POST', '/v1/nodes', ws.workspaceKey, { name: 'shared-broker', kind: 'ws', role: 'broker' });
      expect(workspaceNode.status).toBe(201);
      const workspaceNodeToken = ((await workspaceNode.json()) as { data: { token: string } }).data.token;
      const runToken = await mintToken(ws.workspaceKey, 'run-scope');
      const res = await stack.app.request('/v1/nodes', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${runToken}`,
          'content-type': 'application/json',
          'X-Relaycast-Node-Token': workspaceNodeToken,
        },
        body: JSON.stringify({ name: 'shared-broker', kind: 'ws', role: 'broker' }),
      });
      expect(res.status).toBe(403);
    });
  });

  describe('rejected routes', () => {
    it('rejects a run token on every other representative route', async () => {
      const ws = await createWorkspace(stack.app, 'run-reject');
      const runToken = await mintToken(ws.workspaceKey, 'run-reject');
      expect((await registerWithRunToken(runToken, 'scoped')).res.status).toBe(201);
      expect((await enrollNodeWithRunToken(runToken, 'scoped-node')).res.status).toBe(201);

      const routes: Array<[string, string, unknown?]> = [
        ['GET', '/v1/agents'],
        ['GET', '/v1/agents/scoped'],
        ['PATCH', '/v1/agents/scoped', { persona: 'x' }],
        ['POST', '/v1/agents/spawn', { name: 'x', cli: 'claude' }],
        ['POST', '/v1/agents/scoped/rotate-token'],
        ['POST', '/v1/agents/retention', {}],
        ['GET', '/v1/inbox'],
        ['GET', '/v1/channels'],
        ['POST', '/v1/channels', { name: 'run-chan' }],
        ['POST', '/v1/channels/general/messages', { text: 'hi' }],
        ['POST', '/v1/dm', { to: 'scoped', text: 'hi' }],
        ['GET', '/v1/nodes'],
        ['GET', '/v1/nodes/scoped-node'],
        ['POST', '/v1/nodes/scoped-node/agents', { agent_name: 'scoped' }],
        ['GET', '/v1/node/me'],
        ['GET', '/v1/activity'],
        ['POST', '/v1/observer-tokens', { name: 'o', scopes: ['agents:read'] }],
        ['PATCH', '/v1/workspace', { name: 'renamed' }],
        ['DELETE', '/v1/workspace'],
        ['POST', '/v1/runs/run-reject/tokens'],
        ['POST', '/v1/runs/other-run/tokens'],
        ['DELETE', '/v1/runs/run-reject/authority'],
      ];
      for (const [method, path, body] of routes) {
        const res = await request(method, path, runToken, body);
        expect({ method, path, status: res.status }).toEqual({
          method,
          path,
          status: expect.toBeOneOf([401, 403]),
        });
      }

      const deps = { auth: stack.runtime.deps.auth, db: stack.runtime.deps.db };
      expect(await authenticateRealtimeWs(deps, runToken)).toMatchObject({ ok: false, status: 401 });
      expect(await authenticateNodeWs(deps, runToken)).toMatchObject({ ok: false, status: 401 });
    });

    it('denies deleting an agent of another run or the workspace', async () => {
      const ws = await createWorkspace(stack.app, 'run-cross-delete');
      const runA = await mintToken(ws.workspaceKey, 'run-a');
      const runB = await mintToken(ws.workspaceKey, 'run-b');
      expect((await registerWithRunToken(runA, 'agent-a')).res.status).toBe(201);
      await registerAgent(stack.app, ws.workspaceKey, 'workspace-agent');

      expect((await request('DELETE', '/v1/agents/agent-a', runB)).status).toBe(404);
      expect((await request('DELETE', '/v1/agents/workspace-agent', runA)).status).toBe(404);
      expect((await request('GET', '/v1/agents/agent-a', ws.workspaceKey)).status).toBe(200);
      expect((await request('GET', '/v1/agents/workspace-agent', ws.workspaceKey)).status).toBe(200);
    });

    it('rejects an expired run token', async () => {
      const ws = await createWorkspace(stack.app, 'run-expired');
      const runToken = await mintToken(ws.workspaceKey, 'run-exp');
      expect((await registerWithRunToken(runToken, 'early')).res.status).toBe(201);
      await stack.runtime.deps.db.update(runTokens)
        .set({ expiresAt: new Date(Date.now() - 1_000) })
        .where(eq(runTokens.tokenHash, await sha256Hex(runToken)));
      const late = await registerWithRunToken(runToken, 'late');
      expect(late.res.status).toBe(401);
      expect((await request('POST', '/v1/nodes', runToken, { name: 'late-node' })).status).toBe(401);
    });
  });

  describe('revoke', () => {
    it('cascades to run tokens, agents, nodes, and live node connections', async () => {
      const ws = await createWorkspace(stack.app, 'run-revoke');
      const runToken = await mintToken(ws.workspaceKey, 'run-rev');
      const otherRunToken = await mintToken(ws.workspaceKey, 'run-keep');
      const agent = await registerWithRunToken(runToken, 'rev-agent');
      const node = await enrollNodeWithRunToken(runToken, 'rev-node');
      const survivor = await registerWithRunToken(otherRunToken, 'keep-agent');
      const workspaceAgent = await registerAgent(stack.app, ws.workspaceKey, 'ws-agent');
      expect(agent.res.status).toBe(201);
      expect(node.res.status).toBe(201);

      const nodeSocket = new FakeSocket();
      const handle = stack.runtime.realtime.attachNodeSocket(ws.workspaceId, node.json.data.id, nodeSocket);
      await handle.handleMessage(JSON.stringify({
        v: 1,
        id: 'reg-1',
        type: 'node.register',
        node_id: node.json.data.id,
        name: 'rev-node',
        capabilities: [],
        max_agents: 4,
        tags: ['test'],
        version: 'test',
        resume_cursor: null,
      }));
      expect(nodeSocket.closed).toBe(false);

      const deps = { auth: stack.runtime.deps.auth, db: stack.runtime.deps.db };
      expect((await request('GET', '/v1/inbox', agent.json.data.token)).status).toBe(200);
      expect((await request('GET', '/v1/node/me', node.json.data.token)).status).toBe(200);

      const revoked = await request('DELETE', '/v1/runs/run-rev/authority', ws.workspaceKey);
      expect(revoked.status).toBe(200);
      const body = await revoked.json() as { data: Record<string, unknown> };
      expect(body.data).toMatchObject({
        run_id: 'run-rev',
        run_tokens_revoked: 1,
        agents_revoked: 1,
        nodes_revoked: 1,
      });
      expect(typeof body.data.revoked_at).toBe('string');

      // Live connection closed by the revoke itself.
      expect(nodeSocket.closed).toBe(true);
      // Every credential of the run is dead.
      expect((await registerWithRunToken(runToken, 'after')).res.status).toBe(401);
      expect((await request('GET', '/v1/inbox', agent.json.data.token)).status).toBe(401);
      expect((await request('GET', '/v1/node/me', node.json.data.token)).status).toBe(401);
      expect(await authenticateNodeWs(deps, node.json.data.token)).toMatchObject({ ok: false, status: 401 });
      // Other runs and workspace principals are untouched.
      expect((await request('GET', '/v1/inbox', survivor.json.data.token)).status).toBe(200);
      expect((await request('GET', '/v1/inbox', workspaceAgent.token)).status).toBe(200);
      expect((await registerWithRunToken(otherRunToken, 'keep-2')).res.status).toBe(201);

      // Idempotent: repeating keeps the original timestamp and touches nothing new.
      const again = await request('DELETE', '/v1/runs/run-rev/authority', ws.workspaceKey);
      expect(again.status).toBe(200);
      const againBody = await again.json() as { data: Record<string, unknown> };
      expect(againBody.data).toMatchObject({
        run_id: 'run-rev',
        revoked_at: body.data.revoked_at,
        run_tokens_revoked: 0,
        agents_revoked: 0,
        nodes_revoked: 0,
      });
    });

    it('blocks a run credential re-issued after revoke (recovery path)', async () => {
      const ws = await createWorkspace(stack.app, 'run-revoke-reissue');
      const runToken = await mintToken(ws.workspaceKey, 'run-reissue');
      const agent = await registerWithRunToken(runToken, 'reissued');
      expect((await request('DELETE', '/v1/runs/run-reissue/authority', ws.workspaceKey)).status).toBe(200);
      // Simulate any later path that writes a fresh hash onto the run agent.
      const fresh = 'at_live_00000000000000000000000000000000';
      await stack.runtime.deps.db.update(agents)
        .set({ tokenHash: await sha256Hex(fresh), tokenExpiresAt: new Date(Date.now() + 60_000) })
        .where(and(eq(agents.workspaceId, ws.workspaceId), eq(agents.id, agent.json.data.id)));
      expect((await request('GET', '/v1/inbox', fresh)).status).toBe(401);
    });

    it('refuses to mint for a revoked run, including one revoked before first mint', async () => {
      const ws = await createWorkspace(stack.app, 'run-mint-after-revoke');
      await mintToken(ws.workspaceKey, 'run-done');
      expect((await request('DELETE', '/v1/runs/run-done/authority', ws.workspaceKey)).status).toBe(200);
      const after = await mint(ws.workspaceKey, 'run-done');
      expect(after.res.status).toBe(410);
      expect((after.json as unknown as { error: { code: string } }).error.code).toBe('run_authority_revoked');

      expect((await request('DELETE', '/v1/runs/never-minted/authority', ws.workspaceKey)).status).toBe(200);
      expect((await mint(ws.workspaceKey, 'never-minted')).res.status).toBe(410);
    });

    it('is scoped to the calling workspace and requires the workspace key', async () => {
      const wsA = await createWorkspace(stack.app, 'run-ws-a');
      const wsB = await createWorkspace(stack.app, 'run-ws-b');
      const runToken = await mintToken(wsA.workspaceKey, 'shared-run-id');
      expect((await request('DELETE', '/v1/runs/shared-run-id/authority', wsB.workspaceKey)).status).toBe(200);
      // Workspace B revoking its own namespace does not touch workspace A's run.
      expect((await registerWithRunToken(runToken, 'still-live')).res.status).toBe(201);
      const agent = await registerAgent(stack.app, wsA.workspaceKey, 'plain');
      expect((await request('DELETE', '/v1/runs/shared-run-id/authority', agent.token)).status).toBe(401);
    });
  });
});
