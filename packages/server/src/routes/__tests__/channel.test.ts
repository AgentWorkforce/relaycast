import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { Hono } from 'hono';
import type { AppEnv } from '../../env.js';
import { dbMiddleware } from '../../middleware/db.js';
import { channelRoutes } from '../../routes/channel.js';
import { getDb } from '../../db/index.js';
import * as channelEngine from '../../engine/channel.js';
import {
  createMockBindings, mockDbForWorkspaceAuth, mockDbForAgentAuth,
  wsAuthHeaders, agentAuthHeaders,
  TEST_API_KEY, TEST_AGENT_TOKEN, FAKE_WORKSPACE,
} from '../../__tests__/test-helpers.js';

const bindings = createMockBindings();

const app = new Hono<AppEnv>();
app.use('*', dbMiddleware);
const v1 = new Hono<AppEnv>();
v1.route('/', channelRoutes);
app.route('/v1', v1);

app.onError((err, c) => {
  const error = err as Error & { code?: string; status?: number };
  return c.json({ ok: false, error: { code: error.code || 'internal_error', message: error.message } }, (error.status || 500) as any);
});

describe('POST /v1/channels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue(mockDbForWorkspaceAuth());
  });

  it('creates a channel and returns 201', async () => {
    vi.mocked(channelEngine.createChannel).mockResolvedValue({
      id: 'ch_456',
      name: 'code-review',
      topic: 'PR discussions',
      created_by: null,
      created_at: '2025-01-01T00:00:00.000Z',
      member_count: 0,
    });

    const res = await app.request('/v1/channels', {
      method: 'POST',
      headers: wsAuthHeaders(),
      body: JSON.stringify({ name: 'code-review', topic: 'PR discussions' }),
    }, bindings);

    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.data.name).toBe('code-review');
    expect(bindings.WEBHOOK_QUEUE.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'channel.created',
      workspaceId: FAKE_WORKSPACE.id,
      data: expect.objectContaining({ name: 'code-review' }),
    }));
  });

  it('returns 400 when name is missing', async () => {
    const res = await app.request('/v1/channels', {
      method: 'POST',
      headers: wsAuthHeaders(),
      body: JSON.stringify({}),
    }, bindings);
    expect(res.status).toBe(400);
  });

  it('returns 409 for duplicate channel', async () => {
    vi.mocked(channelEngine.createChannel).mockRejectedValue(
      Object.assign(new Error('Channel "code-review" already exists'), {
        code: 'channel_already_exists',
        status: 409,
      }),
    );

    const res = await app.request('/v1/channels', {
      method: 'POST',
      headers: wsAuthHeaders(),
      body: JSON.stringify({ name: 'code-review' }),
    }, bindings);
    expect(res.status).toBe(409);
  });
});

describe('GET /v1/channels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue(mockDbForWorkspaceAuth());
  });

  it('lists channels', async () => {
    vi.mocked(channelEngine.listChannels).mockResolvedValue([
      {
        id: 'ch_1',
        name: 'general',
        topic: 'General discussion',
        member_count: 3,
        created_at: '2025-01-01T00:00:00.000Z',
        is_archived: false,
      },
    ]);

    const res = await app.request('/v1/channels', {
      headers: wsAuthHeaders(),
    }, bindings);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data).toHaveLength(1);
  });

  it('passes include_archived flag', async () => {
    vi.mocked(channelEngine.listChannels).mockResolvedValue([]);

    await app.request('/v1/channels?include_archived=true', {
      headers: wsAuthHeaders(),
    }, bindings);

    expect(channelEngine.listChannels).toHaveBeenCalledWith(expect.anything(), 'ws_123', true);
  });
});

