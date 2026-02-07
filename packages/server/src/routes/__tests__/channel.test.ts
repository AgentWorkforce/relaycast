import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

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

vi.mock('../../engine/message.js', () => ({
  postMessage: vi.fn(),
  getMessages: vi.fn(),
  getMessage: vi.fn(),
}));

vi.mock('../../engine/agent.js', () => ({
  registerAgent: vi.fn(),
  listAgents: vi.fn(),
  getAgentByName: vi.fn(),
  updateAgent: vi.fn(),
  deleteAgent: vi.fn(),
}));

vi.mock('../../engine/thread.js', () => ({
  postReply: vi.fn(),
  getReplies: vi.fn(),
}));

vi.mock('../../engine/dm.js', () => ({
  sendDm: vi.fn(),
  listConversations: vi.fn(),
  getConversationMessages: vi.fn(),
}));

vi.mock('../../engine/groupDm.js', () => ({
  createGroupDm: vi.fn(),
  postToGroupDm: vi.fn(),
  addParticipant: vi.fn(),
  removeParticipant: vi.fn(),
}));

vi.mock('../../engine/reaction.js', () => ({
  addReaction: vi.fn(),
  removeReaction: vi.fn(),
  getReactions: vi.fn(),
}));

vi.mock('../../engine/search.js', () => ({
  searchMessages: vi.fn(),
}));

vi.mock('../../engine/inbox.js', () => ({
  getInbox: vi.fn(),
}));

vi.mock('../../engine/workspace.js', () => ({
  createWorkspace: vi.fn(),
  getWorkspace: vi.fn(),
  updateWorkspace: vi.fn(),
  deleteWorkspace: vi.fn(),
}));

vi.mock('../../engine/receipt.js', () => ({
  markRead: vi.fn(),
  getReaders: vi.fn(),
  getReadStatus: vi.fn(),
}));

vi.mock('../../engine/file.js', () => ({
  createUpload: vi.fn(),
  completeUpload: vi.fn(),
  getFile: vi.fn(),
  deleteFile: vi.fn(),
  listFiles: vi.fn(),
}));

vi.mock('../../db/index.js', () => ({
  getDb: vi.fn(),
}));

vi.mock('../../redis/index.js', () => ({
  getRedis: vi.fn(() => ({
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
  })),
}));

import { app } from '../../app.js';
import * as channelEngine from '../../engine/channel.js';
import { getDb } from '../../db/index.js';
import { hashToken } from '../../middleware/auth.js';
import crypto from 'node:crypto';

const apiKey = `rk_live_${crypto.randomBytes(16).toString('hex')}`;
const apiKeyHash = hashToken(apiKey);
const agentToken = `at_live_${crypto.randomBytes(16).toString('hex')}`;
const agentTokenHash = hashToken(agentToken);

const fakeWorkspace = {
  id: 'ws_123',
  name: 'test-workspace',
  apiKeyHash,
  systemPrompt: null,
  plan: 'free',
  stripeCustomerId: null,
  stripeSubscriptionId: null,
  createdAt: new Date(),
  metadata: {},
};

const fakeAgent = {
  id: 'agent_123',
  workspaceId: 'ws_123',
  name: 'TestBot',
  type: 'agent',
  tokenHash: agentTokenHash,
  status: 'online',
  persona: null,
  metadata: {},
  createdAt: new Date(),
  lastSeen: new Date(),
};

function mockDbForWorkspaceAuth() {
  vi.mocked(getDb).mockReturnValue({
    select: () => ({
      from: () => ({
        where: vi.fn().mockResolvedValue([fakeWorkspace]),
      }),
    }),
  } as ReturnType<typeof getDb>);
}

function mockDbForAgentAuth() {
  let callCount = 0;
  vi.mocked(getDb).mockReturnValue({
    select: () => ({
      from: () => ({
        where: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount % 2 === 1) {
            return Promise.resolve([fakeAgent]);
          }
          return Promise.resolve([fakeWorkspace]);
        }),
      }),
    }),
  } as ReturnType<typeof getDb>);
}

