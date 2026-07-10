import type { CloneOutcome, CloneRequest } from "./github-clone-orchestrator";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CloneJob {
  id: string;
  key: string;
  status: "queued" | "running" | "completed" | "partial_failure" | "failed";
  workspaceId: string;
  owner: string;
  repo: string;
  ref: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  result?: CloneOutcome;
  error?: string;
}

export interface CloneQueueConfig {
  maxConcurrent?: number; // default 3
  maxPerWorkspace?: number; // default 1
  jobTtlMs?: number; // default 600_000 (10 min)
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const DEFAULT_MAX_CONCURRENT = 3;
const DEFAULT_MAX_PER_WORKSPACE = 1;
const DEFAULT_JOB_TTL_MS = 600_000;

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return fallback;
  }

  return Math.floor(value);
}

function normalizeNonNegativeInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return fallback;
  }

  return Math.floor(value);
}

function buildCloneKey(request: CloneRequest): string {
  const ref = request.ref?.trim() || "HEAD";
  return `${request.workspaceId}:${request.owner}/${request.repo}@${ref}`;
}

function isTerminal(job: CloneJob): boolean {
  return job.status === "completed" || job.status === "partial_failure" || job.status === "failed";
}

function isExpired(job: CloneJob, ttlMs: number, now: number): boolean {
  if (!isTerminal(job)) {
    return false;
  }

  return now - (job.completedAt ?? job.createdAt) >= ttlMs;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error.trim();
  }

  return "Clone failed with an unknown error.";
}

function copyOutcome(outcome: CloneOutcome): CloneOutcome {
  return {
    ...outcome,
    skipped: outcome.skipped.map((entry) => ({ ...entry })),
    errors: outcome.errors.map((entry) => ({ ...entry })),
  };
}

function copyJob(job: CloneJob): CloneJob {
  const copy: CloneJob = { ...job };

  if (job.result) {
    copy.result = copyOutcome(job.result);
  }

  return copy;
}

// ---------------------------------------------------------------------------
// CloneQueue
// ---------------------------------------------------------------------------

export class CloneQueue {
  private readonly maxConcurrent: number;
  private readonly maxPerWorkspace: number;
  private readonly jobTtlMs: number;

  /** All tracked jobs, keyed by job ID. */
  private readonly jobs = new Map<string, CloneJob>();

  /** Maps a clone key to the active (queued | running) job ID for dedup. */
  private readonly activeByKey = new Map<string, string>();

  /** FIFO queue of job IDs waiting for a slot. */
  private readonly pending: string[] = [];

  /** Registered execute functions, keyed by job ID. */
  private readonly executors = new Map<string, () => Promise<CloneOutcome>>();

  private running = 0;

