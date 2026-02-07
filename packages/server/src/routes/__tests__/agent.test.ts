import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

vi.mock('../../engine/agent.js', () => ({
  registerAgent: vi.fn(),
  listAgents: vi.fn(),
  getAgentByName: vi.fn(),
  updateAgent: vi.fn(),
  deleteAgent: vi.fn(),
}));

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

vi.mock('../../engine/presence.js', () => ({
  getPresence: vi.fn(),
}));

vi.mock('../../engine/systemPrompt.js', () => ({
  getSystemPrompt: vi.fn(),
  setSystemPrompt: vi.fn(),
}));

vi.mock('../../engine/billing.js', () => ({
  subscribe: vi.fn(),
  getSubscription: vi.fn(),
  getUsage: vi.fn(),
  getInvoices: vi.fn(),
  createPortalSession: vi.fn(),
}));

vi.mock('../../engine/webhooks.js', () => ({
  processWebhook: vi.fn(),
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
import * as agentEngine from '../../engine/agent.js';
import { getDb } from '../../db/index.js';
import { hashToken } from '../../middleware/auth.js';
import crypto from 'node:crypto';

const apiKey = `rk_live_${crypto.randomBytes(16).toString('hex')}`;
const apiKeyHash = hashToken(apiKey);

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

function mockDbForAuth() {
  vi.mocked(getDb).mockReturnValue({
    select: () => ({
      from: () => ({
        where: vi.fn().mockResolvedValue([fakeWorkspace]),
      }),
    }),
  } as ReturnType<typeof getDb>);
}

describe('POST /v1/agents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbForAuth();
  });

  it('registers an agent and returns 201 with token', async () => {
    vi.mocked(agentEngine.registerAgent).mockResolvedValue({
      id: 'agent_456',
      name: 'CodeReviewer',
      token: 'at_live_tokenvalue123',
      status: 'online',
      created_at: '2025-01-01T00:00:00.000Z',
    });

    const res = await request(app)
      .post('/v1/agents')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ name: 'CodeReviewer', persona: 'Senior code reviewer' });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.name).toBe('CodeReviewer');
    expect(res.body.data.token).toContain('at_live_');
  });

  it('returns 400 when name is missing', async () => {
    const res = await request(app)
      .post('/v1/agents')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_request');
  });

  it('returns 409 for duplicate agent name', async () => {
    vi.mocked(agentEngine.registerAgent).mockRejectedValue(
      Object.assign(new Error('Agent "CodeReviewer" already exists'), {
        code: 'agent_already_exists',
        status: 409,
      }),
    );

    const res = await request(app)
      .post('/v1/agents')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ name: 'CodeReviewer' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('agent_already_exists');
  });
});

describe('GET /v1/agents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbForAuth();
  });

  it('lists agents', async () => {
    vi.mocked(agentEngine.listAgents).mockResolvedValue([
      {
        id: 'agent_1',
        name: 'Bot1',
        type: 'agent',
        status: 'online',
        persona: null,
        last_seen: '2025-01-01T00:00:00.000Z',
        metadata: {},
      },
    ]);

    const res = await request(app)
      .get('/v1/agents')
      .set('Authorization', `Bearer ${apiKey}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe('Bot1');
  });

  it('filters agents by status', async () => {
    vi.mocked(agentEngine.listAgents).mockResolvedValue([]);

    await request(app)
      .get('/v1/agents?status=online')
      .set('Authorization', `Bearer ${apiKey}`);

    expect(agentEngine.listAgents).toHaveBeenCalledWith('ws_123', 'online');
  });
});

describe('GET /v1/agents/:name', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbForAuth();
  });

  it('returns agent by name', async () => {
    vi.mocked(agentEngine.getAgentByName).mockResolvedValue({
      id: 'agent_1',
      name: 'Bot1',
      type: 'agent',
      status: 'online',
      persona: 'Helper bot',
      last_seen: '2025-01-01T00:00:00.000Z',
      metadata: {},
      channels: [{ id: 'ch_1', name: 'general', role: 'member', joined_at: '2025-01-01T00:00:00.000Z' }],
    });

    const res = await request(app)
      .get('/v1/agents/Bot1')
      .set('Authorization', `Bearer ${apiKey}`);
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Bot1');
    expect(res.body.data.channels).toHaveLength(1);
  });

  it('returns 404 for unknown agent', async () => {
    vi.mocked(agentEngine.getAgentByName).mockResolvedValue(null);

    const res = await request(app)
      .get('/v1/agents/Unknown')
      .set('Authorization', `Bearer ${apiKey}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('agent_not_found');
  });
});

describe('PATCH /v1/agents/:name', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbForAuth();
  });

  it('updates agent', async () => {
    vi.mocked(agentEngine.updateAgent).mockResolvedValue({
      id: 'agent_1',
      name: 'Bot1',
      type: 'agent',
      status: 'offline',
      persona: null,
      last_seen: '2025-01-01T00:00:00.000Z',
      metadata: {},
    });

    const res = await request(app)
      .patch('/v1/agents/Bot1')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ status: 'offline' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('offline');
  });
});

describe('DELETE /v1/agents/:name', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbForAuth();
  });

  it('deletes agent and returns 204', async () => {
    vi.mocked(agentEngine.deleteAgent).mockResolvedValue(true);

    const res = await request(app)
      .delete('/v1/agents/Bot1')
      .set('Authorization', `Bearer ${apiKey}`);
    expect(res.status).toBe(204);
  });

  it('returns 404 for unknown agent', async () => {
    vi.mocked(agentEngine.deleteAgent).mockResolvedValue(false);

    const res = await request(app)
      .delete('/v1/agents/Unknown')
      .set('Authorization', `Bearer ${apiKey}`);
    expect(res.status).toBe(404);
  });
});
