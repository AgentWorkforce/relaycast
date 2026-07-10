/**
 * Phase C — Push-back via GitHub App for multi-repo cloud workflows.
 *
 * Source spec:
 *   specs/multi-repo-cloud-workflows.md
 *
 * Scope:
 *   Cross-repo implementation across cloud + relay, focused on GitHub App
 *   push-back after workflow completion. This workflow bakes in the recommended
 *   V1 choices from PR #282:
 *
 *   - Q1 Branch naming: Option B
 *     workflow-author-supplied `paths[].pushBranch` optional, fallback
 *     `agent-relay/run-{runId}`
 *   - Q2 PR body: Option B
 *     workflow-author-supplied `paths[].pushPrBody` optional, fallback
 *     platform default body
 *   - Q3 Partial failure: Option A
 *     leave partial state and report exactly what landed / failed
 *   - Q4 Conflict on push: Option B
 *     fail loud if base moved since the run started, surface both SHAs
 *   - Q5 Patch size limits: Option C
 *     try Contents API first, fallback to Git Database API on size limit
 */

process.env.RUST_LOG =
  process.env.RUST_LOG ??
  ['relay_broker::worker=debug', 'relay_broker=info'].join(',');

import { workflow } from '@relayflows/core';
import { ClaudeModels, CodexModels } from '@agent-relay/config';

const CLOUD_BRANCH = 'feat/multi-repo-cloud-phase-c-cloud';
const RELAY_BRANCH = 'feat/multi-repo-cloud-phase-c-relay';
const CHANNEL = 'wf-multi-repo-cloud-phase-c';
const SPEC = 'specs/multi-repo-cloud-workflows.md';

