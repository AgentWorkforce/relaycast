import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockKV } from '../../__tests__/test-helpers.js';
import {
  processWebhook,
  handleSubscriptionUpdated,
  handleSubscriptionDeleted,
  handleInvoicePaid,
  handlePaymentFailed,
} from '../webhooks.js';

// Mock the usage module
vi.mock('../usage.js', () => ({
  resetUsageCounters: vi.fn().mockResolvedValue(undefined),
}));

import { resetUsageCounters } from '../usage.js';

function createMockDb() {
  const mockUpdate = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue([]),
  };
  const mockSelect = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue([]),
  };

  return {
    update: vi.fn().mockReturnValue(mockUpdate),
    select: vi.fn().mockReturnValue(mockSelect),
    _update: mockUpdate,
    _select: mockSelect,
  };
}

describe('webhook handlers', () => {
  let db: ReturnType<typeof createMockDb>;
  let kv: KVNamespace;

  beforeEach(() => {
    db = createMockDb();
    kv = createMockKV();
    vi.clearAllMocks();
  });

  describe('handleSubscriptionUpdated', () => {
    it('updates workspace plan from subscription metadata', async () => {
      await handleSubscriptionUpdated(db as any, {
        id: 'sub_123',
        metadata: { workspace_id: 'ws_123', plan: 'pro' },
      });

      expect(db.update).toHaveBeenCalled();
      expect(db._update.set).toHaveBeenCalledWith({
        plan: 'pro',
        stripeSubscriptionId: 'sub_123',
      });
    });

    it('defaults to free plan when metadata has no plan', async () => {
      await handleSubscriptionUpdated(db as any, {
        id: 'sub_123',
        metadata: { workspace_id: 'ws_123' },
      });

      expect(db._update.set).toHaveBeenCalledWith({
        plan: 'free',
        stripeSubscriptionId: 'sub_123',
      });
    });

    it('does nothing when no workspace_id in metadata', async () => {
      await handleSubscriptionUpdated(db as any, {
        id: 'sub_123',
        metadata: {},
      });

      expect(db.update).not.toHaveBeenCalled();
    });
  });

  describe('handleSubscriptionDeleted', () => {
    it('downgrades workspace to free plan', async () => {
      await handleSubscriptionDeleted(db as any, {
        id: 'sub_123',
        metadata: { workspace_id: 'ws_123' },
      });

      expect(db.update).toHaveBeenCalled();
      expect(db._update.set).toHaveBeenCalledWith({
        plan: 'free',
        stripeSubscriptionId: null,
      });
    });

    it('does nothing when no workspace_id in metadata', async () => {
      await handleSubscriptionDeleted(db as any, {
        id: 'sub_123',
        metadata: {},
      });

      expect(db.update).not.toHaveBeenCalled();
    });
  });

  describe('handleInvoicePaid', () => {
    it('resets usage counters for the workspace', async () => {
      db._select.where.mockResolvedValue([{ id: 'ws_123', stripeCustomerId: 'cus_123' }]);

      await handleInvoicePaid(db as any, kv, { customer: 'cus_123' });

      expect(resetUsageCounters).toHaveBeenCalledWith(kv, 'ws_123');
    });

    it('does nothing when no customer ID', async () => {
      await handleInvoicePaid(db as any, kv, {});

      expect(resetUsageCounters).not.toHaveBeenCalled();
    });

    it('does nothing when workspace not found', async () => {
      db._select.where.mockResolvedValue([]);

      await handleInvoicePaid(db as any, kv, { customer: 'cus_unknown' });

      expect(resetUsageCounters).not.toHaveBeenCalled();
    });
  });

  describe('handlePaymentFailed', () => {
    it('downgrades workspace to free and clears subscription', async () => {
      db._select.where.mockResolvedValue([{ id: 'ws_123', stripeCustomerId: 'cus_123' }]);

      await handlePaymentFailed(db as any, { customer: 'cus_123' });

      expect(db.update).toHaveBeenCalled();
      expect(db._update.set).toHaveBeenCalledWith({
        plan: 'free',
        stripeSubscriptionId: null,
      });
    });

    it('does nothing when no customer ID', async () => {
      await handlePaymentFailed(db as any, {});

      expect(db.update).not.toHaveBeenCalled();
    });

    it('does nothing when workspace not found', async () => {
      db._select.where.mockResolvedValue([]);

      await handlePaymentFailed(db as any, { customer: 'cus_unknown' });

      // select is called but update should not be (no workspace found)
      expect(db.update).not.toHaveBeenCalled();
    });
  });

  describe('processWebhook', () => {
    it('handles subscription.updated event', async () => {
      const result = await processWebhook(
        db as any,
        {
          type: 'subscription.updated',
          data: { id: 'sub_123', metadata: { workspace_id: 'ws_123', plan: 'pro' } },
        },
        kv,
      );

      expect(result).toEqual({ received: true });
      expect(db.update).toHaveBeenCalled();
    });

    it('handles subscription.deleted event', async () => {
      const result = await processWebhook(
        db as any,
        {
          type: 'subscription.deleted',
          data: { id: 'sub_123', metadata: { workspace_id: 'ws_123' } },
        },
        kv,
      );

      expect(result).toEqual({ received: true });
    });

    it('handles invoice.paid event', async () => {
      db._select.where.mockResolvedValue([{ id: 'ws_123', stripeCustomerId: 'cus_123' }]);

      const result = await processWebhook(
        db as any,
        {
          type: 'invoice.paid',
          data: { customer: 'cus_123' },
        },
        kv,
      );

      expect(result).toEqual({ received: true });
      expect(resetUsageCounters).toHaveBeenCalledWith(kv, 'ws_123');
    });

    it('handles invoice.payment_failed event', async () => {
      db._select.where.mockResolvedValue([{ id: 'ws_123', stripeCustomerId: 'cus_123' }]);

      const result = await processWebhook(
        db as any,
        {
          type: 'invoice.payment_failed',
          data: { customer: 'cus_123' },
        },
        kv,
      );

      expect(result).toEqual({ received: true });
    });

    it('acknowledges unknown event types', async () => {
      const result = await processWebhook(
        db as any,
        {
          type: 'unknown.event',
          data: {},
        },
        kv,
      );

      expect(result).toEqual({ received: true });
    });
  });
});
