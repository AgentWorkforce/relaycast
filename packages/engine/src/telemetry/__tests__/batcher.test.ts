import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BATCH_MAX_BYTES_DEFAULT,
  createBatcher,
  DELIVERY_DEADLINE_DEFAULT_MS,
  EVENT_MAX_BYTES_DEFAULT,
  jsonUtf8Bytes,
  QUEUE_MAX_BYTES_DEFAULT,   FAILURE_LOG_INTERVAL_MS,
  RETRY_DELAY_MAX_MS,
  type BatchAttempt,
  type BatcherOptions,
} from '../batcher.js';

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

  it('finishes flushing an entirely expired queue and accepts later events', async () => {
    const transport = recorder();
    let time = 0;
    const batcher = createBatcher<number>(transport, { ...base, deliveryDeadlineMs: 50 }, {
      now: () => time, log: () => {},
    });
    batcher.enqueue(1);
    time += 50;
    await batcher.flush();
    expect(transport.send).not.toHaveBeenCalled();
    expect(batcher.stats()).toMatchObject({ expired: 1, dropped: 1, queued: 0, inFlight: 0 });
    batcher.enqueue(2);
    await batcher.shutdown();
    expect(transport.batches).toEqual([[2]]);
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
    // The hung batch of 2 is aborted and counted at the deadline (F10); the 3 queued behind it are dropped.
    expect(batcher.stats()).toMatchObject({ dropped: 5, failedBatches: 1, queued: 0, inFlight: 0 });
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
    expect(batcher.stats()).toMatchObject({ exported: 7, dropped: 1, rejected: 1, oversized: 1, failedBatches: 1, splits: 3, retries: 0 });
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
    // Event 2 was never sent; the hung attempt for event 1 was abandoned at its deadline (1000).
    expect(send).toHaveBeenCalledTimes(1);
    expect(batcher.stats()).toMatchObject({ exported: 0, dropped: 2, expired: 2, attemptTimeouts: 1, queued: 0 });
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
    // [0..3] at 0 (fails at 400) -> [0,1] at 400 (fails at 800) -> [0] at 800, abandoned
    // at the deadline (1000) because its 200 ms attempt bound passed; [1] and [2,3]
    // would start past the deadline.
    expect(attempts.map((a) => [a.items, a.at - start, a.timeoutMs])).toEqual([
      [[0, 1, 2, 3], 0, 1000],
      [[0, 1], 400, 600],
      [[0], 800, 200],
    ]);
    expect(batcher.stats()).toMatchObject({ exported: 0, dropped: 4, expired: 4, splits: 2, attemptTimeouts: 1 });
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

describe('byte bounds (UTF-8)', () => {
  // JSON-encoded sizes, measured in UTF-8 bytes, not UTF-16 code units.
  const E_ACUTE = '\u00e9'; // 2 bytes, 1 code unit
  const EMOJI = '\u{1F600}'; // 4 bytes, 2 code units
  const CJK = '\u4e2d'; // 3 bytes, 1 code unit
  const strings = recorderOf<string>();

  function recorderOf<T>() {
    return () => {
      const batches: T[][] = [];
      return { batches, send: vi.fn(async (items: T[]) => { batches.push(items); }) };
    };
  }

  it('measures events in UTF-8 bytes', () => {
    expect(jsonUtf8Bytes(E_ACUTE.repeat(10))).toBe(22);
    expect(E_ACUTE.repeat(10).length + 2).toBe(12);
    expect(jsonUtf8Bytes(EMOJI.repeat(3))).toBe(14);
    expect(jsonUtf8Bytes(CJK.repeat(4))).toBe(14);
    expect(jsonUtf8Bytes({ a: CJK })).toBe(Buffer.byteLength(JSON.stringify({ a: CJK })));
  });

  it('has finite, documented producer defaults', () => {
    expect(EVENT_MAX_BYTES_DEFAULT).toBe(8192);
    expect(BATCH_MAX_BYTES_DEFAULT).toBe(262_144);
    expect(QUEUE_MAX_BYTES_DEFAULT).toBe(1_048_576);
    expect(() => createBatcher(strings(), base)).not.toThrow();
  });

  it('drops and counts an event over eventMaxBytes as oversized, judged by bytes not characters', async () => {
    const transport = strings();
    const log = vi.fn();
    const batcher = createBatcher<string>(transport, { ...base, eventMaxBytes: 16, batchMaxBytes: 64, queueMaxBytes: 64 }, { log });
    batcher.enqueue('e'.repeat(10)); // 12 bytes: fits
    batcher.enqueue(E_ACUTE.repeat(10)); // 12 code units, 22 bytes: oversized
    batcher.enqueue(EMOJI.repeat(3)); // 8 code units, 14 bytes: fits
    batcher.enqueue(CJK.repeat(5)); // 7 code units, 17 bytes: oversized
    expect(batcher.stats()).toMatchObject({ enqueued: 2, dropped: 2, oversized: 2, queueFull: 0, queued: 2, queuedBytes: 26 });
    expect(log.mock.calls[0]![0]).toMatch(/over 16 bytes/);
    await batcher.flush();
    expect(transport.batches).toEqual([['e'.repeat(10), EMOJI.repeat(3)]]);
    expect(batcher.stats()).toMatchObject({ exported: 2, queuedBytes: 0 });
  });

  it('counts an event whose size cannot be measured as oversized', () => {
    const batcher = createBatcher<unknown>(strings(), { ...base, sizeOf: () => { throw new Error('cyclic'); } }, { log: () => {} });
    batcher.enqueue({});
    const nan = createBatcher<unknown>(strings(), { ...base, sizeOf: () => Number.NaN }, { log: () => {} });
    nan.enqueue({});
    expect(batcher.stats()).toMatchObject({ dropped: 1, oversized: 1, enqueued: 0 });
    expect(nan.stats()).toMatchObject({ dropped: 1, oversized: 1, enqueued: 0 });
  });

  it('forms batches within batchMaxBytes, counting frame and separators', async () => {
    const transport = strings();
    // Each event is "\u00e9\u00e9" = 6 bytes; a batch of n is 2 + 6n + (n - 1) bytes, so at most 4 fit in 30.
    const batcher = createBatcher<string>(transport, { ...base, batchMax: 100, eventMaxBytes: 16, batchMaxBytes: 30, queueMaxBytes: 1000 });
    for (let i = 0; i < 6; i += 1) batcher.enqueue(E_ACUTE.repeat(2));
    await batcher.flush();
    expect(transport.batches.map((batch) => batch.length)).toEqual([4, 2]);
    for (const batch of transport.batches) expect(Buffer.byteLength(JSON.stringify(batch))).toBeLessThanOrEqual(30);
    expect(Buffer.byteLength(JSON.stringify(transport.batches[0]))).toBe(29);
  });

  it('sends immediately once a full batch by bytes is queued', async () => {
    const transport = strings();
    const batcher = createBatcher<string>(transport, { ...base, batchMax: 100, eventMaxBytes: 16, batchMaxBytes: 30, queueMaxBytes: 1000 });
    for (let i = 0; i < 4; i += 1) batcher.enqueue(E_ACUTE.repeat(2));
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.batches).toEqual([]);
    batcher.enqueue(E_ACUTE.repeat(2));
    // Well before flushIntervalMs: the byte-full batch goes out and the pump drains the remainder.
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.batches.map((batch) => batch.length)).toEqual([4, 1]);
  });

  it('drops the NEWEST event and counts queueFull when the byte budget is exhausted', async () => {
    const transport = strings();
    const log = vi.fn();
    // Each CJK x4 event is 14 bytes; 40 bytes holds two (28), the third would make 42.
    const batcher = createBatcher<string>(transport, { ...base, queueMax: 100, batchMax: 100, eventMaxBytes: 16, batchMaxBytes: 64, queueMaxBytes: 40 }, { log });
    batcher.enqueue(CJK.repeat(4));
    batcher.enqueue(CJK.repeat(4));
    batcher.enqueue(`${CJK.repeat(3)}z`); // 12 bytes: 28 + 12 = 40 fits exactly
    batcher.enqueue('n'); // 3 bytes: over budget, newest dropped
    expect(batcher.stats()).toMatchObject({ enqueued: 3, dropped: 1, queueFull: 1, oversized: 0, queued: 3, queuedBytes: 40 });
    expect(log.mock.calls[0]![0]).toMatch(/queue full \(40 bytes\); dropped the newest event/);
    await batcher.flush();
    expect(transport.batches).toEqual([[CJK.repeat(4), CJK.repeat(4), `${CJK.repeat(3)}z`]]);
    // Budget is released after sending.
    batcher.enqueue('n');
    expect(batcher.stats()).toMatchObject({ enqueued: 4, queueFull: 1, queuedBytes: 3 });
  });

  it('drops the NEWEST event and counts queueFull when the event count is exhausted', () => {
    const batcher = createBatcher<string>(strings(), { ...base, queueMax: 2, batchMax: 100 }, { log: () => {} });
    for (const item of ['first', 'second', 'newest']) batcher.enqueue(item);
    expect(batcher.stats()).toMatchObject({ enqueued: 2, queueFull: 1, queued: 2 });
  });

  it('releases queued bytes for expired events', async () => {
    const send = vi.fn(() => new Promise<void>((resolve) => { setTimeout(resolve, 1500); }));
    const batcher = createBatcher<string>({ send }, { ...base, batchMax: 1, deliveryDeadlineMs: 1000, eventMaxBytes: 16, batchMaxBytes: 64, queueMaxBytes: 64 }, { log: () => {} });
    batcher.enqueue('a');
    batcher.enqueue('b');
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(batcher.stats()).toMatchObject({ queued: 1, queuedBytes: 3 });
    await vi.advanceTimersByTimeAsync(1500);
    expect(send).toHaveBeenCalledTimes(1);
    // 'b' expired while queued; the hung attempt for 'a' was abandoned at the deadline.
    expect(batcher.stats()).toMatchObject({ queued: 0, queuedBytes: 0, inFlight: 0, inFlightBytes: 0, expired: 2 });
  });

  it('rejects inconsistent byte bounds at construction', () => {
    expect(() => createBatcher(strings(), { ...base, eventMaxBytes: 100, batchMaxBytes: 101 })).toThrow(/batchMaxBytes must hold/);
    expect(() => createBatcher(strings(), { ...base, eventMaxBytes: 100, batchMaxBytes: 102 })).not.toThrow();
    expect(() => createBatcher(strings(), { ...base, eventMaxBytes: 100, batchMaxBytes: 200, batchFrameBytes: 101 })).toThrow(/batchMaxBytes must hold/);
    expect(() => createBatcher(strings(), { ...base, eventMaxBytes: 100, queueMaxBytes: 99 })).toThrow(/queueMaxBytes must be at least/);
    for (const key of ['eventMaxBytes', 'batchMaxBytes', 'queueMaxBytes'] as const) {
      expect(() => createBatcher(strings(), { ...base, [key]: 0 }), key).toThrow(new RegExp(key));
      expect(() => createBatcher(strings(), { ...base, [key]: 1.5 }), key).toThrow(new RegExp(key));
    }
  });
});

