/**
 * runtime-all.ts
 *
 * Master executor for the runtime adapter rollout. One command runs the
 * entire sequence inside an isolated worktree so the caller's current
 * branch (and its uncommitted dirt) is never touched.
 *
 * Usage:
 *   # From the cloud repo root, on any branch, in any working-tree state:
 *   agent-relay run workflows/runtime-all.ts
 *
 *   # Optional — auto-open a PR when the rollout finishes:
 *   RUNTIME_ALL_OPEN_PR=1 agent-relay run workflows/runtime-all.ts
 *
 * What it does (all inside a fresh worktree at ../cloud-runtime-adapter-rollout):
 *
 *   1. Preflight — verify git state, confirm no conflicting worktree or branch
 *   2. Create worktree off origin/main on branch feat/runtime-adapter-rollout
 *   3. Copy the 6 runtime workflow files + specs + trail recovery into the worktree
 *      and commit them as the scaffolding baseline
 *   4. Run workflows/runtime-v1-interface.ts inside the worktree, commit the result
 *   5. Run workflows/runtime-v2-local.ts, commit
 *   6. Run workflows/runtime-v3-e2b.ts, commit
 *   7. Run workflows/runtime-v4-worker-dispatch.ts, commit
 *   8. Run workflows/runtime-v5-registry.ts, commit
 *   9. Run workflows/runtime-v6-worker-onboarding.ts, commit
 *  10. Push the branch
 *  11. (Optional) open a PR
 *  12. Print a final summary with commit log + review instructions
 *
 * Execution model: strictly sequential in a single worktree. Each sub-workflow
 * runs via nested `agent-relay run` inside a deterministic step; the next
 * sub-workflow sees the prior one's committed changes in the worktree.
 *
 * Recovery: if a sub-workflow fails, the master stops at that step. The worktree
 * and any commits made so far are preserved. To recover:
 *   cd ../cloud-runtime-adapter-rollout
 *   # inspect, fix, commit manually
 *   # then either continue with the remaining workflows manually, or reset:
 *   cd - && git worktree remove ../cloud-runtime-adapter-rollout --force
 *   git branch -D feat/runtime-adapter-rollout
 *   # then re-run this master from scratch
 *
 * Why sequential (not parallel waves): each sub-workflow's write allowlist
 * overlaps on packages/core/src/runtime/index.ts (all append exports there).
 * Parallel runs would collide on that file. Sequential-with-commits means each
 * workflow sees the prior one's exports and appends safely. Total runtime is
 * higher (~2 hours vs ~1 hour) but the merge story is clean.
 *
 * Prerequisite: the caller's current working directory must have the workflow
 * files (runtime-v1..v6 + runtime-all + specs) already present. The master
 * copies them from the caller's cwd into the worktree.
 */

import { workflow } from '@relayflows/core';

const WORKTREE = '../cloud-runtime-adapter-rollout';
const BRANCH = 'feat/runtime-adapter-rollout';
const PREPARE_WORKTREE_AGENT_RELAY = [
  'ORIGIN_ABS="$(pwd -P)"',
  '[ -d "$ORIGIN_ABS/node_modules/agent-relay" ] || { echo "FAIL: parent has no working node_modules/agent-relay"; exit 1; }',
  'cd "' + WORKTREE + '"',
  'rm -rf .agent-relay',
  'rm -rf ./node_modules/agent-relay',
  'cp -R "$ORIGIN_ABS/node_modules/agent-relay" ./node_modules/agent-relay',
  './node_modules/.bin/agent-relay --version >/dev/null 2>&1 || { echo "FAIL: worktree agent-relay bootstrap is not runnable"; exit 1; }',
];

