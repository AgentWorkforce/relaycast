import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

vi.mock('../../engine/groupDm.js', () => ({
  createGroupDm: vi.fn(),
  postGroupMessage: vi.fn(),
  addParticipant: vi.fn(),
  removeParticipant: vi.fn(),
}));

vi.mock('../../engine/dm.js', () => ({
  sendDm: vi.fn(),
  listConversations: vi.fn(),
  getDmMessages: vi.fn(),
}));

vi.mock('../../engine/thread.js', () => ({
  postReply: vi.fn(),
  getThread: vi.fn(),
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

vi.mock('../../engine/agent.js', () => ({
  registerAgent: vi.fn(),
  listAgents: vi.fn(),
  getAgentByName: vi.fn(),
  updateAgent: vi.fn(),
  deleteAgent: vi.fn(),
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
import * as groupDmEngine from '../../engine/groupDm.js';
import { getDb } from '../../db/index.js';
import { hashToken } from '../../middleware/auth.js';
import crypto from 'node:crypto';

const agentToken = `at_live_${crypto.randomBytes(16).toString('hex')}`;
const agentTokenHash = hashToken(agentToken);

const fakeWorkspace = {
  id: 'ws_123',
  name: 'test-workspace',
  apiKeyHash: hashToken('rk_live_dummy'),
  systemPrompt: null,
  plan: 'free',
  stripeCustomerId: null,
  stripeSubscriptionId: null,
  createdAt: new Date(),
  metadata: {},
};

const fakeAgent = {
  id: 'agent_456',
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

function mockDbForAgentAuth() {
  const mockWhere = vi.fn();
  let callCount = 0;
  mockWhere.mockImplementation(() => {
    callCount++;
    if (callCount === 1) return Promise.resolve([fakeWorkspace]);
    return Promise.resolve([fakeAgent]);
  });

  vi.mocked(getDb).mockReturnValue({
    select: () => ({
      from: () => ({
        where: mockWhere,
      }),
    }),
  } as ReturnType<typeof getDb>);
}

describe('POST /v1/dm/group', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbForAgentAuth();
  });

  it('creates a group DM and returns 201', async () => {
    vi.mocked(groupDmEngine.createGroupDm).mockResolvedValue({
      id: 'conv_group_1',
      channel_id: 'ch_group_1',
      dm_type: 'group',
      name: 'My Group',
      participants: [
        { agent_id: 'agent_456' },
        { agent_id: 'agent_789' },
        { agent_id: 'agent_012' },
      ],
      created_at: '2025-01-01T00:00:00.000Z',
    });

    const res = await request(app)
      .post('/v1/dm/group')
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ participants: ['Agent2', 'Agent3'], name: 'My Group' });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.id).toBe('conv_group_1');
    expect(res.body.data.dm_type).toBe('group');
  });

  it('returns 400 when participants missing', async () => {
    const res = await request(app)
      .post('/v1/dm/group')
      .set('Authorization', `Bearer ${agentToken}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_request');
  });
});

describe('POST /v1/dm/:conversation_id/messages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbForAgentAuth();
  });

  it('posts a message to group DM', async () => {
    vi.mocked(groupDmEngine.postGroupMessage).mockResolvedValue({
      id: 'msg_group_1',
      conversation_id: 'conv_group_1',
      agent_id: 'agent_456',
      text: 'Hello group',
      created_at: '2025-01-01T00:00:00.000Z',
    });

    const res = await request(app)
      .post('/v1/dm/conv_group_1/messages')
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ text: 'Hello group' });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.text).toBe('Hello group');
  });

  it('returns 400 when text missing', async () => {
    const res = await request(app)
      .post('/v1/dm/conv_group_1/messages')
      .set('Authorization', `Bearer ${agentToken}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_request');
  });
});

describe('POST /v1/dm/:conversation_id/participants', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbForAgentAuth();
  });

  it('adds a participant', async () => {
    vi.mocked(groupDmEngine.addParticipant).mockResolvedValue({
      conversation_id: 'conv_group_1',
      agent: 'NewBot',
      already_member: false,
    });

    const res = await request(app)
      .post('/v1/dm/conv_group_1/participants')
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ agent: 'NewBot' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.agent).toBe('NewBot');
  });

  it('returns 400 when agent missing', async () => {
    const res = await request(app)
      .post('/v1/dm/conv_group_1/participants')
      .set('Authorization', `Bearer ${agentToken}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_request');
  });
});

describe('DELETE /v1/dm/:conversation_id/participants/:agent_name', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbForAgentAuth();
  });

  it('removes participant and returns 204', async () => {
    vi.mocked(groupDmEngine.removeParticipant).mockResolvedValue(undefined);

    const res = await request(app)
      .delete('/v1/dm/conv_group_1/participants/TestBot')
      .set('Authorization', `Bearer ${agentToken}`);

    expect(res.status).toBe(204);
  });

  it('returns 403 for non-participant', async () => {
    vi.mocked(groupDmEngine.removeParticipant).mockRejectedValue(
      Object.assign(new Error('Not a participant in this conversation'), {
        code: 'forbidden',
        status: 403,
      }),
    );

    const res = await request(app)
      .delete('/v1/dm/conv_group_1/participants/TestBot')
      .set('Authorization', `Bearer ${agentToken}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('forbidden');
  });
});
