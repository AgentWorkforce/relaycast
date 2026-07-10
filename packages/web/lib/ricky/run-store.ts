import { and, desc, eq, max } from "drizzle-orm";
import { getDb } from "../db";
import {
  rickyAttempts,
  rickyHumanGates,
  rickyRunEvents,
  rickyRuns,
} from "../db/schema";
import type {
  GateResolution,
  RickyAttemptStatus,
  RickyAutoFixPolicy,
  RickyGateStatus,
  RickyRepairMode,
  RickyRunStatus,
} from "./types";
import { redactForRicky } from "./redaction";

type RickyRunRow = typeof rickyRuns.$inferSelect;
type RickyAttemptRow = typeof rickyAttempts.$inferSelect;
type RickyGateRow = typeof rickyHumanGates.$inferSelect;
type RickyEventRow = typeof rickyRunEvents.$inferSelect;

export type RickyRunRecord = ReturnType<typeof mapRun>;
export type RickyAttemptRecord = ReturnType<typeof mapAttempt>;
export type RickyGateRecord = ReturnType<typeof mapGate>;

function iso(date: Date | null): string | undefined {
  return date ? date.toISOString() : undefined;
}

function mapRun(row: RickyRunRow) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    workspaceId: row.workspaceId,
    userId: row.userId,
    rootWorkflowRunId: row.rootWorkflowRunId,
    activeWorkflowRunId: row.activeWorkflowRunId ?? undefined,
    status: row.status as RickyRunStatus,
    maxAttempts: row.maxAttempts,
    currentAttempt: row.currentAttempt,
    sourceWorkflowPath: row.sourceWorkflowPath ?? undefined,
    sourceFileType: row.sourceFileType,
    runtime: row.runtimeJson ?? undefined,
    autoFixPolicy: row.autoFixPolicyJson as RickyAutoFixPolicy,
    selectedAgent: row.selectedAgentJson ?? undefined,
    latestDiagnosis: row.latestDiagnosisJson ?? undefined,
    finalResult: row.finalResultJson ?? undefined,
    error: row.error ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: iso(row.completedAt),
  };
}

function mapAttempt(row: RickyAttemptRow) {
  return {
    id: row.id,
    rickyRunId: row.rickyRunId,
    attempt: row.attempt,
    workflowRunId: row.workflowRunId,
    previousWorkflowRunId: row.previousWorkflowRunId ?? undefined,
    startFromStep: row.startFromStep ?? undefined,
    role: row.role as "original" | "repaired_rerun",
    repairMode: (row.repairMode ?? "none") as RickyRepairMode,
    repairAgent: row.repairAgentJson ?? undefined,
    diagnosis: row.diagnosisJson ?? undefined,
    evidenceSnapshot: row.evidenceSnapshotJson ?? {},
    repairSummary: row.repairSummary ?? undefined,
    repairedWorkflowPath: row.repairedWorkflowPath ?? undefined,
    repairedWorkflowDigest: row.repairedWorkflowDigest ?? undefined,
    repairedArtifact: row.repairedArtifactJson ?? undefined,
    status: row.status as RickyAttemptStatus,
    error: row.error ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: iso(row.completedAt),
  };
}

function mapGate(row: RickyGateRow) {
  return {
    id: row.id,
    rickyRunId: row.rickyRunId,
    attemptId: row.attemptId,
    workflowRunId: row.workflowRunId ?? undefined,
    gateType: row.gateType,
    reason: row.reason,
    prompt: row.prompt,
    proposedAction: row.proposedActionJson ?? undefined,
    status: row.status as RickyGateStatus,
    requestedByAgent: row.requestedByAgentJson ?? undefined,
    resolvedByUserId: row.resolvedByUserId ?? undefined,
    resolution: row.resolutionJson ?? undefined,
    expiresAt: iso(row.expiresAt),
    createdAt: row.createdAt.toISOString(),
    resolvedAt: iso(row.resolvedAt),
  };
}