async function main() {
  const result = await workflow('runtime-all')
    .description('Master executor — worktree + all six runtime adapter workflows')
    .pattern('dag')
    .channel('wf-runtime-all')
    .maxConcurrency(1)
    .timeout(7_200_000)

    // ═══════════════════════════════════════════════════════════════════
    // Phase 0 — Preflight
    // ═══════════════════════════════════════════════════════════════════

    .step('preflight', {
      type: 'deterministic',
      command: [
        'set -eu',
        '[ -d .git ] || { echo "FAIL: not a git repository"; exit 1; }',
        '[ -f workflows/runtime-v1-interface.ts ] || { echo "FAIL: workflows/runtime-v1-interface.ts not found in cwd"; exit 1; }',
        '[ -f workflows/runtime-v2-local.ts ] || { echo "FAIL: runtime-v2 missing"; exit 1; }',
        '[ -f workflows/runtime-v3-e2b.ts ] || { echo "FAIL: runtime-v3 missing"; exit 1; }',
        '[ -f workflows/runtime-v4-worker-dispatch.ts ] || { echo "FAIL: runtime-v4 missing"; exit 1; }',
        '[ -f workflows/runtime-v5-registry.ts ] || { echo "FAIL: runtime-v5 missing"; exit 1; }',
        '[ -f workflows/runtime-v6-worker-onboarding.ts ] || { echo "FAIL: runtime-v6 missing"; exit 1; }',
        '[ -d docs/runtimes/specs ] || { echo "FAIL: docs/runtimes/specs missing"; exit 1; }',
        '[ ! -d "' + WORKTREE + '" ] || { echo "FAIL: worktree path already exists at ' + WORKTREE + ' — remove it with git worktree remove or pick a different location"; exit 1; }',
        'git show-ref --verify --quiet refs/heads/' + BRANCH + ' && { echo "FAIL: branch ' + BRANCH + ' already exists — delete it with git branch -D ' + BRANCH + ' or pick a different branch name"; exit 1; } || true',
        'command -v git >/dev/null || { echo "FAIL: git not on PATH"; exit 1; }',
        'command -v npx >/dev/null || { echo "FAIL: npx not on PATH"; exit 1; }',
        'git fetch origin main --quiet || { echo "FAIL: git fetch origin main failed"; exit 1; }',
        'echo PREFLIGHT_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    // ═══════════════════════════════════════════════════════════════════
    // Phase 1 — Create worktree
    // ═══════════════════════════════════════════════════════════════════

    .step('create-worktree', {
      type: 'deterministic',
      dependsOn: ['preflight'],
      command: [
        'set -eu',
        'git worktree add -b ' + BRANCH + ' "' + WORKTREE + '" origin/main',
        'test -d "' + WORKTREE + '/.git" -o -f "' + WORKTREE + '/.git"',
        'echo "worktree created at ' + WORKTREE + ' on branch ' + BRANCH + '"',
        'echo WORKTREE_CREATED',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    // ═══════════════════════════════════════════════════════════════════
    // Phase 1.5 — Install an isolated node_modules in the worktree
    //
    // Agents inside the sub-workflows are free to edit dependencies and run
    // npm commands. A symlinked node_modules can be replaced by npm during
    // those installs, leaving the worktree with a partially different layout
    // than the parent checkout. Bootstrapping a real install in the worktree
    // is slower, but it keeps the mutable dependency graph isolated.
    //
    // We then overlay the parent checkout's known-good node_modules/agent-relay
    // package into the worktree. The published 3.2.15 tarball installs with a
    // broken internal @agent-relay/* resolution layout in fresh checkouts,
    // while the parent's already-working install has the correct package-local
    // symlinks. Refreshing that package in the worktree preserves isolation for
    // everything else while keeping nested `agent-relay run` invocations
    // runnable.
    // ═══════════════════════════════════════════════════════════════════

    .step('install-node-modules', {
      type: 'deterministic',
      dependsOn: ['create-worktree'],
      command: [
        'set -euo pipefail',
        'ORIGIN_ABS="$(pwd -P)"',
        'command -v node >/dev/null || { echo "FAIL: node not on PATH"; exit 1; }',
        'command -v npm >/dev/null || { echo "FAIL: npm not on PATH"; exit 1; }',
        '[ -d "$ORIGIN_ABS/node_modules/agent-relay" ] || { echo "FAIL: parent has no working node_modules/agent-relay"; exit 1; }',
        'cd "' + WORKTREE + '"',
        '[ -f package-lock.json ] || { echo "FAIL: worktree package-lock.json missing"; exit 1; }',
        'echo "=== Bootstrapping worktree node_modules with npm ci ==="',
        'npm ci --prefer-offline --no-audit --no-fund',
        'rm -rf ./node_modules/agent-relay',
        'cp -R "$ORIGIN_ABS/node_modules/agent-relay" ./node_modules/agent-relay',
        '[ -x ./node_modules/.bin/agent-relay ] || { echo "FAIL: npm ci completed but ./node_modules/.bin/agent-relay is missing"; exit 1; }',
        './node_modules/.bin/agent-relay --version >/dev/null 2>&1 || { echo "FAIL: installed agent-relay is not runnable inside the worktree"; exit 1; }',
        'echo NODE_MODULES_INSTALLED',
      ].join('\n'),
      captureOutput: true,
      failOnError: true,
    })

    // ═══════════════════════════════════════════════════════════════════
    // Phase 2 — Copy scaffolding into worktree and commit
    // ═══════════════════════════════════════════════════════════════════

    .step('copy-scaffolding', {
      type: 'deterministic',
      dependsOn: ['install-node-modules'],
      command: [
        'set -eu',
        'mkdir -p "' + WORKTREE + '/workflows"',
        'cp workflows/runtime-v1-interface.ts "' + WORKTREE + '/workflows/"',
        'cp workflows/runtime-v2-local.ts "' + WORKTREE + '/workflows/"',
        'cp workflows/runtime-v3-e2b.ts "' + WORKTREE + '/workflows/"',
        'cp workflows/runtime-v4-worker-dispatch.ts "' + WORKTREE + '/workflows/"',
        'cp workflows/runtime-v5-registry.ts "' + WORKTREE + '/workflows/"',
        'cp workflows/runtime-v6-worker-onboarding.ts "' + WORKTREE + '/workflows/"',
        'cp workflows/runtime-all.ts "' + WORKTREE + '/workflows/"',
        'mkdir -p "' + WORKTREE + '/docs/runtimes/specs"',
        'cp docs/runtimes/specs/byoi-runtime.md "' + WORKTREE + '/docs/runtimes/specs/"',
        'cp docs/runtimes/specs/freestyle-runtime.md "' + WORKTREE + '/docs/runtimes/specs/"',
        'cp docs/runtimes/specs/own-sandbox-runtime.md "' + WORKTREE + '/docs/runtimes/specs/"',
        'cp docs/runtimes/specs/worker-dispatch.md "' + WORKTREE + '/docs/runtimes/specs/"',
        '[ -f .trajectories/completed/2026-04/traj_d57fdf3cabcd.json ] && { mkdir -p "' + WORKTREE + '/.trajectories/completed/2026-04"; cp .trajectories/completed/2026-04/traj_d57fdf3cabcd.json "' + WORKTREE + '/.trajectories/completed/2026-04/"; } || true',
        'echo SCAFFOLDING_COPIED',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('commit-scaffolding', {
      type: 'deterministic',
      dependsOn: ['copy-scaffolding'],
      command: [
        'set -eu',
        'cd "' + WORKTREE + '"',
        'git add workflows/runtime-v1-interface.ts workflows/runtime-v2-local.ts workflows/runtime-v3-e2b.ts workflows/runtime-v4-worker-dispatch.ts workflows/runtime-v5-registry.ts workflows/runtime-v6-worker-onboarding.ts workflows/runtime-all.ts',
        'git add docs/runtimes/specs/byoi-runtime.md docs/runtimes/specs/freestyle-runtime.md docs/runtimes/specs/own-sandbox-runtime.md docs/runtimes/specs/worker-dispatch.md',
        '[ -f .trajectories/completed/2026-04/traj_d57fdf3cabcd.json ] && git add .trajectories/completed/2026-04/traj_d57fdf3cabcd.json || true',
        'git commit -m "chore: runtime adapter scaffolding — 6 workflows + 4 specs"',
        'echo SCAFFOLDING_COMMITTED',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    // ═══════════════════════════════════════════════════════════════════
    // Wave 1 — runtime-v1 (foundation: WorkflowRuntime interface)
    // ═══════════════════════════════════════════════════════════════════

    .step('run-v1', {
      type: 'deterministic',
      dependsOn: ['commit-scaffolding'],
      command: [
        'set -euo pipefail',
        ...PREPARE_WORKTREE_AGENT_RELAY,
        'echo "=== Running runtime-v1-interface ==="',
        './node_modules/.bin/agent-relay run workflows/runtime-v1-interface.ts 2>&1 | tee /tmp/runtime-all-v1.log',
        'grep -q "^Result: completed$" /tmp/runtime-all-v1.log || { echo "FAIL: runtime-v1 sub-workflow reported Result: failed (see /tmp/runtime-all-v1.log)"; exit 1; }',
      ].join('\n'),
      captureOutput: true,
      failOnError: true,
    })

    .step('commit-v1', {
      type: 'deterministic',
      dependsOn: ['run-v1'],
      command: [
        'set -eu',
        'cd "' + WORKTREE + '"',
        '[ -f packages/core/src/runtime/types.ts ] || { echo "FAIL: runtime-v1 did not create packages/core/src/runtime/types.ts"; exit 1; }',
        '[ -f packages/core/src/runtime/daytona.ts ] || { echo "FAIL: runtime-v1 did not create packages/core/src/runtime/daytona.ts"; exit 1; }',
        '[ -f packages/core/src/runtime/index.ts ] || { echo "FAIL: runtime-v1 did not create packages/core/src/runtime/index.ts"; exit 1; }',
        'grep -q "SandboxedStepExecutor" packages/core/src/executor/executor.ts || { echo "FAIL: runtime-v1 did not refactor executor.ts to SandboxedStepExecutor"; exit 1; }',
        'git add -A -- packages/core/src/runtime packages/core/src/executor/executor.ts packages/core/src/bootstrap/script-generator.ts',
        'git diff --cached --quiet && { echo "FAIL: no staged runtime/executor/bootstrap changes to commit"; exit 1; } || true',
        'git commit -m "feat: runtime v1 — extract WorkflowRuntime interface and wrap Daytona adapter"',
        'echo V1_COMMITTED',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    // ═══════════════════════════════════════════════════════════════════
    // Wave 2 — runtime-v2 through runtime-v5 (sequential; each depends on v1)
    // ═══════════════════════════════════════════════════════════════════

    .step('run-v2', {
      type: 'deterministic',
      dependsOn: ['commit-v1'],
      command: [
        'set -euo pipefail',
        ...PREPARE_WORKTREE_AGENT_RELAY,
        'echo "=== Running runtime-v2-local ==="',
        './node_modules/.bin/agent-relay run workflows/runtime-v2-local.ts 2>&1 | tee /tmp/runtime-all-v2.log',
        'grep -q "^Result: completed$" /tmp/runtime-all-v2.log || { echo "FAIL: runtime-v2 sub-workflow reported Result: failed (see /tmp/runtime-all-v2.log)"; exit 1; }',
      ].join('\n'),
      captureOutput: true,
      failOnError: true,
    })

    .step('commit-v2', {
      type: 'deterministic',
      dependsOn: ['run-v2'],
      command: [
        'set -eu',
        'cd "' + WORKTREE + '"',
        '[ -f packages/core/src/runtime/local.ts ] || { echo "FAIL: runtime-v2 did not create packages/core/src/runtime/local.ts"; exit 1; }',
        'grep -q "LocalRuntime" packages/core/src/runtime/index.ts || { echo "FAIL: runtime-v2 did not export LocalRuntime from index.ts"; exit 1; }',
        'git add -A -- packages/core/src/runtime',
        'git diff --cached --quiet && { echo "FAIL: no staged runtime changes to commit"; exit 1; } || true',
        'git commit -m "feat: runtime v2 — LocalRuntime adapter (child_process, no isolation)"',
        'echo V2_COMMITTED',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('run-v3', {
      type: 'deterministic',
      dependsOn: ['commit-v2'],
      command: [
        'set -euo pipefail',
        ...PREPARE_WORKTREE_AGENT_RELAY,
        'echo "=== Running runtime-v3-e2b ==="',
        './node_modules/.bin/agent-relay run workflows/runtime-v3-e2b.ts 2>&1 | tee /tmp/runtime-all-v3.log',
        'grep -q "^Result: completed$" /tmp/runtime-all-v3.log || { echo "FAIL: runtime-v3 sub-workflow reported Result: failed (see /tmp/runtime-all-v3.log)"; exit 1; }',
      ].join('\n'),
      captureOutput: true,
      failOnError: true,
    })

    .step('commit-v3', {
      type: 'deterministic',
      dependsOn: ['run-v3'],
      command: [
        'set -eu',
        'cd "' + WORKTREE + '"',
        '[ -f packages/core/src/runtime/e2b.ts ] || { echo "FAIL: runtime-v3 did not create packages/core/src/runtime/e2b.ts"; exit 1; }',
        '[ -f infra/e2b/template.json ] || { echo "FAIL: runtime-v3 did not create infra/e2b/template.json"; exit 1; }',
        '[ -f infra/e2b/README.md ] || { echo "FAIL: runtime-v3 did not create infra/e2b/README.md"; exit 1; }',
        'grep -q "E2BRuntime" packages/core/src/runtime/index.ts || { echo "FAIL: runtime-v3 did not export E2BRuntime"; exit 1; }',
        'git add -A -- packages/core/src/runtime infra/e2b packages/core/package.json',
        'git diff --cached --quiet && { echo "FAIL: no staged changes to commit"; exit 1; } || true',
        'git commit -m "feat: runtime v3 — E2BRuntime adapter + e2b template manifest"',
        'echo V3_COMMITTED',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('run-v4', {
      type: 'deterministic',
      dependsOn: ['commit-v3'],
      command: [
        'set -euo pipefail',
        ...PREPARE_WORKTREE_AGENT_RELAY,
        'echo "=== Running runtime-v4-worker-dispatch ==="',
        './node_modules/.bin/agent-relay run workflows/runtime-v4-worker-dispatch.ts 2>&1 | tee /tmp/runtime-all-v4.log',
        'grep -q "^Result: completed$" /tmp/runtime-all-v4.log || { echo "FAIL: runtime-v4 sub-workflow reported Result: failed (see /tmp/runtime-all-v4.log)"; exit 1; }',
      ].join('\n'),
      captureOutput: true,
      failOnError: true,
    })

    .step('commit-v4', {
      type: 'deterministic',
      dependsOn: ['run-v4'],
      command: [
        'set -eu',
        'cd "' + WORKTREE + '"',
        '[ -f packages/core/src/workers/registry.ts ] || { echo "FAIL: runtime-v4 did not create packages/core/src/workers/registry.ts"; exit 1; }',
        '[ -f packages/core/src/workers/dispatcher.ts ] || { echo "FAIL: runtime-v4 did not create packages/core/src/workers/dispatcher.ts"; exit 1; }',
        '[ -f packages/web/app/api/v1/workers/register/route.ts ] || { echo "FAIL: runtime-v4 did not create the workers register route"; exit 1; }',
        'git add -A -- packages/core/src/workers packages/web/app/api/v1/workers packages/web/lib/workers packages/web/drizzle/schema packages/web/drizzle/migrations packages/web/app/api/v1/workflows/run',
        'git diff --cached --quiet && { echo "FAIL: no staged changes to commit"; exit 1; } || true',
        'git commit -m "feat: runtime v4 — worker registry, dispatcher, API, launcher fork"',
        'echo V4_COMMITTED',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('run-v5', {
      type: 'deterministic',
      dependsOn: ['commit-v4'],
      command: [
        'set -euo pipefail',
        ...PREPARE_WORKTREE_AGENT_RELAY,
        'echo "=== Running runtime-v5-registry ==="',
        './node_modules/.bin/agent-relay run workflows/runtime-v5-registry.ts 2>&1 | tee /tmp/runtime-all-v5.log',
        'grep -q "^Result: completed$" /tmp/runtime-all-v5.log || { echo "FAIL: runtime-v5 sub-workflow reported Result: failed (see /tmp/runtime-all-v5.log)"; exit 1; }',
      ].join('\n'),
      captureOutput: true,
      failOnError: true,
    })

    .step('commit-v5', {
      type: 'deterministic',
      dependsOn: ['run-v5'],
      command: [
        'set -eu',
        'cd "' + WORKTREE + '"',
        '[ -f packages/core/src/runtime/registry.ts ] || { echo "FAIL: runtime-v5 did not create packages/core/src/runtime/registry.ts"; exit 1; }',
        '[ -f packages/core/src/runtime/descriptor.ts ] || { echo "FAIL: runtime-v5 did not create packages/core/src/runtime/descriptor.ts"; exit 1; }',
        '[ -f scripts/list-runtimes.ts ] || { echo "FAIL: runtime-v5 did not create scripts/list-runtimes.ts"; exit 1; }',
        'git add -A -- packages/core/src/runtime scripts/list-runtimes.ts',
        'git diff --cached --quiet && { echo "FAIL: no staged changes to commit"; exit 1; } || true',
        'git commit -m "feat: runtime v5 — RuntimeRegistry and list-runtimes script"',
        'echo V5_COMMITTED',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    // ═══════════════════════════════════════════════════════════════════
    // Wave 3 — runtime-v6 (worker onboarding UI, depends on v4)
    // ═══════════════════════════════════════════════════════════════════

    .step('run-v6', {
      type: 'deterministic',
      dependsOn: ['commit-v5'],
      command: [
        'set -euo pipefail',
        ...PREPARE_WORKTREE_AGENT_RELAY,
        'echo "=== Running runtime-v6-worker-onboarding ==="',
        './node_modules/.bin/agent-relay run workflows/runtime-v6-worker-onboarding.ts 2>&1 | tee /tmp/runtime-all-v6.log',
        'grep -q "^Result: completed$" /tmp/runtime-all-v6.log || { echo "FAIL: runtime-v6 sub-workflow reported Result: failed (see /tmp/runtime-all-v6.log)"; exit 1; }',
      ].join('\n'),
      captureOutput: true,
      failOnError: true,
    })

    .step('commit-v6', {
      type: 'deterministic',
      dependsOn: ['run-v6'],
      command: [
        'set -eu',
        'cd "' + WORKTREE + '"',
        '[ -f packages/web/app/api/v1/workers/enrollment-tokens/route.ts ] || { echo "FAIL: runtime-v6 did not create the enrollment-tokens route"; exit 1; }',
        '[ -f packages/web/lib/workers/onboarding.ts ] || { echo "FAIL: runtime-v6 did not create lib/workers/onboarding.ts"; exit 1; }',
        'git add -A -- packages/web/app/api/v1/workers/enrollment-tokens packages/web/app/api/v1/workspaces packages/web/app/workspaces packages/web/components/workers packages/web/lib/workers packages/web/drizzle',
        'git diff --cached --quiet && { echo "FAIL: no staged changes to commit"; exit 1; } || true',
        'git commit -m "feat: runtime v6 — worker onboarding UI and workspace default runtime"',
        'echo V6_COMMITTED',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    // ═══════════════════════════════════════════════════════════════════
    // Phase 4 — Push branch and optionally open PR
    // ═══════════════════════════════════════════════════════════════════

    .step('push-branch', {
      type: 'deterministic',
      dependsOn: ['commit-v6'],
      command: [
        'set -eu',
        'cd "' + WORKTREE + '"',
        'echo "=== Pushing ' + BRANCH + ' to origin ==="',
        'git push -u origin ' + BRANCH,
        'echo BRANCH_PUSHED',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('maybe-open-pr', {
      type: 'deterministic',
      dependsOn: ['push-branch'],
      command: [
        'set -euo pipefail',
        'cd "' + WORKTREE + '"',
        'if [ "${RUNTIME_ALL_OPEN_PR:-0}" = "1" ]; then',
        '  command -v gh >/dev/null || { echo "WARN: gh CLI not on PATH — skipping PR creation"; exit 0; }',
        '  gh pr create --base main --title "feat: workflow runtime adapter refactor (v1-v6)" --body "Full runtime adapter refactor rolled out by workflows/runtime-all.ts. See docs/runtimes/specs/ for architecture."',
        '  echo PR_CREATED',
        'else',
        '  echo "PR creation skipped (set RUNTIME_ALL_OPEN_PR=1 to auto-open)"',
        'fi',
      ].join('\n'),
      captureOutput: true,
      failOnError: true,
    })

    // ═══════════════════════════════════════════════════════════════════
    // Phase 5 — Final summary
    // ═══════════════════════════════════════════════════════════════════

    .step('report-summary', {
      type: 'deterministic',
      dependsOn: ['maybe-open-pr'],
      command: [
        'set -eu',
        'cd "' + WORKTREE + '"',
        'echo ""',
        'echo "═══════════════════════════════════════════════════════════"',
        'echo "  Runtime Adapter Rollout Complete"',
        'echo "═══════════════════════════════════════════════════════════"',
        'echo ""',
        'echo "Branch:    ' + BRANCH + '"',
        'echo "Worktree:  ' + WORKTREE + '"',
        'echo ""',
        'echo "Commits on this branch:"',
        'git log --oneline origin/main..HEAD',
        'echo ""',
        'echo "Files changed:"',
        'git diff --stat origin/main..HEAD | tail -20',
        'echo ""',
        'echo "To review:"',
        'echo "  cd ' + WORKTREE + '"',
        'echo "  git log"',
        'echo "  git diff origin/main"',
        'echo ""',
        'echo "To clean up after merge:"',
        'echo "  git worktree remove ' + WORKTREE + '"',
        'echo "  git branch -D ' + BRANCH + '"',
        'echo ""',
      ].join(' && '),
      captureOutput: true,
      failOnError: false,
    })

    .run({ cwd: process.cwd() });

  console.log('Result:', result.status);
}

main().catch(console.error);
