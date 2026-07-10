import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";

type QueryClient = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
};

type WorkflowRunStatusRow = {
  id?: string;
  status: string;
  error: string | null;
};

type ApiTokenSessionRow = {
  id: string;
  revoked_at: string | null;
  revoked_reason: string | null;
};

type WorkflowLaunchJobStatus = "queued" | "launching" | "launched" | "failed";

type ReapStuckRuns = (
  client: QueryClient,
  options?: {
    now?: Date;
    timeoutMinutes?: number;
  },
) => Promise<unknown>;

async function loadReaper(): Promise<{ reapStuckRuns: ReapStuckRuns }> {
  const mod = (await import("../../packages/core/src/sync/stuck-run-reaper.js")) as {
    reapStuckRuns?: ReapStuckRuns;
  };
  const reapStuckRuns = mod.reapStuckRuns;

  if (typeof reapStuckRuns !== "function") {
    assert.fail("stuck-run reaper module must export reapStuckRuns(client, options)");
  }

  return { reapStuckRuns };
}

const fixedNow = new Date("2026-04-23T12:00:00.000Z");
const staleCreatedAt = new Date(fixedNow.getTime() - 6 * 60 * 1000).toISOString();
const recentCreatedAt = new Date(fixedNow.getTime() - 2 * 60 * 1000).toISOString();
const expiredLeaseUntil = new Date(fixedNow.getTime() - 60 * 1000).toISOString();
const activeLeaseUntil = new Date(fixedNow.getTime() + 60 * 1000).toISOString();