  constructor(config?: CloneQueueConfig) {
    this.maxConcurrent = normalizePositiveInteger(
      config?.maxConcurrent,
      DEFAULT_MAX_CONCURRENT,
    );
    this.maxPerWorkspace = normalizePositiveInteger(
      config?.maxPerWorkspace,
      DEFAULT_MAX_PER_WORKSPACE,
    );
    this.jobTtlMs = normalizeNonNegativeInteger(config?.jobTtlMs, DEFAULT_JOB_TTL_MS);
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Enqueue a clone request. Returns immediately with a job.
   * If an identical request is already queued or running, returns that job.
   */
  enqueue(request: CloneRequest, executeFn: () => Promise<CloneOutcome>): CloneJob {
    this.purgeExpired();

    const key = buildCloneKey(request);

    // Dedup: return existing in-flight job for the same key.
    const existingId = this.activeByKey.get(key);
    if (existingId) {
      const existing = this.jobs.get(existingId);
      if (existing && (existing.status === "queued" || existing.status === "running")) {
        return copyJob(existing);
      }
      // Stale entry — clean up and fall through.
      this.activeByKey.delete(key);
    }

    const ref = request.ref?.trim() || "HEAD";
    const job: CloneJob = {
      id: crypto.randomUUID(),
      key,
      status: "queued",
      workspaceId: request.workspaceId,
      owner: request.owner,
      repo: request.repo,
      ref,
      createdAt: Date.now(),
    };

    this.jobs.set(job.id, job);
    this.activeByKey.set(key, job.id);
    this.executors.set(job.id, executeFn);
    this.pending.push(job.id);

    // Kick the scheduler (non-blocking).
    this.drain();

    return copyJob(job);
  }

  /** Get job status by ID. */
  getJob(jobId: string): CloneJob | undefined {
    this.purgeExpired();
    const job = this.jobs.get(jobId);
    return job ? copyJob(job) : undefined;
  }

  /** Get all jobs for a workspace (active + recent). */
  getWorkspaceJobs(workspaceId: string): CloneJob[] {
    this.purgeExpired();
    const result: CloneJob[] = [];
    for (const job of this.jobs.values()) {
      if (job.workspaceId === workspaceId) {
        result.push(copyJob(job));
      }
    }
    return result;
  }

  /** Number of currently running clones. */
  get activeCount(): number {
    this.purgeExpired();
    return this.running;
  }

  /** Number of queued (waiting) clones. */
  get queuedCount(): number {
    this.purgeExpired();
    return this.pending.length;
  }

  // -----------------------------------------------------------------------
  // Internal scheduling
  // -----------------------------------------------------------------------

  /** Count running jobs for a given workspace. */
  private workspaceRunningCount(workspaceId: string): number {
    let count = 0;
    for (const job of this.jobs.values()) {
      if (job.workspaceId === workspaceId && job.status === "running") {
        count += 1;
      }
    }
    return count;
  }

  /**
   * Try to promote queued jobs into running slots, respecting global and
   * per-workspace limits.
   */
  private drain(): void {
    while (this.running < this.maxConcurrent && this.pending.length > 0) {
      const picked = this.pickNext();
      if (!picked) {
        // All pending jobs are blocked by per-workspace limits.
        break;
      }

      this.startJob(picked);
    }
  }

  /**
   * Pick the next eligible job from the pending queue. Returns the job ID
   * and removes it from the queue, or returns undefined if no job can run.
   */
  private pickNext(): string | undefined {
    for (let i = 0; i < this.pending.length; i++) {
      const jobId = this.pending[i];
      const job = this.jobs.get(jobId);

      // Job was removed or expired — drop from queue.
      if (!job || job.status !== "queued") {
        this.pending.splice(i, 1);
        i -= 1;
        continue;
      }

      if (this.workspaceRunningCount(job.workspaceId) < this.maxPerWorkspace) {
        this.pending.splice(i, 1);
        return jobId;
      }
    }

    return undefined;
  }

  /** Transition a job to running and kick off its executor. */
  private startJob(jobId: string): void {
    const job = this.jobs.get(jobId);
    const executeFn = this.executors.get(jobId);
    if (!job || !executeFn) {
      return;
    }

    job.status = "running";
    job.startedAt = Date.now();
    this.running += 1;
    this.executors.delete(jobId);

    void Promise.resolve().then(executeFn).then(
      (result) => {
        job.status = result.errors.length > 0 ? "partial_failure" : "completed";
        job.completedAt = Date.now();
        job.result = result;
        this.finishJob(job);
      },
      (err: unknown) => {
        job.status = "failed";
        job.completedAt = Date.now();
        job.error = getErrorMessage(err);
        this.finishJob(job);
      },
    );
  }

  /** Common post-completion bookkeeping. */
  private finishJob(job: CloneJob): void {
    this.running = Math.max(0, this.running - 1);

    // Clear the active-by-key entry so future requests for the same key
    // create a fresh job instead of returning the completed/failed one.
    if (this.activeByKey.get(job.key) === job.id) {
      this.activeByKey.delete(job.key);
    }

    // Try to start the next queued job.
    this.drain();
  }

  // -----------------------------------------------------------------------
  // Expiry
  // -----------------------------------------------------------------------

  /** Lazily remove expired jobs on access. */
  private purgeExpired(): void {
    const now = Date.now();
    const toDelete: string[] = [];

    for (const [id, job] of this.jobs) {
      if (isExpired(job, this.jobTtlMs, now)) {
        toDelete.push(id);
      }
    }

    for (const id of toDelete) {
      const job = this.jobs.get(id);
      if (job) {
        if (this.activeByKey.get(job.key) === id) {
          this.activeByKey.delete(job.key);
        }
        this.executors.delete(id);
      }
      this.jobs.delete(id);
    }

    // Also clean stale entries from the pending queue.
    for (let i = this.pending.length - 1; i >= 0; i--) {
      if (!this.jobs.has(this.pending[i])) {
        this.pending.splice(i, 1);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const cloneQueue = new CloneQueue();
