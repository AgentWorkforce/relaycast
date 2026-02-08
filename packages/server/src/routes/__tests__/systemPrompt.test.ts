import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

vi.mock('../../engine/systemPrompt.js', () => ({
  getSystemPrompt: vi.fn(),
  setSystemPrompt: vi.fn(),
}));

vi.mock('../../engine/workspace.js', () => ({
  createWorkspace: vi.fn(),
  getWorkspace: vi.fn(),
  updateWorkspace: vi.fn(),
  deleteWorkspace: vi.fn(),
}));

vi.mock('../../engine/agent.js', () => ({
  registerAgent: vi.fn(),
  listAgents: vi.fn(),
  getAgentByName: vi.fn(),
  updateAgent: vi.fn(),
  deleteAgent: vi.fn(),
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

vi.mock('../../engine/message.js', () => ({
  postMessage: vi.fn(),
  getMessages: vi.fn(),
  getMessage: vi.fn(),
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

vi.mock('../../engine/presence.js', () => ({
  getPresence: vi.fn(),
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

vi.mock('../../ws/pubsub.js', () => ({
  publishEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../engine/eventDelivery.js', () => ({
  deliverEvent: vi.fn().mockResolvedValue(undefined),
}));

import { app } from '../../app.js';
import * as systemPromptEngine from '../../engine/systemPrompt.js';
import { getDb } from '../../db/index.js';
import { hashToken } from '../../middleware/auth.js';
import crypto from 'node:crypto';

const workspaceKey = `rk_live_${crypto.randomBytes(16).toString('hex')}`;
const workspaceKeyHash = hashToken(workspaceKey);
const agentToken = `at_live_${crypto.randomBytes(16).toString('hex')}`;
const agentTokenHash = hashToken(agentToken);

const fakeWorkspace = {
  id: 'ws_123',
  name: 'test-workspace',
  apiKeyHash: workspaceKeyHash,
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
  const mockSelect = vi.fn();
  const mockFrom = vi.fn();
  const mockWhere = vi.fn();
  let callCount = 0;
  mockWhere.mockImplementation(() => {
    callCount++;
    if (callCount === 1) return Promise.resolve([fakeAgent]);
    return Promise.resolve([fakeWorkspace]);
  });
  mockFrom.mockReturnValue({ where: mockWhere });
  mockSelect.mockReturnValue({ from: mockFrom });
  vi.mocked(getDb).mockReturnValue({
    select: mockSelect,
  } as ReturnType<typeof getDb>);
}

describe('GET /v1/workspace/system-prompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns default prompt with workspace key auth', async () => {
    mockDbForWorkspaceAuth();
    vi.mocked(systemPromptEngine.getSystemPrompt).mockResolvedValue({
      prompt: 'You are an AI agent in a collaborative workspace.',
      is_default: true,
    });

    const res = await request(app)
      .get('/v1/workspace/system-prompt')
      .set('Authorization', `Bearer ${workspaceKey}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.prompt).toBe('You are an AI agent in a collaborative workspace.');
    expect(res.body.data.is_default).toBe(true);
  });

  it('works with agent token', async () => {
    mockDbForAgentAuth();
    vi.mocked(systemPromptEngine.getSystemPrompt).mockResolvedValue({
      prompt: 'Custom prompt',
      is_default: false,
    });

    const res = await request(app)
      .get('/v1/workspace/system-prompt')
      .set('Authorization', `Bearer ${agentToken}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.prompt).toBe('Custom prompt');
    expect(res.body.data.is_default).toBe(false);
  });

  it('returns 401 without auth', async () => {
    const res = await request(app).get('/v1/workspace/system-prompt');
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
  });
});

describe('PUT /v1/workspace/system-prompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbForWorkspaceAuth();
  });

  it('sets custom prompt', async () => {
    vi.mocked(systemPromptEngine.setSystemPrompt).mockResolvedValue({
      prompt: 'You are a helpful coding assistant.',
      is_default: false,
    });

    const res = await request(app)
      .put('/v1/workspace/system-prompt')
      .set('Authorization', `Bearer ${workspaceKey}`)
      .send({ prompt: 'You are a helpful coding assistant.' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.prompt).toBe('You are a helpful coding assistant.');
    expect(res.body.data.is_default).toBe(false);
    expect(systemPromptEngine.setSystemPrompt).toHaveBeenCalledWith(
      'ws_123',
      'You are a helpful coding assistant.',
    );
  });

  it('returns 400 for invalid prompt', async () => {
    const res = await request(app)
      .put('/v1/workspace/system-prompt')
      .set('Authorization', `Bearer ${workspaceKey}`)
      .send({ prompt: 123 });

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('invalid_request');
  });

  it('reset=true resets to default', async () => {
    vi.mocked(systemPromptEngine.setSystemPrompt).mockResolvedValue({
      prompt: 'You are an AI agent in a collaborative workspace.',
      is_default: true,
    });

    const res = await request(app)
      .put('/v1/workspace/system-prompt')
      .set('Authorization', `Bearer ${workspaceKey}`)
      .send({ reset: true });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.is_default).toBe(true);
    expect(systemPromptEngine.setSystemPrompt).toHaveBeenCalledWith('ws_123', null);
  });

  it('prompt=null resets to default', async () => {
    vi.mocked(systemPromptEngine.setSystemPrompt).mockResolvedValue({
      prompt: 'You are an AI agent in a collaborative workspace.',
      is_default: true,
    });

    const res = await request(app)
      .put('/v1/workspace/system-prompt')
      .set('Authorization', `Bearer ${workspaceKey}`)
      .send({ prompt: null });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.is_default).toBe(true);
    expect(systemPromptEngine.setSystemPrompt).toHaveBeenCalledWith('ws_123', null);
  });

  it('returns 401 with agent token', async () => {
    mockDbForAgentAuth();

    const res = await request(app)
      .put('/v1/workspace/system-prompt')
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ prompt: 'hacked' });

    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
  });
});
