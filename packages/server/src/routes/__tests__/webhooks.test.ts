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

vi.mock('../../engine/command.js', () => ({
  registerCommand: vi.fn(),
  listCommands: vi.fn(),
  getCommand: vi.fn(),
  deleteCommand: vi.fn(),
  invokeCommand: vi.fn(),
}));

vi.mock('../../engine/inboundWebhook.js', () => ({
  createWebhook: vi.fn(),
  listWebhooks: vi.fn(),
  getWebhook: vi.fn(),
  deleteWebhook: vi.fn(),
  triggerWebhook: vi.fn(),
}));

vi.mock('../../engine/eventSubscription.js', () => ({
  createSubscription: vi.fn(),
  listSubscriptions: vi.fn(),
  deleteSubscription: vi.fn(),
  getActiveSubscriptions: vi.fn(),
}));

vi.mock('../../ws/pubsub.js', () => ({
  publishEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../engine/eventDelivery.js', () => ({
  deliverEvent: vi.fn().mockResolvedValue(undefined),
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

import { createHmac } from 'node:crypto';
import { app } from '../../app.js';
import * as webhooksEngine from '../../engine/webhooks.js';

describe('POST /v1/billing/webhooks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.STRIPE_WEBHOOK_SECRET;
  });

  it('handles subscription.updated', async () => {
    vi.mocked(webhooksEngine.processWebhook).mockResolvedValue({ received: true });

    const res = await request(app)
      .post('/v1/billing/webhooks')
      .send({ type: 'subscription.updated', data: { id: 'sub_123', metadata: { workspace_id: 'ws_1', plan: 'pro' } } });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.received).toBe(true);
    expect(webhooksEngine.processWebhook).toHaveBeenCalledWith({
      type: 'subscription.updated',
      data: { id: 'sub_123', metadata: { workspace_id: 'ws_1', plan: 'pro' } },
    });
  });

  it('handles subscription.deleted', async () => {
    vi.mocked(webhooksEngine.processWebhook).mockResolvedValue({ received: true });

    const res = await request(app)
      .post('/v1/billing/webhooks')
      .send({ type: 'subscription.deleted', data: { id: 'sub_123', metadata: { workspace_id: 'ws_1' } } });

    expect(res.status).toBe(200);
    expect(res.body.data.received).toBe(true);
  });

  it('handles invoice.paid', async () => {
    vi.mocked(webhooksEngine.processWebhook).mockResolvedValue({ received: true });

    const res = await request(app)
      .post('/v1/billing/webhooks')
      .send({ type: 'invoice.paid', data: { customer: 'cus_123', amount_paid: 2999 } });

    expect(res.status).toBe(200);
    expect(res.body.data.received).toBe(true);
  });

  it('handles invoice.payment_failed', async () => {
    vi.mocked(webhooksEngine.processWebhook).mockResolvedValue({ received: true });

    const res = await request(app)
      .post('/v1/billing/webhooks')
      .send({ type: 'invoice.payment_failed', data: { customer: 'cus_123' } });

    expect(res.status).toBe(200);
    expect(res.body.data.received).toBe(true);
  });

  it('returns 400 for missing type', async () => {
    const res = await request(app)
      .post('/v1/billing/webhooks')
      .send({ data: {} });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_request');
    expect(res.body.error.message).toContain('type');
  });

  it('returns 500 on processing failure so Stripe retries', async () => {
    vi.mocked(webhooksEngine.processWebhook).mockRejectedValue(new Error('DB error'));

    const res = await request(app)
      .post('/v1/billing/webhooks')
      .send({ type: 'subscription.updated', data: {} });

    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('webhook_processing_error');
  });

  it('does not require auth', async () => {
    vi.mocked(webhooksEngine.processWebhook).mockResolvedValue({ received: true });

    const res = await request(app)
      .post('/v1/billing/webhooks')
      .send({ type: 'subscription.updated', data: {} });

    // Should not get 401
    expect(res.status).toBe(200);
  });

  it('handles unknown events', async () => {
    vi.mocked(webhooksEngine.processWebhook).mockResolvedValue({ received: true });

    const res = await request(app)
      .post('/v1/billing/webhooks')
      .send({ type: 'some.unknown.event', data: {} });

    expect(res.status).toBe(200);
    expect(res.body.data.received).toBe(true);
  });

  it('rejects requests with invalid signature when STRIPE_WEBHOOK_SECRET is set', async () => {
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret';

    const res = await request(app)
      .post('/v1/billing/webhooks')
      .set('stripe-signature', 't=12345,v1=invalid')
      .send({ type: 'subscription.updated', data: {} });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('invalid_signature');
  });

  it('rejects requests without stripe-signature header when secret is set', async () => {
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret';

    const res = await request(app)
      .post('/v1/billing/webhooks')
      .send({ type: 'subscription.updated', data: {} });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('invalid_signature');
  });

  it('accepts requests with valid signature when STRIPE_WEBHOOK_SECRET is set', async () => {
    const secret = 'whsec_test_secret';
    process.env.STRIPE_WEBHOOK_SECRET = secret;
    vi.mocked(webhooksEngine.processWebhook).mockResolvedValue({ received: true });

    const body = JSON.stringify({ type: 'subscription.updated', data: {} });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const sig = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');

    const res = await request(app)
      .post('/v1/billing/webhooks')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', `t=${timestamp},v1=${sig}`)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('rejects stale signatures older than 5 minutes', async () => {
    const secret = 'whsec_test_secret';
    process.env.STRIPE_WEBHOOK_SECRET = secret;

    const body = JSON.stringify({ type: 'subscription.updated', data: {} });
    // Timestamp 10 minutes in the past
    const staleTimestamp = (Math.floor(Date.now() / 1000) - 600).toString();
    const sig = createHmac('sha256', secret).update(`${staleTimestamp}.${body}`).digest('hex');

    const res = await request(app)
      .post('/v1/billing/webhooks')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', `t=${staleTimestamp},v1=${sig}`)
      .send(body);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('invalid_signature');
  });
});
