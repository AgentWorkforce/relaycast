import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../engine/eventSubscription.js', () => ({
  createSubscription: vi.fn(),
  listSubscriptions: vi.fn(),
  getSubscription: vi.fn(),
  deleteSubscription: vi.fn(),
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
import { eventSubscriptionRoutes } from '../../routes/eventSubscription.js';
import { getDb } from '../../db/index.js';
import * as eventSubscriptionEngine from '../../engine/eventSubscription.js';
import {
  createMockBindings, mockDbForWorkspaceAuth, mockDbForAgentAuth,
  wsAuthHeaders, agentAuthHeaders,
} from '../../__tests__/test-helpers.js';

const bindings = createMockBindings();

const app = new Hono<AppEnv>();
app.use('*', dbMiddleware);
const v1 = new Hono<AppEnv>();
v1.route('/', eventSubscriptionRoutes);
app.route('/v1', v1);

app.onError((err, c) => {
  const error = err as Error & { code?: string; status?: number };
  return c.json({ ok: false, error: { code: error.code || 'internal_error', message: error.message } }, (error.status || 500) as any);
});

// ── POST /v1/subscriptions ─────────────────────────────────────────────────

describe('POST /v1/subscriptions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue(mockDbForWorkspaceAuth());
  });

  it('creates a subscription and returns 201', async () => {
    const sub = {
      id: 'sub_001',
      events: ['message.created'],
      url: 'https://example.com/webhook',
      secret: null,
      filter: null,
      workspace_id: 'ws_123',
      created_at: '2025-01-01T00:00:00.000Z',
    };
    vi.mocked(eventSubscriptionEngine.createSubscription).mockResolvedValue(sub);

    const res = await app.request('/v1/subscriptions', {
      method: 'POST',
      headers: wsAuthHeaders(),
      body: JSON.stringify({
        events: ['message.created'],
        url: 'https://example.com/webhook',
      }),
    }, bindings);

    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.data.events).toEqual(['message.created']);
    expect(body.data.url).toBe('https://example.com/webhook');
    expect(eventSubscriptionEngine.createSubscription).toHaveBeenCalledWith(
      expect.anything(),
      'ws_123',
      expect.objectContaining({ events: ['message.created'], url: 'https://example.com/webhook' }),
    );
  });

  it('returns 400 when events is missing', async () => {
    const res = await app.request('/v1/subscriptions', {
      method: 'POST',
      headers: wsAuthHeaders(),
      body: JSON.stringify({ url: 'https://example.com/webhook' }),
    }, bindings);

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error.code).toBe('invalid_request');
    expect(body.error.message).toContain('events');
  });

  it('returns 400 when events is empty array', async () => {
    const res = await app.request('/v1/subscriptions', {
      method: 'POST',
      headers: wsAuthHeaders(),
      body: JSON.stringify({ events: [], url: 'https://example.com/webhook' }),
    }, bindings);

    expect(res.status).toBe(400);
  });

  it('returns 400 when url is missing', async () => {
    const res = await app.request('/v1/subscriptions', {
      method: 'POST',
      headers: wsAuthHeaders(),
      body: JSON.stringify({ events: ['message.created'] }),
    }, bindings);

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error.message).toContain('url');
  });

  it('returns 401 without auth', async () => {
    const res = await app.request('/v1/subscriptions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: ['message.created'], url: 'https://example.com/webhook' }),
    }, bindings);

    expect(res.status).toBe(401);
  });

  it('works with agent token (requireAuth accepts both)', async () => {
    vi.mocked(getDb).mockReturnValue(mockDbForAgentAuth());
    vi.mocked(eventSubscriptionEngine.createSubscription).mockResolvedValue({
      id: 'sub_002',
      events: ['reaction.added'],
      url: 'https://example.com/hook',
      secret: null,
      filter: null,
      workspace_id: 'ws_123',
      created_at: '2025-01-01T00:00:00.000Z',
    });

    const res = await app.request('/v1/subscriptions', {
      method: 'POST',
      headers: agentAuthHeaders(),
      body: JSON.stringify({ events: ['reaction.added'], url: 'https://example.com/hook' }),
    }, bindings);

    expect(res.status).toBe(201);
  });

  it('passes optional secret and filter to engine', async () => {
    vi.mocked(eventSubscriptionEngine.createSubscription).mockResolvedValue({
      id: 'sub_003',
      events: ['message.created'],
      url: 'https://example.com/webhook',
      secret: 'whsec_test',
      filter: { channel: 'engineering' },
      workspace_id: 'ws_123',
      created_at: '2025-01-01T00:00:00.000Z',
    });

    const res = await app.request('/v1/subscriptions', {
      method: 'POST',
      headers: wsAuthHeaders(),
      body: JSON.stringify({
        events: ['message.created'],
        url: 'https://example.com/webhook',
        secret: 'whsec_test',
        filter: { channel: 'engineering' },
      }),
    }, bindings);

    expect(res.status).toBe(201);
    expect(eventSubscriptionEngine.createSubscription).toHaveBeenCalledWith(
      expect.anything(),
      'ws_123',
      expect.objectContaining({
        secret: 'whsec_test',
        filter: { channel: 'engineering' },
      }),
    );
  });

  it('creates subscription with multiple event types', async () => {
    vi.mocked(eventSubscriptionEngine.createSubscription).mockResolvedValue({
      id: 'sub_004',
      events: ['message.created', 'reaction.added', 'agent.online'],
      url: 'https://example.com/webhook',
      secret: null,
      filter: null,
      workspace_id: 'ws_123',
      created_at: '2025-01-01T00:00:00.000Z',
    });

    const res = await app.request('/v1/subscriptions', {
      method: 'POST',
      headers: wsAuthHeaders(),
      body: JSON.stringify({
        events: ['message.created', 'reaction.added', 'agent.online'],
        url: 'https://example.com/webhook',
      }),
    }, bindings);

    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.data.events).toHaveLength(3);
  });

  it('propagates engine errors with correct status', async () => {
    vi.mocked(eventSubscriptionEngine.createSubscription).mockRejectedValue(
      Object.assign(new Error('Subscription limit reached'), {
        code: 'limit_exceeded',
        status: 429,
      }),
    );

    const res = await app.request('/v1/subscriptions', {
      method: 'POST',
      headers: wsAuthHeaders(),
      body: JSON.stringify({ events: ['message.created'], url: 'https://example.com/webhook' }),
    }, bindings);

    expect(res.status).toBe(429);
    const body = await res.json() as any;
    expect(body.error.code).toBe('limit_exceeded');
  });
});

