import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../engine/inboundWebhook.js', () => ({
  createWebhook: vi.fn(),
  listWebhooks: vi.fn(),
  deleteWebhook: vi.fn(),
  triggerWebhook: vi.fn(),
}));

vi.mock('../../engine/channel.js', () => ({
  getChannel: vi.fn(),
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
import { inboundWebhookRoutes } from '../../routes/inboundWebhook.js';
import { getDb } from '../../db/index.js';
import * as inboundWebhookEngine from '../../engine/inboundWebhook.js';
import * as channelEngine from '../../engine/channel.js';
import {
  createMockBindings, mockDbForWorkspaceAuth, mockDbForAgentAuth,
  wsAuthHeaders, agentAuthHeaders,
  FAKE_WORKSPACE,
} from '../../__tests__/test-helpers.js';

const bindings = createMockBindings();

const app = new Hono<AppEnv>();
app.use('*', dbMiddleware);
const v1 = new Hono<AppEnv>();
v1.route('/', inboundWebhookRoutes);
app.route('/v1', v1);

app.onError((err, c) => {
  const error = err as Error & { code?: string; status?: number };
  return c.json({ ok: false, error: { code: error.code || 'internal_error', message: error.message } }, (error.status || 500) as any);
});

// ── POST /v1/webhooks ──────────────────────────────────────────────────────

describe('POST /v1/webhooks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue(mockDbForWorkspaceAuth());
  });

  it('creates a webhook and returns 201', async () => {
    vi.mocked(channelEngine.getChannel).mockResolvedValue({
      id: 'ch_001',
      name: 'engineering',
      workspaceId: 'ws_123',
      topic: null,
      archived: false,
      createdAt: new Date(),
      metadata: {},
    } as any);
    vi.mocked(inboundWebhookEngine.createWebhook).mockResolvedValue({
      id: 'wh_001',
      name: 'CI Pipeline',
      channel_id: 'ch_001',
      webhook_url: 'https://api.relaycast.dev/v1/hooks/wh_001',
      workspace_id: 'ws_123',
      created_at: '2025-01-01T00:00:00.000Z',
    });

    const res = await app.request('/v1/webhooks', {
      method: 'POST',
      headers: wsAuthHeaders(),
      body: JSON.stringify({ name: 'CI Pipeline', channel: 'engineering' }),
    }, bindings);

    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.data.name).toBe('CI Pipeline');
    expect(inboundWebhookEngine.createWebhook).toHaveBeenCalledWith(
      expect.anything(),
      'ws_123',
      'ch_001',
      { name: 'CI Pipeline' },
    );
  });

  it('returns 400 when name is missing', async () => {
    const res = await app.request('/v1/webhooks', {
      method: 'POST',
      headers: wsAuthHeaders(),
      body: JSON.stringify({ channel: 'engineering' }),
    }, bindings);

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error.code).toBe('invalid_request');
  });

  it('returns 400 when channel is missing', async () => {
    const res = await app.request('/v1/webhooks', {
      method: 'POST',
      headers: wsAuthHeaders(),
      body: JSON.stringify({ name: 'CI Pipeline' }),
    }, bindings);

    expect(res.status).toBe(400);
  });

  it('returns 404 when channel not found', async () => {
    vi.mocked(channelEngine.getChannel).mockResolvedValue(null);

    const res = await app.request('/v1/webhooks', {
      method: 'POST',
      headers: wsAuthHeaders(),
      body: JSON.stringify({ name: 'CI Pipeline', channel: 'nonexistent' }),
    }, bindings);

    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.error.code).toBe('channel_not_found');
  });

  it('returns 401 without auth', async () => {
    const res = await app.request('/v1/webhooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'CI Pipeline', channel: 'engineering' }),
    }, bindings);

    expect(res.status).toBe(401);
  });

  it('rejects agent token (requireWorkspaceKey only)', async () => {
    vi.mocked(getDb).mockReturnValue(mockDbForAgentAuth());

    const res = await app.request('/v1/webhooks', {
      method: 'POST',
      headers: agentAuthHeaders(),
      body: JSON.stringify({ name: 'CI Pipeline', channel: 'engineering' }),
    }, bindings);

    expect(res.status).toBe(401);
  });

  it('propagates engine errors with correct status', async () => {
    vi.mocked(channelEngine.getChannel).mockResolvedValue({
      id: 'ch_001',
      name: 'engineering',
      workspaceId: 'ws_123',
      topic: null,
      archived: false,
      createdAt: new Date(),
      metadata: {},
    } as any);
    vi.mocked(inboundWebhookEngine.createWebhook).mockRejectedValue(
      Object.assign(new Error('Webhook limit reached'), {
        code: 'limit_exceeded',
        status: 429,
      }),
    );

    const res = await app.request('/v1/webhooks', {
      method: 'POST',
      headers: wsAuthHeaders(),
      body: JSON.stringify({ name: 'CI Pipeline', channel: 'engineering' }),
    }, bindings);

    expect(res.status).toBe(429);
    const body = await res.json() as any;
    expect(body.error.code).toBe('limit_exceeded');
  });
});

// ── GET /v1/webhooks ───────────────────────────────────────────────────────

