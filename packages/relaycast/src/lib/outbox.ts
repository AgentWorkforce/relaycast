import {
  cleanupOldEvents,
  completeEvent,
  deliverEvent,
  failEvent,
  rescheduleEvent,
  sweepPendingEvents,
  type SweptEvent,
} from '@relaycast/engine';

/**
 * `pending_events` outbox settlement for the hosted deployment.
 *
 * The engine send path persists an outbox row in D1 BEFORE enqueueing to the
 * Cloudflare Queue and stamps the row id on the message (`outboxId`). This
 * module is the consumer side: settle rows after delivery, and sweep rows
 * whose queue send was lost (isolate died between the D1 insert and
 * `WEBHOOK_QUEUE.send`) back onto the queue.
 *
 * Settle / CF-retry interaction (who owns a row when):
 * - Delivery succeeds            → `completeEvent` deletes the row, then ack.
 * - Terminal failure (4xx)       → `failEvent` settles the row, then ack —
 *                                  CF retries would not change the outcome.
 * - Retryable failure (5xx/429)  → `rescheduleEvent` pushes the row's
 *                                  `process_after` beyond the CF retry horizon
 *                                  (`OUTBOX_QUEUE_RETRY_HOLDOFF_MS`), then the
 *                                  message keeps retrying via `msg.retry()`.
 *                                  The hold-off keeps the sweep from
 *                                  re-enqueueing a row the queue is still
 *                                  redelivering; if CF exhausts retries (DLQ),
 *                                  the row comes due after the hold-off and
 *                                  the sweep gives it another round.
 * - Settle bookkeeping failures are swallowed (reported via `onSettleError`):
 *   delivery outcome wins, and an unsettled row is merely re-swept later —
 *   webhooks are at-least-once, never lost.
 *
 * The bundled `@relaycast/engine` (>= 3.0.0) exports the outbox API directly;
 * {@link engineOutbox} binds to it statically (an exact version pin plus
 * typecheck guarantee — a runtime probe could only mask a build
 * misconfiguration by silently no-opping). `OutboxApi` remains as the seam
 * tests use to inject a fake store.
 */

/** The drizzle database type `deliverEvent` accepts (engine's `Db`). */
export type OutboxDb = Parameters<typeof deliverEvent>[0];

/** Queue message shape: the engine's `QueuedEvent`, with the outbox row id. */
export interface OutboxQueueMessage {
  type: string;
  workspaceId: string;
  data: Record<string, unknown>;
  /** `pending_events` row id; absent on legacy messages already in flight. */
  outboxId?: string;
}

/** A claimed `pending_events` row returned by the engine's sweep. */
export type SweptOutboxEvent = SweptEvent;

/** The engine's outbox settle/sweep surface (injectable for tests). */
export interface OutboxApi {
  completeEvent(db: OutboxDb, id: string): Promise<void>;
  failEvent(db: OutboxDb, id: string, error: string): Promise<void>;
  rescheduleEvent(db: OutboxDb, id: string, error: string, backoffMs: number): Promise<void>;
  sweepPendingEvents(
    db: OutboxDb,
    opts?: { limit?: number; leaseMs?: number; now?: Date },
  ): Promise<SweptOutboxEvent[]>;
  cleanupOldEvents(db: OutboxDb, maxAgeMs?: number): Promise<number>;
}

/** The real engine outbox — the default for both entrypoints. */
export const engineOutbox: OutboxApi = {
  completeEvent,
  failEvent,
  rescheduleEvent,
  sweepPendingEvents,
  cleanupOldEvents,
};

/**
 * How long a retryably-failed row is held off before the sweep may re-enqueue
 * it. Must comfortably exceed the CF queue's retry window for the message
 * (delays + max_retries) so the sweep never races an in-flight redelivery.
 */
export const OUTBOX_QUEUE_RETRY_HOLDOFF_MS = 10 * 60_000;

/**
 * Only sweep rows that have been due at least this long. Freshly-inserted rows
 * are due immediately (the request path enqueues them right away); the age gate
 * keeps the sweep from double-enqueueing rows the queue is about to deliver
 * normally — only rows that sat unsettled past the gate are presumed lost.
 */
export const OUTBOX_SWEEP_MIN_PENDING_AGE_MS = 5 * 60_000;