describe('configuration failures', () => {
  it('counts a configuration failure separately and logs it as one', async () => {
    const send = vi.fn(async () => {
      throw Object.assign(new Error('x'), { retryable: false, configuration: true, reason: 'collector rejected producer credential (403); check the collector token and deployment id' });
    });
    const log = vi.fn();
    const batcher = createBatcher<number>({ send }, { ...base, batchMax: 2 }, { log });
    for (let i = 0; i < 3; i += 1) batcher.enqueue(i);
    await batcher.flush();
    expect(send).toHaveBeenCalledTimes(2);
    expect(batcher.stats()).toMatchObject({ exported: 0, dropped: 3, rejected: 3, configFailures: 2, failedBatches: 2, retries: 0 });
    expect(log.mock.calls[0]![0]).toMatch(/CONFIGURATION FAILURE.*\(403\).*configFailures=1/);
  });

  it('does not let ordinary failures suppress the configuration-failure log', async () => {
    let calls = 0;
    const send = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('x'), { retryable: false, reason: 'collector rejected batch (400)' });
      throw Object.assign(new Error('x'), { retryable: false, configuration: true, reason: 'collector rejected producer credential (401)' });
    });
    const log = vi.fn();
    const batcher = createBatcher<number>({ send }, { ...base, batchMax: 1 }, { log });
    batcher.enqueue(1);
    batcher.enqueue(2);
    await batcher.flush();
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[0]![0]).not.toMatch(/CONFIGURATION/);
    expect(log.mock.calls[1]![0]).toMatch(/CONFIGURATION FAILURE.*\(401\)/);
  });
});

