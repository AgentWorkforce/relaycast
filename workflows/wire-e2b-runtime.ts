// Wire E2B as a first-class runtime alongside Daytona.
//
// Usage:
//   agent-relay run workflows/wire-e2b-runtime.ts
//
// The workflow provisions its own isolated worktree so unrelated local
// changes don't leak into the PR. Pattern: claude plan → codex implement
// → claude review → commit + PR (see `writing-agent-relay-workflows` skill).

import { workflow } from '@relayflows/core';
import { ClaudeModels, CodexModels } from '@agent-relay/config';
import { execSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';

const BRANCH = 'feat/wire-e2b-runtime';
const DRY_RUN = !!process.env.DRY_RUN || process.argv.includes('--dry-run');

function computeWorktreePath(): string {
  const repoRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
  return path.resolve(repoRoot, '..', `${path.basename(repoRoot)}-wire-e2b`);
}

function setupWorktree(worktreePath: string): void {
  const repoRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();

  // An active git worktree at this path means someone is using it — refuse to touch it.
  // A bare directory with no worktree registration is safe to remove (leftover from a
  // previous aborted run).
  const registeredWorktrees = execSync('git worktree list --porcelain', {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  const isRegisteredWorktree = registeredWorktrees
    .split('\n')
    .some((line) => line === `worktree ${worktreePath}`);

  if (isRegisteredWorktree) {
    throw new Error(
      `An active git worktree already exists at ${worktreePath}.\n` +
        `Remove it before running the workflow:\n` +
        `  git worktree remove --force ${worktreePath}\n` +
        `  git branch -D ${BRANCH}   # if the branch also lingered`,
    );
  }

  if (existsSync(worktreePath)) {
    console.log(`[setup] removing stale directory at ${worktreePath}`);
    rmSync(worktreePath, { recursive: true, force: true });
  }

  // Old branch from a previous aborted run would block `git worktree add -b`.
  try {
    execSync(`git branch -D ${JSON.stringify(BRANCH)}`, { cwd: repoRoot, stdio: 'pipe' });
    console.log(`[setup] deleted stale local branch ${BRANCH}`);
  } catch {
    // branch didn't exist — fine
  }

  console.log('[setup] fetching origin/main');
  execSync('git fetch origin main', { cwd: repoRoot, stdio: 'inherit' });

  console.log(`[setup] creating worktree ${worktreePath} on ${BRANCH}`);
  execSync(
    `git worktree add ${JSON.stringify(worktreePath)} -b ${JSON.stringify(BRANCH)} origin/main`,
    { cwd: repoRoot, stdio: 'inherit' },
  );

  console.log('[setup] npm install in worktree');
  execSync('npm install --no-audit --no-fund', { cwd: worktreePath, stdio: 'inherit' });
}

async function runWorkflow() {
  const worktreePath = computeWorktreePath();
  if (DRY_RUN) {
    console.log(`[dry-run] skipping worktree setup (would provision ${worktreePath} on ${BRANCH})`);
  } else {
    setupWorktree(worktreePath);
  }

  const result = await workflow('wire-e2b-runtime')
    .description(
      'Wire E2B runtime end-to-end: registry, UI picker, API validation, SST secret, bootstrap branch, snapshot deps, CI template publish',
    )
    .pattern('dag')
    .channel('wf-wire-e2b-runtime')
    .maxConcurrency(3)
    .timeout(3_600_000)

    .agent('planner', {
      cli: 'claude',
      model: ClaudeModels.OPUS,
      role: 'Architect — maps every file that must change for E2B to be first-class; produces the plan.',
      retries: 1,
    })
    .agent('implementer', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      role: 'Implements the plan across packages/core, packages/web, infra, scripts, and .github.',
      retries: 2,
    })
    .agent('reviewer', {
      cli: 'claude',
      model: ClaudeModels.OPUS,
      role: 'Strict end-to-end reviewer — verdicts APPROVE or REQUEST_CHANGES against the acceptance checklist.',
      retries: 1,
    })

    // ─── Plan ──────────────────────────────────────────────────────────
    .step('plan', {
      agent: 'planner',
      task: `Produce a concrete, file-by-file plan to wire E2B as a first-class runtime alongside Daytona.

Context to read:
  packages/core/src/runtime/e2b.ts              (existing E2BRuntime class)
  packages/core/src/runtime/daytona.ts          (parallel DaytonaRuntime)
  packages/core/src/runtime/register-defaults.ts (only daytona is registered today)
  packages/core/src/runtime/registry.ts
  packages/core/src/runtime/index.ts            (barrel — causes eager e2b load in snapshot)
  packages/web/components/workers/RuntimeDefaultPicker.tsx  (UI — only daytona option)
  packages/web/app/api/v1/workspaces/[workspaceId]/runtime/route.ts  (accepts "daytona"|"worker"; not "e2b")
  packages/core/src/bootstrap/script-generator.ts  (bootstrap hardcodes DaytonaRuntime)
  packages/web/app/api/v1/workflows/run/route.ts  (launches orchestrator; selects runtime implicitly)
  infra/secrets.ts                              (SST secrets; no E2BApiKey yet)
  infra/e2b/template.json, infra/e2b/README.md  (E2B template spec, not published in CI)
  scripts/create-snapshot.ts                    (Daytona orchestrator snapshot — needs "e2b" npm dep)

Produce PLAN.md at the repo root covering:

  1. Registry: add an 'e2b' entry in register-defaults.ts with descriptor + factory.
  2. Selection API: extend the runtime route validator to accept runtime.id === 'e2b'.
  3. UI: add <option value="e2b">E2B</option> in RuntimeDefaultPicker.tsx (and any other runtime display).
  4. SST secret: declare E2BApiKey in infra/secrets.ts; wire into Lambda env (infra/web.ts or equivalent).
  5. Orchestrator env: pass E2B_API_KEY + E2B_TEMPLATE into the Daytona orchestrator sandbox env
     (packages/web/app/api/v1/workflows/run/route.ts — wherever envVars are assembled).
  6. Bootstrap: change script-generator.ts to branch on the workspace's defaultRuntime — when 'e2b',
     instantiate E2BRuntime with { apiKey: env.E2B_API_KEY, template: env.E2B_TEMPLATE }. Preserve the
     Daytona default. Do NOT re-introduce the runtime/index.js barrel import (see PR #218 for the bug).
  7. Snapshot deps: add "e2b" to the snapshot's /home/daytona/package.json so the orchestrator can
     import { Sandbox } from 'e2b'. Update scripts/create-snapshot.ts (or equivalent) accordingly.
  8. CI: add .github/workflows/publish-e2b-template.yml that runs "e2b template build" + "e2b template publish"
     on changes to infra/e2b/. Requires E2B_API_KEY as a repo secret — document the setup step.
  9. Tests: add a script-generator test asserting the bootstrap selects E2BRuntime when runtime='e2b'
     and still selects DaytonaRuntime by default. Add a runtime-registry test asserting both adapters
     are registered.
 10. Acceptance contract: the exact command a human would run to prove E2B works end-to-end
     (e.g. set workspace defaultRuntime to 'e2b', run a hello-world workflow, expect it to launch
     an E2B sandbox and return exit 0).
 11. Residual risks / deferred: anything not covered by this PR.

Keep the plan concrete — every item names exact file paths and the nature of the edit. Do NOT modify any source files in this step.`,
      verification: { type: 'file_exists', value: 'PLAN.md' },
    })

    .step('read-plan', {
      type: 'deterministic',
      dependsOn: ['plan'],
      command: 'cat PLAN.md',
      captureOutput: true,
      failOnError: true,
    })

    // ─── Implement ─────────────────────────────────────────────────────
    .step('implement', {
      agent: 'implementer',
      dependsOn: ['read-plan'],
      task: `Execute the plan below. Only edit files the plan names; do not refactor unrelated code.

PLAN:
{{steps.read-plan.output}}

After edits, iterate until these all pass (fix failures in-place):
  npm run build:core
  npm run orchestrator:test

When green, write IMPL_SUMMARY.md at the repo root listing each file you touched with a one-line note
on what changed in that file.

IMPORTANT:
  - Do not modify the runtime/index.js barrel in a way that pulls e2b into the Daytona snapshot path
    (that was the PR #218 bug). Keep the direct-import pattern in script-generator.ts.
  - Preserve the Daytona default. A workspace with no explicit runtime must still get Daytona.
  - Do not commit — a later step handles commit + PR.`,
      verification: { type: 'file_exists', value: 'IMPL_SUMMARY.md' },
    })

    // Hard build + test gate. If implement passed its own checks but something drifted,
    // this surfaces it before review.
    .step('build-gate', {
      type: 'deterministic',
      dependsOn: ['implement'],
      command: 'npm run build:core && npm run orchestrator:test',
      failOnError: true,
    })

    .step('capture-diff', {
      type: 'deterministic',
      dependsOn: ['build-gate'],
      command: 'git diff --stat HEAD && echo --- && git diff HEAD',
      captureOutput: true,
      failOnError: true,
    })

    // ─── Review ────────────────────────────────────────────────────────
    .step('review', {
      agent: 'reviewer',
      dependsOn: ['capture-diff'],
      task: `Review the E2B wiring implementation against PLAN.md and IMPL_SUMMARY.md.

Staged changes:
{{steps.capture-diff.output}}

Acceptance checklist (mark each PASS or FAIL — FAIL means REQUEST_CHANGES):
  [ ] E2BRuntime registered in packages/core/src/runtime/register-defaults.ts with correct descriptor.
  [ ] Runtime selection API accepts runtime.id === "e2b" and persists it.
  [ ] RuntimeDefaultPicker.tsx exposes the E2B option; any runtime label/description UI is updated.
  [ ] E2BApiKey declared in infra/secrets.ts and wired into the Lambda/web env.
  [ ] E2B_API_KEY + E2B_TEMPLATE flow from the web route into the orchestrator sandbox env.
  [ ] Bootstrap branches on runtime and instantiates E2BRuntime when appropriate; Daytona stays default.
  [ ] Bootstrap does NOT import from ./lib/runtime/index.js (barrel) — direct imports only.
  [ ] "e2b" added to snapshot deps (scripts/create-snapshot.ts or equivalent), so the orchestrator can import it.
  [ ] CI workflow exists at .github/workflows/publish-e2b-template.yml (build + publish on infra/e2b changes).
  [ ] Tests added: script-generator selects the right runtime; registry has both adapters.
  [ ] No unrelated changes / scope creep.

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

Be strict. If any item fails, use REQUEST_CHANGES. Do NOT edit code in this step.`,
      verification: { type: 'file_exists', value: 'REVIEW.md' },
    })

    // Deterministic verdict gate — fails the workflow if review didn't approve.
    // Use a literal pattern (BSD grep doesn't do \s the way GNU does).
    .step('gate-on-verdict', {
      type: 'deterministic',
      dependsOn: ['review'],
      command: 'grep -q "VERDICT: APPROVE" REVIEW.md',
      failOnError: true,
    })

    // ─── Commit + PR ───────────────────────────────────────────────────
    // Intermediate artifacts (PLAN.md / IMPL_SUMMARY.md / REVIEW.md) are removed
    // before the commit so they don't end up in the PR.
    .step('commit-and-pr', {
      type: 'deterministic',
      dependsOn: ['gate-on-verdict'],
      command: [
        'rm -f PLAN.md IMPL_SUMMARY.md REVIEW.md',
        'git add -A',
        'git diff --cached --quiet && { echo "nothing to commit"; exit 1; } || true',
        'git commit -m "feat(runtime): wire E2B as a first-class runtime"',
        'git push -u origin HEAD',
        'gh pr create --title "feat(runtime): wire E2B as a first-class runtime" --body "Wires E2B end-to-end: registry, UI picker, runtime API, SST secret, bootstrap branch, snapshot dep, CI template publish. Generated by workflows/wire-e2b-runtime.ts (claude plan → codex implement → claude review)."',
      ].join(' && '),
      failOnError: true,
    })

    .onError('fail-fast')
    .run({ cwd: worktreePath });

  console.log('Workflow status:', result.status);
  console.log(`Worktree: ${worktreePath}`);
  console.log(`Branch:   ${BRANCH}`);
  console.log('After the PR merges, clean up with:');
  console.log(`  git worktree remove ${worktreePath}`);
}

runWorkflow().catch((error) => {
  console.error(error);
  process.exit(1);
});