describe('GET /v1/webhooks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue(mockDbForWorkspaceAuth());
  });

  it('lists webhooks and returns 200', async () => {
    vi.mocked(inboundWebhookEngine.listWebhooks).mockResolvedValue([
      { id: 'wh_001', name: 'CI Pipeline', channel_id: 'ch_001', webhook_url: 'https://api.relaycast.dev/v1/hooks/wh_001', workspace_id: 'ws_123', created_at: '2025-01-01T00:00:00.000Z' },
    ]);

    const res = await app.request('/v1/webhooks', {
      headers: wsAuthHeaders(),
    }, bindings);

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].name).toBe('CI Pipeline');
  });

  it('returns empty array when no webhooks', async () => {
    vi.mocked(inboundWebhookEngine.listWebhooks).mockResolvedValue([]);

    const res = await app.request('/v1/webhooks', {
      headers: wsAuthHeaders(),
    }, bindings);

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data).toEqual([]);
  });
});

// ── DELETE /v1/webhooks/:id ────────────────────────────────────────────────

describe('DELETE /v1/webhooks/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue(mockDbForWorkspaceAuth());
  });

  it('deletes a webhook and returns 204', async () => {
    vi.mocked(inboundWebhookEngine.deleteWebhook).mockResolvedValue(true);

    const res = await app.request('/v1/webhooks/wh_001', {
      method: 'DELETE',
      headers: wsAuthHeaders(),
    }, bindings);

    expect(res.status).toBe(204);
    expect(inboundWebhookEngine.deleteWebhook).toHaveBeenCalledWith(expect.anything(), 'ws_123', 'wh_001');
  });

  it('returns 404 when webhook not found', async () => {
    vi.mocked(inboundWebhookEngine.deleteWebhook).mockResolvedValue(false);

    const res = await app.request('/v1/webhooks/wh_999', {
      method: 'DELETE',
      headers: wsAuthHeaders(),
    }, bindings);

    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.error.code).toBe('webhook_not_found');
  });
});

// ── POST /v1/hooks/:webhookId ──────────────────────────────────────────────

describe('POST /v1/hooks/:webhookId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The trigger endpoint doesn't require auth (external callers)
    vi.mocked(getDb).mockReturnValue(mockDbForWorkspaceAuth());
  });

  it('triggers a webhook and returns 201', async () => {
    vi.mocked(inboundWebhookEngine.triggerWebhook).mockResolvedValue({
      id: 'msg_001',
      webhook_id: 'wh_001',
      text: 'Build passed',
      source: 'github',
      workspace_id: 'ws_123',
      channel_id: 'ch_001',
      created_at: '2025-01-01T00:00:00.000Z',
    });

    const res = await app.request('/v1/hooks/wh_001', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Build passed', source: 'github' }),
    }, bindings);

    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.data.text).toBe('Build passed');
    // Should not expose workspace_id or channel_id in response
    expect(body.data.workspace_id).toBeUndefined();
    expect(bindings.WEBHOOK_QUEUE.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'webhook.received',
      workspaceId: 'ws_123',
    }));
  });

  it('returns 404 when webhook not found', async () => {
    vi.mocked(inboundWebhookEngine.triggerWebhook).mockResolvedValue(null);

    const res = await app.request('/v1/hooks/wh_999', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Build passed' }),
    }, bindings);

    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.error.code).toBe('webhook_not_found');
  });

  it('accepts trigger with payload field', async () => {
    vi.mocked(inboundWebhookEngine.triggerWebhook).mockResolvedValue({
      id: 'msg_002',
      webhook_id: 'wh_001',
      text: null,
      source: 'datadog',
      workspace_id: 'ws_123',
      channel_id: 'ch_001',
      created_at: '2025-01-01T00:00:00.000Z',
    });

    const res = await app.request('/v1/hooks/wh_001', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'datadog', payload: { alert: 'cpu_high', severity: 'warning' } }),
    }, bindings);

    expect(res.status).toBe(201);
    expect(inboundWebhookEngine.triggerWebhook).toHaveBeenCalledWith(
      expect.anything(),
      'wh_001',
      expect.objectContaining({
        source: 'datadog',
        payload: { alert: 'cpu_high', severity: 'warning' },
      }),
    );
  });

  it('does not expose channel_id in response', async () => {
    vi.mocked(inboundWebhookEngine.triggerWebhook).mockResolvedValue({
      id: 'msg_003',
      webhook_id: 'wh_001',
      text: 'Test',
      source: null,
      workspace_id: 'ws_123',
      channel_id: 'ch_001',
      created_at: '2025-01-01T00:00:00.000Z',
    });

    const res = await app.request('/v1/hooks/wh_001', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Test' }),
    }, bindings);

    const body = await res.json() as any;
    expect(body.data.channel_id).toBeUndefined();
    expect(body.data.workspace_id).toBeUndefined();
  });

  it('does not require any auth (external callers)', async () => {
    vi.mocked(inboundWebhookEngine.triggerWebhook).mockResolvedValue({
      id: 'msg_004',
      webhook_id: 'wh_001',
      text: 'External event',
      source: null,
      workspace_id: 'ws_123',
      channel_id: 'ch_001',
      created_at: '2025-01-01T00:00:00.000Z',
    });

    // No Authorization header at all
    const res = await app.request('/v1/hooks/wh_001', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'External event' }),
    }, bindings);

    expect(res.status).toBe(201);
  });
});
