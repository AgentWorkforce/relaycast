import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

const fakeWorkspace = {
  id: 'ws_test123',
  name: 'test',
  apiKeyHash: 'hash_test',
  plan: 'free',
  systemPrompt: null,
  stripeCustomerId: null,
  stripeSubscriptionId: null,
  createdAt: new Date(),
  metadata: {},
};

const fakeAgent = {
  id: 'agent_test1',
  workspaceId: 'ws_test123',
  name: 'TestBot',
  type: 'agent',
  tokenHash: 'hash_test',
  status: 'online',
  persona: null,
  metadata: {},
  createdAt: new Date(),
  lastSeen: new Date(),
};

// Mock all engines
vi.mock('../engine/workspace.js', () => ({
  createWorkspace: vi.fn(),
  getWorkspace: vi.fn(),
  updateWorkspace: vi.fn(),
  deleteWorkspace: vi.fn(),
}));

vi.mock('../engine/message.js', () => ({
  postMessage: vi.fn(),
  getMessages: vi.fn(),
  getMessage: vi.fn(),
}));

vi.mock('../engine/channel.js', () => ({
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

vi.mock('../engine/agent.js', () => ({
  registerAgent: vi.fn(),
  listAgents: vi.fn(),
  getAgentByName: vi.fn(),
  updateAgent: vi.fn(),
  deleteAgent: vi.fn(),
}));

vi.mock('../engine/thread.js', () => ({
  postReply: vi.fn(),
  getThread: vi.fn(),
}));

vi.mock('../engine/dm.js', () => ({
  sendDm: vi.fn(),
  listConversations: vi.fn(),
  getDmMessages: vi.fn(),
}));

vi.mock('../engine/groupDm.js', () => ({
  createGroupDm: vi.fn(),
  postGroupMessage: vi.fn(),
  addParticipant: vi.fn(),
  removeParticipant: vi.fn(),
}));

vi.mock('../engine/reaction.js', () => ({
  addReaction: vi.fn(),
  removeReaction: vi.fn(),
  getReactions: vi.fn(),
}));

vi.mock('../engine/search.js', () => ({
  searchMessages: vi.fn(),
}));

vi.mock('../engine/inbox.js', () => ({
  getInbox: vi.fn(),
}));

vi.mock('../engine/receipt.js', () => ({
  markRead: vi.fn(),
  getReaders: vi.fn(),
  getReadStatus: vi.fn(),
}));

vi.mock('../engine/file.js', () => ({
  createUpload: vi.fn(),
  completeUpload: vi.fn(),
  getFile: vi.fn(),
  deleteFile: vi.fn(),
  listFiles: vi.fn(),
}));

vi.mock('../engine/billing.js', () => ({
  subscribe: vi.fn(),
  getSubscription: vi.fn(),
  getUsage: vi.fn(),
  getInvoices: vi.fn(),
  createPortalSession: vi.fn(),
  handleWebhook: vi.fn(),
}));

vi.mock('../engine/systemPrompt.js', () => ({
  getSystemPrompt: vi.fn(),
  setSystemPrompt: vi.fn(),
}));

vi.mock('../engine/presence.js', () => ({
  getPresence: vi.fn(),
}));

vi.mock('../engine/usage.js', () => ({
  incrementUsage: vi.fn(),
  getUsageCounters: vi.fn(),
}));

vi.mock('../engine/webhooks.js', () => ({
  processWebhook: vi.fn(),
}));

vi.mock('../engine/inboundWebhook.js', () => ({
  createWebhook: vi.fn(),
  listWebhooks: vi.fn(),
  getWebhook: vi.fn(),
  deleteWebhook: vi.fn(),
  triggerWebhook: vi.fn(),
}));

vi.mock('../engine/eventSubscription.js', () => ({
  createSubscription: vi.fn(),
  listSubscriptions: vi.fn(),
  getSubscription: vi.fn(),
  deleteSubscription: vi.fn(),
  getActiveSubscriptions: vi.fn(),
}));

vi.mock('../engine/command.js', () => ({
  registerCommand: vi.fn(),
  listCommands: vi.fn(),
  getCommand: vi.fn(),
  deleteCommand: vi.fn(),
  invokeCommand: vi.fn(),
}));

vi.mock('../db/index.js', () => ({
  getDb: vi.fn(),
}));

vi.mock('../redis/index.js', () => ({
  getRedis: vi.fn(() => ({
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
  })),
}));

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (_req: any, _res: any, next: any) => {
    _req.workspace = fakeWorkspace;
    _req.agent = fakeAgent;
    next();
  },
  requireWorkspaceKey: (_req: any, _res: any, next: any) => {
    _req.workspace = fakeWorkspace;
    next();
  },
  requireAgentToken: (_req: any, _res: any, next: any) => {
    _req.workspace = fakeWorkspace;
    _req.agent = fakeAgent;
    next();
  },
  hashToken: vi.fn((t: string) => 'hash_' + t),
}));

