import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockUpdate,
  mockSet,
  mockWhere,
  mockSelect,
  mockFrom,
  mockSelectWhere,
  mockResetUsageCounters,
} = vi.hoisted(() => {
  const mockUpdate = vi.fn();
  const mockSet = vi.fn();
  const mockWhere = vi.fn().mockResolvedValue([]);
  const mockSelect = vi.fn();
  const mockFrom = vi.fn();
  const mockSelectWhere = vi.fn();
  const mockResetUsageCounters = vi.fn();

  // Chain: update().set().where()
  mockUpdate.mockReturnValue({ set: mockSet });
  mockSet.mockReturnValue({ where: mockWhere });

  // Chain: select().from()
  mockSelect.mockReturnValue({ from: mockFrom });

  return { mockUpdate, mockSet, mockWhere, mockSelect, mockFrom, mockSelectWhere, mockResetUsageCounters };
});

vi.mock('../db/index.js', () => ({
  getDb: () => ({ update: mockUpdate, select: mockSelect }),
}));

vi.mock('../db/schema.js', () => ({
  workspaces: { id: 'id', stripeCustomerId: 'stripe_customer_id' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((_col: unknown, val: unknown) => ({ type: 'eq', val })),
}));

vi.mock('../engine/usage.js', () => ({
  resetUsageCounters: mockResetUsageCounters,
}));

import {
  processWebhook,
  handleInvoicePaid,
  handlePaymentFailed,
  handleSubscriptionUpdated,
  handleSubscriptionDeleted,
} from '../engine/webhooks.js';

beforeEach(() => {
  vi.clearAllMocks();
  // Reset chains
  mockUpdate.mockReturnValue({ set: mockSet });
  mockSet.mockReturnValue({ where: mockWhere });
  mockSelect.mockReturnValue({ from: mockFrom });
  // Default: select().from().where() returns a workspace
  mockFrom.mockReturnValue({
    where: mockSelectWhere,
  });
  mockSelectWhere.mockResolvedValue([
    { id: 'ws_1', plan: 'pro', stripeCustomerId: 'cus_123' },
  ]);
});

describe('processWebhook', () => {
  it('dispatches subscription.updated', async () => {
    const result = await processWebhook({
      type: 'subscription.updated',
      data: { id: 'sub_1', metadata: { workspace_id: 'ws_1', plan: 'pro' } },
    });
    expect(result).toEqual({ received: true });
    expect(mockUpdate).toHaveBeenCalled();
  });

  it('dispatches subscription.deleted', async () => {
    const result = await processWebhook({
      type: 'subscription.deleted',
      data: { metadata: { workspace_id: 'ws_1' } },
    });
    expect(result).toEqual({ received: true });
    expect(mockUpdate).toHaveBeenCalled();
  });

  it('dispatches invoice.paid', async () => {
    const result = await processWebhook({
      type: 'invoice.paid',
      data: { customer: 'cus_123' },
    });
    expect(result).toEqual({ received: true });
    expect(mockResetUsageCounters).toHaveBeenCalledWith('ws_1');
  });

  it('dispatches invoice.payment_failed', async () => {
    const result = await processWebhook({
      type: 'invoice.payment_failed',
      data: { customer: 'cus_123' },
    });
    expect(result).toEqual({ received: true });
    expect(mockUpdate).toHaveBeenCalled();
    expect(mockSet).toHaveBeenCalledWith({ plan: 'free' });
  });

  it('acknowledges unknown event types', async () => {
    const result = await processWebhook({ type: 'unknown.event', data: {} });
    expect(result).toEqual({ received: true });
  });
});

describe('handleInvoicePaid', () => {
  it('resets usage counters for the workspace', async () => {
    await handleInvoicePaid({ customer: 'cus_123' });
    expect(mockResetUsageCounters).toHaveBeenCalledWith('ws_1');
  });

  it('does nothing if customer is missing', async () => {
    await handleInvoicePaid({});
    expect(mockResetUsageCounters).not.toHaveBeenCalled();
  });

  it('does nothing if workspace not found', async () => {
    mockSelectWhere.mockResolvedValueOnce([]);
    await handleInvoicePaid({ customer: 'cus_nonexistent' });
    expect(mockResetUsageCounters).not.toHaveBeenCalled();
  });
});

describe('handlePaymentFailed', () => {
  it('downgrades workspace to free plan', async () => {
    await handlePaymentFailed({ customer: 'cus_123' });
    expect(mockUpdate).toHaveBeenCalled();
    expect(mockSet).toHaveBeenCalledWith({ plan: 'free' });
  });

  it('does nothing if customer is missing', async () => {
    vi.clearAllMocks();
    mockUpdate.mockReturnValue({ set: mockSet });
    mockSet.mockReturnValue({ where: mockWhere });
    mockSelect.mockReturnValue({ from: mockFrom });
    mockFrom.mockReturnValue({ where: mockSelectWhere });
    mockSelectWhere.mockResolvedValue([{ id: 'ws_1', plan: 'pro', stripeCustomerId: 'cus_123' }]);
    await handlePaymentFailed({});
    expect(mockSet).not.toHaveBeenCalledWith({ plan: 'free' });
  });

  it('does nothing if workspace not found', async () => {
    mockSelectWhere.mockResolvedValueOnce([]);
    vi.clearAllMocks();
    mockUpdate.mockReturnValue({ set: mockSet });
    mockSet.mockReturnValue({ where: mockWhere });
    mockSelect.mockReturnValue({ from: mockFrom });
    mockFrom.mockReturnValue({ where: mockSelectWhere });
    mockSelectWhere.mockResolvedValue([]);
    await handlePaymentFailed({ customer: 'cus_nonexistent' });
    expect(mockSet).not.toHaveBeenCalledWith({ plan: 'free' });
  });
});

describe('handleSubscriptionUpdated', () => {
  it('updates workspace plan and subscription ID', async () => {
    await handleSubscriptionUpdated({
      id: 'sub_new',
      metadata: { workspace_id: 'ws_1', plan: 'enterprise' },
    });
    expect(mockSet).toHaveBeenCalledWith({
      plan: 'enterprise',
      stripeSubscriptionId: 'sub_new',
    });
  });

  it('defaults to free when plan not in metadata', async () => {
    await handleSubscriptionUpdated({
      id: 'sub_new',
      metadata: { workspace_id: 'ws_1' },
    });
    expect(mockSet).toHaveBeenCalledWith({
      plan: 'free',
      stripeSubscriptionId: 'sub_new',
    });
  });

  it('does nothing if workspace_id is missing from metadata', async () => {
    vi.clearAllMocks();
    await handleSubscriptionUpdated({ id: 'sub_new', metadata: {} });
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

describe('handleSubscriptionDeleted', () => {
  it('downgrades to free and clears subscription ID', async () => {
    await handleSubscriptionDeleted({
      metadata: { workspace_id: 'ws_1' },
    });
    expect(mockSet).toHaveBeenCalledWith({
      plan: 'free',
      stripeSubscriptionId: null,
    });
  });

  it('does nothing if workspace_id is missing', async () => {
    vi.clearAllMocks();
    await handleSubscriptionDeleted({ metadata: {} });
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
