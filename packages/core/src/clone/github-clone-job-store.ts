import {
  and,
  desc,
  eq,
  gte,
  inArray,
  sql,
} from "drizzle-orm";

import { getDb } from "../db.js";
import { githubCloneJobs } from "../db/schema.js";
import type {
  GithubCloneCompletion,
  GithubCloneJobRequest,
  GithubCloneJobRow,
} from "./github-clone-job.js";
import { GITHUB_CLONE_JOB_DEDUPE_TTL_MS } from "./github-clone-job.js";

export type { GithubCloneJobRow as GithubCloneJob } from "./github-clone-job.js";
type GithubCloneJob = GithubCloneJobRow;

type GithubCloneDb = {
  insert: (...args: unknown[]) => {
    values: (values: unknown) => {
      returning: () => Promise<GithubCloneJobRow[]>;
    };
  };
  select: (...args: unknown[]) => {
    from: (table: unknown) => {
      where: (condition: unknown) => {
        orderBy: (...values: unknown[]) => {
          limit: (count: number) => Promise<GithubCloneJobRow[]>;
        };
        limit: (count: number) => Promise<GithubCloneJobRow[]>;
      };
      limit: (count: number) => Promise<GithubCloneJobRow[]>;
    };
  };
  update: (table: unknown) => {
    set: (values: unknown) => {
      where: (condition: unknown) => Promise<unknown>;
    };
  };
};

type DedupeLookup = Pick<
  GithubCloneJobRequest,
  "workspaceId" | "owner" | "repo" | "ref"
>;

function resolveDb(db?: unknown): GithubCloneDb {
  return (db ?? getDb()) as GithubCloneDb;
}

function isDbLike(value: unknown): value is GithubCloneDb {
  return Boolean(
    value &&
      typeof value === "object" &&
      "select" in value &&
      "insert" in value &&
      "update" in value,
  );
}

export async function createGithubCloneJob(
  request: GithubCloneJobRequest,
): Promise<GithubCloneJobRow>;
export async function createGithubCloneJob(
  db: unknown,
  request: GithubCloneJobRequest,
): Promise<GithubCloneJobRow>;
export async function createGithubCloneJob(
  dbOrRequest: unknown,
  maybeRequest?: GithubCloneJobRequest,
): Promise<GithubCloneJobRow> {
  const db = resolveDb(maybeRequest ? dbOrRequest : undefined);
  const request = (maybeRequest ?? dbOrRequest) as GithubCloneJobRequest;

  const [job] = await db
    .insert(githubCloneJobs)
    .values({
      workspaceId: request.workspaceId,
      owner: request.owner,
      repo: request.repo,
      ref: request.ref,
      connectionId: request.connectionId,
      // mode defaults to 'full' at the DB level too, but we set it
      // explicitly so the row reflects the caller's intent.
      mode: request.mode ?? "full",
      baseSha: request.mode === "incremental" ? request.baseSha ?? null : null,
      status: "queued",
      attempts: 0,
      filesWritten: null,
      headSha: null,
      durationMs: null,
      materializationJson: null,
      lastError: null,
      startedAt: null,
      completedAt: null,
    })
    .returning();

  if (!job) {
    throw new Error("Failed to create github clone job");
  }

  return job;
}

export async function findActiveGithubCloneJob(
  key: DedupeLookup,
): Promise<GithubCloneJobRow | null>;
export async function findActiveGithubCloneJob(
  db: unknown,
  key: DedupeLookup,
): Promise<GithubCloneJobRow | null>;
export async function findActiveGithubCloneJob(
  dbOrKey: unknown,
  maybeKey?: DedupeLookup,
): Promise<GithubCloneJobRow | null> {
  const db = resolveDb(maybeKey ? dbOrKey : undefined);
  const key = (maybeKey ?? dbOrKey) as DedupeLookup;
  const cutoff = new Date(Date.now() - GITHUB_CLONE_JOB_DEDUPE_TTL_MS);

  const [job] = await db
    .select()
    .from(githubCloneJobs)
    .where(
      and(
        eq(githubCloneJobs.workspaceId, key.workspaceId),
        eq(githubCloneJobs.owner, key.owner),
        eq(githubCloneJobs.repo, key.repo),
        eq(githubCloneJobs.ref, key.ref),
        inArray(githubCloneJobs.status, ["queued", "running"]),
        gte(githubCloneJobs.createdAt, cutoff),
      ),
    )
    .orderBy(desc(githubCloneJobs.createdAt))
    .limit(1);

  return job ?? null;
}

