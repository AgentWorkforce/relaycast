/**
 * Fix: agent-written files never make it back via `agent-relay cloud sync`.
 * ============================================================================
 *
 * Runtime context
 *   Run with: `agent-relay cloud run workflows/fix-cloud-sync-patch.ts`
 *   Workflow runs in a Daytona orchestrator sandbox with the cloud repo
 *   mounted at /project.
 *
 * Pattern
 *   writing-agent-relay-workflows: claude plan → codex implement →
 *                                  claude review → commit + PR
 *   relay-80-100-workflow:         test-fix-rerun, build gate,
 *                                  regression gate, deterministic gate.
 *
 * Problem being fixed
 *   script-generator.ts patch-capture logic has two branches at run end:
 *     (a) if (!relayfileEnabled) — builds baseline manifest at start,
 *         diffs local FS at end, produces a git patch at
 *         /tmp/changes.patch, uploads to S3.
 *     (b) if (relayfileEnabled)  — stops mount, calls
 *         flushRelayfileMountOnce, then uploadRelayfilePatch which
 *         GETs /v1/workspaces/<id>/fs/export?format=patch.
 *
 *   The relayfile path captures *workspace* state. In cloud, the
 *   workspace ACL denies the orchestrator agent write scope on
 *   /project/** — relayfile-mount preserves the local copy (after
 *   AgentWorkforce/relayfile#50) but never pushes to workspace.
 *   Result: workspace patch is empty, `cloud sync` returns "No changes
 *   to sync — the workflow did not modify any files" even when agents
 *   wrote deliverables.
 *
 * Evidence
 *   Run 5c005a15-889b-42de-9816-252cacf24c59: all three hi-interactive
 *   agents wrote intro-<cli>.md (verify-intros cat'd them), but
 *   `agent-relay cloud sync` returned empty.
 *
 * Acceptance contract
 *   After the fix, a cloud workflow whose steps create files in the
 *   workflow cwd (e.g. hi-interactive.ts's intro-<cli>.md) returns a
 *   non-empty patch via `agent-relay cloud sync` even when the
 *   workspace ACL blocks writes.
 *
 * Tracing
 *   RUST_LOG for anyone running this locally and inspecting the broker.
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

const BRANCH = 'fix/cloud-sync-relayfile-patch';
const CHANNEL = 'wf-fix-cloud-sync-patch';

async function main() {
  const baseWf = workflow('fix-cloud-sync-patch')
    .description(
      'Capture a local-manifest diff in the relayfile-enabled bootstrap path so agent-written files come back via `cloud sync`. claude plan → codex implement → test-fix-rerun → claude review → PR.',
    )
    .pattern('dag')
    .channel(CHANNEL)
    .maxConcurrency(3)
    .timeout(3_600_000)

    .agent('planner', {
      cli: 'claude',
      model: ClaudeModels.OPUS,
      role: 'Architect — traces the bootstrap patch-capture paths and proposes the fix shape.',
      retries: 1,
    })
    .agent('implementer', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      role: 'Implements the plan; iterates until build:core + orchestrator:test green.',
      retries: 2,
    })
    .agent('reviewer', {
      cli: 'claude',
      model: ClaudeModels.OPUS,
      role: 'Strict reviewer. VERDICT: APPROVE only when every acceptance item passes.',
      retries: 1,
    });

  // ─── Phase 0: Setup (shared helper) ─────────────────────────────────
  const wf = applyCloudRepoSetup(baseWf, {
    branch: BRANCH,
    committerName: 'Cloud Sync Fix Bot',
  });

  const result = await wf
    // ─── Phase 1: Plan ─────────────────────────────────────────────────
    .step('plan', {
      agent: 'planner',
      dependsOn: ['install-deps'],
      task: `Produce a plan to fix the cloud-sync-returns-empty bug. Write PLAN.md at the repo root.

Read these files first:
  packages/core/src/bootstrap/script-generator.ts
      - The non-relayfile branch (search for "if (!relayfileEnabled)") which
        builds a baseline manifest at workflow start and diffs it against
        the live filesystem at the end, producing a git patch.
      - The relayfile branch which stops the mount daemon, flushes once,
        and calls uploadRelayfilePatch. Note: this branch does NOT build a
        baseline manifest.
      - The uploadRelayfilePatch function: it GETs /fs/export?format=patch
        from the relayfile workspace. This only sees files the workspace
        knows about — and workspace-ACL-denied writes never made it to
        the workspace (AgentWorkforce/relayfile#50 preserves them locally).
  packages/web/app/api/v1/workflows/runs/[runId]/sync/... (if exists, or
      the relevant sync route) — confirm what \`agent-relay cloud sync\`
      downloads. It fetches changes.patch from S3.
  scripts/create-snapshot.ts — current snapshot includes relayfile-mount
      v0.2.2 with the PR #50 preserve-local-on-write-denied behavior.

Your PLAN.md must cover:

  1. Evidence. file:line citations for:
     a) Where the non-relayfile path builds the baseline manifest (start).
     b) Where the non-relayfile path generates changes.patch from the
        manifest diff (end).
     c) Where the relayfile path does upload but skips manifest capture.
  2. Root cause: relayfile-enabled runs only capture workspace state, not
     local disk state. Workspace ACL denies writes, so workspace is
     empty even when local disk has files.
  3. Fix options with tradeoffs:
     A) Unify: always build the baseline manifest at start and always
        compute + upload the local-manifest-diff patch at end. The
        workspace patch becomes supplementary or gets dropped. Simplest.
     B) Keep two branches but add manifest capture to the relayfile
        branch. Combines workspace patch + local diff — if the workspace
        patch is non-empty, prefer it; otherwise fall back to the local
        diff. More code, maybe needed if relayfile ACL later grants write.
     C) Change relayfile-mount to push local-only files first. Out of
        scope for cloud repo; requires a relayfile change.
  4. Recommendation (likely A — unify to local manifest). Justify.
  5. Exact file list to change in packages/core/src/bootstrap/script-
     generator.ts. Identify which blocks move / are deleted / are added.
  6. Test plan:
     - Unit test: the generated bootstrap script contains the manifest
       capture + diff logic in BOTH branches (or unconditionally, if
       plan A).
     - Optional probe workflow extension: extend workflows/e2e-per-agent-
       sandbox.ts (if it exists) OR create workflows/e2e-cloud-sync.ts
       that writes a unique file and exits. User runs this, then runs
       \`agent-relay cloud sync <run-id>\` and sees the file.
  7. Acceptance contract: after \`agent-relay cloud run
     workflows/e2e-cloud-sync.ts\`, \`agent-relay cloud sync <run-id>\`
     produces a non-empty patch that includes the test file.
  8. Residual risks / out-of-scope items.

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
      task: `Implement the plan. Edit only files the plan names.

PLAN:
{{steps.read-plan.output}}

IMPORTANT:
  - Non-relayfile mode (local runs, e2e tests outside cloud) must keep
    working. The baseline manifest + diff path is already correct there;
    don't regress it.
  - hi-interactive-style TS cloud runs must start producing a non-empty
    changes.patch when they write files.
  - Do not touch unrelated code paths (YAML, Python, etc.) unless the
    plan explicitly requires it.

After each meaningful edit:
  npm run build:core

Then iterate test-fix-rerun until clean:
  1. npm run build:core
  2. npm run orchestrator:test 2>&1 | tail -60
  3. fix what's wrong (test or source)
  4. repeat

Add a test in tests/orchestrator/ that asserts the generated bootstrap
string contains the manifest-diff logic regardless of relayfileEnabled.

Create workflows/e2e-cloud-sync.ts per the plan — a small workflow
that writes a file with a timestamp and exits, so the user can verify
\`agent-relay cloud sync\` captures it after the fix.

When the build is clean and tests pass, write IMPL_SUMMARY.md at the
repo root listing each changed file with a one-line note. No commits.`,
      verification: { type: 'file_exists', value: 'IMPL_SUMMARY.md' },
      retries: 2,
    })

    // ─── Phase 3: Test-fix-rerun loop ──────────────────────────────────
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
      task: `Test output below. Fix any failures by editing the right side
(test OR source — regressions go in source, bad assertions go in test).
Re-run \`npm run build:core && npm run orchestrator:test\` until green.
If everything passed, do nothing.

{{steps.run-orchestrator-tests.output}}

No commits.`,
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

    // ─── Phase 4: Probe file + dry-run ─────────────────────────────────
    .step('verify-probe-file-exists', {
      type: 'deterministic',
      dependsOn: ['run-orchestrator-tests-final'],
      command: 'test -f workflows/e2e-cloud-sync.ts && echo OK',
      captureOutput: true,
      failOnError: true,
    })

    .step('dry-run-probe', {
      type: 'deterministic',
      dependsOn: ['verify-probe-file-exists'],
      command:
        'npx agent-relay run --dry-run workflows/e2e-cloud-sync.ts 2>&1 | tail -30',
      captureOutput: true,
      failOnError: true,
    })

    // ─── Phase 5: Diff + review ────────────────────────────────────────
    .step('capture-diff', {
      type: 'deterministic',
      dependsOn: ['dry-run-probe'],
      command: 'git diff HEAD --stat && echo --- FULL DIFF --- && git diff HEAD',
      captureOutput: true,
      failOnError: true,
    })

    .step('review', {
      agent: 'reviewer',
      dependsOn: ['capture-diff'],
      task: `Review against PLAN.md + IMPL_SUMMARY.md and the diff below.

DIFF:
{{steps.capture-diff.output}}

Acceptance checklist — mark each PASS or FAIL. Any FAIL = REQUEST_CHANGES.

  [ ] Relayfile branch now captures the local-manifest diff (or equivalent
      fix per the plan).
  [ ] Non-relayfile branch is still producing a patch correctly — the
      pre-existing baseline-manifest + diff logic untouched unless the
      plan is A (unify) and unification preserves the same output shape.
  [ ] Generated bootstrap string contains the manifest-diff logic
      regardless of relayfileEnabled (assertion in the new orchestrator
      test).
  [ ] workflows/e2e-cloud-sync.ts exists, is valid TS, dry-runs clean.
  [ ] No unrelated refactors or formatting churn.
  [ ] orchestrator:test is green on final run (the workflow's own
      run-orchestrator-tests-final step guarantees this, but re-confirm).
  [ ] The acceptance contract is testable: user can run
      \`agent-relay cloud run workflows/e2e-cloud-sync.ts\` and
      \`agent-relay cloud sync <run-id>\` locally after the snapshot
      rebuilds with this change.

Write REVIEW.md at the repo root:

  VERDICT: APPROVE
  (or)
  VERDICT: REQUEST_CHANGES

  ## Checklist
  - [PASS|FAIL] <item>
  ## Findings
  1. <file>:<line> — <issue>

Do NOT edit code.`,
      verification: { type: 'file_exists', value: 'REVIEW.md' },
    })

    .step('gate-on-verdict', {
      type: 'deterministic',
      dependsOn: ['review'],
      command: 'grep -q "VERDICT: APPROVE" REVIEW.md',
      failOnError: true,
    })

    // ─── Phase 6: Commit + PR ──────────────────────────────────────────
    .step('commit-and-pr', {
      type: 'deterministic',
      dependsOn: ['gate-on-verdict'],
      command: [
        'rm -f PLAN.md IMPL_SUMMARY.md REVIEW.md',
        'git add -A',
        'git diff --cached --quiet && { echo "nothing to commit"; exit 1; } || true',
        'git commit -m "fix(bootstrap): capture local-manifest diff in relayfile-enabled runs"',
        'git push -u origin HEAD',
        'gh pr create --title "fix(bootstrap): capture local-manifest diff in relayfile-enabled cloud runs" --body "Cloud workflows running with relayfile-mount never produced a non-empty changes.patch when the workspace ACL blocked writes. uploadRelayfilePatch only sees workspace state; AgentWorkforce/relayfile#50 preserves local files but never pushes them, so the patch stayed empty even when agents wrote deliverables. This extends the bootstrap to also build a baseline manifest + diff-against-local for relayfile-enabled runs, so \\`agent-relay cloud sync\\` returns real agent output. Generated by workflows/fix-cloud-sync-patch.ts (claude plan → codex implement → test-fix-rerun → claude review)."',
      ].join(' && '),
      failOnError: true,
    })

    .onError('fail-fast')
    .run({ cwd: process.cwd() });

  console.log('Workflow status:', result.status);
  console.log(`Branch: ${BRANCH}`);
  console.log('After PR merges: trigger Rebuild Daytona Snapshot, then run');
  console.log('  agent-relay cloud run workflows/e2e-cloud-sync.ts');
  console.log('  agent-relay cloud sync <run-id>');
  console.log('to verify the patch now contains the agent-written file.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
