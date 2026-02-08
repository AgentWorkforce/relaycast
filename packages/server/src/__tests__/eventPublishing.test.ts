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

import { app } from '../app.js';
import { publishEvent } from '../ws/pubsub.js';
import { deliverEvent } from '../engine/eventDelivery.js';
import { getChannel, createChannel, archiveChannel } from '../engine/channel.js';
import { postMessage } from '../engine/message.js';
import { postReply } from '../engine/thread.js';
import { addReaction, removeReaction } from '../engine/reaction.js';
import { sendDm } from '../engine/dm.js';
import { postGroupMessage } from '../engine/groupDm.js';
import { completeUpload } from '../engine/file.js';
import { markRead } from '../engine/receipt.js';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getChannel).mockResolvedValue({ id: 'ch_1', name: 'general' } as any);
  vi.mocked(publishEvent).mockResolvedValue(undefined);
  vi.mocked(deliverEvent).mockResolvedValue(undefined);
});

describe('Event Publishing - message.created', () => {
  it('publishes message.created when a message is posted', async () => {
    vi.mocked(postMessage).mockResolvedValue({
      id: 'msg_1', channel_id: 'ch_1', agent_id: 'agent_test1', text: 'hello',
      blocks: null, has_attachments: false, thread_id: null,
      created_at: '2025-01-01T00:00:00.000Z', mentions: [], attachments: [],
    });

    await request(app).post('/v1/channels/general/messages').send({ text: 'hello' });

    // Wait for fire-and-forget
    await new Promise((r) => setTimeout(r, 50));

    expect(vi.mocked(publishEvent)).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'message.created', workspace_id: 'ws_test123', channel_id: 'ch_1' }),
    );
    expect(vi.mocked(deliverEvent)).toHaveBeenCalledWith(
      'ws_test123', 'message.created',
      expect.objectContaining({ id: 'msg_1', text: 'hello', channel_name: 'general' }),
    );
  });
});

describe('Event Publishing - thread.reply', () => {
  it('publishes thread.reply when a reply is posted', async () => {
    vi.mocked(postReply).mockResolvedValue({
      id: 'reply_1', channel_id: 'ch_1', agent_id: 'agent_test1',
      thread_id: 'msg_parent', text: 'reply text',
      has_attachments: false, created_at: '2025-01-01T00:00:00.000Z',
    });

    await request(app).post('/v1/messages/msg_parent/replies').send({ text: 'reply text' });
    await new Promise((r) => setTimeout(r, 50));

    expect(vi.mocked(publishEvent)).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'thread.reply', workspace_id: 'ws_test123', channel_id: 'ch_1' }),
    );
    expect(vi.mocked(deliverEvent)).toHaveBeenCalledWith(
      'ws_test123', 'thread.reply',
      expect.objectContaining({ id: 'reply_1', thread_id: 'msg_parent' }),
    );
  });
});

describe('Event Publishing - reaction.added / reaction.removed', () => {
  it('publishes reaction.added', async () => {
    vi.mocked(addReaction).mockResolvedValue({
      id: 'rxn_1', message_id: 'msg_1', agent_name: 'TestBot',
      emoji: '👍', created_at: '2025-01-01T00:00:00.000Z',
    });

    await request(app).post('/v1/messages/msg_1/reactions').send({ emoji: '👍' });
    await new Promise((r) => setTimeout(r, 50));

    expect(vi.mocked(publishEvent)).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'reaction.added' }),
    );
    expect(vi.mocked(deliverEvent)).toHaveBeenCalledWith(
      'ws_test123', 'reaction.added', expect.objectContaining({ emoji: '👍' }),
    );
  });

  it('publishes reaction.removed', async () => {
    vi.mocked(removeReaction).mockResolvedValue(true);

    await request(app).delete('/v1/messages/msg_1/reactions/👍');
    await new Promise((r) => setTimeout(r, 50));

    expect(vi.mocked(publishEvent)).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'reaction.removed' }),
    );
    expect(vi.mocked(deliverEvent)).toHaveBeenCalledWith(
      'ws_test123', 'reaction.removed',
      expect.objectContaining({ message_id: 'msg_1', emoji: '👍' }),
    );
  });
});

