import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeNodeStack, createWorkspace, registerAgent, type TestStack } from './harness.js';

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
    expect((await call(y.token, 'POST', '/v1/channels/ops/invite', { agent_name: 'x' })).status).toBeLessThan(300);

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
});
