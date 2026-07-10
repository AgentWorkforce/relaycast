/**
 * runtime-v4-worker-dispatch.ts
 *
 * Phase 4 of the workflow runtime adapter refactor — Worker Dispatch.
 *
 * REPLACES the earlier runtime-v4-openclaw.ts. OpenClaw is not a runtime
 * adapter — it's a dispatch target. The Mac mini already has agent-relay
 * installed; the cloud just needs to hand it a workflow and a relayfile
 * token. No custom RPC protocol, no gatewayd binary, no packaging.
 *
 * This workflow ships the cloud side of Phase 1 from the worker-dispatch
 * spec at docs/runtimes/specs/worker-dispatch.md:
 *
 *   - DB tables: workers, worker_enrollment_tokens, work_assignments
 *   - packages/core/src/workers/{types,registry,dispatcher}.ts
 *   - packages/web/lib/workers/{tokens,assignments,queue}.ts
 *   - API routes: register, SSE queue, heartbeat, ack, status, list
 *   - Dispatcher hook in the web workflow launcher so workflows tagged
 *     for a worker enqueue instead of launching a Daytona sandbox
 *
 * Out of scope (runtime-v6-worker-onboarding.ts handles these):
 *   - Web UI (Workspace Settings → Workers)
 *   - Enrollment token mint endpoint wired to a user session
 *   - Landing page with install commands
 *
 * Also out of scope (lives in the agent-relay CLI repo):
 *   - `agent-relay worker` subcommand itself
 *
 * Prerequisite: runtime-v1-interface.ts must have been merged (workers
 * use SandboxedStepExecutor + LocalRuntime on their own host, which v1
 * shipped).
 *
 * Run: agent-relay run workflows/runtime-v4-worker-dispatch.ts
 */

import { CodexModels, workflow } from '@relayflows/core';

