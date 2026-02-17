import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../engine/billing.js', () => ({
  subscribe: vi.fn(),
  getSubscription: vi.fn(),
  getUsage: vi.fn(),
  getInvoices: vi.fn(),
  createPortalSession: vi.fn(),
}));

vi.mock('../../engine/agent.js', () => ({
  touchLastSeen: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../db/index.js', () => ({
  getDb: vi.fn(),
}));

import { Hono } from 'hono';
import type { AppEnv } from '../../env.js';
import { dbMiddleware } from '../../middleware/db.js';
import { billingRoutes } from '../../routes/billing.js';
import * as billingEngine from '../../engine/billing.js';
import { getDb } from '../../db/index.js';
import {
  mockDbForWorkspaceAuth,
  mockDbForAgentAuth,
  wsAuthHeaders,
  agentAuthHeaders,
  createMockBindings,
  FAKE_WORKSPACE,
} from '../../__tests__/test-helpers.js';

// Override FAKE_WORKSPACE to include stripeCustomerId for billing tests
const billingWorkspace = {
  ...FAKE_WORKSPACE,
  stripeCustomerId: 'cus_abc',
  stripeSubscriptionId: 'sub_abc',
};

function mockDbForBillingWorkspaceAuth() {
  return {
    select: () => ({
      from: () => ({
        where: vi.fn().mockResolvedValue([billingWorkspace]),
      }),
    }),
    insert: () => ({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([]),
        onConflictDoNothing: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      }),
    }),
    update: () => ({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      }),
    }),
    delete: () => ({
      where: vi.fn().mockResolvedValue([]),
    }),
    execute: vi.fn().mockResolvedValue({ rows: [] }),
  } as any;
}

const bindings = createMockBindings();
const app = new Hono<AppEnv>();
app.use('*', async (c, next) => {
  (c as any).env = { ...bindings };
  await next();
});
app.use('*', dbMiddleware);
const v1 = new Hono<AppEnv>();
v1.route('/', billingRoutes);
app.route('/v1', v1);

describe('POST /v1/billing/subscribe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue(mockDbForBillingWorkspaceAuth());
  });

  it('creates subscription and returns 201', async () => {
    vi.mocked(billingEngine.subscribe).mockResolvedValue({
      subscription_id: 'sub_new',
      plan: 'pro',
      status: 'active',
      current_period_end: '2025-02-01T00:00:00.000Z',
    });

    const res = await app.request('/v1/billing/subscribe', {
      method: 'POST',
      headers: wsAuthHeaders(),
      body: JSON.stringify({ plan: 'pro', payment_method: 'pm_123' }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.plan).toBe('pro');
    expect(billingEngine.subscribe).toHaveBeenCalledWith(
      expect.anything(),
      FAKE_WORKSPACE.id,
      'pro',
      'pm_123',
    );
  });

  it('returns 400 for invalid plan', async () => {
    const res = await app.request('/v1/billing/subscribe', {
      method: 'POST',
      headers: wsAuthHeaders(),
      body: JSON.stringify({ plan: 'invalid', payment_method: 'pm_123' }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_request');
  });

  it('returns 400 for missing payment_method', async () => {
    const res = await app.request('/v1/billing/subscribe', {
      method: 'POST',
      headers: wsAuthHeaders(),
      body: JSON.stringify({ plan: 'pro' }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain('payment_method');
  });

  it('returns 401 without auth', async () => {
    const res = await app.request('/v1/billing/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: 'pro', payment_method: 'pm_123' }),
    });

    expect(res.status).toBe(401);
  });

  it('returns 401 with agent token', async () => {
    vi.mocked(getDb).mockReturnValue(mockDbForAgentAuth());

    const res = await app.request('/v1/billing/subscribe', {
      method: 'POST',
      headers: agentAuthHeaders(),
      body: JSON.stringify({ plan: 'pro', payment_method: 'pm_123' }),
    });

    expect(res.status).toBe(401);
  });
});

describe('GET /v1/billing/subscription', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue(mockDbForBillingWorkspaceAuth());
  });

  it('returns subscription data', async () => {
    vi.mocked(billingEngine.getSubscription).mockResolvedValue({
      plan: 'pro',
      status: 'active',
      current_period_end: '2025-02-01T00:00:00.000Z',
      usage_this_period: { messages_sent: 100, api_calls: 50, files_uploaded: 2, file_bytes: 1024, ws_minutes: 10 },
    });

    const res = await app.request('/v1/billing/subscription', {
      method: 'GET',
      headers: wsAuthHeaders(),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.plan).toBe('pro');
  });

  it('returns 401 without auth', async () => {
    const res = await app.request('/v1/billing/subscription', { method: 'GET' });
    expect(res.status).toBe(401);
  });
});

describe('GET /v1/billing/usage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue(mockDbForBillingWorkspaceAuth());
  });

  it('returns usage for current period', async () => {
    vi.mocked(billingEngine.getUsage).mockResolvedValue({
      messages_sent: 500,
      api_calls: 200,
      files_uploaded: 3,
      file_bytes: 2048,
      ws_minutes: 15,
      period_start: '2025-01-01T00:00:00.000Z',
      period_end: '2025-02-01T00:00:00.000Z',
    });

    const res = await app.request('/v1/billing/usage', {
      method: 'GET',
      headers: wsAuthHeaders(),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.messages_sent).toBe(500);
  });

  it('returns 400 for invalid period', async () => {
    const res = await app.request('/v1/billing/usage?period=invalid', {
      method: 'GET',
      headers: wsAuthHeaders(),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain('period');
  });
});

describe('GET /v1/billing/invoices', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue(mockDbForBillingWorkspaceAuth());
  });

  it('lists invoices', async () => {
    vi.mocked(billingEngine.getInvoices).mockResolvedValue([
      { id: 'in_1', amount: 2999, currency: 'usd', status: 'paid', period_start: '2025-01-01', period_end: '2025-02-01', pdf_url: 'https://example.com/inv.pdf' },
    ]);

    const res = await app.request('/v1/billing/invoices', {
      method: 'GET',
      headers: wsAuthHeaders(),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
  });

  it('defaults limit to 10', async () => {
    vi.mocked(billingEngine.getInvoices).mockResolvedValue([]);

    await app.request('/v1/billing/invoices', {
      method: 'GET',
      headers: wsAuthHeaders(),
    });

    expect(billingEngine.getInvoices).toHaveBeenCalledWith('cus_abc', 10);
  });

  it('returns 400 for invalid limit', async () => {
    const res = await app.request('/v1/billing/invoices?limit=-1', {
      method: 'GET',
      headers: wsAuthHeaders(),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain('limit');
  });
});

describe('POST /v1/billing/portal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue(mockDbForBillingWorkspaceAuth());
  });

  it('creates portal session', async () => {
    vi.mocked(billingEngine.createPortalSession).mockResolvedValue({
      url: 'https://billing.example.com/session/123',
    });

    const res = await app.request('/v1/billing/portal', {
      method: 'POST',
      headers: wsAuthHeaders(),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.url).toContain('billing.example.com');
  });
});
