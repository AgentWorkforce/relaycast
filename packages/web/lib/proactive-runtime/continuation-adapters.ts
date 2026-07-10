import { and, desc, eq } from "drizzle-orm";

import type {
  ContinuationRecord,
  ContinuationSchedulerAdapter,
  ContinuationStore,
  ContinuationWaitCondition,
} from "@agent-assistant/continuation";

import { getDb, type AppDb } from "@/lib/db";
import { proactiveContinuations } from "@/lib/db/schema";
import {
  createRelaycronSchedule,
  type CreateRelaycronScheduleInput,
} from "@/lib/workflow-schedules/relaycron-client";

export type ContinuationWaitForType = ContinuationWaitCondition["type"];

export class PostgresContinuationStore implements ContinuationStore {
  constructor(private readonly db: AppDb = getDb()) {}

  async put(record: ContinuationRecord): Promise<void> {
    const row = recordToRow(record);
    await this.db
      .insert(proactiveContinuations)
      .values(row)
      .onConflictDoUpdate({
        target: proactiveContinuations.id,
        set: {
          sessionId: row.sessionId,
          status: row.status,
          waitForType: row.waitForType,
          correlation: row.correlation,
          record: row.record,
          expiresAt: row.expiresAt,
          updatedAt: row.updatedAt,
        },
      });
  }

  async get(continuationId: string): Promise<ContinuationRecord | null> {
    const [row] = await this.db
      .select({ record: proactiveContinuations.record })
      .from(proactiveContinuations)
      .where(eq(proactiveContinuations.id, continuationId))
      .limit(1);
    return row ? cloneRecord(row.record) : null;
  }

  async delete(continuationId: string): Promise<void> {
    await this.db
      .delete(proactiveContinuations)
      .where(eq(proactiveContinuations.id, continuationId));
  }

  async listBySession(sessionId: string): Promise<ContinuationRecord[]> {
    const rows = await this.db
      .select({ record: proactiveContinuations.record })
      .from(proactiveContinuations)
      .where(eq(proactiveContinuations.sessionId, sessionId))
      .orderBy(desc(proactiveContinuations.updatedAt));
    return rows.map((row) => cloneRecord(row.record));
  }

  async findByCorrelation(
    waitForType: ContinuationWaitForType,
    correlationKey: string,
  ): Promise<string | null> {
    const [row] = await this.db
      .select({ id: proactiveContinuations.id })
      .from(proactiveContinuations)
      .where(
        and(
          eq(proactiveContinuations.waitForType, waitForType),
          eq(proactiveContinuations.correlation, correlationKey),
        ),
      )
      .orderBy(desc(proactiveContinuations.updatedAt))
      .limit(1);
    return row?.id ?? null;
  }
}

export type RelaycronContinuationClient = {
  createSchedule(input: CreateRelaycronScheduleInput): Promise<{ id: string }>;
};

export type RelaycronContinuationSchedulerOptions = {
  deliveryUrl: string;
  headers?: Record<string, string>;
  timezone?: string;
};

export class RelaycronContinuationSchedulerAdapter
  implements ContinuationSchedulerAdapter
{
  constructor(
    private readonly client: RelaycronContinuationClient,
    private readonly options: RelaycronContinuationSchedulerOptions,
  ) {}

  async scheduleWake(input: {
    continuationId: string;
    wakeAtMs: number;
  }): Promise<{ wakeUpId: string }> {
    const wakeUpId = continuationWakeUpId(input.continuationId);
    const scheduledAt = new Date(input.wakeAtMs).toISOString();
    await this.client.createSchedule({
      name: wakeUpId,
      description: `Continuation wake for ${input.continuationId}`,
      schedule_type: "once",
      scheduled_at: scheduledAt,
      timezone: this.options.timezone ?? "UTC",
      payload: {
        type: "continuation_wake",
        continuationId: input.continuationId,
        wakeUpId,
      },
      transport: {
        type: "webhook",
        url: this.options.deliveryUrl,
        headers: this.options.headers,
        timeout_ms: 10_000,
      },
      metadata: {
        source: "cloud",
        kind: "continuation_wake",
        continuationId: input.continuationId,
        wakeUpId,
      },
    });
    return { wakeUpId };
  }
}

export function createRelaycronContinuationClient(
  apiKey: string,
): RelaycronContinuationClient {
  return {
    createSchedule: (input) => createRelaycronSchedule(apiKey, input),
  };
}

export function continuationWakeUpId(continuationId: string): string {
  return `continuation:${continuationId}`;
}

function recordToRow(record: ContinuationRecord) {
  return {
    id: record.id,
    sessionId: record.sessionId ?? null,
    status: record.status,
    waitForType: record.waitFor.type,
    correlation: waitForCorrelation(record.waitFor),
    record: record as unknown as Record<string, unknown>,
    expiresAt: new Date(record.bounds.expiresAt),
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
  };
}

function waitForCorrelation(waitFor: ContinuationWaitCondition): string | null {
  switch (waitFor.type) {
    case "user_reply":
      return waitFor.correlationKey ?? null;
    case "approval_resolution":
      return waitFor.approvalId;
    case "external_result":
      return waitFor.operationId;
    case "scheduled_wake":
      return waitFor.wakeUpId ?? null;
  }
}

function cloneRecord(input: Record<string, unknown>): ContinuationRecord {
  return structuredClone(input) as unknown as ContinuationRecord;
}