async function main() {
  const result = await workflow('multi-repo-cloud-phase-c-pushback')
    .description(
      'Implement Phase C of specs/multi-repo-cloud-workflows.md: GitHub App push-back, PR creation, run-result surfacing, and the recommended V1 option choices from PR #282.',
    )
    .pattern('dag')
    .channel(CHANNEL)
    .maxConcurrency(4)
    .timeout(6_300_000)

    .agent('planner', {
      cli: 'claude',
      model: ClaudeModels.OPUS,
      role:
        'Architect. Plans the Phase C cross-repo work and hard-codes the recommended V1 option choices into the design and review contract.',
      retries: 1,
    })
    .agent('implementer', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      preset: 'worker',
      role:
        'Implements Phase C across cloud + relay, including writeback bridge extensions, callback integration, run response/CLI surfacing, and tests around the chosen V1 policies.',
      retries: 2,
    })
    .agent('reviewer', {
      cli: 'claude',
      model: ClaudeModels.OPUS,
      role:
        'Strict final reviewer. APPROVE only when the recommended option choices are implemented exactly and failure semantics are explicit, safe, and test-covered.',
      retries: 1,
    })

    .step('verify-repos', {
      type: 'deterministic',
      command: [
        'set -e',
        'git rev-parse --is-inside-work-tree >/dev/null',
        'git -C ../relay rev-parse --is-inside-work-tree >/dev/null',
        'echo CLOUD_OK',
        'echo RELAY_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })
    .step('setup-branches', {
      type: 'deterministic',
      dependsOn: ['verify-repos'],
      command: [
        'set -e',
        'git config user.email "agent@agent-relay.com"',
        'git config user.name "Multi-Repo Pushback Bot"',
        `git checkout -B ${CLOUD_BRANCH}`,
        `cd ../relay && git config user.email "agent@agent-relay.com" && git config user.name "Multi-Repo Pushback Bot" && git checkout -B ${RELAY_BRANCH}`,
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })
    .step('install-deps', {
      type: 'deterministic',
      dependsOn: ['setup-branches'],
      command: [
        'npm install --legacy-peer-deps --no-audit --no-fund 2>&1 | tail -10',
        'cd ../relay && npm install --no-audit --no-fund 2>&1 | tail -10',
      ].join(' && '),
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
    .step('read-cloud-pushback-context', {
      type: 'deterministic',
      dependsOn: ['install-deps'],
      command: [
        'echo "=== relayfile writeback bridge ==="',
        'cat packages/web/lib/integrations/relayfile-writeback-bridge.ts',
        'echo "=== workflow callback route ==="',
        'cat packages/web/app/api/v1/workflows/callback/route.ts',
        'echo "=== workflow run route ==="',
        'cat packages/web/app/api/v1/workflows/run/route.ts',
        'echo "=== integration route handler ==="',
        'cat packages/web/lib/integrations/integration-route-handler.ts',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })
    .step('read-relay-and-cli-context', {
      type: 'deterministic',
      dependsOn: ['install-deps'],
      command: [
        'echo "=== relay cloud workflow CLI ==="',
        'cat ../relay/packages/cloud/src/workflows.ts',
        'echo "=== relay cloud types ==="',
        'cat ../relay/packages/cloud/src/types.ts',
        'echo "=== relay workflow schema paths ==="',
        `python3 -c 'import json, pathlib; obj = json.loads(pathlib.Path("../relay/packages/sdk/src/workflows/schema.json").read_text()); print(json.dumps({"paths": obj["properties"]["paths"]}, indent=2))'`,
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })
    .step('read-scripts-and-reference-workflow', {
      type: 'deterministic',
      dependsOn: ['install-deps'],
      command: [
        'echo "=== cloud package scripts ==="',
        'cat package.json',
        'echo "=== relay package scripts ==="',
        'cat ../relay/package.json',
        'echo "=== phase B reference workflow (if present) ==="',
        'cat workflows/multi-repo-cloud-phase-b-plumbing.ts 2>/dev/null || echo "PHASE_B_WORKFLOW_NOT_FOUND"',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('plan', {
      agent: 'planner',
      dependsOn: ['read-spec', 'read-cloud-pushback-context', 'read-relay-and-cli-context', 'read-scripts-and-reference-workflow'],
      task: `Write PLAN.md for Phase C of ${SPEC}.

You MUST bake in these V1 decisions from PR #282:
  - Branch naming = Option B: optional paths[].pushBranch, fallback agent-relay/run-{runId}
  - PR body = Option B: optional paths[].pushPrBody, fallback platform default body
  - Partial failure = Option A: leave partial state, report exactly what landed
  - Conflict on push = Option B: fail loud if base moved, include both SHAs
  - Patch size limits = Option C: Contents API first, Git Database fallback on size error

PLAN.md must include:
  1. Exact repo split across cloud and relay.
  2. Exact file:line evidence for current writeback bridge, callback path, and
     current relay CLI run-result surfacing.
  3. Concrete API/data shape for run response patches[].pushedTo and any extra
     metadata needed to surface partial success/failure cleanly.
  4. Concrete test plan proving the five decisions above.
  5. Clear non-goals and future follow-up notes if any recommendation implies a
     later improvement (e.g. rebase-on-conflict later).

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
      task: `Implement Phase C across cloud + relay.

PLAN:
{{steps.read-plan.output}}

Non-negotiable V1 decisions to implement exactly:
  1. paths[].pushBranch optional, fallback default branch name agent-relay/run-{runId}
  2. paths[].pushPrBody optional, fallback platform default PR body
  3. Partial success is preserved and reported; no rollback of already-opened PRs
  4. If base moved during run, fail loud with both SHAs
  5. Use Contents API first, fall back to Git Database API for size-limit cases

Rules:
  - Installation token never leaves the web side.
  - No PATs, no SSH keys, no service tokens in sandbox.
  - Add/update tests for the above decision points.
  - Keep failure semantics operator-visible and non-destructive.

Before finishing, iterate until the planner's exact commands pass.
Then write IMPL_SUMMARY.md with separate CLOUD and RELAY sections. Do not commit.`,
      verification: { type: 'file_exists', value: 'IMPL_SUMMARY.md' },
      retries: 2,
    })

    .step('run-cloud-gates', {
      type: 'deterministic',
      dependsOn: ['implement'],
      command: 'npm run typecheck 2>&1 | tail -60 && npm run test 2>&1 | tail -80',
      captureOutput: true,
      failOnError: true,
    })
    .step('run-relay-gates', {
      type: 'deterministic',
      dependsOn: ['implement'],
      command: 'cd ../relay && npm run build 2>&1 | tail -60 && npm test 2>&1 | tail -80',
      captureOutput: true,
      failOnError: true,
    })
    .step('capture-both-diffs', {
      type: 'deterministic',
      dependsOn: ['run-cloud-gates', 'run-relay-gates'],
      command: [
        'echo "=== CLOUD DIFF ==="',
        'git diff HEAD --stat && git diff HEAD',
        'echo "=== RELAY DIFF ==="',
        'cd ../relay && git diff HEAD --stat && git diff HEAD',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('review', {
      agent: 'reviewer',
      dependsOn: ['capture-both-diffs'],
      task: `Review Phase C against the spec, PLAN.md, and both repo diffs.

SPEC:
{{steps.read-spec.output}}

PLAN:
{{steps.read-plan.output}}

DIFFS:
{{steps.capture-both-diffs.output}}

Write REVIEW.md with this exact shape:
  VERDICT: APPROVE
  or
  VERDICT: REQUEST_CHANGES

  ## Checklist
  - [PASS|FAIL] branch naming implements Option B with correct fallback
  - [PASS|FAIL] PR body implements Option B with correct fallback
  - [PASS|FAIL] partial multi-repo push failure implements Option A (no rollback)
  - [PASS|FAIL] base-moved conflict implements Option B and surfaces both SHAs
  - [PASS|FAIL] size handling implements Option C (Contents API then Git Database fallback)
  - [PASS|FAIL] installation token stays web-side only
  - [PASS|FAIL] cloud + relay verification commands passed
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

    .step('commit-and-open-prs', {
      type: 'deterministic',
      dependsOn: ['gate-on-review'],
      command: [
        'rm -f PLAN.md IMPL_SUMMARY.md REVIEW.md',
        'git add -A',
        'git -C ../relay add -A',
        'git diff --cached --quiet && { echo "cloud nothing to commit"; exit 1; } || true',
        'git commit -m "feat(cloud): add phase C multi-repo pushback"',
        'git -C ../relay diff --cached --quiet && { echo "relay nothing to commit"; exit 1; } || true',
        'git -C ../relay commit -m "feat(cloud-cli): surface phase C multi-repo push results"',
        'git push -u origin HEAD',
        'git -C ../relay push -u origin HEAD',
        'gh pr create --repo AgentWorkforce/cloud --base main --head ' + CLOUD_BRANCH + ' --title "feat: phase C push-back for multi-repo cloud workflows" --body "Implements Phase C from specs/multi-repo-cloud-workflows.md in the cloud repo, using the recommended V1 choices from PR #282 (Q1=B, Q2=B, Q3=A, Q4=B, Q5=C). Generated by workflows/multi-repo-cloud-phase-c-pushback.ts."',
        '(cd ../relay && gh pr create --repo AgentWorkforce/relay --base main --head ' + RELAY_BRANCH + ' --title "feat: surface phase C multi-repo push results in cloud CLI" --body "Implements the relay-side Phase C changes from specs/multi-repo-cloud-workflows.md, including run-result surfacing for pushed PRs. Generated by ../cloud/workflows/multi-repo-cloud-phase-c-pushback.ts.")',
      ].join(' && '),
      failOnError: true,
    })

    .onError('fail-fast')
    .run({ cwd: process.cwd() });

  console.log('Workflow status:', result.status);
  console.log(`Cloud branch: ${CLOUD_BRANCH}`);
  console.log(`Relay branch: ${RELAY_BRANCH}`);
  if (result.status !== 'completed') process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
