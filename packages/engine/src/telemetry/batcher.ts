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
 *
 * Deadlines. Every event has a total delivery deadline, `deliveryDeadlineMs`
 * after it is enqueued, covering its queued time, every attempt and every
 * retry wait. A batch uses its earliest event deadline; a retry or a split
 * never resets or extends it (split halves keep their events' deadlines).
 * Each attempt's timeout handed to the transport is clipped to that remaining
 * deadline (and, once shutdown begins, to the shutdown deadline). When the
 * deadline would pass before another attempt could start, the events are
 * dropped and counted as `expired` instead of starting another request or
 * wait. Every retry wait, including one lengthened by `retryAfterMs`, is also
 * capped at {@link RETRY_DELAY_MAX_MS} and counts against `maxAttempts` (a zero
 * hint falls back to the local backoff and never permits extra attempts). Once
 * shutdown begins no wait outlasts the shutdown deadline: at that deadline a
 * batch waiting to be retried, unsent split halves and the queue are dropped
 * and counted.
 *
 * Byte bounds. Every event's serialized UTF-8 size (`sizeOf`, measured once at
 * enqueue) is bounded by `eventMaxBytes`: a larger event is dropped and counted
 * as `oversized`. The queue holds at most `queueMaxBytes` (and `queueMax`
 * events); an event that would exceed either is the newest and is dropped and
 * counted as `queueFull`. A batch never exceeds `batchMax` events nor
 * `batchMaxBytes` bytes, computed as `batchFrameBytes` plus the events' sizes
 * plus one separator byte between events (exactly the JSON array encoding).
 * The one in-flight batch is not counted against the queue bounds.
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
  /** The failure is a producer configuration problem (credential / authority); counted and logged separately. */
  configuration?: boolean;
}

/** Longest delay a `retryAfterMs` hint can impose. */
export const RETRY_DELAY_MAX_MS = 30_000;

function hintOf(err: unknown): ExportFailureHint {
  if (!err || typeof err !== 'object') return {};
  const { retryable, retryAfterMs, split, reason, configuration } = err as Record<string, unknown>;
  return {
    ...(typeof retryable === 'boolean' ? { retryable } : {}),
    ...(typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs > 0
      ? { retryAfterMs: Math.min(retryAfterMs, RETRY_DELAY_MAX_MS) }
      : {}),
    ...(split === true ? { split } : {}),
    ...(typeof reason === 'string' ? { reason } : {}),
    ...(configuration === true ? { configuration } : {}),
  };
}

/** Per-attempt bounds the batcher hands the transport. */
export interface BatchAttempt {
  /**
   * Longest this attempt may take, in ms: the remaining delivery deadline,
   * further clipped to the shutdown deadline once shutdown has begun. The
   * transport applies the smaller of this and its own request timeout.
   */
  timeoutMs: number;
}

export interface BatchTransport<T> {
  send(items: T[], attempt?: BatchAttempt): Promise<void>;
}

/** Default total delivery deadline per event (enqueue to acknowledgement). */
export const DELIVERY_DEADLINE_DEFAULT_MS = 60_000;

/**
 * Producer default byte bounds. infra#85 requires finite configurable limits
 * but publishes no numbers; these are conservative producer defaults.
 */
export const EVENT_MAX_BYTES_DEFAULT = 8 * 1024;
export const BATCH_MAX_BYTES_DEFAULT = 256 * 1024;
export const QUEUE_MAX_BYTES_DEFAULT = 1024 * 1024;

/** UTF-8 bytes of `JSON.stringify(item)` (the default `sizeOf`). */
export function jsonUtf8Bytes(item: unknown): number {
  const text = JSON.stringify(item) ?? '';
  const buffer = (globalThis as { Buffer?: { byteLength(v: string, enc: 'utf8'): number } }).Buffer;
  return buffer ? buffer.byteLength(text, 'utf8') : new TextEncoder().encode(text).byteLength;
}

export interface BatcherOptions<T = unknown> {
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
  /**
   * Total delivery deadline per event, from enqueue across queued time, all
   * attempts and all waits. Default {@link DELIVERY_DEADLINE_DEFAULT_MS}.
   */
  deliveryDeadlineMs?: number;
  /** Largest serialized event, UTF-8 bytes; larger events are dropped as `oversized`. Default {@link EVENT_MAX_BYTES_DEFAULT}. */
  eventMaxBytes?: number;
  /** Largest serialized batch body, UTF-8 bytes. Default {@link BATCH_MAX_BYTES_DEFAULT}. */
  batchMaxBytes?: number;
  /** Most serialized bytes waiting in the queue; the newest event over budget is dropped as `queueFull`. Default {@link QUEUE_MAX_BYTES_DEFAULT}. */
  queueMaxBytes?: number;
  /** Serialized UTF-8 size of one event as it appears in a batch body. Default {@link jsonUtf8Bytes}. */
  sizeOf?: (item: T) => number;
  /** Serialized bytes of a batch body with zero events. Default 2 (`[]`). */
  batchFrameBytes?: number;
}

