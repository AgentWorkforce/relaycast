/**
 * Phase A — Repo allowlist for multi-repo cloud workflows.
 *
 * Source spec:
 *   specs/multi-repo-cloud-workflows.md
 *
 * Scope:
 *   Cloud repo only. Adds the workflow_repository_allowlists data model,
 *   CRUD API, and dashboard UI. No launcher / bootstrap / CLI behavior change.
 *
 * Run mode:
 *   Run locally from the cloud repo root with `agent-relay run` or via any
 *   environment that has this repo checked out. No sibling repos required.
 */

process.env.RUST_LOG =
  process.env.RUST_LOG ??
  ['relay_broker::worker=debug', 'relay_broker=info'].join(',');

import { workflow } from '@relayflows/core';
import { ClaudeModels, CodexModels } from '@agent-relay/config';

const BRANCH = 'feat/multi-repo-cloud-phase-a-allowlist';
const CHANNEL = 'wf-multi-repo-cloud-phase-a';
const SPEC = 'specs/multi-repo-cloud-workflows.md';

async function main() {
  const result = await workflow('multi-repo-cloud-phase-a-allowlist')
    .description(
      'Implement Phase A of specs/multi-repo-cloud-workflows.md: workflow repository allowlist schema, API, dashboard UI, and tests.',
    )
    .pattern('dag')
    .channel(CHANNEL)
    .maxConcurrency(3)
    .timeout(4_500_000)

    .agent('planner', {
      cli: 'claude',
      model: ClaudeModels.OPUS,
      role:
        'Architect. Reads the Phase A spec plus current cloud integration/data-model code, then writes a concrete plan with exact files, migration strategy, API contracts, UI scope, and verification commands.',
      retries: 1,
    })
    .agent('implementer', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      preset: 'worker',
      role:
        'Implements Phase A exactly as planned, including migration, store/helpers, CRUD route(s), integrations UI, and tests. Iterates until build/typecheck/tests are green.',
      retries: 2,
    })
    .agent('reviewer', {
      cli: 'claude',
      model: ClaudeModels.OPUS,
      role:
        'Strict final reviewer. APPROVE only when Phase A stays behavior-neutral outside allowlist surfaces and all verification gates pass.',
      retries: 1,
    })

    .step('setup-branch', {
      type: 'deterministic',
      command: [
        'set -e',
        'git config user.email "agent@agent-relay.com"',
        'git config user.name "Multi-Repo Allowlist Bot"',
        `git checkout -B ${BRANCH}`,
        'git log -1 --oneline',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })
    .step('install-deps', {
      type: 'deterministic',
      dependsOn: ['setup-branch'],
      command: 'npm install --legacy-peer-deps --no-audit --no-fund 2>&1 | tail -10',
      captureOutput: true,
      failOnError: true,
    })

    .step('read-spec', {
      type: 'deterministic',
      dependsOn: ['install-deps'],
      command: `cat ${SPEC}`,
      captureOutput: true,
      failOnError: true,
    })
    .step('read-data-and-integration-context', {
      type: 'deterministic',
      dependsOn: ['install-deps'],
      command: [
        'echo "=== db schema ==="',
        'cat packages/web/lib/db/schema.ts',
        'echo "=== integrations page ==="',
        'cat packages/web/app/integrations/page.tsx',
        'echo "=== integration route handler ==="',
        'cat packages/web/lib/integrations/integration-route-handler.ts',
        'echo "=== workspace integrations ==="',
        'cat packages/web/lib/integrations/workspace-integrations.ts',
        'echo "=== workflow run route (for non-goal boundary) ==="',
        'cat packages/web/app/api/v1/workflows/run/route.ts',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })
    .step('read-test-and-migration-context', {
      type: 'deterministic',
      dependsOn: ['install-deps'],
      command: [
        'echo "=== package scripts ==="',
        'cat package.json',
        'echo "=== drizzle journal test ==="',
        'cat tests/web-drizzle-journal.test.ts',
        'echo "=== workflow store tests ==="',
        'cat tests/orchestrator/workflow-store.test.ts',
        'echo "=== auth token lifecycle tests ==="',
        'cat tests/orchestrator/auth-token-lifecycle.test.ts',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('plan', {
      agent: 'planner',
      dependsOn: ['read-spec', 'read-data-and-integration-context', 'read-test-and-migration-context'],
      task: `Write PLAN.md for Phase A of ${SPEC}.

PLAN.md must include:
  1. Exact file:line evidence for the current integration storage path,
     integrations page, and db schema entry points.
  2. Exact new files + modified files for:
     - drizzle migration / journal entry (if needed)
     - schema/store/helper modules for workflow_repository_allowlists
     - CRUD route(s)
     - integrations dashboard page or subpage for repo registration
     - tests
  3. API contract for read-only vs pushAllowed rows.
  4. UI scope and route path. Prefer the spec's /integrations/github/repos path
     only if it matches current app structure; otherwise document the repo-correct
     path and why.
  5. Verification commands with expected outcomes. Use real project commands from
     package.json where possible.
  6. Explicit non-goals for Phase A: no launcher changes, no bootstrap changes,
     no push-back behavior changes.

Do NOT edit code in this step.`,
      verification: { type: 'file_exists', value: 'PLAN.md' },
    })
    .step('read-plan', {
      type: 'deterministic',
      dependsOn: ['plan'],
      command: 'cat PLAN.md',
      captureOutput: true,
      failOnError: true,
    })

    .step('implement', {
      agent: 'implementer',
      dependsOn: ['read-plan'],
      task: `Implement Phase A exactly as planned.

PLAN:
{{steps.read-plan.output}}

Rules:
  - Stay inside cloud repo Phase A scope only.
  - No behavioral changes to workflow execution, launcher, bootstrap, or push-back.
  - If you add/rename/remove a drizzle migration under packages/web/drizzle,
    update packages/web/drizzle/meta/_journal.json in the same change.
  - Add or update tests before claiming done.

Required verification loop before finishing:
  1. npm run web:drizzle-journal:test
  2. npm run typecheck
  3. npm run test

Repeat until green. Then write IMPL_SUMMARY.md with each changed file and one-line note.
Do not commit.`,
      verification: { type: 'file_exists', value: 'IMPL_SUMMARY.md' },
      retries: 2,
    })

    .step('run-journal-gate', {
      type: 'deterministic',
      dependsOn: ['implement'],
      command: 'npm run web:drizzle-journal:test 2>&1 | tail -40',
      captureOutput: true,
      failOnError: true,
    })
    .step('run-typecheck-gate', {
      type: 'deterministic',
      dependsOn: ['implement'],
      command: 'npm run typecheck 2>&1 | tail -60',
      captureOutput: true,
      failOnError: true,
    })
    .step('run-test-gate', {
      type: 'deterministic',
      dependsOn: ['implement'],
      command: 'npm run test 2>&1 | tail -80',
      captureOutput: true,
      failOnError: true,
    })
    .step('capture-diff', {
      type: 'deterministic',
      dependsOn: ['run-journal-gate', 'run-typecheck-gate', 'run-test-gate'],
      command: 'git diff HEAD --stat && echo --- FULL DIFF --- && git diff HEAD',
      captureOutput: true,
      failOnError: true,
    })

    .step('review', {
      agent: 'reviewer',
      dependsOn: ['capture-diff'],
      task: `Review Phase A implementation against the spec, PLAN.md, and diff.

SPEC:
{{steps.read-spec.output}}

PLAN:
{{steps.read-plan.output}}

DIFF:
{{steps.capture-diff.output}}

Write REVIEW.md with this exact shape:
  VERDICT: APPROVE
  or
  VERDICT: REQUEST_CHANGES

  ## Checklist
  - [PASS|FAIL] allowlist schema/data model matches Phase A
  - [PASS|FAIL] CRUD API exists and matches read-only vs pushAllowed semantics
  - [PASS|FAIL] dashboard repo-registration UI is present and phase-scoped
  - [PASS|FAIL] no launcher/bootstrap/push-back behavior changed
  - [PASS|FAIL] migration + journal handling is correct
  - [PASS|FAIL] typecheck + tests passed
  - [PASS|FAIL] no unrelated churn

  ## Findings
  1. <file>:<line> — <specific issue>
  2. ...`,
      verification: { type: 'file_exists', value: 'REVIEW.md' },
    })
    .step('gate-on-review', {
      type: 'deterministic',
      dependsOn: ['review'],
      command: 'grep -q "VERDICT: APPROVE" REVIEW.md',
      failOnError: true,
    })

    .step('commit-and-pr', {
      type: 'deterministic',
      dependsOn: ['gate-on-review'],
      command: [
        'rm -f PLAN.md IMPL_SUMMARY.md REVIEW.md',
        'git add -A',
        'git diff --cached --quiet && { echo "nothing to commit"; exit 1; } || true',
        'git commit -m "feat(workflows): add repo allowlist surfaces for multi-repo cloud"',
        'git push -u origin HEAD',
        'gh pr create --repo AgentWorkforce/cloud --base main --head ' + BRANCH + ' --title "feat: phase A repo allowlist for multi-repo cloud workflows" --body "Implements Phase A from specs/multi-repo-cloud-workflows.md: repo allowlist schema, CRUD API, dashboard UI, and tests. No launcher/bootstrap behavior change. Generated by workflows/multi-repo-cloud-phase-a-allowlist.ts."',
      ].join(' && '),
      failOnError: true,
    })

    .onError('fail-fast')
    .run({ cwd: process.cwd() });

  console.log('Workflow status:', result.status);
  console.log(`Branch: ${BRANCH}`);
  if (result.status !== 'completed') process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
