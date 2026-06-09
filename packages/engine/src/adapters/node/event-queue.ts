import type { EventQueue, QueuedEvent } from '../../ports/event-queue.js';
import type { EngineDb } from '../../ports/database.js';
import { deliverEvent } from '../../engine/eventDelivery.js';
import {
  enqueueEvent,
  claimDueEvents,
  completeEvent,
  failEvent,
  rescheduleEvent,
  cleanupOldEvents,
  type ClaimedEvent,
} from '../../engine/eventQueue.js';

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_BASE_BACKOFF_MS = 30_000;
const DEFAULT_MAX_BACKOFF_MS = 15 * 60_000;
const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 60_000;

export interface DurableEventQueueOptions {
  /** Poll cadence for due rows. 0 disables the timer (tests drive `poll()` directly). Default 5s. */
  pollIntervalMs?: number;
  /** Delay before the first retry; doubles per attempt. Default 30s. */
  baseBackoffMs?: number;
  /** Retry backoff ceiling. Default 15 min. */
  maxBackoffMs?: number;
  /** How long a claimed row stays invisible before a crashed worker's claim expires. Default 60s. */
  leaseMs?: number;
  /** Max rows claimed per poll pass. Default 25. */
  batchSize?: number;
  /** How often settled rows older than 24h are pruned. Default 1h. */
  cleanupIntervalMs?: number;
}

/**
 * Durable webhook delivery for self-host, replacing the Cloudflare Queue + DLQ.
 * `send` persists a `pending_events` outbox row first, then a background poller
 * claims due rows and fans them out via `deliverEvent` (HMAC signing and
 * retryable-vs-terminal classification unchanged). Success deletes the row;
 * terminal failures settle it as `failed`; retryable failures back off
 * exponentially and survive process restarts — `start()` resumes whatever is due.
 */
export class DurableEventQueue implements EventQueue {
  private readonly pollIntervalMs: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly leaseMs: number;
  private readonly batchSize: number;
  private readonly cleanupIntervalMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private polling = false;
  private lastCleanupAt = 0;

  constructor(
    private readonly db: EngineDb,
    private readonly onError: (err: unknown, ctx: Record<string, unknown>) => void = () => {},
    options: DurableEventQueueOptions = {},
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.baseBackoffMs = options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.cleanupIntervalMs = options.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS;
  }

  /**
   * Persist the outbox row first (awaited — the event is durable once `send`
   * resolves), then kick an immediate poll so delivery is prompt. The poll path
   * claims rows atomically, so the kick and the interval timer never double-deliver.
   */
  async send(message: QueuedEvent): Promise<void> {
    await enqueueEvent(this.db, message.workspaceId, message.type, message.data);
    void this.poll();
  }

  /** Start the interval poller and immediately resume any rows left over from a previous run. */
  start(): void {
    if (this.pollIntervalMs > 0 && !this.timer) {
      this.timer = setInterval(() => {
        void this.poll();
      }, this.pollIntervalMs);
      // Don't keep the Node process alive solely for the outbox poller.
      (this.timer as { unref?: () => void }).unref?.();
    }
    void this.poll();
  }

  /** Stop the interval poller (server shutdown / test teardown). */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * Claim and deliver every currently-due row, then prune old settled rows on
   * the cleanup cadence. Serialized per instance: overlapping calls coalesce
   * into the in-flight pass.
   */
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      for (;;) {
        const claimed = await claimDueEvents(this.db, {
          limit: this.batchSize,
          leaseMs: this.leaseMs,
        });
        if (claimed.length === 0) break;
        await Promise.all(claimed.map((event) => this.process(event)));
        if (claimed.length < this.batchSize) break;
      }
      await this.maybeCleanup();
    } catch (err) {
      this.onError(err, { source: 'node.event_queue', op: 'poll' });
    } finally {
      this.polling = false;
    }
  }

  private async process(event: ClaimedEvent): Promise<void> {
    try {
      const summary = await deliverEvent(this.db, event.workspaceId, event.eventType, event.payload);
      if (summary.failed > 0) {
        // deliverEvent resolved with failures and no retryables — terminal
        // (non-408/429 4xx). Settle the row; retrying won't change the outcome.
        await failEvent(
          this.db,
          event.id,
          `terminal delivery failure: ${summary.failed} of ${summary.attempted} subscriber(s)`,
        );
      } else {
        await completeEvent(this.db, event.id);
      }
    } catch (err) {
      // deliverEvent throws only for retryable conditions (coded 503 on
      // retryable webhook failures, or a transient subscription-lookup error).
      const message = err instanceof Error ? err.message : String(err);
      if (event.attempts >= event.maxAttempts) {
        await failEvent(this.db, event.id, `${message} (attempts exhausted)`);
        this.onError(err, {
          source: 'node.event_queue',
          op: 'deliver',
          event_type: event.eventType,
          attempts: event.attempts,
          settled: 'failed',
        });
      } else {
        const backoff = Math.min(this.baseBackoffMs * 2 ** (event.attempts - 1), this.maxBackoffMs);
        await rescheduleEvent(this.db, event.id, message, backoff);
      }
    }
  }

  private async maybeCleanup(): Promise<void> {
    const now = Date.now();
    if (now - this.lastCleanupAt < this.cleanupIntervalMs) return;
    this.lastCleanupAt = now;
    await cleanupOldEvents(this.db);
  }
}
