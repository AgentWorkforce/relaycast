import { afterEach, describe, expect, it, vi } from 'vitest';
import * as deliveryEngine from '../../engine/delivery.js';
import type { EngineDeps } from '../../ports/index.js';
import {
  DELIVERY_EXPIRY_MAX_BATCHES,
  sweepExpiredDeliveries,
  sweepUnreachableDeliveries,
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

  it('keeps sweeping when mention backfill fails', async () => {
    const expire = vi.spyOn(deliveryEngine, 'expireDueDeliveryBatch')
      .mockResolvedValue({ expiredCount: 3, notices: [] });
    const unreachable = vi.spyOn(deliveryEngine, 'deadLetterUnreachableDeliveryBatch')
      .mockResolvedValue({ expiredCount: 2, notices: [] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = {
      all: vi.fn().mockRejectedValue(new Error('UNIQUE constraint failed: messages_mention_fts_docsize.id')),
    };

    await expect(sweepExpiredDeliveries({ db } as EngineDeps)).resolves.toBe(3);
    await expect(sweepUnreachableDeliveries({ db } as EngineDeps)).resolves.toBe(2);
    expect(expire).toHaveBeenCalledTimes(1);
    expect(unreachable).toHaveBeenCalledTimes(1);
  });
});
