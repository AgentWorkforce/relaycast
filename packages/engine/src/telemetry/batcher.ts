/**
 * Bounded asynchronous export queue. One batch is in flight at a time; the
 * queue never holds more than `queueMax` events (plus the one batch being
 * sent); a failed batch is retried at most `maxAttempts` times and then
 * dropped. Failures are counted and logged (rate limited) to stderr only, never
 * reported to a TelemetrySink, so an export failure cannot feed itself.
 *
 * The batcher knows nothing about the wire. A transport steers it only through
 * the optional {@link ExportFailureHint} fields on the error it throws: a
 * terminal failure is dropped without retry, a `split` failure is retried as
 * two halves, and `retryAfterMs` lengthens the next backoff. A plain error is
 * retryable.
 */

/** Optional fields a transport may set on a thrown error to steer retries. */
export interface ExportFailureHint {
  /** `false`: retrying the same batch cannot succeed; drop it now. Default true. */
  retryable?: boolean;
  /** Least delay before the next attempt (clamped to {@link RETRY_DELAY_MAX_MS}). */
  retryAfterMs?: number;
  /** The batch is too large: send it again as two halves; a single item is dropped. */
  split?: boolean;
  /** Short, content-free description for the failure log line. */
  reason?: string;
}

/** Longest delay a `retryAfterMs` hint can impose. */
export const RETRY_DELAY_MAX_MS = 30_000;

function hintOf(err: unknown): ExportFailureHint {
  if (!err || typeof err !== 'object') return {};
  const { retryable, retryAfterMs, split, reason } = err as Record<string, unknown>;
  return {
    ...(typeof retryable === 'boolean' ? { retryable } : {}),
    ...(typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs > 0
      ? { retryAfterMs: Math.min(retryAfterMs, RETRY_DELAY_MAX_MS) }
      : {}),
    ...(split === true ? { split } : {}),
    ...(typeof reason === 'string' ? { reason } : {}),
  };
}

export interface BatchTransport<T> {
  send(items: T[]): Promise<void>;
}

export interface BatcherOptions {
  /** Most events waiting to be sent; further events are dropped. */
  queueMax: number;
  /** Most events per transport call. */
  batchMax: number;
  /** Longest time an event waits before a partial batch is sent. */
  flushIntervalMs: number;
  /** Transport attempts per batch (first try included) before it is dropped. */
  maxAttempts: number;
  /** Delay before retry n is `backoffMs * n`. */
  backoffMs: number;
  /** Longest time `shutdown()` waits for the queue to drain. */
  shutdownTimeoutMs: number;
}

export interface BatcherStats {
  enqueued: number;
  exported: number;
  /** Events not exported, for any reason: queue full, enqueued after shutdown, rejected, retries exhausted, or left at the shutdown deadline. */
  dropped: number;
  /** Of `dropped`: events refused because the queue was full. */
  queueFull: number;
  /** Of `dropped`: events in batches the transport reported as terminal (not retryable), or single items too large to send. */
  rejected: number;
  /** Batches (or split halves) given up: rejected or retries exhausted. */
  failedBatches: number;
  retries: number;
  /** Batches re-sent as two halves after a `split` failure. */
  splits: number;
  /** Events currently waiting (not counting an in-flight batch). */
  queued: number;
}

type TimerHandle = unknown;

export interface BatcherDeps {
  setTimeout?: (fn: () => void, ms: number) => TimerHandle;
  clearTimeout?: (handle: TimerHandle) => void;
  now?: () => number;
  /** Failure log sink (default: console.error). */
  log?: (line: string) => void;
}

export interface Batcher<T> {
  enqueue(item: T): void;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
  stats(): BatcherStats;
}

/** At most one failure line per this window. */
export const FAILURE_LOG_INTERVAL_MS = 30_000;

function positiveInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`telemetry batcher: ${name} must be a positive integer`);
  return value;
}

function nonNegativeInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0) throw new Error(`telemetry batcher: ${name} must be a non-negative integer`);
  return value;
}

function unref(handle: TimerHandle): void {
  (handle as { unref?: () => void } | null)?.unref?.();
}

