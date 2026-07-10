import { PGlite } from "@electric-sql/pglite";
import {
  ContinuationAlreadyTerminalError,
  createContinuationRuntime,
} from "@agent-assistant/continuation";
import type {
  ContinuationRecord,
  ContinuationResumedTurnInput,
  ContinuationResumeTrigger,
  HarnessResult,
} from "@agent-assistant/continuation";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PostgresContinuationStore,
  RelaycronContinuationSchedulerAdapter,
} from "./continuation-adapters";
import * as schema from "@/lib/db/schema";

const PROACTIVE_CONTINUATIONS_DDL = `
CREATE TABLE proactive_continuations (
  id text PRIMARY KEY,
  session_id text,
  status text NOT NULL,
  wait_for_type text NOT NULL,
  correlation text,
  record jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_proactive_continuations_session_id
  ON proactive_continuations (session_id);
CREATE INDEX idx_proactive_continuations_wait_for_type
  ON proactive_continuations (wait_for_type);
CREATE INDEX idx_proactive_continuations_correlation
  ON proactive_continuations (correlation);
`;

let pg: PGlite | null = null;

afterEach(async () => {
  await pg?.close();
  pg = null;
});

describe("PostgresContinuationStore", () => {
  it("round-trips continuation records through Postgres storage", async () => {
    const store = await createTestStore();
    const record = continuationRecord({
      id: "cont_roundtrip",
      sessionId: "session-roundtrip",
      waitFor: { type: "scheduled_wake", wakeUpId: "continuation:cont_roundtrip" },
    });

    await store.put(record);

    await expect(store.get(record.id)).resolves.toMatchObject({
      id: "cont_roundtrip",
      sessionId: "session-roundtrip",
      waitFor: {
        type: "scheduled_wake",
        wakeUpId: "continuation:cont_roundtrip",
      },
    });
    await expect(store.listBySession("session-roundtrip")).resolves.toHaveLength(1);

    await store.delete(record.id);
    await expect(store.get(record.id)).resolves.toBeNull();
  });

  it("resolves user-reply correlations to continuation ids before resume", async () => {
    const store = await createTestStore();
    const scheduler = new InMemoryRelaycronContinuationScheduler();
    const resumedTurns: ContinuationResumedTurnInput[] = [];
    const runtime = createContinuationRuntime({
      store,
      scheduler,
      clock: new FixedClock("2026-06-02T10:00:00.000Z"),
      defaults: { maxResumeAttempts: 3 },
      harness: {
        runResumedTurn: vi.fn(async (input: ContinuationResumedTurnInput) => {
          resumedTurns.push(input);
          return completedHarnessResult(input.resumedTurnId, input.continuation.sessionId);
        }),
      },
    });
    await store.put(
      continuationRecord({
        id: "cont_user_reply_alpha",
        sessionId: "session-alpha",
        waitFor: { type: "user_reply", correlationKey: "reply-alpha" },
      }),
    );
    await store.put(
      continuationRecord({
        id: "cont_user_reply_beta",
        sessionId: "session-beta",
        waitFor: { type: "user_reply", correlationKey: "reply-beta" },
      }),
    );

    await expect(
      store.findByCorrelation("user_reply", "reply-alpha"),
    ).resolves.toBe("cont_user_reply_alpha");
    await expect(
      store.findByCorrelation("user_reply", "reply-beta"),
    ).resolves.toBe("cont_user_reply_beta");
    await expect(
      store.findByCorrelation("user_reply", "missing-reply"),
    ).resolves.toBeNull();

    const continuationId = await store.findByCorrelation("user_reply", "reply-alpha");
    expect(continuationId).toBe("cont_user_reply_alpha");

    const resumed = await runtime.resume({
      continuationId: continuationId!,
      trigger: {
        type: "user_reply",
        receivedAt: "2026-06-02T10:00:05.000Z",
        message: {
          id: "msg-1",
          text: "continue",
          receivedAt: "2026-06-02T10:00:05.000Z",
        },
      },
    });

    expect(resumed.continuation).toMatchObject({
      id: "cont_user_reply_alpha",
      status: "completed",
      terminalReason: "completed",
    });
    expect(resumedTurns).toHaveLength(1);
    await expect(store.get("cont_user_reply_alpha")).resolves.toMatchObject({
      status: "completed",
      terminalReason: "completed",
    });
  });
});

describe("RelaycronContinuationSchedulerAdapter", () => {
  it("round-trips a scheduled wake and treats duplicate relaycron fires as terminal no-ops", async () => {
    const store = await createTestStore();
    const scheduler = new InMemoryRelaycronContinuationScheduler();
    const resumedTurns: ContinuationResumedTurnInput[] = [];
    const clock = new MutableClock(Date.parse("2026-06-02T10:05:00.000Z"));
    const runtime = createContinuationRuntime({
      store,
      scheduler,
      clock,
      defaults: {
        scheduledWakeTtlMs: 60_000,
        maxResumeAttempts: 3,
      },
      harness: {
        runResumedTurn: vi.fn(async (input: ContinuationResumedTurnInput) => {
          resumedTurns.push(input);
          return completedHarnessResult(input.resumedTurnId, input.continuation.sessionId);
        }),
      },
    });

    const created = await runtime.create({
      assistantId: "assistant-scheduled",
      sessionId: "session-scheduled",
      originTurnId: "turn-scheduled",
      harnessResult: deferredScheduledWakeHarnessResult(),
      metadata: { scheduledWake: true },
    });

    expect(created.scheduledWakeId).toBe(`continuation:${created.continuation.id}`);
    expect(scheduler.get(created.continuation.id)).toMatchObject({
      name: `continuation:${created.continuation.id}`,
      scheduled_at: "2026-06-02T10:06:00.000Z",
    });
    await expect(store.get(created.continuation.id)).resolves.toMatchObject({
      status: "pending",
      waitFor: {
        type: "scheduled_wake",
        wakeUpId: `continuation:${created.continuation.id}`,
      },
    });

    clock.set(Date.parse("2026-06-02T10:05:30.000Z"));
    const firstWake = scheduler.fire(created.continuation.id);
    const resumed = await runtime.resume(firstWake);

    expect(resumed.continuation).toMatchObject({
      status: "completed",
      terminalReason: "completed",
    });
    expect(resumedTurns).toHaveLength(1);

    const secondWake = scheduler.fire(created.continuation.id);
    await expect(runtime.resume(secondWake)).rejects.toBeInstanceOf(
      ContinuationAlreadyTerminalError,
    );
    expect(resumedTurns).toHaveLength(1);
    await expect(store.get(created.continuation.id)).resolves.toMatchObject({
      status: "completed",
      terminalReason: "completed",
    });
  });
});

