# Spec: Move GitHub clone execution off the Next.js Lambda hot path onto a durable SST queue

**Status**: draft for review
**Owner**: TBD
**Repo**: `cloud/`
**Issue link**: TBD

## Problem

Sage's fire-and-forget clone requests return `202 queued` from
`/cloud/api/v1/github/clone/request` but the clone work itself never
completes. Concrete evidence:

- User asks sage `@Sage what's in <repo>?` for an unindexed repo. Sage
  fires the clone POST. No clone happens in relayfile. Subsequent
  queries still return empty listings.
- Cause: the cloud handler enqueues into `cloneQueue`, an
  **in-process `CloneQueue` singleton**
  (`packages/web/lib/integrations/github-clone-queue.ts:350`) which
  fires `void Promise.resolve().then(executeFn)` (line 269-295) with no
  `waitUntil` / `after()` / external durability.
- Cloud web is deployed as `sst.aws.Nextjs` → AWS Lambda. After the 202
  returns, **Lambda freezes the instance** before
  `executeCloneForQueue` (HTTP tarball fetch + chunked relayfile write)
  can complete. The dangling promise either runs on a future thaw or
  never runs at all.
- Audit lines (`logger.info("GitHub clone request completed")` /
  `logger.warn("GitHub clone request failed")`) never fire because they
  live inside the executor.

Failure is silent end-to-end: sage sees a clean 202, no logs, no
errors. Users see "the commits path returned no data."

## Goals

1. Clone work executes durably regardless of Lambda lifecycle. Once
   `/api/v1/github/clone/request` returns 202, the clone WILL run
   within seconds-to-minutes, even if no further HTTP requests hit the
   cloud Lambda.
2. Existing API contract preserved:
   `POST /api/v1/github/clone/request` returns 202 + `jobId`.
   `GET /api/v1/github/clone/status/{jobId}` returns durable status.
   No client changes required (sage, specialist).
3. Observability: every clone has audit log entries. Failures surface
   with attempt count + last error.
4. Idempotency: re-requesting the same `(workspaceId, owner, repo)`
   within a cooldown is deduplicated (preserve current sage-side
   debounce semantics on the server side too).

## Non-goals

- Changing what a clone DOES (tarball fetch, chunked write) — only how
  it's scheduled.
- Real-time clone progress streaming.
  `queued | running | completed | failed` is enough.
- Retroactively repairing repos that should have been cloned but
  weren't.

## Current architecture

```
sage worker (CF Workers)
  └─ POST /cloud/api/v1/github/clone/request
       └─ route.ts:129 — bearer auth, zod parse
            └─ cloneQueue.enqueue(req, () => executeCloneForQueue(req))
                 └─ in-memory CloneQueue (per Lambda instance)
                      └─ void Promise.resolve().then(executeFn)
                           └─ Lambda freezes; executor abandoned
```

## Proposed architecture

```
sage worker
  └─ POST /cloud/api/v1/github/clone/request (Lambda)
       └─ bearer auth, zod parse
       └─ deduplication check (Postgres jobs table)
       └─ enqueue to SST-managed SQS:
          GithubCloneQueue.send({ jobId, workspaceId, owner, repo, requestedAt })
       └─ persist job row (Postgres):
          jobs[jobId] = { status: "queued", ... }
       └─ return 202 + { jobId }

GithubCloneQueueWorker (SST queue subscriber, separate Lambda)
  └─ on message:
       └─ jobs[jobId].status = "running"
       └─ executeClone(request, jobId, deps)
       └─ jobs[jobId].status = "completed" | "failed"
       └─ emit audit log

GET /cloud/api/v1/github/clone/status/{jobId}
  └─ read jobs[jobId] from Postgres → return
     { status, attempts, lastError, completedAt }
```

### Why SST queue over alternatives

- **SST queue** (SQS-backed): native to existing infra, declared in
  `infra/`, auto-wires permissions to subscriber Lambda. Already used
  for `nango-sync-queue.ts`. **Pick this.**
- **Step Functions**: overkill for a 1-step job.
- **EventBridge schedule**: not the right primitive — we want
  event-driven, not scheduled.
- **In-process with `after()` (Vercel-style)**: not portable to AWS
  Lambda streaming responses; SST doesn't expose it cleanly.

### Storage for job records

Use existing **Aurora Postgres** (`appDatabase` in `infra/database.ts`).
Don't introduce DynamoDB. New Drizzle migration adds:

```sql
CREATE TABLE github_clone_jobs (
  job_id        UUID PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  owner         TEXT NOT NULL,
  repo          TEXT NOT NULL,
  status        TEXT NOT NULL,  -- queued | running | completed | failed
  attempts      INT NOT NULL DEFAULT 0,
  last_error    TEXT,
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ
);
CREATE INDEX github_clone_jobs_dedupe_idx
  ON github_clone_jobs (workspace_id, owner, repo, status, requested_at);
```

