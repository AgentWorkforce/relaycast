import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

// Mocks must come before app import (ESM).
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
}));

vi.mock('../engine/systemPrompt.js', () => ({
  getSystemPrompt: vi.fn(),
  setSystemPrompt: vi.fn(),
}));

vi.mock('../engine/presence.js', () => ({
  getPresence: vi.fn(),
  setPresence: vi.fn(),
  removePresence: vi.fn(),
}));

vi.mock('../engine/usage.js', () => ({
  incrementUsage: vi.fn(),
  getUsageCounters: vi.fn(),
  resetUsageCounters: vi.fn(),
  getUsageMetric: vi.fn(),
}));

vi.mock('../engine/webhooks.js', () => ({
  processWebhook: vi.fn(),
  handleSubscriptionUpdated: vi.fn(),
  handleSubscriptionDeleted: vi.fn(),
  handleInvoicePaid: vi.fn(),
  handlePaymentFailed: vi.fn(),
}));

vi.mock('../middleware/auth.js', () => {
  const WORKSPACE_ID = 'ws_test123';
  const WORKSPACE_KEY = 'rk_live_wskey';

  const AGENTS_BY_TOKEN: Record<string, { id: string; name: string }> = {
    at_live_coder: { id: 'agent_coder', name: 'Coder' },
    at_live_reviewer: { id: 'agent_reviewer', name: 'Reviewer' },
    at_live_manager: { id: 'agent_manager', name: 'Manager' },
  };

  function extractBearer(req: any): string | null {
    const header = req?.headers?.authorization;
    if (!header || typeof header !== 'string') return null;
    if (!header.startsWith('Bearer ')) return null;
    return header.slice('Bearer '.length);
  }

  function attachWorkspace(req: any) {
    req.workspace = {
      id: WORKSPACE_ID,
      plan: 'free',
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      apiKeyHash: 'hash_' + WORKSPACE_KEY,
    };
  }

  function attachAgent(req: any, token: string) {
    const a = AGENTS_BY_TOKEN[token];
    if (!a) return;
    req.agent = {
      id: a.id,
      name: a.name,
      workspaceId: WORKSPACE_ID,
      status: 'active',
    };
  }

  return {
    hashToken: vi.fn((t: string) => 'hash_' + t),

    requireWorkspaceKey: async (req: any, res: any, next: any) => {
      const token = extractBearer(req);
      if (!token || !token.startsWith('rk_live_')) {
        res.status(401).json({
          ok: false,
          error: { code: 'unauthorized', message: 'Workspace key required' },
        });
        return;
      }
      attachWorkspace(req);
      next();
    },

    requireAuth: async (req: any, res: any, next: any) => {
      const token = extractBearer(req);
      if (!token) {
        res.status(401).json({
          ok: false,
          error: { code: 'unauthorized', message: 'Missing Authorization' },
        });
        return;
      }
      if (token.startsWith('rk_live_')) {
        attachWorkspace(req);
        next();
        return;
      }
      if (token.startsWith('at_live_')) {
        attachWorkspace(req);
        attachAgent(req, token);
        next();
        return;
      }
      res.status(401).json({
        ok: false,
        error: { code: 'unauthorized', message: 'Invalid token' },
      });
    },

    requireAgentToken: async (req: any, res: any, next: any) => {
      const token = extractBearer(req);
      if (!token || !token.startsWith('at_live_')) {
        res.status(401).json({
          ok: false,
          error: { code: 'unauthorized', message: 'Agent token required' },
        });
        return;
      }
      attachWorkspace(req);
      attachAgent(req, token);
      if (!req.agent) {
        res.status(401).json({
          ok: false,
          error: { code: 'unauthorized', message: 'Invalid agent token' },
        });
        return;
      }
      next();
    },
  };
});

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

import { createWorkspace, deleteWorkspace } from '../engine/workspace.js';
import { registerAgent, listAgents } from '../engine/agent.js';
import {
  createChannel,
  joinChannel,
  archiveChannel,
  getChannel,
} from '../engine/channel.js';
import { postMessage, getMessages } from '../engine/message.js';
import { postReply, getThread } from '../engine/thread.js';
import { sendDm, listConversations } from '../engine/dm.js';
import { createGroupDm, postGroupMessage } from '../engine/groupDm.js';
import { addReaction, getReactions } from '../engine/reaction.js';
import { searchMessages } from '../engine/search.js';
import { getInbox } from '../engine/inbox.js';
import { createUpload, completeUpload } from '../engine/file.js';
import { markRead, getReaders } from '../engine/receipt.js';
import { getSystemPrompt, setSystemPrompt } from '../engine/systemPrompt.js';
import { getPresence } from '../engine/presence.js';
import { getUsage } from '../engine/billing.js';

