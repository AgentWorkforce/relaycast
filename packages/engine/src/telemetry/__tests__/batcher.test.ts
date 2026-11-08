import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBatcher, DELIVERY_DEADLINE_DEFAULT_MS, FAILURE_LOG_INTERVAL_MS, RETRY_DELAY_MAX_MS, type BatchAttempt, type BatcherOptions } from '../batcher.js';

const base: BatcherOptions = { queueMax: 10, batchMax: 3, flushIntervalMs: 1000, maxAttempts: 3, backoffMs: 100, shutdownTimeoutMs: 500 };

function recorder(fail: (call: number) => boolean = () => false) {
  const batches: number[][] = [];
  let calls = 0;
  return {
    batches,
    get calls() { return calls; },
    send: vi.fn(async (items: number[]) => {
      calls += 1;
      if (fail(calls)) throw new Error('collector down');
      batches.push(items);
    }),
  };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('createBatcher', () => {
  it('drops and counts events beyond queueMax', async () => {
    const transport = recorder();
    const log = vi.fn();
    const batcher = createBatcher<number>(transport, { ...base, queueMax: 4, batchMax: 100 }, { log });
    for (let i = 0; i < 10; i += 1) batcher.enqueue(i);
    expect(batcher.stats()).toMatchObject({ enqueued: 4, dropped: 6, queueFull: 6, queued: 4 });
    expect(log).toHaveBeenCalledTimes(1);
    await batcher.flush();
    expect(transport.batches).toEqual([[0, 1, 2, 3]]);
    expect(batcher.stats()).toMatchObject({ exported: 4, queued: 0 });
  });

  it('splits into batches of at most batchMax', async () => {
    const transport = recorder();
    const batcher = createBatcher<number>(transport, { ...base, batchMax: 3 });
    for (let i = 0; i < 7; i += 1) batcher.enqueue(i);
    await batcher.flush();
    expect(transport.batches).toEqual([[0, 1, 2], [3, 4, 5], [6]]);
    expect(batcher.stats()).toMatchObject({ enqueued: 7, exported: 7, dropped: 0 });
  });

  it('sends a partial batch after flushIntervalMs', async () => {
    const transport = recorder();
    const batcher = createBatcher<number>(transport, base);
    batcher.enqueue(1);
    batcher.enqueue(2);
    await vi.advanceTimersByTimeAsync(999);
    expect(transport.send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(transport.batches).toEqual([[1, 2]]);
  });

  it('retries a failed batch with backoff, then drops it after maxAttempts', async () => {
    const transport = recorder(() => true);
    const log = vi.fn();
    const batcher = createBatcher<number>(transport, base, { log });
    batcher.enqueue(1);
    batcher.enqueue(2);
    batcher.enqueue(3);
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(transport.calls).toBe(2);
    await vi.advanceTimersByTimeAsync(200);
    expect(transport.calls).toBe(3);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(transport.calls).toBe(3);
    expect(batcher.stats()).toMatchObject({ enqueued: 3, exported: 0, dropped: 3, failedBatches: 1, retries: 2, queued: 0 });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toMatch(/dropped a batch of 3 after 3 attempt/);
  });

  it('recovers when a retry succeeds', async () => {
    const transport = recorder((call) => call === 1);
    const batcher = createBatcher<number>(transport, base);
    for (let i = 0; i < 3; i += 1) batcher.enqueue(i);
    await vi.advanceTimersByTimeAsync(100);
    expect(batcher.stats()).toMatchObject({ exported: 3, retries: 1, failedBatches: 0 });
  });

  it('rate-limits failure logging to one line per window', async () => {
    const transport = recorder(() => true);
    const log = vi.fn();
    const batcher = createBatcher<number>(transport, { ...base, maxAttempts: 1, batchMax: 1 }, { log });
    batcher.enqueue(1);
    batcher.enqueue(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(batcher.stats().failedBatches).toBe(2);
    expect(log).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(FAILURE_LOG_INTERVAL_MS);
    batcher.enqueue(3);
    await vi.advanceTimersByTimeAsync(0);
    expect(log).toHaveBeenCalledTimes(2);
  });

  it('never lets a throwing transport escape enqueue', async () => {
    const transport = { send: vi.fn(() => { throw new Error('sync boom'); }) };
    const batcher = createBatcher<number>(transport as never, { ...base, batchMax: 1, maxAttempts: 2 }, { log: () => {} });
    expect(() => batcher.enqueue(1)).not.toThrow();
    await vi.advanceTimersByTimeAsync(1000);
    await expect(batcher.flush()).resolves.toBeUndefined();
    expect(batcher.stats()).toMatchObject({ failedBatches: 1, retries: 1, dropped: 1 });
  });

  it('flushes on shutdown and drops events enqueued afterwards', async () => {
    const transport = recorder();
    const batcher = createBatcher<number>(transport, base, { log: () => {} });
    batcher.enqueue(1);
    batcher.enqueue(2);
    await batcher.shutdown();
    expect(transport.batches).toEqual([[1, 2]]);
    batcher.enqueue(3);
    expect(batcher.stats()).toMatchObject({ exported: 2, dropped: 1 });
    expect(batcher.shutdown()).toBe(batcher.shutdown());
  });

  it('gives up at the shutdown deadline when the collector hangs', async () => {
    const transport = { send: vi.fn(() => new Promise<void>(() => {})) };
    const batcher = createBatcher<number>(transport, { ...base, batchMax: 2 }, { log: () => {} });
    for (let i = 0; i < 5; i += 1) batcher.enqueue(i);
    let done = false;
    void batcher.shutdown().then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(499);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
    // The hung batch of 2 is still in flight; the 3 queued behind it are dropped.
    expect(batcher.stats()).toMatchObject({ dropped: 3, queued: 0 });
    expect(transport.send).toHaveBeenCalledTimes(1);
  });

  it('counts queue-full drops separately from post-shutdown drops', async () => {
    const batcher = createBatcher<number>(recorder(), { ...base, queueMax: 2, batchMax: 100 }, { log: () => {} });
    for (let i = 0; i < 5; i += 1) batcher.enqueue(i);
    await batcher.shutdown();
    batcher.enqueue(9);
    expect(batcher.stats()).toMatchObject({ exported: 2, dropped: 4, queueFull: 3, rejected: 0 });
  });

  it('drops a terminal (retryable: false) batch without retrying and logs its reason', async () => {
    const send = vi.fn(async () => { throw Object.assign(new Error('x'), { retryable: false, reason: 'collector rejected producer credential (401)' }); });
    const log = vi.fn();
    const batcher = createBatcher<number>({ send }, base, { log });
    for (let i = 0; i < 3; i += 1) batcher.enqueue(i);
    await batcher.flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(batcher.stats()).toMatchObject({ exported: 0, dropped: 3, rejected: 3, failedBatches: 1, retries: 0 });
    expect(log.mock.calls[0]![0]).toMatch(/not retried \(collector rejected producer credential \(401\)\).*rejected=3/);
  });

  it('splits a batch in halves on a split hint and drops a single item that still fails', async () => {
    const sent: number[][] = [];
    const send = vi.fn(async (items: number[]) => {
      // Any batch containing 3 is "too large"; everything else is accepted.
      if (items.includes(3)) throw Object.assign(new Error('x'), { retryable: false, split: true });
      sent.push(items);
    });
    const batcher = createBatcher<number>({ send }, { ...base, queueMax: 100, batchMax: 8 }, { log: () => {} });
    for (let i = 0; i < 8; i += 1) batcher.enqueue(i);
    await batcher.flush();
    expect(sent).toEqual([[0, 1], [2], [4, 5, 6, 7]]);
    // 8 -> [0..3] -> [2,3] -> [3]: three splits; depth never exceeds log2(batchMax).
    expect(batcher.stats()).toMatchObject({ exported: 7, dropped: 1, rejected: 1, failedBatches: 1, splits: 3, retries: 0 });
    expect(send).toHaveBeenCalledTimes(7);
  });

  it('honors a retryAfterMs hint longer than the backoff, clamped to RETRY_DELAY_MAX_MS', async () => {
    let calls = 0;
    const send = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('x'), { retryable: true, retryAfterMs: 5000 });
      if (calls === 2) throw Object.assign(new Error('x'), { retryable: true, retryAfterMs: 10 * RETRY_DELAY_MAX_MS });
    });
    const batcher = createBatcher<number>({ send }, { ...base, maxAttempts: 3 }, { log: () => {} });
    batcher.enqueue(1);
    void batcher.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4999);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MAX_MS - 1);
    expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(3);
    expect(batcher.stats()).toMatchObject({ exported: 1, retries: 2 });
  });

  it('re-sends the same item objects on retry', async () => {
    const seen: Array<Array<{ id: string }>> = [];
    let calls = 0;
    const send = vi.fn(async (items: Array<{ id: string }>) => {
      seen.push(items.map((item) => ({ ...item })));
      calls += 1;
      if (calls === 1) throw new Error('collector down');
    });
    const batcher = createBatcher<{ id: string }>({ send }, base, { log: () => {} });
    batcher.enqueue({ id: 'a' });
    batcher.enqueue({ id: 'b' });
    const flushed = batcher.flush();
    await vi.advanceTimersByTimeAsync(100);
    await flushed;
    expect(seen).toEqual([[{ id: 'a' }, { id: 'b' }], [{ id: 'a' }, { id: 'b' }]]);
  });

  it('rejects invalid bounds at construction', () => {
    expect(() => createBatcher(recorder(), { ...base, queueMax: 0 })).toThrow(/queueMax/);
    expect(() => createBatcher(recorder(), { ...base, maxAttempts: 1.5 })).toThrow(/maxAttempts/);
    expect(() => createBatcher(recorder(), { ...base, deliveryDeadlineMs: 0 })).toThrow(/deliveryDeadlineMs/);
    expect(() => createBatcher(recorder(), { ...base, deliveryDeadlineMs: Number.POSITIVE_INFINITY })).toThrow(/deliveryDeadlineMs/);
  });
});

