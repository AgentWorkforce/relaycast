import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agents } from '../../db/schema.js';
import { enforceD1ParameterLimit, makeNodeStack, createWorkspace, registerAgent, type TestStack } from './harness.js';

type Json = Record<string, any>;

/**
 * Per-recipient inbound policy: an agent on an allowlist can be addressed only
 * by the agents it admits (plus pinned owner/admin agents). Everyone else gets
 * the same not-found a nonexistent agent gets, on every path that reaches it.
 */
describe('inbound policy', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack(); });
  afterEach(async () => { await stack.close(); });

  async function call(token: string, method: string, path: string, body?: unknown) {
    const res = await stack.app.request(path, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Json };
  }

  const dm = (token: string, to: string, text = 'hi') => call(token, 'POST', '/v1/dm', { to, text });
  const setPolicy = (token: string, name: string, body: unknown) =>
    call(token, 'PUT', `/v1/agents/${name}/inbound-policy`, body);

  /** x admits only y; owner is pinned. z is an unrelated agent. */
  async function seed() {
    const ws = await createWorkspace(stack.app, 'policy-ws');
    const [x, y, z, owner] = await Promise.all(
      ['x', 'y', 'z', 'owner'].map((name) => registerAgent(stack.app, ws.workspaceKey, name)),
    );
    const set = await setPolicy(ws.workspaceKey, 'x', { mode: 'allowlist', allowed_agents: ['y'], pinned_agents: ['owner'] });
    expect(set.status).toBe(200);
    expect(set.body.data).toMatchObject({
      mode: 'allowlist',
      allowed_agents: [{ id: y.agentId, name: 'y' }],
      pinned_agents: [{ id: owner.agentId, name: 'owner' }],
    });
    return { ws, x, y, z, owner };
  }

  it('is open by default', async () => {
    const ws = await createWorkspace(stack.app, 'open-ws');
    const x = await registerAgent(stack.app, ws.workspaceKey, 'x');
    const z = await registerAgent(stack.app, ws.workspaceKey, 'z');
    expect((await dm(z.token, 'x')).status).toBe(201);
    const read = await call(x.token, 'GET', '/v1/agents/x/inbound-policy');
    expect(read.body.data).toEqual({ agent_id: x.agentId, mode: 'open', allowed_agents: [], pinned_agents: [] });
  });

  it('refuses direct messages from outside the allowlist exactly like a missing agent', async () => {
    const { x, y, z, owner } = await seed();
    expect((await dm(y.token, 'x')).status).toBe(201);
    expect((await dm(owner.token, 'x')).status).toBe(201);
    // Outbound is not restricted: x can still message z.
    expect((await dm(x.token, 'z')).status).toBe(201);

    const refused = await dm(z.token, 'x');
    const missing = await dm(z.token, 'nobody');
    expect(refused.status).toBe(404);
    expect(refused.body.error.code).toBe('agent_not_found');
    expect(refused.body.error.message).toBe(missing.body.error.message.replace('nobody', 'x'));

    const refusedAddress = await call(z.token, 'POST', '/v1/dm', { address: 'x@direct', text: 'hi' });
    const missingAddress = await call(z.token, 'POST', '/v1/dm', { address: 'nobody@direct', text: 'hi' });
    expect(refusedAddress.status).toBe(404);
    expect(refusedAddress.body.error.code).toBe('address_not_found');
    expect(refusedAddress.body.error.message).toBe(missingAddress.body.error.message.replace('nobody@direct', 'x@direct'));
    expect((await call(y.token, 'POST', '/v1/dm', { address: 'x@direct', text: 'hi' })).status).toBe(201);
  });

  it('keeps refused agents out of group DMs, channels and DM threads', async () => {
    const { ws, x, y, z } = await seed();

    expect((await call(z.token, 'POST', '/v1/dm/group', { participants: ['x'] })).body.error.code).toBe('agent_not_found');
    const mixed = await call(y.token, 'POST', '/v1/dm/group', { participants: ['x', 'z'] });
    expect(mixed.status).toBe(403);
    expect(mixed.body.error.code).toBe('participant_not_allowed');

    const group = await call(y.token, 'POST', '/v1/dm/group', { participants: ['x'] });
    expect(group.status).toBe(201);
    const add = await call(y.token, 'POST', `/v1/dm/${group.body.data.id}/participants`, { agent_name: 'z' });
    expect(add.status).toBe(403);
    expect(add.body.error.code).toBe('participant_not_allowed');

    expect((await call(ws.workspaceKey, 'POST', '/v1/channels', { name: 'ops' })).status).toBe(201);
    for (const agent of [y, z]) {
      expect((await call(agent.token, 'POST', '/v1/channels/ops/join')).status).toBeLessThan(300);
    }
    const zInvite = await call(z.token, 'POST', '/v1/channels/ops/invite', { agent_name: 'x' });
    expect(zInvite.status).toBe(404);
    expect(zInvite.body.error.code).toBe('agent_not_found');
    const yInvite = await call(y.token, 'POST', '/v1/channels/ops/invite', { agent_name: 'x' });
    expect(yInvite.status).toBeLessThan(300);
    const members = await call(ws.workspaceKey, 'GET', '/v1/channels/ops/members');
    expect(members.status).toBe(200);
    expect(members.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ agent_name: 'x' }),
    ]));

    // Knowing a message id in x's DM is not a way in.
    const sent = await dm(y.token, 'x', 'private');
    const reply = await call(z.token, 'POST', `/v1/messages/${sent.body.data.id}/replies`, { text: 'me too' });
    expect(reply.status).toBe(404);
    expect(reply.body.error.code).toBe('message_not_found');
    expect((await call(x.token, 'POST', `/v1/messages/${sent.body.data.id}/replies`, { text: 'ok' })).status).toBe(201);
  });

  it('lets an agent narrow its own policy but never widen it or touch pinned agents', async () => {
    const { x, y, owner } = await seed();

    expect((await call(x.token, 'GET', '/v1/agents/y/inbound-policy')).status).toBe(404);
    expect((await setPolicy(x.token, 'y', { mode: 'open' })).status).toBe(404);

    for (const body of [{ mode: 'open' }, { mode: 'allowlist', allowed_agents: ['y', 'z'] }]) {
      const widen = await setPolicy(x.token, 'x', body);
      expect(widen.status).toBe(403);
      expect(widen.body.error.code).toBe('inbound_policy_widen_forbidden');
    }
    const pin = await setPolicy(x.token, 'x', { mode: 'allowlist', allowed_agents: ['y'], pinned_agents: [] });
    expect(pin.status).toBe(403);
    expect(pin.body.error.code).toBe('workspace_key_required');

    const narrowed = await setPolicy(x.token, 'x', { mode: 'allowlist', allowed_agents: [] });
    expect(narrowed.status).toBe(200);
    expect(narrowed.body.data.pinned_agents).toEqual([{ id: owner.agentId, name: 'owner' }]);
    expect((await dm(y.token, 'x')).status).toBe(404);
    expect((await dm(owner.token, 'x')).status).toBe(201);
  });

  it('only the workspace key reopens a policy', async () => {
    const { ws, z } = await seed();
    expect((await setPolicy(ws.workspaceKey, 'x', { mode: 'open' })).status).toBe(200);
    expect((await dm(z.token, 'x')).status).toBe(201);
  });

  it('does not confirm a hidden agent exists through an allowlist', async () => {
    const { z } = await seed();
    const probe = await setPolicy(z.token, 'z', { mode: 'allowlist', allowed_agents: ['x'] });
    const missing = await setPolicy(z.token, 'z', { mode: 'allowlist', allowed_agents: ['nobody'] });
    expect(probe.status).toBe(404);
    expect(probe.body.error.code).toBe(missing.body.error.code);
    expect(probe.body.error.message).toBe(missing.body.error.message.replace('nobody', 'x'));

    // A missing neighbor must not change the answer for a name that refuses the caller.
    const hiddenThenMissing = await setPolicy(z.token, 'z', { mode: 'allowlist', allowed_agents: ['x', 'nobody'] });
    const missingThenHidden = await setPolicy(z.token, 'z', { mode: 'allowlist', allowed_agents: ['nobody', 'x'] });
    expect(hiddenThenMissing.status).toBe(404);
    expect(hiddenThenMissing.body.error.message).toBe('Agent "x" not found');
    expect(missingThenHidden.body.error.message).toBe('Agent "nobody" not found');

    // An agent this caller may address is not hidden, so the missing name is the error.
    const visibleThenMissing = await setPolicy(z.token, 'z', { mode: 'allowlist', allowed_agents: ['y', 'nobody'] });
    expect(visibleThenMissing.body.error.message).toBe('Agent "nobody" not found');
  });

  it('resolves and reads an allowlist larger than one D1 IN-list chunk', async () => {
    const ws = await createWorkspace(stack.app, 'chunk-ws');
    const owner = await registerAgent(stack.app, ws.workspaceKey, 'owner');
    const names = Array.from({ length: 256 }, (_, i) => `peer-${i}`);
    const db = stack.runtime.deps.db;
    for (let i = 0; i < names.length; i += 40) {
      await db.insert(agents).values(names.slice(i, i + 40).map((name, j) => ({
        id: `ag_peer_${i + j}`,
        workspaceId: ws.workspaceId,
        name,
        tokenHash: `tok_peer_${ws.workspaceId}_${i + j}`,
      })));
    }
    const guard = enforceD1ParameterLimit(stack);
    try {
      // From open, the agent's own token resolves every name, reads every target
      // policy, and returns every admitted name. 256 ids plus workspaceId is 257
      // binds, over D1's cap, unless each lookup is chunked.
      const set = await setPolicy(owner.token, 'owner', { mode: 'allowlist', allowed_agents: names });
      expect(set.status).toBe(200);
      const listed = new Set((set.body.data.allowed_agents as { name: string }[]).map((agent) => agent.name));
      expect(listed).toEqual(new Set(names));
      const read = await call(owner.token, 'GET', '/v1/agents/owner/inbound-policy');
      expect(read.status).toBe(200);
      expect(read.body.data.allowed_agents).toHaveLength(names.length);
      expect(guard.maxObserved()).toBeLessThanOrEqual(100);
    } finally {
      guard.restore();
    }
  });

  it('does not let a later agent narrow put back a name an earlier narrow removed', async () => {
    const { ws, x, y, z, owner } = await seed();
    expect((await setPolicy(ws.workspaceKey, 'x', {
      mode: 'allowlist',
      allowed_agents: ['y', 'z'],
      pinned_agents: ['owner'],
    })).status).toBe(200);

    const sqlite = stack.runtime.handle.sqlite;
    const originalPrepare = sqlite.prepare.bind(sqlite);
    let snapshot: unknown[] | undefined;
    let serveStale = false;
    const policyReads: string[] = [];
    sqlite.prepare = ((source: string) => {
      const stmt = originalPrepare(source);
      const pointRead = /^\s*select\b/i.test(source)
        && /agent_inbound_policies/i.test(source)
        && !/\bin\s*\(/i.test(source);
      if (!pointRead) return stmt;
      const all = stmt.all.bind(stmt);
      stmt.all = ((...args: unknown[]) => {
        const rows = all(...args) as unknown[];
        policyReads.push(source);
        if (snapshot === undefined) snapshot = rows.map((row) => Array.isArray(row) ? [...row] : row);
        if (serveStale && snapshot) {
          serveStale = false;
          return snapshot;
        }
        return rows;
      }) as typeof stmt.all;
      return stmt;
    }) as typeof sqlite.prepare;

    try {
      const first = await setPolicy(x.token, 'x', { mode: 'allowlist', allowed_agents: ['y'] });
      expect(first.status, policyReads.join('\n---\n')).toBe(200);
      expect(snapshot, policyReads.join('\n---\n')).toBeDefined();
      serveStale = true;
      const second = await setPolicy(x.token, 'x', { mode: 'allowlist', allowed_agents: ['z'] });
      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe('inbound_policy_conflict');
    } finally {
      sqlite.prepare = originalPrepare as typeof sqlite.prepare;
    }

    const read = await call(x.token, 'GET', '/v1/agents/x/inbound-policy');
    expect(read.body.data.allowed_agents).toEqual([{ id: y.agentId, name: 'y' }]);
    expect(read.body.data.pinned_agents).toEqual([{ id: owner.agentId, name: 'owner' }]);

    const retried = await setPolicy(x.token, 'x', { mode: 'allowlist', allowed_agents: [] });
    expect(retried.status).toBe(200);
    expect(retried.body.data.allowed_agents).toEqual([]);

    const replaced = await setPolicy(ws.workspaceKey, 'x', { mode: 'allowlist', allowed_agents: ['z'] });
    expect(replaced.status).toBe(200);
    expect(replaced.body.data.allowed_agents).toEqual([{ id: z.agentId, name: 'z' }]);
  });

  it('refuses posts once a member narrows after the group formed', async () => {
    const { x, y } = await seed();
    const group = await call(y.token, 'POST', '/v1/dm/group', { participants: ['x'] });
    const post = (token: string) => call(token, 'POST', `/v1/dm/${group.body.data.id}/messages`, { text: 'hello' });
    expect((await post(y.token)).status).toBe(201);
    expect((await setPolicy(x.token, 'x', { mode: 'allowlist', allowed_agents: [] })).status).toBe(200);
    const refused = await post(y.token);
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('participant_not_allowed');
  });

  it('rejects a group post when the policy narrows after the pre-check', async () => {
    const { x, y } = await seed();
    const group = await call(y.token, 'POST', '/v1/dm/group', { participants: ['x'] });
    expect((await setPolicy(x.token, 'x', { mode: 'allowlist', allowed_agents: [] })).status).toBe(200);

    const sqlite = stack.runtime.handle.sqlite;
    const originalPrepare = sqlite.prepare.bind(sqlite);
    sqlite.prepare = ((source: string) => {
      const stmt = originalPrepare(source);
      if (/^\s*select\b/i.test(source) && /agent_inbound_policies/i.test(source)) {
        stmt.all = (() => []) as typeof stmt.all;
      }
      return stmt;
    }) as typeof sqlite.prepare;
    try {
      const refused = await call(y.token, 'POST', `/v1/dm/${group.body.data.id}/messages`, { text: 'hello' });
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe('participant_not_allowed');
    } finally {
      sqlite.prepare = originalPrepare as typeof sqlite.prepare;
    }
  });

  it('rejects a concurrent add that the pre-check did not see', async () => {
    const ws = await createWorkspace(stack.app, 'race-ws');
    const [y, x, z, w] = await Promise.all(
      ['y', 'x', 'z', 'w'].map((name) => registerAgent(stack.app, ws.workspaceKey, name)),
    );
    const group = await call(y.token, 'POST', '/v1/dm/group', { participants: ['w'] });
    expect(group.status).toBe(201);
    expect((await setPolicy(ws.workspaceKey, 'x', { mode: 'allowlist', allowed_agents: ['y', 'w'] })).status).toBe(200);
    expect((await setPolicy(ws.workspaceKey, 'z', { mode: 'allowlist', allowed_agents: ['y', 'w'] })).status).toBe(200);

    const sqlite = stack.runtime.handle.sqlite;
    const originalPrepare = sqlite.prepare.bind(sqlite);
    let sneaked = false;
    sqlite.prepare = ((source: string) => {
      const stmt = originalPrepare(source);
      if (/insert into dm_participants/i.test(source) && /where/i.test(source)) {
        const all = stmt.all.bind(stmt);
        stmt.all = ((...args: unknown[]) => {
          if (!sneaked) {
            sneaked = true;
            originalPrepare('INSERT INTO dm_participants (conversation_id, agent_id) VALUES (?, ?)').run(group.body.data.id, z.agentId);
          }
          return all(...args);
        }) as typeof stmt.all;
      }
      return stmt;
    }) as typeof sqlite.prepare;
    try {
      const add = await call(y.token, 'POST', `/v1/dm/${group.body.data.id}/participants`, { agent_name: 'x' });
      expect(sneaked).toBe(true);
      expect(add.status).toBe(403);
      expect(add.body.error.code).toBe('participant_not_allowed');
    } finally {
      sqlite.prepare = originalPrepare as typeof sqlite.prepare;
    }
    const members = stack.runtime.handle.sqlite.prepare(
      'SELECT agent_id FROM dm_participants WHERE conversation_id = ? AND left_at IS NULL',
    ).all(group.body.data.id) as { agent_id: string }[];
    const ids = members.map((row) => row.agent_id);
    expect(ids).toContain(z.agentId);
    expect(ids).not.toContain(x.agentId);
  });

  it('reports already a member when the same participant is added twice at once', async () => {
    const ws = await createWorkspace(stack.app, 'same-add-ws');
    const [y, x, w] = await Promise.all(
      ['y', 'x', 'w'].map((name) => registerAgent(stack.app, ws.workspaceKey, name)),
    );
    const group = await call(y.token, 'POST', '/v1/dm/group', { participants: ['w'] });
    expect(group.status).toBe(201);

    const sqlite = stack.runtime.handle.sqlite;
    const originalPrepare = sqlite.prepare.bind(sqlite);
    let raced = false;
    sqlite.prepare = ((source: string) => {
      const stmt = originalPrepare(source);
      if (/insert into dm_participants/i.test(source) && /on conflict/i.test(source)) {
        const all = stmt.all.bind(stmt);
        stmt.all = ((...args: unknown[]) => {
          if (!raced) {
            raced = true;
            originalPrepare('INSERT INTO dm_participants (conversation_id, agent_id) VALUES (?, ?)').run(group.body.data.id, x.agentId);
          }
          return all(...args);
        }) as typeof stmt.all;
      }
      return stmt;
    }) as typeof sqlite.prepare;
    try {
      const add = await call(y.token, 'POST', `/v1/dm/${group.body.data.id}/participants`, { agent_name: 'x' });
      expect(raced).toBe(true);
      expect(add.status).toBe(200);
      expect(add.body.data.already_member).toBe(true);
    } finally {
      sqlite.prepare = originalPrepare as typeof sqlite.prepare;
    }
  });
});
