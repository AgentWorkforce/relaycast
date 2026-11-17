import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createWorkspace, makeNodeStack, registerAgent, type TestStack } from './harness.js';
import { workspaces } from '../../db/tables.js';

describe('workspace leaders', () => {
  let stack: TestStack;

  beforeEach(() => {
    stack = makeNodeStack();
  });

  afterEach(() => stack.close());

  async function send(method: string, path: string, key: string, body?: unknown) {
    const res = await stack.app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
    return { status: res.status, body: await res.json() as { ok: boolean; data?: unknown; error?: { code: string } } };
  }

  const getLeaders = (key: string) => send('GET', '/v1/workspace/leaders', key);
  const putLeaders = (key: string, body: unknown) => send('PUT', '/v1/workspace/leaders', key, body);

  async function enrollNodeToken(workspaceKey: string) {
    const enrolled = await stack.app.request('/v1/nodes', {
      method: 'POST',
      headers: { authorization: `Bearer ${workspaceKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        node_id: 'leaders-node',
        name: 'leaders-node',
        role: 'broker',
        capabilities: [],
        max_agents: 4,
        tags: [],
        version: 'test',
      }),
    });
    expect(enrolled.status).toBe(201);
    const { data } = await enrolled.json() as { data: { token: string } };
    expect(data.token).toMatch(/^nt_live_/);
    return data.token;
  }

  it('returns empty leaders and patterns when unset, to agents and the workspace key', async () => {
    const ws = await createWorkspace(stack.app, 'leaders-unset');
    const agent = await registerAgent(stack.app, ws.workspaceKey, 'opsgrok');

    for (const key of [ws.workspaceKey, agent.token]) {
      const res = await getLeaders(key);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, data: { leaders: [], patterns: [] } });
    }
  });

  it('requires authentication to read and the workspace key to write', async () => {
    const ws = await createWorkspace(stack.app, 'leaders-auth');
    const agent = await registerAgent(stack.app, ws.workspaceKey, 'opsgrok');

    const anonymous = await stack.app.request('/v1/workspace/leaders');
    expect(anonymous.status).toBe(401);

    const denied = await putLeaders(agent.token, { patterns: ['*grok'] });
    expect(denied.status).toBe(401);
    expect(denied.body.ok).toBe(false);
    // The agent's attempt did not change the stored list.
    expect((await getLeaders(ws.workspaceKey)).body.data).toEqual({ leaders: [], patterns: [] });
  });

  it('resolves exact names and globs against registered agents, sorted and deduped', async () => {
    const ws = await createWorkspace(stack.app, 'leaders-resolve');
    const other = await createWorkspace(stack.app, 'leaders-other');
    const zeta = await registerAgent(stack.app, ws.workspaceKey, 'zetagrok');
    const admin = await registerAgent(stack.app, ws.workspaceKey, 'admin');
    const ops = await registerAgent(stack.app, ws.workspaceKey, 'opsgrok');
    const leadA = await registerAgent(stack.app, ws.workspaceKey, 'lead-a');
    await registerAgent(stack.app, ws.workspaceKey, 'Admin');
    await registerAgent(stack.app, ws.workspaceKey, 'grokker');
    await registerAgent(stack.app, ws.workspaceKey, 'worker');
    // Same name in another workspace never leaks across.
    await registerAgent(stack.app, other.workspaceKey, 'admin');

    const put = await putLeaders(ws.workspaceKey, {
      // `opsgrok` matches both `*grok` and `ops*`; `ghost` is not registered.
      patterns: ['*grok', ' admin ', 'ops*', 'ghost', 'lead-?', '*grok'],
    });
    const expected = {
      leaders: [
        { name: admin.name, agent_id: admin.agentId },
        { name: leadA.name, agent_id: leadA.agentId },
        { name: ops.name, agent_id: ops.agentId },
        { name: zeta.name, agent_id: zeta.agentId },
      ],
      patterns: ['*grok', 'admin', 'ops*', 'ghost', 'lead-?'],
    };
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ ok: true, data: expected });

    const agent = await registerAgent(stack.app, ws.workspaceKey, 'reader');
    expect((await getLeaders(agent.token)).body).toEqual({ ok: true, data: expected });
    expect((await getLeaders(other.workspaceKey)).body.data).toEqual({ leaders: [], patterns: [] });

    // A newly registered matching agent becomes a leader without a re-PUT.
    const ghost = await registerAgent(stack.app, ws.workspaceKey, 'ghost');
    const after = (await getLeaders(ws.workspaceKey)).body.data as typeof expected;
    expect(after.leaders.map((leader) => leader.name)).toEqual(['admin', 'ghost', 'lead-a', 'opsgrok', 'zetagrok']);
    expect(after.leaders[1]).toEqual({ name: 'ghost', agent_id: ghost.agentId });

    // A removed agent stops being a leader.
    const removed = await stack.app.request('/v1/agents/zetagrok', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${ws.workspaceKey}` },
    });
    expect(removed.status).toBe(204);
    const pruned = (await getLeaders(ws.workspaceKey)).body.data as typeof expected;
    expect(pruned.leaders.map((leader) => leader.name)).toEqual(['admin', 'ghost', 'lead-a', 'opsgrok']);
  });

  it('stores the list on the workspace row without exposing it on the workspace shape', async () => {
    const ws = await createWorkspace(stack.app, 'leaders-storage');
    await putLeaders(ws.workspaceKey, { patterns: ['lead-*'] });

    const [row] = await stack.runtime.deps.db
      .select({ leaders: workspaces.leaders })
      .from(workspaces)
      .where(eq(workspaces.id, ws.workspaceId));
    expect(row?.leaders).toEqual({ patterns: ['lead-*'] });

    const info = await send('GET', '/v1/workspace', ws.workspaceKey);
    expect(info.status).toBe(200);
    expect(info.body.data).not.toHaveProperty('leaders');
  });

  it.each([
    ['a missing patterns field', {}],
    ['a string', { patterns: 'admin' }],
    ['null patterns', { patterns: null }],
    ['a non-string entry', { patterns: ['admin', 7] }],
    ['an empty entry', { patterns: [''] }],
    ['a whitespace entry', { patterns: ['  '] }],
    ['an entry over 128 characters', { patterns: ['a'.repeat(129)] }],
    ['a control character', { patterns: ['ad\u0007min'] }],
    ['65 entries', { patterns: Array.from({ length: 65 }, (_, i) => `agent-${i}`) }],
    ['reset combined with patterns', { reset: true, patterns: ['admin'] }],
    ['a non-boolean reset', { reset: 'yes' }],
    ['a non-object body', ['admin']],
    ['malformed JSON', '{"patterns":'],
  ])('rejects %s with 400 invalid_request', async (_label, body) => {
    const ws = await createWorkspace(stack.app, 'leaders-invalid');
    await putLeaders(ws.workspaceKey, { patterns: ['admin'] });

    const res = await putLeaders(ws.workspaceKey, body);
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error?.code).toBe('invalid_request');
    // A rejected write leaves the stored list unchanged.
    expect((await getLeaders(ws.workspaceKey)).body.data).toEqual({ leaders: [], patterns: ['admin'] });
  });

  it('accepts 64 patterns', async () => {
    const ws = await createWorkspace(stack.app, 'leaders-max');
    const patterns = Array.from({ length: 64 }, (_, i) => `agent-${i}`);
    const res = await putLeaders(ws.workspaceKey, { patterns });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ leaders: [], patterns });
  });

  it.each([
    ['an empty list', { patterns: [] }],
    ['reset: true', { reset: true }],
  ])('clears the list with %s', async (_label, body) => {
    const ws = await createWorkspace(stack.app, 'leaders-reset');
    await registerAgent(stack.app, ws.workspaceKey, 'admin');
    const set = await putLeaders(ws.workspaceKey, { patterns: ['admin'] });
    expect((set.body.data as { leaders: unknown[] }).leaders).toHaveLength(1);

    const cleared = await putLeaders(ws.workspaceKey, body);
    expect(cleared.status).toBe(200);
    expect(cleared.body).toEqual({ ok: true, data: { leaders: [], patterns: [] } });
    expect((await getLeaders(ws.workspaceKey)).body.data).toEqual({ leaders: [], patterns: [] });

    const [row] = await stack.runtime.deps.db
      .select({ leaders: workspaces.leaders })
      .from(workspaces)
      .where(eq(workspaces.id, ws.workspaceId));
    expect(row?.leaders).toBeNull();
  });

  it('lets a node token read the leaders the workspace key reads', async () => {
    const ws = await createWorkspace(stack.app, 'leaders-node-read');
    await registerAgent(stack.app, ws.workspaceKey, 'opsgrok');
    await registerAgent(stack.app, ws.workspaceKey, 'worker');
    const put = await putLeaders(ws.workspaceKey, { patterns: ['*grok', 'ghost'] });
    expect(put.status).toBe(200);
    const nodeToken = await enrollNodeToken(ws.workspaceKey);

    const viaNode = await getLeaders(nodeToken);
    expect(viaNode.status).toBe(200);
    expect(viaNode.body).toEqual({
      ok: true,
      data: { leaders: [expect.objectContaining({ name: 'opsgrok' })], patterns: ['*grok', 'ghost'] },
    });
    expect(viaNode.body).toEqual((await getLeaders(ws.workspaceKey)).body);
  });

  it('refuses a node token on PUT and leaves the stored list unchanged', async () => {
    const ws = await createWorkspace(stack.app, 'leaders-node-write');
    await putLeaders(ws.workspaceKey, { patterns: ['admin'] });
    const nodeToken = await enrollNodeToken(ws.workspaceKey);

    const denied = await putLeaders(nodeToken, { patterns: ['*grok'] });
    expect(denied.status).toBe(401);
    expect(denied.body.ok).toBe(false);
    expect(denied.body.error?.code).toBe('node_token_forbidden');
    expect((await getLeaders(ws.workspaceKey)).body.data).toEqual({ leaders: [], patterns: ['admin'] });
  });
});