export async function getGithubCloneJob(jobId: string): Promise<GithubCloneJobRow | null>;
export async function getGithubCloneJob(
  db: unknown,
  jobId: string,
): Promise<GithubCloneJobRow | null>;
export async function getGithubCloneJob(
  dbOrJobId: unknown,
  maybeJobId?: string,
): Promise<GithubCloneJobRow | null> {
  const db = resolveDb(maybeJobId ? dbOrJobId : undefined);
  const jobId = (maybeJobId ?? dbOrJobId) as string;
  const [job] = await db
    .select()
    .from(githubCloneJobs)
    .where(eq(githubCloneJobs.id, jobId))
    .limit(1);

  return job ?? null;
}

export async function getLatestGithubCloneJobForRepo(
  workspaceId: string,
  owner: string,
  repo: string,
): Promise<GithubCloneJob | null>;
export async function getLatestGithubCloneJobForRepo(
  db: unknown,
  workspaceId: string,
  owner: string,
  repo: string,
): Promise<GithubCloneJob | null>;
export async function getLatestGithubCloneJobForRepo(
  dbOrWorkspaceId: unknown,
  workspaceIdOrOwner: string,
  ownerOrRepo: string,
  maybeRepo?: string,
): Promise<GithubCloneJob | null> {
  const hasExplicitDb = maybeRepo !== undefined;
  const db = resolveDb(hasExplicitDb ? dbOrWorkspaceId : undefined);
  const workspaceId = hasExplicitDb
    ? workspaceIdOrOwner
    : (dbOrWorkspaceId as string);
  const owner = hasExplicitDb ? ownerOrRepo : workspaceIdOrOwner;
  const repo = hasExplicitDb ? (maybeRepo as string) : ownerOrRepo;

  return await db
    .select()
    .from(githubCloneJobs)
    .where(
      and(
        eq(githubCloneJobs.workspaceId, workspaceId),
        eq(githubCloneJobs.owner, owner),
        eq(githubCloneJobs.repo, repo),
      ),
    )
    .orderBy(desc(githubCloneJobs.createdAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

export async function markGithubCloneJobRunning(
  db: unknown,
  jobId: string,
): Promise<void> {
  const resolvedDb = resolveDb(db);
  const now = new Date();

  await resolvedDb
    .update(githubCloneJobs)
    .set({
      status: "running",
      attempts: sql`${githubCloneJobs.attempts} + 1`,
      startedAt: now,
      updatedAt: now,
    })
    .where(eq(githubCloneJobs.id, jobId));
}

export async function markGithubCloneJobCompleted(
  db: unknown,
  jobId: string,
  result: GithubCloneCompletion,
): Promise<void> {
  const resolvedDb = resolveDb(db);
  const completedAt = result.completedAt ?? new Date();

  await resolvedDb
    .update(githubCloneJobs)
    .set({
      status: "completed",
      filesWritten: result.filesWritten ?? null,
      headSha: result.headSha ?? null,
      durationMs: result.durationMs ?? null,
      materializationJson: result.materialization ?? null,
      lastError: null,
      completedAt,
      updatedAt: completedAt,
    })
    .where(eq(githubCloneJobs.id, jobId));
}

export async function markGithubCloneJobRetrying(
  db: unknown,
  jobId: string,
  error: string,
): Promise<void> {
  const resolvedDb = resolveDb(db);
  const now = new Date();

  await resolvedDb
    .update(githubCloneJobs)
    .set({
      status: "running",
      lastError: error,
      completedAt: null,
      updatedAt: now,
    })
    .where(eq(githubCloneJobs.id, jobId));
}

export async function markGithubCloneJobFailed(
  jobId: string,
  error: string,
): Promise<void>;
export async function markGithubCloneJobFailed(
  db: unknown,
  jobId: string,
  error: string,
): Promise<void>;
export async function markGithubCloneJobFailed(
  dbOrJobId: unknown,
  jobIdOrError: string,
  maybeError?: string,
): Promise<void> {
  const hasExplicitDb = maybeError !== undefined || isDbLike(dbOrJobId);
  const resolvedDb = resolveDb(hasExplicitDb ? dbOrJobId : undefined);
  const jobId = hasExplicitDb ? jobIdOrError : (dbOrJobId as string);
  const error = hasExplicitDb ? (maybeError as string) : jobIdOrError;
  const completedAt = new Date();

  await resolvedDb
    .update(githubCloneJobs)
    .set({
      status: "failed",
      lastError: error,
      completedAt,
      updatedAt: completedAt,
    })
    .where(eq(githubCloneJobs.id, jobId));
}
