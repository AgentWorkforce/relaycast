import { afterEach, describe, expect, it, vi } from 'vitest';
import { pendingEvents, webhookDeliveries } from '../../db/schema.js';
import { createWorkspace, makeNodeStack } from './harness.js';

describe('webhook delivery health and replay', () => {
  afterEach(() => vi.restoreAllMocks());

  it('lists a dead letter and requeues its exact durable event', async () => {
    const stack = makeNodeStack();
    const workspace = await createWorkspace(stack.app, 'webhook-replay');
    const create = await stack.app.request('/v1/subscriptions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${workspace.workspaceKey}`,
      },
      body: JSON.stringify({ events: ['message.created'], url: 'https://hooks.example.test/relay' }),
    });
    expect(create.status).toBe(201);
    const subscription = await create.json() as { data: { id: string } };

    await stack.runtime.deps.db.insert(pendingEvents).values({
      id: 'evt_dead_letter',
      workspaceId: workspace.workspaceId,
      eventType: 'message.created',
      payload: { text: 'replay me' },
      status: 'failed',
      attempts: 7,
      webhookInitialized: true,
      lastError: 'attempts exhausted',
      completedAt: new Date(),
    });
    await stack.runtime.deps.db.insert(webhookDeliveries).values({
      id: 'whd_dead_letter',
      eventId: 'evt_dead_letter',
      subscriptionId: subscription.data.id,
      status: 'dead_letter',
      attempts: 7,
      lastStatus: 503,
      lastError: 'HTTP 503',
      completedAt: new Date(),
    });

    const list = await stack.app.request(
      `/v1/subscriptions/${subscription.data.id}/deliveries?status=dead_letter`,
      { headers: { authorization: `Bearer ${workspace.workspaceKey}` } },
    );
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject({
      data: [{ id: 'whd_dead_letter', event_id: 'evt_dead_letter', status: 'dead_letter', attempts: 7 }],
    });

    const send = vi.spyOn(stack.runtime.webhookQueue, 'send').mockResolvedValue();
    const replayRequest = () => stack.app.request(
      `/v1/subscriptions/${subscription.data.id}/deliveries/whd_dead_letter/replay`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${workspace.workspaceKey}` },
      },
    );
    const attempts = await Promise.all([replayRequest(), replayRequest()]);
    expect(attempts.map(response => response.status).sort()).toEqual([200, 409]);
    const replay = attempts.find(response => response.status === 200)!;
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({
      data: { id: 'whd_dead_letter', status: 'pending' },
    });
    expect(send).toHaveBeenCalledWith({
      outboxId: 'evt_dead_letter',
      workspaceId: workspace.workspaceId,
      type: 'message.created',
      data: { text: 'replay me' },
    });

    expect(send).toHaveBeenCalledTimes(1);

    const [delivery] = await stack.runtime.deps.db.select().from(webhookDeliveries);
    const [event] = await stack.runtime.deps.db.select().from(pendingEvents);
    expect(delivery).toMatchObject({ status: 'pending', attempts: 0, lastError: null });
    expect(event).toMatchObject({ status: 'pending', attempts: 0, lastError: null });
  });

  it('validates Standard Webhooks secrets and returns the selected scheme', async () => {
    const stack = makeNodeStack();
    const workspace = await createWorkspace(stack.app, 'standard-webhooks-subscription');
    const headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${workspace.workspaceKey}`,
    };
    const invalid = await stack.app.request('/v1/subscriptions', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        events: ['message.created'],
        url: 'https://hooks.example.test/relay',
        signature_scheme: 'standard-webhooks',
        secret: 'not-a-whsec-secret',
      }),
    });
    expect(invalid.status).toBe(400);

    const valid = await stack.app.request('/v1/subscriptions', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        events: ['message.created'],
        url: 'https://hooks.example.test/relay',
        signature_scheme: 'standard-webhooks',
        secret: 'whsec_MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
      }),
    });
    expect(valid.status).toBe(201);
    await expect(valid.json()).resolves.toMatchObject({
      data: { signature_scheme: 'standard-webhooks' },
    });
  });
});
