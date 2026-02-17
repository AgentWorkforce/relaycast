import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../engine/inbox.js', () => ({
  getInbox: vi.fn(),
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
import { inboxRoutes } from '../../routes/inbox.js';
import * as inboxEngine from '../../engine/inbox.js';
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
v1.route('/', inboxRoutes);
app.route('/v1', v1);

describe('GET /v1/inbox', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue(mockDbForAgentAuth());
  });

  it('returns inbox with unread channels, mentions, and DMs', async () => {
    vi.mocked(inboxEngine.getInbox).mockResolvedValue({
      unread_channels: [
        { channel_name: 'general', unread_count: 5 },
        { channel_name: 'code-review', unread_count: 2 },
      ],
      mentions: [
        {
          id: 'msg_010',
          channel_name: 'general',
          agent_name: 'Alice',
          text: 'Hey @TestBot check this out',
          created_at: '2025-01-01T00:00:00.000Z',
        },
      ],
      unread_dms: [
        {
          conversation_id: 'dm_001',
          from: 'Alice',
          unread_count: 3,
          last_message: {
            id: 'msg_020',
            text: 'Can you review this?',
            created_at: '2025-01-01T00:00:00.000Z',
          },
        },
      ],
    });

    const res = await app.request('/v1/inbox', {
      method: 'GET',
      headers: agentAuthHeaders(),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.unread_channels).toHaveLength(2);
    expect(body.data.unread_channels[0].channel_name).toBe('general');
    expect(body.data.unread_channels[0].unread_count).toBe(5);
    expect(body.data.mentions).toHaveLength(1);
    expect(body.data.mentions[0].text).toContain('@TestBot');
    expect(body.data.unread_dms).toHaveLength(1);
    expect(body.data.unread_dms[0].from).toBe('Alice');
  });

  it('returns empty inbox when nothing unread', async () => {
    vi.mocked(inboxEngine.getInbox).mockResolvedValue({
      unread_channels: [],
      mentions: [],
      unread_dms: [],
    });

    const res = await app.request('/v1/inbox', {
      method: 'GET',
      headers: agentAuthHeaders(),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.unread_channels).toEqual([]);
    expect(body.data.mentions).toEqual([]);
    expect(body.data.unread_dms).toEqual([]);
  });

  it('returns 401 without auth', async () => {
    const res = await app.request('/v1/inbox', { method: 'GET' });
    expect(res.status).toBe(401);
  });

  it('returns 401 with workspace key (requires agent token)', async () => {
    vi.mocked(getDb).mockReturnValue(mockDbForWorkspaceAuth());

    const res = await app.request('/v1/inbox', {
      method: 'GET',
      headers: wsAuthHeaders(),
    });

    expect(res.status).toBe(401);
  });

  it('calls getInbox with correct workspace and agent IDs', async () => {
    vi.mocked(inboxEngine.getInbox).mockResolvedValue({
      unread_channels: [],
      mentions: [],
      unread_dms: [],
    });

    await app.request('/v1/inbox', {
      method: 'GET',
      headers: agentAuthHeaders(),
    });

    expect(inboxEngine.getInbox).toHaveBeenCalledWith(
      expect.anything(),
      FAKE_WORKSPACE.id,
      FAKE_AGENT.id,
    );
  });

  it('handles engine errors gracefully', async () => {
    vi.mocked(inboxEngine.getInbox).mockRejectedValue(new Error('DB connection failed'));

    const res = await app.request('/v1/inbox', {
      method: 'GET',
      headers: agentAuthHeaders(),
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('internal_error');
  });
});
