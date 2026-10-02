import { describe, expect, it, vi } from 'vitest';
import { buildIdempotencyStorageKey, runIdempotent } from '../middleware/idempotency.js';
import type { KeyValueStore } from '../ports/kv.js';

const identity = { workspaceId: 'ws_perf', actorId: 'agt_perf', scope: 'dm:direct', key: 'join-announce-1' };

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

interface TracingKv extends KeyValueStore {
  /** Operations grouped by serialized round trip: one group per set of in-flight calls. */
  readonly roundTrips: string[][];
  /** Operations started but not yet settled. */
  readonly inFlight: number;
  readonly puts: Array<{ label: string; value: string; expirationTtl?: number }>;
  /** Hook run as an operation settles, so a test can land a concurrent write. */
  onSettled?: (label: string) => void;
  seed(label: 'record' | 'lock', value: string): void;
  failOn(label: string, error: Error): void;
}

/**
 * KV double that gives every call a real tick of latency, so calls issued
 * together land in one round-trip group and serialized calls land in their own.
 */
function tracingKv(recordKey: string): TracingKv {
  const store = new Map<string, string>();
  const roundTrips: string[][] = [];
  const failures = new Map<string, Error>();
  const puts: Array<{ label: string; value: string; expirationTtl?: number }> = [];
  let inFlight = 0;

  const labelOf = (key: string, op: string) => `${op}:${key.endsWith(':lock') ? 'lock' : 'record'}`;

  const run = async <T>(op: string, key: string, body: () => T): Promise<T> => {
    const label = labelOf(key, op);
    if (inFlight === 0) roundTrips.push([]);
    roundTrips[roundTrips.length - 1]!.push(label);
    inFlight += 1;
    try {
      await tick();
      kv.onSettled?.(label);
      const failure = failures.get(label);
      if (failure) throw failure;
      return body();
    } finally {
      inFlight -= 1;
    }
  };

  const kv: TracingKv = {
    roundTrips,
    puts,
    get inFlight() { return inFlight; },
    seed(label, value) { store.set(label === 'lock' ? `${recordKey}:lock` : recordKey, value); },
    failOn(label, error) { failures.set(label, error); },
    get: (key) => run('get', key, () => store.get(key) ?? null),
    put: (key, value, options) => run('put', key, () => {
      puts.push({ label: labelOf(key, 'put'), value, expirationTtl: options?.expirationTtl });
      store.set(key, value);
    }),
    delete: (key) => run('delete', key, () => { store.delete(key); }),
    increment: async () => { throw new Error('increment is not part of the idempotency path'); },
  };
  return kv;
}

const storageKey = () => buildIdempotencyStorageKey(identity.workspaceId, identity.actorId, identity.scope, identity.key);

const flat = (kv: TracingKv) => kv.roundTrips.flat();

