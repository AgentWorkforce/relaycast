import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

// Mock ALL engines that app.ts imports
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
import * as billingEngine from '../../engine/billing.js';
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
  stripeCustomerId: 'cus_abc',
  stripeSubscriptionId: 'sub_abc',
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
          if (callCount % 2 === 1) return Promise.resolve([fakeAgent]);
          return Promise.resolve([fakeWorkspace]);
        }),
      }),
    }),
  } as ReturnType<typeof getDb>);
}

describe('POST /v1/billing/subscribe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbForWorkspaceAuth();
  });

  it('creates subscription and returns 201', async () => {
    vi.mocked(billingEngine.subscribe).mockResolvedValue({
      subscription_id: 'sub_new',
      plan: 'pro',
      status: 'active',
      current_period_end: '2025-02-01T00:00:00.000Z',
    });

    const res = await request(app)
      .post('/v1/billing/subscribe')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ plan: 'pro', payment_method: 'pm_123' });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.plan).toBe('pro');
    expect(billingEngine.subscribe).toHaveBeenCalledWith('ws_123', 'pro', 'pm_123');
  });

  it('returns 400 for invalid plan', async () => {
    const res = await request(app)
      .post('/v1/billing/subscribe')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ plan: 'invalid', payment_method: 'pm_123' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_request');
  });

  it('returns 400 for missing payment_method', async () => {
    const res = await request(app)
      .post('/v1/billing/subscribe')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ plan: 'pro' });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('payment_method');
  });

  it('returns 401 without auth', async () => {
    const res = await request(app)
      .post('/v1/billing/subscribe')
      .send({ plan: 'pro', payment_method: 'pm_123' });

    expect(res.status).toBe(401);
  });

  it('returns 401 with agent token', async () => {
    mockDbForAgentAuth();
    const res = await request(app)
      .post('/v1/billing/subscribe')
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ plan: 'pro', payment_method: 'pm_123' });

    expect(res.status).toBe(401);
  });
});

describe('GET /v1/billing/subscription', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbForWorkspaceAuth();
  });

  it('returns subscription data', async () => {
    vi.mocked(billingEngine.getSubscription).mockResolvedValue({
      plan: 'pro',
      status: 'active',
      current_period_end: '2025-02-01T00:00:00.000Z',
      usage_this_period: { messages_sent: 100, api_calls: 50, files_uploaded: 2, file_bytes: 1024, ws_minutes: 10 },
    });

    const res = await request(app)
      .get('/v1/billing/subscription')
      .set('Authorization', `Bearer ${apiKey}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.plan).toBe('pro');
  });

  it('returns 401 without auth', async () => {
    const res = await request(app).get('/v1/billing/subscription');
    expect(res.status).toBe(401);
  });
});

describe('GET /v1/billing/usage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbForWorkspaceAuth();
  });

  it('returns usage for current period', async () => {
    vi.mocked(billingEngine.getUsage).mockResolvedValue({
      messages_sent: 500,
      api_calls: 200,
      files_uploaded: 3,
      file_bytes: 2048,
      ws_minutes: 15,
      period_start: '2025-01-01T00:00:00.000Z',
      period_end: '2025-02-01T00:00:00.000Z',
    });

    const res = await request(app)
      .get('/v1/billing/usage')
      .set('Authorization', `Bearer ${apiKey}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.messages_sent).toBe(500);
  });

  it('returns 400 for invalid period', async () => {
    const res = await request(app)
      .get('/v1/billing/usage?period=invalid')
      .set('Authorization', `Bearer ${apiKey}`);

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('period');
  });
});

describe('GET /v1/billing/invoices', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbForWorkspaceAuth();
  });

  it('lists invoices', async () => {
    vi.mocked(billingEngine.getInvoices).mockResolvedValue([
      { id: 'in_1', amount: 2999, currency: 'usd', status: 'paid', period_start: '2025-01-01', period_end: '2025-02-01', pdf_url: 'https://example.com/inv.pdf' },
    ]);

    const res = await request(app)
      .get('/v1/billing/invoices')
      .set('Authorization', `Bearer ${apiKey}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  it('defaults limit to 10', async () => {
    vi.mocked(billingEngine.getInvoices).mockResolvedValue([]);

    await request(app)
      .get('/v1/billing/invoices')
      .set('Authorization', `Bearer ${apiKey}`);

    expect(billingEngine.getInvoices).toHaveBeenCalledWith('cus_abc', 10);
  });

  it('returns 400 for invalid limit', async () => {
    const res = await request(app)
      .get('/v1/billing/invoices?limit=-1')
      .set('Authorization', `Bearer ${apiKey}`);

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('limit');
  });
});

describe('POST /v1/billing/portal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbForWorkspaceAuth();
  });

  it('creates portal session', async () => {
    vi.mocked(billingEngine.createPortalSession).mockResolvedValue({
      url: 'https://billing.example.com/session/123',
    });

    const res = await request(app)
      .post('/v1/billing/portal')
      .set('Authorization', `Bearer ${apiKey}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.url).toContain('billing.example.com');
  });
});