async function createTestStore(): Promise<PostgresContinuationStore> {
  pg = new PGlite();
  await pg.exec(PROACTIVE_CONTINUATIONS_DDL);
  const db = drizzle(pg, { schema });
  return new PostgresContinuationStore(db as never);
}

class InMemoryRelaycronContinuationScheduler extends RelaycronContinuationSchedulerAdapter {
  private readonly schedules = new Map<
    string,
    {
      name: string;
      scheduled_at: string;
      payload: { continuationId: string; wakeUpId: string };
    }
  >();

  constructor() {
    super(
      {
        createSchedule: async (input) => {
          const continuationId = String(
            (input.payload as { continuationId?: unknown }).continuationId,
          );
          const wakeUpId = String((input.payload as { wakeUpId?: unknown }).wakeUpId);
          this.schedules.set(continuationId, {
            name: input.name,
            scheduled_at: input.scheduled_at!,
            payload: { continuationId, wakeUpId },
          });
          return { id: wakeUpId };
        },
      },
      {
        deliveryUrl: "https://cloud.test/api/internal/proactive-runtime/continuations/wake",
      },
    );
  }

  get(continuationId: string) {
    return this.schedules.get(continuationId) ?? null;
  }

  fire(continuationId: string): {
    continuationId: string;
    trigger: ContinuationResumeTrigger;
  } {
    const schedule = this.schedules.get(continuationId);
    if (schedule === undefined) {
      throw new Error(`No scheduled wake for ${continuationId}`);
    }
    return {
      continuationId,
      trigger: {
        type: "scheduled_wake",
        wakeUpId: schedule.payload.wakeUpId,
        firedAt: "2026-06-02T10:05:30.000Z",
      },
    };
  }
}

class FixedClock {
  constructor(private readonly iso: string) {}

  nowMs(): number {
    return Date.parse(this.iso);
  }

  nowIso(): string {
    return this.iso;
  }
}

class MutableClock {
  constructor(private now: number) {}

  set(now: number): void {
    this.now = now;
  }

  nowMs(): number {
    return this.now;
  }

  nowIso(): string {
    return new Date(this.now).toISOString();
  }
}

function continuationRecord(input: {
  id: string;
  sessionId: string;
  waitFor: ContinuationRecord["waitFor"];
}): ContinuationRecord {
  return {
    id: input.id,
    assistantId: "assistant-1",
    sessionId: input.sessionId,
    origin: {
      turnId: `origin-${input.id}`,
      outcome: input.waitFor.type === "scheduled_wake" ? "deferred" : "needs_clarification",
      stopReason: "clarification_required",
      createdAt: "2026-06-02T10:00:00.000Z",
    },
    status: "pending",
    waitFor: input.waitFor,
    continuation: {
      id: `harness-${input.id}`,
      type: input.waitFor.type === "scheduled_wake" ? "deferred" : "clarification",
      createdAt: "2026-06-02T10:00:00.000Z",
      turnId: `origin-${input.id}`,
      sessionId: input.sessionId,
      resumeToken: `resume-${input.id}`,
      state: {},
    },
    delivery: { status: "not_applicable" },
    bounds: {
      expiresAt: "2026-06-02T11:00:00.000Z",
      maxResumeAttempts: 3,
      resumeAttempts: 0,
    },
    createdAt: "2026-06-02T10:00:00.000Z",
    updatedAt: "2026-06-02T10:00:00.000Z",
  };
}

function deferredScheduledWakeHarnessResult(): HarnessResult {
  return {
    outcome: "deferred",
    stopReason: "max_iterations_reached",
    turnId: "turn-scheduled-wake",
    sessionId: "session-scheduled",
    continuation: {
      id: "harness-scheduled-wake",
      type: "deferred",
      createdAt: "2026-06-02T10:05:00.000Z",
      turnId: "turn-scheduled-wake",
      sessionId: "session-scheduled",
      resumeToken: "resume-scheduled-wake",
      state: {},
    },
    traceSummary: {
      iterationCount: 1,
      toolCallCount: 0,
      hadContinuation: true,
      finalEventType: "turn_finished",
    },
    usage: {
      modelCalls: 0,
      toolCalls: 0,
    },
  };
}

function completedHarnessResult(
  turnId: string,
  sessionId: string | undefined,
): HarnessResult {
  return {
    outcome: "completed",
    stopReason: "answer_finalized",
    turnId,
    sessionId: sessionId ?? "session-unknown",
    assistantMessage: {
      text: "resumed",
    },
    traceSummary: {
      iterationCount: 1,
      toolCallCount: 0,
      hadContinuation: false,
      finalEventType: "turn_finished",
    },
    usage: {
      modelCalls: 0,
      toolCalls: 0,
    },
  };
}
