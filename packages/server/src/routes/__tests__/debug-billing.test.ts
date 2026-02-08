import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';

vi.mock('../../engine/billing.js', () => ({ subscribe: vi.fn(), getSubscription: vi.fn(), getUsage: vi.fn(), getInvoices: vi.fn(), createPortalSession: vi.fn() }));
vi.mock('../../engine/webhooks.js', () => ({ processWebhook: vi.fn() }));
vi.mock('../../engine/channel.js', () => ({}));
vi.mock('../../engine/agent.js', () => ({}));
vi.mock('../../engine/message.js', () => ({}));
vi.mock('../../engine/thread.js', () => ({}));
vi.mock('../../engine/dm.js', () => ({}));
vi.mock('../../engine/groupDm.js', () => ({}));
vi.mock('../../engine/reaction.js', () => ({}));
vi.mock('../../engine/search.js', () => ({}));
vi.mock('../../engine/inbox.js', () => ({}));
vi.mock('../../engine/workspace.js', () => ({}));
vi.mock('../../engine/receipt.js', () => ({}));
vi.mock('../../engine/file.js', () => ({}));
vi.mock('../../engine/presence.js', () => ({ getPresence: vi.fn() }));
vi.mock('../../engine/systemPrompt.js', () => ({ getSystemPrompt: vi.fn(), setSystemPrompt: vi.fn() }));
vi.mock('../../db/index.js', () => ({ getDb: vi.fn() }));
vi.mock('../../redis/index.js', () => ({ getRedis: vi.fn(() => ({ incr: vi.fn().mockResolvedValue(1), expire: vi.fn().mockResolvedValue(1) })) }));

vi.mock('../../ws/pubsub.js', () => ({
  publishEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../engine/eventDelivery.js', () => ({
  deliverEvent: vi.fn().mockResolvedValue(undefined),
}));

import { app } from '../../app.js';

describe('debug', () => {
  it('check billing route mounts', async () => {
    const res = await request(app).post('/v1/billing/webhooks').send({ type: 'test' });
    console.log('webhook status:', res.status, 'body:', JSON.stringify(res.body));

    const res2 = await request(app).get('/v1/billing/subscription');
    console.log('subscription status:', res2.status, 'body:', JSON.stringify(res2.body));
  });
});
