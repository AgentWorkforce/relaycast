// End-to-end DLQ replay proof for the B2 dedup contract.
//
// This is a F0-rigor test for the autonomous-run contract gate G4
// ("B2 idempotency proven + DLQ replay proven + 35-stale-DLQ disposition
// done"). It is intentionally NON-VACUOUS:
//
//   1. A deterministic consumer failure exhausts the configured 5-retry
//      budget (matching `infra/webhook-queue.ts` `dlq: { ..., retry: 5 }`).
//   2. After the budget is exhausted, the message is routed into the
//      `webhook-events-dlq` queue by the simulator (modelling Cloudflare
//      Queues' built-in DLQ delivery for max-retries-exhausted messages,
//      see https://developers.cloudflare.com/queues/configuration/dead-letter-queues/).
//   3. A DLQ-replay operator drains the DLQ and re-enqueues each message
//      onto the main `webhook-events` queue (this is the operator action
//      `wrangler queues consumer add ... --batch-size 10 --max-retries 1`
//      followed by a forwarder script, modelled here in-process).
//   4. On replay the processor is now healthy and acks the message; the
//      dedup row transitions to `completed`.
//   5. A subsequent redelivery (the "re-replayed messages dedupe correctly"
//      half of the contract) observes `duplicate_completed` and ACKs
//      WITHOUT invoking the processor, so the Relayfile write counter
//      stays at exactly one.
//
// The dedup store is the in-memory model that the production
// PostgresNangoSyncDedupStore implements against the `nango_sync_dedup`
// table (see `packages/core/src/sync/nango-sync-dedup-postgres.ts` and
// `packages/web/drizzle/0047_nango_sync_dedup.sql`). The contract under
// test is the surface that crosses the queue → dedup → processor → DLQ
// boundary, not the SQL of the Postgres store (covered by
// `dedup.test.ts`).

import { describe, expect, it, vi } from "vitest";
import { processWebhookQueueMessage, type WebhookProcessor } from "../src/queue-consumer";
import type {
  DedupeClaimInput,
  DedupeClaimResult,
  DedupeKey,
  NangoSyncDedupStore,
} from "../src/dedup";
import type {
  LegacyWebhookQueueMessage,
  NangoSyncQueueMessage,
  WebhookQueueMessage,
} from "../src/types";
import { createEnv } from "./helpers";

// ---------------------------------------------------------------------------
// Memory-backed dedup store — mirrors `PostgresNangoSyncDedupStore` claim/
// complete/fail semantics from `packages/core/src/sync/nango-sync-dedup-postgres.ts`.
// Used here (instead of the existing `MemoryDedupStore` in dedup.test.ts)
// so the test also exposes counters for asserting that completed claims are
// only written once across the full DLQ-replay round-trip.
// ---------------------------------------------------------------------------

type DedupRow = {
  surface: DedupeClaimInput["surface"];
  dedupeId: string;
  status: "processing" | "completed" | "failed";
  attemptCount: number;
  leaseExpiresAt?: Date;
  completedAt?: Date;
  lastError?: string;
};

class MemoryNangoSyncDedupStore implements NangoSyncDedupStore {
  rows = new Map<string, DedupRow>();
  claimCalls = 0;
  completeCalls = 0;
  failCalls = 0;

  private key(input: DedupeClaimInput | DedupeKey): string {
    return `${input.surface}:${input.dedupeId}`;
  }

