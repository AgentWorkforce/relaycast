import { describe, expect, it, vi } from 'vitest';
import { runIdempotent } from '../middleware/idempotency.js';

const identity = { workspaceId: 'fixture', actorId: 'actor', scope: 'test', key: 'key' };

describe('idempotency storage requirements', () => {
  it.each([{ requireKv: true }, { requireKvRead: true }, { requireKv: true, requireKvRead: true }])(
    'refuses missing storage before operation with %j', async (requirements) => {
      const operation = vi.fn(async () => 'must not commit');
      await expect(runIdempotent({ ...identity, ...requirements, operation }))
        .rejects.toMatchObject({ status: 503, code: 'idempotency_unavailable' });
      expect(operation).not.toHaveBeenCalled();
    },
  );

  it('preserves optional storage and unkeyed request behavior', async () => {
    const operation = vi.fn(async () => 'accepted');
    await expect(runIdempotent({ ...identity, requireKvRead: false, operation })).resolves.toMatchObject({ data: 'accepted' });
    await expect(runIdempotent({ ...identity, key: undefined, operation })).resolves.toMatchObject({ data: 'accepted' });
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('requires readable storage without failing an accepted operation on completion loss', async () => {
    const operation = vi.fn(async () => 'committed');
    const kv = { get: vi.fn(async () => null), put: vi.fn(async (_key: string, _value: string) => {}), delete: vi.fn(async () => {}), increment: vi.fn(async () => 1) };
    kv.put.mockImplementation(async (key) => { if (!key.endsWith(':lock')) throw new Error('completion loss'); });
    await expect(runIdempotent({ ...identity, requireKvRead: true, kv, operation }))
      .resolves.toMatchObject({ data: 'committed', replayed: false });
    expect(operation).toHaveBeenCalledTimes(1);
    operation.mockClear();
    kv.get.mockRejectedValue(new Error('read outage'));
    await expect(runIdempotent({ ...identity, requireKvRead: true, kv, operation }))
      .rejects.toMatchObject({ status: 503, code: 'idempotency_unavailable' });
    expect(operation).not.toHaveBeenCalled();
  });
});
