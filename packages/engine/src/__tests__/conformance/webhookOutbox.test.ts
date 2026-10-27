import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pendingEvents } from '../../db/schema.js';
import { makeNodeStack, createWorkspace, registerAgent, type TestStack } from './harness.js';

/**
 * Outbox pre-check conformance: webhook-eligible mutations only write
 * `pending_events` rows when the workspace actually has an active event
 * subscription. Workspaces without webhooks skip the write entirely.
 */
describe('webhook outbox subscriber pre-check', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack(); });
  afterEach(() => stack.close());

  async function seedChannelWithMessage(name: string) {
    const ws = await createWorkspace(stack.app, name);
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');

    const createRes = await stack.app.request('/v1/channels', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({ name: 'team-chat' }),
    });
    expect(createRes.status).toBeLessThan(300);
    const joinRes = await stack.app.request('/v1/channels/team-chat/join', {
      method: 'POST',
      headers: { authorization: `Bearer ${alice.token}` },
    });
    expect(joinRes.status).toBeLessThan(300);

    const postRes = await stack.app.request('/v1/channels/team-chat/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ text: 'hello world' }),
    });
    expect(postRes.status).toBeLessThan(300);

    return { ws, alice };
  }

  it('skips the outbox insert when the workspace has no subscriptions', async () => {
    await seedChannelWithMessage('no-subs-ws');

    const rows = await stack.runtime.handle.db.select().from(pendingEvents);
    expect(rows).toHaveLength(0);
  });

  it('still writes outbox rows for workspaces with an active subscription', async () => {
    const ws = await createWorkspace(stack.app, 'subbed-ws');
    const subRes = await stack.app.request('/v1/subscriptions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({ events: ['*'], url: 'http://127.0.0.1:1/hook' }),
    });
    expect(subRes.status).toBe(201);

    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const createRes = await stack.app.request('/v1/channels', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({ name: 'team-chat' }),
    });
    expect(createRes.status).toBeLessThan(300);
    const joinRes = await stack.app.request('/v1/channels/team-chat/join', {
      method: 'POST',
      headers: { authorization: `Bearer ${alice.token}` },
    });
    expect(joinRes.status).toBeLessThan(300);
    const postRes = await stack.app.request('/v1/channels/team-chat/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ text: 'hello world' }),
    });
    expect(postRes.status).toBeLessThan(300);

    // Rows exist for the mutations after the subscription was created. They may
    // be mid-claim by the queue poller, but delivery to the dead endpoint never
    // succeeds, so the rows are still present (pending or failed).
    const rows = await stack.runtime.handle.db.select().from(pendingEvents);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.workspaceId.length > 0)).toBe(true);
  });
});
