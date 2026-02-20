import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../engine/message.js', () => ({
  postMessage: vi.fn(),
  getMessages: vi.fn(),
  getMessage: vi.fn(),
}));

vi.mock('../../engine/channel.js', () => ({
  createChannel: vi.fn(),
  listChannels: vi.fn(),
  getChannel: vi.fn(),
  updateChannel: vi.fn(),
  archiveChannel: vi.fn(),
  joinChannel: vi.fn(),
  leaveChannel: vi.fn(),
  getMembers: vi.fn(),
  inviteAgent: vi.fn(),
}));

vi.mock('../../engine/agent.js', () => ({
  touchLastSeen: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../db/index.js', () => ({
  getDb: vi.fn(),
}));

vi.mock('../../lib/serverTelemetry.js', () => ({
  emitServerEvent: vi.fn(),
}));

import { Hono } from 'hono';
import type { AppEnv } from '../../env.js';
import { dbMiddleware } from '../../middleware/db.js';
import { messageRoutes } from '../../routes/message.js';
import { getDb } from '../../db/index.js';
import * as messageEngine from '../../engine/message.js';
import * as channelEngine from '../../engine/channel.js';
import { emitServerEvent } from '../../lib/serverTelemetry.js';
import {
  createMockBindings, mockDbForAgentAuth, agentAuthHeaders, FAKE_WORKSPACE,
} from '../../__tests__/test-helpers.js';

const bindings = createMockBindings();

const app = new Hono<AppEnv>();
app.use('*', dbMiddleware);
const v1 = new Hono<AppEnv>();
v1.route('/', messageRoutes);
app.route('/v1', v1);

app.onError((err, c) => {
  const error = err as Error & { code?: string; status?: number };
  return c.json({ ok: false, error: { code: error.code || 'internal_error', message: error.message } }, (error.status || 500) as any);
});

const fakeChannel = {
  id: 'ch_789',
  name: 'general',
  topic: null,
  member_count: 1,
  members: [],
  created_at: '2025-01-01T00:00:00.000Z',
  is_archived: false,
};

describe('POST /v1/channels/:name/messages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue(mockDbForAgentAuth());
    vi.mocked(channelEngine.getChannel).mockResolvedValue(fakeChannel);
  });

  it('posts a message and returns 201', async () => {
    vi.mocked(messageEngine.postMessage).mockResolvedValue({
      id: 'msg_001',
      channel_id: 'ch_789',
      agent_id: 'agent_456',
      text: 'Hello world',
      has_attachments: false,
      thread_id: null,
      created_at: '2025-01-01T00:00:00.000Z',
      mentions: [],
    });

    const res = await app.request('/v1/channels/general/messages', {
      method: 'POST',
      headers: agentAuthHeaders(),
      body: JSON.stringify({ text: 'Hello world' }),
    }, bindings);

    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.data.text).toBe('Hello world');
    expect(body.data.id).toBe('msg_001');
    expect(bindings.WEBHOOK_QUEUE.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'message.created',
      workspaceId: FAKE_WORKSPACE.id,
      data: expect.objectContaining({ channel_name: 'general' }),
    }));
    expect(emitServerEvent).toHaveBeenCalledWith(
      expect.anything(),
      FAKE_WORKSPACE.id,
      'relaycast_server_message_created',
      expect.objectContaining({
        channel_id: 'ch_789',
      }),
    );
  });

  it('returns 400 when text is missing', async () => {
    const res = await app.request('/v1/channels/general/messages', {
      method: 'POST',
      headers: agentAuthHeaders(),
      body: JSON.stringify({}),
    }, bindings);

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error.code).toBe('invalid_request');
  });

  it('returns 404 when channel not found', async () => {
    vi.mocked(channelEngine.getChannel).mockResolvedValue(null);

    const res = await app.request('/v1/channels/nonexistent/messages', {
      method: 'POST',
      headers: agentAuthHeaders(),
      body: JSON.stringify({ text: 'Hello' }),
    }, bindings);

    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.error.code).toBe('channel_not_found');
  });
});

describe('GET /v1/channels/:name/messages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue(mockDbForAgentAuth());
    vi.mocked(channelEngine.getChannel).mockResolvedValue(fakeChannel);
  });

  it('returns messages array', async () => {
    vi.mocked(messageEngine.getMessages).mockResolvedValue([
      {
        id: 'msg_001',
        channel_id: 'ch_789',
        agent_id: 'agent_456',
        text: 'Hello',
        has_attachments: false,
        thread_id: null,
        created_at: '2025-01-01T00:00:00.000Z',
        reply_count: 0,
        reactions: [],
        read_by_count: 0,
      },
    ]);

    const res = await app.request('/v1/channels/general/messages', {
      headers: agentAuthHeaders(),
    }, bindings);

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].text).toBe('Hello');
  });

  it('passes pagination params correctly', async () => {
    vi.mocked(messageEngine.getMessages).mockResolvedValue([]);

    await app.request('/v1/channels/general/messages?limit=10&before=msg_050', {
      headers: agentAuthHeaders(),
    }, bindings);

    expect(messageEngine.getMessages).toHaveBeenCalledWith(
      expect.anything(),
      'ws_123',
      'ch_789',
      { limit: 10, before: 'msg_050', after: undefined },
    );
  });
});

describe('GET /v1/messages/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue(mockDbForAgentAuth());
  });

  it('returns a single message', async () => {
    vi.mocked(messageEngine.getMessage).mockResolvedValue({
      id: 'msg_001',
      channel_id: 'ch_789',
      agent_id: 'agent_456',
      text: 'Hello',
      has_attachments: false,
      thread_id: null,
      created_at: '2025-01-01T00:00:00.000Z',
      reply_count: 0,
      reactions: [],
      read_by_count: 0,
    });

    const res = await app.request('/v1/messages/msg_001', {
      headers: agentAuthHeaders(),
    }, bindings);

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.data.id).toBe('msg_001');
  });

  it('returns 404 for unknown message', async () => {
    vi.mocked(messageEngine.getMessage).mockResolvedValue(null);

    const res = await app.request('/v1/messages/unknown_id', {
      headers: agentAuthHeaders(),
    }, bindings);

    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.error.code).toBe('message_not_found');
  });
});