describe('Event Publishing - channel.created / channel.archived', () => {
  it('publishes channel.created', async () => {
    vi.mocked(createChannel).mockResolvedValue({
      id: 'ch_new', name: 'alerts', topic: null,
      created_by: 'agent_test1', created_at: '2025-01-01T00:00:00.000Z',
      member_count: 1,
    });

    await request(app).post('/v1/channels').send({ name: 'alerts' });
    await new Promise((r) => setTimeout(r, 50));

    expect(vi.mocked(publishEvent)).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'channel.created' }),
    );
    expect(vi.mocked(deliverEvent)).toHaveBeenCalledWith(
      'ws_test123', 'channel.created',
      expect.objectContaining({ channel_name: 'alerts' }),
    );
  });

  it('publishes channel.archived', async () => {
    vi.mocked(archiveChannel).mockResolvedValue(true);

    await request(app).delete('/v1/channels/old-channel');
    await new Promise((r) => setTimeout(r, 50));

    expect(vi.mocked(publishEvent)).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'channel.archived' }),
    );
    expect(vi.mocked(deliverEvent)).toHaveBeenCalledWith(
      'ws_test123', 'channel.archived',
      expect.objectContaining({ channel_name: 'old-channel' }),
    );
  });
});

describe('Event Publishing - dm.received', () => {
  it('publishes dm.received', async () => {
    vi.mocked(sendDm).mockResolvedValue({
      id: 'dm_1', conversation_id: 'conv_1',
      from_agent_id: 'agent_test1', to: 'OtherBot',
      text: 'hi there', created_at: '2025-01-01T00:00:00.000Z',
    });

    await request(app).post('/v1/dm').send({ to: 'OtherBot', text: 'hi there' });
    await new Promise((r) => setTimeout(r, 50));

    expect(vi.mocked(publishEvent)).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'dm.received' }),
    );
    expect(vi.mocked(deliverEvent)).toHaveBeenCalledWith(
      'ws_test123', 'dm.received',
      expect.objectContaining({ to: 'OtherBot' }),
    );
  });
});

describe('Event Publishing - group_dm.received', () => {
  it('publishes group_dm.received', async () => {
    vi.mocked(postGroupMessage).mockResolvedValue({
      id: 'gdm_1', conversation_id: 'conv_g1',
      agent_id: 'agent_test1', text: 'team msg',
      created_at: '2025-01-01T00:00:00.000Z',
    });

    await request(app).post('/v1/dm/conv_g1/messages').send({ text: 'team msg' });
    await new Promise((r) => setTimeout(r, 50));

    expect(vi.mocked(publishEvent)).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'group_dm.received' }),
    );
    expect(vi.mocked(deliverEvent)).toHaveBeenCalledWith(
      'ws_test123', 'group_dm.received',
      expect.objectContaining({ text: 'team msg' }),
    );
  });
});

describe('Event Publishing - file.uploaded', () => {
  it('publishes file.uploaded on complete', async () => {
    vi.mocked(completeUpload).mockResolvedValue({
      id: 'file_1', download_url: 'https://s3.example.com/file',
      filename: 'report.pdf', content_type: 'application/pdf',
      size_bytes: 1024,
    });

    await request(app).post('/v1/files/file_1/complete');
    await new Promise((r) => setTimeout(r, 50));

    expect(vi.mocked(publishEvent)).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'file.uploaded' }),
    );
    expect(vi.mocked(deliverEvent)).toHaveBeenCalledWith(
      'ws_test123', 'file.uploaded',
      expect.objectContaining({ filename: 'report.pdf' }),
    );
  });
});

describe('Event Publishing - message.read', () => {
  it('publishes message.read', async () => {
    vi.mocked(markRead).mockResolvedValue({
      message_id: 'msg_1', agent_id: 'agent_test1',
      read_at: '2025-01-01T00:00:00.000Z',
    });

    await request(app).post('/v1/messages/msg_1/read');
    await new Promise((r) => setTimeout(r, 50));

    expect(vi.mocked(publishEvent)).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'message.read' }),
    );
    expect(vi.mocked(deliverEvent)).toHaveBeenCalledWith(
      'ws_test123', 'message.read',
      expect.objectContaining({ message_id: 'msg_1' }),
    );
  });
});

describe('Event Publishing - does not publish on failure', () => {
  it('does not publish when engine call fails', async () => {
    vi.mocked(postMessage).mockRejectedValue(new Error('DB error'));

    await request(app).post('/v1/channels/general/messages').send({ text: 'hello' });
    await new Promise((r) => setTimeout(r, 50));

    expect(vi.mocked(publishEvent)).not.toHaveBeenCalled();
    expect(vi.mocked(deliverEvent)).not.toHaveBeenCalled();
  });

  it('does not publish when validation fails', async () => {
    await request(app).post('/v1/channels/general/messages').send({});
    await new Promise((r) => setTimeout(r, 50));

    expect(vi.mocked(publishEvent)).not.toHaveBeenCalled();
    expect(vi.mocked(deliverEvent)).not.toHaveBeenCalled();
  });
});
