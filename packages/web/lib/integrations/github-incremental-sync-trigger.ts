import "server-only";

import { createGithubCloneJob, findActiveGithubCloneJob } from "@cloud/core/clone/github-clone-job-store.js";
import type { GithubCloneJobRequest } from "@cloud/core/clone/github-clone-job.js";
import type { RelayFileClient } from "@relayfile/sdk";

import { auditGithubCloneEnqueued, auditGithubCloneFailed } from "@/lib/integrations/github-clone-audit";
import { enqueueGithubCloneJob } from "@/lib/integrations/github-clone-durable-queue";
import { logger } from "@/lib/logger";

// Read the per-repo manifest written by the full-clone executor (or the
// previous incremental sync) to recover the prior head sha. We try the new
// `.relayfile/clone.json` sentinel first (preferred path) and fall back to
// the legacy `meta.json` for one release cycle (sage spec §5a).
//
// Returns null when no manifest exists at all — that means the repo was
// never cloned, so the incremental path must NOT preempt the public
// full-clone trigger. Callers should silently no-op in that case.

interface ReadManifestResult {
  headSha: string;
  defaultBranch: string | null;
  source: "sentinel" | "meta";
}

const SENTINEL_PATH_PREFIX = "/github/repos";

function repoRoot(owner: string, repo: string): string {
  return `${SENTINEL_PATH_PREFIX}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const status = (error as { status?: unknown }).status;
  return status === 404;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseManifest(content: string): ReadManifestResult | null {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    const headSha = readString(record.headSha);
    if (!headSha) return null;
    return {
      headSha,
      defaultBranch: readString(record.defaultBranch),
      source: "sentinel",
    };
  } catch {
    return null;
  }
}

export async function readPriorCloneManifest(
  relayfile: RelayFileClient,
  workspaceId: string,
  owner: string,
  repo: string,
): Promise<ReadManifestResult | null> {
  const sentinelPath = `${repoRoot(owner, repo)}/.relayfile/clone.json`;
  const metaPath = `${repoRoot(owner, repo)}/meta.json`;

  try {
    const file = await relayfile.readFile(workspaceId, sentinelPath);
    const parsed = parseManifest(file.content);
    if (parsed) return parsed;
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  try {
    const file = await relayfile.readFile(workspaceId, metaPath);
    const parsed = parseManifest(file.content);
    if (parsed) return { ...parsed, source: "meta" };
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  return null;
}

export interface EnqueueIncrementalSyncInput {
  workspaceId: string;
  owner: string;
  repo: string;
  ref: string;
  connectionId: string;
  baseSha: string;
  // For audit/log correlation — the inbound webhook delivery ID, when known.
  deliveryId?: string | null;
}

export async function enqueueIncrementalCloneJob(
  input: EnqueueIncrementalSyncInput,
): Promise<{ ok: true; jobId: string } | { ok: true; deduped: true; jobId: string } | { ok: false; error: string }> {
  const cloneRequest: GithubCloneJobRequest = {
    workspaceId: input.workspaceId,
    owner: input.owner,
    repo: input.repo,
    ref: input.ref,
    connectionId: input.connectionId,
    mode: "incremental",
    baseSha: input.baseSha,
  };

  // Reuse the existing dedupe key (workspaceId, owner, repo, ref) so a burst
  // of pushes on the same branch doesn't fan out into N concurrent syncs.
  const existing = await findActiveGithubCloneJob({
    workspaceId: input.workspaceId,
    owner: input.owner,
    repo: input.repo,
    ref: input.ref,
  });
  if (existing) {
    await logger.info("incremental_sync_deduped", {
      area: "incremental-sync",
      workspaceId: input.workspaceId,
      owner: input.owner,
      repo: input.repo,
      jobId: existing.id,
      deliveryId: input.deliveryId ?? undefined,
    });
    return { ok: true, deduped: true, jobId: existing.id };
  }

  let job: Awaited<ReturnType<typeof createGithubCloneJob>>;
  try {
    job = await createGithubCloneJob(cloneRequest);
  } catch (error) {
    const message =
      error instanceof Error && error.message
        ? error.message
        : "Failed to create incremental clone job";
    await logger.error("incremental_sync_create_failed", {
      area: "incremental-sync",
      workspaceId: input.workspaceId,
      owner: input.owner,
      repo: input.repo,
      error: message,
    });
    return { ok: false, error: message };
  }

  try {
    await enqueueGithubCloneJob({
      jobId: job.id,
      request: cloneRequest,
    });
  } catch (error) {
    const message =
      error instanceof Error && error.message
        ? error.message
        : "Failed to enqueue incremental clone job";

    auditGithubCloneFailed(
      {
        id: job.id,
        status: "failed",
        completedAt: new Date(),
        lastError: message,
      },
      message,
      cloneRequest,
    );

    return { ok: false, error: message };
  }

  auditGithubCloneEnqueued(job, cloneRequest);
  await logger.info("incremental_sync_enqueued", {
    area: "incremental-sync",
    workspaceId: input.workspaceId,
    owner: input.owner,
    repo: input.repo,
    jobId: job.id,
    baseSha: input.baseSha,
    deliveryId: input.deliveryId ?? undefined,
  });
  return { ok: true, jobId: job.id };
}
