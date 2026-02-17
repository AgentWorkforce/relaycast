import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../engine/receipt.js', () => ({
  markRead: vi.fn(),
  getReaders: vi.fn(),
  getReadStatus: vi.fn(),
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
import { receiptRoutes } from '../../routes/receipt.js';
import * as receiptEngine from '../../engine/receipt.js';
import { getDb } from '../../db/index.js';
import {
  mockDbForAgentAuth,
  mockDbForWorkspaceAuth,
  agentAuthHeaders,
  wsAuthHeaders,
  createMockBindings,
  FAKE_AGENT,
  FAKE_WORKSPACE,
} from '../../__tests__/test-helpers.js';

const bindings = createMockBindings();
const app = new Hono<AppEnv>();
app.use('*', async (c, next) => {
  (c as any).env = { ...bindings };
  await next();
});
app.use('*', dbMiddleware);
const v1 = new Hono<AppEnv>();
v1.route('/', receiptRoutes);
app.route('/v1', v1);

describe('POST /v1/messages/:id/read', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue(mockDbForAgentAuth());
  });

  it('marks read and returns 200', async () => {
    vi.mocked(receiptEngine.markRead).mockResolvedValue({
      message_id: 'msg_001',
      agent_id: FAKE_AGENT.id,
      read_at: '2025-01-01T00:00:00.000Z',
    });

    const res = await app.request('/v1/messages/msg_001/read', {
      method: 'POST',
      headers: agentAuthHeaders(),
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.message_id).toBe('msg_001');
    expect(body.data.agent_id).toBe(FAKE_AGENT.id);
    expect(receiptEngine.markRead).toHaveBeenCalledWith(
      expect.anything(),
      FAKE_WORKSPACE.id,
      'msg_001',
      FAKE_AGENT.id,
    );
  });

  it('is idempotent', async () => {
    vi.mocked(receiptEngine.markRead).mockResolvedValue({
      message_id: 'msg_001',
      agent_id: FAKE_AGENT.id,
      read_at: '2025-01-01T00:00:00.000Z',
    });

    const res1 = await app.request('/v1/messages/msg_001/read', {
      method: 'POST',
      headers: agentAuthHeaders(),
      body: JSON.stringify({}),
    });

    vi.mocked(getDb).mockReturnValue(mockDbForAgentAuth());
    const res2 = await app.request('/v1/messages/msg_001/read', {
      method: 'POST',
      headers: agentAuthHeaders(),
      body: JSON.stringify({}),
    });

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
  });

  it('returns 404 when message not found', async () => {
    vi.mocked(receiptEngine.markRead).mockResolvedValue(null);

    const res = await app.request('/v1/messages/msg_999/read', {
      method: 'POST',
      headers: agentAuthHeaders(),
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('message_not_found');
  });

  it('returns 401 without auth', async () => {
    const res = await app.request('/v1/messages/msg_001/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(401);
  });

  it('returns 401 with workspace key (requires agent token)', async () => {
    vi.mocked(getDb).mockReturnValue(mockDbForWorkspaceAuth());

    const res = await app.request('/v1/messages/msg_001/read', {
      method: 'POST',
      headers: wsAuthHeaders(),
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(401);
  });
});

describe('GET /v1/messages/:id/readers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns list of readers with agent token', async () => {
    vi.mocked(getDb).mockReturnValue(mockDbForAgentAuth());
    vi.mocked(receiptEngine.getReaders).mockResolvedValue([
      { agent_name: 'TestBot', read_at: '2025-01-01T00:00:00.000Z' },
    ]);

    const res = await app.request('/v1/messages/msg_001/readers', {
      method: 'GET',
      headers: agentAuthHeaders(),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toEqual([
      { agent_name: 'TestBot', read_at: '2025-01-01T00:00:00.000Z' },
    ]);
  });

  it('returns list of readers with workspace key', async () => {
    vi.mocked(getDb).mockReturnValue(mockDbForWorkspaceAuth());
    vi.mocked(receiptEngine.getReaders).mockResolvedValue([
      { agent_name: 'TestBot', read_at: '2025-01-01T00:00:00.000Z' },
    ]);

    const res = await app.request('/v1/messages/msg_001/readers', {
      method: 'GET',
      headers: wsAuthHeaders(),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it('returns 404 when message not found', async () => {
    vi.mocked(getDb).mockReturnValue(mockDbForAgentAuth());
    vi.mocked(receiptEngine.getReaders).mockResolvedValue(null);

    const res = await app.request('/v1/messages/msg_999/readers', {
      method: 'GET',
      headers: agentAuthHeaders(),
    });

    expect(res.status).toBe(404);
  });

  it('returns empty array when no readers', async () => {
    vi.mocked(getDb).mockReturnValue(mockDbForAgentAuth());
    vi.mocked(receiptEngine.getReaders).mockResolvedValue([]);

    const res = await app.request('/v1/messages/msg_001/readers', {
      method: 'GET',
      headers: agentAuthHeaders(),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([]);
  });
});

describe('GET /v1/channels/:name/read-status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns per-member read positions', async () => {
    vi.mocked(getDb).mockReturnValue(mockDbForAgentAuth());
    vi.mocked(receiptEngine.getReadStatus).mockResolvedValue([
      { agent_name: 'TestBot', last_read_id: '100' },
    ]);

    const res = await app.request('/v1/channels/general/read-status', {
      method: 'GET',
      headers: agentAuthHeaders(),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toEqual([
      { agent_name: 'TestBot', last_read_id: '100' },
    ]);
  });

  it('works with workspace key', async () => {
    vi.mocked(getDb).mockReturnValue(mockDbForWorkspaceAuth());
    vi.mocked(receiptEngine.getReadStatus).mockResolvedValue([]);

    const res = await app.request('/v1/channels/general/read-status', {
      method: 'GET',
      headers: wsAuthHeaders(),
    });

    expect(res.status).toBe(200);
  });

  it('returns 404 when channel not found', async () => {
    vi.mocked(getDb).mockReturnValue(mockDbForAgentAuth());
    vi.mocked(receiptEngine.getReadStatus).mockResolvedValue(null);

    const res = await app.request('/v1/channels/missing/read-status', {
      method: 'GET',
      headers: agentAuthHeaders(),
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('channel_not_found');
  });

  it('returns empty array for channel with no members', async () => {
    vi.mocked(getDb).mockReturnValue(mockDbForAgentAuth());
    vi.mocked(receiptEngine.getReadStatus).mockResolvedValue([]);

    const res = await app.request('/v1/channels/empty/read-status', {
      method: 'GET',
      headers: agentAuthHeaders(),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([]);
  });
});