describe('E2E Lifecycle', () => {
  const workspaceId = 'ws_test123';
  const workspaceKey = 'rk_live_wskey';
  const coderToken = 'at_live_coder';

  let agentTokens: Record<string, string> = {};
  let channelId = 'ch_code_review';
  let messageId = '144115188075855872';
  let dmConversationId = '2001';
  let groupConversationId = '3001';
  let fileId = '4001';

  beforeEach(() => {
    vi.clearAllMocks();
    agentTokens = {};
    channelId = 'ch_code_review';
    messageId = '144115188075855872';
    dmConversationId = '2001';
    groupConversationId = '3001';
    fileId = '4001';
  });

  it('1. Workspace creation: POST /v1/workspaces', async () => {
    vi.mocked(createWorkspace).mockResolvedValue({
      workspace_id: workspaceId,
      api_key: workspaceKey,
      created_at: '2025-01-01T00:00:00.000Z',
    });

    const res = await request(app)
      .post('/v1/workspaces')
      .send({ name: 'test-workspace' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      ok: true,
      data: {
        workspace_id: workspaceId,
        api_key: workspaceKey,
        created_at: '2025-01-01T00:00:00.000Z',
      },
    });
    expect(createWorkspace).toHaveBeenCalledWith('test-workspace');
  });

  it('2. Agent registration (Coder): POST /v1/agents', async () => {
    vi.mocked(registerAgent).mockResolvedValue({
      id: 'agent_coder',
      name: 'Coder',
      token: 'at_live_coder',
      status: 'active',
      created_at: '2025-01-01T00:00:00.000Z',
    });

    const res = await request(app)
      .post('/v1/agents')
      .set('Authorization', `Bearer ${workspaceKey}`)
      .send({ name: 'Coder', type: 'agent', persona: 'ships code' });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.token).toBe('at_live_coder');
    expect(registerAgent).toHaveBeenCalledWith(workspaceId, {
      name: 'Coder',
      type: 'agent',
      persona: 'ships code',
      metadata: undefined,
    });
    agentTokens.Coder = res.body.data.token;
  });

  it('3. Agent registration (Reviewer): POST /v1/agents', async () => {
    vi.mocked(registerAgent).mockResolvedValue({
      id: 'agent_reviewer',
      name: 'Reviewer',
      token: 'at_live_reviewer',
      status: 'active',
      created_at: '2025-01-01T00:00:00.000Z',
    });

    const res = await request(app)
      .post('/v1/agents')
      .set('Authorization', `Bearer ${workspaceKey}`)
      .send({ name: 'Reviewer', type: 'agent', persona: 'reviews code' });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.token).toBe('at_live_reviewer');
    expect(registerAgent).toHaveBeenCalledWith(workspaceId, {
      name: 'Reviewer',
      type: 'agent',
      persona: 'reviews code',
      metadata: undefined,
    });
    agentTokens.Reviewer = res.body.data.token;
  });

  it('4. Agent registration (Manager): POST /v1/agents', async () => {
    vi.mocked(registerAgent).mockResolvedValue({
      id: 'agent_manager',
      name: 'Manager',
      token: 'at_live_manager',
      status: 'active',
      created_at: '2025-01-01T00:00:00.000Z',
    });

    const res = await request(app)
      .post('/v1/agents')
      .set('Authorization', `Bearer ${workspaceKey}`)
      .send({ name: 'Manager', type: 'agent', persona: 'manages work' });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.token).toBe('at_live_manager');
    expect(registerAgent).toHaveBeenCalledWith(workspaceId, {
      name: 'Manager',
      type: 'agent',
      persona: 'manages work',
      metadata: undefined,
    });
    agentTokens.Manager = res.body.data.token;
  });

  it('5. List agents: GET /v1/agents', async () => {
    vi.mocked(listAgents).mockResolvedValue([
      {
        id: 'agent_coder',
        name: 'Coder',
        type: 'agent',
        status: 'active',
        persona: 'ships code',
        last_seen: '2025-01-01T00:00:00.000Z',
        metadata: {},
      },
      {
        id: 'agent_reviewer',
        name: 'Reviewer',
        type: 'agent',
        status: 'active',
        persona: 'reviews code',
        last_seen: '2025-01-01T00:00:00.000Z',
        metadata: {},
      },
      {
        id: 'agent_manager',
        name: 'Manager',
        type: 'agent',
        status: 'active',
        persona: 'manages work',
        last_seen: '2025-01-01T00:00:00.000Z',
        metadata: {},
      },
    ]);

    const res = await request(app)
      .get('/v1/agents')
      .set('Authorization', `Bearer ${workspaceKey}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toHaveLength(3);
    expect(listAgents).toHaveBeenCalledWith(workspaceId, undefined);
  });

  it('6. Channel creation: POST /v1/channels', async () => {
    vi.mocked(createChannel).mockResolvedValue({
      id: channelId,
      name: 'code-review',
      topic: 'Code review',
      created_by: 'agent_coder',
      created_at: '2025-01-01T00:00:00.000Z',
      member_count: 1,
    });

    const res = await request(app)
      .post('/v1/channels')
      .set('Authorization', `Bearer ${coderToken}`)
      .send({ name: 'code-review', topic: 'Code review' });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.name).toBe('code-review');
    expect(createChannel).toHaveBeenCalledWith(
      workspaceId,
      { name: 'code-review', topic: 'Code review' },
      'agent_coder',
    );
    channelId = res.body.data.id;
  });

  it('7. Join channel: POST /v1/channels/code-review/join', async () => {
    vi.mocked(joinChannel).mockResolvedValue({
      channel: 'code-review',
      agent_id: 'agent_coder',
      already_member: false,
    });

    const res = await request(app)
      .post('/v1/channels/code-review/join')
      .set('Authorization', `Bearer ${coderToken}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.channel).toBe('code-review');
    expect(joinChannel).toHaveBeenCalledWith(
      workspaceId,
      'code-review',
      'agent_coder',
    );
  });

  it('8. Post message: POST /v1/channels/code-review/messages', async () => {
    vi.mocked(getChannel).mockResolvedValue({
      id: channelId,
      name: 'code-review',
      topic: 'Code review',
      member_count: 1,
      members: [],
      created_at: '2025-01-01T00:00:00.000Z',
      is_archived: false,
    });

    vi.mocked(postMessage).mockResolvedValue({
      id: messageId,
      channel_id: channelId,
      agent_id: 'agent_coder',
      text: 'test message',
      has_attachments: false,
      thread_id: null,
      created_at: '2025-01-01T00:00:00.000Z',
    });

    const res = await request(app)
      .post('/v1/channels/code-review/messages')
      .set('Authorization', `Bearer ${coderToken}`)
      .send({ text: 'test message' });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.id).toBe(messageId);
    expect(getChannel).toHaveBeenCalledWith(workspaceId, 'code-review');
    expect(postMessage).toHaveBeenCalledWith(
      workspaceId,
      channelId,
      'agent_coder',
      {
        text: 'test message',
        attachments: undefined,
        data: undefined,
        content_type: undefined,
      },
    );
    messageId = res.body.data.id;
  });

  it('9. Get messages: GET /v1/channels/code-review/messages', async () => {
    vi.mocked(getChannel).mockResolvedValue({
      id: channelId,
      name: 'code-review',
      topic: 'Code review',
      member_count: 1,
      members: [],
      created_at: '2025-01-01T00:00:00.000Z',
      is_archived: false,
    });

    vi.mocked(getMessages).mockResolvedValue([
      {
        id: messageId,
        channel_id: channelId,
        agent_id: 'agent_coder',
        text: 'test message',
        has_attachments: false,
        thread_id: null,
        created_at: '2025-01-01T00:00:00.000Z',
      },
    ]);

    const res = await request(app)
      .get('/v1/channels/code-review/messages')
      .set('Authorization', `Bearer ${coderToken}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data[0].id).toBe(messageId);
    expect(getChannel).toHaveBeenCalledWith(workspaceId, 'code-review');
    expect(getMessages).toHaveBeenCalledWith(
      workspaceId,
      channelId,
      expect.objectContaining({ limit: undefined, before: undefined, after: undefined }),
    );
  });

  it('10. Thread reply: POST /v1/messages/:id/replies', async () => {
    vi.mocked(postReply).mockResolvedValue({
      id: '144115188075855873',
      channel_id: channelId,
      agent_id: 'agent_coder',
      thread_id: messageId,
      text: 'reply',
      has_attachments: false,
      created_at: '2025-01-01T00:00:00.000Z',
    });

    const res = await request(app)
      .post(`/v1/messages/${messageId}/replies`)
      .set('Authorization', `Bearer ${coderToken}`)
      .send({ text: 'reply' });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.thread_id).toBe(messageId);
    expect(postReply).toHaveBeenCalledWith(
      workspaceId,
      messageId,
      'agent_coder',
      { text: 'reply' },
    );
  });

  it('11. Get thread: GET /v1/messages/:id/replies', async () => {
    vi.mocked(getThread).mockResolvedValue({
      parent: {
        id: messageId,
        channel_id: channelId,
        agent_id: 'agent_coder',
        text: 'test message',
        has_attachments: false,
        thread_id: null,
        created_at: '2025-01-01T00:00:00.000Z',
        reply_count: 1,
      },
      replies: [
        {
          id: '144115188075855873',
          channel_id: channelId,
          agent_id: 'agent_coder',
          thread_id: messageId,
          text: 'reply',
          has_attachments: false,
          created_at: '2025-01-01T00:00:00.000Z',
        },
      ],
    });

    const res = await request(app)
      .get(`/v1/messages/${messageId}/replies`)
      .set('Authorization', `Bearer ${coderToken}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.parent.id).toBe(messageId);
    expect(res.body.data.replies).toHaveLength(1);
    expect(getThread).toHaveBeenCalledWith(
      workspaceId,
      messageId,
      expect.objectContaining({ limit: undefined, before: undefined, after: undefined }),
    );
  });

  it('12. Send DM: POST /v1/dm', async () => {
    vi.mocked(sendDm).mockResolvedValue({
      id: '1555',
      conversation_id: dmConversationId,
      from_agent_id: 'agent_coder',
      to: 'Reviewer',
      text: 'ping',
      created_at: '2025-01-01T00:00:00.000Z',
    });

    const res = await request(app)
      .post('/v1/dm')
      .set('Authorization', `Bearer ${coderToken}`)
      .send({ to: 'Reviewer', text: 'ping' });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.conversation_id).toBe(dmConversationId);
    expect(sendDm).toHaveBeenCalledWith(workspaceId, 'agent_coder', {
      to: 'Reviewer',
      text: 'ping',
    });
    dmConversationId = res.body.data.conversation_id;
  });

  it('13. List DM conversations: GET /v1/dm/conversations', async () => {
    vi.mocked(listConversations).mockResolvedValue([
      {
        id: dmConversationId,
        dm_type: '1:1',
        name: null,
        participants: [
          { agent_id: 'agent_coder', agent_name: 'Coder' },
          { agent_id: 'agent_reviewer', agent_name: 'Reviewer' },
        ],
        last_message: {
          id: '1555',
          text: 'ping',
          agent_id: 'agent_coder',
          created_at: '2025-01-01T00:00:00.000Z',
        },
        unread_count: 0,
        created_at: '2025-01-01T00:00:00.000Z',
      },
    ]);

    const res = await request(app)
      .get('/v1/dm/conversations')
      .set('Authorization', `Bearer ${coderToken}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data[0].id).toBe(dmConversationId);
    expect(listConversations).toHaveBeenCalledWith(workspaceId, 'agent_coder');
  });

  it('14. Create group DM: POST /v1/dm/group', async () => {
    vi.mocked(createGroupDm).mockResolvedValue({
      id: groupConversationId,
      channel_id: 'ch_group_1',
      dm_type: 'group',
      name: 'triage',
      participants: [{ agent_id: 'agent_coder' }, { agent_id: 'agent_reviewer' }, { agent_id: 'agent_manager' }],
      created_at: '2025-01-01T00:00:00.000Z',
    });

    const res = await request(app)
      .post('/v1/dm/group')
      .set('Authorization', `Bearer ${coderToken}`)
      .send({ participants: ['Reviewer', 'Manager'], name: 'triage' });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.id).toBe(groupConversationId);
    expect(createGroupDm).toHaveBeenCalledWith(workspaceId, 'agent_coder', {
      participants: ['Reviewer', 'Manager'],
      name: 'triage',
    });
    groupConversationId = res.body.data.id;
  });

  it('15. Post to group DM: POST /v1/dm/:conversation_id/messages', async () => {
    vi.mocked(postGroupMessage).mockResolvedValue({
      id: '1666',
      conversation_id: groupConversationId,
      agent_id: 'agent_coder',
      text: 'hello group',
      created_at: '2025-01-01T00:00:00.000Z',
    });

    const res = await request(app)
      .post(`/v1/dm/${groupConversationId}/messages`)
      .set('Authorization', `Bearer ${coderToken}`)
      .send({ text: 'hello group' });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.conversation_id).toBe(groupConversationId);
    expect(postGroupMessage).toHaveBeenCalledWith(
      workspaceId,
      groupConversationId,
      'agent_coder',
      { text: 'hello group' },
    );
  });

  it('16. Add reaction: POST /v1/messages/:id/reactions', async () => {
    vi.mocked(addReaction).mockResolvedValue({
      message_id: messageId,
      emoji: '👍',
      count: 1,
      me: true,
    });

    const res = await request(app)
      .post(`/v1/messages/${messageId}/reactions`)
      .set('Authorization', `Bearer ${coderToken}`)
      .send({ emoji: '👍' });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.emoji).toBe('👍');
    expect(addReaction).toHaveBeenCalledWith(
      workspaceId,
      messageId,
      'agent_coder',
      '👍',
    );
  });

  it('17. Get reactions: GET /v1/messages/:id/reactions', async () => {
    vi.mocked(getReactions).mockResolvedValue([
      { emoji: '👍', count: 1, me: true },
    ]);

    const res = await request(app)
      .get(`/v1/messages/${messageId}/reactions`)
      .set('Authorization', `Bearer ${workspaceKey}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data[0]).toEqual({ emoji: '👍', count: 1, me: true });
    expect(getReactions).toHaveBeenCalledWith(workspaceId, messageId);
  });

  it('18. Search: GET /v1/search?q=test', async () => {
    vi.mocked(searchMessages).mockResolvedValue([
      {
        id: messageId,
        channel: 'code-review',
        agent: 'Coder',
        text: 'test message',
        created_at: '2025-01-01T00:00:00.000Z',
      },
    ]);

    const res = await request(app)
      .get('/v1/search?q=test')
      .set('Authorization', `Bearer ${workspaceKey}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data[0].id).toBe(messageId);
    expect(searchMessages).toHaveBeenCalledWith(
      workspaceId,
      expect.objectContaining({
        q: 'test',
        channel: undefined,
        from: undefined,
        limit: undefined,
        before: undefined,
        after: undefined,
      }),
    );
  });

  it('19. Check inbox: GET /v1/inbox', async () => {
    vi.mocked(getInbox).mockResolvedValue({
      unread_count: 1,
      mentions: [{ message_id: messageId, channel: 'code-review' }],
    });

    const res = await request(app)
      .get('/v1/inbox')
      .set('Authorization', `Bearer ${coderToken}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.unread_count).toBe(1);
    expect(getInbox).toHaveBeenCalledWith(workspaceId, 'agent_coder');
  });

  it('20. Upload file: POST /v1/files/upload', async () => {
    vi.mocked(createUpload).mockResolvedValue({
      id: fileId,
      upload_url: 'https://example.com/upload',
      expires_at: '2025-01-01T01:00:00.000Z',
    });

    const res = await request(app)
      .post('/v1/files/upload')
      .set('Authorization', `Bearer ${coderToken}`)
      .send({
        filename: 'notes.txt',
        content_type: 'text/plain',
        size_bytes: 12,
      });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.upload_url).toContain('https://');
    expect(createUpload).toHaveBeenCalledWith(workspaceId, 'agent_coder', {
      filename: 'notes.txt',
      content_type: 'text/plain',
      size_bytes: 12,
    });
    fileId = res.body.data.id;
  });

  it('21. Complete upload: POST /v1/files/:id/complete', async () => {
    vi.mocked(completeUpload).mockResolvedValue({
      id: fileId,
      download_url: 'https://example.com/download',
      filename: 'notes.txt',
      content_type: 'text/plain',
      size_bytes: 12,
    });

    const res = await request(app)
      .post(`/v1/files/${fileId}/complete`)
      .set('Authorization', `Bearer ${coderToken}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.id).toBe(fileId);
    expect(completeUpload).toHaveBeenCalledWith(workspaceId, fileId, 'agent_coder');
  });

  it('22. Mark read: POST /v1/messages/:id/read', async () => {
    vi.mocked(markRead).mockResolvedValue({
      message_id: messageId,
      agent_id: 'agent_coder',
      read_at: '2025-01-01T00:00:00.000Z',
    });

    const res = await request(app)
      .post(`/v1/messages/${messageId}/read`)
      .set('Authorization', `Bearer ${coderToken}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.message_id).toBe(messageId);
    expect(markRead).toHaveBeenCalledWith(workspaceId, messageId, 'agent_coder');
  });

  it('23. Get readers: GET /v1/messages/:id/readers', async () => {
    vi.mocked(getReaders).mockResolvedValue([
      { agent_name: 'Coder', read_at: '2025-01-01T00:00:00.000Z' },
    ]);

    const res = await request(app)
      .get(`/v1/messages/${messageId}/readers`)
      .set('Authorization', `Bearer ${workspaceKey}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data[0].agent_name).toBe('Coder');
    expect(getReaders).toHaveBeenCalledWith(workspaceId, messageId);
  });

  it('24. System prompt: GET /v1/workspace/system-prompt', async () => {
    vi.mocked(getSystemPrompt).mockResolvedValue({
      prompt: 'You are helpful.',
      is_default: false,
    });

    const res = await request(app)
      .get('/v1/workspace/system-prompt')
      .set('Authorization', `Bearer ${workspaceKey}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.prompt).toContain('helpful');
    expect(getSystemPrompt).toHaveBeenCalledWith(workspaceId);
  });

  it('25. Update system prompt: PUT /v1/workspace/system-prompt', async () => {
    vi.mocked(setSystemPrompt).mockResolvedValue({
      prompt: 'New prompt',
      is_default: false,
    });

    const res = await request(app)
      .put('/v1/workspace/system-prompt')
      .set('Authorization', `Bearer ${workspaceKey}`)
      .send({ prompt: 'New prompt' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.prompt).toBe('New prompt');
    expect(setSystemPrompt).toHaveBeenCalledWith(workspaceId, 'New prompt');
  });

  it('26. Get presence: GET /v1/agents/presence', async () => {
    vi.mocked(getPresence).mockResolvedValue([
      { agent_id: 'agent_coder', agent_name: 'Coder', status: 'online' },
      { agent_id: 'agent_reviewer', agent_name: 'Reviewer', status: 'offline' },
    ]);

    const res = await request(app)
      .get('/v1/agents/presence')
      .set('Authorization', `Bearer ${workspaceKey}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toHaveLength(2);
    expect(getPresence).toHaveBeenCalledWith(workspaceId);
  });

  it('27. Billing usage: GET /v1/billing/usage', async () => {
    vi.mocked(getUsage).mockResolvedValue({
      period: 'current',
      api_calls: 123,
      messages: 10,
      agents: 3,
      file_bytes: 12,
    });

    const res = await request(app)
      .get('/v1/billing/usage')
      .set('Authorization', `Bearer ${workspaceKey}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.api_calls).toBe(123);
    expect(getUsage).toHaveBeenCalledWith(workspaceId, 'current');
  });

  it('28. Archive channel: DELETE /v1/channels/code-review', async () => {
    vi.mocked(archiveChannel).mockResolvedValue(true);

    const res = await request(app)
      .delete('/v1/channels/code-review')
      .set('Authorization', `Bearer ${workspaceKey}`);

    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect(archiveChannel).toHaveBeenCalledWith(workspaceId, 'code-review');
  });

  it('29. Delete workspace: DELETE /v1/workspace', async () => {
    vi.mocked(deleteWorkspace).mockResolvedValue(undefined);

    const res = await request(app)
      .delete('/v1/workspace')
      .set('Authorization', `Bearer ${workspaceKey}`);

    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect(deleteWorkspace).toHaveBeenCalledWith(workspaceId);
  });
});

