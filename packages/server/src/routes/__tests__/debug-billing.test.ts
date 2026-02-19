import { describe, it, expect, vi } from 'vitest';

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

vi.mock('../../engine/agent.js', () => ({
  touchLastSeen: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../db/index.js', () => ({
  getDb: vi.fn(),
}));

import { Hono } from 'hono';
import type { AppEnv } from '../../env.js';
import { dbMiddleware } from '../../middleware/db.js';
import { billingRoutes } from '../../routes/billing.js';
import { webhookRoutes } from '../../routes/webhooks.js';
import { getDb } from '../../db/index.js';
import {
  mockDbForWorkspaceAuth,
  createMockBindings,
} from '../../__tests__/test-helpers.js';

const bindings = createMockBindings();
const app = new Hono<AppEnv>();
app.use('*', async (c, next) => {
  (c as any).env = { ...bindings };
  await next();
});
app.use('*', dbMiddleware);
const v1 = new Hono<AppEnv>();
v1.route('/', billingRoutes);
v1.route('/', webhookRoutes);
app.route('/v1', v1);

describe('debug', () => {
  it('check billing route mounts', async () => {
    vi.mocked(getDb).mockReturnValue(mockDbForWorkspaceAuth());

    const res = await app.request('/v1/billing/webhooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'test' }),
    });
    console.log('webhook status:', res.status, 'body:', JSON.stringify(await res.json()));

    const res2 = await app.request('/v1/billing/subscription', { method: 'GET' });
    console.log('subscription status:', res2.status, 'body:', JSON.stringify(await res2.json()));
  });
});
