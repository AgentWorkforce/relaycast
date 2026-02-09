import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseIdempotencyKey, runIdempotent } from '../idempotency.js';

const store = new Map<string, string>();

const mockRedis = {
  get: vi.fn(async (key: string) => store.get(key) ?? null),
  set: vi.fn(async (key: string, value: string, ...args: unknown[]) => {
    const useNx = args.includes('NX');
    if (useNx && store.has(key)) {
      return null;
    }
    store.set(key, value);
    return 'OK';
  }),
  del: vi.fn(async (key: string) => {
    store.delete(key);
    return 1;
  }),
};

vi.mock('../../redis/index.js', () => ({
  getRedis: vi.fn(() => mockRedis),
}));

describe('idempotency middleware helpers', () => {
  beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
  });

  describe('parseIdempotencyKey()', () => {
    it('returns undefined when header is absent', () => {
      const req = { header: vi.fn(() => undefined) } as any;
      expect(parseIdempotencyKey(req)).toEqual({});
    });

    it('rejects empty key', () => {
      const req = { header: vi.fn(() => '   ') } as any;
      expect(parseIdempotencyKey(req).error).toContain('cannot be empty');
    });

    it('accepts visible ASCII key', () => {
      const req = { header: vi.fn(() => 'abc-123:_KEY') } as any;
      expect(parseIdempotencyKey(req)).toEqual({ key: 'abc-123:_KEY' });
    });
  });

  describe('runIdempotent()', () => {
    it('runs operation directly when no key is provided', async () => {
      const op = vi.fn(async () => ({ id: 'm1' }));

      const a = await runIdempotent({
        workspaceId: 'ws1',
        actorId: 'a1',
        scope: 'dm:direct',
        operation: op,
      });
      const b = await runIdempotent({
        workspaceId: 'ws1',
        actorId: 'a1',
        scope: 'dm:direct',
        operation: op,
      });

      expect(a.replayed).toBe(false);
      expect(b.replayed).toBe(false);
      expect(op).toHaveBeenCalledTimes(2);
    });

    it('replays stored response for same key and fingerprint', async () => {
      const op = vi.fn(async () => ({ id: 'm1' }));

      const first = await runIdempotent({
        workspaceId: 'ws1',
        actorId: 'a1',
        scope: 'channel:general',
        key: 'idem-1',
        fingerprint: '{"text":"hello"}',
        operation: op,
      });

      const second = await runIdempotent({
        workspaceId: 'ws1',
        actorId: 'a1',
        scope: 'channel:general',
        key: 'idem-1',
        fingerprint: '{"text":"hello"}',
        operation: op,
      });

      expect(first.replayed).toBe(false);
      expect(second.replayed).toBe(true);
      expect(second.data).toEqual(first.data);
      expect(op).toHaveBeenCalledTimes(1);
    });

    it('rejects same key reused with different fingerprint', async () => {
      const op = vi.fn(async () => ({ id: 'm1' }));

      await runIdempotent({
        workspaceId: 'ws1',
        actorId: 'a1',
        scope: 'channel:general',
        key: 'idem-1',
        fingerprint: '{"text":"hello"}',
        operation: op,
      });

      await expect(
        runIdempotent({
          workspaceId: 'ws1',
          actorId: 'a1',
          scope: 'channel:general',
          key: 'idem-1',
          fingerprint: '{"text":"different"}',
          operation: op,
        }),
      ).rejects.toMatchObject({ code: 'idempotency_key_reused', status: 409 });
    });

    it('returns conflict when same key is currently processing', async () => {
      const setSpy = vi.spyOn(mockRedis, 'set');
      // First SET is lock acquisition, force lock miss (already in progress)
      setSpy.mockResolvedValueOnce(null as any);

      await expect(
        runIdempotent({
          workspaceId: 'ws1',
          actorId: 'a1',
          scope: 'channel:general',
          key: 'idem-1',
          fingerprint: '{"text":"hello"}',
          operation: async () => ({ id: 'm1' }),
        }),
      ).rejects.toMatchObject({ code: 'idempotency_in_progress', status: 409 });
    });
  });
});