describe('review repairs (#636): queue bounds and cumulative deadline', () => {
  it('F7: counts the in-flight batch against queueMax, dropping the newest events as queueFull', async () => {
    const send = vi.fn(() => new Promise<void>(() => {})); // never settles
    const batcher = createBatcher<number>({ send }, { ...base, queueMax: 2, batchMax: 2, deliveryDeadlineMs: 60_000 }, { log: () => {} });
    batcher.enqueue(1);
    batcher.enqueue(2);
    void batcher.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(batcher.stats()).toMatchObject({ queued: 0, inFlight: 2 });
    batcher.enqueue(3);
    batcher.enqueue(4);
    expect(batcher.stats()).toMatchObject({ enqueued: 2, dropped: 2, queueFull: 2, queued: 0, inFlight: 2 });
  });

  it('F7: counts the in-flight batch bytes against queueMaxBytes', async () => {
    const send = vi.fn(() => new Promise<void>(() => {}));
    // 'aaaa' is 6 serialized bytes; the queue budget holds two.
    const batcher = createBatcher<string>({ send }, { ...base, batchMax: 2, eventMaxBytes: 6, batchMaxBytes: 64, queueMaxBytes: 12, deliveryDeadlineMs: 60_000 }, { log: () => {} });
    batcher.enqueue('aaaa');
    batcher.enqueue('bbbb');
    void batcher.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(batcher.stats()).toMatchObject({ queuedBytes: 0, inFlightBytes: 12 });
    batcher.enqueue('cccc');
    expect(batcher.stats()).toMatchObject({ enqueued: 2, queueFull: 1, queued: 0 });
  });

  it('F8: split halves inherit the parent batch deadline, never their own later one', async () => {
    const attempts: Array<{ items: number[]; at: number; timeoutMs: number }> = [];
    const send = vi.fn(async (items: number[], attempt?: BatchAttempt) => {
      attempts.push({ items, at: Date.now(), timeoutMs: attempt!.timeoutMs });
      if (items.length > 1) throw Object.assign(new Error('x'), { retryable: false, split: true });
      if (items[0] === 0) await new Promise((resolve) => setTimeout(resolve, 300));
    });
    const start = Date.now();
    const batcher = createBatcher<number>({ send }, { ...base, batchMax: 2, flushIntervalMs: 60_000, deliveryDeadlineMs: 1000 }, { log: () => {} });
    batcher.enqueue(0); // deadline 1000
    await vi.advanceTimersByTimeAsync(600);
    batcher.enqueue(1); // its own deadline would be 1600
    const flushed = batcher.flush();
    await vi.advanceTimersByTimeAsync(5000);
    await flushed;
    // [0,1] at 600 -> split; [0] at 600 (ok at 900); [1] at 900 with only the parent's 100 ms left.
    expect(attempts.map((a) => [a.items, a.at - start, a.timeoutMs])).toEqual([
      [[0, 1], 600, 400],
      [[0], 600, 400],
      [[1], 900, 100],
    ]);
  });

  it('F8: caps a Retry-After hint at the configured retryAfterMaxMs', async () => {
    const at: number[] = [];
    const send = vi.fn(async () => {
      at.push(Date.now());
      if (at.length === 1) throw Object.assign(new Error('busy'), { retryable: true, retryAfterMs: 20_000 });
    });
    const start = Date.now();
    const batcher = createBatcher<number>({ send }, { ...base, retryAfterMaxMs: 1000, deliveryDeadlineMs: 60_000 }, { log: () => {} });
    batcher.enqueue(1);
    const flushed = batcher.flush();
    await vi.advanceTimersByTimeAsync(30_000);
    await flushed;
    expect(at.map((t) => t - start)).toEqual([0, 1000]);
    expect(batcher.stats()).toMatchObject({ exported: 1, retries: 1 });
    expect(() => createBatcher<number>({ send }, { ...base, retryAfterMaxMs: RETRY_DELAY_MAX_MS + 1 })).toThrow(/retryAfterMaxMs/);
  });

  it('F8: abandons an attempt at the delivery deadline even when the transport ignores timeoutMs', async () => {
    const send = vi.fn(() => new Promise<void>(() => {})); // ignores its timeout entirely
    const batcher = createBatcher<number>({ send }, { ...base, deliveryDeadlineMs: 1000 }, { log: () => {} });
    batcher.enqueue(1);
    let done = false;
    void batcher.flush().then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(1001);
    expect(done).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(batcher.stats()).toMatchObject({ exported: 0, dropped: 1, expired: 1, attemptTimeouts: 1, inFlight: 0 });
  });
});