  async claim(
    input: DedupeClaimInput,
    options: { now?: Date; leaseMs?: number } = {},
  ): Promise<DedupeClaimResult> {
    this.claimCalls += 1;
    const now = options.now ?? new Date();
    const leaseExpiresAt = new Date(now.getTime() + (options.leaseMs ?? 60_000));
    const key = this.key(input);
    const existing = this.rows.get(key);

    if (!existing) {
      this.rows.set(key, {
        surface: input.surface,
        dedupeId: input.dedupeId,
        status: "processing",
        attemptCount: 1,
        leaseExpiresAt,
      });
      return {
        type: "claimed",
        key: { surface: input.surface, dedupeId: input.dedupeId },
        attemptCount: 1,
        leaseExpiresAt,
      };
    }

    if (existing.status === "completed") {
      return {
        type: "duplicate_completed",
        key: { surface: input.surface, dedupeId: input.dedupeId },
        completedAt: existing.completedAt,
      };
    }

    if (
      existing.status === "processing" &&
      existing.leaseExpiresAt &&
      existing.leaseExpiresAt > now
    ) {
      return {
        type: "duplicate_in_flight",
        key: { surface: input.surface, dedupeId: input.dedupeId },
        leaseExpiresAt: existing.leaseExpiresAt,
      };
    }

    existing.status = "processing";
    existing.attemptCount += 1;
    existing.leaseExpiresAt = leaseExpiresAt;
    existing.completedAt = undefined;
    existing.lastError = undefined;
    return {
      type: "claimed",
      key: { surface: input.surface, dedupeId: input.dedupeId },
      attemptCount: existing.attemptCount,
      leaseExpiresAt,
    };
  }

  async complete(key: DedupeKey, options: { now?: Date } = {}): Promise<void> {
    this.completeCalls += 1;
    const row = this.rows.get(this.key(key));
    if (!row) return;
    row.status = "completed";
    row.completedAt = options.now ?? new Date();
    row.leaseExpiresAt = undefined;
    row.lastError = undefined;
  }

  async fail(key: DedupeKey, error: unknown): Promise<void> {
    this.failCalls += 1;
    const row = this.rows.get(this.key(key));
    if (!row) return;
    row.status = "failed";
    row.leaseExpiresAt = undefined;
    row.lastError = error instanceof Error ? error.message : String(error);
  }
}

// ---------------------------------------------------------------------------
// Cloudflare Queue simulator — models CF Queues' max-retries + DLQ-route
// semantics that `infra/webhook-queue.ts` configures (`retry: 5` →
// `webhook-events-dlq`). Each invocation of the consumer is driven through
// this simulator, mirroring the Worker runtime calling `worker.queue(...)`.
//
// Semantics modelled:
//   - `message.ack()` removes the message from the queue.
//   - `message.retry()` puts the message back on the queue, incrementing
//     `attempts`. When `attempts` exceeds `maxRetries`, the next retry
//     instead routes the message to `webhook-events-dlq`.
//   - A consumer-thrown exception is treated as an implicit retry by the
//     CF runtime; we model that the same way.
// ---------------------------------------------------------------------------

type QueueName = "webhook-events" | "webhook-events-dlq";
type SimulatedMessageBody = WebhookQueueMessage | LegacyWebhookQueueMessage;

type SimulatedMessage = {
  id: string;
  timestamp: Date;
  body: SimulatedMessageBody;
  attempts: number;
  acked: boolean;
  retried: boolean;
  retryAfterSeconds?: number;
  ack: () => void;
  retry: (opts?: { delaySeconds?: number }) => void;
};

type DeliveryRecord = {
  queue: QueueName;
  attempts: number;
  disposition: "ack" | "retry" | "throw" | "dlq";
};

class CloudflareQueueSimulator {
  readonly main: SimulatedMessage[] = [];
  readonly dlq: SimulatedMessage[] = [];
  readonly history: DeliveryRecord[] = [];
  private idSeq = 0;

  constructor(private readonly maxRetries: number) {}

  enqueue(body: SimulatedMessageBody, queue: QueueName = "webhook-events"): void {
    const message = this.makeMessage(body);
    (queue === "webhook-events" ? this.main : this.dlq).push(message);
  }

  /**
   * Replay a single DLQ message back onto the main queue, simulating an
   * operator running `wrangler queues consumer dlq-replay` or a small
   * forwarder Worker. The replayed message gets a fresh attempts counter,
   * matching the CF runtime behaviour for a queue producer `.send(...)`.
   *
   * Returns the new main-queue message id, or null if the DLQ is empty.
   */
  replayOneFromDlq(): string | null {
    const dlqMessage = this.dlq.shift();
    if (!dlqMessage) return null;
    const replayed = this.makeMessage(dlqMessage.body);
    this.main.push(replayed);
    return replayed.id;
  }