export function createBatcher<T>(transport: BatchTransport<T>, opts: BatcherOptions, deps: BatcherDeps = {}): Batcher<T> {
  const queueMax = positiveInteger('queueMax', opts.queueMax);
  const batchMax = positiveInteger('batchMax', opts.batchMax);
  const flushIntervalMs = nonNegativeInteger('flushIntervalMs', opts.flushIntervalMs);
  const maxAttempts = positiveInteger('maxAttempts', opts.maxAttempts);
  const backoffMs = nonNegativeInteger('backoffMs', opts.backoffMs);
  const shutdownTimeoutMs = nonNegativeInteger('shutdownTimeoutMs', opts.shutdownTimeoutMs);

  // Resolved per call so test fake timers installed later still apply.
  const setTimer = (fn: () => void, ms: number): TimerHandle => (deps.setTimeout ?? ((f, m) => setTimeout(f, m)))(fn, ms);
  const clearTimer = (handle: TimerHandle): void => (deps.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)))(handle);
  const now = (): number => (deps.now ?? Date.now)();
  const log = (line: string): void => (deps.log ?? ((l) => console.error(l)))(line);

  const queue: T[] = [];
  const counters = { enqueued: 0, exported: 0, dropped: 0, queueFull: 0, rejected: 0, failedBatches: 0, retries: 0, splits: 0 };
  // Halving a batch of at most batchMax reaches single items within this many splits.
  const maxSplitDepth = Math.ceil(Math.log2(batchMax));
  let flushTimer: TimerHandle | undefined;
  let pumping: Promise<void> | undefined;
  let closed = false;
  // Set at the shutdown deadline: stop retrying and starting new batches.
  let abandoned = false;
  let shutdownPromise: Promise<void> | undefined;
  let lastLogAt = Number.NEGATIVE_INFINITY;

  const report = (reason: string): void => {
    try {
      const at = now();
      if (at - lastLogAt < FAILURE_LOG_INTERVAL_MS) return;
      lastLogAt = at;
      log(`[telemetry] collector export: ${reason} (exported=${counters.exported} dropped=${counters.dropped} rejected=${counters.rejected} queueFull=${counters.queueFull} failedBatches=${counters.failedBatches} retries=${counters.retries})`);
    } catch {
      // logging is best effort
    }
  };

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => {
    if (ms <= 0) { resolve(); return; }
    unref(setTimer(resolve, ms));
  });

  const giveUp = (batch: T[], rejected: boolean, reason: string): void => {
    counters.failedBatches += 1;
    counters.dropped += batch.length;
    if (rejected) counters.rejected += batch.length;
    report(reason);
  };

  const sendWithRetry = async (batch: T[], depth = 0): Promise<void> => {
    for (let attempt = 1; ; attempt += 1) {
      let failure: unknown;
      try {
        await Promise.resolve().then(() => transport.send(batch));
        counters.exported += batch.length;
        return;
      } catch (err) {
        failure = err;
      }
      const hint = hintOf(failure);
      const why = hint.reason ?? (failure instanceof Error ? failure.name : typeof failure);
      if (hint.split) {
        if (batch.length > 1 && depth < maxSplitDepth && !abandoned) {
          // Each half gets its own attempt budget; the same items (and ids) are re-sent.
          counters.splits += 1;
          const middle = Math.ceil(batch.length / 2);
          await sendWithRetry(batch.slice(0, middle), depth + 1);
          await sendWithRetry(batch.slice(middle), depth + 1);
          return;
        }
        giveUp(batch, true, `rejected a batch of ${batch.length} that cannot be split further (${why})`);
        return;
      }
      if (hint.retryable === false) {
        giveUp(batch, true, `rejected a batch of ${batch.length}; not retried (${why})`);
        return;
      }
      if (attempt >= maxAttempts || abandoned) {
        giveUp(batch, false, `dropped a batch of ${batch.length} after ${attempt} attempt(s) (${why})`);
        return;
      }
      counters.retries += 1;
      await sleep(Math.max(backoffMs * attempt, hint.retryAfterMs ?? 0));
      if (abandoned) {
        giveUp(batch, false, `dropped a batch of ${batch.length} at the shutdown deadline (${why})`);
        return;
      }
    }
  };

  const pump = (): Promise<void> => {
    if (pumping) return pumping;
    pumping = (async () => {
      try {
        while (queue.length > 0 && !abandoned) {
          await sendWithRetry(queue.splice(0, batchMax));
        }
      } finally {
        pumping = undefined;
        // Events that arrived during the last send wait for the next tick.
        if (queue.length > 0 && !abandoned) schedule();
      }
    })();
    return pumping;
  };

  const cancelTimer = (): void => {
    if (flushTimer !== undefined) {
      clearTimer(flushTimer);
      flushTimer = undefined;
    }
  };

  function schedule(): void {
    if (flushTimer !== undefined || pumping) return;
    flushTimer = setTimer(() => {
      flushTimer = undefined;
      void pump();
    }, flushIntervalMs);
    unref(flushTimer);
  }

  const batcher: Batcher<T> = {
    enqueue(item: T): void {
      try {
        if (closed || queue.length >= queueMax) {
          counters.dropped += 1;
          if (!closed) counters.queueFull += 1;
          report(closed ? 'dropped an event after shutdown' : `queue full (${queueMax}); dropped an event`);
          return;
        }
        queue.push(item);
        counters.enqueued += 1;
        if (queue.length >= batchMax && !pumping) {
          cancelTimer();
          void pump();
        } else {
          schedule();
        }
      } catch {
        // enqueue never throws into the product path
      }
    },

    async flush(): Promise<void> {
      cancelTimer();
      // A pump started before new events arrived still drains them (it loops
      // until the queue is empty), so awaiting until idle drains everything.
      while ((queue.length > 0 || pumping) && !abandoned) await pump();
    },

    shutdown(): Promise<void> {
      if (shutdownPromise) return shutdownPromise;
      closed = true;
      cancelTimer();
      shutdownPromise = new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        const deadline = setTimer(() => {
          abandoned = true;
          counters.dropped += queue.length;
          if (queue.length > 0) report(`shutdown deadline; dropped ${queue.length} queued event(s)`);
          queue.length = 0;
          finish();
        }, shutdownTimeoutMs);
        void batcher.flush().then(() => {
          clearTimer(deadline);
          finish();
        }, finish);
      });
      return shutdownPromise;
    },

    stats(): BatcherStats {
      return { ...counters, queued: queue.length };
    },
  };
  return batcher;
}
