import { afterEach, describe, expect, it, vi } from 'vitest';
import * as deliveryEngine from '../../engine/delivery.js';
import type { EngineDeps } from '../../ports/index.js';
import {
  DELIVERY_EXPIRY_MAX_BATCHES,
  sweepExpiredDeliveries,
} from '../deliveryRouting.js';

const deps = {} as EngineDeps;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('scheduled delivery expiry drain', () => {
  it('must fire repeatedly so one invocation drains more than one SQL batch', async () => {
    const expire = vi.spyOn(deliveryEngine, 'expireDueDeliveryBatch')
      .mockResolvedValueOnce({ expiredCount: 50, notices: [] })
      .mockResolvedValueOnce({ expiredCount: 17, notices: [] });

    await expect(sweepExpiredDeliveries(deps)).resolves.toBe(67);
    expect(expire).toHaveBeenCalledTimes(2);
  });

  it('must not fire past the fixed invocation bound while backlog remains', async () => {
    const expire = vi.spyOn(deliveryEngine, 'expireDueDeliveryBatch')
      .mockResolvedValue({ expiredCount: deliveryEngine.DELIVERY_EXPIRY_BATCH_SIZE, notices: [] });

    await expect(sweepExpiredDeliveries(deps, { maxBatches: Number.MAX_SAFE_INTEGER }))
      .resolves.toBe(DELIVERY_EXPIRY_MAX_BATCHES * deliveryEngine.DELIVERY_EXPIRY_BATCH_SIZE);
    expect(expire).toHaveBeenCalledTimes(DELIVERY_EXPIRY_MAX_BATCHES);
  });
});