describe("stuck-run reaper", () => {
  let db: PGlite;

  beforeEach(async () => {
    db = new PGlite();

    await db.exec(`
      CREATE TABLE workflow_runs (
        id UUID PRIMARY KEY,
        sandbox_id TEXT,
        dispatch_type TEXT NOT NULL DEFAULT 'sandbox',
        user_id UUID NOT NULL,
        workspace_id UUID NOT NULL,
        relay_workspace_id TEXT,
        workflow TEXT NOT NULL,
        file_type TEXT NOT NULL,
        callback_token TEXT NOT NULL,
        status TEXT NOT NULL,
        relayauth_identity_id TEXT,
        result TEXT,
        error TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX idx_workflow_runs_user ON workflow_runs (user_id);
      CREATE INDEX idx_workflow_runs_workspace ON workflow_runs (workspace_id);
      CREATE INDEX idx_workflow_runs_status ON workflow_runs (status);

      CREATE TABLE workflow_launch_jobs (
        id UUID PRIMARY KEY,
        run_id UUID NOT NULL,
        user_id UUID NOT NULL,
        workspace_id UUID NOT NULL,
        organization_id UUID NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        attempts INTEGER NOT NULL DEFAULT 0,
        lease_until TIMESTAMPTZ,
        sandbox_id TEXT,
        relay_workspace_id TEXT,
        request_envelope JSONB NOT NULL,
        last_error TEXT,
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );
      CREATE UNIQUE INDEX workflow_launch_jobs_run_unique ON workflow_launch_jobs (run_id);
      CREATE INDEX idx_workflow_launch_jobs_status_lease ON workflow_launch_jobs (status, lease_until);
      CREATE INDEX idx_workflow_launch_jobs_workspace ON workflow_launch_jobs (workspace_id);

      CREATE TABLE api_token_sessions (
        id UUID PRIMARY KEY,
        token_family_id UUID NOT NULL,
        subject_type TEXT NOT NULL,
        user_id UUID NOT NULL,
        workspace_id UUID NOT NULL,
        organization_id UUID NOT NULL,
        sandbox_id TEXT,
        run_id UUID,
        scopes TEXT NOT NULL,
        access_token_hash TEXT NOT NULL UNIQUE,
        access_token_expires_at TIMESTAMPTZ NOT NULL,
        refresh_token_hash TEXT NOT NULL UNIQUE,
        refresh_token_expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        last_used_at TIMESTAMPTZ,
        last_refreshed_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ,
        revoked_reason TEXT
      );
      CREATE INDEX idx_api_token_sessions_family ON api_token_sessions (token_family_id);
      CREATE INDEX idx_api_token_sessions_user ON api_token_sessions (user_id);
      CREATE INDEX idx_api_token_sessions_run ON api_token_sessions (run_id);
      CREATE INDEX idx_api_token_sessions_sandbox ON api_token_sessions (sandbox_id);
    `);
  });

  afterEach(async () => {
    await db.close();
  });

  it("marks pending workflow runs older than five minutes as failed with bootstrap_timeout", async () => {
    const { reapStuckRuns } = await loadReaper();
    const staleRunId = randomUUID();

    await insertWorkflowRun(staleRunId, "pending", staleCreatedAt);

    await reapStuckRuns(db, { now: fixedNow, timeoutMinutes: 5 });

    const result = await db.query<WorkflowRunStatusRow>(
      "SELECT status, error FROM workflow_runs WHERE id = $1",
      [staleRunId],
    );

    assert.equal(result.rows[0].status, "failed");
    assert.equal(result.rows[0].error, "bootstrap_timeout");
  });

  for (const [label, status, leaseUntil] of [
    ["queued", "queued", null],
    ["launching with an active lease", "launching", activeLeaseUntil],
    ["launching with an expired lease", "launching", expiredLeaseUntil],
    ["launched", "launched", null],
  ] as const) {
    it(`does not reap stale pending workflow runs with a launch job that is ${label}`, async () => {
      const { reapStuckRuns } = await loadReaper();
      const runId = randomUUID();

      await insertWorkflowRun(runId, "pending", staleCreatedAt);
      await insertWorkflowLaunchJob(runId, status, { leaseUntil });

      await reapStuckRuns(db, { now: fixedNow, timeoutMinutes: 5 });

      const result = await db.query<WorkflowRunStatusRow>(
        "SELECT status, error FROM workflow_runs WHERE id = $1",
        [runId],
      );

      assert.equal(result.rows[0].status, "pending");
      assert.equal(result.rows[0].error, null);
    });
  }

  it("reaps stale pending workflow runs when the launch job is failed", async () => {
    const { reapStuckRuns } = await loadReaper();
    const runId = randomUUID();
    const sessionId = randomUUID();

    await insertWorkflowRun(runId, "pending", staleCreatedAt);
    await insertWorkflowLaunchJob(runId, "failed", {
      lastError: "daytona create failed",
    });
    await insertApiTokenSession(sessionId, runId, "failed-launch");

    await reapStuckRuns(db, { now: fixedNow, timeoutMinutes: 5 });

    const run = await db.query<WorkflowRunStatusRow>(
      "SELECT status, error FROM workflow_runs WHERE id = $1",
      [runId],
    );
    const session = await db.query<ApiTokenSessionRow>(
      "SELECT id, revoked_at, revoked_reason FROM api_token_sessions WHERE id = $1",
      [sessionId],
    );

    assert.equal(run.rows[0].status, "failed");
    assert.equal(run.rows[0].error, "daytona create failed");
    assert.ok(session.rows[0].revoked_at, "failed launch session should be revoked");
    assert.equal(session.rows[0].revoked_reason, "daytona create failed");
  });

  it("uses a launch-specific fallback when the failed launch job has no error", async () => {
    const { reapStuckRuns } = await loadReaper();
    const runId = randomUUID();

    await insertWorkflowRun(runId, "pending", staleCreatedAt);
    await insertWorkflowLaunchJob(runId, "failed");

    await reapStuckRuns(db, { now: fixedNow, timeoutMinutes: 5 });

    const result = await db.query<WorkflowRunStatusRow>(
      "SELECT status, error FROM workflow_runs WHERE id = $1",
      [runId],
    );

    assert.equal(result.rows[0].status, "failed");
    assert.equal(result.rows[0].error, "workflow_launch_failed");
  });

  it("does not affect pending workflow runs newer than five minutes", async () => {
    const { reapStuckRuns } = await loadReaper();
    const recentRunId = randomUUID();

    await insertWorkflowRun(recentRunId, "pending", recentCreatedAt);

    await reapStuckRuns(db, { now: fixedNow, timeoutMinutes: 5 });

    const result = await db.query<WorkflowRunStatusRow>(
      "SELECT status, error FROM workflow_runs WHERE id = $1",
      [recentRunId],
    );

    assert.equal(result.rows[0].status, "pending");
    assert.equal(result.rows[0].error, null);
  });

  it("does not rewrite workflow runs that are already terminal", async () => {
    const { reapStuckRuns } = await loadReaper();
    const completedRunId = randomUUID();
    const failedRunId = randomUUID();

    await insertWorkflowRun(completedRunId, "completed", staleCreatedAt);
    await insertWorkflowRun(failedRunId, "failed", staleCreatedAt, "original_failure");

    await reapStuckRuns(db, { now: fixedNow, timeoutMinutes: 5 });

    const result = await db.query<WorkflowRunStatusRow>(
      "SELECT id, status, error FROM workflow_runs WHERE id IN ($1, $2) ORDER BY id",
      [completedRunId, failedRunId],
    );

    const byId = new Map(result.rows.map((row) => [row.id, row] as const));
    assert.equal(byId.get(completedRunId)?.status, "completed");
    assert.equal(byId.get(completedRunId)?.error, null);
    assert.equal(byId.get(failedRunId)?.status, "failed");
    assert.equal(byId.get(failedRunId)?.error, "original_failure");
  });

  it("revokes active API token sessions for reaped workflow runs only", async () => {
    const { reapStuckRuns } = await loadReaper();
    const staleRunId = randomUUID();
    const recentRunId = randomUUID();
    const staleSessionId = randomUUID();
    const recentSessionId = randomUUID();
    const alreadyRevokedSessionId = randomUUID();

    await insertWorkflowRun(staleRunId, "pending", staleCreatedAt);
    await insertWorkflowRun(recentRunId, "pending", recentCreatedAt);
    await insertApiTokenSession(staleSessionId, staleRunId, "active-stale");
    await insertApiTokenSession(recentSessionId, recentRunId, "active-recent");
    await insertApiTokenSession(
      alreadyRevokedSessionId,
      staleRunId,
      "already-revoked",
      "manual_revocation",
    );

    await reapStuckRuns(db, { now: fixedNow, timeoutMinutes: 5 });

    const result = await db.query<ApiTokenSessionRow>(
      "SELECT id, revoked_at, revoked_reason FROM api_token_sessions ORDER BY access_token_hash",
    );

    const byId = new Map(result.rows.map((row) => [row.id, row] as const));
    assert.ok(byId.get(staleSessionId)?.revoked_at, "stale run session should be revoked");
    assert.equal(byId.get(staleSessionId)?.revoked_reason, "bootstrap_timeout");
    assert.equal(byId.get(recentSessionId)?.revoked_at, null);
    assert.equal(byId.get(recentSessionId)?.revoked_reason, null);
    assert.equal(
      byId.get(alreadyRevokedSessionId)?.revoked_reason,
      "manual_revocation",
      "existing revocation reasons must not be overwritten",
    );
  });

  async function insertWorkflowRun(
    runId: string,
    status: string,
    createdAt: string,
    error: string | null = null,
  ): Promise<void> {
    await db.query(
      `
        INSERT INTO workflow_runs (
          id,
          sandbox_id,
          dispatch_type,
          user_id,
          workspace_id,
          workflow,
          file_type,
          callback_token,
          status,
          error,
          created_at,
          updated_at
        )
        VALUES ($1, $2, 'sandbox', $3, $4, $5, 'yaml', $6, $7, $8, $9, $9)
      `,
      [
        runId,
        `sandbox-${runId}`,
        randomUUID(),
        randomUUID(),
        "version: '1.0'",
        `callback-${runId}`,
        status,
        error,
        createdAt,
      ],
    );
  }

  async function insertApiTokenSession(
    sessionId: string,
    runId: string,
    tokenHashSuffix: string,
    revokedReason: string | null = null,
  ): Promise<void> {
    const timestamp = staleCreatedAt;
    await db.query(
      `
        INSERT INTO api_token_sessions (
          id,
          token_family_id,
          subject_type,
          user_id,
          workspace_id,
          organization_id,
          sandbox_id,
          run_id,
          scopes,
          access_token_hash,
          access_token_expires_at,
          refresh_token_hash,
          refresh_token_expires_at,
          created_at,
          updated_at,
          revoked_at,
          revoked_reason
        )
        VALUES (
          $1,
          $2,
          'workflow',
          $3,
          $4,
          $5,
          $6,
          $7,
          '["workflow:run"]',
          $8,
          $9,
          $10,
          $9,
          $11,
          $11,
          CASE WHEN $12::TEXT IS NULL THEN NULL ELSE $11::TIMESTAMPTZ END,
          $12
        )
      `,
      [
        sessionId,
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
        `sandbox-${runId}`,
        runId,
        `access-${tokenHashSuffix}`,
        new Date(fixedNow.getTime() + 60 * 60 * 1000).toISOString(),
        `refresh-${tokenHashSuffix}`,
        timestamp,
        revokedReason,
      ],
    );
  }

  async function insertWorkflowLaunchJob(
    runId: string,
    status: WorkflowLaunchJobStatus,
    options: {
      leaseUntil?: string | null;
      lastError?: string | null;
    } = {},
  ): Promise<void> {
    await db.query(
      `
        INSERT INTO workflow_launch_jobs (
          id,
          run_id,
          user_id,
          workspace_id,
          organization_id,
          status,
          attempts,
          lease_until,
          request_envelope,
          last_error,
          created_at,
          updated_at
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          1,
          $7,
          $8::JSONB,
          $9,
          $10,
          $10
        )
      `,
      [
        randomUUID(),
        runId,
        randomUUID(),
        randomUUID(),
        randomUUID(),
        status,
        options.leaseUntil ?? null,
        JSON.stringify({
          ciphertext: "ciphertext",
          iv: "iv",
          tag: "tag",
          version: 1,
        }),
        options.lastError ?? null,
        staleCreatedAt,
      ],
    );
  }
});
