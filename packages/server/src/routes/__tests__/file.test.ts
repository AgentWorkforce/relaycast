import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

vi.mock('../../engine/file.js', () => ({
  createUpload: vi.fn(),
  completeUpload: vi.fn(),
  getFile: vi.fn(),
  deleteFile: vi.fn(),
  listFiles: vi.fn(),
}));

vi.mock('../../engine/receipt.js', () => ({
  markRead: vi.fn(),
  getReaders: vi.fn(),
  getReadStatus: vi.fn(),
}));

vi.mock('../../engine/reaction.js', () => ({
  addReaction: vi.fn(),
  removeReaction: vi.fn(),
  getReactions: vi.fn(),
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

vi.mock('../../engine/search.js', () => ({
  searchMessages: vi.fn(),
}));

vi.mock('../../engine/inbox.js', () => ({
  getInbox: vi.fn(),
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
import * as fileEngine from '../../engine/file.js';
import { getDb } from '../../db/index.js';
import { hashToken } from '../../middleware/auth.js';
import crypto from 'node:crypto';

const agentToken = `at_live_${crypto.randomBytes(16).toString('hex')}`;
const agentTokenHash = hashToken(agentToken);
const workspaceKey = `rk_live_${crypto.randomBytes(16).toString('hex')}`;
const workspaceKeyHash = hashToken(workspaceKey);

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

function mockDbForWorkspaceAuth() {
  const mockSelect = vi.fn();
  const mockFrom = vi.fn();
  const mockWhere = vi.fn();
  mockWhere.mockResolvedValue([fakeWorkspace]);
  mockFrom.mockReturnValue({ where: mockWhere });
  mockSelect.mockReturnValue({ from: mockFrom });
  vi.mocked(getDb).mockReturnValue({
    select: mockSelect,
  } as ReturnType<typeof getDb>);
}

describe('POST /v1/files/upload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbForAgentAuth();
  });

  it('returns 201 with upload URL', async () => {
    vi.mocked(fileEngine.createUpload).mockResolvedValue({
      id: 'file_001',
      upload_url: 'https://minio.local/presigned-put',
      expires_at: '2025-01-01T01:00:00.000Z',
    });

    const res = await request(app)
      .post('/v1/files/upload')
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ filename: 'test.png', content_type: 'image/png', size_bytes: 1024 });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.id).toBe('file_001');
    expect(res.body.data.upload_url).toBe('https://minio.local/presigned-put');
  });

  it('returns 400 when filename missing', async () => {
    const res = await request(app)
      .post('/v1/files/upload')
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ content_type: 'image/png', size_bytes: 1024 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_request');
  });

  it('returns 400 when content_type missing', async () => {
    const res = await request(app)
      .post('/v1/files/upload')
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ filename: 'test.png', size_bytes: 1024 });

    expect(res.status).toBe(400);
  });

  it('returns 400 when size_bytes missing', async () => {
    const res = await request(app)
      .post('/v1/files/upload')
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ filename: 'test.png', content_type: 'image/png' });

    expect(res.status).toBe(400);
  });

  it('returns 401 without auth', async () => {
    const res = await request(app)
      .post('/v1/files/upload')
      .send({ filename: 'test.png', content_type: 'image/png', size_bytes: 1024 });

    expect(res.status).toBe(401);
  });
});

describe('POST /v1/files/:id/complete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbForAgentAuth();
  });

  it('returns 200 on success', async () => {
    vi.mocked(fileEngine.completeUpload).mockResolvedValue({
      id: 'file_001',
      download_url: 'https://minio.local/presigned-get',
      filename: 'test.png',
      content_type: 'image/png',
      size_bytes: 1024,
    });

    const res = await request(app)
      .post('/v1/files/file_001/complete')
      .set('Authorization', `Bearer ${agentToken}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.download_url).toBe('https://minio.local/presigned-get');
  });

  it('returns 404 when file not found', async () => {
    vi.mocked(fileEngine.completeUpload).mockResolvedValue(null);

    const res = await request(app)
      .post('/v1/files/file_999/complete')
      .set('Authorization', `Bearer ${agentToken}`)
      .send({});

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('file_not_found');
  });
});

describe('GET /v1/files/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 200 with file metadata', async () => {
    mockDbForAgentAuth();
    vi.mocked(fileEngine.getFile).mockResolvedValue({
      id: 'file_001',
      filename: 'test.png',
      content_type: 'image/png',
      size_bytes: 1024,
      status: 'complete',
      uploaded_by: 'TestBot',
      download_url: 'https://minio.local/presigned-get',
      created_at: '2025-01-01T00:00:00.000Z',
    });

    const res = await request(app)
      .get('/v1/files/file_001')
      .set('Authorization', `Bearer ${agentToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.filename).toBe('test.png');
  });

  it('returns 404 when file not found', async () => {
    mockDbForAgentAuth();
    vi.mocked(fileEngine.getFile).mockResolvedValue(null);

    const res = await request(app)
      .get('/v1/files/file_999')
      .set('Authorization', `Bearer ${agentToken}`);

    expect(res.status).toBe(404);
  });

  it('works with workspace key', async () => {
    mockDbForWorkspaceAuth();
    vi.mocked(fileEngine.getFile).mockResolvedValue({
      id: 'file_001',
      filename: 'test.png',
      content_type: 'image/png',
      size_bytes: 1024,
      status: 'complete',
      uploaded_by: 'TestBot',
      download_url: 'https://minio.local/presigned-get',
      created_at: '2025-01-01T00:00:00.000Z',
    });

    const res = await request(app)
      .get('/v1/files/file_001')
      .set('Authorization', `Bearer ${workspaceKey}`);

    expect(res.status).toBe(200);
  });
});

describe('DELETE /v1/files/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbForAgentAuth();
  });

  it('returns 204 on success', async () => {
    vi.mocked(fileEngine.deleteFile).mockResolvedValue(true);

    const res = await request(app)
      .delete('/v1/files/file_001')
      .set('Authorization', `Bearer ${agentToken}`);

    expect(res.status).toBe(204);
  });

  it('returns 404 when file not found', async () => {
    vi.mocked(fileEngine.deleteFile).mockResolvedValue(null);

    const res = await request(app)
      .delete('/v1/files/file_999')
      .set('Authorization', `Bearer ${agentToken}`);

    expect(res.status).toBe(404);
  });

  it('returns 403 when not the file owner', async () => {
    vi.mocked(fileEngine.deleteFile).mockResolvedValue('forbidden');

    const res = await request(app)
      .delete('/v1/files/file_001')
      .set('Authorization', `Bearer ${agentToken}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('forbidden');
  });
});

describe('GET /v1/files', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 200 with file list', async () => {
    mockDbForAgentAuth();
    vi.mocked(fileEngine.listFiles).mockResolvedValue([
      {
        id: 'file_001',
        filename: 'test.png',
        content_type: 'image/png',
        size_bytes: 1024,
        status: 'complete',
        created_at: '2025-01-01T00:00:00.000Z',
      },
    ]);

    const res = await request(app)
      .get('/v1/files')
      .set('Authorization', `Bearer ${agentToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  it('works with workspace key', async () => {
    mockDbForWorkspaceAuth();
    vi.mocked(fileEngine.listFiles).mockResolvedValue([]);

    const res = await request(app)
      .get('/v1/files')
      .set('Authorization', `Bearer ${workspaceKey}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
});
