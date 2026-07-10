/**
 * GitHub Clone Durable Queue
 *
 * Implements specs/github-clone-durable-queue.md end-to-end:
 * - move /api/v1/github/clone/request from an in-process Lambda queue to an
 *   SST/SQS durable queue
 * - persist durable github_clone_jobs rows in Aurora Postgres
 * - run clone execution from a separate queue subscriber Lambda
 * - preserve existing request/status HTTP contracts for Sage and specialist
 * - add observability, idempotent server-side dedupe, and 80-to-100 tests
 *
 * Run:
 *   agent-relay run workflows/github-clone-durable-queue.ts
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { applyCloudRepoSetup } from './lib/cloud-repo-setup.ts';

const BRANCH = 'codex/github-clone-durable-queue';
const GH_NOOP_PATH = '.agent-bin/gh';
const LOCAL_WORKFLOW_SDK = 'node_modules/@agent-relay/sdk/dist/workflows/index.js';
const CONTEXT_DIR = '.workflow-context/github-clone-durable-queue';

const SPEC = 'specs/github-clone-durable-queue.md';
const REQUEST_ROUTE = 'packages/web/app/api/v1/github/clone/request/route.ts';
const STATUS_ROUTE = 'packages/web/app/api/v1/github/clone/status/[jobId]/route.ts';
const CURRENT_QUEUE = 'packages/web/lib/integrations/github-clone-queue.ts';
const CLONE_AUTH = 'packages/web/lib/integrations/github-clone-auth.ts';
const CLONE_SCHEMA = 'packages/web/lib/integrations/github-clone-schema.ts';
const CLONE_AUDIT = 'packages/web/lib/integrations/github-clone-audit.ts';
const CLONE_ORCHESTRATOR = 'packages/web/lib/integrations/github-clone-orchestrator.ts';
const CLONE_WRITER = 'packages/web/lib/integrations/github-clone-writer.ts';
const NANGO_CLIENT = 'packages/web/lib/integrations/github-nango-proxy-client.ts';
const WORKSPACE_INTEGRATIONS = 'packages/web/lib/integrations/workspace-integrations.ts';
const WEB_DB_SCHEMA = 'packages/web/lib/db/schema.ts';
const CORE_DB_SCHEMA = 'packages/core/src/db/schema.ts';
const CORE_DB_CLIENT = 'packages/core/src/db/client.ts';
const CORE_CLONE_DIR = 'packages/core/src/clone';
const JOB_TYPES = `${CORE_CLONE_DIR}/github-clone-job.ts`;
const JOB_STORE = `${CORE_CLONE_DIR}/github-clone-job-store.ts`;
const CLONE_EXECUTOR = `${CORE_CLONE_DIR}/github-clone-executor.ts`;
const CLONE_PRODUCTION = `${CORE_CLONE_DIR}/github-clone-production.ts`;
const CORE_CLONE_WRITER = `${CORE_CLONE_DIR}/github-clone-writer.ts`;
const CORE_TARBALL_WALKER = `${CORE_CLONE_DIR}/github-tarball-walker.ts`;
const WORKER = `${CORE_CLONE_DIR}/github-clone-worker.ts`;
const WEB_QUEUE_CLIENT = 'packages/web/lib/integrations/github-clone-durable-queue.ts';
const INFRA_QUEUE = 'infra/github-clone-queue.ts';
const INFRA_WEB = 'infra/web.ts';
const INFRA_NANGO_QUEUE = 'infra/nango-sync-queue.ts';
const MIGRATION = 'packages/web/drizzle/0021_github_clone_jobs.sql';
const JOURNAL = 'packages/web/drizzle/meta/_journal.json';

const TEST_HELPER = 'tests/helpers/github-clone-db.ts';
const JOB_STORE_TEST = 'tests/github-clone-job-store.test.ts';
const REQUEST_ROUTE_TEST = 'tests/github-clone-request-route.test.ts';
const STATUS_ROUTE_TEST = 'tests/github-clone-status-route.test.ts';
const WORKER_TEST = 'tests/github-clone-worker.test.ts';
const DURABLE_E2E_TEST = 'tests/github-clone-durable-queue.e2e.test.ts';
const EXISTING_GITHUB_TESTS =
  'tests/github-clone-runner.contract.test.ts tests/github-tarball-walker.test.ts tests/github-clone-writer.test.ts tests/github-clone-audit.test.ts';
const EXISTING_GITHUB_VITEST_TESTS = 'tests/github-clone-queue.test.ts';
const NEW_TESTS =
  `${JOB_STORE_TEST} ${REQUEST_ROUTE_TEST} ${STATUS_ROUTE_TEST} ${WORKER_TEST} ${DURABLE_E2E_TEST} ${EXISTING_GITHUB_VITEST_TESTS}`;
const ENSURE_CLOUD_RESUME_ENV = [
  'mkdir -p .agent-bin .logs',
  'git config user.email "agent@agent-relay.com"',
  'git config user.name "GitHub Clone Durable Queue Workflow"',
  `git checkout -B ${BRANCH}`,
  `printf '%s\\n' '#!/usr/bin/env bash' 'echo "gh no-op: $*" >&2' 'exit 0' > ${GH_NOOP_PATH}`,
  `chmod +x ${GH_NOOP_PATH}`,
].join(' && ');
const ENSURE_DEPS =
  `${ENSURE_CLOUD_RESUME_ENV} && (test -d node_modules/vitest -a -d node_modules/tsx || npm install --legacy-peer-deps --no-audit --no-fund)`;

const READ_FILES = [
  `${CONTEXT_DIR}/**`,
  SPEC,
  REQUEST_ROUTE,
  STATUS_ROUTE,
  CURRENT_QUEUE,
  CLONE_AUTH,
  CLONE_SCHEMA,
  CLONE_AUDIT,
  CLONE_ORCHESTRATOR,
  CLONE_WRITER,
  NANGO_CLIENT,
  WORKSPACE_INTEGRATIONS,
  WEB_DB_SCHEMA,
  CORE_DB_SCHEMA,
  CORE_DB_CLIENT,
  CLONE_EXECUTOR,
  CLONE_PRODUCTION,
  CORE_CLONE_WRITER,
  CORE_TARBALL_WALKER,
  WORKER,
  INFRA_NANGO_QUEUE,
  INFRA_WEB,
  TEST_HELPER,
  REQUEST_ROUTE_TEST,
  'tests/github-clone-runner.contract.test.ts',
  'tests/github-clone-queue.test.ts',
  'tests/nango-sync-worker.test.ts',
  'packages/core/src/sync/nango-sync-worker.ts',
  'packages/web/lib/integrations/nango-sync-queue.ts',
  'packages/web/drizzle/meta/_journal.json',
  'package.json',
];

const WRITE_FILES = [
  REQUEST_ROUTE,
  STATUS_ROUTE,
  CURRENT_QUEUE,
  CLONE_AUTH,
  CLONE_SCHEMA,
  CLONE_AUDIT,
  CLONE_ORCHESTRATOR,
  WEB_DB_SCHEMA,
  CORE_DB_SCHEMA,
  JOB_TYPES,
  JOB_STORE,
  CLONE_EXECUTOR,
  CLONE_PRODUCTION,
  CORE_CLONE_WRITER,
  CORE_TARBALL_WALKER,
  WORKER,
  WEB_QUEUE_CLIENT,
  INFRA_QUEUE,
  INFRA_WEB,
  MIGRATION,
  JOURNAL,
  TEST_HELPER,
  JOB_STORE_TEST,
  REQUEST_ROUTE_TEST,
  STATUS_ROUTE_TEST,
  WORKER_TEST,
  DURABLE_E2E_TEST,
  'package.json',
];

const DENY_FILES = [
  '.env*',
  'packages/web/.next/**',
  'packages/web/.open-next/**',
  'node_modules/**',
  '**/node_modules/**',
  '.agent-bin/**',
  '.agent-relay/**',
  '.trajectories/**',
  '.relayfile-mount-state.json',
  '..relayfile-mount-state.json.tmp-*',
  '../relayauth/**',
  '../relayfile/**',
];

function standardPermissions(write: string[]) {
  return {
    access: 'restricted',
    files: {
      read: READ_FILES,
      write,
      deny: DENY_FILES,
    },
    exec: [],
  };
}

function agentOptions<T extends Record<string, unknown>>(options: T) {
  return options as never;
}

async function loadWorkflowFactory() {
  const moduleFailures: string[] = [];
  const candidates = [
    resolve(process.cwd(), LOCAL_WORKFLOW_SDK),
    ...(process.env.HOME ? [resolve(process.env.HOME, LOCAL_WORKFLOW_SDK)] : []),
  ];

  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      moduleFailures.push(`${candidate}: not found`);
      continue;
    }

    try {
      const workflowModule = await import(pathToFileURL(candidate).href);
      if (typeof workflowModule.workflow === 'function') {
        return workflowModule.workflow as (name: string) => any;
      }
      moduleFailures.push(`${candidate}: missing workflow() export`);
    } catch (error) {
      moduleFailures.push(
        `${candidate}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  try {
    const workflowModule = await import('@relayflows/core');
    if (typeof workflowModule.workflow === 'function') {
      return workflowModule.workflow as (name: string) => any;
    }
    moduleFailures.push('@relayflows/core: missing workflow() export');
  } catch (error) {
    moduleFailures.push(
      `@relayflows/core: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  throw new Error(
    [
      'Unable to load @relayflows/core without installing packages at runtime.',
      'Cloud bootstrap should already install the SDK under $HOME/node_modules; local runs should use repo node_modules.',
      ...moduleFailures.map((failure) => `- ${failure}`),
    ].join('\n'),
  );
}

async function main() {
  const workflow = await loadWorkflowFactory();
  const baseWorkflow = workflow('github-clone-durable-queue')
    .description('Move GitHub clone request execution onto an SST durable SQS queue with durable Postgres status and full 80-to-100 validation')
    .pattern('dag')
    .channel('wf-github-clone-durable-queue')
    .maxConcurrency(5)
    .timeout(7_200_000)

    .agent('architect', agentOptions({
      cli: 'claude',
      preset: 'lead',
      retries: 0,
      role: 'Lead architect and final reviewer for the durable queue migration. Owns cross-lane consistency and API compatibility. Never use the GitHub CLI; any gh command is treated as a no-op.',
      permissions: {
        access: 'readonly',
        files: { read: READ_FILES, write: [], deny: DENY_FILES },
        exec: ['git diff *', 'git status *', 'sed *', 'grep *', 'ls *'],
      },
    }))

    .agent('db-store-worker', agentOptions({
      cli: 'codex',
      preset: 'worker',
      retries: 0,
      role: 'Implements Drizzle schema, SQL migration, durable job row types, and Postgres job store helpers. Never use the GitHub CLI; any gh command is treated as a no-op.',
      permissions: standardPermissions([
        CORE_DB_SCHEMA,
        JOB_TYPES,
        JOB_STORE,
        MIGRATION,
        JOURNAL,
        TEST_HELPER,
      ]),
    }))

    .agent('api-worker', agentOptions({
      cli: 'codex',
      preset: 'worker',
      retries: 0,
      role: 'Updates request/status routes and web enqueue client while preserving Sage/specialist API contracts. Never use the GitHub CLI; any gh command is treated as a no-op.',
      permissions: standardPermissions([
        REQUEST_ROUTE,
        STATUS_ROUTE,
        WEB_QUEUE_CLIENT,
        CLONE_SCHEMA,
        CLONE_AUDIT,
      ]),
    }))

    .agent('worker-infra-worker', agentOptions({
      cli: 'codex',
      preset: 'worker',
      retries: 0,
      role: 'Builds the SQS subscriber worker, explicit clone executor deps, and SST queue wiring. Never use the GitHub CLI; any gh command is treated as a no-op.',
      permissions: standardPermissions([
        WORKER,
        JOB_TYPES,
        JOB_STORE,
        CLONE_EXECUTOR,
        INFRA_QUEUE,
        INFRA_WEB,
        CLONE_AUDIT,
      ]),
    }))

    .agent('test-worker', agentOptions({
      cli: 'codex',
      preset: 'worker',
      retries: 0,
      role: 'Writes unit, route, worker, and local E2E tests before the final fix loop. Never use the GitHub CLI; any gh command is treated as a no-op.',
      permissions: standardPermissions([
        TEST_HELPER,
        JOB_STORE_TEST,
        REQUEST_ROUTE_TEST,
        STATUS_ROUTE_TEST,
        WORKER_TEST,
        DURABLE_E2E_TEST,
      ]),
    }))

    .agent('fixer', agentOptions({
      cli: 'codex',
      preset: 'worker',
      retries: 0,
      role: 'Reads failing deterministic output, fixes product or test code as needed, and reruns checks until green. Never use the GitHub CLI; any gh command is treated as a no-op.',
      permissions: standardPermissions(WRITE_FILES),
    }))

    .agent('reviewer', agentOptions({
      cli: 'claude',
      preset: 'reviewer',
      retries: 0,
      role: 'Performs final correctness, production-risk, and test-coverage review before commit. Never use the GitHub CLI; any gh command is treated as a no-op.',
      permissions: {
        access: 'restricted',
        files: { read: [...READ_FILES, ...WRITE_FILES], write: [], deny: DENY_FILES },
        exec: ['git diff *', 'git status *', 'grep *', 'sed *', 'ls *'],
      },
    }));

  const wf = applyCloudRepoSetup(baseWorkflow, {
    branch: BRANCH,
    committerName: 'GitHub Clone Durable Queue Workflow',
    extraSetupCommands: [
      'mkdir -p .agent-bin',
      `printf '%s\\n' '#!/usr/bin/env bash' 'echo "gh no-op: $*" >&2' 'exit 0' > ${GH_NOOP_PATH}`,
      `chmod +x ${GH_NOOP_PATH}`,
      `PATH="$PWD/.agent-bin:$PATH" gh --version || true`,
    ],
  });

  const result = await wf
    // ---------------------------------------------------------------------
    // Phase 1: context and acceptance contract
    // ---------------------------------------------------------------------

    .step('sanitize-workspace', {
      type: 'deterministic',
      dependsOn: ['install-deps'],
      command: [
        'rm -rf .agent-relay/step-artifacts',
        'rm -f .relayfile-mount-state.json ..relayfile-mount-state.json.tmp-*',
        "find packages -path '*/node_modules' -prune -type d -exec rm -rf {} + 2>/dev/null || true",
        'echo WORKSPACE_SANITIZED',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('read-spec', {
      type: 'deterministic',
      dependsOn: ['sanitize-workspace'],
      command: [
        `mkdir -p ${CONTEXT_DIR}`,
        `sed -n '1,340p' ${SPEC} > ${CONTEXT_DIR}/spec.md`,
        `wc -c ${CONTEXT_DIR}/spec.md`,
        'echo READ_SPEC_READY',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('read-current-api', {
      type: 'deterministic',
      dependsOn: ['sanitize-workspace'],
      command: [
        `mkdir -p ${CONTEXT_DIR}`,
        `{ printf '%s\\n' "REQUEST_ROUTE=${REQUEST_ROUTE}"; sed -n '1,240p' ${REQUEST_ROUTE}; printf '%s\\n' "STATUS_ROUTE=${STATUS_ROUTE}"; sed -n '1,220p' '${STATUS_ROUTE}'; printf '%s\\n' "CURRENT_QUEUE=${CURRENT_QUEUE}"; sed -n '1,380p' ${CURRENT_QUEUE}; } > ${CONTEXT_DIR}/current-api.txt`,
        `wc -c ${CONTEXT_DIR}/current-api.txt`,
        'echo READ_CURRENT_API_READY',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('read-clone-execution', {
      type: 'deterministic',
      dependsOn: ['sanitize-workspace'],
      command: [
        `mkdir -p ${CONTEXT_DIR}`,
        `{ sed -n '1,360p' ${CLONE_ORCHESTRATOR}; printf '%s\\n' "--- writer ---"; sed -n '1,260p' ${CLONE_WRITER}; printf '%s\\n' "--- nango client ---"; sed -n '1,260p' ${NANGO_CLIENT}; printf '%s\\n' "--- audit ---"; sed -n '1,220p' ${CLONE_AUDIT}; } > ${CONTEXT_DIR}/clone-execution.txt`,
        `wc -c ${CONTEXT_DIR}/clone-execution.txt`,
        'echo READ_CLONE_EXECUTION_READY',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('read-db-and-infra-patterns', {
      type: 'deterministic',
      dependsOn: ['sanitize-workspace'],
      command: [
        `mkdir -p ${CONTEXT_DIR}`,
        `{ sed -n '1,320p' ${CORE_DB_SCHEMA}; printf '%s\\n' "--- db client ---"; sed -n '1,220p' ${CORE_DB_CLIENT}; printf '%s\\n' "--- nango queue infra ---"; sed -n '1,180p' ${INFRA_NANGO_QUEUE}; printf '%s\\n' "--- web infra imports/linking ---"; sed -n '1,150p' ${INFRA_WEB}; printf '%s\\n' "--- journal ---"; cat ${JOURNAL}; } > ${CONTEXT_DIR}/db-infra.txt`,
        `wc -c ${CONTEXT_DIR}/db-infra.txt`,
        'echo READ_DB_INFRA_READY',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('read-test-patterns', {
      type: 'deterministic',
      dependsOn: ['sanitize-workspace'],
      command: [
        `mkdir -p ${CONTEXT_DIR}`,
        `{ sed -n '1,220p' ${REQUEST_ROUTE_TEST}; printf '%s\\n' "--- queue tests ---"; sed -n '1,320p' tests/github-clone-queue.test.ts; printf '%s\\n' "--- nango worker tests ---"; sed -n '1,260p' tests/nango-sync-worker.test.ts; printf '%s\\n' "--- pglite helper ---"; sed -n '1,220p' ${TEST_HELPER}; } > ${CONTEXT_DIR}/test-patterns.txt`,
        `wc -c ${CONTEXT_DIR}/test-patterns.txt`,
        'echo READ_TEST_PATTERNS_READY',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('acceptance-contract', {
      agent: 'architect',
      dependsOn: [
        'read-spec',
        'read-current-api',
        'read-clone-execution',
        'read-db-and-infra-patterns',
        'read-test-patterns',
      ],
      task: `Write the implementation contract for the durable queue migration.

Read these context files from disk instead of relying on step output:
- ${CONTEXT_DIR}/spec.md
- ${CONTEXT_DIR}/current-api.txt
- ${CONTEXT_DIR}/clone-execution.txt
- ${CONTEXT_DIR}/db-infra.txt
- ${CONTEXT_DIR}/test-patterns.txt

Produce concise lane assignments and invariants:
- request returns 202 with existing ok/jobId/status shape plus durable job id
- status reads Postgres, includes attempts and lastError without breaking existing job wrapper clients
- dedupe key is workspaceId/owner/repo/ref with queued/running rows newer than 30 minutes
- queue message contains jobId plus the clone request, never secrets
- worker sets running, increments attempts, calls existing clone behavior, records terminal status
- clone execution is extracted behind explicit deps that both web and the worker can call without core importing web-only modules
- 404/401 GitHub fetch failures are non-retryable and do not redeliver
- transient failures throw so SQS retries and DLQ handles attempt exhaustion
- migration and journal update land together
- all tests run deterministically before commit
- do not create PRs, push branches, call GitHub APIs, or depend on gh; a local gh shim is present only to make accidental gh calls no-op

End with CONTRACT_READY.`,
      verification: { type: 'output_contains', value: 'CONTRACT_READY' },
    })

    // ---------------------------------------------------------------------
    // Phase 2: implementation lanes
    // ---------------------------------------------------------------------

    .step('implement-db-store', {
      agent: 'db-store-worker',
      dependsOn: ['acceptance-contract'],
      task: `Implement the durable github clone job schema and store.

Read the spec and context from ${CONTEXT_DIR}/. The lead contract was posted to the workflow channel; if it is unavailable, follow ${CONTEXT_DIR}/spec.md and the requirements below.

Edit only your owned files:
- ${MIGRATION}: create github_clone_jobs and github_clone_jobs_dedupe_idx
- ${JOURNAL}: add matching idx/tag entry for 0021_github_clone_jobs
- ${CORE_DB_SCHEMA}: export githubCloneJobs pgTable
- ${JOB_TYPES}: typed statuses, row, enqueue payload, terminal helpers
- ${JOB_STORE}: getDb-backed helpers for create, dedupe, markRunning, markCompleted, markFailed, findById
- ${TEST_HELPER}: PGlite DDL must include workspace_integrations plus github_clone_jobs

Requirements:
- statuses are queued, running, completed, failed
- attempts defaults to 0 and increments when worker starts an attempt
- dedupe TTL is 30 minutes and only queued/running rows dedupe
- preserve ref in key even though the spec key omits it; HEAD and branch clones must not collide
- no process.env secret reads in the store
- do not run gh; if any existing script tries to call gh, treat that call as already no-op

End with DB_STORE_DONE.`,
      verification: { type: 'output_contains', value: 'DB_STORE_DONE' },
    })

    .step('verify-db-store-files', {
      type: 'deterministic',
      dependsOn: ['implement-db-store'],
      command: [
        `test -f ${MIGRATION}`,
        `test -f ${JOB_TYPES}`,
        `test -f ${JOB_STORE}`,
        `grep -q "CREATE TABLE github_clone_jobs" ${MIGRATION}`,
        `grep -q "github_clone_jobs_dedupe_idx" ${MIGRATION}`,
        `grep -q "githubCloneJobs" ${CORE_DB_SCHEMA}`,
        `grep -q "findActiveGithubCloneJob" ${JOB_STORE}`,
        `grep -q "markGithubCloneJobRunning" ${JOB_STORE}`,
        `grep -q "markGithubCloneJobCompleted" ${JOB_STORE}`,
        `grep -q "markGithubCloneJobFailed" ${JOB_STORE}`,
        `grep -q "github_clone_jobs" ${TEST_HELPER}`,
        `grep -q "0021_github_clone_jobs" ${JOURNAL}`,
        `git diff --quiet -- ${MIGRATION} ${JOURNAL} ${CORE_DB_SCHEMA} ${JOB_TYPES} ${JOB_STORE} ${TEST_HELPER} && (echo "DB_STORE_NOT_MODIFIED"; exit 1) || echo DB_STORE_FILES_OK`,
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
      verification: { type: 'output_contains', value: 'DB_STORE_FILES_OK' },
    })

    .step('implement-api-durable-enqueue', {
      agent: 'api-worker',
      dependsOn: ['acceptance-contract', 'verify-db-store-files'],
      task: `Update the web request/status API to use durable jobs.

Read the spec and context from ${CONTEXT_DIR}/. The lead contract was posted to the workflow channel; if it is unavailable, follow ${CONTEXT_DIR}/spec.md and the requirements below.

DB/store exports are available from ${JOB_STORE} and ${JOB_TYPES}.

Edit only your owned files:
- ${WEB_QUEUE_CLIENT}: SQS send helper using Resource.GithubCloneQueue.url
- ${REQUEST_ROUTE}: auth, zod parse, dedupe, create row, enqueue message, return 202
- ${STATUS_ROUTE}: auth, read durable job row, return current job wrapper plus attempts/lastError/completedAt
- ${CLONE_SCHEMA}: add shared response/status types only if useful
- ${CLONE_AUDIT}: add enqueued/started/completed/failed audit helpers without logging secrets

Requirements:
- default path uses durable queue when USE_DURABLE_CLONE_QUEUE is unset or true
- legacy in-memory queue remains behind USE_DURABLE_CLONE_QUEUE=false only
- DB row must exist before sending SQS; if DB insert fails return 500
- if SQS send fails, mark job failed or delete the new row and return 500
- dedupe returns existing queued/running job id with 202
- accept both SageCloudApiToken and SpecialistCloudApiToken like current request route
- do not import cloudflare or D1 types
- do not run gh; if any existing script tries to call gh, treat that call as already no-op

End with API_DURABLE_DONE.`,
      verification: { type: 'output_contains', value: 'API_DURABLE_DONE' },
    })

    .step('verify-api-files', {
      type: 'deterministic',
      dependsOn: ['implement-api-durable-enqueue'],
      command: [
        `test -f ${WEB_QUEUE_CLIENT}`,
        `grep -q "Resource.GithubCloneQueue.url" ${WEB_QUEUE_CLIENT}`,
        `grep -q "SendMessageCommand" ${WEB_QUEUE_CLIENT}`,
        `grep -q "USE_DURABLE_CLONE_QUEUE" ${REQUEST_ROUTE}`,
        `grep -q "findActiveGithubCloneJob" ${REQUEST_ROUTE}`,
        `grep -q "createGithubCloneJob" ${REQUEST_ROUTE}`,
        `grep -q "enqueueGithubCloneJob" ${REQUEST_ROUTE}`,
        `grep -q "getGithubCloneJob" '${STATUS_ROUTE}'`,
        `grep -q "attempts" '${STATUS_ROUTE}'`,
        `grep -q "lastError" '${STATUS_ROUTE}'`,
        `grep -q "SpecialistCloudApiToken" ${REQUEST_ROUTE}`,
        `! grep -q "void Promise.resolve" ${REQUEST_ROUTE}`,
        `git diff --quiet -- ${REQUEST_ROUTE} '${STATUS_ROUTE}' ${WEB_QUEUE_CLIENT} ${CLONE_SCHEMA} ${CLONE_AUDIT} && (echo "API_NOT_MODIFIED"; exit 1) || echo API_FILES_OK`,
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
      verification: { type: 'output_contains', value: 'API_FILES_OK' },
    })

    .step('implement-worker-infra', {
      agent: 'worker-infra-worker',
      dependsOn: ['acceptance-contract', 'verify-db-store-files'],
      task: `Implement the SQS subscriber worker and SST wiring.

Read the spec and context from ${CONTEXT_DIR}/. The lead contract was posted to the workflow channel; if it is unavailable, follow ${CONTEXT_DIR}/spec.md and the requirements below.

Read the existing nango worker/queue patterns from prior context. Edit only:
- ${WORKER}: SQS handler, payload parser, deps builder, status transitions
- ${CLONE_EXECUTOR}: shared explicit-deps wrapper around the existing clone behavior
- ${INFRA_QUEUE}: mirror nango-sync queue with 16 minute visibility, 15 minute worker timeout, DLQ retry 3, batch size 1
- ${INFRA_WEB}: import/link GithubCloneQueue so web can send messages
- ${CLONE_AUDIT}: add worker audit helpers if not already done

Requirements:
- worker message body is { jobId, request }
- handler loops records one at a time and lets transient errors throw
- running transition increments attempts and records startedAt
- success marks completed with filesWritten/headSha/durationMs/completedAt
- non-retryable GitHub 401/404 class marks failed and swallows to avoid redelivery
- transient GitHub/network/relayfile errors mark failed for current attempt and throw for SQS retry
- build deps through Resource first for SST secrets, process.env only for local fallback
- no module-scoped mutable queue state
- do not import from packages/web inside packages/core; if code is currently web-only, extract the pure execution seam into core or consume @relayfile/adapter-github directly
- do not run gh; if any existing script tries to call gh, treat that call as already no-op

End with WORKER_INFRA_DONE.`,
      verification: { type: 'output_contains', value: 'WORKER_INFRA_DONE' },
    })

    .step('verify-worker-infra-files', {
      type: 'deterministic',
      dependsOn: ['implement-worker-infra'],
      command: [
        `test -f ${WORKER}`,
        `test -f ${CLONE_EXECUTOR}`,
        `test -f ${INFRA_QUEUE}`,
        `grep -q "executeGithubClone" ${CLONE_EXECUTOR}`,
        `grep -q "SQSEvent\\|SQSHandler" ${WORKER}`,
        `grep -q "markGithubCloneJobRunning" ${WORKER}`,
        `grep -q "markGithubCloneJobCompleted" ${WORKER}`,
        `grep -q "markGithubCloneJobFailed" ${WORKER}`,
        `grep -q "NonRetryable" ${WORKER}`,
        `grep -q "GithubCloneQueue" ${INFRA_QUEUE}`,
        `grep -q "GithubCloneDlq" ${INFRA_QUEUE}`,
        `grep -q "visibilityTimeout: \\"16 minutes\\"" ${INFRA_QUEUE}`,
        `grep -q "batch: { size: 1 }" ${INFRA_QUEUE}`,
        `grep -q "githubCloneQueue" ${INFRA_WEB}`,
        `! grep -q "setTimeout\\|setInterval" ${WORKER}`,
        `git diff --quiet -- ${CLONE_EXECUTOR} ${WORKER} ${INFRA_QUEUE} ${INFRA_WEB} ${CLONE_AUDIT} && (echo "WORKER_INFRA_NOT_MODIFIED"; exit 1) || echo WORKER_INFRA_FILES_OK`,
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
      verification: { type: 'output_contains', value: 'WORKER_INFRA_FILES_OK' },
    })

    // ---------------------------------------------------------------------
    // Phase 3: tests
    // ---------------------------------------------------------------------

    .step('write-durable-tests', {
      agent: 'test-worker',
      dependsOn: [
        'verify-db-store-files',
        'verify-api-files',
        'verify-worker-infra-files',
      ],
      task: `Write comprehensive tests for the durable queue implementation.

Read the spec and context from ${CONTEXT_DIR}/. The lead contract was posted to the workflow channel; if it is unavailable, follow ${CONTEXT_DIR}/spec.md and the requirements below.

Create/update only:
- ${TEST_HELPER}
- ${JOB_STORE_TEST}
- ${REQUEST_ROUTE_TEST}
- ${STATUS_ROUTE_TEST}
- ${WORKER_TEST}
- ${DURABLE_E2E_TEST}

Required cases:
- job store creates queued rows, dedupes queued/running rows within 30 min, ignores completed/failed/expired rows
- markRunning increments attempts and sets startedAt
- markCompleted and markFailed set terminal fields
- request route accepts Sage and specialist tokens, returns existing job on dedupe, creates row before SQS send, handles SQS failure
- status route returns durable status, attempts, lastError, completedAt, and 404 for missing job
- worker success path runs clone deps and marks completed
- worker non-retryable 401/404 marks failed without throwing
- worker transient failure marks failed for the attempt and throws so SQS redelivers
- local E2E posts request, captures SQS payload, invokes worker, polls status, and asserts relayfile-visible completion with mocks only

Use vitest where route mocks already use vitest; use node:test only where the surrounding file does.
Do not run gh; if any existing script tries to call gh, treat that call as already no-op.
End with DURABLE_TESTS_DONE.`,
      verification: { type: 'output_contains', value: 'DURABLE_TESTS_DONE' },
    })

    .step('verify-test-files', {
      type: 'deterministic',
      dependsOn: ['write-durable-tests'],
      command: [
        `test -f ${JOB_STORE_TEST}`,
        `test -f ${STATUS_ROUTE_TEST}`,
        `test -f ${WORKER_TEST}`,
        `test -f ${DURABLE_E2E_TEST}`,
        `grep -q "dedupe" ${JOB_STORE_TEST}`,
        `grep -q "30" ${JOB_STORE_TEST}`,
        `grep -q "SpecialistCloudApiToken\\|SPECIALIST_TOKEN" ${REQUEST_ROUTE_TEST}`,
        `grep -q "SageCloudApiToken\\|SAGE_TOKEN" ${REQUEST_ROUTE_TEST}`,
        `grep -q "lastError" ${STATUS_ROUTE_TEST}`,
        `grep -q "attempts" ${STATUS_ROUTE_TEST}`,
        `grep -q "NonRetryable\\|non-retryable\\|401\\|404" ${WORKER_TEST}`,
        `grep -q "transient" ${WORKER_TEST}`,
        `grep -q "poll" ${DURABLE_E2E_TEST}`,
        `grep -q "SQS\\|sqs\\|Queue" ${DURABLE_E2E_TEST}`,
        `git diff --quiet -- ${TEST_HELPER} ${JOB_STORE_TEST} ${REQUEST_ROUTE_TEST} ${STATUS_ROUTE_TEST} ${WORKER_TEST} ${DURABLE_E2E_TEST} && (echo "TESTS_NOT_MODIFIED"; exit 1) || echo TEST_FILES_OK`,
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
      verification: { type: 'output_contains', value: 'TEST_FILES_OK' },
    })

    // ---------------------------------------------------------------------
    // Phase 4: test-fix-rerun loop
    // ---------------------------------------------------------------------

    .step('run-new-tests-first', {
      type: 'deterministic',
      dependsOn: ['verify-test-files'],
      command: `mkdir -p .logs && ${ENSURE_DEPS} && rm -rf .agent-relay/step-artifacts && (npx vitest run ${NEW_TESTS} > .logs/github-clone-durable-new-tests-first.log 2>&1; status=$?; tail -120 .logs/github-clone-durable-new-tests-first.log; exit $status)`,
      captureOutput: true,
      failOnError: false,
    })

    .step('fix-new-tests', {
      agent: 'fixer',
      dependsOn: ['run-new-tests-first'],
      task: `Fix failures from the first durable queue test run.

Read the full log from .logs/github-clone-durable-new-tests-first.log. The step output contains only the final tail:
{{steps.run-new-tests-first.output}}

If all tests passed, make no changes. If tests failed:
- inspect the failing tests and source files
- fix product code when behavior is wrong
- fix tests only when mocks/imports are wrong
- rerun: npx vitest run ${NEW_TESTS}
- keep iterating until all tests pass
- do not run gh; if any existing script tries to call gh, treat that call as already no-op

End with NEW_TESTS_FIXED.`,
      verification: { type: 'output_contains', value: 'NEW_TESTS_FIXED' },
    })

    .step('run-new-tests-final', {
      type: 'deterministic',
      dependsOn: ['fix-new-tests'],
      command: `mkdir -p .logs && ${ENSURE_DEPS} && rm -rf .agent-relay/step-artifacts && npx vitest run ${NEW_TESTS} > .logs/github-clone-durable-new-tests-final.log 2>&1; status=$?; tail -120 .logs/github-clone-durable-new-tests-final.log; exit $status`,
      captureOutput: true,
      failOnError: true,
    })

    .step('run-node-tests-first', {
      type: 'deterministic',
      dependsOn: ['run-new-tests-final'],
      command: `mkdir -p .logs && ${ENSURE_DEPS} && rm -rf .agent-relay/step-artifacts && npx tsx --test ${EXISTING_GITHUB_TESTS} > .logs/github-clone-durable-node-tests-first.log 2>&1; status=$?; tail -120 .logs/github-clone-durable-node-tests-first.log; exit $status`,
      captureOutput: true,
      failOnError: false,
    })

    .step('fix-node-tests', {
      agent: 'fixer',
      dependsOn: ['run-node-tests-first'],
      task: `Fix failures from durable job store and existing GitHub clone node:test suites.

Read the full log from .logs/github-clone-durable-node-tests-first.log. The step output contains only the final tail:
{{steps.run-node-tests-first.output}}

If all tests passed, make no changes. If tests failed:
- preserve the existing clone runner behavior
- do not weaken existing assertions
- rerun: npx tsx --test ${EXISTING_GITHUB_TESTS}
- keep iterating until all tests pass
- do not run gh; if any existing script tries to call gh, treat that call as already no-op

End with NODE_TESTS_FIXED.`,
      verification: { type: 'output_contains', value: 'NODE_TESTS_FIXED' },
    })

    .step('run-node-tests-final', {
      type: 'deterministic',
      dependsOn: ['fix-node-tests'],
      command: `mkdir -p .logs && ${ENSURE_DEPS} && rm -rf .agent-relay/step-artifacts && npx tsx --test ${EXISTING_GITHUB_TESTS} > .logs/github-clone-durable-node-tests-final.log 2>&1; status=$?; tail -120 .logs/github-clone-durable-node-tests-final.log; exit $status`,
      captureOutput: true,
      failOnError: true,
    })

    .step('run-typecheck-first', {
      type: 'deterministic',
      dependsOn: ['run-node-tests-final'],
      command: `mkdir -p .logs && ${ENSURE_DEPS} && npm run typecheck > .logs/github-clone-durable-typecheck-first.log 2>&1; status=$?; tail -120 .logs/github-clone-durable-typecheck-first.log; exit $status`,
      captureOutput: true,
      failOnError: false,
    })

    .step('fix-typecheck', {
      agent: 'fixer',
      dependsOn: ['run-typecheck-first'],
      task: `Fix typecheck failures from the durable queue migration.

Read the full log from .logs/github-clone-durable-typecheck-first.log. The step output contains only the final tail:
{{steps.run-typecheck-first.output}}

If typecheck passed, make no changes. If it failed:
- fix imports between web/core carefully
- avoid adding ambient shims
- keep SST secrets read through Resource first
- rerun: npm run typecheck
- do not run gh; if any existing script tries to call gh, treat that call as already no-op

End with TYPECHECK_FIXED.`,
      verification: { type: 'output_contains', value: 'TYPECHECK_FIXED' },
    })

    .step('run-typecheck-final', {
      type: 'deterministic',
      dependsOn: ['fix-typecheck'],
      command: `mkdir -p .logs && ${ENSURE_DEPS} && npm run typecheck > .logs/github-clone-durable-typecheck-final.log 2>&1; status=$?; tail -120 .logs/github-clone-durable-typecheck-final.log; exit $status`,
      captureOutput: true,
      failOnError: true,
    })

    // ---------------------------------------------------------------------
    // Phase 5: deterministic invariants and regressions
    // ---------------------------------------------------------------------

    .step('verify-drizzle-journal', {
      type: 'deterministic',
      dependsOn: ['run-typecheck-final'],
      command: `${ENSURE_DEPS} && npm run web:drizzle-journal:test`,
      captureOutput: true,
      failOnError: true,
    })

    .step('verify-durable-invariants', {
      type: 'deterministic',
      dependsOn: ['verify-drizzle-journal'],
      command: [
        ENSURE_CLOUD_RESUME_ENV,
        `grep -q "CREATE TABLE github_clone_jobs" ${MIGRATION}`,
        `grep -q "attempts" ${MIGRATION}`,
        `grep -q "last_error" ${MIGRATION}`,
        `grep -q "github_clone_jobs_dedupe_idx" ${MIGRATION}`,
        `grep -q "Resource.GithubCloneQueue.url" ${WEB_QUEUE_CLIENT}`,
        `grep -q "USE_DURABLE_CLONE_QUEUE" ${REQUEST_ROUTE}`,
        `grep -q "enqueueGithubCloneJob" ${REQUEST_ROUTE}`,
        `grep -q "getGithubCloneJob" '${STATUS_ROUTE}'`,
        `grep -q "markGithubCloneJobRunning" ${WORKER}`,
        `grep -q "markGithubCloneJobCompleted" ${WORKER}`,
        `grep -q "markGithubCloneJobFailed" ${WORKER}`,
        `grep -q "GithubCloneDlq" ${INFRA_QUEUE}`,
        `grep -q "retry: 3" ${INFRA_QUEUE}`,
        `grep -q "timeout: \\"15 minutes\\"" ${INFRA_QUEUE}`,
        `grep -q "memory: \\"512 MB\\"" ${INFRA_QUEUE}`,
        `grep -q "batch: { size: 1 }" ${INFRA_QUEUE}`,
        `grep -q "Resource" ${WORKER}`,
        `! grep -rn "packages/web/" ${WORKER} ${CLONE_EXECUTOR}`,
        `test -x ${GH_NOOP_PATH}`,
        `PATH="$PWD/.agent-bin:$PATH" gh pr create --title noop --body noop 2>&1 | grep -q "gh no-op"`,
        `BAD_GH=$(rg -n "gh (auth|api|repo|issue|pr|release|workflow)" workflows/github-clone-durable-queue.ts | grep -v "PATH=.*\\.git/agent-bin" | grep -v "gh no-op" || true); test -z "$BAD_GH"`,
        `! grep -rn "console.log.*token\\|console.log.*secret\\|console.log.*Authorization" ${WORKER} ${REQUEST_ROUTE} ${CLONE_AUDIT}`,
        `! grep -rn "cloudflare:workers\\|D1Database\\|DurableObject" ${JOB_STORE} ${WORKER} ${REQUEST_ROUTE}`,
        `echo DURABLE_INVARIANTS_OK`,
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
      verification: { type: 'output_contains', value: 'DURABLE_INVARIANTS_OK' },
    })

    .step('run-regression-suite-first', {
      type: 'deterministic',
      dependsOn: ['verify-durable-invariants'],
      command: `mkdir -p .logs && ${ENSURE_DEPS} && npm test > .logs/github-clone-durable-regression-first.log 2>&1; status=$?; tail -160 .logs/github-clone-durable-regression-first.log; exit $status`,
      captureOutput: true,
      failOnError: false,
    })

    .step('fix-regressions', {
      agent: 'fixer',
      dependsOn: ['run-regression-suite-first'],
      task: `Fix regressions from the full repository test suite.

Read the full log from .logs/github-clone-durable-regression-first.log. The step output contains only the final tail:
{{steps.run-regression-suite-first.output}}

If all tests passed, make no changes. If failures are unrelated, document why and rerun the targeted durable checks.
Otherwise fix the regression without weakening durable queue behavior.

Required reruns before ending:
- npm run web:drizzle-journal:test
- npx vitest run ${NEW_TESTS}
- npx tsx --test ${EXISTING_GITHUB_TESTS}
- npm test, unless an unrelated pre-existing failure is proven
- do not run gh; if any existing script tries to call gh, treat that call as already no-op

End with REGRESSIONS_FIXED.`,
      verification: { type: 'output_contains', value: 'REGRESSIONS_FIXED' },
    })

    .step('run-regression-suite-final', {
      type: 'deterministic',
      dependsOn: ['fix-regressions'],
      command: `mkdir -p .logs && ${ENSURE_DEPS} && npm test > .logs/github-clone-durable-regression-final.log 2>&1; status=$?; tail -160 .logs/github-clone-durable-regression-final.log; exit $status`,
      captureOutput: true,
      failOnError: true,
    })

    // ---------------------------------------------------------------------
    // Phase 6: review, summary, commit
    // ---------------------------------------------------------------------

    .step('final-review', {
      agent: 'reviewer',
      dependsOn: ['run-regression-suite-final'],
      task: `Review the finished durable queue migration.

Check git diff against HEAD. Focus on:
- API compatibility for Sage and specialist clients
- no remaining reliance on in-process background work when durable flag is on
- DB migration and journal consistency
- SST queue linkage from web and subscriber
- worker retry semantics: non-retryable 401/404 vs transient retry
- status endpoint durable fields
- audit logs for enqueued/started/completed/failed
- tests prove request -> queue payload -> worker -> status using mocks
- no secret leakage in logs
- no pushes, PR creation, or real gh calls; accidental gh invocations are no-op through ${GH_NOOP_PATH}

Do not edit files. End with FINAL_REVIEW_OK and list any residual risks.`,
      verification: { type: 'output_contains', value: 'FINAL_REVIEW_OK' },
    })

    .step('capture-final-evidence', {
      type: 'deterministic',
      dependsOn: ['final-review'],
      command: [
        'git status --short',
        'echo "--- changed files ---"',
        'git diff --name-only',
        'echo "--- test evidence ---"',
        `echo "vitest durable: ${NEW_TESTS}"`,
        `echo "node existing: ${EXISTING_GITHUB_TESTS}"`,
        'echo "typecheck: npm run typecheck"',
        'echo "regression: npm test"',
        'echo FINAL_EVIDENCE_CAPTURED',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
      verification: { type: 'output_contains', value: 'FINAL_EVIDENCE_CAPTURED' },
    })

    .step('commit', {
      type: 'deterministic',
      dependsOn: ['capture-final-evidence'],
      command: [
        `git add ${WRITE_FILES.map((file) => JSON.stringify(file)).join(' ')}`,
        'git diff --cached --quiet && (echo "NO_CHANGES_TO_COMMIT"; exit 1) || true',
        `git commit -m "fix(github-clone): move clone requests to durable queue"`,
        'echo DURABLE_QUEUE_COMMITTED',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
      verification: { type: 'output_contains', value: 'DURABLE_QUEUE_COMMITTED' },
    })

    .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
    .run({ cwd: process.cwd() });

  console.log('GitHub clone durable queue workflow status:', result.status);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
