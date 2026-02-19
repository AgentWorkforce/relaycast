import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockKV } from '../../__tests__/test-helpers.js';
import {
  incrementUsage,
  getUsageCounters,
  resetUsageCounters,
  getUsageMetric,
} from '../usage.js';

describe('usage engine (KV-based)', () => {
  let kv: KVNamespace;

  beforeEach(() => {
    kv = createMockKV();
    vi.clearAllMocks();
  });

  describe('incrementUsage', () => {
    it('increments from zero', async () => {
      const result = await incrementUsage(kv, 'ws_123', 'messages');
      expect(result).toBe(1);
      expect(kv.put).toHaveBeenCalledWith('usage:ws_123:messages', '1');
    });

    it('increments existing value', async () => {
      vi.mocked(kv.get).mockResolvedValue('41');
      const result = await incrementUsage(kv, 'ws_123', 'messages');
      expect(result).toBe(42);
      expect(kv.put).toHaveBeenCalledWith('usage:ws_123:messages', '42');
    });

    it('increments by custom amount', async () => {
      vi.mocked(kv.get).mockResolvedValue('10');
      const result = await incrementUsage(kv, 'ws_123', 'file_bytes', 1024);
      expect(result).toBe(1034);
      expect(kv.put).toHaveBeenCalledWith('usage:ws_123:file_bytes', '1034');
    });

    it('reads the correct KV key', async () => {
      await incrementUsage(kv, 'ws_456', 'api_calls');
      expect(kv.get).toHaveBeenCalledWith('usage:ws_456:api_calls');
    });
  });

  describe('getUsageCounters', () => {
    it('returns all metrics as zero when no data', async () => {
      const counters = await getUsageCounters(kv, 'ws_123');
      expect(counters).toEqual({
        messages: 0,
        api_calls: 0,
        files: 0,
        file_bytes: 0,
        ws_minutes: 0,
      });
    });

    it('returns parsed values from KV', async () => {
      vi.mocked(kv.get).mockImplementation(async (key: string) => {
        const values: Record<string, string> = {
          'usage:ws_123:messages': '100',
          'usage:ws_123:api_calls': '500',
          'usage:ws_123:files': '10',
          'usage:ws_123:file_bytes': '2048',
          'usage:ws_123:ws_minutes': '60',
        };
        return values[key as string] ?? null;
      });

      const counters = await getUsageCounters(kv, 'ws_123');
      expect(counters).toEqual({
        messages: 100,
        api_calls: 500,
        files: 10,
        file_bytes: 2048,
        ws_minutes: 60,
      });
    });

    it('fetches all 5 metric keys', async () => {
      await getUsageCounters(kv, 'ws_123');
      expect(kv.get).toHaveBeenCalledTimes(5);
      expect(kv.get).toHaveBeenCalledWith('usage:ws_123:messages');
      expect(kv.get).toHaveBeenCalledWith('usage:ws_123:api_calls');
      expect(kv.get).toHaveBeenCalledWith('usage:ws_123:files');
      expect(kv.get).toHaveBeenCalledWith('usage:ws_123:file_bytes');
      expect(kv.get).toHaveBeenCalledWith('usage:ws_123:ws_minutes');
    });
  });

  describe('resetUsageCounters', () => {
    it('deletes all metric keys', async () => {
      await resetUsageCounters(kv, 'ws_123');
      expect(kv.delete).toHaveBeenCalledTimes(5);
      expect(kv.delete).toHaveBeenCalledWith('usage:ws_123:messages');
      expect(kv.delete).toHaveBeenCalledWith('usage:ws_123:api_calls');
      expect(kv.delete).toHaveBeenCalledWith('usage:ws_123:files');
      expect(kv.delete).toHaveBeenCalledWith('usage:ws_123:file_bytes');
      expect(kv.delete).toHaveBeenCalledWith('usage:ws_123:ws_minutes');
    });
  });

  describe('getUsageMetric', () => {
    it('returns zero when key does not exist', async () => {
      const result = await getUsageMetric(kv, 'ws_123', 'messages');
      expect(result).toBe(0);
    });

    it('returns parsed value from KV', async () => {
      vi.mocked(kv.get).mockResolvedValue('42');
      const result = await getUsageMetric(kv, 'ws_123', 'messages');
      expect(result).toBe(42);
      expect(kv.get).toHaveBeenCalledWith('usage:ws_123:messages');
    });
  });
});