vi.mock('../middleware/rateLimit.js', () => ({
  rateLimit: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../middleware/planLimits.js', () => ({
  checkPlanLimit: () => (_req: any, _res: any, next: any) => next(),
  PLAN_LIMITS: {},
}));

vi.mock('../middleware/usageTracker.js', () => ({
  usageTracker: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../middleware/presenceRefresh.js', () => ({
  presenceRefresh: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../ws/pubsub.js', () => ({
  publishEvent: vi.fn(),
}));

vi.mock('../engine/eventDelivery.js', () => ({
  deliverEvent: vi.fn(),
}));

vi.mock('../engine/eventQueue.js', () => ({
  enqueueEvent: vi.fn().mockResolvedValue('evt_mock'),
}));

import { app } from '../app.js';

import { getChannel } from '../engine/channel.js';
import { postMessage, getMessages, getMessage } from '../engine/message.js';
import {
  createWebhook,
  listWebhooks,
  deleteWebhook,
  triggerWebhook,
} from '../engine/inboundWebhook.js';
import {
  createSubscription,
  listSubscriptions,
  getSubscription as getEventSub,
  deleteSubscription,
} from '../engine/eventSubscription.js';
import {
  registerCommand,
  listCommands,
  deleteCommand,
  invokeCommand,
} from '../engine/command.js';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getChannel).mockReset().mockResolvedValue({ id: 'ch_1', name: 'general' } as any);
});

