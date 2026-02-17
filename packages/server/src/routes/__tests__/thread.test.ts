import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../engine/thread.js', () => ({
  postReply: vi.fn(),
  getThread: vi.fn(),
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
import { threadRoutes } from '../../routes/thread.js';
import { getDb } from '../../db/index.js';
import * as threadEngine from '../../engine/thread.js';
import {
  createMockBindings, mockDbForAgentAuth, agentAuthHeaders,
} from '../../__tests__/test-helpers.js';

const bindings = createMockBindings();

const app = new Hono<AppEnv>();
app.use('*', dbMiddleware);
const v1 = new Hono<AppEnv>();
v1.route('/', threadRoutes);
app.route('/v1', v1);

app.onError((err, c) => {
  const error = err as Error & { code?: string; status?: number };
  return c.json({ ok: false, error: { code: error.code || 'internal_error', message: error.message } }, (error.status || 500) as any);
});

describe('POST /v1/messages/:id/replies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue(mockDbForAgentAuth());
  });

  it('creates a reply and returns 201', async () => {
    vi.mocked(threadEngine.postReply).mockResolvedValue({
      id: 'reply_001',
      channel_id: 'ch_789',
      agent_id: 'agent_456',
      thread_id: 'msg_001',
      text: 'This is a reply',
      has_attachments: false,
      created_at: '2025-01-01T00:00:00.000Z',
    });

    const res = await app.request('/v1/messages/msg_001/replies', {
      method: 'POST',
      headers: agentAuthHeaders(),
      body: JSON.stringify({ text: 'This is a reply' }),
    }, bindings);

    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.data.thread_id).toBe('msg_001');
  });

  it('returns 400 when text is missing', async () => {
    const res = await app.request('/v1/messages/msg_001/replies', {
      method: 'POST',
      headers: agentAuthHeaders(),
      body: JSON.stringify({}),
    }, bindings);

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error.code).toBe('invalid_request');
  });

  it('returns 404 for unknown parent message', async () => {
    vi.mocked(threadEngine.postReply).mockRejectedValue(
      Object.assign(new Error('Parent message not found'), {
        code: 'message_not_found',
        status: 404,
      }),
    );

    const res = await app.request('/v1/messages/unknown/replies', {
      method: 'POST',
      headers: agentAuthHeaders(),
      body: JSON.stringify({ text: 'Reply' }),
    }, bindings);

    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.error.code).toBe('message_not_found');
  });
});

describe('GET /v1/messages/:id/replies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue(mockDbForAgentAuth());
  });

  it('returns parent + replies', async () => {
    vi.mocked(threadEngine.getThread).mockResolvedValue({
      parent: {
        id: 'msg_001',
        channel_id: 'ch_789',
        agent_id: 'agent_456',
        text: 'Original message',
        has_attachments: false,
        thread_id: null,
        created_at: '2025-01-01T00:00:00.000Z',
        reply_count: 2,
      },
      replies: [
        {
          id: 'reply_001',
          channel_id: 'ch_789',
          agent_id: 'agent_456',
          thread_id: 'msg_001',
          text: 'First reply',
          has_attachments: false,
          created_at: '2025-01-01T00:01:00.000Z',
        },
        {
          id: 'reply_002',
          channel_id: 'ch_789',
          agent_id: 'agent_456',
          thread_id: 'msg_001',
          text: 'Second reply',
          has_attachments: false,
          created_at: '2025-01-01T00:02:00.000Z',
        },
      ],
    });

    const res = await app.request('/v1/messages/msg_001/replies', {
      headers: agentAuthHeaders(),
    }, bindings);

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.data.parent.id).toBe('msg_001');
    expect(body.data.parent.reply_count).toBe(2);
    expect(body.data.replies).toHaveLength(2);
  });

  it('returns 404 for unknown parent', async () => {
    vi.mocked(threadEngine.getThread).mockRejectedValue(
      Object.assign(new Error('Parent message not found'), {
        code: 'message_not_found',
        status: 404,
      }),
    );

    const res = await app.request('/v1/messages/unknown/replies', {
      headers: agentAuthHeaders(),
    }, bindings);

    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.error.code).toBe('message_not_found');
  });
});