describe('POST /v1/channels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbForWorkspaceAuth();
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

    const res = await request(app)
      .post('/v1/channels')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ name: 'code-review', topic: 'PR discussions' });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.name).toBe('code-review');
  });

  it('returns 400 when name is missing', async () => {
    const res = await request(app)
      .post('/v1/channels')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it('returns 409 for duplicate channel', async () => {
    vi.mocked(channelEngine.createChannel).mockRejectedValue(
      Object.assign(new Error('Channel "code-review" already exists'), {
        code: 'channel_already_exists',
        status: 409,
      }),
    );

    const res = await request(app)
      .post('/v1/channels')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ name: 'code-review' });
    expect(res.status).toBe(409);
  });
});

describe('GET /v1/channels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbForWorkspaceAuth();
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

    const res = await request(app)
      .get('/v1/channels')
      .set('Authorization', `Bearer ${apiKey}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  it('passes include_archived flag', async () => {
    vi.mocked(channelEngine.listChannels).mockResolvedValue([]);

    await request(app)
      .get('/v1/channels?include_archived=true')
      .set('Authorization', `Bearer ${apiKey}`);

    expect(channelEngine.listChannels).toHaveBeenCalledWith('ws_123', true);
  });
});

describe('GET /v1/channels/:name', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbForWorkspaceAuth();
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

    const res = await request(app)
      .get('/v1/channels/general')
      .set('Authorization', `Bearer ${apiKey}`);
    expect(res.status).toBe(200);
    expect(res.body.data.members).toHaveLength(1);
  });

  it('returns 404 for unknown channel', async () => {
    vi.mocked(channelEngine.getChannel).mockResolvedValue(null);

    const res = await request(app)
      .get('/v1/channels/unknown')
      .set('Authorization', `Bearer ${apiKey}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('channel_not_found');
  });
});

describe('DELETE /v1/channels/:name (archive)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbForWorkspaceAuth();
  });

  it('archives channel and returns 204', async () => {
    vi.mocked(channelEngine.archiveChannel).mockResolvedValue(true);

    const res = await request(app)
      .delete('/v1/channels/old-channel')
      .set('Authorization', `Bearer ${apiKey}`);
    expect(res.status).toBe(204);
  });

  it('returns 400 when trying to archive #general', async () => {
    vi.mocked(channelEngine.archiveChannel).mockRejectedValue(
      Object.assign(new Error('#general cannot be archived'), {
        code: 'cannot_archive_general',
        status: 400,
      }),
    );

    const res = await request(app)
      .delete('/v1/channels/general')
      .set('Authorization', `Bearer ${apiKey}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('cannot_archive_general');
  });
});

describe('POST /v1/channels/:name/join', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbForAgentAuth();
  });

  it('agent joins channel with agent token', async () => {
    vi.mocked(channelEngine.joinChannel).mockResolvedValue({
      channel: 'code-review',
      agent_id: 'agent_123',
      already_member: false,
    });

    const res = await request(app)
      .post('/v1/channels/code-review/join')
      .set('Authorization', `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.channel).toBe('code-review');
  });

  it('rejects workspace key for join', async () => {
    mockDbForWorkspaceAuth();
    const res = await request(app)
      .post('/v1/channels/code-review/join')
      .set('Authorization', `Bearer ${apiKey}`);
    expect(res.status).toBe(401);
  });
});

describe('POST /v1/channels/:name/leave', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbForAgentAuth();
  });

  it('agent leaves channel and returns 204', async () => {
    vi.mocked(channelEngine.leaveChannel).mockResolvedValue(undefined);

    const res = await request(app)
      .post('/v1/channels/code-review/leave')
      .set('Authorization', `Bearer ${agentToken}`);
    expect(res.status).toBe(204);
  });
});

describe('GET /v1/channels/:name/members', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbForWorkspaceAuth();
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

    const res = await request(app)
      .get('/v1/channels/general/members')
      .set('Authorization', `Bearer ${apiKey}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });
});

describe('POST /v1/channels/:name/invite', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbForAgentAuth();
  });

  it('invites agent to channel', async () => {
    vi.mocked(channelEngine.inviteAgent).mockResolvedValue({
      channel: 'code-review',
      agent: 'WorkerBot',
    });

    const res = await request(app)
      .post('/v1/channels/code-review/invite')
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ agent: 'WorkerBot' });
    expect(res.status).toBe(200);
    expect(res.body.data.agent).toBe('WorkerBot');
  });

  it('returns 400 when agent name is missing', async () => {
    const res = await request(app)
      .post('/v1/channels/code-review/invite')
      .set('Authorization', `Bearer ${agentToken}`)
      .send({});
    expect(res.status).toBe(400);
  });
});
