import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseIdempotencyKey, runIdempotent } from '../idempotency.js';
import { createMockKV } from '../../__tests__/test-helpers.js';

describe('idempotency helpers', () => {
  describe('parseIdempotencyKey()', () => {
    it('returns empty object when header is undefined', () => {
      expect(parseIdempotencyKey(undefined)).toEqual({});
    });

    it('rejects empty key', () => {
      expect(parseIdempotencyKey('   ').error).toContain('cannot be empty');
    });

    it('accepts visible ASCII key', () => {
      expect(parseIdempotencyKey('abc-123:_KEY')).toEqual({ key: 'abc-123:_KEY' });
    });

    it('rejects key with whitespace', () => {
      expect(parseIdempotencyKey('key with space').error).toContain('visible ASCII');
    });

    it('rejects key exceeding max length', () => {
      const longKey = 'a'.repeat(256);
      expect(parseIdempotencyKey(longKey).error).toContain('255 characters');
    });

    it('trims key before validation', () => {
      // A key that is only whitespace after trim is empty
      expect(parseIdempotencyKey('  ').error).toContain('cannot be empty');
    });
  });

  describe('runIdempotent()', () => {
    let kv: KVNamespace;

    beforeEach(() => {
      kv = createMockKV();
      vi.clearAllMocks();
    });

    it('runs operation directly when no key is provided', async () => {
      const op = vi.fn(async () => ({ id: 'm1' }));

      const a = await runIdempotent({
        workspaceId: 'ws1',
        actorId: 'a1',
        scope: 'dm:direct',
        kv,
        operation: op,
      });
      const b = await runIdempotent({
        workspaceId: 'ws1',
        actorId: 'a1',
        scope: 'dm:direct',
        kv,
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
        kv,
        operation: op,
      });

      const second = await runIdempotent({
        workspaceId: 'ws1',
        actorId: 'a1',
        scope: 'channel:general',
        key: 'idem-1',
        fingerprint: '{"text":"hello"}',
        kv,
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
        kv,
        operation: op,
      });

      await expect(
        runIdempotent({
          workspaceId: 'ws1',
          actorId: 'a1',
          scope: 'channel:general',
          key: 'idem-1',
          fingerprint: '{"text":"different"}',
          kv,
          operation: op,
        }),
      ).rejects.toMatchObject({ code: 'idempotency_key_reused', status: 409 });
    });

    it('returns conflict when same key is currently processing (lock held)', async () => {
      // Simulate a lock being held by pre-populating the lock key
      // We need to intercept the KV calls to simulate the lock scenario
      const lockKv = createMockKV();
      let getCallCount = 0;
      vi.mocked(lockKv.get).mockImplementation(async (key: string) => {
        getCallCount++;
        if (typeof key === 'string' && key.endsWith(':lock')) {
          return '1'; // lock is held
        }
        return null; // no existing result
      });

      await expect(
        runIdempotent({
          workspaceId: 'ws1',
          actorId: 'a1',
          scope: 'channel:general',
          key: 'idem-1',
          fingerprint: '{"text":"hello"}',
          kv: lockKv,
          operation: async () => ({ id: 'm1' }),
        }),
      ).rejects.toMatchObject({ code: 'idempotency_in_progress', status: 409 });
    });

    it('proceeds without idempotency when kv is not provided', async () => {
      const op = vi.fn(async () => ({ id: 'm1' }));

      const result = await runIdempotent({
        workspaceId: 'ws1',
        actorId: 'a1',
        scope: 'channel:general',
        key: 'idem-1',
        operation: op,
      });

      expect(result.replayed).toBe(false);
      expect(op).toHaveBeenCalledTimes(1);
    });

    it('preserves custom status code', async () => {
      const op = vi.fn(async () => ({ id: 'm1' }));

      const result = await runIdempotent({
        workspaceId: 'ws1',
        actorId: 'a1',
        scope: 'channel:general',
        key: 'idem-1',
        status: 200,
        kv,
        operation: op,
      });

      expect(result.status).toBe(200);
    });

    it('cleans up lock on operation failure', async () => {
      const op = vi.fn(async () => {
        throw new Error('operation failed');
      });

      await expect(
        runIdempotent({
          workspaceId: 'ws1',
          actorId: 'a1',
          scope: 'channel:general',
          key: 'idem-1',
          kv,
          operation: op,
        }),
      ).rejects.toThrow('operation failed');

      // Lock should have been cleaned up via delete
      expect(kv.delete).toHaveBeenCalled();
    });

    it('falls back to non-idempotent when KV fails during read', async () => {
      const brokenKv = createMockKV();
      vi.mocked(brokenKv.get).mockRejectedValue(new Error('KV down'));

      const op = vi.fn(async () => ({ id: 'm1' }));

      const result = await runIdempotent({
        workspaceId: 'ws1',
        actorId: 'a1',
        scope: 'channel:general',
        key: 'idem-1',
        kv: brokenKv,
        operation: op,
      });

      expect(result.replayed).toBe(false);
      expect(op).toHaveBeenCalledTimes(1);
    });
  });
});