describe('delivery deadline', () => {
  const retryable = (retryAfterMs?: number) => Object.assign(new Error('x'), { retryable: true, ...(retryAfterMs ? { retryAfterMs } : {}) });

  it('defaults to a finite 60 s', () => {
    expect(DELIVERY_DEADLINE_DEFAULT_MS).toBe(60_000);
  });

  it('drops a batch whose backoff would pass the deadline instead of waiting', async () => {
    const send = vi.fn(async () => { throw retryable(); });
    const log = vi.fn();
    // backoff 100, 200, 300...: attempts at t=0, 100, 300; the next wait (300) would end at 600 > 500.
    const batcher = createBatcher<number>({ send }, { ...base, maxAttempts: 10, deliveryDeadlineMs: 500 }, { log });
    batcher.enqueue(1);
    const flushed = batcher.flush();
    await vi.advanceTimersByTimeAsync(300);
    await flushed;
    expect(send).toHaveBeenCalledTimes(3);
    expect(batcher.stats()).toMatchObject({ exported: 0, dropped: 1, expired: 1, failedBatches: 1, retries: 2 });
    expect(log.mock.calls[0]![0]).toMatch(/delivery deadline/);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('drops a batch whose Retry-After wait would pass the deadline', async () => {
    const send = vi.fn(async () => { throw retryable(20_000); });
    const batcher = createBatcher<number>({ send }, { ...base, deliveryDeadlineMs: 10_000 }, { log: () => {} });
    batcher.enqueue(1);
    await batcher.flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(batcher.stats()).toMatchObject({ dropped: 1, expired: 1, retries: 0 });
  });

  it('counts time spent queued and in earlier attempts against the deadline', async () => {
    const attempts: BatchAttempt[] = [];
    let calls = 0;
    const send = vi.fn(async (_items: number[], attempt?: BatchAttempt) => {
      attempts.push(attempt!);
      calls += 1;
      if (calls === 1) await new Promise((resolve) => setTimeout(resolve, 600));
      throw retryable();
    });
    const batcher = createBatcher<number>({ send }, { ...base, maxAttempts: 10, flushIntervalMs: 300, deliveryDeadlineMs: 1000 }, { log: () => {} });
    batcher.enqueue(1);
    // Queued 300 ms, first attempt takes 600 ms, backoff 100: the second attempt starts at 1000 = deadline.
    await vi.advanceTimersByTimeAsync(2000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(attempts[0]!.timeoutMs).toBe(700);
    expect(batcher.stats()).toMatchObject({ dropped: 1, expired: 1 });
  });

  it('drops queued events whose deadline passed before they were sent', async () => {
    let release: () => void = () => {};
    let calls = 0;
    const send = vi.fn(async () => {
      calls += 1;
      if (calls === 1) await new Promise<void>((resolve) => { release = resolve; });
    });
    const batcher = createBatcher<number>({ send }, { ...base, batchMax: 1, deliveryDeadlineMs: 1000 }, { log: () => {} });
    batcher.enqueue(1);
    batcher.enqueue(2);
    await vi.advanceTimersByTimeAsync(1500);
    release();
    await batcher.flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(batcher.stats()).toMatchObject({ exported: 1, dropped: 1, expired: 1, queued: 0 });
  });

  it('keeps the original enqueue deadline for split halves', async () => {
    const attempts: Array<{ items: number[]; at: number; timeoutMs: number }> = [];
    const send = vi.fn(async (items: number[], attempt?: BatchAttempt) => {
      attempts.push({ items, at: Date.now(), timeoutMs: attempt!.timeoutMs });
      await new Promise((resolve) => setTimeout(resolve, 400));
      if (items.length > 1) throw Object.assign(new Error('x'), { retryable: false, split: true });
    });
    const start = Date.now();
    const batcher = createBatcher<number>({ send }, { ...base, batchMax: 4, deliveryDeadlineMs: 1000 }, { log: () => {} });
    for (let i = 0; i < 4; i += 1) batcher.enqueue(i);
    const flushed = batcher.flush();
    await vi.advanceTimersByTimeAsync(5000);
    await flushed;
    // [0..3] at 0 (fails at 400) -> [0,1] at 400 (fails at 800) -> [0] at 800 (ok at 1200);
    // [1] would start at 1200, past the deadline at 1000, as would [2,3].
    expect(attempts.map((a) => [a.items, a.at - start, a.timeoutMs])).toEqual([
      [[0, 1, 2, 3], 0, 1000],
      [[0, 1], 400, 600],
      [[0], 800, 200],
    ]);
    expect(batcher.stats()).toMatchObject({ exported: 1, dropped: 3, expired: 3, splits: 2 });
  });

  it('clips the per-attempt timeout to the shutdown deadline', async () => {
    const attempts: BatchAttempt[] = [];
    const send = vi.fn(async (_items: number[], attempt?: BatchAttempt) => { attempts.push(attempt!); });
    const batcher = createBatcher<number>({ send }, { ...base, shutdownTimeoutMs: 500, deliveryDeadlineMs: 60_000 }, { log: () => {} });
    batcher.enqueue(1);
    await batcher.flush();
    batcher.enqueue(2);
    await batcher.shutdown();
    expect(attempts.map((a) => a.timeoutMs)).toEqual([60_000, 500]);
  });
});