  async drive(
    processor: WebhookProcessor | undefined,
    options: { dedupStore: NangoSyncDedupStore },
  ): Promise<void> {
    // Process at most one full round of the main queue per call. Each
    // retried message becomes available again with attempts++.
    while (this.main.length > 0) {
      const message = this.main.shift();
      if (!message) break;
      message.attempts += 1;

      // `Message<T>` adapter for the consumer.
      const adapted = this.adapt(message);

      let threw: unknown = null;
      try {
        await processWebhookQueueMessage(
          adapted,
          // The consumer only forwards env/ctx through; createEnv is fine.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (this as any)._env ?? createEnv(),
          {} as ExecutionContext,
          { dedupStore: options.dedupStore, processor },
        );
      } catch (error) {
        threw = error;
      }

      if (message.acked) {
        this.history.push({
          queue: "webhook-events",
          attempts: message.attempts,
          disposition: "ack",
        });
        continue;
      }

      if (message.retried || threw) {
        if (message.attempts > this.maxRetries) {
          // Exhausted retry budget → route to DLQ.
          message.retried = false;
          message.attempts = 0;
          this.dlq.push(message);
          this.history.push({
            queue: "webhook-events",
            attempts: this.maxRetries + 1,
            disposition: "dlq",
          });
          continue;
        }
        this.history.push({
          queue: "webhook-events",
          attempts: message.attempts,
          disposition: threw ? "throw" : "retry",
        });
        message.retried = false;
        this.main.push(message);
        continue;
      }

      // Defensive: no ack, no retry, no throw. CF Queues would treat this
      // as implicit retry; mirror that.
      if (message.attempts > this.maxRetries) {
        this.dlq.push(message);
        this.history.push({
          queue: "webhook-events",
          attempts: this.maxRetries + 1,
          disposition: "dlq",
        });
      } else {
        this.main.push(message);
        this.history.push({
          queue: "webhook-events",
          attempts: message.attempts,
          disposition: "retry",
        });
      }
    }
  }

  private makeMessage(body: SimulatedMessageBody): SimulatedMessage {
    this.idSeq += 1;
    const id = `sim-msg-${this.idSeq}`;
    const message: SimulatedMessage = {
      id,
      timestamp: new Date("2026-05-19T00:00:00Z"),
      body,
      attempts: 0,
      acked: false,
      retried: false,
      retryAfterSeconds: undefined,
      ack() {
        this.acked = true;
      },
      retry(opts) {
        this.retried = true;
        this.retryAfterSeconds = opts?.delaySeconds;
      },
    };
    return message;
  }

