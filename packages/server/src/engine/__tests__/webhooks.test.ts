import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/index.js', () => ({
  getDb: vi.fn(),
}));

vi.mock('../usage.js', () => ({
  resetUsageCounters: vi.fn(),
}));

import { getDb } from '../../db/index.js';
import {
  processWebhook,
  handleSubscriptionUpdated,
  handleSubscriptionDeleted,
  handleInvoicePaid,
  handlePaymentFailed,
} from '../webhooks.js';

function mockDb(selectResult: unknown[] = []) {
  const updateSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) });
  vi.mocked(getDb).mockReturnValue({
    select: () => ({
      from: () => ({
        where: vi.fn().mockResolvedValue(selectResult),
      }),
    }),
    update: () => ({
      set: updateSet,
    }),
  } as any);
  return { updateSet };
}

describe('processWebhook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('handles subscription.updated', async () => {
    const { updateSet } = mockDb();
    const result = await processWebhook({
      type: 'subscription.updated',
      data: { id: 'sub_123', metadata: { workspace_id: 'ws_1', plan: 'pro' } },
    });
    expect(result).toEqual({ received: true });
    expect(updateSet).toHaveBeenCalledWith({ plan: 'pro', stripeSubscriptionId: 'sub_123' });
  });

  it('handles subscription.deleted', async () => {
    const { updateSet } = mockDb();
    const result = await processWebhook({
      type: 'subscription.deleted',
      data: { id: 'sub_123', metadata: { workspace_id: 'ws_1', plan: 'pro' } },
    });
    expect(result).toEqual({ received: true });
    expect(updateSet).toHaveBeenCalledWith({ plan: 'free', stripeSubscriptionId: null });
  });

  it('handles invoice.paid', async () => {
    mockDb([{ id: 'ws_1', stripeCustomerId: 'cus_123' }]);
    const result = await processWebhook({
      type: 'invoice.paid',
      data: { customer: 'cus_123', amount_paid: 2999 },
    });
    expect(result).toEqual({ received: true });
  });

  it('handles invoice.payment_failed', async () => {
    mockDb([{ id: 'ws_1', stripeCustomerId: 'cus_123' }]);
    const result = await processWebhook({
      type: 'invoice.payment_failed',
      data: { customer: 'cus_123' },
    });
    expect(result).toEqual({ received: true });
  });

  it('handles unknown event types gracefully', async () => {
    mockDb();
    const result = await processWebhook({
      type: 'some.unknown.event',
      data: {},
    });
    expect(result).toEqual({ received: true });
  });
});

describe('handleSubscriptionUpdated', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does nothing without workspace_id in metadata', async () => {
    const { updateSet } = mockDb();
    await handleSubscriptionUpdated({ id: 'sub_123', metadata: {} });
    expect(updateSet).not.toHaveBeenCalled();
  });

  it('defaults plan to free if missing from metadata', async () => {
    const { updateSet } = mockDb();
    await handleSubscriptionUpdated({ id: 'sub_123', metadata: { workspace_id: 'ws_1' } });
    expect(updateSet).toHaveBeenCalledWith({ plan: 'free', stripeSubscriptionId: 'sub_123' });
  });
});

describe('handleSubscriptionDeleted', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resets plan to free and clears subscription ID', async () => {
    const { updateSet } = mockDb();
    await handleSubscriptionDeleted({ id: 'sub_123', metadata: { workspace_id: 'ws_1' } });
    expect(updateSet).toHaveBeenCalledWith({ plan: 'free', stripeSubscriptionId: null });
  });
});

describe('handleInvoicePaid', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does nothing without customer', async () => {
    mockDb();
    await handleInvoicePaid({});
    // No error thrown
  });
});

describe('handlePaymentFailed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does nothing without customer', async () => {
    mockDb();
    await handlePaymentFailed({});
    // No error thrown
  });
});