describe('idempotency KV round trips', () => {
  it('spends four serialized KV round trips on a fresh key', async () => {
    const kv = tracingKv(await storageKey());
    let inFlightAtOperation = -1;
    const operation = vi.fn(async () => {
      inFlightAtOperation = kv.inFlight;
      await tick();
      return { id: 'msg_1' };
    });

    await expect(runIdempotent({ ...identity, kv, operation }))
      .resolves.toMatchObject({ status: 201, replayed: false, data: { id: 'msg_1' } });

    // The record and lock reads share one round trip. The lock write and the
    // post-lock record fence remain serialized before the operation, and the
    // result write follows it.
    expect(kv.roundTrips).toEqual([
      ['get:record', 'get:lock'],
      ['put:lock'],
      ['get:record'],
      ['put:record'],
    ]);
    expect(inFlightAtOperation).toBe(0);
  });

  it('replays a completed record from the first read round trip', async () => {
    const kv = tracingKv(await storageKey());
    kv.seed('record', JSON.stringify({ status: 201, data: { id: 'msg_1' }, fingerprint: 'fp-a' }));
    const operation = vi.fn(async () => ({ id: 'msg_2' }));

    await expect(runIdempotent({ ...identity, kv, fingerprint: 'fp-a', operation }))
      .resolves.toEqual({ status: 201, replayed: true, data: { id: 'msg_1' } });
    expect(operation).not.toHaveBeenCalled();
    expect(kv.roundTrips).toEqual([['get:record', 'get:lock']]);
  });

  it('rejects a key reused with a different payload without running the operation', async () => {
    const kv = tracingKv(await storageKey());
    kv.seed('record', JSON.stringify({ status: 201, data: { id: 'msg_1' }, fingerprint: 'fp-a' }));
    const operation = vi.fn(async () => ({ id: 'msg_2' }));

    await expect(runIdempotent({ ...identity, kv, fingerprint: 'fp-b', operation }))
      .rejects.toMatchObject({ status: 409, code: 'idempotency_key_reused' });
    expect(operation).not.toHaveBeenCalled();
  });

  it('rejects a request that finds a held lock and no record', async () => {
    const kv = tracingKv(await storageKey());
    kv.seed('lock', '1');
    const operation = vi.fn(async () => ({ id: 'msg_2' }));

    await expect(runIdempotent({ ...identity, kv, operation }))
      .rejects.toMatchObject({ status: 409, code: 'idempotency_in_progress' });
    expect(operation).not.toHaveBeenCalled();
    // Only the contended path pays the extra record read.
    expect(kv.roundTrips).toEqual([['get:record', 'get:lock'], ['get:record']]);
  });

  it('replays a record that lands while the lock is still held', async () => {
    const kv = tracingKv(await storageKey());
    kv.seed('lock', '1');
    kv.onSettled = (label) => {
      if (label !== 'get:record') return;
      kv.onSettled = undefined;
      kv.seed('record', JSON.stringify({ status: 201, data: { id: 'msg_1' }, fingerprint: 'fp-a' }));
    };
    const operation = vi.fn(async () => ({ id: 'msg_2' }));

    await expect(runIdempotent({ ...identity, kv, fingerprint: 'fp-a', operation }))
      .resolves.toEqual({ status: 201, replayed: true, data: { id: 'msg_1' } });
    expect(operation).not.toHaveBeenCalled();
  });

  it('replays a concurrent result that lands while this caller writes its lock', async () => {
    const kv = tracingKv(await storageKey());
    kv.onSettled = (label) => {
      if (label !== 'put:lock') return;
      kv.onSettled = undefined;
      kv.seed('record', JSON.stringify({ status: 201, data: { id: 'msg_1' }, fingerprint: 'fp-a' }));
    };
    const operation = vi.fn(async () => ({ id: 'msg_2' }));

    await expect(runIdempotent({ ...identity, kv, fingerprint: 'fp-a', operation }))
      .resolves.toEqual({ status: 201, replayed: true, data: { id: 'msg_1' } });
    expect(operation).not.toHaveBeenCalled();
    expect(kv.roundTrips).toEqual([
      ['get:record', 'get:lock'],
      ['put:lock'],
      ['get:record'],
    ]);
    expect(flat(kv)).not.toContain('delete:lock');
  });

  it.each([{}, { requireKvRead: true }, { requireKv: true }])(
    'releases its lock when the post-lock record recheck fails, with %j', async (requirement) => {
      const kv = tracingKv(await storageKey());
      let recordReads = 0;
      kv.onSettled = (label) => {
        if (label !== 'get:record' || ++recordReads !== 2) return;
        kv.failOn('get:record', new Error('recheck outage'));
      };
      const operation = vi.fn(async () => ({ id: 'msg_1' }));
      const run = runIdempotent({ ...identity, ...requirement, kv, operation });

      if (requirement.requireKvRead || requirement.requireKv) {
        await expect(run).rejects.toMatchObject({ status: 503, code: 'idempotency_unavailable' });
        expect(operation).not.toHaveBeenCalled();
      } else {
        await expect(run).resolves.toMatchObject({ replayed: false, data: { id: 'msg_1' } });
        expect(operation).toHaveBeenCalledTimes(1);
      }
      expect(flat(kv)).toContain('delete:lock');
    },
  );

  it('leaves no lock behind when the operation fails, so a retry runs fresh', async () => {
    const kv = tracingKv(await storageKey());
    const failing = vi.fn(async () => { throw new Error('d1 write failed'); });

    await expect(runIdempotent({ ...identity, kv, operation: failing })).rejects.toThrow('d1 write failed');
    expect(flat(kv)).toContain('delete:lock');

    const retry = vi.fn(async () => ({ id: 'msg_1' }));
    await expect(runIdempotent({ ...identity, kv, operation: retry }))
      .resolves.toMatchObject({ replayed: false, data: { id: 'msg_1' } });
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('leaves no lock behind when the record write fails, so a retry runs fresh', async () => {
    const kv = tracingKv(await storageKey());
    kv.failOn('put:record', new Error('completion loss'));
    const operation = vi.fn(async () => ({ id: 'msg_1' }));

    await expect(runIdempotent({ ...identity, kv, operation }))
      .resolves.toMatchObject({ replayed: false, data: { id: 'msg_1' } });
    expect(flat(kv)).toContain('delete:lock');

    const retry = vi.fn(async () => ({ id: 'msg_2' }));
    await expect(runIdempotent({ ...identity, kv, operation: retry }))
      .resolves.toMatchObject({ replayed: false, data: { id: 'msg_2' } });
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('keeps the lock write ahead of the operation when storage is mandatory', async () => {
    for (const requirement of [{ requireKv: true }, { requireKvRead: true }]) {
      const kv = tracingKv(await storageKey());
      kv.failOn('put:lock', new Error('kv write outage'));
      const operation = vi.fn(async () => ({ id: 'msg_1' }));

      await expect(runIdempotent({ ...identity, ...requirement, kv, operation }))
        .rejects.toMatchObject({ status: 503, code: 'idempotency_unavailable' });
      expect(operation).not.toHaveBeenCalled();
    }
  });

  it.each([{}, { requireKvRead: true }, { requireKv: true }])(
    'replays a stored record when only the lock read fails, with %j', async (requirement) => {
      const kv = tracingKv(await storageKey());
      kv.seed('record', JSON.stringify({ status: 201, data: { id: 'msg_1' }, fingerprint: 'fp-a' }));
      kv.failOn('get:lock', new Error('lock read outage'));
      const operation = vi.fn(async () => ({ id: 'msg_2' }));

      // The record read alone proves the replay, so pairing it with the lock
      // read must not let a lock-read failure re-run a committed operation.
      await expect(runIdempotent({ ...identity, ...requirement, kv, fingerprint: 'fp-a', operation }))
        .resolves.toEqual({ status: 201, replayed: true, data: { id: 'msg_1' } });
      expect(operation).not.toHaveBeenCalled();
    },
  );

  it.each([{}, { requireKvRead: true }])(
    'treats a failed record read as a read failure, with %j', async (requirement) => {
      const kv = tracingKv(await storageKey());
      kv.failOn('get:record', new Error('record read outage'));
      const operation = vi.fn(async () => ({ id: 'msg_1' }));
      const run = runIdempotent({ ...identity, ...requirement, kv, operation });

      if (requirement.requireKvRead) {
        await expect(run).rejects.toMatchObject({ status: 503, code: 'idempotency_unavailable' });
        expect(operation).not.toHaveBeenCalled();
      } else {
        // Optional storage degrades to running the operation unprotected.
        await expect(run).resolves.toMatchObject({ replayed: false, data: { id: 'msg_1' } });
      }
    },
  );

  it('stores a rollback-compatible primary fingerprint with a canonical alias', async () => {
    const kv = tracingKv(await storageKey());
    const oldEngineFingerprint = JSON.stringify({
      to: 'bob', text: 'hello', data_sha256: 'insertion-order-digest',
    });
    const canonicalFingerprint = JSON.stringify({
      to: 'bob', text: 'hello', data_sha256: 'canonical-digest',
    });
    const operation = vi.fn(async () => ({ id: 'msg_1' }));

    await runIdempotent({
      ...identity,
      kv,
      fingerprint: canonicalFingerprint,
      storageFingerprint: oldEngineFingerprint,
      compatibleFingerprints: [oldEngineFingerprint],
      operation,
    });

    const stored = JSON.parse(kv.puts.find((put) => put.label === 'put:record')!.value) as {
      fingerprint: string;
      fingerprints: string[];
    };
    // A rolled-back engine compares only this legacy primary field and ignores
    // the additive aliases property, so it accepts the newly written record.
    expect(stored.fingerprint).toBe(oldEngineFingerprint);
    expect(stored.fingerprints).toEqual([canonicalFingerprint]);

    const replayOperation = vi.fn(async () => ({ id: 'msg_2' }));
    await expect(runIdempotent({
      ...identity,
      kv,
      fingerprint: canonicalFingerprint,
      storageFingerprint: oldEngineFingerprint,
      compatibleFingerprints: [oldEngineFingerprint],
      operation: replayOperation,
    })).resolves.toEqual({ status: 201, replayed: true, data: { id: 'msg_1' } });
    expect(replayOperation).not.toHaveBeenCalled();
  });

  it('bounds retention for both the lock and the stored record', async () => {
    const kv = tracingKv(await storageKey());
    await runIdempotent({ ...identity, kv, ttlSeconds: 600, operation: async () => ({ id: 'msg_1' }) });

    expect(kv.puts).toEqual([
      { label: 'put:lock', value: '1', expirationTtl: 30 },
      { label: 'put:record', value: JSON.stringify({ status: 201, data: { id: 'msg_1' } }), expirationTtl: 600 },
    ]);
  });
});