  private adapt(message: SimulatedMessage): Message<WebhookQueueMessage | LegacyWebhookQueueMessage> {
    return {
      id: message.id,
      timestamp: message.timestamp,
      body: message.body,
      attempts: message.attempts,
      ack: () => message.ack(),
      retry: (opts?: { delaySeconds?: number }) => message.retry(opts),
    } as unknown as Message<WebhookQueueMessage | LegacyWebhookQueueMessage>;
  }
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function nangoMessage(overrides: Partial<NangoSyncQueueMessage> = {}): NangoSyncQueueMessage {
  return {
    version: 2,
    provider: "nango",
    ingress: "nango-sync",
    requestId: "req-dlq-replay-1",
    receivedAt: "2026-05-19T00:00:00Z",
    headers: {},
    payload: {
      storage: "inline",
      body: '{"id":"page-1"}',
      sizeBytes: 15,
      sha256: "sha-dlq-replay-1",
    },
    nango: {
      connectionId: "conn-dlq-replay",
      syncName: "fetch-spaces",
      model: "ConfluenceSpace",
      queryTimeStamp: "2026-05-19T00:00:00Z",
      cursor: "cursor-1",
      providerConfigKey: "confluence-relay",
    },
    dedupe: {
      kind: "nango-sync",
      connectionId: "conn-dlq-replay",
      syncName: "fetch-spaces",
      model: "ConfluenceSpace",
      windowKey: "2026-05-19T00:00:00Z",
      cursorKey: "cursor-1",
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("B2 end-to-end DLQ replay proof", () => {
  // `infra/webhook-queue.ts`:
  //   dlq: { queue: webhookEventsDlq..., retry: 5 }
  const MAX_RETRIES = 5;

  it("routes a max-retries-exhausted message to webhook-events-dlq, replays it, and dedupes on a subsequent redelivery", async () => {
    const dedupStore = new MemoryNangoSyncDedupStore();
    const simulator = new CloudflareQueueSimulator(MAX_RETRIES);

    // Track effective writebacks (the surrogate for Relayfile record
    // writes). The dedup contract is: at-most-one effective write per
    // dedupe_id across the full retry + DLQ-replay lifecycle.
    const relayfileWrites: { dedupeId: string; phase: string }[] = [];

    // ---- Phase 1: deterministic failure exhausts retries ----
    // The processor throws on every attempt, modelling a transient downstream
    // failure (e.g. relayfile 5xx). On each throw, `withWebhookDedup` calls
    // `fail(...)` on the dedup row, leaving status='failed' so the next
    // claim succeeds — matching the SQL `ON CONFLICT ... WHERE
    // status = 'failed'` clause in PostgresNangoSyncDedupStore.
    const failingProcessor: WebhookProcessor = vi.fn<WebhookProcessor>(async () => {
      throw new Error("downstream relayfile write 5xx");
    });

    simulator.enqueue(nangoMessage());

    // Drive the simulator until the queue settles (DLQ or empty main).
    // Each iteration is one consumer batch. We bound iterations strictly
    // to prove convergence rather than infinite-loop on a bug.
    let iterations = 0;
    while (simulator.main.length > 0 && iterations < MAX_RETRIES + 2) {
      await simulator.drive(failingProcessor, { dedupStore });
      iterations += 1;
    }

    // Assert: processor called MAX_RETRIES+1 times (initial attempt + 5
    // retries). After the (MAX_RETRIES+1)th attempt, the simulator routes
    // to the DLQ instead of re-enqueueing on main.
    expect(failingProcessor).toHaveBeenCalledTimes(MAX_RETRIES + 1);
    expect(simulator.main).toHaveLength(0);
    expect(simulator.dlq).toHaveLength(1);
    // History should contain MAX_RETRIES "throw" dispositions followed by
    // one "dlq" disposition.
    const phase1History = simulator.history.slice();
    expect(phase1History.filter((h) => h.disposition === "throw")).toHaveLength(MAX_RETRIES);
    expect(phase1History.filter((h) => h.disposition === "dlq")).toHaveLength(1);
    // Relayfile writes should still be zero — every attempt threw.
    expect(relayfileWrites).toHaveLength(0);
    // The dedup row is in `failed` status, with attemptCount tracking the
    // claim count (the SQL store increments on claim-after-fail).
    const dedupRows = Array.from(dedupStore.rows.values());
    expect(dedupRows).toHaveLength(1);
    expect(dedupRows[0].status).toBe("failed");

    // ---- Phase 2: DLQ-replay operator drains the DLQ back to main ----
    // This models the operator running a forwarder (in production:
    // `wrangler queues consumer add webhook-events-dlq <forwarder>`, where
    // the forwarder Worker `WEBHOOK_QUEUE.send(message.body)` re-enqueues
    // each DLQ message onto webhook-events).
    const replayedId = simulator.replayOneFromDlq();
    expect(replayedId).not.toBeNull();
    expect(simulator.dlq).toHaveLength(0);
    expect(simulator.main).toHaveLength(1);

    // ---- Phase 3: on replay, the downstream is healthy and the processor
    //               acks. The dedup row transitions failed → completed. ----
    const healthyProcessor: WebhookProcessor = vi.fn<WebhookProcessor>(async (message, body) => {
      const input = (body as NangoSyncQueueMessage).dedupe;
      relayfileWrites.push({
        dedupeId: `v1:${input.connectionId}|${input.syncName}|${input.model}|${input.windowKey}|${input.cursorKey}`,
        phase: "replay",
      });
      // A real processor must transition the queue message (ack on success,
      // retry on transient failure). The consumer's `shouldComplete:
      // disposition === "ack"` then maps the returned disposition to
      // dedup-store complete/fail in withWebhookDedup.
      message.ack();
      return "ack" as const;
    });

    await simulator.drive(healthyProcessor, { dedupStore });

    expect(healthyProcessor).toHaveBeenCalledTimes(1);
    expect(simulator.main).toHaveLength(0);
    expect(simulator.dlq).toHaveLength(0);
    expect(relayfileWrites).toHaveLength(1);
    expect(relayfileWrites[0].phase).toBe("replay");
    const replayRow = Array.from(dedupStore.rows.values())[0];
    expect(replayRow.status).toBe("completed");
    expect(replayRow.completedAt).toBeDefined();

    // ---- Phase 4: a subsequent redelivery (e.g. another DLQ replay run,
    //               or Nango re-delivering the same window) MUST observe
    //               duplicate_completed and ack WITHOUT invoking the
    //               processor. This is the "re-replayed messages dedupe
    //               correctly via nango_sync_dedup, don't double-write
    //               Relayfile records" half of the proof. ----
    const redeliveryProcessor: WebhookProcessor = vi.fn<WebhookProcessor>(async (message) => {
      relayfileWrites.push({ dedupeId: "should-not-happen", phase: "redelivery" });
      message.ack();
      return "ack" as const;
    });

    simulator.enqueue(nangoMessage());
    await simulator.drive(redeliveryProcessor, { dedupStore });

    expect(redeliveryProcessor).not.toHaveBeenCalled();
    // The Relayfile write counter MUST still be exactly one — no double
    // write on redelivery.
    expect(relayfileWrites).toHaveLength(1);
    // The dedup row stays completed.
    const finalRow = Array.from(dedupStore.rows.values())[0];
    expect(finalRow.status).toBe("completed");
  });

  it("is non-vacuous: removing the dedup completed-claim short-circuit causes a double Relayfile write on redelivery (negative-control)", async () => {
    // Negative-control proves the test is actually exercising the dedup
    // contract: if we replace the MemoryNangoSyncDedupStore with one that
    // never returns `duplicate_completed`, the redelivery in phase 4 WILL
    // double-write. If this assertion changes, the positive test above
    // would be vacuously passing.
    type ClaimResultOverride = Extract<DedupeClaimResult, { type: "claimed" }>;
    const alwaysClaim: NangoSyncDedupStore = {
      async claim(input): Promise<ClaimResultOverride> {
        return {
          type: "claimed",
          key: { surface: input.surface, dedupeId: input.dedupeId },
          attemptCount: 1,
          leaseExpiresAt: new Date(Date.now() + 60_000),
        };
      },
      async complete() {},
      async fail() {},
    };

    const simulator = new CloudflareQueueSimulator(MAX_RETRIES);
    const writes: number[] = [];
    const healthy: WebhookProcessor = vi.fn<WebhookProcessor>(async (message) => {
      writes.push(writes.length + 1);
      message.ack();
      return "ack" as const;
    });

    simulator.enqueue(nangoMessage());
    await simulator.drive(healthy, { dedupStore: alwaysClaim });
    expect(writes).toHaveLength(1);

    // "Redelivery": with a buggy/missing dedup store, the processor IS
    // re-invoked → double write. This proves the positive test isn't
    // accidentally green for the wrong reason.
    simulator.enqueue(nangoMessage());
    await simulator.drive(healthy, { dedupStore: alwaysClaim });
    expect(writes).toHaveLength(2);
  });
});