Drizzle migration goes in `packages/web/drizzle/`.

## API contract (preserved)

| Endpoint | Method | Behavior |
|---|---|---|
| `/cloud/api/v1/github/clone/request` | POST | bearer auth → dedupe → enqueue SQS → write job row `status:"queued"` → return `202 { jobId }` |
| `/cloud/api/v1/github/clone/status/{jobId}` | GET | bearer auth → read job row → return `{ status, attempts, lastError?, completedAt? }` |

No request/response shape changes. Sage and specialist clients require
zero updates.

## Idempotency / dedupe

- Server-side dedupe key: `${workspaceId}:${owner}/${repo}`.
- On enqueue: check Postgres for an existing job row with the key,
  status in `{queued, running}`, AND `requested_at > now() - 30 min`.
  If found, return the existing `jobId` with 202 (idempotent).
- This makes sage's client-side cooldown belt-and-suspenders rather
  than load-bearing.
- Dedupe TTL = 30 min (longer than queue visibility = 16 min, so a
  retried message can't accidentally double-enqueue).

## Failure modes & observability

| Failure | Surface |
|---|---|
| Tarball fetch 404 / 401 | `status: "failed"`, `last_error: "github_fetch_<status>"`, audit warn. **Do NOT retry**: bad creds or missing repo won't recover. Throw a non-retryable error class so SQS doesn't redeliver. |
| Tarball fetch 5xx / network | DLQ after 3 attempts (SQS native retry) → `status: "failed"`, `last_error: "github_fetch_transient"`. |
| Relayfile bulk-write error | Same — 3 SQS attempts → DLQ → `status: "failed"`. |
| Worker Lambda timeout | SQS visibility timeout → message redelivered → next worker picks up. Idempotent because terminal DB write happens at end. |
| DB write failure on enqueue | Return 500 to client. Sage retries (already wired via clone-requester cooldown). |

Audit log entries (CloudWatch):
- `info: github_clone_enqueued { jobId, workspace, owner, repo }`
- `info: github_clone_started { jobId, attempt }`
- `info: github_clone_completed { jobId, durationMs, fileCount }`
- `warn: github_clone_failed { jobId, attempt, error }`

Metric (CloudWatch custom):
`github_clone.queued_to_completed_p95_seconds`. Alert if > 5 min for 3
consecutive samples.

## Cold-start SLA

| Percentile | Target | Note |
|---|---|---|
| p50 | < 30s | typical small-medium repo (tarball + chunked write) |
| p95 | < 90s | medium-large repo |
| p99 | < 5 min | huge repos (rare) |
| Hard ceiling | 15 min | queue visibility = hard kill |

**Don't pre-warm the worker Lambda.** Cold start is ~2-3s. The clone
itself is the bottleneck. Provisioned concurrency would cost money for
negligible improvement.

What you actually want for cold-start UX:
- **Sage-side**: when the model hits an unindexed repo, surface "this
  repo isn't indexed yet — kicking off a clone, retry in ~30s" instead
  of returning empty results. Already partially in place via
  `_clone_requested.txt` advisory; just make the model surface that to
  the user when it sees the advisory.
- **Status polling**: give sage a way to await completion when the
  user's question is unanswerable without the clone. PR #169 already
  pre-warms; the missing piece is "block briefly until the clone
  progresses past `queued`." 60-90s timeout, then fall back.

If clone latency p95 creeps above 2 min in production, **then**
investigate the clone path (tarball size, chunked-write batch size).
Not before.

## Refactor before lifting

Extract `executeClone` to a pure-ish function with explicit deps before
moving to the worker:

```ts
// packages/web/lib/integrations/github-clone-executor.ts
export interface CloneExecutorDeps {
  relayfileClient: RelayFileClient;
  githubTarball: (owner: string, repo: string) => Promise<ReadableStream>;
  jobStore: { update(jobId: string, patch: Partial<JobRow>): Promise<void> };
  logger: Logger;
}

export async function executeClone(
  request: CloneRequest,
  jobId: string,
  deps: CloneExecutorDeps,
): Promise<CloneResult> {
  // existing logic, no module-scoped state
}
```

Worker handler factory:

```ts
// packages/core/src/clone/github-clone-worker.ts
export const handler = async (event: SQSEvent) => {
  const deps = buildDeps(/* read env, db, secrets */);
  for (const record of event.Records) {
    const { jobId, request } = parsePayload(record.body);
    await executeClone(request, jobId, deps);
  }
};
```

Why this shape:
- Existing in-memory `cloneQueue.startJob` can call the same
  `executeClone` during the migration phase (both paths share the
  executor).
- The pure function is unit-testable with mocked deps. No SST/Lambda
  needed for tests.
- Module-scoped singletons (the current `cloneQueue` itself, any cached
  relayfile client) move to the handler factory or get explicitly wired
  in.

Audit the current `executeCloneForQueue` for:
- Module-scoped variables (other than `cloneQueue` — those are problem
  state).
- Direct env reads (`process.env.X`) — pull these into deps instead.
- Logger references (`logger.info(...)`) — already injectable, just
  thread it through.

Probably <100 lines of refactor before the queue lift.

## Migration plan

1. **Drizzle migration**: add `github_clone_jobs` table per schema
   above. Migration in `packages/web/drizzle/`.
2. **Refactor**: extract
   `executeClone(request, jobId, deps)` from `executeCloneForQueue`.
   Existing in-memory queue still works (calls the new function).
3. **Infra**: `infra/github-clone-queue.ts` mirroring
   `infra/nango-sync-queue.ts`:
   ```ts
   const GithubCloneDlq = new sst.aws.Queue("GithubCloneDlq", {
     visibilityTimeout: "15 minutes",
   });
   export const githubCloneQueue = new sst.aws.Queue("GithubCloneQueue", {
     visibilityTimeout: "16 minutes",
     dlq: { queue: GithubCloneDlq.arn, retry: 3 },
   });
   githubCloneQueue.subscribe(
     {
       handler: "packages/core/src/clone/github-clone-worker.handler",
       timeout: "15 minutes",
       memory: "512 MB",
       link: [appDatabase, /* relayfile client secrets */],
       vpc,
       environment: {
         RELAYFILE_URL: relayfileUrl,
         /* ... */
       },
     },
     { batch: { size: 1 } },
   );
   ```
4. **Handler update**: route handler now writes job row to Postgres +
   sends SQS message, returns 202. Status endpoint reads from Postgres.
5. **Worker**: dequeues, updates job row to `running`, calls
   `executeClone`, updates job row to terminal status.
6. **Feature flag** `USE_DURABLE_CLONE_QUEUE`: when on, new path. When
   off, legacy in-memory `cloneQueue` (which still calls the same
   `executeClone` post-refactor).
7. **Cleanup**: remove `CloneQueue` class + flag after a clean week
   in prod.

## Test plan

| Layer | Test |
|---|---|
| Unit | `executeClone`: success path → row patched to `completed`; transient error → throws (SQS retries); permanent error → row patched to `failed`, throws non-retryable. |
| Unit | Request handler: dedupe path returns existing jobId; new path writes Postgres row + sends SQS message. |
| Unit | Status handler: returns row contents, 404 for missing jobId. |
| Integration | Local SST dev: full round-trip POST → poll status → see `completed`. |
| End-to-end | Staging: sage worker fires clone for a real test repo, status reaches `completed` within 60s, files visible in relayfile workspace. |
| Regression | Status endpoint contract unchanged for existing sage/specialist clients. |
| Load | 100 concurrent clone requests for distinct repos: all reach `completed`, p95 latency tracked. |

## Rollout

1. Deploy to staging with `USE_DURABLE_CLONE_QUEUE` flag OFF. Schema
   migration runs. Worker is deployed but receives no traffic (legacy
   in-memory path still active).
2. Flip flag ON in staging. New SQS path active. Side-by-side for 24h.
   Watch staging metrics: clone success rate (target ≥99%), p95
   latency, DLQ count.
3. Flip flag ON in production. Watch metrics for 1 week.
4. Remove flag + delete `CloneQueue` class + remove legacy code paths.
   Single durable path remains.

## Open questions (resolved)

1. **DB**: Aurora Postgres (existing `appDatabase`). New table
   `github_clone_jobs` via Drizzle migration in
   `packages/web/drizzle/`.
2. **Queue**: Mirror `infra/nango-sync-queue.ts`. New file
   `infra/github-clone-queue.ts`.
3. **Long clones**: 16-min visibility timeout, 15-min worker timeout,
   30-min server-side dedupe TTL.
4. **Cold-start SLA**: target p95 < 90s, p99 < 5 min, hard ceiling
   15 min. Don't provision concurrency.
5. **Refactor before lift**: extract
   `executeClone(request, jobId, deps)` to a pure function with
   explicit deps. Audit `executeCloneForQueue` for module-scoped state
   and direct env reads.

## References

- Current handler:
  `packages/web/app/api/v1/github/clone/request/route.ts:129`
- Current queue:
  `packages/web/lib/integrations/github-clone-queue.ts:269-350`
- Existing queue pattern: `infra/nango-sync-queue.ts`
- Database setup: `infra/database.ts:64`
- Sage clone-requester (calls this API):
  `sage/src/integrations/clone-requester.ts:47-89`
- Sage prod failure trace: 2026-04-30 — sage tail evidence on the
  `@Sage what's in AgentWorkforce/relaycast?` failure that led to this
  spec.
