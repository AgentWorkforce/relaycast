import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../engine/usage.js', () => ({
  incrementUsage: vi.fn().mockResolvedValue(1),
}));

import { usageTracker } from '../usageTracker.js';
import { incrementUsage } from '../../engine/usage.js';

describe('usageTracker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('increments api_calls for authenticated requests', async () => {
    const req = { workspace: { id: 'ws_123', plan: 'free' } } as any;
    const res = {} as any;
    const next = vi.fn();

    await usageTracker(req, res, next);

    expect(incrementUsage).toHaveBeenCalledWith('ws_123', 'api_calls');
    expect(next).toHaveBeenCalled();
  });

  it('calls next without incrementing if no workspace', async () => {
    const req = {} as any;
    const res = {} as any;
    const next = vi.fn();

    await usageTracker(req, res, next);

    expect(incrementUsage).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it('still calls next even if incrementUsage fails', async () => {
    vi.mocked(incrementUsage).mockRejectedValue(new Error('Redis down'));

    const req = { workspace: { id: 'ws_123', plan: 'free' } } as any;
    const res = {} as any;
    const next = vi.fn();

    await usageTracker(req, res, next);

    // next is called immediately (incrementUsage is fire-and-forget)
    expect(next).toHaveBeenCalled();
  });
});