export interface BatcherStats {
  enqueued: number;
  exported: number;
  /** Events not exported, for any reason: queue full, enqueued after shutdown, rejected, retries exhausted, delivery deadline passed, or left at the shutdown deadline. */
  dropped: number;
  /** Of `dropped`: the newest events, refused because the queue's event count or byte budget was full. */
  queueFull: number;
  /** Of `dropped`: single events larger than `eventMaxBytes`, or a single event the collector refused as too large (413). */
  oversized: number;
  /** Batches refused for a producer configuration problem (401/403: credential or deployment authority). */
  configFailures: number;
  /** Of `dropped`: events in batches the transport reported as terminal (not retryable), or single items too large to send. */
  rejected: number;
  /** Of `dropped`: events whose total delivery deadline passed (while queued or between attempts). */
  expired: number;
  /** Batches (or split halves) given up: rejected, retries exhausted or delivery deadline passed. */
  failedBatches: number;
  retries: number;
  /** Batches re-sent as two halves after a `split` failure. */
  splits: number;
  /** Events currently waiting (not counting an in-flight batch). */
  queued: number;
  /** Serialized bytes currently waiting (not counting an in-flight batch). */
  queuedBytes: number;
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

interface Entry<T> {
  item: T;
  /** `now()` value after which this event is no longer sent. */
  deadlineAt: number;
  /** Serialized UTF-8 size, measured once at enqueue. */
  bytes: number;
}

export function createBatcher<T>(transport: BatchTransport<T>, opts: BatcherOptions<T>, deps: BatcherDeps = {}): Batcher<T> {
  const queueMax = positiveInteger('queueMax', opts.queueMax);
  const batchMax = positiveInteger('batchMax', opts.batchMax);
  const flushIntervalMs = nonNegativeInteger('flushIntervalMs', opts.flushIntervalMs);
  const maxAttempts = positiveInteger('maxAttempts', opts.maxAttempts);
  const backoffMs = nonNegativeInteger('backoffMs', opts.backoffMs);
  const shutdownTimeoutMs = nonNegativeInteger('shutdownTimeoutMs', opts.shutdownTimeoutMs);
  const deliveryDeadlineMs = positiveInteger('deliveryDeadlineMs', opts.deliveryDeadlineMs ?? DELIVERY_DEADLINE_DEFAULT_MS);
  const eventMaxBytes = positiveInteger('eventMaxBytes', opts.eventMaxBytes ?? EVENT_MAX_BYTES_DEFAULT);
  const batchMaxBytes = positiveInteger('batchMaxBytes', opts.batchMaxBytes ?? BATCH_MAX_BYTES_DEFAULT);
  const queueMaxBytes = positiveInteger('queueMaxBytes', opts.queueMaxBytes ?? QUEUE_MAX_BYTES_DEFAULT);
  const batchFrameBytes = nonNegativeInteger('batchFrameBytes', opts.batchFrameBytes ?? 2);
  if (eventMaxBytes + batchFrameBytes > batchMaxBytes) {
    throw new Error('telemetry batcher: batchMaxBytes must hold at least one event of eventMaxBytes');
  }
  if (eventMaxBytes > queueMaxBytes) {
    throw new Error('telemetry batcher: queueMaxBytes must be at least eventMaxBytes');
  }
  const sizeOf = opts.sizeOf ?? jsonUtf8Bytes;

  // Resolved per call so test fake timers installed later still apply.
  const setTimer = (fn: () => void, ms: number): TimerHandle => (deps.setTimeout ?? ((f, m) => setTimeout(f, m)))(fn, ms);
  const clearTimer = (handle: TimerHandle): void => (deps.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)))(handle);
  const now = (): number => (deps.now ?? Date.now)();
  const log = (line: string): void => (deps.log ?? ((l) => console.error(l)))(line);

  const queue: Array<Entry<T>> = [];
  let queuedBytes = 0;
  const counters = { enqueued: 0, exported: 0, dropped: 0, queueFull: 0, oversized: 0, configFailures: 0, rejected: 0, expired: 0, failedBatches: 0, retries: 0, splits: 0 };
  // Halving a batch of at most batchMax reaches single items within this many splits.
  const maxSplitDepth = Math.ceil(Math.log2(batchMax));
  let flushTimer: TimerHandle | undefined;
  let pumping: Promise<void> | undefined;
  let closed = false;
  // Set when shutdown begins: no attempt or wait may run past it.
  let shutdownAt: number | undefined;
  // Set at the shutdown deadline: stop retrying and starting new batches.
  let abandoned = false;
  let shutdownPromise: Promise<void> | undefined;
  let lastLogAt = Number.NEGATIVE_INFINITY;
  let lastConfigLogAt = Number.NEGATIVE_INFINITY;
  // The batch currently sleeping before a retry (one batch is in flight at a time).
  let waiting: { batch: Array<Entry<T>>; why: string; wake: () => void; dropped: boolean } | undefined;
  // Second halves of split batches not yet sent; dropped at the shutdown deadline.
  const deferredHalves: Array<{ batch: Array<Entry<T>>; why: string; dropped: boolean }> = [];

  const report = (reason: string, configuration = false): void => {
    try {
      const at = now();
      // A configuration failure has its own rate limit, so other failures never hide it.
      if (at - (configuration ? lastConfigLogAt : lastLogAt) < FAILURE_LOG_INTERVAL_MS) return;
      if (configuration) lastConfigLogAt = at;
      else lastLogAt = at;
      const prefix = configuration ? '[telemetry] collector export CONFIGURATION FAILURE' : '[telemetry] collector export';
      log(`${prefix}: ${reason} (exported=${counters.exported} dropped=${counters.dropped} rejected=${counters.rejected} expired=${counters.expired} queueFull=${counters.queueFull} oversized=${counters.oversized} configFailures=${counters.configFailures} failedBatches=${counters.failedBatches} retries=${counters.retries})`);
    } catch {
      // logging is best effort
    }
  };

  /**
   * Wait before retrying `batch`. Resolves false when the shutdown deadline
   * passed during the wait, in which case the batch was already counted as
   * dropped: the wait is cut short at that deadline rather than overrunning it.
   */
  const retryWait = (batch: Array<Entry<T>>, why: string, ms: number): Promise<boolean> => new Promise((resolve) => {
    if (ms <= 0) { resolve(true); return; }
    const entry = { batch, why, dropped: false, wake: () => {} };
    const handle = setTimer(() => entry.wake(), ms);
    unref(handle);
    entry.wake = () => {
      clearTimer(handle);
      if (waiting === entry) waiting = undefined;
      resolve(!entry.dropped);
    };
    waiting = entry;
  });

  const giveUp = (batch: Array<Entry<T>>, rejected: boolean, reason: string, configuration = false): void => {
    counters.failedBatches += 1;
    counters.dropped += batch.length;
    if (rejected) counters.rejected += batch.length;
    if (configuration) counters.configFailures += 1;
    report(reason, configuration);
  };

  const expire = (batch: Array<Entry<T>>, reason: string): void => {
    counters.expired += batch.length;
    giveUp(batch, false, reason);
  };

  const earliestDeadline = (batch: Array<Entry<T>>): number =>
    batch.reduce((earliest, entry) => Math.min(earliest, entry.deadlineAt), Number.POSITIVE_INFINITY);

  const sendWithRetry = async (batch: Array<Entry<T>>, depth = 0): Promise<void> => {
    // A batch uses its earliest event deadline; nothing below resets it.
    const deadlineAt = earliestDeadline(batch);
    const items = batch.map((entry) => entry.item);
    let why = 'delivery deadline';
    for (let attempt = 1; ; attempt += 1) {
      if (abandoned) {
        giveUp(batch, false, `dropped a batch of ${batch.length} at the shutdown deadline (${why})`);
        return;
      }
      const at = now();
      let timeoutMs = deadlineAt - at;
      if (shutdownAt !== undefined) timeoutMs = Math.min(timeoutMs, shutdownAt - at);
      if (deadlineAt - at <= 0) {
        expire(batch, `dropped a batch of ${batch.length} at its delivery deadline (${why})`);
        return;
      }
      let failure: unknown;
      try {
        await Promise.resolve().then(() => transport.send(items, { timeoutMs: Math.max(1, Math.ceil(timeoutMs)) }));
        counters.exported += batch.length;
        return;
      } catch (err) {
        failure = err;
      }
      const hint = hintOf(failure);
      why = hint.reason ?? (failure instanceof Error ? failure.name : typeof failure);
      if (hint.split) {
        if (batch.length > 1 && depth < maxSplitDepth && !abandoned) {
          // Each half gets its own attempt budget but keeps its events' delivery
          // deadlines; the same items (and ids) are re-sent.
          counters.splits += 1;
          const middle = Math.ceil(batch.length / 2);
          const rest = { batch: batch.slice(middle), why, dropped: false };
          deferredHalves.push(rest);
          try {
            await sendWithRetry(batch.slice(0, middle), depth + 1);
          } finally {
            deferredHalves.splice(deferredHalves.indexOf(rest), 1);
          }
          if (!rest.dropped) await sendWithRetry(rest.batch, depth + 1);
          return;
        }
        // A single event the collector still finds too large is oversized.
        if (batch.length === 1) counters.oversized += 1;
        giveUp(batch, true, `rejected a batch of ${batch.length} that cannot be split further (${why})`);
        return;
      }
      if (hint.retryable === false) {
        giveUp(batch, true, `rejected a batch of ${batch.length}; not retried (${why})`, hint.configuration === true);
        return;
      }
      if (attempt >= maxAttempts || abandoned) {
        giveUp(batch, false, `dropped a batch of ${batch.length} after ${attempt} attempt(s) (${why})`);
        return;
      }
      const delay = Math.min(Math.max(backoffMs * attempt, hint.retryAfterMs ?? 0), RETRY_DELAY_MAX_MS);
      if (now() + delay >= deadlineAt) {
        // The wait would consume the rest of the delivery budget: drop now
        // rather than start a wait that no attempt can follow.
        expire(batch, `dropped a batch of ${batch.length} at its delivery deadline (${why})`);
        return;
      }
      counters.retries += 1;
      if (!(await retryWait(batch, why, delay))) return;
    }
  };

  /** Drop queued events whose delivery deadline already passed (the queue is in deadline order). */
  const expireQueued = (): void => {
    const at = now();
    let count = 0;
    while (count < queue.length && queue[count]!.deadlineAt <= at) count += 1;
    if (count === 0) return;
    for (const entry of queue.splice(0, count)) queuedBytes -= entry.bytes;
    counters.dropped += count;
    counters.expired += count;
    report(`delivery deadline; dropped ${count} queued event(s)`);
  };

  /** Bytes of a batch body holding `count` events totalling `eventBytes`. */
  const batchBytes = (count: number, eventBytes: number): number =>
    batchFrameBytes + eventBytes + Math.max(0, count - 1);

  /** Remove the next batch from the queue: at most batchMax events and batchMaxBytes bytes. */
  const takeBatch = (): Array<Entry<T>> => {
    let count = 0;
    let bytes = 0;
    // The first event always fits (eventMaxBytes + frame <= batchMaxBytes).
    while (count < queue.length && count < batchMax) {
      const next = queue[count]!.bytes;
      if (count > 0 && batchBytes(count + 1, bytes + next) > batchMaxBytes) break;
      bytes += next;
      count += 1;
    }
    queuedBytes -= bytes;
    return queue.splice(0, count);
  };

  /** True when the queue already holds a full batch (by count or bytes). */
  const fullBatchQueued = (): boolean =>
    queue.length >= batchMax || batchBytes(queue.length, queuedBytes) >= batchMaxBytes;

  const pump = (): Promise<void> => {
    if (pumping) return pumping;
    pumping = (async () => {
      try {
        while (queue.length > 0 && !abandoned) {
          expireQueued();
          if (queue.length === 0) break;
          await sendWithRetry(takeBatch());
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
        if (closed) {
          counters.dropped += 1;
          report('dropped an event after shutdown');
          return;
        }
        let bytes: number;
        try {
          bytes = sizeOf(item);
        } catch {
          bytes = Number.NaN;
        }
        if (!Number.isFinite(bytes) || bytes < 0 || bytes > eventMaxBytes) {
          counters.dropped += 1;
          counters.oversized += 1;
          report(`dropped an event over ${eventMaxBytes} bytes`);
          return;
        }
        // Queue exhaustion (count or bytes) drops the newest event: this one.
        if (queue.length >= queueMax || queuedBytes + bytes > queueMaxBytes) {
          counters.dropped += 1;
          counters.queueFull += 1;
          report(queue.length >= queueMax
            ? `queue full (${queueMax} events); dropped the newest event`
            : `queue full (${queueMaxBytes} bytes); dropped the newest event`);
          return;
        }
        queue.push({ item, deadlineAt: now() + deliveryDeadlineMs, bytes });
        queuedBytes += bytes;
        counters.enqueued += 1;
        if (fullBatchQueued() && !pumping) {
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
      shutdownAt = now() + shutdownTimeoutMs;
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
          // A batch sleeping before its retry is dropped now, not when its
          // (possibly Retry-After lengthened) wait would have ended.
          const sleeper = waiting;
          if (sleeper) {
            sleeper.dropped = true;
            giveUp(sleeper.batch, false, `dropped a batch of ${sleeper.batch.length} at the shutdown deadline (${sleeper.why})`);
            sleeper.wake();
          }
          for (const half of deferredHalves) {
            if (half.dropped) continue;
            half.dropped = true;
            giveUp(half.batch, false, `dropped a batch of ${half.batch.length} at the shutdown deadline (${half.why})`);
          }
          counters.dropped += queue.length;
          if (queue.length > 0) report(`shutdown deadline; dropped ${queue.length} queued event(s)`);
          queue.length = 0;
          queuedBytes = 0;
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
      return { ...counters, queued: queue.length, queuedBytes };
    },
  };
  return batcher;
}