/**
 * Claim lease for swept rows. The engine computes the new `process_after`
 * from the (age-gated, i.e. backdated) `now`, so the effective invisibility
 * window is `LEASE - MIN_PENDING_AGE` = 15 min from the actual sweep time —
 * enough for the re-enqueued message to deliver and settle before the row
 * could be claimed again.
 */
export const OUTBOX_SWEEP_LEASE_MS = 20 * 60_000;

/** Max rows re-enqueued per scheduled sweep pass. */
export const OUTBOX_SWEEP_BATCH = 100;

export interface DeliverQueueMessageOptions {
  /** Injectable for tests; defaults to the engine's `deliverEvent`. */
  deliver?: typeof deliverEvent;
  /** Settle bookkeeping failures are swallowed and reported here. */
  onSettleError?: (err: unknown) => void;
}

/**
 * Deliver one queue message and settle its outbox row.
 *
 * Throws only when delivery is retryable — the caller must `msg.retry()` in
 * that case and `msg.ack()` otherwise. With no `outboxId` (legacy message
 * already in flight from a pre-outbox engine), this is exactly the old
 * behavior: deliver, and let CF queue retries + DLQ handle failures.
 */
export async function deliverQueueMessage(
  db: OutboxDb,
  event: OutboxQueueMessage,
  outbox: OutboxApi = engineOutbox,
  options: DeliverQueueMessageOptions = {},
): Promise<void> {
  const deliver = options.deliver ?? deliverEvent;
  const settling = event.outboxId ? { outbox, outboxId: event.outboxId } : undefined;

  let summary: Awaited<ReturnType<typeof deliverEvent>>;
  try {
    summary = await deliver(db, event.workspaceId, event.type, event.data);
  } catch (err) {
    // Retryable (deliverEvent throws only for retryable conditions). Hold the
    // row off so the sweep stays out of the way while CF redelivers, then
    // rethrow so the caller retries the message.
    if (settling) {
      try {
        const message = err instanceof Error ? err.message : String(err);
        await settling.outbox.rescheduleEvent(db, settling.outboxId, message, OUTBOX_QUEUE_RETRY_HOLDOFF_MS);
      } catch (settleErr) {
        options.onSettleError?.(settleErr);
      }
    }
    throw err;
  }

  if (settling) {
    try {
      if (summary.failed > 0) {
        // Resolved with failures and no retryables — terminal (non-408/429
        // 4xx). Settle as failed; retrying won't change the outcome.
        await settling.outbox.failEvent(
          db,
          settling.outboxId,
          `terminal delivery failure: ${summary.failed} of ${summary.attempted} subscriber(s)`,
        );
      } else {
        await settling.outbox.completeEvent(db, settling.outboxId);
      }
    } catch (settleErr) {
      // Delivery already happened; an unsettled row just gets re-swept later.
      options.onSettleError?.(settleErr);
    }
  }
}

/** Minimal producer surface of a Cloudflare Queue binding. */
export interface OutboxQueueProducer {
  send(message: OutboxQueueMessage): Promise<unknown>;
}

export interface OutboxSweepResult {
  swept: number;
  reenqueued: number;
  cleaned: number;
}

/**
 * Scheduled sweep: claim rows that have sat unsettled past the age gate and
 * RE-ENQUEUE them to the CF queue (delivery stays in the queue consumer), then
 * prune settled rows. A failed queue send leaves the row claimed; the lease
 * expiry re-offers it to a later sweep.
 */
export async function runOutboxSweep(
  db: OutboxDb,
  queue: OutboxQueueProducer,
  outbox: OutboxApi = engineOutbox,
  now: () => number = Date.now,
): Promise<OutboxSweepResult> {
  const swept = await outbox.sweepPendingEvents(db, {
    limit: OUTBOX_SWEEP_BATCH,
    leaseMs: OUTBOX_SWEEP_LEASE_MS,
    now: new Date(now() - OUTBOX_SWEEP_MIN_PENDING_AGE_MS),
  });

  let reenqueued = 0;
  let sendError: unknown;
  for (const event of swept) {
    try {
      await queue.send({
        type: event.eventType,
        workspaceId: event.workspaceId,
        data: event.payload,
        outboxId: event.id,
      });
      reenqueued += 1;
    } catch (err) {
      sendError = err; // keep going — other rows can still make it out
    }
  }

  const cleaned = await outbox.cleanupOldEvents(db);
  if (sendError && reenqueued === 0 && swept.length > 0) {
    throw sendError; // queue fully unavailable — surface it to telemetry
  }
  return { swept: swept.length, reenqueued, cleaned };
}