describe('GET /v1/channels/:name', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue(mockDbForWorkspaceAuth());
  });

  it('returns channel with members', async () => {
    vi.mocked(channelEngine.getChannel).mockResolvedValue({
      id: 'ch_1',
      name: 'general',
      topic: 'General discussion',
      member_count: 1,
      members: [
        {
          agent_id: 'agent_1',
          agent_name: 'Bot1',
          role: 'member',
          joined_at: '2025-01-01T00:00:00.000Z',
        },
      ],
      created_at: '2025-01-01T00:00:00.000Z',
      is_archived: false,
    });

    const res = await app.request('/v1/channels/general', {
      headers: wsAuthHeaders(),
    }, bindings);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.members).toHaveLength(1);
  });

  it('returns 404 for unknown channel', async () => {
    vi.mocked(channelEngine.getChannel).mockResolvedValue(null);

    const res = await app.request('/v1/channels/unknown', {
      headers: wsAuthHeaders(),
    }, bindings);
    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.error.code).toBe('channel_not_found');
  });
});

describe('DELETE /v1/channels/:name (archive)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue(mockDbForWorkspaceAuth());
  });

  it('archives channel and returns 204', async () => {
    vi.mocked(channelEngine.archiveChannel).mockResolvedValue(true);

    const res = await app.request('/v1/channels/old-channel', {
      method: 'DELETE',
      headers: wsAuthHeaders(),
    }, bindings);
    expect(res.status).toBe(204);
  });

  it('returns 400 when trying to archive #general', async () => {
    vi.mocked(channelEngine.archiveChannel).mockRejectedValue(
      Object.assign(new Error('#general cannot be archived'), {
        code: 'cannot_archive_general',
        status: 400,
      }),
    );

    const res = await app.request('/v1/channels/general', {
      method: 'DELETE',
      headers: wsAuthHeaders(),
    }, bindings);
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error.code).toBe('cannot_archive_general');
  });
});

describe('POST /v1/channels/:name/join', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue(mockDbForAgentAuth());
  });

  it('agent joins channel with agent token', async () => {
    vi.mocked(channelEngine.joinChannel).mockResolvedValue({
      channel: 'code-review',
      agent_id: 'agent_123',
      already_member: false,
    });

    const res = await app.request('/v1/channels/code-review/join', {
      method: 'POST',
      headers: agentAuthHeaders(),
    }, bindings);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.channel).toBe('code-review');
  });

  it('rejects workspace key for join', async () => {
    vi.mocked(getDb).mockReturnValue(mockDbForWorkspaceAuth());
    const res = await app.request('/v1/channels/code-review/join', {
      method: 'POST',
      headers: wsAuthHeaders(),
    }, bindings);
    expect(res.status).toBe(401);
  });
});

describe('POST /v1/channels/:name/leave', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue(mockDbForAgentAuth());
  });

  it('agent leaves channel and returns 204', async () => {
    vi.mocked(channelEngine.leaveChannel).mockResolvedValue(undefined);

    const res = await app.request('/v1/channels/code-review/leave', {
      method: 'POST',
      headers: agentAuthHeaders(),
    }, bindings);
    expect(res.status).toBe(204);
  });
});

describe('GET /v1/channels/:name/members', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue(mockDbForWorkspaceAuth());
  });

  it('lists channel members', async () => {
    vi.mocked(channelEngine.getMembers).mockResolvedValue([
      {
        agent_id: 'agent_1',
        agent_name: 'Bot1',
        role: 'member',
        joined_at: '2025-01-01T00:00:00.000Z',
      },
    ]);

    const res = await app.request('/v1/channels/general/members', {
      headers: wsAuthHeaders(),
    }, bindings);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data).toHaveLength(1);
  });
});

describe('POST /v1/channels/:name/invite', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue(mockDbForAgentAuth());
  });

  it('invites agent to channel', async () => {
    vi.mocked(channelEngine.inviteAgent).mockResolvedValue({
      channel: 'code-review',
      agent: 'WorkerBot',
    });

    const res = await app.request('/v1/channels/code-review/invite', {
      method: 'POST',
      headers: agentAuthHeaders(),
      body: JSON.stringify({ agent_name: 'WorkerBot' }),
    }, bindings);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.agent).toBe('WorkerBot');
  });

  it('returns 400 when agent name is missing', async () => {
    const res = await app.request('/v1/channels/code-review/invite', {
      method: 'POST',
      headers: agentAuthHeaders(),
      body: JSON.stringify({}),
    }, bindings);
    expect(res.status).toBe(400);
  });
});
