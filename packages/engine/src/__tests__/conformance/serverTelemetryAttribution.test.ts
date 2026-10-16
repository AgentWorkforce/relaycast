import { createHash } from 'node:crypto';
import { createEngine } from '../../engine.js';
import { hashToken } from '../../auth/index.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { workspaces } from '../../db/schema.js';
import type { TelemetryEvent } from '../../ports/telemetry.js';
import { createWorkspace, makeNodeStack, type TestStack } from './harness.js';

/**
 * Emitters without an authenticated workspace in context load the workspace
 * row themselves, so their events carry the same PostHog groups as
 * authenticated routes.
 */
describe('server telemetry attribution without workspace auth', () => {
  let stack: TestStack;

  beforeEach(() => { stack = makeNodeStack({ ttlMs: 60_000 }); });
  afterEach(() => stack.close());

  it('does not turn a node-selected human sender into credential-authenticated ownership', async () => {
    const ws = await createWorkspace(stack.app, 'node-sender-identity');
    const post = async (path: string, token: string, body: unknown) => {
      const response = await stack.app.request(path, { method: 'POST', headers: {
        'content-type': 'application/json', authorization: `Bearer ${token}`,
      }, body: JSON.stringify(body) });
      expect(response.status).toBe(201);
      return (await response.json() as { data: Record<string, string> }).data;
    };
    const human = await post('/v1/agents', ws.workspaceKey, { name: 'human-A', type: 'human', metadata: { cloud_user_id: 'owner-A' } });
    const node = await post('/v1/nodes', ws.workspaceKey, { node_id: 'node-B', name: 'node-B', capabilities: [], max_agents: 4 });
    const capture = vi.spyOn(stack.runtime.deps.telemetry, 'capture');
    await post('/v1/channels/general/messages', node.token!, { from: 'human-A', text: 'node-selected sender' });
    await stack.settle();
    const event = capture.mock.calls.map(([value]) => value).find(value => value.name === 'relaycast_server_message_created');
    expect(event?.actor).toEqual({ workspaceId: ws.workspaceId });
    expect(event?.properties.actor_kind).toBe('service');
    expect(event?.setOnce).toBeUndefined();
    expect(event?.processPersonProfile).toBe(false);
    capture.mockClear();
    await post('/v1/channels/general/messages', human.token!, { text: 'actual authenticated human' });
    await stack.settle();
    const authenticated = capture.mock.calls.map(([value]) => value).find(value => value.name === 'relaycast_server_message_created');
    expect(authenticated?.actor).toMatchObject({ agentId: human.id, senderType: 'human' });
    expect(authenticated?.setOnce).toEqual({ first_human_message_at: expect.any(String) });
  });

  it('retains the presented token generation when old credentials are accepted during grace', async () => {
    const ws = await createWorkspace(stack.app, 'grace-telemetry');
    const created = await stack.app.request('/v1/agents', { method: 'POST', headers: {
      'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}`,
    }, body: JSON.stringify({ name: 'grace-human', type: 'human' }) });
    expect(created.status).toBe(201);
    const human = (await created.json() as { data: { id: string; token: string } }).data;
    const oldHash = await hashToken(human.token);
    const newHash = await hashToken('at_live_new_generation');
    stack.runtime.handle.sqlite.prepare('UPDATE agents SET token_hash = ?, previous_token_hash = ?, previous_token_expires_at = ? WHERE id = ?')
      .run(newHash, oldHash, Math.floor(Date.now() / 1000) + 60, human.id);
    const capture = vi.spyOn(stack.runtime.deps.telemetry, 'capture');
    const sent = await stack.app.request('/v1/channels/general/messages', { method: 'POST', headers: {
      'content-type': 'application/json', authorization: `Bearer ${human.token}`,
    }, body: JSON.stringify({ text: 'accepted grace credential' }) });
    expect(sent.status).toBe(201);
    await stack.settle();
    const event = capture.mock.calls.map(([value]) => value).find(value => value.name === 'relaycast_server_message_created');
    expect(event?.actor?.credentialHash).toBe(oldHash);
    expect(event?.actor?.credentialHash).not.toBe(newHash);
  });

  it('never exposes plaintext storage keys through a custom telemetry sink', async () => {
    const ws = await createWorkspace(stack.app, 'plaintext-provider-telemetry');
    const created = await stack.app.request('/v1/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({ name: 'custom-provider-human', type: 'human' }),
    });
    expect(created.status).toBe(201);
    const human = (await created.json() as { data: { id: string; token: string } }).data;
    const authenticate = stack.runtime.deps.auth.authenticate.bind(stack.runtime.deps.auth);
    const plaintextHash = vi.fn(async (token: string) => token);
    // A valid custom provider may use plaintext storage keys. Authentication
    // still delegates to the real provider; telemetry must not use storage keys.
    const events: TelemetryEvent[] = [];
    const app = createEngine({
      ...stack.runtime.deps,
      auth: { authenticate, hashToken: plaintextHash },
      telemetry: {
        capture: (event) => { events.push(event); },
        captureException: vi.fn(),
      },
    });
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${human.token}` };
    const sent = await app.request('/v1/channels/general/messages', {
      method: 'POST', headers, body: JSON.stringify({ text: 'fingerprint regression' }),
    });
    expect(sent.status).toBe(201);
    const read = await app.request('/v1/search?q=fingerprint', { headers });
    expect(read.status).toBe(200);
    await stack.settle();
    const expectedDigest = createHash('sha256').update(human.token).digest('hex');
    for (const name of ['relaycast_server_message_created', 'relaycast_server_search_executed']) {
      expect(events.find(event => event.name === name)?.actor).toEqual({
        workspaceId: ws.workspaceId, agentId: human.id,
        credentialHash: expectedDigest, senderType: 'human',
      });
    }
    expect(JSON.stringify(events)).not.toContain(human.token);
    expect(plaintextHash).not.toHaveBeenCalled();
  });

  it('keeps public workspace metadata out of webhook analytics groups', async () => {
    const ws = await createWorkspace(stack.app, 'telemetry-webhook-groups');
    await stack.runtime.deps.db
      .update(workspaces)
      .set({ metadata: { cloud_org_id: 'org_1', cloud_workspace_id: 'cws_1' } })
      .where(eq(workspaces.id, ws.workspaceId));

    const createResponse = await stack.app.request('/v1/webhooks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({ channel: 'general', name: 'provider-events' }),
    });
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json() as { data: { webhook_id: string; token: string } }).data;

    const capture = vi.spyOn(stack.runtime.deps.telemetry, 'capture');
    const response = await stack.app.request(`/v1/hooks/${created.webhook_id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${created.token}` },
      body: JSON.stringify({ text: 'pull request opened', source: 'github' }),
    });
    expect(response.status).toBe(201);
    await stack.settle();

    const triggered = capture.mock.calls
      .map(([event]) => event as TelemetryEvent)
      .find((event) => event.name === 'relaycast_server_inbound_webhook_triggered');
    expect(triggered).toMatchObject({
      distinctId: `relaycast-ws:${ws.workspaceId}`,
      processPersonProfile: false,
    });
    expect(triggered?.groups).toBeUndefined();
  });
});
