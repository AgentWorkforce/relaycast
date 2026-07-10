/**
 * Master: fix both cloud-bootstrap bugs in one PR, one cloud run.
 * ============================================================================
 *
 * Combines the two orthogonal bootstrap fixes so you only pay for
 * one plan/implement/review cycle and one snapshot rebuild:
 *
 *   Bug 1 (per-agent sandbox)
 *     Agents spawned from standalone TS workflows share the orchestrator
 *     sandbox — see workflows/fix-per-agent-sandbox.ts for the focused
 *     version.
 *
 *   Bug 2 (cloud sync empty)
 *     `agent-relay cloud sync` returns "No changes to sync" even when
 *     agents wrote files, because the relayfile-enabled bootstrap branch
 *     only captures workspace state (which the workspace ACL keeps
 *     empty). See workflows/fix-cloud-sync-patch.ts for the focused
 *     version.
 *
 * Pick this workflow when you want one PR that lands both fixes.
 * Pick the individual workflows when you want them reviewed separately.
 *
 * Runtime context
 *   Run with: `agent-relay cloud run workflows/fix-cloud-bootstrap-master.ts`
 *   Runs in a Daytona orchestrator sandbox with the cloud repo at /project.
 *
 * Pattern
 *   writing-agent-relay-workflows: claude plans both fixes together →
 *                                  codex implements both → claude reviews
 *                                  both → one commit + one PR.
 *   relay-80-100-workflow:         test-fix-rerun, combined build gate,
 *                                  combined regression gate, deterministic
 *                                  verdict gate before shipping.
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

const BRANCH = 'fix/cloud-bootstrap-per-agent-sandbox-and-sync';
const CHANNEL = 'wf-fix-cloud-bootstrap-master';

async function main() {
  const baseWf = workflow('fix-cloud-bootstrap-master')
    .description(
      'Combined fix for both cloud-bootstrap bugs — per-agent sandbox wiring + cloud-sync patch capture — in one PR. claude plan → codex implement → claude review → PR.',
    )
    .pattern('dag')
    .channel(CHANNEL)
    .maxConcurrency(3)
    .timeout(5_400_000) // 90 min — combined workload

    .agent('planner', {
      cli: 'claude',
      model: ClaudeModels.OPUS,
      role: 'Architect — plans both fixes together and defines both acceptance contracts.',
      retries: 1,
    })
    .agent('implementer', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      role: 'Implements both fixes; runs the test-fix-rerun loop until build:core + orchestrator:test cover everything.',
      retries: 2,
    })
    .agent('reviewer', {
      cli: 'claude',
      model: ClaudeModels.OPUS,
      role: 'Strict reviewer — checks BOTH acceptance checklists independently. VERDICT: APPROVE requires all items PASS.',
      retries: 1,
    });

  // ─── Phase 0: Setup (shared helper) ─────────────────────────────────
  const wf = applyCloudRepoSetup(baseWf, {
    branch: BRANCH,
    committerName: 'Cloud Bootstrap Fix Bot',
  });

  const result = await wf
    // ─── Phase 1: Combined plan ────────────────────────────────────────
    .step('plan', {
      agent: 'planner',
      dependsOn: ['install-deps'],
      task: `Plan both cloud-bootstrap fixes in a single PLAN.md at the repo root. Two acceptance contracts, two fix sections, one coherent plan.

════════════════════════════════════════════════════════════════════════
FIX 1 — per-agent Daytona sandbox for standalone TS runs
════════════════════════════════════════════════════════════════════════

Problem
  Agents spawned from a standalone TS workflow (no \`export const config\`)
  share the orchestrator sandbox instead of getting per-agent sandboxes.

Read
  packages/core/src/bootstrap/script-generator.ts
    — the hasConfigExport=true branch (~line 731): constructs
      WorkflowRunner with { executor, processBackend: executor }.
    — the hasConfigExport=false fallback (~line 813): shells out via
      execFileSync('bun', ['run', workflowFile], ...). The child
      process creates its OWN WorkflowRunner with NO executor.
  packages/core/src/executor/executor.ts — SandboxedStepExecutor.
  packages/core/src/runtime/daytona.ts — DaytonaRuntime.launch().
  packages/core/src/bootstrap/launcher.ts — how orchestrator env is
    assembled (DAYTONA_API_KEY, DAYTONA_SANDBOX_ID).

Fix shape (plan recommends one of):
  A) Bootstrap writes a wrapper .mjs that imports the workflow file,
     constructs the cloud executor when DAYTONA_SANDBOX_ID is set,
     monkey-patches WorkflowBuilder.run to merge in
     { executor, processBackend }, then invokes the workflow.
  B) Require the exported symbol shape (main/workflow) and call it
     directly from bootstrap.
  C) Remove the fallback; require export const config. Rejected —
     breaks backward compat.

Acceptance contract
  After the fix, \`agent-relay cloud run workflows/hi-interactive.ts\`
  results in each agent seeing a distinct DAYTONA_SANDBOX_ID. Locally
  (no DAYTONA_SANDBOX_ID), behavior is unchanged.

Probe
  Create workflows/e2e-per-agent-sandbox.ts — 2 interactive agents
  each write \`echo SANDBOX_ID=\\$DAYTONA_SANDBOX_ID > sandbox-id-<cli>.txt\`,
  a final deterministic step asserts both files exist, both IDs are
  non-empty, and the IDs differ.

════════════════════════════════════════════════════════════════════════
FIX 2 — agent-written files must come back via \`cloud sync\`
════════════════════════════════════════════════════════════════════════

Problem
  Run 5c005a15-889b-42de-9816-252cacf24c59: all three hi-interactive
  agents wrote intro-<cli>.md (verify-intros confirmed), but
  \`agent-relay cloud sync\` returned empty.

Read
  packages/core/src/bootstrap/script-generator.ts
    — !relayfileEnabled branch: baseline manifest at start, diff at
      end → produces /tmp/changes.patch, uploads to S3. This path
      works correctly.
    — relayfileEnabled branch: stops mount, flushes once, calls
      uploadRelayfilePatch which GETs /fs/export?format=patch from
      the workspace. This path only sees workspace state, and the
      workspace is empty because the ACL denies writes and
      relayfile-mount (v0.2.2+ via AgentWorkforce/relayfile#50)
      preserves local files without pushing.

Fix shape
  A) Unify: always build the baseline manifest at start and always
     compute + upload a local-manifest-diff patch at end. Workspace
     patch becomes supplementary or unused. Simplest.
  B) Extend: keep the existing branches, add manifest capture to
     the relayfile path, combine workspace patch + local diff.
  C) Change relayfile-mount. Out of scope for cloud repo.

Acceptance contract
  After the fix, \`agent-relay cloud run workflows/e2e-cloud-sync.ts\`
  followed by \`agent-relay cloud sync <run-id>\` produces a non-empty
  patch that includes the test file the probe workflow wrote.

Probe
  Create workflows/e2e-cloud-sync.ts — writes a unique
  timestamped file and exits. After the fix, \`cloud sync\` returns
  the file.

════════════════════════════════════════════════════════════════════════
PLAN.md must cover
════════════════════════════════════════════════════════════════════════

  1. Evidence (file:line) for both bugs.
  2. Recommended fix shape + rationale for each fix.
  3. Exact file list per fix.
  4. Combined test plan:
     - tests/orchestrator/standalone-ts-executor.test.ts for fix 1
     - tests/orchestrator/<name>.test.ts for fix 2
     - workflows/e2e-per-agent-sandbox.ts
     - workflows/e2e-cloud-sync.ts
  5. Both acceptance contracts restated.
  6. Interaction notes: do the two fixes touch overlapping code? If
     yes (both modify script-generator.ts), specify the order to land
     edits to minimize merge pain.
  7. Residual risks (e.g. workspace ACL is still the root cause for
     empty workspace patches — we're working around it, not fixing it).

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

    // ─── Phase 2: Implement both ──────────────────────────────────────
    .step('implement', {
      agent: 'implementer',
      dependsOn: ['read-plan'],
      task: `Implement BOTH fixes in the plan below. Follow the order the plan specifies.

PLAN:
{{steps.read-plan.output}}

Guardrails:
  - Non-cloud local runs: behavior unchanged for both fixes.
  - hasConfigExport=true TS path: untouched.
  - YAML and Python paths: untouched.
  - No unrelated refactors or formatting churn.

After each meaningful edit:
  npm run build:core

Once all edits land, iterate test-fix-rerun until green:
  1. npm run build:core
  2. npm run orchestrator:test 2>&1 | tail -80
  3. fix the right side (source for regressions, test for bad asserts)
  4. repeat

Required new artifacts:
  - tests/orchestrator/standalone-ts-executor.test.ts — asserts the
    generated bootstrap branches on DAYTONA_SANDBOX_ID for the
    hasConfigExport=false path.
  - A second orchestrator test (name per plan) — asserts the generated
    bootstrap contains manifest-diff patch logic regardless of
    relayfileEnabled.
  - workflows/e2e-per-agent-sandbox.ts — probe for fix 1.
  - workflows/e2e-cloud-sync.ts — probe for fix 2.

Write IMPL_SUMMARY.md listing each changed file with a one-line note.
Separate sections for Fix 1 and Fix 2. No commits.`,
      verification: { type: 'file_exists', value: 'IMPL_SUMMARY.md' },
      retries: 2,
    })

    // ─── Phase 3: Test-fix-rerun ──────────────────────────────────────
    .step('run-orchestrator-tests', {
      type: 'deterministic',
      dependsOn: ['implement'],
      command: 'npm run build:core && npm run orchestrator:test 2>&1 | tail -100',
      captureOutput: true,
      failOnError: false,
    })

    .step('fix-test-failures', {
      agent: 'implementer',
      dependsOn: ['run-orchestrator-tests'],
      task: `Test output below. Fix any failures and re-run
\`npm run build:core && npm run orchestrator:test\` until green. If all
tests passed, do nothing.

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

    // ─── Phase 4: Verify both probes exist + dry-run ──────────────────
    .step('verify-probes-exist', {
      type: 'deterministic',
      dependsOn: ['run-orchestrator-tests-final'],
      command: [
        'set -e',
        'test -f workflows/e2e-per-agent-sandbox.ts',
        'test -f workflows/e2e-cloud-sync.ts',
        'echo BOTH_PROBES_PRESENT',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('dry-run-probes', {
      type: 'deterministic',
      dependsOn: ['verify-probes-exist'],
      command: [
        'set -e',
        'echo === probe 1 ===',
        'npx agent-relay run --dry-run workflows/e2e-per-agent-sandbox.ts 2>&1 | tail -15',
        'echo === probe 2 ===',
        'npx agent-relay run --dry-run workflows/e2e-cloud-sync.ts 2>&1 | tail -15',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    // ─── Phase 5: Diff + review ───────────────────────────────────────
    .step('capture-diff', {
      type: 'deterministic',
      dependsOn: ['dry-run-probes'],
      command: 'git diff HEAD --stat && echo --- FULL DIFF --- && git diff HEAD',
      captureOutput: true,
      failOnError: true,
    })

    .step('review', {
      agent: 'reviewer',
      dependsOn: ['capture-diff'],
      task: `Review BOTH fixes against PLAN.md + IMPL_SUMMARY.md. Diff:

{{steps.capture-diff.output}}

Evaluate two acceptance checklists independently. Any FAIL on either
checklist = REQUEST_CHANGES.

## Fix 1 — per-agent Daytona sandbox
  [ ] Bootstrap wires per-agent sandbox executor when DAYTONA_SANDBOX_ID
      is set, for the hasConfigExport=false path.
  [ ] Local runs (no DAYTONA_SANDBOX_ID) are unchanged.
  [ ] hasConfigExport=true path untouched.
  [ ] New test tests/orchestrator/standalone-ts-executor.test.ts exists
      and exercises both env-set and env-unset branches.
  [ ] workflows/e2e-per-agent-sandbox.ts exists, dry-runs clean,
      asserts distinct non-empty DAYTONA_SANDBOX_IDs per agent.

## Fix 2 — cloud sync captures agent writes
  [ ] Relayfile-enabled bootstrap now captures the local-manifest diff
      (or equivalent per the plan).
  [ ] Non-relayfile bootstrap path is either unchanged or consistent
      with the new unified path — no output regression.
  [ ] New orchestrator test asserts the generated bootstrap contains
      the manifest-diff logic regardless of relayfileEnabled.
  [ ] workflows/e2e-cloud-sync.ts exists, dry-runs clean, writes a
      unique file so the user can verify \`cloud sync\` captures it.

## Overall
  [ ] YAML + Python paths untouched.
  [ ] No unrelated refactors.
  [ ] Both fixes land cleanly together — no merge hazards between them.
  [ ] orchestrator:test green (guaranteed by run-orchestrator-tests-final).

Write REVIEW.md at the repo root:

  VERDICT: APPROVE
  (or)
  VERDICT: REQUEST_CHANGES

  ## Fix 1 checklist
  - [PASS|FAIL] <item>
  ## Fix 2 checklist
  - [PASS|FAIL] <item>
  ## Overall
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

    // ─── Phase 6: Commit + PR (one combined PR) ───────────────────────
    .step('commit-and-pr', {
      type: 'deterministic',
      dependsOn: ['gate-on-verdict'],
      command: [
        'rm -f PLAN.md IMPL_SUMMARY.md REVIEW.md',
        'git add -A',
        'git diff --cached --quiet && { echo "nothing to commit"; exit 1; } || true',
        'git commit -m "fix(bootstrap): per-agent sandbox wiring + cloud-sync patch capture"',
        'git push -u origin HEAD',
        'gh pr create --title "fix(bootstrap): per-agent sandbox wiring + cloud-sync patch capture" --body "Two orthogonal cloud-bootstrap fixes landed together:\n\n**Fix 1** — Standalone TS cloud workflows (no \\`export const config\\`) now wire SandboxedStepExecutor when DAYTONA_SANDBOX_ID is set, so each agent gets its own Daytona sandbox instead of sharing the orchestrator sandbox.\n\n**Fix 2** — Relayfile-enabled bootstrap runs now capture a local-manifest diff at the end of the workflow, so \\`agent-relay cloud sync\\` returns agent-written files even when the workspace ACL keeps the workspace patch empty.\n\nBoth fixes have regression tests (tests/orchestrator/*.test.ts) and probe workflows (workflows/e2e-per-agent-sandbox.ts, workflows/e2e-cloud-sync.ts). Generated by workflows/fix-cloud-bootstrap-master.ts (claude plan → codex implement → test-fix-rerun → claude review)."',
      ].join(' && '),
      failOnError: true,
    })

    .onError('fail-fast')
    .run({ cwd: process.cwd() });

  console.log('Workflow status:', result.status);
  console.log(`Branch: ${BRANCH}`);
  console.log('');
  console.log('After PR merges + snapshot rebuild, run both probes to verify:');
  console.log('  agent-relay cloud run workflows/e2e-per-agent-sandbox.ts');
  console.log('  agent-relay cloud run workflows/e2e-cloud-sync.ts');
  console.log('  agent-relay cloud sync <e2e-cloud-sync-run-id>  # non-empty patch expected');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