async function main() {
  const result = await workflow('runtime-v4-worker-dispatch')
    .description('Cloud-side worker registry + dispatch queue + launcher hook')
    .pattern('dag')
    .channel('wf-runtime-v4')
    .maxConcurrency(6)
    .timeout(3_000_000)

    .agent('lead', {
      cli: 'codex',
      role: 'Architect — plans registry, dispatcher, API, and launcher hook',
      // Non-interactive headless Codex avoids PTY idle-kill during long
      // plan/reflect prompts while keeping the analyst-style read-only flow.
      preset: 'analyst',
      interactive: false,
      retries: 1,
      constraints: { model: CodexModels.GPT_5_4 },
      permissions: {
        access: 'readonly',
        files: {
          read: [
            'docs/runtimes/specs/worker-dispatch.md',
            'packages/core/src/runtime/**',
            'packages/core/src/bootstrap/launcher.ts',
            'packages/web/app/api/v1/workflows/run/**',
            'packages/web/app/api/v1/**',
            'packages/web/lib/**',
            'packages/web/drizzle/**',
          ],
          write: [],
          deny: [],
        },
        exec: [],
      },
    })

    .agent('impl-core', {
      cli: 'codex',
      role: 'Implementer — writes worker registry + dispatcher in packages/core',
      preset: 'worker',
      retries: 2,
      constraints: { model: CodexModels.GPT_5_3_CODEX },
      permissions: {
        access: 'restricted',
        files: {
          read: ['packages/core/**', 'package.json', 'tsconfig*.json', 'docs/runtimes/specs/worker-dispatch.md'],
          write: ['packages/core/src/workers/**'],
          deny: [
            'packages/core/src/runtime/types.ts',
            'packages/core/src/runtime/daytona.ts',
            'packages/core/src/runtime/local.ts',
            'packages/core/src/runtime/e2b.ts',
            'tests/**',
            '.env*',
          ],
        },
        exec: [],
      },
    })

    .agent('impl-web', {
      cli: 'codex',
      role: 'Implementer — writes DB schema, API routes, launcher hook in packages/web',
      preset: 'worker',
      retries: 2,
      constraints: { model: CodexModels.GPT_5_3_CODEX },
      permissions: {
        access: 'restricted',
        files: {
          read: ['packages/web/**', 'packages/core/**', 'package.json', 'tsconfig*.json', 'docs/runtimes/specs/worker-dispatch.md'],
          write: [
            'packages/web/drizzle/schema/workers.ts',
            'packages/web/drizzle/migrations/**',
            'packages/web/lib/workers/**',
            'packages/web/app/api/v1/workers/**',
            'packages/web/app/api/v1/workflows/run/route.ts',
          ],
          deny: [
            'packages/core/**',
            '.env*',
            'infra/**',
          ],
        },
        exec: [],
      },
    })

    .agent('reviewer', {
      cli: 'codex',
      role: 'Peer reviewer — security + dispatch correctness + SSE lifecycle',
      preset: 'reviewer',
      retries: 1,
      constraints: { model: CodexModels.GPT_5_4 },
      permissions: {
        access: 'readonly',
        files: { read: ['packages/**', 'docs/**'], write: [], deny: [] },
        exec: [],
      },
    })

    // ─── Phase 1: Read context ─────────────────────────────────────────

    .step('read-spec', {
      type: 'deterministic',
      command: 'cat docs/runtimes/specs/worker-dispatch.md',
      captureOutput: true,
      failOnError: true,
    })

    .step('read-launcher', {
      type: 'deterministic',
      command: [
        'echo "=== launcher.ts (entry and sandbox creation section) ==="',
        'sed -n "1,50p;290,370p" packages/core/src/bootstrap/launcher.ts',
      ].join(' && '),
      captureOutput: true,
      failOnError: false,
    })

    .step('read-workflow-run-route', {
      type: 'deterministic',
      command: [
        'echo "=== POST /api/v1/workflows/run handler ==="',
        'find packages/web/app/api/v1/workflows -name "route.ts" -exec cat {} \\;',
      ].join(' && '),
      captureOutput: true,
      failOnError: false,
    })

    .step('read-drizzle-sample', {
      type: 'deterministic',
      command: [
        'echo "=== drizzle schema sample ==="',
        'find packages/web -path "*/drizzle/schema*" -name "*.ts" 2>/dev/null | head -3',
        'echo',
        'find packages/web -path "*/drizzle/schema*" -name "*.ts" 2>/dev/null | head -1 | xargs cat 2>/dev/null || echo "(no schemas yet)"',
      ].join(' && '),
      captureOutput: true,
      failOnError: false,
    })

    .step('read-auth-helpers', {
      type: 'deterministic',
      command: [
        'echo "=== how routes resolve workspace from request ==="',
        'grep -rn "resolveWorkspace\\|requireAuth\\|getWorkspace\\b" packages/web/lib 2>/dev/null | head -10',
      ].join(' && '),
      captureOutput: true,
      failOnError: false,
    })

    // ─── Phase 2: Plan ─────────────────────────────────────────────────

    .step('plan', {
      agent: 'lead',
      dependsOn: ['read-spec', 'read-launcher', 'read-workflow-run-route', 'read-drizzle-sample', 'read-auth-helpers'],
      task: `Plan the cloud-side worker dispatch implementation.

Full spec:
{{steps.read-spec.output}}

Current workflow launcher:
{{steps.read-launcher.output}}

Current POST /workflows/run handler:
{{steps.read-workflow-run-route.output}}

Drizzle schema style:
{{steps.read-drizzle-sample.output}}

Workspace auth helpers:
{{steps.read-auth-helpers.output}}

Produce a detailed plan covering:

## A. packages/core/src/workers/

Three new files:

1. **types.ts**
   export type WorkerStatus = 'pending' | 'online' | 'offline' | 'revoked';

   export interface WorkerRecord {
     id: string;
     workspaceId: string;
     name: string;
     displayName: string;
     status: WorkerStatus;
     lastSeen: Date | null;
     hostInfo: { os?: string; arch?: string; agentRelayVersion?: string };
     tags: string[];
   }

   export interface WorkAssignment {
     id: string;
     workspaceId: string;
     workerId: string | null;
     runId: string;
     workflowRef: { type: 'url' | 'inline'; value: string };
     status: 'queued' | 'assigned' | 'running' | 'completed' | 'failed' | 'timeout';
     queuedAt: Date;
     assignedAt: Date | null;
     startedAt: Date | null;
     completedAt: Date | null;
     queueDeadline: Date;
     result?: { exitCode: number; durationMs: number; summary?: string };
     error?: string;
   }

   export interface WorkerSelection {
     workerId?: string;   // exact match by id
     name?: string;       // exact match by name in workspace
     tags?: string[];     // all tags must match
   }

   export interface DispatchOptions {
     maxQueueWaitMs?: number;   // default 10 * 60 * 1000
     envSecrets?: Record<string, string>;
   }

2. **registry.ts** — WorkerRegistry class
   Methods:
     - register(row: NewWorkerRow): Promise<{ worker: WorkerRecord; plaintextToken: string }>
     - findByName(workspaceId, name): Promise<WorkerRecord | null>
     - findById(workerId): Promise<WorkerRecord | null>
     - listByWorkspace(workspaceId): Promise<WorkerRecord[]>
     - select(workspaceId, selection): Promise<WorkerRecord> // throws if no match or match is offline
     - markOnline(workerId): Promise<void>
     - markOffline(workerId): Promise<void>
     - revoke(workerId): Promise<void>
     - validateToken(workerId, plaintextToken): Promise<boolean>  // timing-safe
   All methods accept a db handle (pg pool or drizzle instance) as the
   first argument — no module-level state, no side channels.

3. **dispatcher.ts** — WorkerDispatcher class
   Constructor: WorkerDispatcher(registry: WorkerRegistry, bus: AssignmentBus)
   Where AssignmentBus is a minimal interface:
     interface AssignmentBus {
       publish(workerId: string, assignment: WorkAssignment): Promise<void>;
       subscribe(workerId: string, onEvent: (a: WorkAssignment) => void): () => void;  // returns unsub
     }
   In v4 AssignmentBus is an in-memory implementation scoped to the web
   process. Document that multi-instance cloud deployments will need a
   Redis-backed bus in a follow-up. (Note: same limitation as existing
   relay-file-access.ts revocation tracker — documented TODO.)

   Methods:
     - enqueue(worker: WorkerRecord, workflowRef, runId, workspace, options): Promise<WorkAssignment>
       * Creates DB row with status='queued', deadline=now+maxQueueWait
       * If worker is online → publish to bus + set status='assigned' + return
       * If offline → return with status='queued' (worker will poll on next SSE connect)
     - ack(workerId, runId): Promise<void>           // status='assigned' → 'running' conceptually; worker confirms receipt
     - reportStatus(workerId, runId, phase, detail): Promise<void>
       * phase: 'started' | 'running' | 'completed' | 'failed'
       * Updates assignment row + timestamps
     - reapTimeouts(): Promise<number>
       * Finds rows where now > queue_deadline and status='queued'
       * Marks them 'timeout' and fires a cancellation callback on the bus
     - pollQueueForWorker(workerId): Promise<WorkAssignment[]>
       * Returns all status='queued' assignments for this worker
       * Used when a worker first connects SSE — catches up on anything
         that was enqueued while offline

## B. packages/web/drizzle/schema/workers.ts

Drizzle schema matching the style of existing schema files in the repo.
Three tables: workers, worker_enrollment_tokens, work_assignments — see
the spec for exact columns and indices.

Also generate the migration SQL file under packages/web/drizzle/migrations/
with the next sequential migration number. Do NOT run the migration.

## C. packages/web/lib/workers/

1. **tokens.ts**
   - mintEnrollmentToken(db, { workspaceId, userId }): Promise<{ plaintext: string; expiresAt: Date }>
     * "ocl_wrk_enr_" + 24 base58 chars
     * sha256 hash stored, TTL 15 min
   - redeemEnrollmentToken(db, plaintext, { name, hostInfo, ip }): Promise<{ workerId; workerToken; }>
     * Timing-safe hash comparison
     * Marks used_at inside the same transaction as worker creation
     * Mints worker token "ocl_wrk_" + 48 base58, stores sha256
     * Creates worker row status='pending'
   - validateWorkerToken(db, workerId, plaintext): Promise<boolean>

2. **assignments.ts**
   Wraps the dispatcher methods above for use inside API route handlers.
   Provides:
   - enqueueForWorker(db, bus, request): Promise<WorkAssignment>
   - recordPhaseTransition(db, workerId, runId, phase, detail)
   - listAssignmentsForWorker(db, workerId, { status? })

3. **queue.ts** — SSE helper
   - createAssignmentStream(bus, workerId): ReadableStream<Uint8Array>
     * Subscribes to bus for this workerId
     * Emits SSE "data:" frames with JSON assignments
     * Also emits periodic "heartbeat" pings (every 20s) so clients can
       detect dead connections
     * Unsubscribes when the stream is closed

## D. packages/web/app/api/v1/workers/

Next.js App Router routes (match existing route.ts style):

1. **register/route.ts** — POST
   - Body: { enrollmentToken, name, hostInfo }
   - No user session required — token IS the auth
   - Call redeemEnrollmentToken
   - Return { workerId, workerToken, heartbeatIntervalMs }
   - Rate limit: 10/min per source IP

2. **[workerId]/queue/route.ts** — GET (SSE)
   - Auth: Bearer ocl_wrk_xxx
   - Validate token against workerId
   - Mark worker online
   - On initial connect: call dispatcher.pollQueueForWorker and emit any queued assignments
   - Open SSE stream via createAssignmentStream
   - Stream continues until client disconnects
   - On disconnect: mark worker offline after a 60s grace period (so flapping connections don't trigger offline→online→offline)

3. **[workerId]/heartbeat/route.ts** — POST
   - Auth: Bearer token
   - Update last_seen + status='online'
   - Return { ok: true, nextHeartbeatMs: 30000 }

4. **[workerId]/assignments/[runId]/ack/route.ts** — POST
   - Auth: Bearer
   - Sets assignment status='assigned' + assigned_at=now (if not already)

5. **[workerId]/assignments/[runId]/status/route.ts** — POST
   - Auth: Bearer
   - Body: { phase: 'running' | 'completed' | 'failed', exitCode?, durationMs?, error?, summary? }
   - Call dispatcher.reportStatus
   - Return { ok: true }

6. **route.ts** (the /workers index) — GET
   - Auth: user session + workspace membership
   - Return { workers: listByWorkspace(...) }

7. **[workerId]/route.ts** — GET, DELETE
   - GET: single worker detail (user session required)
   - DELETE: revoke worker (sets status='revoked', publishes a CANCEL event on the bus to drop any live SSE stream)

## E. Launcher integration

Modify: **packages/web/app/api/v1/workflows/run/route.ts**

Before the existing Daytona launch path, add a runtime-type check:

  const runtimeDesc = req.workflow?.runtime ?? workspace.defaultRuntime ?? { id: 'daytona' };
  if (runtimeDesc.id === 'worker') {
    const worker = await registry.select(workspace.id, runtimeDesc.config ?? {});
    const assignment = await dispatcher.enqueue(worker, workflowRef, runId, workspace, {
      envSecrets: req.envSecrets,
      maxQueueWaitMs: req.workflow?.queueWaitMs ?? 10 * 60 * 1000,
    });
    return json({ runId, dispatchedTo: worker.name, assignmentId: assignment.id });
  }
  // existing Daytona path unchanged below...

Important:
- Do NOT change the Daytona path behavior.
- workspace.defaultRuntime may not exist yet in the schema — if not,
  default to { id: 'daytona' } inline and leave a TODO comment that v6
  will add the workspace-level setting.
- workflowRef must be a URL (or inline payload) the worker can fetch.
  For v4, use an inline JSON encoding of the workflow definition or a
  short-lived signed S3 URL. Leave the implementation of workflowRef
  packaging to a helper function the dispatcher can call; if the helper
  doesn't exist yet, create it as packages/web/lib/workers/workflow-ref.ts
  with a simple MVP: { type: 'inline', value: JSON.stringify(workflowSpec) }.

## F. What NOT to touch

- packages/core/src/runtime/types.ts (frozen in v1)
- packages/core/src/bootstrap/launcher.ts (don't move the Daytona launch into the worker path; add the fork in the HTTP route)
- any .env file
- any test file

## G. Known TODOs to document in code comments

- AssignmentBus is in-memory; multi-instance deployment requires Redis.
- Worker token rotation is not implemented in v4.
- Concurrency per worker is hardcoded to 1; no multi-assignment per worker.
- Tag-based pool selection is stubbed but not optimized (linear scan).

End with PLAN_COMPLETE.`,
      verification: { type: 'output_contains', value: 'PLAN_COMPLETE' },
    })

    // ─── Phase 3: Self-reflection ──────────────────────────────────────

    .step('reflect', {
      agent: 'lead',
      dependsOn: ['plan'],
      task: `Self-reflect on the worker-dispatch plan.

Plan:
{{steps.plan.output}}

Challenge yourself:

1. **SSE vs polling race**: when a worker connects to /queue, the plan
   says (a) mark online, (b) drain queued assignments, (c) stream future
   ones. What if a new assignment is enqueued between (b) and (c)?
   Fix: (c) subscribe to bus FIRST, then (b) drain queued, then start
   emitting. Any event that arrives during drain is buffered by the bus
   subscriber and delivered after the drain flush. Revise the plan.

2. **Token comparison**: the plan says timing-safe comparison for
   worker tokens. Confirm the implementer will use crypto.timingSafeEqual
   and not the === operator. Add an explicit rule to the implement step.

3. **Enqueue-while-offline**: if a worker is offline when a workflow
   fires, the assignment sits in 'queued'. When the worker eventually
   connects, pollQueueForWorker fetches it. But what if queue_deadline
   already passed? The plan's reapTimeouts marks expired rows, but
   reapTimeouts runs on a schedule — between reaps, an expired row
   could still be served. Fix: pollQueueForWorker must filter
   'WHERE status = queued AND queue_deadline > now()'. Revise.

4. **Assignment bus subscriber lifetime**: each SSE connection creates
   one subscriber. When the stream closes (client disconnect, network
   failure, worker revoked), the subscriber must be removed from the bus
   or it leaks memory. Ensure createAssignmentStream's cleanup callback
   calls bus.unsubscribe on stream close.

5. **Dispatcher back-pressure**: what happens if a worker is assigned
   a workflow, then enqueue is called AGAIN for the same worker before
   the first completes? With concurrency=1, the second enqueue should
   still enqueue (not reject) and wait. The bus.publish should deliver
   it to the worker's SSE stream; the worker is responsible for
   serializing its own work. OR the dispatcher can track in-flight
   assignments per worker and defer publishing. For v4, do the simple
   thing: dispatcher always publishes, worker serializes. Document
   that worker.concurrency is effectively uncapped from the cloud's
   perspective — the worker.toml config limits it locally.

6. **SSE Content-Type + Next.js**: Next.js App Router supports streaming
   responses via Response(ReadableStream), but Content-Type must be
   'text/event-stream' and Cache-Control 'no-cache'. Add these headers
   explicitly in the queue route handler.

7. **Worker authentication**: Bearer token in the Authorization header.
   The implementer should use a single helper like
   'requireWorkerAuth(req, db): Promise<WorkerRecord>' that validates
   the token and throws 401 on failure. Add this helper to
   packages/web/lib/workers/auth.ts (not covered in the plan — add it).

8. **Dispatcher integration risk**: the plan modifies
   packages/web/app/api/v1/workflows/run/route.ts. The existing route
   may have complex pre-processing (auth, permissions, credential
   building) that happens BEFORE the dispatch decision. Ensure the
   worker-dispatch branch runs AFTER all pre-processing and ONLY
   replaces the launchOrchestratorSandbox call. Do not reorder
   anything that happens before.

9. **What about workflow.runtime source?**: in v4 we read
   workflow.runtime from the request body (whatever the client posted).
   But the existing clients don't post a runtime field. So the
   dispatcher branch is dead code unless workspace.defaultRuntime is set,
   OR we add a new optional field to the POST body schema. Document
   this: v4 ADDS an optional 'runtime' field to the POST body with
   shape { id: string, config?: unknown }. Existing clients unchanged.

10. **Revocation during live run**: if a user revokes a worker mid-run,
    what happens to the running assignment? Options: (a) let it finish,
    (b) cancel it. For v4, let it finish — revocation means "no more
    new work", not "kill in-flight". Document this.

Revise the plan with the fixes above. End with REFLECTION_COMPLETE.`,
      verification: { type: 'output_contains', value: 'REFLECTION_COMPLETE' },
    })

    // ─── Phase 4: Parallel implementation ──────────────────────────────

    .step('implement-core', {
      agent: 'impl-core',
      dependsOn: ['reflect'],
      task: `Implement the worker registry + dispatcher in packages/core.

Plan:
{{steps.plan.output}}

Reflection (overrides):
{{steps.reflect.output}}

Create:
- packages/core/src/workers/types.ts
- packages/core/src/workers/registry.ts
- packages/core/src/workers/dispatcher.ts
- packages/core/src/workers/bus.ts         (in-memory AssignmentBus implementation)
- packages/core/src/workers/index.ts       (re-exports)

Hard rules:
1. No module-level state. Every class takes dependencies (db handle, bus) via constructor.
2. Token validation uses crypto.timingSafeEqual. Never ===.
3. No console.log of token values.
4. AssignmentBus subscribe returns an unsubscribe function; no leaks.
5. pollQueueForWorker filters on queue_deadline > now() to avoid serving expired assignments.
6. Dispatcher.enqueue subscribes to bus FIRST (for the SSE case), THEN drains queued rows, THEN the caller attaches the SSE stream — but wait, that's for the SSE route, not enqueue. Clarification: the SSE route handler orchestrates this sequence. The dispatcher just exposes pollQueueForWorker + bus.subscribe. Make sure the API surface supports calling them in the right order without a race.
7. Revocation (dispatcher.revokeWorker or registry.revoke) does NOT cancel in-flight running assignments. It only prevents new ones from being enqueued.
8. Document at the top of bus.ts: "TODO: in-memory AssignmentBus is per-process. Multi-instance cloud deployments require a Redis-backed bus. Same limitation as packages/core/src/relay-file-access.ts revocation tracker."
9. All imports use .js extensions per the repo convention.
10. Do NOT touch packages/core/src/runtime/** or packages/core/src/bootstrap/launcher.ts.

Do not run build or test commands.`,
      verification: { type: 'file_exists', value: 'packages/core/src/workers/dispatcher.ts' },
    })

    .step('implement-web', {
      agent: 'impl-web',
      dependsOn: ['reflect'],
      task: `Implement the DB schema, API routes, and launcher hook in packages/web.

Plan:
{{steps.plan.output}}

Reflection (overrides):
{{steps.reflect.output}}

Create:
- packages/web/drizzle/schema/workers.ts
- packages/web/drizzle/migrations/NNNN_workers.sql   (NNNN = next sequential number in migrations dir)
- packages/web/lib/workers/tokens.ts
- packages/web/lib/workers/assignments.ts
- packages/web/lib/workers/queue.ts
- packages/web/lib/workers/auth.ts            (requireWorkerAuth helper)
- packages/web/lib/workers/workflow-ref.ts    (MVP: inline JSON packaging)
- packages/web/app/api/v1/workers/route.ts                                  (GET list)
- packages/web/app/api/v1/workers/register/route.ts                         (POST register)
- packages/web/app/api/v1/workers/[workerId]/route.ts                       (GET, DELETE)
- packages/web/app/api/v1/workers/[workerId]/queue/route.ts                 (GET SSE)
- packages/web/app/api/v1/workers/[workerId]/heartbeat/route.ts             (POST)
- packages/web/app/api/v1/workers/[workerId]/assignments/[runId]/ack/route.ts      (POST)
- packages/web/app/api/v1/workers/[workerId]/assignments/[runId]/status/route.ts   (POST)

Modify:
- packages/web/app/api/v1/workflows/run/route.ts
  * Add the runtime-type fork before launchOrchestratorSandbox
  * Only fork when runtimeDesc.id === 'worker'
  * Do not change the Daytona path
  * Add an optional 'runtime' field to the POST body schema

Hard rules:
1. Match the existing drizzle schema style — grep for an existing schema file in packages/web/drizzle/schema/ and mirror its structure.
2. Migration SQL creates all three tables with indices exactly as in the spec.
3. SSE route sets Content-Type: text/event-stream, Cache-Control: no-cache, Connection: keep-alive.
4. SSE route emits a ping every 20s ("event: ping\\ndata: {}\\n\\n") so clients can detect dead connections.
5. SSE cleanup: on stream close (abort signal from the client, or stream.cancel), unsubscribe from bus and mark worker offline after a 60s grace timer. Implement the grace by scheduling a setTimeout that's cancelled if the worker reconnects within the window.
6. Token comparisons use crypto.timingSafeEqual. Validation helpers live in auth.ts.
7. No 5xx response body contains stack traces — return { error: 'internal' } and log server-side.
8. Rate limit /register to 10 req/min per source IP. Use the repo's existing rate limit helper if present; otherwise add a tiny in-memory LRU with a TODO for Redis.
9. Workflow run route change:
   - Parse req.body.runtime if present; default to { id: 'daytona' } (or workspace default if that field exists in the workspace schema)
   - if runtime.id === 'worker': fork into the worker path
   - Import WorkerRegistry + WorkerDispatcher from '@agent-relay/core/workers' (or whatever the cross-package import path is — mirror how other core imports are done in the route)
   - Package the workflow with workflow-ref.ts and enqueue
   - Return { runId, dispatchedTo, assignmentId }
10. workflow-ref.ts MVP: just JSON.stringify the workflow spec and return { type: 'inline', value: ... }. A later phase will swap this for signed S3 URLs.
11. Do not touch packages/core/**.

Do not run build, migration, or test commands.`,
      verification: { type: 'file_exists', value: 'packages/web/app/api/v1/workers/register/route.ts' },
    })

    // ─── Phase 5: Self-reviews (parallel) ──────────────────────────────

    .step('self-review-core', {
      agent: 'impl-core',
      dependsOn: ['implement-core'],
      task: `Self-review the core/workers implementation.

Re-read every file you created. Checklist:

1. types.ts exports all interfaces from the plan (WorkerStatus, WorkerRecord, WorkAssignment, WorkerSelection, DispatchOptions, AssignmentBus).
2. registry.ts has all methods listed in the plan. Every method takes a db handle as first argument.
3. registry.validateToken uses crypto.timingSafeEqual.
4. dispatcher.ts has: enqueue, ack, reportStatus, reapTimeouts, pollQueueForWorker.
5. pollQueueForWorker filters on queue_deadline > now() — verify the SQL or ORM condition.
6. bus.ts has an in-memory Map implementation with subscribe returning an unsub function.
7. bus.ts has the TODO comment about Redis migration.
8. index.ts re-exports everything.
9. No module-level state (no 'let foo' outside a class).
10. No console.log of token values.
11. All imports use .js extensions.
12. No stray TODO / placeholder / "// ..." elision.

Fix any issue by editing on disk. End with SELF_REVIEW_COMPLETE.`,
      verification: { type: 'output_contains', value: 'SELF_REVIEW_COMPLETE' },
    })

    .step('self-review-web', {
      agent: 'impl-web',
      dependsOn: ['implement-web'],
      task: `Self-review the web implementation.

Re-read every file you created or modified. Checklist:

1. drizzle schema matches repo style (correct imports, table helpers, column types).
2. Migration SQL creates all three tables with the indices from the spec.
3. tokens.ts: mintEnrollmentToken + redeemEnrollmentToken + validateWorkerToken. sha256 hash only, timing-safe comparison.
4. auth.ts: requireWorkerAuth extracts Bearer token, validates, throws 401 on failure.
5. SSE route (/queue):
   - Content-Type: text/event-stream
   - Cache-Control: no-cache
   - Connection: keep-alive
   - Subscribes to bus, then drains queued, then streams
   - 20s ping events
   - Cleanup on abort: unsubscribe from bus, schedule 60s offline grace
6. Workflow run route fork: ONLY activates when runtime.id === 'worker'. Daytona path untouched.
7. Rate limit on /register.
8. No 5xx leaks stack traces.
9. No token values logged.
10. All imports use .js where required.

Fix any issue by editing on disk. End with SELF_REVIEW_COMPLETE.`,
      verification: { type: 'output_contains', value: 'SELF_REVIEW_COMPLETE' },
    })

    // ─── Phase 6: Deterministic verification ───────────────────────────

    .step('verify-build-core', {
      type: 'deterministic',
      dependsOn: ['self-review-core'],
      command: [
        'echo "=== tsc --noEmit on packages/core ==="',
        'cd packages/core && npx tsc --noEmit -p tsconfig.build.json 2>&1 | tee /tmp/runtime-v4-core-tsc.log | head -200',
        'grep -c "error TS" /tmp/runtime-v4-core-tsc.log || echo 0',
      ].join(' && '),
      captureOutput: true,
      failOnError: false,
    })

    .step('verify-build-web', {
      type: 'deterministic',
      dependsOn: ['self-review-web'],
      command: [
        'echo "=== tsc --noEmit on packages/web ==="',
        'cd packages/web && npx tsc --noEmit 2>&1 | tee /tmp/runtime-v4-web-tsc.log | head -200',
        'grep -c "error TS" /tmp/runtime-v4-web-tsc.log || echo 0',
      ].join(' && '),
      captureOutput: true,
      failOnError: false,
    })

    .step('verify-routes-exist', {
      type: 'deterministic',
      dependsOn: ['self-review-web'],
      command: [
        'for f in \\',
        '  packages/web/app/api/v1/workers/route.ts \\',
        '  packages/web/app/api/v1/workers/register/route.ts \\',
        '  packages/web/app/api/v1/workers/\\[workerId\\]/route.ts \\',
        '  packages/web/app/api/v1/workers/\\[workerId\\]/queue/route.ts \\',
        '  packages/web/app/api/v1/workers/\\[workerId\\]/heartbeat/route.ts \\',
        '  packages/web/app/api/v1/workers/\\[workerId\\]/assignments/\\[runId\\]/ack/route.ts \\',
        '  packages/web/app/api/v1/workers/\\[workerId\\]/assignments/\\[runId\\]/status/route.ts; do',
        '  test -f "$f" && echo "ok: $f" || { echo "MISSING: $f"; exit 1; }',
        'done',
      ].join('\n'),
      captureOutput: true,
      failOnError: true,
    })

    .step('verify-core-files-exist', {
      type: 'deterministic',
      dependsOn: ['self-review-core'],
      command: [
        'for f in packages/core/src/workers/types.ts packages/core/src/workers/registry.ts packages/core/src/workers/dispatcher.ts packages/core/src/workers/bus.ts packages/core/src/workers/index.ts; do',
        '  test -f "$f" && echo "ok: $f" || { echo "MISSING: $f"; exit 1; }',
        'done',
      ].join('\n'),
      captureOutput: true,
      failOnError: true,
    })

    .step('verify-migration-present', {
      type: 'deterministic',
      dependsOn: ['self-review-web'],
      command: 'find packages/web/drizzle -name "*worker*" -type f 2>&1 | tee /tmp/v4-migration-files.log && [ -s /tmp/v4-migration-files.log ]',
      captureOutput: true,
      failOnError: true,
    })

    .step('verify-daytona-path-untouched', {
      type: 'deterministic',
      dependsOn: ['self-review-web'],
      command: [
        'echo "=== workflows/run/route.ts should still import launchOrchestratorSandbox ==="',
        'grep -n "launchOrchestratorSandbox" packages/web/app/api/v1/workflows/run/route.ts || { echo "DAYTONA PATH LOST"; exit 1; }',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('fix-build', {
      agent: 'impl-web',
      dependsOn: ['verify-build-core', 'verify-build-web', 'verify-routes-exist', 'verify-core-files-exist', 'verify-migration-present', 'verify-daytona-path-untouched'],
      task: `Consolidated verification output:

core tsc:
{{steps.verify-build-core.output}}

web tsc:
{{steps.verify-build-web.output}}

routes present:
{{steps.verify-routes-exist.output}}

core files present:
{{steps.verify-core-files-exist.output}}

migration SQL present:
{{steps.verify-migration-present.output}}

Daytona path untouched:
{{steps.verify-daytona-path-untouched.output}}

If any tsc errors exist, fix them by editing files on disk (web or core as appropriate).
If a file is missing, create it.
If the Daytona path check failed, restore the import and fork logic so the existing Daytona launch still works.

If everything is clean, output NO_FIX_NEEDED.`,
      verification: { type: 'exit_code' },
    })

    .step('re-verify-build', {
      type: 'deterministic',
      dependsOn: ['fix-build'],
      command: [
        'cd packages/core && npx tsc --noEmit -p tsconfig.build.json 2>&1 | head -100',
        'echo "--- web ---"',
        'cd packages/web && npx tsc --noEmit 2>&1 | head -100',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    // ─── Phase 7: Peer review ──────────────────────────────────────────

    .step('peer-review', {
      agent: 'reviewer',
      dependsOn: ['re-verify-build'],
      task: `Peer-review the worker dispatch implementation.

Read:
- packages/core/src/workers/{types,registry,dispatcher,bus,index}.ts
- packages/web/drizzle/schema/workers.ts
- packages/web/drizzle/migrations/*worker*.sql
- packages/web/lib/workers/{tokens,auth,assignments,queue,workflow-ref}.ts
- packages/web/app/api/v1/workers/**/route.ts
- packages/web/app/api/v1/workflows/run/route.ts (diff only — focus on the fork)

Review for:

## Security
1. Enrollment tokens: sha256 hashed, 15-min TTL, single-use, rate-limited.
2. Worker tokens: sha256 hashed, plaintext returned ONCE in the register response.
3. All token comparisons use crypto.timingSafeEqual.
4. No token values logged anywhere.
5. 5xx responses never leak stack traces.
6. Bearer auth on every worker-facing endpoint (queue, heartbeat, ack, status).
7. User-session auth on every user-facing endpoint (list, detail, delete).

## Correctness
8. Dispatcher.enqueue handles both online (publish to bus) and offline (queue only) workers correctly.
9. pollQueueForWorker filters on queue_deadline > now() so expired assignments don't get served.
10. SSE route subscribes to bus BEFORE draining queued assignments to avoid races.
11. SSE cleanup on disconnect: unsubscribe + schedule 60s offline grace.
12. ack / status updates use timing-safe token validation via the shared auth helper.
13. Worker revocation does NOT cancel in-flight running assignments.

## Launcher integration
14. The Daytona launch path is untouched — workflow.runtime.id !== 'worker' goes through the exact same code as before.
15. The worker fork runs AFTER all pre-processing (auth, workspace resolution, etc.).
16. The new 'runtime' field in the POST body is optional. Existing clients unchanged.

## Code quality
17. No module-level state in packages/core/src/workers/.
18. All imports use .js extensions.
19. No TODO without a reason comment.
20. SSE Content-Type, Cache-Control, Connection headers set correctly.

Verdict: APPROVED or CHANGES_REQUESTED with a grouped bulleted list.

End with REVIEW_COMPLETE.`,
      verification: { type: 'output_contains', value: 'REVIEW_COMPLETE' },
    })

    .onError('retry', { maxRetries: 2, retryDelayMs: 10_000 })
    .run({ cwd: process.cwd() });

  console.log('Result:', result.status);
}

main().catch(console.error);
