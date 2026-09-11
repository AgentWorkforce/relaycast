import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { channelMembers, channels } from '../../db/schema.js';
import { generateId } from '../../engine/snowflake.js';
import { deleteAgent } from '../../engine/agent.js';
import { createChannel, getChannel, joinChannel, leaveChannel, ensureAgentSubscriptionChannel } from '../../engine/channel.js';
import type { EngineDb, TransactionCapability } from '../../ports/database.js';
import { makeNodeStack, createWorkspace, registerAgent, type TestStack } from './harness.js';

describe('agent subscription channels', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack(); });
  afterEach(async () => { await stack.close(); });
  it('provisions an idempotent exact recipient route and rejects membership widening', async () => {
    const ws = await createWorkspace(stack.app, 'targeting');
    const target = await registerAgent(stack.app, ws.workspaceKey, 'target-hyphen');
    const other = await registerAgent(stack.app, ws.workspaceKey, 'target');
    const post = (path: string, token: string, body?: unknown) => stack.app.request(path, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const endpoint = '/v1/agents/target-hyphen/subscription-channel';
    expect((await post(endpoint, other.token)).status).toBe(401);
    const response = await post(endpoint, ws.workspaceKey);
    expect(response.status).toBe(200);
    const { data: route } = await response.json() as { data: { name: string; members: Array<{ agent_name: string }> } };
    expect(route.members.map(m => m.agent_name)).toEqual(['target-hyphen']);
    expect((await (await post(endpoint, ws.workspaceKey)).json()).data.name).toBe(route.name);
    expect((await post(`/v1/channels/${route.name}/join`, other.token)).status).toBe(403);
    expect((await post(`/v1/channels/${route.name}/invite`, target.token, { agent_name: 'target' })).status).toBe(403);
    const hook = await post('/v1/webhooks', ws.workspaceKey, { channel: route.name });
    expect(hook.status).toBe(201);
    const { data: webhook } = await hook.json();
    const sent = await post(`/v1/hooks/${webhook.webhook_id}`, webhook.token, { text: 'event-only-fixture' });
    expect(sent.status).toBe(201);
    const { data: message } = await sent.json();
    for (const [agent, count] of [[target, 1], [other, 0]] as const) {
      const deliveries = await stack.app.request('/v1/deliveries', { headers: { authorization: `Bearer ${agent.token}` } });
      const { data } = await deliveries.json();
      expect(data.filter((d: {message_id: string}) => d.message_id === message.message_id)).toHaveLength(count);
    }
    await post(`/v1/channels/${route.name}/leave`, target.token);
    expect((await (await post(endpoint, ws.workspaceKey)).json()).data.members).toHaveLength(1);
  });
  it('fails setup when release wins before the conditional membership insert', async () => {
    const ws = await createWorkspace(stack.app, 'release-during-ensure');
    await registerAgent(stack.app, ws.workspaceKey, 'racing-recipient');
    const db = stack.runtime.handle.db;
    const original = db.run.bind(db);
    const hook = vi.spyOn(db, 'run').mockImplementationOnce(async (query) => {
      await deleteAgent(db, ws.workspaceId, 'racing-recipient');
      return original(query);
    });
    try {
      await expect(ensureAgentSubscriptionChannel(db, ws.workspaceId, 'racing-recipient')).rejects.toMatchObject({ code: 'agent_not_found' });
    } finally { hook.mockRestore(); }
  });

  it('rejects a released recipient joining its old subscription channel', async () => {
    const ws = await createWorkspace(stack.app, 'released-join');
    const target = await registerAgent(stack.app, ws.workspaceKey, 'released-join-target');
    const db = stack.runtime.deps.db;
    const channel = await ensureAgentSubscriptionChannel(db, ws.workspaceId, 'released-join-target');
    await deleteAgent(db, ws.workspaceId, 'released-join-target');
    await expect(joinChannel(db, ws.workspaceId, channel.name, target.agentId)).rejects.toMatchObject({ code: 'agent_not_found' });
    expect((await getChannel(db, ws.workspaceId, channel.name)).members).toHaveLength(0);
  });

  it('prevents release racing a subscription join from recreating membership', async () => {
    const ws = await createWorkspace(stack.app, 'release-racing-join');
    const target = await registerAgent(stack.app, ws.workspaceKey, 'racing-join-target');
    const db = stack.runtime.deps.db;
    const channel = await ensureAgentSubscriptionChannel(db, ws.workspaceId, 'racing-join-target');
    await leaveChannel(db, ws.workspaceId, channel.name, target.agentId);
    const original = db.run.bind(db);
    const hook = vi.spyOn(db, 'run').mockImplementationOnce(async query => {
      await deleteAgent(db, ws.workspaceId, 'racing-join-target');
      return original(query);
    });
    try {
      await expect(joinChannel(db, ws.workspaceId, channel.name, target.agentId)).rejects.toMatchObject({ code: 'agent_not_found' });
      expect((await getChannel(db, ws.workspaceId, channel.name)).members).toHaveLength(0);
    } finally { hook.mockRestore(); }
  });

  it('never transfers a deleted identity subscription to a recreated name', async () => {
    const ws = await createWorkspace(stack.app, 'target-lifecycle');
    await registerAgent(stack.app, ws.workspaceKey, 'recreated-worker');
    const request = (path: string, method = 'POST', body?: unknown) => stack.app.request(path, {
      method, headers: { authorization: `Bearer ${ws.workspaceKey}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const endpoint = '/v1/agents/recreated-worker/subscription-channel';
    const old = (await (await request(endpoint)).json()).data;
    expect((await request('/v1/agents/recreated-worker', 'DELETE')).status).toBe(204);
    expect((await request(endpoint)).status).toBe(404);
    await registerAgent(stack.app, ws.workspaceKey, 'recreated-worker');
    const current = (await (await request(endpoint)).json()).data;
    expect(current.name).not.toBe(old.name);
    expect(current.members.map((m: { agent_name: string }) => m.agent_name)).toEqual(['recreated-worker']);
    const oldChannel = (await (await request(`/v1/channels/${old.name}`, 'GET')).json()).data;
    expect(oldChannel.members).toHaveLength(0);
    expect((await request(`/v1/channels/${current.name}`, 'PATCH', { metadata: { subscription_agent_id: 'another' } })).status).toBe(403);
  });

  it('reads live membership after a lifecycle release without a host node', async () => {
    const ws = await createWorkspace(stack.app, 'target-release');
    await registerAgent(stack.app, ws.workspaceKey, 'released-worker');
    const headers = { authorization: `Bearer ${ws.workspaceKey}`, 'content-type': 'application/json' };
    const route = await stack.app.request('/v1/agents/released-worker/subscription-channel', { method: 'POST', headers });
    const { data: channel } = await route.json();
    expect(channel.members).toHaveLength(1);
    const release = await stack.app.request('/v1/agents/release', { method: 'POST', headers,
      body: JSON.stringify({ name: 'released-worker', delete_agent: true, reason: 'owned process stopped' }) });
    expect(release.status).toBe(201);
    const after = await stack.app.request(`/v1/channels/${channel.name}`, { headers });
    expect((await after.json()).data.members).toHaveLength(0);
  });

  it('rejects a legacy reserved channel containing a non-recipient without adopting it', async () => {
    const ws = await createWorkspace(stack.app, 'legacy-route');
    const target = await registerAgent(stack.app, ws.workspaceKey, 'legacy-target');
    const other = await registerAgent(stack.app, ws.workspaceKey, 'legacy-other');
    const db = stack.runtime.deps.db;
    const channelId = generateId();
    await db.insert(channels).values({ id: channelId, workspaceId: ws.workspaceId,
      name: `agent-events-${target.agentId}`, metadata: { subscription_agent_id: target.agentId } });
    await db.insert(channelMembers).values({ channelId, agentId: other.agentId, role: 'member' });
    const response = await stack.app.request('/v1/agents/legacy-target/subscription-channel', {
      method: 'POST', headers: { authorization: `Bearer ${ws.workspaceKey}` },
    });
    expect(response.status).toBe(409);
    expect((await getChannel(db, ws.workspaceId, `agent-events-${target.agentId}`)).members.map(m => m.agent_id)).toEqual([other.agentId]);
  });

  it.each([null, 'invalid', 7, [], {}, { subscription_agent_id: 7 },
    { subscription_agent_id: '' }, { subscription_agent_id: 'another-agent' }])(
    'rejects malformed or mismatched legacy subscription metadata: %j', async (metadata) => {
      const ws = await createWorkspace(stack.app, 'invalid-route');
      const target = await registerAgent(stack.app, ws.workspaceKey, 'metadata-target');
      const db = stack.runtime.deps.db;
      const channelId = generateId();
      await db.insert(channels).values({ id: channelId, workspaceId: ws.workspaceId,
        name: `agent-events-${target.agentId}`, metadata });
      const response = await stack.app.request('/v1/agents/metadata-target/subscription-channel', {
        method: 'POST', headers: { authorization: `Bearer ${ws.workspaceKey}` },
      });
      expect(response.status).toBe(403);
      expect((await response.json()).error.code).toBe('subscription_recipient_only');
      expect((await getChannel(db, ws.workspaceId, `agent-events-${target.agentId}`)).members).toHaveLength(0);
    },
  );

  it('invalidates a membership cached after release preflight but before its transaction', async () => {
    const ws = await createWorkspace(stack.app, 'release-late-join');
    const target = await registerAgent(stack.app, ws.workspaceKey, 'late-target');
    const db = stack.runtime.deps.db as EngineDb & TransactionCapability;
    await createChannel(db, ws.workspaceId, { name: 'late-channel' });
    const original = db.withTransaction.bind(db);
    const hook = vi.spyOn(db, 'withTransaction').mockImplementationOnce(async (fn) => {
      await joinChannel(db, ws.workspaceId, 'late-channel', target.agentId);
      expect((await getChannel(db, ws.workspaceId, 'late-channel')).members.map(m => m.agent_id)).toContain(target.agentId);
      return original(fn);
    });
    try {
      expect(await deleteAgent(db, ws.workspaceId, 'late-target')).toBe(true);
      expect((await getChannel(db, ws.workspaceId, 'late-channel')).members).toHaveLength(0);
    } finally { hook.mockRestore(); }
  });

});
