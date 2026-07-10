/**
 * Fix: agents spawned from standalone TS workflows share the orchestrator
 * sandbox instead of getting per-agent Daytona sandboxes.
 * ============================================================================
 *
 * Runtime context
 *   Run with: `agent-relay cloud run workflows/fix-per-agent-sandbox.ts`
 *   The workflow itself runs inside a Daytona orchestrator sandbox with
 *   the cloud repo mounted at /project. Agents work on /project directly
 *   (no worktree — cloud sandbox is already isolated).
 *
 * Pattern
 *   writing-agent-relay-workflows: claude plan → codex implement →
 *                                  claude review → commit + PR
 *   relay-80-100-workflow:         test-fix-rerun loop, build gate,
 *                                  regression gate, deterministic
 *                                  final gate before commit.
 *
 * Problem being fixed
 *   script-generator.ts has two TS code paths:
 *     (a) hasConfigExport = true  → extracts tsConfig, constructs
 *         WorkflowRunner with { executor, processBackend: executor } →
 *         per-agent Daytona sandboxes via SandboxedStepExecutor.
 *     (b) hasConfigExport = false → execFileSync('bun', ['run', wf]) →
 *         the child process creates its OWN WorkflowRunner with NO
 *         executor → agents spawn as local subprocesses in the
 *         orchestrator sandbox. This is the bug.
 *
 *   Evidence from a recent traced run: every agent logged
 *   `Spawning owner "X" (cli: Y)` immediately followed by broker startup
 *   lines — i.e. they all share the broker/orchestrator process.
 *
 * Acceptance contract
 *   After the fix, running `agent-relay cloud run workflows/hi-interactive.ts`
 *   must result in each agent seeing a distinct DAYTONA_SANDBOX_ID.
 *   Locally (no DAYTONA_SANDBOX_ID), behavior is unchanged.
 *
 * Tracing
 *   RUST_LOG covers the broker if anyone wants to inspect mid-run.
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

const BRANCH = 'fix/per-agent-sandbox-standalone-ts';
const CHANNEL = 'wf-fix-per-agent-sandbox';

async function main() {
  const baseWf = workflow('fix-per-agent-sandbox-standalone-ts')
    .description(
      'Wire per-agent Daytona sandboxes for the standalone-TS bootstrap path. claude plans, codex implements with test-fix-rerun, claude reviews, deterministic gate commits + opens PR.',
    )
    .pattern('dag')
    .channel(CHANNEL)
    .maxConcurrency(3)
    .timeout(3_600_000)

    .agent('planner', {
      cli: 'claude',
      model: ClaudeModels.OPUS,
      role: 'Architect — traces the standalone-TS bootstrap code path, proposes the fix shape.',
      retries: 1,
    })
    .agent('implementer', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      role: 'Implements the plan; iterates until build:core + orchestrator:test both pass; writes regression tests.',
      retries: 2,
    })
    .agent('reviewer', {
      cli: 'claude',
      model: ClaudeModels.OPUS,
      role: 'Strict end-to-end reviewer. VERDICT: APPROVE only when every acceptance item passes.',
      retries: 1,
    });

  // ─── Phase 0: Setup (shared helper) ─────────────────────────────────
  const wf = applyCloudRepoSetup(baseWf, {
    branch: BRANCH,
    committerName: 'Per-Agent Sandbox Fix Bot',
    extraSetupCommands: ['ls packages/core/src/bootstrap/'],
  });

  const result = await wf
    // ─── Phase 1: Plan ─────────────────────────────────────────────────
    .step('plan', {
      agent: 'planner',
      dependsOn: ['install-deps'],
      task: `Produce a plan to fix the per-agent-sandbox bug for standalone TS workflow runs. Write PLAN.md at the repo root.

Read these files first:
  packages/core/src/bootstrap/script-generator.ts
      - Find the "hasConfigExport" branch (~line 731). Note how the
        "true" path constructs WorkflowRunner with
        { executor, processBackend: executor } and the "false" path
        shells out to "bun run workflowFile".
  packages/core/src/executor/executor.ts
      - SandboxedStepExecutor implementation.
      - How the executor is constructed (credentials, runtime, relayfile).
  packages/core/src/runtime/daytona.ts
      - DaytonaRuntime.launch() creates per-agent sandboxes.
  packages/core/src/runtime/types.ts
      - WorkflowRuntime / ProcessBackend interfaces.
  packages/core/src/bootstrap/launcher.ts
      - How orchestrator env is assembled (DAYTONA_API_KEY, DAYTONA_SANDBOX_ID).
  workflows/hi-interactive.ts (in this repo) as a reference for the
  standalone-TS shape.

Your PLAN.md must cover:

  1. Evidence. file:line citations for:
     a) The hasConfigExport=true branch (good path).
     b) The hasConfigExport=false fallback (bug path).
     c) Where the executor is currently constructed.
  2. Root cause, one paragraph.
  3. Fix options with tradeoffs:
     A) Bootstrap writes a wrapper .mjs that:
         - imports the workflow file as a module
         - if DAYTONA_SANDBOX_ID is set, constructs the cloud executor
         - monkey-patches WorkflowBuilder.run to merge { executor, processBackend }
         - invokes the original workflow
     B) Keep fallback but replace bun invocation with a bootstrap step that
        constructs WorkflowRunner directly from the exported symbols (require
        authors to export 'main' or 'workflow').
     C) Remove the standalone fallback; require export const config / default.
        Breaks backward compat; reject as too aggressive.
  4. Recommendation (likely A). Justify.
  5. Exact file list to change and the nature of each change.
  6. Test plan:
     - New unit test: assert the generated bootstrap (for a TS workflow
       without exported config) emits logic that checks DAYTONA_SANDBOX_ID
       and constructs the executor when set.
     - New e2e probe workflow at workflows/e2e-per-agent-sandbox.ts that
       spawns 2 agents (interactive claude + interactive codex), each
       writes DAYTONA_SANDBOX_ID to sandbox-id-<cli>.txt, and a final
       deterministic step asserts the two IDs are non-empty and distinct.
       Local dry-run should validate.
  7. Acceptance contract, re-stated: running the e2e probe on cloud must
     show each agent with a distinct DAYTONA_SANDBOX_ID. Locally, IDs are
     both empty/unset and the probe fails (expected).
  8. Residual risks / out-of-scope items (e.g. the workspace-ACL-blocks-
     cloud-sync issue is separate).

Do NOT edit source code in this step.`,
      verification: { type: 'file_exists', value: 'PLAN.md' },
    })

    .step('read-plan', {
      type: 'deterministic',
      dependsOn: ['plan'],
      command: 'cat PLAN.md',
      captureOutput: true,
      failOnError: true,
    })

    // ─── Phase 2: Implement ────────────────────────────────────────────
    .step('implement', {
      agent: 'implementer',
      dependsOn: ['read-plan'],
      task: `Implement the plan below. Edit only files the plan names. Do not refactor unrelated code.

PLAN:
{{steps.read-plan.output}}

IMPORTANT:
  - Preserve local agent-relay run behavior: when DAYTONA_SANDBOX_ID is
    NOT set, the bootstrap / runner must behave exactly as before.
  - Preserve the hasConfigExport=true path: already works, do not regress.
  - Keep scope tight. Do not touch YAML path, Python path, or anything
    outside the standalone-TS path.

After each meaningful edit, run:
  npm run build:core

Once all edits land, iterate the test-fix-rerun loop until green:
  1. npm run build:core
  2. npm run orchestrator:test 2>&1 | tail -60
  3. fix failures (in tests OR source, whichever is wrong)
  4. repeat

Add a new test file tests/orchestrator/standalone-ts-executor.test.ts
that, at minimum, constructs the generated bootstrap string for a TS
workflow and asserts:
  - DAYTONA_SANDBOX_ID branch is present.
  - When that env is set, the generated code wires executor +
    processBackend into the workflow runner.
  - When it is NOT set, the generated code falls through to the
    pre-existing bun-run fallback.

Also create workflows/e2e-per-agent-sandbox.ts per the plan.

When everything builds and tests pass, write IMPL_SUMMARY.md listing each
changed file with a one-line note. Do not commit.`,
      verification: { type: 'file_exists', value: 'IMPL_SUMMARY.md' },
      retries: 2,
    })

    // ─── Phase 3: Test-fix-rerun loop (explicit gate, not just retries) ─
    .step('run-orchestrator-tests', {
      type: 'deterministic',
      dependsOn: ['implement'],
      command: 'npm run build:core && npm run orchestrator:test 2>&1 | tail -80',
      captureOutput: true,
      failOnError: false,
    })

    .step('fix-test-failures', {
      agent: 'implementer',
      dependsOn: ['run-orchestrator-tests'],
      task: `Check the orchestrator test output below. If every test passed,
do nothing. If there are failures:

{{steps.run-orchestrator-tests.output}}

  1. Read the failing test file(s) and the source they exercise.
  2. Decide whether the test or the source is wrong, and fix the correct
     side. Regression = source. Incorrect assertion = test.
  3. Re-run: npm run build:core && npm run orchestrator:test
  4. Repeat until all tests pass.

Do NOT commit.`,
      verification: { type: 'exit_code' },
      retries: 1,
    })

    .step('run-orchestrator-tests-final', {
      type: 'deterministic',
      dependsOn: ['fix-test-failures'],
      command: 'npm run build:core && npm run orchestrator:test 2>&1 | tail -40',
      captureOutput: true,
      failOnError: true,
    })

    // ─── Phase 4: Verify the e2e probe workflow is well-formed ─────────
    .step('verify-probe-file-exists', {
      type: 'deterministic',
      dependsOn: ['run-orchestrator-tests-final'],
      command: 'test -f workflows/e2e-per-agent-sandbox.ts && echo OK',
      captureOutput: true,
      failOnError: true,
    })

    .step('dry-run-probe', {
      type: 'deterministic',
      dependsOn: ['verify-probe-file-exists'],
      command:
        'npx agent-relay run --dry-run workflows/e2e-per-agent-sandbox.ts 2>&1 | tail -30',
      captureOutput: true,
      failOnError: true,
    })

    // ─── Phase 5: Collect diff + before/after evidence ────────────────
    .step('capture-diff', {
      type: 'deterministic',
      dependsOn: ['dry-run-probe'],
      command: 'git diff HEAD --stat && echo --- FULL DIFF --- && git diff HEAD',
      captureOutput: true,
      failOnError: true,
    })

    // ─── Phase 6: Review ──────────────────────────────────────────────
    .step('review', {
      agent: 'reviewer',
      dependsOn: ['capture-diff'],
      task: `Review the implementation against PLAN.md, IMPL_SUMMARY.md, and
the captured diff below.

DIFF:
{{steps.capture-diff.output}}

Acceptance checklist — mark each PASS or FAIL. Any FAIL = REQUEST_CHANGES.

  [ ] Evidence in PLAN.md cites the correct file:line for both code paths.
  [ ] Fix is gated on DAYTONA_SANDBOX_ID (or an equivalent cloud signal);
      local runs without that env var behave as before.
  [ ] hasConfigExport=true path is untouched (look for that branch — its
      code block should be identical to before).
  [ ] YAML and Python workflow paths are untouched.
  [ ] New test tests/orchestrator/standalone-ts-executor.test.ts exists
      and exercises both env-set and env-unset branches of the generated
      bootstrap string.
  [ ] workflows/e2e-per-agent-sandbox.ts exists, is valid TS that dry-runs,
      and asserts distinct non-empty DAYTONA_SANDBOX_ID values per agent.
  [ ] No unrelated refactors, renames, or formatting churn.
  [ ] No new runtime deps added unless the plan calls for them.

Write REVIEW.md at the repo root with this exact shape:

  VERDICT: APPROVE
  (or)
  VERDICT: REQUEST_CHANGES

  ## Checklist
  - [PASS|FAIL] <item 1>
  - [PASS|FAIL] <item 2>
  ...

  ## Findings
  1. <file>:<line> — <specific issue>
  2. ...

Be strict. Do NOT edit code.`,
      verification: { type: 'file_exists', value: 'REVIEW.md' },
    })

    // Literal match; BSD grep doesn't honor \s. Per the team's feedback
    // memory on verify-step greps.
    .step('gate-on-verdict', {
      type: 'deterministic',
      dependsOn: ['review'],
      command: 'grep -q "VERDICT: APPROVE" REVIEW.md',
      failOnError: true,
    })

    // ─── Phase 7: Commit + PR ─────────────────────────────────────────
    .step('commit-and-pr', {
      type: 'deterministic',
      dependsOn: ['gate-on-verdict'],
      command: [
        'rm -f PLAN.md IMPL_SUMMARY.md REVIEW.md',
        'git add -A',
        'git diff --cached --quiet && { echo "nothing to commit"; exit 1; } || true',
        'git commit -m "fix(bootstrap): wire per-agent sandboxes for standalone TS workflow runs"',
        'git push -u origin HEAD',
        'gh pr create --title "fix(bootstrap): wire per-agent sandboxes for standalone TS workflow runs" --body "Standalone-TS cloud workflows (no \\`export const config\\`) previously had every agent spawn as a subprocess inside the orchestrator sandbox. This wires SandboxedStepExecutor into the fallback bun-run path when DAYTONA_SANDBOX_ID is set, so each agent gets its own Daytona sandbox. Local runs without that env are unchanged. Generated by workflows/fix-per-agent-sandbox.ts (claude plan → codex implement → test-fix-rerun → claude review)."',
      ].join(' && '),
      failOnError: true,
    })

    .onError('fail-fast')
    .run({ cwd: process.cwd() });

  console.log('Workflow status:', result.status);
  console.log(`Branch: ${BRANCH}`);
  console.log('After PR merges: trigger Rebuild Daytona Snapshot, then run');
  console.log('  agent-relay cloud run workflows/e2e-per-agent-sandbox.ts');
  console.log('to verify each agent gets a distinct DAYTONA_SANDBOX_ID.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
