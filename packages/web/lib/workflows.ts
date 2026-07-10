import { mintS3Credentials, type MintS3CredentialsOptions } from "@cloud/core/auth/s3-credentials.js";
import {
  launchOrchestratorSandbox,
  resolveCredentialProxyConfig,
  type LaunchOptions,
  type LaunchResult,
} from "@cloud/core/bootstrap/launcher.js";
import { buildCredentialBundle, type CredentialBundle } from "@cloud/core/auth/credentials.js";
import { getCliCredentials, resolveCredentialProvider, workflowNeedsCliCredentials, getAllProviders, listConnectedProviders } from "@cloud/core/auth/cli-credentials.js";
import type { StepMetadata } from "@cloud/core/storage/metadata.js";
import { eq, desc, inArray, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { workflowRuns, workflowSteps } from "@/lib/db/schema";

export type WorkflowFileType = "yaml" | "ts" | "py";
export type WorkflowSourceFileType = WorkflowFileType | "workflow";
export type { MintS3CredentialsOptions, LaunchOptions, LaunchResult, CredentialBundle };
export { buildCredentialBundle, resolveCredentialProxyConfig };

export type PathSubmission = {
  name: string;
  s3CodeKey: string;
  repoOwner?: string;
  repoName?: string;
  pushBranch?: string;
  pushBase?: string;
  pushPrBody?: string;
};

export type WorkflowPathPushResult =
  | {
      status: "pushed";
      branch: string;
      prUrl: string;
      sha: string;
      base: {
        branch: string;
        sha: string;
      };
      strategy: "contents_api" | "git_db";
      pushedAt: string;
    }
  | {
      status: "failed";
      code:
        | "base_branch_moved"
        | "patch_too_large"
        | "patch_unapplyable"
        | "integration_not_found"
        | "installation_token_failed"
        | "github_api_error";
      message: string;
      base?: {
        branch: string;
        sha: string;
      };
      observedBaseSha?: string;
      failedAt: string;
    };

export type WorkflowPushedTo = Record<string, WorkflowPathPushResult>;

export interface WorkflowRecord {
  runId: string;
  sandboxId: string | null;
  dispatchType: string;
  userId: string;
  workspaceId: string;
  relayWorkspaceId?: string;
  relayauthIdentityId?: string;
  workflow: string;
  fileType: WorkflowFileType;
  status: string;
  callbackToken: string;
  createdAt: string;
  updatedAt: string;
  result?: unknown;
  error?: string;
  paths?: PathSubmission[];
  pushedTo?: WorkflowPushedTo;
}

export interface WorkflowCreateInput {
  runId: string;
  sandboxId: string | null;
  dispatchType?: string;
  userId: string;
  workspaceId: string;
  relayWorkspaceId?: string;
  relayauthIdentityId?: string;
  workflow: string;
  fileType: WorkflowFileType;
  callbackToken: string;
  status: string;
  paths?: PathSubmission[];
}

export interface WorkflowPatch {
  status?: string;
  result?: unknown;
  error?: string;
  pushedTo?: WorkflowPushedTo;
  sandboxId?: string | null;
  relayWorkspaceId?: string;
}

function rowToRecord(row: typeof workflowRuns.$inferSelect): WorkflowRecord {
  return {
    runId: row.id,
    sandboxId: row.sandboxId,
    dispatchType: row.dispatchType,
    userId: row.userId,
    workspaceId: row.workspaceId,
    relayWorkspaceId: row.relayWorkspaceId ?? undefined,
    relayauthIdentityId: row.relayauthIdentityId ?? undefined,
    workflow: row.workflow,
    fileType: row.fileType as WorkflowFileType,
    status: row.status,
    callbackToken: row.callbackToken,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    result: row.result ? JSON.parse(row.result) : undefined,
    error: row.error ?? undefined,
    paths: row.paths ?? undefined,
    pushedTo: (row.pushedTo as WorkflowPushedTo | null) ?? undefined,
  };
}

function stepRowToMetadata(row: typeof workflowSteps.$inferSelect): StepMetadata {
  return {
    stepName: row.stepName,
    agent: row.agent,
    preset: row.preset,
    cli: row.cli,
    sandboxId: row.sandboxId,
    startTime: row.startTime,
    endTime: row.endTime,
    durationMs: row.durationMs,
    exitCode: row.exitCode,
    outputSummary: row.outputSummary,
    error: row.error ?? undefined,
  };
}

export const workflowStore = {
  async create(input: WorkflowCreateInput): Promise<WorkflowRecord> {
    const db = getDb();
    const now = new Date();
    const [row] = await db
      .insert(workflowRuns)
      .values({
        id: input.runId,
        sandboxId: input.sandboxId,
        dispatchType: input.dispatchType ?? "sandbox",
        userId: input.userId,
        workspaceId: input.workspaceId,
        relayWorkspaceId: input.relayWorkspaceId ?? null,
        relayauthIdentityId: input.relayauthIdentityId ?? null,
        workflow: input.workflow,
        fileType: input.fileType,
        callbackToken: input.callbackToken,
        status: input.status,
        paths: input.paths ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return rowToRecord(row);
  },

  async get(runId: string): Promise<WorkflowRecord | null> {
    const db = getDb();
    const rows = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, runId))
      .limit(1);
    if (rows.length === 0) return null;
    return rowToRecord(rows[0]);
  },

  async update(runId: string, patch: WorkflowPatch): Promise<WorkflowRecord> {
    const db = getDb();
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.status !== undefined) updates.status = patch.status;
    if (patch.result !== undefined) updates.result = JSON.stringify(patch.result);
    if (patch.error !== undefined) updates.error = patch.error;
    if (patch.sandboxId !== undefined) updates.sandboxId = patch.sandboxId;
    if (patch.relayWorkspaceId !== undefined) updates.relayWorkspaceId = patch.relayWorkspaceId;
    if (patch.pushedTo !== undefined) {
      // Atomic merge: SELECT-then-UPDATE has a TOCTOU race that drops keys
      // when two updates fire concurrently (each sees the other's pre-state
      // and overwrites). Push the merge into Postgres via the jsonb `||`
      // operator so disjoint key writes both land regardless of ordering.
      updates.pushedTo = sql`COALESCE(${workflowRuns.pushedTo}, '{}'::jsonb) || ${JSON.stringify(patch.pushedTo)}::jsonb`;
    }

    const [row] = await db
      .update(workflowRuns)
      .set(updates)
      .where(eq(workflowRuns.id, runId))
      .returning();

    if (!row) {
      throw new Error(`Run ${runId} not found`);
    }
    return rowToRecord(row);
  },

  async replaceSteps(runId: string, steps: StepMetadata[]): Promise<StepMetadata[]> {
    const db = getDb();

    // Verify run exists
    const existing = await db
      .select({ id: workflowRuns.id })
      .from(workflowRuns)
      .where(eq(workflowRuns.id, runId))
      .limit(1);
    if (existing.length === 0) {
      throw new Error(`Run ${runId} not found`);
    }

    // Delete existing steps for this run
    await db.delete(workflowSteps).where(eq(workflowSteps.runId, runId));

    if (steps.length === 0) return [];

    // Insert new steps
    const rows = await db
      .insert(workflowSteps)
      .values(
        steps.map((step) => ({
          id: crypto.randomUUID(),
          runId,
          stepName: step.stepName,
          agent: step.agent,
          preset: step.preset,
          cli: step.cli,
          sandboxId: step.sandboxId,
          startTime: step.startTime,
          endTime: step.endTime,
          durationMs: step.durationMs,
          exitCode: step.exitCode,
          outputSummary: step.outputSummary,
          error: step.error ?? null,
        })),
      )
      .returning();

    return rows.map(stepRowToMetadata);
  },

  async listSteps(runId: string): Promise<StepMetadata[]> {
    const db = getDb();
    const rows = await db
      .select()
      .from(workflowSteps)
      .where(eq(workflowSteps.runId, runId));

    return rows
      .map(stepRowToMetadata)
      .sort((a, b) => {
        const aTime = a.startTime ? new Date(a.startTime).getTime() : 0;
        const bTime = b.startTime ? new Date(b.startTime).getTime() : 0;
        return aTime - bTime;
      });
  },

  async listByUser(userId: string): Promise<WorkflowRecord[]> {
    const db = getDb();
    const rows = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.userId, userId))
      .orderBy(desc(workflowRuns.createdAt));

    return rows.map((row) => {
      const record = rowToRecord(row);
      // Strip callbackToken from listing
      const safe = { ...record };
      delete (safe as { callbackToken?: string }).callbackToken;
      return safe as WorkflowRecord;
    });
  },

  async listByWorkspaceIds(workspaceIds: string[]): Promise<WorkflowRecord[]> {
    if (workspaceIds.length === 0) {
      return [];
    }

    const db = getDb();
    const rows = await db
      .select()
      .from(workflowRuns)
      .where(inArray(workflowRuns.workspaceId, workspaceIds))
      .orderBy(desc(workflowRuns.createdAt));

    return rows.map((row) => {
      const record = rowToRecord(row);
      const safe = { ...record };
      delete (safe as { callbackToken?: string }).callbackToken;
      return safe as WorkflowRecord;
    });
  },
};

export { mintS3Credentials, launchOrchestratorSandbox, getCliCredentials, resolveCredentialProvider, workflowNeedsCliCredentials, getAllProviders, listConnectedProviders };