function mapEvent(row: RickyEventRow) {
  return {
    id: row.id,
    rickyRunId: row.rickyRunId,
    sequence: row.sequence,
    eventType: row.eventType,
    payload: row.payload,
    createdAt: row.createdAt.toISOString(),
  };
}

const EVENT_SEQUENCE_INSERT_RETRIES = 5;

function isUniqueSequenceConflict(error: unknown): boolean {
  const candidate = error as { code?: unknown; constraint?: unknown; message?: unknown };
  return (
    candidate?.code === "23505" ||
    candidate?.constraint === "ricky_run_events_run_sequence_unique" ||
    (typeof candidate?.message === "string" &&
      candidate.message.includes("ricky_run_events_run_sequence_unique"))
  );
}

export const rickyRunStore = {
  async createRun(input: {
    id: string;
    organizationId: string;
    workspaceId: string;
    userId: string;
    rootWorkflowRunId: string;
    activeWorkflowRunId: string;
    sourceWorkflowPath?: string;
    sourceFileType: string;
    runtime?: Record<string, unknown>;
    autoFixPolicy: RickyAutoFixPolicy;
    maxAttempts: number;
  }): Promise<RickyRunRecord> {
    const now = new Date();
    const [row] = await getDb()
      .insert(rickyRuns)
      .values({
        id: input.id,
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        userId: input.userId,
        rootWorkflowRunId: input.rootWorkflowRunId,
        activeWorkflowRunId: input.activeWorkflowRunId,
        status: "monitoring",
        maxAttempts: input.maxAttempts,
        currentAttempt: 1,
        sourceWorkflowPath: input.sourceWorkflowPath ?? null,
        sourceFileType: input.sourceFileType,
        runtimeJson: input.runtime ?? null,
        autoFixPolicyJson: input.autoFixPolicy,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return mapRun(row);
  },

  async getRun(id: string): Promise<RickyRunRecord | null> {
    const rows = await getDb().select().from(rickyRuns).where(eq(rickyRuns.id, id)).limit(1);
    return rows[0] ? mapRun(rows[0]) : null;
  },

  async getByRootWorkflowRunId(rootWorkflowRunId: string): Promise<RickyRunRecord | null> {
    const rows = await getDb()
      .select()
      .from(rickyRuns)
      .where(eq(rickyRuns.rootWorkflowRunId, rootWorkflowRunId))
      .orderBy(desc(rickyRuns.createdAt))
      .limit(1);
    return rows[0] ? mapRun(rows[0]) : null;
  },

  async updateRun(id: string, patch: {
    status?: RickyRunStatus;
    activeWorkflowRunId?: string | null;
    currentAttempt?: number;
    selectedAgent?: Record<string, unknown> | null;
    latestDiagnosis?: Record<string, unknown> | null;
    finalResult?: Record<string, unknown> | null;
    error?: string | null;
    completedAt?: Date | null;
  }): Promise<RickyRunRecord> {
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.status !== undefined) updates.status = patch.status;
    if (patch.activeWorkflowRunId !== undefined) updates.activeWorkflowRunId = patch.activeWorkflowRunId;
    if (patch.currentAttempt !== undefined) updates.currentAttempt = patch.currentAttempt;
    if (patch.selectedAgent !== undefined) updates.selectedAgentJson = redactForRicky(patch.selectedAgent);
    if (patch.latestDiagnosis !== undefined) updates.latestDiagnosisJson = redactForRicky(patch.latestDiagnosis);
    if (patch.finalResult !== undefined) updates.finalResultJson = redactForRicky(patch.finalResult);
    if (patch.error !== undefined) updates.error = patch.error;
    if (patch.completedAt !== undefined) updates.completedAt = patch.completedAt;

    const [row] = await getDb().update(rickyRuns).set(updates).where(eq(rickyRuns.id, id)).returning();
    if (!row) throw new Error(`Ricky run not found: ${id}`);
    return mapRun(row);
  },

  async createAttempt(input: {
    rickyRunId: string;
    attempt: number;
    workflowRunId: string;
    previousWorkflowRunId?: string;
    startFromStep?: string;
    role: "original" | "repaired_rerun";
    repairMode?: RickyRepairMode;
    repairAgent?: Record<string, unknown>;
    repairSummary?: string;
    repairedWorkflowPath?: string;
    repairedWorkflowDigest?: string;
    repairedArtifact?: Record<string, unknown>;
    status: RickyAttemptStatus;
  }): Promise<RickyAttemptRecord> {
    const now = new Date();
    const [row] = await getDb()
      .insert(rickyAttempts)
      .values({
        id: crypto.randomUUID(),
        rickyRunId: input.rickyRunId,
        attempt: input.attempt,
        workflowRunId: input.workflowRunId,
        previousWorkflowRunId: input.previousWorkflowRunId ?? null,
        startFromStep: input.startFromStep ?? null,
        role: input.role,
        repairMode: input.repairMode ?? null,
        repairAgentJson: input.repairAgent ?? null,
        repairSummary: input.repairSummary ?? null,
        repairedWorkflowPath: input.repairedWorkflowPath ?? null,
        repairedWorkflowDigest: input.repairedWorkflowDigest ?? null,
        repairedArtifactJson: input.repairedArtifact ?? null,
        status: input.status,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return mapAttempt(row);
  },

  async listAttempts(rickyRunId: string): Promise<RickyAttemptRecord[]> {
    const rows = await getDb()
      .select()
      .from(rickyAttempts)
      .where(eq(rickyAttempts.rickyRunId, rickyRunId))
      .orderBy(rickyAttempts.attempt);
    return rows.map(mapAttempt);
  },

  async getAttempt(id: string): Promise<RickyAttemptRecord | null> {
    const rows = await getDb()
      .select()
      .from(rickyAttempts)
      .where(eq(rickyAttempts.id, id))
      .limit(1);
    return rows[0] ? mapAttempt(rows[0]) : null;
  },

  async getAttemptByNumber(rickyRunId: string, attempt: number): Promise<RickyAttemptRecord | null> {
    const rows = await getDb()
      .select()
      .from(rickyAttempts)
      .where(and(eq(rickyAttempts.rickyRunId, rickyRunId), eq(rickyAttempts.attempt, attempt)))
      .limit(1);
    return rows[0] ? mapAttempt(rows[0]) : null;
  },

  async updateAttempt(id: string, patch: {
    status?: RickyAttemptStatus;
    repairMode?: RickyRepairMode | null;
    repairAgent?: Record<string, unknown> | null;
    diagnosis?: Record<string, unknown> | null;
    evidenceSnapshot?: Record<string, unknown>;
    repairSummary?: string | null;
    repairedWorkflowPath?: string | null;
    repairedWorkflowDigest?: string | null;
    repairedArtifact?: Record<string, unknown> | null;
    error?: string | null;
    completedAt?: Date | null;
  }): Promise<RickyAttemptRecord> {
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.status !== undefined) updates.status = patch.status;
    if (patch.repairMode !== undefined) updates.repairMode = patch.repairMode;
    if (patch.repairAgent !== undefined) updates.repairAgentJson = patch.repairAgent;
    if (patch.diagnosis !== undefined) updates.diagnosisJson = patch.diagnosis;
    if (patch.evidenceSnapshot !== undefined) updates.evidenceSnapshotJson = redactForRicky(patch.evidenceSnapshot);
    if (patch.repairSummary !== undefined) updates.repairSummary = patch.repairSummary;
    if (patch.repairedWorkflowPath !== undefined) updates.repairedWorkflowPath = patch.repairedWorkflowPath;
    if (patch.repairedWorkflowDigest !== undefined) updates.repairedWorkflowDigest = patch.repairedWorkflowDigest;
    if (patch.repairedArtifact !== undefined) updates.repairedArtifactJson = redactForRicky(patch.repairedArtifact);
    if (patch.error !== undefined) updates.error = patch.error;
    if (patch.completedAt !== undefined) updates.completedAt = patch.completedAt;

    const [row] = await getDb()
      .update(rickyAttempts)
      .set(updates)
      .where(eq(rickyAttempts.id, id))
      .returning();
    if (!row) throw new Error(`Ricky attempt not found: ${id}`);
    return mapAttempt(row);
  },

  async createGate(input: {
    rickyRunId: string;
    attemptId: string;
    workflowRunId?: string;
    gateType: string;
    reason: string;
    prompt: string;
    proposedAction?: Record<string, unknown>;
    requestedByAgent?: Record<string, unknown>;
  }): Promise<RickyGateRecord> {
    const [row] = await getDb()
      .insert(rickyHumanGates)
      .values({
        id: crypto.randomUUID(),
        rickyRunId: input.rickyRunId,
        attemptId: input.attemptId,
        workflowRunId: input.workflowRunId ?? null,
        gateType: input.gateType,
        reason: input.reason,
        prompt: input.prompt,
        proposedActionJson: input.proposedAction ? redactForRicky(input.proposedAction) : null,
        status: "open",
        requestedByAgentJson: input.requestedByAgent ? redactForRicky(input.requestedByAgent) : null,
        createdAt: new Date(),
      })
      .returning();
    return mapGate(row);
  },

  async getGate(gateId: string): Promise<RickyGateRecord | null> {
    const rows = await getDb()
      .select()
      .from(rickyHumanGates)
      .where(eq(rickyHumanGates.id, gateId))
      .limit(1);
    return rows[0] ? mapGate(rows[0]) : null;
  },

  async listGates(rickyRunId: string): Promise<RickyGateRecord[]> {
    const rows = await getDb()
      .select()
      .from(rickyHumanGates)
      .where(eq(rickyHumanGates.rickyRunId, rickyRunId))
      .orderBy(desc(rickyHumanGates.createdAt));
    return rows.map(mapGate);
  },

  async resolveGate(gateId: string, userId: string, resolution: GateResolution): Promise<RickyGateRecord> {
    const status: RickyGateStatus =
      resolution.decision === "approve" ? "approved" : resolution.decision === "deny" ? "denied" : "edited";
    const [row] = await getDb()
      .update(rickyHumanGates)
      .set({
        status,
        resolvedByUserId: userId,
        resolutionJson: redactForRicky(resolution),
        resolvedAt: new Date(),
      })
      .where(eq(rickyHumanGates.id, gateId))
      .returning();
    if (!row) throw new Error(`Ricky gate not found: ${gateId}`);
    return mapGate(row);
  },

  async appendEvent(rickyRunId: string, eventType: string, payload: Record<string, unknown> = {}) {
    for (let attempt = 1; attempt <= EVENT_SEQUENCE_INSERT_RETRIES; attempt += 1) {
      const db = getDb();
      const [latest] = await db
        .select({ sequence: max(rickyRunEvents.sequence) })
        .from(rickyRunEvents)
        .where(eq(rickyRunEvents.rickyRunId, rickyRunId));
      const sequence = (latest?.sequence ?? 0) + 1;
      try {
        const [row] = await db
          .insert(rickyRunEvents)
          .values({
            id: crypto.randomUUID(),
            rickyRunId,
            sequence,
            eventType,
            payload: redactForRicky(payload),
            createdAt: new Date(),
          })
          .returning();
        return mapEvent(row);
      } catch (error) {
        if (attempt === EVENT_SEQUENCE_INSERT_RETRIES || !isUniqueSequenceConflict(error)) {
          throw error;
        }
      }
    }
    throw new Error("Unable to append Ricky event after sequence conflict retries.");
  },

  async listEvents(rickyRunId: string) {
    const rows = await getDb()
      .select()
      .from(rickyRunEvents)
      .where(eq(rickyRunEvents.rickyRunId, rickyRunId))
      .orderBy(rickyRunEvents.sequence);
    return rows.map(mapEvent);
  },
};