// ===========================
// Inbound Webhooks
// ===========================
describe('Inbound Webhooks', () => {
  it('POST /v1/webhooks creates a webhook', async () => {
    vi.mocked(createWebhook).mockResolvedValue({
      webhook_id: 'wh_123',
      name: 'github-deploys',
      channel: 'deploys',
      url: '/v1/hooks/wh_123',
      is_active: true,
      created_at: '2025-01-01T00:00:00.000Z',
    });

    const res = await request(app)
      .post('/v1/webhooks')
      .send({ name: 'github-deploys', channel: 'deploys' });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.webhook_id).toBe('wh_123');
    expect(res.body.data.url).toBe('/v1/hooks/wh_123');
  });

  it('POST /v1/webhooks returns 400 without name', async () => {
    const res = await request(app)
      .post('/v1/webhooks')
      .send({ channel: 'deploys' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_request');
  });

  it('POST /v1/webhooks returns 400 without channel', async () => {
    const res = await request(app)
      .post('/v1/webhooks')
      .send({ name: 'test' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_request');
  });

  it('POST /v1/webhooks returns 404 when channel not found', async () => {
    vi.mocked(getChannel).mockResolvedValueOnce(null);

    const res = await request(app)
      .post('/v1/webhooks')
      .send({ name: 'test', channel: 'nonexistent' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('channel_not_found');
  });

  it('GET /v1/webhooks lists webhooks', async () => {
    vi.mocked(listWebhooks).mockResolvedValue([
      {
        id: 'wh_1',
        name: 'hook1',
        channel: 'general',
        url: '/v1/hooks/wh_1',
        is_active: true,
        created_at: '2025-01-01T00:00:00.000Z',
      },
    ]);

    const res = await request(app).get('/v1/webhooks');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe('hook1');
  });

  it('DELETE /v1/webhooks/:id deletes a webhook', async () => {
    vi.mocked(deleteWebhook).mockResolvedValue(true);

    const res = await request(app).delete('/v1/webhooks/wh_123');

    expect(res.status).toBe(204);
  });

  it('DELETE /v1/webhooks/:id returns 404 when not found', async () => {
    vi.mocked(deleteWebhook).mockResolvedValue(false);

    const res = await request(app).delete('/v1/webhooks/wh_nonexist');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('webhook_not_found');
  });

  it('POST /v1/hooks/:webhookId triggers a webhook', async () => {
    vi.mocked(triggerWebhook).mockResolvedValue({
      message_id: 'msg_1',
      channel: 'deploys',
      text: 'Deploy completed',
      created_at: '2025-01-01T00:00:00.000Z',
    });

    const res = await request(app)
      .post('/v1/hooks/wh_123')
      .send({ text: 'Deploy completed' });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.message_id).toBe('msg_1');
  });

  it('POST /v1/hooks/:webhookId returns 404 for invalid webhook', async () => {
    vi.mocked(triggerWebhook).mockResolvedValue(null);

    const res = await request(app)
      .post('/v1/hooks/wh_invalid')
      .send({ text: 'test' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('webhook_not_found');
  });

  it('POST /v1/hooks/:webhookId works with payload instead of text', async () => {
    vi.mocked(triggerWebhook).mockResolvedValue({
      message_id: 'msg_2',
      channel: 'deploys',
      text: 'Webhook github: {"ref":"main"}',
      created_at: '2025-01-01T00:00:00.000Z',
    });

    const res = await request(app)
      .post('/v1/hooks/wh_123')
      .send({ source: 'github', payload: { ref: 'main' } });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.message_id).toBe('msg_2');
  });
});

// ===========================
// Rich Message Blocks
// ===========================
describe('Rich Message Blocks', () => {
  it('POST /v1/channels/:name/messages accepts blocks', async () => {
    const blocks = [
      { type: 'header', text: 'PR #42' },
      { type: 'fields', fields: [{ label: 'Author', value: 'Coder' }] },
      {
        type: 'actions',
        elements: [
          { type: 'button', text: 'Approve', action_id: 'approve', value: '42' },
        ],
      },
    ];

    vi.mocked(postMessage).mockResolvedValue({
      id: 'msg_blocks',
      text: 'PR #42 ready',
      blocks,
    } as any);

    const res = await request(app)
      .post('/v1/channels/general/messages')
      .send({ text: 'PR #42 ready', blocks });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.blocks).toEqual(blocks);

    expect(vi.mocked(postMessage)).toHaveBeenCalledWith(
      fakeWorkspace.id,
      'ch_1',
      fakeAgent.id,
      expect.objectContaining({ text: 'PR #42 ready', blocks }),
    );
  });

  it('POST /v1/channels/:name/messages works without blocks (backward compat)', async () => {
    vi.mocked(postMessage).mockResolvedValue({
      id: 'msg_plain',
      text: 'Hello',
    } as any);

    const res = await request(app)
      .post('/v1/channels/general/messages')
      .send({ text: 'Hello' });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);

    expect(vi.mocked(postMessage)).toHaveBeenCalledWith(
      fakeWorkspace.id,
      'ch_1',
      fakeAgent.id,
      expect.objectContaining({ text: 'Hello' }),
    );
  });

  it('GET /v1/channels/:name/messages returns blocks', async () => {
    vi.mocked(getMessages).mockResolvedValue([
      {
        id: 'msg_1',
        text: 'Hello',
        blocks: [{ type: 'header', text: 'Title' }],
      },
      {
        id: 'msg_2',
        text: 'World',
        blocks: null,
      },
    ] as any);

    const res = await request(app).get('/v1/channels/general/messages');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data[0].blocks).toEqual([{ type: 'header', text: 'Title' }]);
    expect(res.body.data[1].blocks).toBeNull();
  });

  it('GET /v1/messages/:id returns blocks on single message', async () => {
    vi.mocked(getMessage).mockResolvedValue({
      id: 'msg_1',
      text: 'Hello',
      blocks: [{ type: 'divider' }],
    } as any);

    const res = await request(app).get('/v1/messages/msg_1');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.blocks).toEqual([{ type: 'divider' }]);
  });
});

// ===========================
// Outbound Event Subscriptions
// ===========================
describe('Outbound Event Subscriptions', () => {
  it('POST /v1/subscriptions creates a subscription', async () => {
    vi.mocked(createSubscription).mockResolvedValue({
      id: 'sub_1',
      events: ['message.created'],
      filter: { channel: 'alerts' },
      url: 'https://pagerduty.com/webhook/xxx',
      is_active: true,
      created_at: '2025-01-01T00:00:00.000Z',
    });

    const res = await request(app)
      .post('/v1/subscriptions')
      .send({
        events: ['message.created'],
        filter: { channel: 'alerts' },
        url: 'https://pagerduty.com/webhook/xxx',
      });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.id).toBe('sub_1');
    expect(res.body.data.events).toEqual(['message.created']);
  });

  it('POST /v1/subscriptions returns 400 without events', async () => {
    const res = await request(app)
      .post('/v1/subscriptions')
      .send({ url: 'https://example.com' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_request');
  });

  it('POST /v1/subscriptions returns 400 with empty events', async () => {
    const res = await request(app)
      .post('/v1/subscriptions')
      .send({ events: [], url: 'https://example.com' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_request');
  });

  it('POST /v1/subscriptions returns 400 without url', async () => {
    const res = await request(app)
      .post('/v1/subscriptions')
      .send({ events: ['message.created'] });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_request');
  });

  it('GET /v1/subscriptions lists subscriptions', async () => {
    vi.mocked(listSubscriptions).mockResolvedValue([
      {
        id: 'sub_1',
        events: ['message.created'],
        filter: null,
        url: 'https://example.com',
        is_active: true,
        created_at: '2025-01-01T00:00:00.000Z',
      },
    ]);

    const res = await request(app).get('/v1/subscriptions');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toHaveLength(1);
  });

  it('GET /v1/subscriptions/:id returns a subscription', async () => {
    vi.mocked(getEventSub).mockResolvedValue({
      id: 'sub_1',
      events: ['message.created'],
      filter: null,
      url: 'https://example.com',
      is_active: true,
      created_at: '2025-01-01T00:00:00.000Z',
    });

    const res = await request(app).get('/v1/subscriptions/sub_1');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.id).toBe('sub_1');
  });

  it('GET /v1/subscriptions/:id returns 404 when not found', async () => {
    vi.mocked(getEventSub).mockResolvedValue(null);

    const res = await request(app).get('/v1/subscriptions/sub_nonexist');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('subscription_not_found');
  });

  it('DELETE /v1/subscriptions/:id deletes a subscription', async () => {
    vi.mocked(deleteSubscription).mockResolvedValue(true);

    const res = await request(app).delete('/v1/subscriptions/sub_1');

    expect(res.status).toBe(204);
  });

  it('DELETE /v1/subscriptions/:id returns 404 when not found', async () => {
    vi.mocked(deleteSubscription).mockResolvedValue(false);

    const res = await request(app).delete('/v1/subscriptions/sub_nonexist');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('subscription_not_found');
  });
});

// ===========================
// Agent Commands
// ===========================
describe('Agent Commands', () => {
  it('POST /v1/commands registers a command', async () => {
    vi.mocked(registerCommand).mockResolvedValue({
      id: 'cmd_1',
      command: '/deploy',
      description: 'Deploy to env',
      handler_agent: 'DeployBot',
      parameters: [],
      created_at: '2025-01-01T00:00:00.000Z',
    });

    const res = await request(app)
      .post('/v1/commands')
      .send({
        command: '/deploy',
        description: 'Deploy to env',
        handler_agent: 'DeployBot',
      });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.command).toBe('/deploy');
    expect(res.body.data.handler_agent).toBe('DeployBot');
  });

  it('POST /v1/commands returns 400 without command', async () => {
    const res = await request(app)
      .post('/v1/commands')
      .send({ description: 'test', handler_agent: 'Bot' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_request');
  });

  it('POST /v1/commands returns 400 without description', async () => {
    const res = await request(app)
      .post('/v1/commands')
      .send({ command: '/test', handler_agent: 'Bot' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_request');
  });

  it('POST /v1/commands returns 400 without handler_agent', async () => {
    const res = await request(app)
      .post('/v1/commands')
      .send({ command: '/test', description: 'Test' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_request');
  });

  it('POST /v1/commands with parameters', async () => {
    vi.mocked(registerCommand).mockResolvedValue({
      id: 'cmd_2',
      command: '/deploy',
      description: 'Deploy',
      handler_agent: 'DeployBot',
      parameters: [
        { name: 'env', type: 'string', required: true },
      ],
      created_at: '2025-01-01T00:00:00.000Z',
    });

    const res = await request(app)
      .post('/v1/commands')
      .send({
        command: '/deploy',
        description: 'Deploy',
        handler_agent: 'DeployBot',
        parameters: [{ name: 'env', type: 'string', required: true }],
      });

    expect(res.status).toBe(201);
    expect(res.body.data.parameters).toEqual([
      { name: 'env', type: 'string', required: true },
    ]);
  });

  it('GET /v1/commands lists commands', async () => {
    vi.mocked(listCommands).mockResolvedValue([
      {
        id: 'cmd_1',
        command: '/deploy',
        description: 'Deploy',
        handler_agent: 'DeployBot',
        parameters: [],
        is_active: true,
        created_at: '2025-01-01T00:00:00.000Z',
      },
    ]);

    const res = await request(app).get('/v1/commands');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].command).toBe('/deploy');
  });

  it('DELETE /v1/commands/:command deletes a command', async () => {
    vi.mocked(deleteCommand).mockResolvedValue(true);

    const res = await request(app).delete('/v1/commands/deploy');

    expect(res.status).toBe(204);
  });

  it('DELETE /v1/commands/:command returns 404 when not found', async () => {
    vi.mocked(deleteCommand).mockResolvedValue(false);

    const res = await request(app).delete('/v1/commands/nonexist');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('command_not_found');
  });

  it('POST /v1/commands/:command/invoke invokes a command', async () => {
    vi.mocked(invokeCommand).mockResolvedValue({
      id: 'inv_1',
      command: '/deploy',
      channel: 'general',
      invoked_by: fakeAgent.id,
      args: 'prod',
      parameters: null,
      handler_agent_id: 'agent_deploy',
      message_id: 'msg_cmd_1',
      created_at: '2025-01-01T00:00:00.000Z',
    });

    const res = await request(app)
      .post('/v1/commands/deploy/invoke')
      .send({ channel: 'general', args: 'prod' });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.command).toBe('/deploy');
    expect(res.body.data.args).toBe('prod');
  });

  it('POST /v1/commands/:command/invoke returns 400 without channel', async () => {
    const res = await request(app)
      .post('/v1/commands/deploy/invoke')
      .send({ args: 'prod' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_request');
  });

  it('POST /v1/commands/:command/invoke propagates engine 404', async () => {
    vi.mocked(invokeCommand).mockRejectedValue({
      status: 404,
      code: 'command_not_found',
      message: 'Command "/ghost" not found',
    });

    const res = await request(app)
      .post('/v1/commands/ghost/invoke')
      .send({ channel: 'general' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('command_not_found');
  });
});