describe('review repairs (#636 re-review): shutdown cancels in-flight work (F10)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function deferredTransport() {
    const calls: Array<{ items: number[]; attempt?: BatchAttempt; release: () => void; fail: (e: unknown) => void }> = [];
    const transport = {
      send: vi.fn((items: number[], attempt?: BatchAttempt) => new Promise<void>((resolve, reject) => {
        calls.push({ items, attempt, release: resolve, fail: reject });
      })),
    };
    return { transport, calls };
  }

  it('F10: aborts an attempt already running before close() at the shutdown deadline, settles counters once and ignores a late 204', async () => {
    const { transport, calls } = deferredTransport();
    const batcher = createBatcher<number>(transport, {
      ...base, batchMax: 10, shutdownTimeoutMs: 20, deliveryDeadlineMs: 60_000,
    }, { log: () => {} });
    batcher.enqueue(1);
    batcher.enqueue(2);
    void batcher.flush();
    await vi.advanceTimersByTimeAsync(0);
    // Started before shutdown, with the full remaining delivery deadline as its timeout.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.attempt!.timeoutMs).toBeGreaterThan(1000);
    const signal = calls[0]!.attempt!.signal!;
    expect(signal.aborted).toBe(false);
    let settled: ReturnType<typeof batcher.stats> | undefined;
    void batcher.shutdown().then(() => { settled = batcher.stats(); });
    await vi.advanceTimersByTimeAsync(19);
    expect(settled).toBeUndefined();
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal.aborted).toBe(true);
    expect(settled).toMatchObject({ enqueued: 2, exported: 0, dropped: 2, failedBatches: 1, queued: 0, inFlight: 0, inFlightBytes: 0 });
    // A late 204 released after close resolved changes nothing.
    calls[0]!.release();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(batcher.stats()).toEqual(settled);
    expect(transport.send).toHaveBeenCalledTimes(1);
  });

  it('F10: a late failure after the shutdown abort is ignored as well (no double count, no retry)', async () => {
    const { transport, calls } = deferredTransport();
    const batcher = createBatcher<number>(transport, { ...base, shutdownTimeoutMs: 20, maxAttempts: 5 }, { log: () => {} });
    batcher.enqueue(1);
    void batcher.flush();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.all([batcher.shutdown(), vi.advanceTimersByTimeAsync(20)]);
    const settled = batcher.stats();
    expect(settled).toMatchObject({ exported: 0, dropped: 1, failedBatches: 1, retries: 0 });
    calls[0]!.fail(Object.assign(new Error('503'), { retryable: true }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(batcher.stats()).toEqual(settled);
    expect(transport.send).toHaveBeenCalledTimes(1);
  });

  it('F10: queued events behind the in-flight batch are dropped once at the deadline and never sent', async () => {
    const { transport, calls } = deferredTransport();
    const batcher = createBatcher<number>(transport, { ...base, batchMax: 2, shutdownTimeoutMs: 20 }, { log: () => {} });
    for (let i = 0; i < 5; i += 1) batcher.enqueue(i);
    void batcher.flush();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.all([batcher.shutdown(), vi.advanceTimersByTimeAsync(20)]);
    expect(batcher.stats()).toMatchObject({ enqueued: 5, exported: 0, dropped: 5, queued: 0, inFlight: 0 });
    calls[0]!.release();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(transport.send).toHaveBeenCalledTimes(1);
    expect(batcher.stats()).toMatchObject({ exported: 0, dropped: 5 });
  });

  it('F10: a batch in a retry wait at close is dropped once at the deadline; no new request starts', async () => {
    const send = vi.fn(async () => { throw Object.assign(new Error('busy'), { retryable: true, retryAfterMs: 10_000 }); });
    const batcher = createBatcher<number>({ send }, { ...base, maxAttempts: 5, shutdownTimeoutMs: 20 }, { log: () => {} });
    batcher.enqueue(1);
    void batcher.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);
    await Promise.all([batcher.shutdown(), vi.advanceTimersByTimeAsync(20)]);
    expect(batcher.stats()).toMatchObject({ exported: 0, dropped: 1, failedBatches: 1, retries: 1, inFlight: 0 });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(batcher.stats()).toMatchObject({ dropped: 1, failedBatches: 1 });
  });

  it('F10: with a split in flight, the running first half is aborted and the unsent second half dropped, each counted once', async () => {
    const calls: Array<{ items: number[]; attempt?: BatchAttempt; release: () => void }> = [];
    const send = vi.fn((items: number[], attempt?: BatchAttempt) => {
      if (items.length === 4) return Promise.reject(Object.assign(new Error('413'), { split: true }));
      return new Promise<void>((resolve) => { calls.push({ items, attempt, release: resolve }); });
    });
    const batcher = createBatcher<number>({ send }, { ...base, batchMax: 4, shutdownTimeoutMs: 20 }, { log: () => {} });
    for (let i = 0; i < 4; i += 1) batcher.enqueue(i);
    void batcher.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.map((c) => c.items)).toEqual([[0, 1]]);
    await Promise.all([batcher.shutdown(), vi.advanceTimersByTimeAsync(20)]);
    expect(calls[0]!.attempt!.signal!.aborted).toBe(true);
    const settled = batcher.stats();
    expect(settled).toMatchObject({ exported: 0, dropped: 4, failedBatches: 2, splits: 1, inFlight: 0 });
    calls[0]!.release();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(send).toHaveBeenCalledTimes(2);
    expect(batcher.stats()).toEqual(settled);
  });

  it('F10: the attempt timeout aborts the transport signal too', async () => {
    const { transport, calls } = deferredTransport();
    const batcher = createBatcher<number>(transport, { ...base, maxAttempts: 1, deliveryDeadlineMs: 100 }, { log: () => {} });
    batcher.enqueue(1);
    void batcher.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls[0]!.attempt!.signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(calls[0]!.attempt!.signal!.aborted).toBe(true);
    expect(batcher.stats()).toMatchObject({ attemptTimeouts: 1, exported: 0, dropped: 1 });
  });
});
