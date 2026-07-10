/**
 * Phase B — Multi-tarball plumbing for multi-repo cloud workflows.
 *
 * Source spec:
 *   specs/multi-repo-cloud-workflows.md
 *
 * Scope:
 *   Cross-repo implementation across the cloud repo and sibling relay repo.
 *   This phase adds read-only multi-path tarballing/mounting + per-repo patch
 *   generation, but NO push-back yet.
 *
 * Expected checkout layout when run locally:
 *   ../cloud   (this repo)
 *   ../relay   (sibling relay repo)
 */

process.env.RUST_LOG =
  process.env.RUST_LOG ??
  ['relay_broker::worker=debug', 'relay_broker=info'].join(',');

import { workflow } from '@relayflows/core';
import { ClaudeModels, CodexModels } from '@agent-relay/config';

const CLOUD_BRANCH = 'feat/multi-repo-cloud-phase-b-cloud';
const RELAY_BRANCH = 'feat/multi-repo-cloud-phase-b-relay';
const CHANNEL = 'wf-multi-repo-cloud-phase-b';
const SPEC = 'specs/multi-repo-cloud-workflows.md';

async function main() {
  const result = await workflow('multi-repo-cloud-phase-b-plumbing')
    .description(
      'Implement Phase B of specs/multi-repo-cloud-workflows.md: multi-path tarballing in relay CLI plus cloud-side validation, mount plumbing, and per-repo patch fanout.',
    )
    .pattern('dag')
    .channel(CHANNEL)
    .maxConcurrency(4)
    .timeout(6_300_000)

    .agent('planner', {
      cli: 'claude',
      model: ClaudeModels.OPUS,
      role:
        'Architect. Reads both relay and cloud entry points, then writes a concrete cross-repo plan for Phase B with exact file list, exact test commands, and repo split.',
      retries: 1,
    })
    .agent('implementer', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      preset: 'worker',
      role:
        'Implements the cross-repo Phase B plan, touching relay CLI code and cloud web/core code. Iterates until both repos build and tests pass.',
      retries: 2,
    })
    .agent('reviewer', {
      cli: 'claude',
      model: ClaudeModels.OPUS,
      role:
        'Final reviewer. APPROVE only when read-only multi-repo cloud execution is working in plan and push-back remains explicitly out of scope.',
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
        'git config user.name "Multi-Repo Plumbing Bot"',
        `git checkout -B ${CLOUD_BRANCH}`,
        `cd ../relay && git config user.email "agent@agent-relay.com" && git config user.name "Multi-Repo Plumbing Bot" && git checkout -B ${RELAY_BRANCH}`,
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
    .step('read-cloud-context', {
      type: 'deterministic',
      dependsOn: ['install-deps'],
      command: [
        'echo "=== workflow run route ==="',
        'cat packages/web/app/api/v1/workflows/run/route.ts',
        'echo "=== launcher ==="',
        'cat packages/core/src/bootstrap/launcher.ts',
        'echo "=== script generator ==="',
        'cat packages/core/src/bootstrap/script-generator.ts',
        'echo "=== workflow store ==="',
        'cat packages/web/lib/workflows.ts',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })
    .step('read-relay-context', {
      type: 'deterministic',
      dependsOn: ['install-deps'],
      command: [
        'echo "=== relay cloud workflows CLI ==="',
        'cat ../relay/packages/cloud/src/workflows.ts',
        'echo "=== relay workflow schema paths ==="',
        `python3 -c 'import json, pathlib; obj = json.loads(pathlib.Path("../relay/packages/sdk/src/workflows/schema.json").read_text()); print(json.dumps({"paths": obj["properties"]["paths"], "PathDefinition": obj["definitions"]["PathDefinition"]}, indent=2))'`,
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })
    .step('read-relevant-tests-and-workflows', {
      type: 'deterministic',
      dependsOn: ['install-deps'],
      command: [
        'echo "=== cloud package scripts ==="',
        'cat package.json',
        'echo "=== relay package scripts ==="',
        'cat ../relay/package.json',
        'echo "=== cloud github clone runner workflow reference ==="',
        'cat workflows/v5-03-cloud-github-clone-runner.ts',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('plan', {
      agent: 'planner',
      dependsOn: ['read-spec', 'read-cloud-context', 'read-relay-context', 'read-relevant-tests-and-workflows'],
      task: `Write PLAN.md for Phase B of ${SPEC}.

PLAN.md must include:
  1. Exact repo split: which files live in relay vs cloud.
  2. Exact file:line evidence for current single-tarball upload in relay and
     current single-mount/single-patch handling in cloud launcher/bootstrap.
  3. Concrete shape for the new request payload and backward-compat handling.
  4. Concrete shape for cloud-side validation against the allowlist, but READ-ONLY
     only in this phase. pushAllowed must not trigger any push-back work yet.
  5. Exact tests in both repos and the actual commands to run them.
  6. Exact e2e/probe workflow(s) to add for Phase B.
  7. Explicit non-goals: no GitHub App push-back yet.

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
      task: `Implement Phase B across cloud + relay.

PLAN:
{{steps.read-plan.output}}

Rules:
  - Cloud repo work stays under this repo.
  - Relay repo work stays under ../relay.
  - Preserve single-repo behavior when workflows do not declare paths.
  - This phase is read-only: patches can be generated and returned, but no
    branch/PR push-back logic ships here.
  - Add/update tests in both repos.

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
      task: `Review Phase B against the spec, PLAN.md, and both repo diffs.

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
  - [PASS|FAIL] relay CLI tarballs each declared path and preserves backward compatibility
  - [PASS|FAIL] cloud validates paths against allowlist in read-only mode
  - [PASS|FAIL] launcher/bootstrap mount multiple repos and emit per-repo patches
  - [PASS|FAIL] single-repo workflows still work unchanged
  - [PASS|FAIL] no push-back logic shipped in Phase B
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
        'git commit -m "feat(cloud): add phase B multi-repo workflow plumbing"',
        'git -C ../relay diff --cached --quiet && { echo "relay nothing to commit"; exit 1; } || true',
        'git -C ../relay commit -m "feat(cloud-cli): add phase B multi-path tarball upload"',
        'git push -u origin HEAD',
        'git -C ../relay push -u origin HEAD',
        'gh pr create --repo AgentWorkforce/cloud --base main --head ' + CLOUD_BRANCH + ' --title "feat: phase B multi-repo cloud plumbing" --body "Implements Phase B from specs/multi-repo-cloud-workflows.md in the cloud repo: allowlist validation, launcher/bootstrap multi-mount plumbing, per-repo patch fanout, and tests. Generated by workflows/multi-repo-cloud-phase-b-plumbing.ts."',
        '(cd ../relay && gh pr create --repo AgentWorkforce/relay --base main --head ' + RELAY_BRANCH + ' --title "feat: phase B multi-path tarball upload for cloud workflows" --body "Implements the relay-side Phase B changes from specs/multi-repo-cloud-workflows.md: upload each declared path tarball and submit the extended run payload. Generated by ../cloud/workflows/multi-repo-cloud-phase-b-plumbing.ts.")',
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
