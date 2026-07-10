/**
 * Fix: surface bootstrap startup crashes quickly and reap stuck pending runs.
 * ============================================================================
 *
 * Source spec:
 *   specs/bootstrap-startup-crash-reporting.md
 *   (introduced on PR #275: docs(spec): bootstrap startup crash reporting)
 *
 * Runtime context
 *   Run with: `agent-relay cloud run workflows/fix-bootstrap-startup-crash-reporting.ts`
 *   The workflow runs inside a Daytona orchestrator sandbox with the cloud repo
 *   mounted at /project, so it can safely edit the repo in-place on its own
 *   implementation branch.
 *
 * Pattern
 *   writing-agent-relay-workflows: claude planner → codex test author →
 *                                  codex impl workers (bootstrap + reaper) →
 *                                  codex peer review → claude final review.
 *   relay-80-100-workflow:         failing tests first, explicit test-fix-rerun,
 *                                  hard deterministic gates, full regression
 *                                  suite before commit.
 *
 * Problem being fixed
 *   A static import crash inside the sandbox bootstrap currently happens before
 *   Reporter is instantiated, so no callback is ever posted and the run sits in
 *   `pending` forever. The web app also has no defense-in-depth sweep for runs
 *   that never report back.
 */

process.env.RUST_LOG =
  process.env.RUST_LOG ??
  [
    'relay_broker::snippets=debug',
    'relay_broker::worker=debug',
    'relay_broker=info',
  ].join(',');

import { workflow } from '@relayflows/core';
import { ClaudeModels, CodexModels } from '@agent-relay/config';
import { applyCloudRepoSetup } from './lib/cloud-repo-setup';

const BRANCH = 'fix/bootstrap-startup-crash-reporting';
const CHANNEL = 'wf-fix-bootstrap-startup-crash-reporting';
const SPEC = 'specs/bootstrap-startup-crash-reporting.md';

