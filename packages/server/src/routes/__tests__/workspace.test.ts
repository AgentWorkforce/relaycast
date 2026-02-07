import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

// Mock engine and DB before importing app
vi.mock('../../engine/workspace.js', () => ({
  createWorkspace: vi.fn(),
  getWorkspace: vi.fn(),
  updateWorkspace: vi.fn(),
  deleteWorkspace: vi.fn(),
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
import * as workspaceEngine from '../../engine/workspace.js';
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

describe('POST /v1/workspaces', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a workspace and returns 201', async () => {
    vi.mocked(workspaceEngine.createWorkspace).mockResolvedValue({
      workspace_id: 'ws_456',
      api_key: 'rk_live_newkey123',
      created_at: '2025-01-01T00:00:00.000Z',
    });

    const res = await request(app)
      .post('/v1/workspaces')
      .send({ name: 'my-project' });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.workspace_id).toBe('ws_456');
    expect(res.body.data.api_key).toContain('rk_live_');
  });

  it('returns 400 when name is missing', async () => {
    const res = await request(app).post('/v1/workspaces').send({});
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('invalid_request');
  });

  it('returns 409 for duplicate workspace name', async () => {
    vi.mocked(workspaceEngine.createWorkspace).mockRejectedValue(
      Object.assign(new Error('Workspace "my-project" already exists'), {
        code: 'workspace_already_exists',
        status: 409,
      }),
    );

    const res = await request(app)
      .post('/v1/workspaces')
      .send({ name: 'my-project' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('workspace_already_exists');
  });
});

describe('GET /v1/workspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbForAuth();
  });

  it('returns workspace data with valid key', async () => {
    vi.mocked(workspaceEngine.getWorkspace).mockResolvedValue({
      id: 'ws_123',
      name: 'test-workspace',
      plan: 'free',
      system_prompt: null,
      created_at: '2025-01-01T00:00:00.000Z',
      metadata: {},
    });

    const res = await request(app)
      .get('/v1/workspace')
      .set('Authorization', `Bearer ${apiKey}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.name).toBe('test-workspace');
  });

  it('returns 401 without auth', async () => {
    const res = await request(app).get('/v1/workspace');
    expect(res.status).toBe(401);
  });
});

describe('PATCH /v1/workspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbForAuth();
  });

  it('updates workspace', async () => {
    vi.mocked(workspaceEngine.updateWorkspace).mockResolvedValue({
      id: 'ws_123',
      name: 'new-name',
      plan: 'free',
      system_prompt: null,
      created_at: '2025-01-01T00:00:00.000Z',
      metadata: {},
    });

    const res = await request(app)
      .patch('/v1/workspace')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ name: 'new-name' });
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('new-name');
  });
});

describe('DELETE /v1/workspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbForAuth();
  });

  it('deletes workspace and returns 204', async () => {
    vi.mocked(workspaceEngine.deleteWorkspace).mockResolvedValue(undefined);

    const res = await request(app)
      .delete('/v1/workspace')
      .set('Authorization', `Bearer ${apiKey}`);
    expect(res.status).toBe(204);
  });
});
