import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../redis/index.js', () => ({
  getRedis: vi.fn(),
}));

import { getRedis } from '../../redis/index.js';
import { incrementUsage, getUsageCounters, resetUsageCounters, getUsageMetric } from '../usage.js';

describe('incrementUsage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('increments by 1 by default', async () => {
    const mockRedis = { incrby: vi.fn().mockResolvedValue(1) };
    vi.mocked(getRedis).mockReturnValue(mockRedis as any);

    const result = await incrementUsage('ws_123', 'messages');
    expect(result).toBe(1);
    expect(mockRedis.incrby).toHaveBeenCalledWith('usage:ws_123:messages', 1);
  });

  it('increments by custom amount', async () => {
    const mockRedis = { incrby: vi.fn().mockResolvedValue(5) };
    vi.mocked(getRedis).mockReturnValue(mockRedis as any);

    const result = await incrementUsage('ws_123', 'file_bytes', 5);
    expect(result).toBe(5);
    expect(mockRedis.incrby).toHaveBeenCalledWith('usage:ws_123:file_bytes', 5);
  });

  it('returns the new value after increment', async () => {
    const mockRedis = { incrby: vi.fn().mockResolvedValue(42) };
    vi.mocked(getRedis).mockReturnValue(mockRedis as any);

    const result = await incrementUsage('ws_456', 'api_calls', 1);
    expect(result).toBe(42);
  });
});

describe('getUsageCounters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns all 5 metrics', async () => {
    const mockRedis = { mget: vi.fn().mockResolvedValue(['100', '200', '5', '1048576', '30']) };
    vi.mocked(getRedis).mockReturnValue(mockRedis as any);

    const result = await getUsageCounters('ws_123');
    expect(result).toEqual({
      messages: 100,
      api_calls: 200,
      files: 5,
      file_bytes: 1048576,
      ws_minutes: 30,
    });
  });

  it('returns 0 for missing keys', async () => {
    const mockRedis = { mget: vi.fn().mockResolvedValue([null, null, null, null, null]) };
    vi.mocked(getRedis).mockReturnValue(mockRedis as any);

    const result = await getUsageCounters('ws_empty');
    expect(result).toEqual({
      messages: 0,
      api_calls: 0,
      files: 0,
      file_bytes: 0,
      ws_minutes: 0,
    });
  });

  it('uses correct redis keys', async () => {
    const mockRedis = { mget: vi.fn().mockResolvedValue([null, null, null, null, null]) };
    vi.mocked(getRedis).mockReturnValue(mockRedis as any);

    await getUsageCounters('ws_abc');
    expect(mockRedis.mget).toHaveBeenCalledWith(
      'usage:ws_abc:messages',
      'usage:ws_abc:api_calls',
      'usage:ws_abc:files',
      'usage:ws_abc:file_bytes',
      'usage:ws_abc:ws_minutes',
    );
  });
});

describe('resetUsageCounters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deletes all usage keys', async () => {
    const mockRedis = { del: vi.fn().mockResolvedValue(5) };
    vi.mocked(getRedis).mockReturnValue(mockRedis as any);

    await resetUsageCounters('ws_123');
    expect(mockRedis.del).toHaveBeenCalledWith(
      'usage:ws_123:messages',
      'usage:ws_123:api_calls',
      'usage:ws_123:files',
      'usage:ws_123:file_bytes',
      'usage:ws_123:ws_minutes',
    );
  });
});

describe('getUsageMetric', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the value of a single metric', async () => {
    const mockRedis = { get: vi.fn().mockResolvedValue('42') };
    vi.mocked(getRedis).mockReturnValue(mockRedis as any);

    const result = await getUsageMetric('ws_123', 'messages');
    expect(result).toBe(42);
    expect(mockRedis.get).toHaveBeenCalledWith('usage:ws_123:messages');
  });

  it('returns 0 for missing metric', async () => {
    const mockRedis = { get: vi.fn().mockResolvedValue(null) };
    vi.mocked(getRedis).mockReturnValue(mockRedis as any);

    const result = await getUsageMetric('ws_123', 'messages');
    expect(result).toBe(0);
  });
});