async function main() {
  const baseWf = workflow('fix-bootstrap-startup-crash-reporting')
    .description(
      'Implement bootstrap wrapper crash reporting + pending-run reaper from specs/bootstrap-startup-crash-reporting.md with failing tests first, deterministic gates, and final PR creation.',
    )
    .pattern('dag')
    .channel(CHANNEL)
    .maxConcurrency(4)
    .timeout(5_400_000)

    .agent('planner', {
      cli: 'claude',
      model: ClaudeModels.OPUS,
      role:
        'Architect. Reads the spec plus current cloud code, then writes a concrete implementation plan with exact files, exact tests, and repo-convention corrections where the spec uses outdated paths.',
      retries: 1,
    })
    .agent('test-author', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      preset: 'worker',
      role:
        'Writes failing regression tests before implementation. Keep tests narrowly scoped to bootstrap wrapper generation/reporting and stuck pending run reaping.',
      retries: 2,
    })
    .agent('bootstrap-impl', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      preset: 'worker',
      role:
        'Implements the two-layer bootstrap wrapper path and launcher upload/invocation changes. Owns only the bootstrap-side files plus any probe workflow the plan requires.',
      retries: 2,
    })
    .agent('reaper-impl', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      preset: 'worker',
      role:
        'Implements the stuck pending run reaper, SST wiring, timeout env handling, and token/session cleanup path while respecting current package boundaries.',
      retries: 2,
    })
    .agent('test-fixer', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      preset: 'worker',
      role:
        'Reads failing deterministic gate output, fixes the correct side, reruns until green, and writes a concise IMPL_SUMMARY.md before review.',
      retries: 2,
    })
    .agent('final-reviewer', {
      cli: 'claude',
      model: ClaudeModels.OPUS,
      role:
        'Strict final reviewer. VERDICT: APPROVE only when the implementation matches the spec, honors repo conventions, and all test/build gates prove the change works.',
      retries: 1,
    });

  // ─── Phase 0: Setup branch + deps (shared helper) ───────────────────
  const wf = applyCloudRepoSetup(baseWf, {
    branch: BRANCH,
    committerName: 'Bootstrap Crash Reporting Bot',
  });

  const result = await wf
    // ─── Phase 1: Deterministic reads ───────────────────────────────────
    .step('read-spec', {
      type: 'deterministic',
      dependsOn: ['install-deps'],
      command: `cat ${SPEC}`,
      captureOutput: true,
      failOnError: true,
    })
    .step('read-script-generator', {
      type: 'deterministic',
      dependsOn: ['install-deps'],
      command: 'cat packages/core/src/bootstrap/script-generator.ts',
      captureOutput: true,
      failOnError: true,
    })
    .step('read-launcher', {
      type: 'deterministic',
      dependsOn: ['install-deps'],
      command: 'cat packages/core/src/bootstrap/launcher.ts',
      captureOutput: true,
      failOnError: true,
    })
    .step('read-callback-route', {
      type: 'deterministic',
      dependsOn: ['install-deps'],
      command: 'cat packages/web/app/api/v1/workflows/callback/route.ts',
      captureOutput: true,
      failOnError: true,
    })
    .step('read-workflow-store', {
      type: 'deterministic',
      dependsOn: ['install-deps'],
      command: 'cat packages/web/lib/workflows.ts',
      captureOutput: true,
      failOnError: true,
    })
    .step('read-api-token-store', {
      type: 'deterministic',
      dependsOn: ['install-deps'],
      command: 'cat packages/web/lib/auth/api-token-store.ts',
      captureOutput: true,
      failOnError: true,
    })
    .step('read-credential-sweep', {
      type: 'deterministic',
      dependsOn: ['install-deps'],
      command: 'cat packages/core/src/auth/credential-sweep.ts',
      captureOutput: true,
      failOnError: true,
    })
    .step('read-script-generator-tests', {
      type: 'deterministic',
      dependsOn: ['install-deps'],
      command: 'cat tests/orchestrator/script-generator.test.ts',
      captureOutput: true,
      failOnError: true,
    })
    .step('read-launcher-tests', {
      type: 'deterministic',
      dependsOn: ['install-deps'],
      command: 'cat tests/orchestrator/launcher.test.ts',
      captureOutput: true,
      failOnError: true,
    })
    .step('read-workflow-store-tests', {
      type: 'deterministic',
      dependsOn: ['install-deps'],
      command: 'cat tests/orchestrator/workflow-store.test.ts',
      captureOutput: true,
      failOnError: true,
    })
    .step('read-auth-token-tests', {
      type: 'deterministic',
      dependsOn: ['install-deps'],
      command: 'cat tests/orchestrator/auth-token-lifecycle.test.ts',
      captureOutput: true,
      failOnError: true,
    })
    .step('read-pglite-helper', {
      type: 'deterministic',
      dependsOn: ['install-deps'],
      command: 'cat tests/orchestrator/helpers/pglite-db.ts',
      captureOutput: true,
      failOnError: true,
    })
    .step('read-sst-config', {
      type: 'deterministic',
      dependsOn: ['install-deps'],
      command: 'cat sst.config.ts',
      captureOutput: true,
      failOnError: true,
    })
    .step('read-credential-refresh-infra', {
      type: 'deterministic',
      dependsOn: ['install-deps'],
      command: 'cat infra/credential-refresh.ts',
      captureOutput: true,
      failOnError: true,
    })

    // ─── Phase 2: Plan ──────────────────────────────────────────────────
    // Plan content is pre-authored at workflows/plans/fix-bootstrap-startup-crash-reporting.md
    // (sourced from an earlier successful planner run). We skip re-planning
    // because the agent step was flaky — it printed "STEP COMPLETE" without
    // actually writing PLAN.md, burning retries and stalling on npx trail
    // zombies. If the spec changes meaningfully, regenerate the plan file or
    // restore the agent step.
    .step('plan', {
      type: 'deterministic',
      dependsOn: [
        'read-spec',
        'read-script-generator',
        'read-launcher',
        'read-callback-route',
        'read-workflow-store',
        'read-api-token-store',
        'read-credential-sweep',
        'read-script-generator-tests',
        'read-launcher-tests',
        'read-workflow-store-tests',
        'read-auth-token-tests',
        'read-pglite-helper',
        'read-sst-config',
        'read-credential-refresh-infra',
      ],
      command:
        'cp workflows/plans/fix-bootstrap-startup-crash-reporting.md PLAN.md',
      captureOutput: true,
      failOnError: true,
    })
    .step('read-plan', {
      type: 'deterministic',
      dependsOn: ['plan'],
      command: 'cat PLAN.md',
      captureOutput: true,
      failOnError: true,
    })

    // ─── Phase 3: Failing tests first ───────────────────────────────────
    .step('author-failing-tests', {
      agent: 'test-author',
      dependsOn: ['read-plan'],
      task: `Using PLAN.md, author failing regression tests BEFORE implementation.

PLAN:
{{steps.read-plan.output}}

Requirements:
  - Create tests/orchestrator/bootstrap-wrapper.test.ts
  - Create tests/orchestrator/stuck-run-reaper.test.ts
  - If the plan needs a tiny focused patch to existing launcher/script-generator
    tests, keep it minimal and only for real interface changes.
  - Tests must be runnable under node:test via tsx.
  - They should fail now for the right reason: missing bootstrap wrapper support,
    missing dual-file upload support, missing reaper implementation, etc.
  - For the reaper test, use the existing PGlite helper pattern or a narrowly
    scoped equivalent. Model the real workflow_runs and api token session shape;
    do not use fake shell scripts.

Do NOT implement production code in this step.`,
      verification: { type: 'file_exists', value: 'tests/orchestrator/stuck-run-reaper.test.ts' },
      retries: 2,
    })
    .step('verify-failing-test-files', {
      type: 'deterministic',
      dependsOn: ['author-failing-tests'],
      command: 'test -f tests/orchestrator/bootstrap-wrapper.test.ts && test -f tests/orchestrator/stuck-run-reaper.test.ts && echo TEST_FILES_READY',
      captureOutput: true,
      failOnError: true,
    })
    .step('run-failing-tests-first', {
      type: 'deterministic',
      dependsOn: ['verify-failing-test-files'],
      command: 'npx tsx --test tests/orchestrator/bootstrap-wrapper.test.ts tests/orchestrator/stuck-run-reaper.test.ts 2>&1 | tail -80',
      captureOutput: true,
      failOnError: false,
    })

    // ─── Phase 4: Parallel implementation waves ────────────────────────
    .step('implement-bootstrap-wave', {
      agent: 'bootstrap-impl',
      dependsOn: ['author-failing-tests'],
      task: `Implement only the bootstrap-side portion of PLAN.md.

PLAN:
{{steps.read-plan.output}}

Your ownership:
  - packages/core/src/bootstrap/script-generator.ts
  - packages/core/src/bootstrap/launcher.ts
  - tests/orchestrator/bootstrap-wrapper.test.ts if small assertion fixes are
    required after the real interface lands
  - optional focused probe workflow only if the plan explicitly calls for one

Rules:
  - Keep scope to the bootstrap wrapper + bootstrap-inner generation and the
    launcher upload / node invocation path.
  - The outer wrapper must import only node:* or built-in globals.
  - Preserve current behavior when CALLBACK_* env vars are absent.
  - Do not touch the reaper or SST infra files in this step.
  - Do not commit.

After edits, ensure build:core still succeeds before you finish.`,
      verification: { type: 'exit_code' },
      retries: 2,
    })
    .step('implement-reaper-wave', {
      agent: 'reaper-impl',
      dependsOn: ['author-failing-tests'],
      task: `Implement only the reaper-side portion of PLAN.md.

PLAN:
{{steps.read-plan.output}}

Your ownership:
  - new handler module for stuck pending runs
  - SST cron wiring following this repo's actual infra convention
  - any timeout env plumbing required by the plan
  - tests/orchestrator/stuck-run-reaper.test.ts if small assertion fixes are
    required after the real implementation lands

Rules:
  - Respect package boundaries. If you need DB access from packages/core, follow
    the credential-sweep linked-resource DB style instead of importing Next/web
    modules.
  - Cleanup must mirror the callback success/failure path as closely as the plan
    justifies: workflow status flip, token/session revoke, and any run cleanup
    that is actually available from this package boundary.
  - Keep the timeout default at 5 minutes unless the plan cites a stronger reason.
  - Do not touch bootstrap generation in this step.
  - Do not commit.

After edits, ensure build:core still succeeds before you finish.`,
      verification: { type: 'exit_code' },
      retries: 2,
    })
    .step('verify-bootstrap-wave', {
      type: 'deterministic',
      dependsOn: ['implement-bootstrap-wave'],
      command: [
        '[ -n "$(git status --porcelain -- packages/core/src/bootstrap/script-generator.ts packages/core/src/bootstrap/launcher.ts)" ] || { echo "BOOTSTRAP_WAVE_NOT_MODIFIED"; exit 1; }',
        'grep -q "bootstrap-inner.mjs" packages/core/src/bootstrap/script-generator.ts',
        'grep -q "bootstrap.mjs" packages/core/src/bootstrap/launcher.ts',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })
    .step('verify-reaper-wave', {
      type: 'deterministic',
      dependsOn: ['implement-reaper-wave'],
      command: [
        'test -f packages/core/src/sync/stuck-run-reaper.ts',
        '[ -n "$(git status --porcelain -- packages/core/src/sync/stuck-run-reaper.ts sst.config.ts infra)" ] || { echo "REAPER_WAVE_NOT_MODIFIED"; exit 1; }',
        'grep -R -n -E "STUCK_RUN_TIMEOUT_MINUTES|bootstrap_timeout" packages/core/src/sync infra sst.config.ts >/dev/null',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    // ─── Phase 5: Targeted test-fix-rerun ───────────────────────────────
    .step('run-targeted-gates-first', {
      type: 'deterministic',
      dependsOn: ['verify-bootstrap-wave', 'verify-reaper-wave'],
      command: [
        'npm run build:core',
        'npx tsx --test tests/orchestrator/bootstrap-wrapper.test.ts tests/orchestrator/stuck-run-reaper.test.ts tests/orchestrator/script-generator.test.ts tests/orchestrator/launcher.test.ts tests/orchestrator/workflow-store.test.ts tests/orchestrator/auth-token-lifecycle.test.ts 2>&1 | tail -120',
      ].join(' && '),
      captureOutput: true,
      failOnError: false,
    })
    .step('fix-targeted-gates', {
      agent: 'test-fixer',
      dependsOn: ['run-targeted-gates-first'],
      task: `Read the targeted gate output and fix the correct side until it is green.

Output:
{{steps.run-targeted-gates-first.output}}

Loop:
  1. npm run build:core
  2. npx tsx --test tests/orchestrator/bootstrap-wrapper.test.ts tests/orchestrator/stuck-run-reaper.test.ts tests/orchestrator/script-generator.test.ts tests/orchestrator/launcher.test.ts tests/orchestrator/workflow-store.test.ts tests/orchestrator/auth-token-lifecycle.test.ts
  3. If failures remain, fix the source for regressions and the test only when
     the assertion is genuinely wrong.
  4. Repeat until all pass.

When done, write IMPL_SUMMARY.md listing each changed file with a one-line note.
Do not commit.`,
      verification: { type: 'file_exists', value: 'IMPL_SUMMARY.md' },
      retries: 2,
    })
    .step('run-targeted-gates-final', {
      type: 'deterministic',
      dependsOn: ['fix-targeted-gates'],
      command: [
        'npm run build:core',
        'npx tsx --test tests/orchestrator/bootstrap-wrapper.test.ts tests/orchestrator/stuck-run-reaper.test.ts tests/orchestrator/script-generator.test.ts tests/orchestrator/launcher.test.ts tests/orchestrator/workflow-store.test.ts tests/orchestrator/auth-token-lifecycle.test.ts 2>&1 | tail -80',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    // ─── Phase 6: Full regression + typecheck ───────────────────────────
    .step('run-typecheck-first', {
      type: 'deterministic',
      dependsOn: ['run-targeted-gates-final'],
      command: 'npm run typecheck 2>&1 | tail -80',
      captureOutput: true,
      failOnError: false,
    })
    .step('run-full-suite-first', {
      type: 'deterministic',
      dependsOn: ['run-targeted-gates-final'],
      command: 'npm run test 2>&1 | tail -100',
      captureOutput: true,
      failOnError: false,
    })
    .step('fix-regressions-and-typecheck', {
      agent: 'test-fixer',
      dependsOn: ['run-typecheck-first', 'run-full-suite-first'],
      task: `Fix any remaining typecheck or regression failures.

Typecheck output:
{{steps.run-typecheck-first.output}}

Full test output:
{{steps.run-full-suite-first.output}}

Loop until both are green:
  - npm run typecheck
  - npm run test

Common failure modes to watch for:
  - bootstrap script generator tests expecting the old return shape
  - launcher upload tests assuming only bootstrap.mjs exists
  - reaper SQL shape drifting from workflow_runs / api token schema
  - SST import / infra file not actually imported from sst.config.ts

Update IMPL_SUMMARY.md if you touch more files. Do not commit.`,
      verification: { type: 'exit_code' },
      retries: 2,
    })
    .step('run-typecheck-final', {
      type: 'deterministic',
      dependsOn: ['fix-regressions-and-typecheck'],
      command: 'npm run typecheck 2>&1 | tail -60',
      captureOutput: true,
      failOnError: true,
    })
    .step('run-full-suite-final', {
      type: 'deterministic',
      dependsOn: ['fix-regressions-and-typecheck'],
      command: 'npm run test 2>&1 | tail -80',
      captureOutput: true,
      failOnError: true,
    })

    // ─── Phase 7: Collect diff ──────────────────────────────────────────
    .step('capture-diff', {
      type: 'deterministic',
      dependsOn: ['run-typecheck-final', 'run-full-suite-final'],
      command: 'git diff HEAD --stat && echo --- FULL DIFF --- && git diff HEAD',
      captureOutput: true,
      failOnError: true,
    })

    // ─── Phase 8: Final review ───────────────────────────────────────────
    .step('final-review', {
      agent: 'final-reviewer',
      dependsOn: ['capture-diff'],
      task: `Perform the final end-to-end review.

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
  - [PASS|FAIL] bootstrap wrapper catches startup crashes before Reporter exists
  - [PASS|FAIL] static-import failures reach callback with status='failed'
  - [PASS|FAIL] launcher writes/starts the wrapper correctly
  - [PASS|FAIL] stuck pending runs are reaped after the configured timeout
  - [PASS|FAIL] cleanup behavior is justified and implemented safely
  - [PASS|FAIL] repo conventions / package boundaries are respected
  - [PASS|FAIL] failing tests first + final regression gates were satisfied
  - [PASS|FAIL] no unrelated churn

  ## Findings
  1. <file>:<line> — <specific issue>
  2. ...

Be strict. Do not edit code.`,
      verification: { type: 'file_exists', value: 'REVIEW.md' },
    })
    .step('gate-on-final-review', {
      type: 'deterministic',
      dependsOn: ['final-review'],
      command: 'grep -q "VERDICT: APPROVE" REVIEW.md',
      failOnError: true,
    })

    // ─── Phase 9: Commit + PR ───────────────────────────────────────────
    .step('commit-and-pr', {
      type: 'deterministic',
      dependsOn: ['gate-on-final-review'],
      command: [
        'rm -f PLAN.md IMPL_SUMMARY.md PEER_REVIEW.md REVIEW.md',
        'git add -A',
        'git diff --cached --quiet && { echo "nothing to commit"; exit 1; } || true',
        'git commit -m "fix(bootstrap): report startup crashes and reap stuck runs"',
        'git push -u origin HEAD',
        'gh pr create --draft --repo AgentWorkforce/cloud --base main --head ' + BRANCH + ' --title "fix(bootstrap): report startup crashes and reap stuck runs" --body "## Summary\n- add a node-only bootstrap wrapper that reports startup crashes before Reporter exists\n- split bootstrap generation/upload into wrapper + bootstrap-inner files\n- add a stuck pending run reaper with timeout-based failure + cleanup\n- add regression tests for wrapper generation/reporting and pending-run reaping\n\n## Source spec\n- specs/bootstrap-startup-crash-reporting.md (from PR #275)\n\nGenerated by workflows/fix-bootstrap-startup-crash-reporting.ts using the AgentWorkforce relay workflow + 80-to-100 pattern."',
      ].join(' && '),
      failOnError: true,
    })

    .onError('fail-fast')
    .run({ cwd: process.cwd() });

  console.log('Workflow status:', result.status);
  console.log(`Branch: ${BRANCH}`);
  console.log('Spec source: specs/bootstrap-startup-crash-reporting.md');
  console.log('After the implementation PR lands, manually run the synthetic');
  console.log('startup-crash and callback-unreachable validations from the spec.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
