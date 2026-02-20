import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';

vi.mock('../../engine/webhooks.js', () => ({
  processWebhook: vi.fn(),
}));

vi.mock('../../db/index.js', () => ({
  getDb: vi.fn(),
}));

import { Hono } from 'hono';
import type { AppEnv } from '../../env.js';
import { dbMiddleware } from '../../middleware/db.js';
import { webhookRoutes } from '../../routes/webhooks.js';
import * as webhooksEngine from '../../engine/webhooks.js';
import { getDb } from '../../db/index.js';
import {
  mockDbForWorkspaceAuth,
  createMockBindings,
} from '../../__tests__/test-helpers.js';

const bindings = { ...createMockBindings(), STRIPE_WEBHOOK_SECRET: '' };

function createApp(overrideBindings?: Record<string, unknown>) {
  const testApp = new Hono<AppEnv>();
  testApp.use('*', async (c, next) => {
    (c as any).env = { ...bindings, ...overrideBindings };
    await next();
  });
  testApp.use('*', dbMiddleware);
  const v1 = new Hono<AppEnv>();
  v1.route('/', webhookRoutes);
  testApp.route('/v1', v1);
  return testApp;
}

const app = createApp();

describe('POST /v1/billing/webhooks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue(mockDbForWorkspaceAuth());
  });

  it('handles subscription.updated', async () => {
    vi.mocked(webhooksEngine.processWebhook).mockResolvedValue({ received: true });

    const res = await app.request('/v1/billing/webhooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'subscription.updated', data: { id: 'sub_123', metadata: { workspace_id: 'ws_1', plan: 'pro' } } }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.received).toBe(true);
    expect(webhooksEngine.processWebhook).toHaveBeenCalledWith(
      expect.anything(),
      {
        type: 'subscription.updated',
        data: { id: 'sub_123', metadata: { workspace_id: 'ws_1', plan: 'pro' } },
      },
      expect.anything(),
    );
  });

  it('handles subscription.deleted', async () => {
    vi.mocked(webhooksEngine.processWebhook).mockResolvedValue({ received: true });

    const res = await app.request('/v1/billing/webhooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'subscription.deleted', data: { id: 'sub_123', metadata: { workspace_id: 'ws_1' } } }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.received).toBe(true);
  });

  it('handles invoice.paid', async () => {
    vi.mocked(webhooksEngine.processWebhook).mockResolvedValue({ received: true });

    const res = await app.request('/v1/billing/webhooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'invoice.paid', data: { customer: 'cus_123', amount_paid: 2999 } }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.received).toBe(true);
  });

  it('handles invoice.payment_failed', async () => {
    vi.mocked(webhooksEngine.processWebhook).mockResolvedValue({ received: true });

    const res = await app.request('/v1/billing/webhooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'invoice.payment_failed', data: { customer: 'cus_123' } }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.received).toBe(true);
  });

  it('returns 400 for missing type', async () => {
    const res = await app.request('/v1/billing/webhooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: {} }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_request');
    expect(body.error.message).toContain('type');
  });

  it('returns 500 on processing failure so Stripe retries', async () => {
    vi.mocked(webhooksEngine.processWebhook).mockRejectedValue(new Error('DB error'));

    const res = await app.request('/v1/billing/webhooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'subscription.updated', data: {} }),
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('webhook_processing_error');
  });

  it('does not require auth', async () => {
    vi.mocked(webhooksEngine.processWebhook).mockResolvedValue({ received: true });

    const res = await app.request('/v1/billing/webhooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'subscription.updated', data: {} }),
    });

    // Should not get 401
    expect(res.status).toBe(200);
  });

  it('handles unknown events', async () => {
    vi.mocked(webhooksEngine.processWebhook).mockResolvedValue({ received: true });

    const res = await app.request('/v1/billing/webhooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'some.unknown.event', data: {} }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.received).toBe(true);
  });

  it('rejects requests with invalid signature when STRIPE_WEBHOOK_SECRET is set', async () => {
    const signedApp = createApp({ STRIPE_WEBHOOK_SECRET: 'whsec_test_secret' });

    const res = await signedApp.request('/v1/billing/webhooks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'stripe-signature': 't=12345,v1=invalid',
      },
      body: JSON.stringify({ type: 'subscription.updated', data: {} }),
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_signature');
  });

  it('rejects requests without stripe-signature header when secret is set', async () => {
    const signedApp = createApp({ STRIPE_WEBHOOK_SECRET: 'whsec_test_secret' });

    const res = await signedApp.request('/v1/billing/webhooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'subscription.updated', data: {} }),
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_signature');
  });

  it('accepts requests with valid signature when STRIPE_WEBHOOK_SECRET is set', async () => {
    const secret = 'whsec_test_secret';
    const signedApp = createApp({ STRIPE_WEBHOOK_SECRET: secret });
    vi.mocked(webhooksEngine.processWebhook).mockResolvedValue({ received: true });

    const bodyStr = JSON.stringify({ type: 'subscription.updated', data: {} });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const sig = createHmac('sha256', secret).update(`${timestamp}.${bodyStr}`).digest('hex');

    const res = await signedApp.request('/v1/billing/webhooks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'stripe-signature': `t=${timestamp},v1=${sig}`,
      },
      body: bodyStr,
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it('rejects stale signatures older than 5 minutes', async () => {
    const secret = 'whsec_test_secret';
    const signedApp = createApp({ STRIPE_WEBHOOK_SECRET: secret });

    const bodyStr = JSON.stringify({ type: 'subscription.updated', data: {} });
    // Timestamp 10 minutes in the past
    const staleTimestamp = (Math.floor(Date.now() / 1000) - 600).toString();
    const sig = createHmac('sha256', secret).update(`${staleTimestamp}.${bodyStr}`).digest('hex');

    const res = await signedApp.request('/v1/billing/webhooks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'stripe-signature': `t=${staleTimestamp},v1=${sig}`,
      },
      body: bodyStr,
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_signature');
  });
});
