import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { EncryptedEnvelope } from "@cloud/core/auth/credential-encryption.js";
import { getDb } from "@/lib/db";
import { workflowRuns, workflowSchedules } from "@/lib/db/schema";
import type { AppDb } from "@/lib/db";
import type { RelaycronScheduleStatus, RelaycronScheduleType } from "./relaycron-client";

export type WorkflowScheduleRecord = {
  id: string;
  relaycronScheduleId: string;
  relaycronApiKeyEnvelope: EncryptedEnvelope;
  userId: string;
  workspaceId: string;
  organizationId: string;
  name: string;
  description: string | null;
  scheduleType: RelaycronScheduleType;
  cronExpression: string | null;
  scheduledAt: Date | null;
  timezone: string;
  status: RelaycronScheduleStatus | "deleted";
  workflowRequestEnvelope: EncryptedEnvelope;
  webhookSecretHash: string;
  lastTriggeredRunId: string | null;
  lastTriggeredAt: Date | null;
  lastTriggerStatus: string | null;
  lastTriggerError: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicWorkflowScheduleRecord = Omit<
  WorkflowScheduleRecord,
  "relaycronApiKeyEnvelope" | "workflowRequestEnvelope" | "webhookSecretHash"
>;

export type WorkflowScheduleCreateInput = {
  id: string;
  relaycronScheduleId: string;
  relaycronApiKeyEnvelope: EncryptedEnvelope;
  userId: string;
  workspaceId: string;
  organizationId: string;
  name: string;
  description?: string | null;
  scheduleType: RelaycronScheduleType;
  cronExpression?: string | null;
  scheduledAt?: Date | null;
  timezone: string;
  status?: RelaycronScheduleStatus;
  workflowRequestEnvelope: EncryptedEnvelope;
  webhookSecretHash: string;
};

export type WorkflowScheduleUpdateInput = Partial<{
  relaycronScheduleId: string;
  relaycronApiKeyEnvelope: EncryptedEnvelope;
  name: string;
  description: string | null;
  cronExpression: string | null;
  scheduledAt: Date | null;
  timezone: string;
  status: RelaycronScheduleStatus | "deleted";
  workflowRequestEnvelope: EncryptedEnvelope;
  lastTriggeredRunId: string | null;
  lastTriggeredAt: Date | null;
  lastTriggerStatus: string | null;
  lastTriggerError: string | null;
}>;

function rowToRecord(row: typeof workflowSchedules.$inferSelect): WorkflowScheduleRecord {
  return {
    id: row.id,
    relaycronScheduleId: row.relaycronScheduleId,
    relaycronApiKeyEnvelope: row.relaycronApiKeyEnvelope,
    userId: row.userId,
    workspaceId: row.workspaceId,
    organizationId: row.organizationId,
    name: row.name,
    description: row.description ?? null,
    scheduleType: row.scheduleType as RelaycronScheduleType,
    cronExpression: row.cronExpression ?? null,
    scheduledAt: row.scheduledAt ?? null,
    timezone: row.timezone,
    status: row.status as WorkflowScheduleRecord["status"],
    workflowRequestEnvelope: row.workflowRequestEnvelope,
    webhookSecretHash: row.webhookSecretHash,
    lastTriggeredRunId: row.lastTriggeredRunId ?? null,
    lastTriggeredAt: row.lastTriggeredAt ?? null,
    lastTriggerStatus: row.lastTriggerStatus ?? null,
    lastTriggerError: row.lastTriggerError ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toPublicWorkflowSchedule(
  record: WorkflowScheduleRecord,
): PublicWorkflowScheduleRecord {
  const {
    relaycronApiKeyEnvelope: _relaycronApiKeyEnvelope,
    workflowRequestEnvelope: _workflowRequestEnvelope,
    webhookSecretHash: _webhookSecretHash,
    ...publicRecord
  } = record;
  return publicRecord;
}

export function createWorkflowScheduleStore(db: AppDb = getDb()) {
  return {
    async create(input: WorkflowScheduleCreateInput): Promise<WorkflowScheduleRecord> {
      const now = new Date();
      const [row] = await db
        .insert(workflowSchedules)
        .values({
          id: input.id,
          relaycronScheduleId: input.relaycronScheduleId,
          relaycronApiKeyEnvelope: input.relaycronApiKeyEnvelope,
          userId: input.userId,
          workspaceId: input.workspaceId,
          organizationId: input.organizationId,
          name: input.name,
          description: input.description ?? null,
          scheduleType: input.scheduleType,
          cronExpression: input.cronExpression ?? null,
          scheduledAt: input.scheduledAt ?? null,
          timezone: input.timezone,
          status: input.status ?? "active",
          workflowRequestEnvelope: input.workflowRequestEnvelope,
          webhookSecretHash: input.webhookSecretHash,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      return rowToRecord(row);
    },

    async get(id: string): Promise<WorkflowScheduleRecord | null> {
      const [row] = await db
        .select()
        .from(workflowSchedules)
        .where(eq(workflowSchedules.id, id))
        .limit(1);
      return row ? rowToRecord(row) : null;
    },

    async getForWorkspace(
      id: string,
      workspaceId: string,
    ): Promise<WorkflowScheduleRecord | null> {
      const [row] = await db
        .select()
        .from(workflowSchedules)
        .where(and(eq(workflowSchedules.id, id), eq(workflowSchedules.workspaceId, workspaceId)))
        .limit(1);
      return row ? rowToRecord(row) : null;
    },

    async existingWorkflowRunIds(runIds: string[]): Promise<Set<string>> {
      if (runIds.length === 0) {
        return new Set();
      }
      const rows = await db
        .select({ id: workflowRuns.id })
        .from(workflowRuns)
        .where(inArray(workflowRuns.id, runIds));
      return new Set(rows.map((row) => row.id));
    },

    async listByWorkspaceIds(workspaceIds: string[]): Promise<WorkflowScheduleRecord[]> {
      if (workspaceIds.length === 0) {
        return [];
      }
      const rows = await db
        .select()
        .from(workflowSchedules)
        .where(inArray(workflowSchedules.workspaceId, workspaceIds))
        .orderBy(desc(workflowSchedules.createdAt));
      return rows.map(rowToRecord);
    },

    async listByWorkspace(workspaceId: string): Promise<WorkflowScheduleRecord[]> {
      const rows = await db
        .select()
        .from(workflowSchedules)
        .where(eq(workflowSchedules.workspaceId, workspaceId))
        .orderBy(desc(workflowSchedules.createdAt));
      return rows.map(rowToRecord);
    },

    async update(id: string, patch: WorkflowScheduleUpdateInput): Promise<WorkflowScheduleRecord> {
      const [row] = await db
        .update(workflowSchedules)
        .set({
          ...patch,
          updatedAt: new Date(),
        })
        .where(eq(workflowSchedules.id, id))
        .returning();
      if (!row) {
        throw new Error(`Workflow schedule not found: ${id}`);
      }
      return rowToRecord(row);
    },

    async claimOnceTrigger(
      id: string,
      triggeredAt: Date,
    ): Promise<WorkflowScheduleRecord | null> {
      const [row] = await db
        .update(workflowSchedules)
        .set({
          status: "completed",
          lastTriggeredRunId: null,
          lastTriggeredAt: triggeredAt,
          lastTriggerStatus: "launching",
          lastTriggerError: null,
          updatedAt: triggeredAt,
        })
        .where(
          and(
            eq(workflowSchedules.id, id),
            eq(workflowSchedules.scheduleType, "once"),
            eq(workflowSchedules.status, "active"),
            isNull(workflowSchedules.lastTriggeredRunId),
            isNull(workflowSchedules.lastTriggeredAt),
          ),
        )
        .returning();
      return row ? rowToRecord(row) : null;
    },

    async delete(id: string): Promise<void> {
      await db.delete(workflowSchedules).where(eq(workflowSchedules.id, id));
    },
  };
}

export type WorkflowScheduleStore = ReturnType<typeof createWorkflowScheduleStore>;

let defaultWorkflowScheduleStore: WorkflowScheduleStore | undefined;

export function getWorkflowScheduleStore(): WorkflowScheduleStore {
  defaultWorkflowScheduleStore ??= createWorkflowScheduleStore();
  return defaultWorkflowScheduleStore;
}

export const workflowScheduleStore = new Proxy({} as WorkflowScheduleStore, {
  get(_target, property) {
    return getWorkflowScheduleStore()[property as keyof WorkflowScheduleStore];
  },
});
