/**
 * Fix: files agents write inside per-agent Daytona sandboxes don't
 * propagate back to the orchestrator for downstream verify steps.
 * ============================================================================
 *
 * Runtime context
 *   Recommended: `agent-relay run workflows/fix-per-agent-file-propagation.ts`
 *   Run LOCALLY until cloud sync is reliable. This workflow touches
 *   executor + bootstrap plumbing that benefits from direct disk access
 *   for iteration speed.
 *
 * Pattern
 *   writing-agent-relay-workflows: claude plan → codex implement →
 *                                  claude review → commit + PR
 *   relay-80-100-workflow:         test-fix-rerun, build gate,
 *                                  regression gate, deterministic gate.
 *
 * Problem being fixed
 *   After cloud#224 enabled per-agent Daytona sandboxes for standalone
 *   TS workflows, agent deliverables (intro-<cli>.md, codegen output,
 *   etc.) stopped being visible to the orchestrator. Concrete failure
 *   from run 551e91f1-...:
 *     - Each agent ran in its own sandbox with its own /project.
 *     - Agent wrote intro-<cli>.md to its own sandbox filesystem.
 *     - verify-intros step ran in the orchestrator sandbox.
 *     - verify-intros looked for intro-<cli>.md in orchestrator /project
 *       → file not found → step FAILED.
 *
 *   Separately, agent writes don't round-trip to the caller via
 *   \`agent-relay cloud sync\` either — they never reach the relayfile
 *   workspace because the workspace ACL denies writes for the synced
 *   agent (relayfile#50 now preserves files locally, but "locally" is
 *   the per-agent sandbox, not the orchestrator).
 *
 * Design options (plan should evaluate)
 *   A) Post-step rsync: SandboxedStepExecutor copies per-agent sandbox
 *      changes back to the orchestrator's /project at step completion.
 *      Uses sandbox.fs.downloadFile or a tar-and-transfer loop.
 *      Pros: purely cloud-side, no relayfile/ACL changes needed.
 *      Cons: N/O(files) transfer cost; needs an "interesting files"
 *      heuristic or diff-based scope.
 *   B) Grant orchestrator fs:write on /project/**: relayfile workspace
 *      ACL change so the mount actually pushes per-agent writes. Then
 *      the orchestrator's mount sees them via workspace sync.
 *      Pros: workspace becomes source of truth, cloud sync works
 *      transitively.
 *      Cons: ACL policy change, security review, touches relayauth.
 *   C) Co-locate verify steps in per-agent sandboxes: change the
 *      workflow-runtime semantics so deterministic steps dependent on
 *      an agent step run in that agent's sandbox rather than the
 *      orchestrator.
 *      Pros: no data movement needed.
 *      Cons: sharp semantics change; breaks DAG steps that depend on
 *      multiple agents' outputs.
 *
 * Acceptance contract
 *   After the fix, running workflows/e2e-per-agent-sandbox.ts on cloud
 *   and then `agent-relay cloud sync <run-id>` returns the intro-<cli>.md
 *   files each agent wrote. And hi-interactive.ts's verify-intros step
 *   succeeds because all three intro files exist in the orchestrator's
 *   /project by the time verify runs.
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

const BRANCH = 'fix/per-agent-file-propagation';
const CHANNEL = 'wf-fix-per-agent-file-propagation';

async function main() {
  const baseWf = workflow('fix-per-agent-file-propagation')
    .description(
      'Propagate per-agent-sandbox file writes back to the orchestrator so verify-intros and cloud sync see agent deliverables. claude plan → codex implement → test-fix-rerun → claude review → PR.',
    )
    .pattern('dag')
    .channel(CHANNEL)
    .maxConcurrency(3)
    .timeout(3_600_000)

    .agent('planner', {
      cli: 'claude',
      model: ClaudeModels.OPUS,
      role: 'Architect — evaluates the three design options, recommends one with tradeoff analysis, specifies the fix shape.',
      retries: 1,
    })
    .agent('implementer', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      role: 'Implements the chosen option; iterates until build:core + orchestrator:test green.',
      retries: 2,
    })
    .agent('reviewer', {
      cli: 'claude',
      model: ClaudeModels.OPUS,
      role: 'Strict reviewer — verifies the chosen option is actually implemented, tests cover both local-run and cloud-executor paths.',
      retries: 1,
    });

  // ─── Phase 0: Setup (shared helper) ─────────────────────────────────
  const wf = applyCloudRepoSetup(baseWf, {
    branch: BRANCH,
    committerName: 'File Propagation Fix Bot',
  });

  const result = await wf
    // ─── Phase 1: Plan ─────────────────────────────────────────────────
    .step('plan', {
      agent: 'planner',
      dependsOn: ['install-deps'],
      task: `Produce a plan for propagating per-agent-sandbox file writes
back to the orchestrator sandbox. Write PLAN.md at the repo root.

Read these files first:

  packages/core/src/executor/executor.ts
      - SandboxedStepExecutor.executeAgentStep and the command build-up.
      - Existing per-agent setup: mountCloudAuthFile, opencode MCP wiring,
        credentials mounting.
      - runtime.destroy(handle) — per-agent sandbox lifecycle.

  packages/core/src/runtime/daytona.ts
      - DaytonaRuntime.downloadFile (if present), uploadFile, exec —
        the primitives available for file transfer.

  packages/core/src/bootstrap/script-generator.ts
      - The existing baseline-manifest + diff logic for local file
        changes (landed in cloud#224 fix #2). This captures ORCHESTRATOR
        /project changes; now we need the per-agent contributions to
        land in the orchestrator /project.

  packages/web/app/api/v1/workflows/runs/<runId>/sync/route.ts
      (or wherever cloud sync is implemented) — to confirm what gets
      shipped to the caller when they run \`agent-relay cloud sync\`.

Your PLAN.md must evaluate the three design options listed in the
workflow header comment (A post-step rsync, B ACL grant, C co-locate
verify). For each:
  - What changes concretely (file:line).
  - What it costs at runtime (transfer bytes, extra API calls, …).
  - What risks it takes on (security, semantics, observability).
  - Whether it requires changes in other repos (relayfile, relayauth).

Then recommend ONE option and justify. Likely Option A for this PR
because it's self-contained to the cloud repo — but argue the case.

The recommended plan section must cover:
  1. Exact new code location (probably a new private method on
     SandboxedStepExecutor, e.g. \`copyArtifactsToOrchestrator\`).
  2. What files to copy: probably files at the root of the per-agent
     sandbox's /project that were created or modified during the agent
     run. Use a baseline file listing captured BEFORE the agent runs,
     diff against final listing, copy the delta.
  3. Timing: copy must happen BEFORE runtime.destroy(handle) so the
     sandbox is still alive.
  4. Failure semantics: if copy fails (network blip, destroyed sandbox,
     etc.) log + continue — the workflow should not fail just because
     artifact propagation failed. Record a warning in the step output
     so the workflow author can see it happened.
  5. Orchestrator target: write the copied files into the orchestrator
     sandbox's /project (or the workflow's cwd). Collisions across
     agents writing the same filename: warn + pick the first, or
     namespace under \`.agent-relay/step-artifacts/<step-name>/\`.
  6. Test plan:
     - Unit: mock sandbox with predictable exec/download outputs; assert
       that executeAgentStep's post-step copy writes the delta to the
       orchestrator cwd.
     - Probe: workflows/e2e-per-agent-sandbox.ts should be extended or
       a new probe workflows/e2e-file-propagation.ts that writes a
       unique file per agent, and a final deterministic verify step
       asserts all files exist in the orchestrator /project.
  7. Acceptance contract:
     a) \`agent-relay cloud run workflows/e2e-file-propagation.ts\`
        succeeds with files visible to the verify step.
     b) \`agent-relay cloud sync <run-id>\` returns the agent-written
        files.
  8. Residual risks / deferred:
     - Large binary artifacts transfer cost — cap size, log if skipped.
     - Relayfile ACL as the root-cause workaround — B is still worth
       doing eventually; note the deferred item.

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
  - Don't regress the opencode MCP wiring (PR #115).
  - Don't regress the claude/codex MCP wiring if #B1 has landed.
  - Local agent-relay run: executor isn't exercised — no path change
    needed. Only the cloud orchestrator uses SandboxedStepExecutor.
  - Failure in file-propagation MUST NOT fail the step; log and continue.
    This is belt-and-suspenders — agents' task-success signal is
    authoritative.

After each meaningful edit:
  npm run build:core

Then iterate test-fix-rerun until clean:
  1. npm run build:core
  2. npm run orchestrator:test 2>&1 | tail -60
  3. fix the right side
  4. repeat

Required artifacts:
  - Unit test that exercises the post-step copy with a mock sandbox.
    Asserts new files written during the step end up in the workflow cwd.
    Asserts pre-existing files are NOT re-copied (baseline scoping).
  - Probe workflow: workflows/e2e-file-propagation.ts
    - Spawns 2 agents (preset: 'worker' for clean stdout)
    - Each writes a file with unique content to cwd
    - Final deterministic step lists files + cat's them to prove
      visibility in the orchestrator.

When green, write IMPL_SUMMARY.md listing changed files. No commits.`,
      verification: { type: 'file_exists', value: 'IMPL_SUMMARY.md' },
      retries: 2,
    })

    // ─── Phase 3: Test-fix-rerun ──────────────────────────────────────
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
      task: `Test output below. Fix failures and re-run
\`npm run build:core && npm run orchestrator:test\` until green. If all
passed, do nothing.

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

    // ─── Phase 4: Probe + dry-run ──────────────────────────────────────
    .step('verify-probe-exists', {
      type: 'deterministic',
      dependsOn: ['run-orchestrator-tests-final'],
      command: 'test -f workflows/e2e-file-propagation.ts && echo OK',
      captureOutput: true,
      failOnError: true,
    })

    .step('dry-run-probe', {
      type: 'deterministic',
      dependsOn: ['verify-probe-exists'],
      command:
        'npx agent-relay run --dry-run workflows/e2e-file-propagation.ts 2>&1 | tail -20',
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
      task: `Review against PLAN.md + IMPL_SUMMARY.md. Diff:

{{steps.capture-diff.output}}

Acceptance checklist — mark PASS or FAIL. Any FAIL = REQUEST_CHANGES.

  [ ] The plan recommended one of A/B/C and the implementation follows
      THAT recommendation. If the implementer deviated, PLAN.md and
      IMPL_SUMMARY.md must explain and the deviation must be defensible.
  [ ] The propagation path is scoped to per-agent-sandbox CHANGES —
      doesn't re-upload the full /project on every step.
  [ ] Copy failures don't fail the step. A warning is surfaced.
  [ ] Cross-agent filename collisions have a defined resolution.
  [ ] Unit tests cover:
      - new-file-during-step copied to orchestrator
      - pre-existing-file NOT re-copied
      - copy failure does not fail the step
  [ ] workflows/e2e-file-propagation.ts exists, dry-runs clean, writes
      and reads back agent-created files.
  [ ] Existing opencode MCP wiring untouched.
  [ ] If B1 (fix-per-agent-mcp-wiring) has already landed on main: its
      claude/codex wiring also untouched.
  [ ] No unrelated refactors.

Write REVIEW.md:
  VERDICT: APPROVE or REQUEST_CHANGES
  ## Checklist
  - [PASS|FAIL] <item>
  ## Findings
  <file>:<line> — <issue>

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
        'git commit -m "fix(executor): propagate per-agent sandbox file writes to orchestrator"',
        'git push -u origin HEAD',
        'gh pr create --title "fix(executor): propagate per-agent sandbox file writes to orchestrator" --body "After cloud#224 enabled per-agent Daytona sandboxes, agent-written files stayed trapped in their per-agent sandbox — invisible to the orchestrator verify steps, and invisible to \\`agent-relay cloud sync\\`. This adds a post-step propagation path in SandboxedStepExecutor that copies per-agent sandbox changes back to the orchestrator cwd before teardown. Failures in propagation are logged but do not fail the step. Generated by workflows/fix-per-agent-file-propagation.ts (claude plan → codex implement → test-fix-rerun → claude review)."',
      ].join(' && '),
      failOnError: true,
    })

    .onError('fail-fast')
    .run({ cwd: process.cwd() });

  console.log('Workflow status:', result.status);
  console.log(`Branch: ${BRANCH}`);
  console.log('');
  console.log('After PR merges + snapshot rebuild, verify:');
  console.log('  agent-relay cloud run workflows/e2e-file-propagation.ts');
  console.log('  agent-relay cloud sync <run-id>');
  console.log('  (agent-written files should appear in both the run log AND the sync)');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