// ── GET /v1/subscriptions ──────────────────────────────────────────────────

describe('GET /v1/subscriptions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue(mockDbForWorkspaceAuth());
  });

  it('lists subscriptions and returns 200', async () => {
    vi.mocked(eventSubscriptionEngine.listSubscriptions).mockResolvedValue([
      { id: 'sub_001', events: ['message.created'], url: 'https://example.com/webhook', secret: null, filter: null, workspace_id: 'ws_123', created_at: '2025-01-01T00:00:00.000Z' },
    ]);

    const res = await app.request('/v1/subscriptions', {
      headers: wsAuthHeaders(),
    }, bindings);

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.data).toHaveLength(1);
  });

  it('returns empty array when no subscriptions', async () => {
    vi.mocked(eventSubscriptionEngine.listSubscriptions).mockResolvedValue([]);

    const res = await app.request('/v1/subscriptions', {
      headers: wsAuthHeaders(),
    }, bindings);

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data).toEqual([]);
  });
});

// ── GET /v1/subscriptions/:id ──────────────────────────────────────────────

describe('GET /v1/subscriptions/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue(mockDbForWorkspaceAuth());
  });

  it('returns a subscription by ID', async () => {
    vi.mocked(eventSubscriptionEngine.getSubscription).mockResolvedValue({
      id: 'sub_001',
      events: ['message.created'],
      url: 'https://example.com/webhook',
      secret: null,
      filter: null,
      workspace_id: 'ws_123',
      created_at: '2025-01-01T00:00:00.000Z',
    });

    const res = await app.request('/v1/subscriptions/sub_001', {
      headers: wsAuthHeaders(),
    }, bindings);

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.data.id).toBe('sub_001');
  });

  it('returns 404 when subscription not found', async () => {
    vi.mocked(eventSubscriptionEngine.getSubscription).mockResolvedValue(null);

    const res = await app.request('/v1/subscriptions/sub_999', {
      headers: wsAuthHeaders(),
    }, bindings);

    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.error.code).toBe('subscription_not_found');
  });
});

// ── DELETE /v1/subscriptions/:id ───────────────────────────────────────────

describe('DELETE /v1/subscriptions/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue(mockDbForWorkspaceAuth());
  });

  it('deletes a subscription and returns 204', async () => {
    vi.mocked(eventSubscriptionEngine.deleteSubscription).mockResolvedValue(true);

    const res = await app.request('/v1/subscriptions/sub_001', {
      method: 'DELETE',
      headers: wsAuthHeaders(),
    }, bindings);

    expect(res.status).toBe(204);
    expect(eventSubscriptionEngine.deleteSubscription).toHaveBeenCalledWith(expect.anything(), 'ws_123', 'sub_001');
  });

  it('returns 404 when subscription not found', async () => {
    vi.mocked(eventSubscriptionEngine.deleteSubscription).mockResolvedValue(false);

    const res = await app.request('/v1/subscriptions/sub_999', {
      method: 'DELETE',
      headers: wsAuthHeaders(),
    }, bindings);

    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.error.code).toBe('subscription_not_found');
  });
});
