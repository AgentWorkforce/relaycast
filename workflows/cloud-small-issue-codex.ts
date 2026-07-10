// workflows/cloud-small-issue-codex.ts
// Small-issue auto-fix for AgentWorkforce/cloud.
// Inputs (env): ISSUE_NUMBER, ISSUE_TITLE, ISSUE_BODY, ISSUE_URL.
// codex impl commits on a fresh branch; claude lead reviews; up to 2 fix rounds;
// integrator pushes and opens the PR via createGitHubStep.
import { workflow } from '@relayflows/core';
import { createGitHubStep } from '@agent-relay/sdk';

const ISSUE_NUMBER = process.env.ISSUE_NUMBER ?? '';
const ISSUE_TITLE = process.env.ISSUE_TITLE ?? '';
const ISSUE_BODY = process.env.ISSUE_BODY ?? '';
const ISSUE_URL = process.env.ISSUE_URL ?? '';
if (!ISSUE_NUMBER || !ISSUE_TITLE) {
  console.error('ERROR: ISSUE_NUMBER and ISSUE_TITLE env vars are required.');
  process.exit(1);
}

const WORKFLOW_NAME = `cloud-small-issue-${ISSUE_NUMBER}`;
const CHANNEL = `wf-cloud-small-issue-${ISSUE_NUMBER}`;
const BRANCH = `codex/small-issue-${ISSUE_NUMBER}-${Date.now()}`;
const REPO = 'AgentWorkforce/cloud';
const REPO_DIR = './cloud';
const A = 'artifacts/cloud-small-issue';
const IMPL_NOTE = `${A}/impl-initial.txt`;
const DIFF_R1 = `${A}/diff-r1.patch`;
const DIFF_R2 = `${A}/diff-r2.patch`;
const DIFF_R3 = `${A}/diff-final.patch`;
const REV_R1 = `${A}/review-r1.md`;
const REV_R2 = `${A}/review-r2.md`;
const REV_F = `${A}/review-final.md`;
const FIX_R1 = `${A}/fix-r1.txt`;
const FIX_R2 = `${A}/fix-r2.txt`;
const VERDICT = `${A}/verdict.txt`;
const PR_URL_FILE = `${A}/pr-url.txt`;
const BRANCH_FILE = `${A}/branch.txt`;

const T_PREFLIGHT = 180_000;
const T_IMPL = 1_200_000;
const T_REVIEW = 300_000;
const T_FIX = 900_000;
const T_PUSH = 180_000;
const T_PR = 120_000;

const ISSUE_CONTEXT = [
  `Issue #${ISSUE_NUMBER}: ${ISSUE_TITLE}`,
  `URL: ${ISSUE_URL}`,
  '',
  'Body:',
  ISSUE_BODY,
].join('\n');

const REVIEW_SCHEMA = `Write the review using this exact schema:

VERDICT: GO
or
VERDICT: NO-GO

REASON: <one short sentence>

FINDINGS (only if NO-GO):
- <finding 1, with file:line and concrete required change>
- <finding 2, ...>

Bar for GO:
- The change actually addresses the issue's stated problem.
- No obvious correctness bugs, regressions, or unsafe patterns.
- Scope is minimal — no unrelated edits, no over-refactor.
- If the fix has observable behavior, a regression test exists and would fail without it.
- No leaked secrets, no committed credentials, no unrelated dep bumps.`;

async function runWorkflow() {
  const result = await workflow(WORKFLOW_NAME)
    .description(`Auto-fix small issue #${ISSUE_NUMBER} in ${REPO}: codex impl + claude review + PR`)
    .pattern('dag')
    .channel(CHANNEL)
    .maxConcurrency(2)
    .timeout(4_500_000)

    .agent('impl', {
      cli: 'codex',
      preset: 'worker',
      role: 'Implements the minimal fix on a fresh branch and commits.',
      retries: 1,
      maxTokens: 32_000,
    })
    .agent('reviewer', {
      cli: 'claude',
      preset: 'lead',
      role: 'Reviews the impl diff against the issue. Returns GO or NO-GO with concrete findings.',
      retries: 1,
      maxTokens: 16_000,
    })

    .step('preflight', {
      type: 'deterministic',
      command: [
        'set -e',
        `mkdir -p ${A}`,
        `rm -f ${IMPL_NOTE} ${DIFF_R1} ${DIFF_R2} ${DIFF_R3} ${REV_R1} ${REV_R2} ${REV_F} ${FIX_R1} ${FIX_R2} ${VERDICT} ${PR_URL_FILE} ${BRANCH_FILE}`,
        `if [ ! -d ${REPO_DIR}/.git ]; then git clone "https://github.com/${REPO}.git" ${REPO_DIR}; fi`,
        `cd ${REPO_DIR} && git fetch origin main`,
        `cd ${REPO_DIR} && git checkout main && git reset --hard origin/main`,
        `cd ${REPO_DIR} && git checkout -B ${BRANCH}`,
        `echo "${BRANCH}" > ${BRANCH_FILE}`,
        'echo preflight_ok',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
      timeoutMs: T_PREFLIGHT,
    })

    .step('implement', {
      agent: 'impl',
      dependsOn: ['preflight'],
      task: `You are working inside ${REPO_DIR} (clone of ${REPO}) on branch ${BRANCH}.
Make the MINIMAL change to fix the following issue, then commit it.

${ISSUE_CONTEXT}

Hard constraints:
- Every shell invocation must start from ${REPO_DIR} (use 'cd ${REPO_DIR} && ...').
- Touch only files needed for the fix. Small surgical edits only.
- No new dependencies unless strictly required.
- Add or update a focused regression test when the fix has observable behavior.
- Run obviously relevant test/lint commands for the touched area.
- Commit with a clear message ending "Refs #${ISSUE_NUMBER}".
- DO NOT push. DO NOT open a PR. The integrator step handles that.
- Keep stdout concise.

When done, write a short summary to ${IMPL_NOTE} from the workflow root (one file per line + commit SHA). Exit successfully when the commit is on ${BRANCH} locally.`,
      verification: { type: 'exit_code' },
      timeoutMs: T_IMPL,
      retries: 1,
    })

    .step('capture-diff-r1', {
      type: 'deterministic',
      dependsOn: ['implement'],
      command: [
        'set -e',
        `cd ${REPO_DIR} && git diff origin/main...HEAD > ../${DIFF_R1}`,
        `test -s ${DIFF_R1} || (echo "empty_diff_after_implement"; exit 1)`,
        `cd ${REPO_DIR} && git log --oneline origin/main..HEAD | head -20`,
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
      timeoutMs: 120_000,
    })

    .step('review-r1', {
      agent: 'reviewer',
      dependsOn: ['capture-diff-r1'],
      task: `Review the impl's diff for issue #${ISSUE_NUMBER}.

${ISSUE_CONTEXT}

The diff is at ${DIFF_R1} (\`cat ${DIFF_R1}\`); you may also read the actual HEAD files under ${REPO_DIR}.

${REVIEW_SCHEMA}

Write your review to ${REV_R1}. Do not invent issues to look thorough.`,
      verification: { type: 'exit_code' },
      timeoutMs: T_REVIEW,
      retries: 0,
    })

    .step('gate-review-r1', {
      type: 'deterministic',
      dependsOn: ['review-r1'],
      command: [
        'set -e',
        `test -s ${REV_R1}`,
        `rg -n "^VERDICT: (GO|NO-GO)$" ${REV_R1} >/dev/null`,
        `rg -n "^REASON: " ${REV_R1} >/dev/null`,
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
      timeoutMs: 60_000,
    })

    .step('fix-r1', {
      agent: 'impl',
      dependsOn: ['gate-review-r1'],
      task: `Reviewer ran on the diff for issue #${ISSUE_NUMBER}. Read ${REV_R1}.

If it contains "VERDICT: GO", do NOT edit anything. Append "no-fix-needed" to ${FIX_R1} and exit.
If it contains "VERDICT: NO-GO", address EVERY finding under FINDINGS with the smallest possible edits inside ${REPO_DIR}. Amend or add commits on ${BRANCH}. Do not push. Keep tests passing for touched areas.

Write a short summary (or "no-fix-needed") to ${FIX_R1}. Stay within ${REPO_DIR}. Keep stdout concise.`,
      verification: { type: 'exit_code' },
      timeoutMs: T_FIX,
      retries: 0,
    })

    .step('capture-diff-r2', {
      type: 'deterministic',
      dependsOn: ['fix-r1'],
      command: [
        'set -e',
        `cd ${REPO_DIR} && git diff origin/main...HEAD > ../${DIFF_R2}`,
        `test -s ${DIFF_R2} || (echo "empty_diff_after_fix_r1"; exit 1)`,
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
      timeoutMs: 120_000,
    })

    .step('review-r2', {
      agent: 'reviewer',
      dependsOn: ['capture-diff-r2'],
      task: `Second-round review for issue #${ISSUE_NUMBER}.

If ${REV_R1} said "VERDICT: GO" and ${FIX_R1} says "no-fix-needed", copy that VERDICT/REASON forward into ${REV_R2} and exit.

Otherwise re-review the post-fix diff at ${DIFF_R2} against the original issue:

${ISSUE_CONTEXT}

${REVIEW_SCHEMA}

Write the review to ${REV_R2}.`,
      verification: { type: 'exit_code' },
      timeoutMs: T_REVIEW,
      retries: 0,
    })

    .step('gate-review-r2', {
      type: 'deterministic',
      dependsOn: ['review-r2'],
      command: [
        'set -e',
        `test -s ${REV_R2}`,
        `rg -n "^VERDICT: (GO|NO-GO)$" ${REV_R2} >/dev/null`,
        `rg -n "^REASON: " ${REV_R2} >/dev/null`,
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
      timeoutMs: 60_000,
    })

    .step('fix-r2', {
      agent: 'impl',
      dependsOn: ['gate-review-r2'],
      task: `LAST fix iteration for issue #${ISSUE_NUMBER}. Read ${REV_R2}.

If "VERDICT: GO": append "no-fix-needed" to ${FIX_R2} and exit.
If "VERDICT: NO-GO": address every finding with minimal edits inside ${REPO_DIR}, commit on ${BRANCH}, summarize to ${FIX_R2}.

If you genuinely cannot resolve a finding (external blocker, conflicting requirement), write the literal line "BLOCKED" at the top of ${FIX_R2} followed by a short explanation. The integrator will refuse to open a PR.

Stay within ${REPO_DIR}. Keep stdout concise.`,
      verification: { type: 'exit_code' },
      timeoutMs: T_FIX,
      retries: 0,
    })

    .step('capture-diff-final', {
      type: 'deterministic',
      dependsOn: ['fix-r2'],
      command: [
        'set -e',
        `cd ${REPO_DIR} && git diff origin/main...HEAD > ../${DIFF_R3}`,
        `test -s ${DIFF_R3} || (echo "empty_final_diff"; exit 1)`,
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
      timeoutMs: 120_000,
    })

    .step('review-final', {
      agent: 'reviewer',
      dependsOn: ['capture-diff-final'],
      task: `Final pre-merge review for issue #${ISSUE_NUMBER}. Read ${DIFF_R3}. Confirm against the original issue:

${ISSUE_CONTEXT}

${REVIEW_SCHEMA}

Write the review to ${REV_F}. After 2 fix rounds the integrator opens a PR only on VERDICT: GO; on NO-GO it refuses and ${REV_F} explains why.`,
      verification: { type: 'exit_code' },
      timeoutMs: T_REVIEW,
      retries: 0,
    })

    .step('decide-verdict', {
      type: 'deterministic',
      dependsOn: ['review-final'],
      command: [
        'set -e',
        `test -s ${REV_F}`,
        `rg -n "^VERDICT: (GO|NO-GO)$" ${REV_F} >/dev/null`,
        `V=$(rg -n "^VERDICT: " ${REV_F} | head -1 | sed 's/^[0-9]*:VERDICT: //')`,
        `echo "$V" > ${VERDICT}`,
        `if [ -f ${FIX_R2} ] && head -1 ${FIX_R2} | rg -n "^BLOCKED$" >/dev/null; then echo "BLOCKED" > ${VERDICT}; fi`,
        `echo "final verdict: $(cat ${VERDICT})"`,
        `if [ "$(cat ${VERDICT})" != "GO" ]; then echo "no_go_no_pr"; exit 1; fi`,
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
      timeoutMs: 60_000,
    })

    .step('push-branch', {
      type: 'deterministic',
      dependsOn: ['decide-verdict'],
      command: [
        'set -e',
        `cd ${REPO_DIR} && git push -u origin ${BRANCH}`,
        `cd ${REPO_DIR} && git rev-parse HEAD`,
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
      timeoutMs: T_PUSH,
    })

    .step('open-pr', createGitHubStep({
      dependsOn: ['push-branch'],
      action: 'createPR',
      repo: REPO,
      params: {
        title: `fix: ${ISSUE_TITLE} (#${ISSUE_NUMBER})`,
        head: BRANCH,
        base: 'main',
        body: [
          `## Summary`,
          ``,
          `Auto-fix for ${ISSUE_URL}.`,
          ``,
          `Closes #${ISSUE_NUMBER}`,
          ``,
          `## Review`,
          `- impl: codex (worker preset)`,
          `- reviewer: claude (lead preset)`,
          `- Artifacts: \`${REV_R1}\`, \`${REV_R2}\`, \`${REV_F}\``,
          ``,
          `## Test plan`,
          `- [ ] CI green`,
          `- [ ] Reviewer final verdict: GO (see \`${REV_F}\`)`,
          ``,
          `Generated by workflow \`${WORKFLOW_NAME}\` on channel \`${CHANNEL}\`.`,
        ].join('\n'),
        draft: false,
      },
      output: { mode: 'data', format: 'json', path: 'html_url' },
      timeoutMs: T_PR,
    }))

    .step('record-pr-url', {
      type: 'deterministic',
      dependsOn: ['open-pr'],
      command: [
        'set -e',
        `printf "%s" "{{steps.open-pr.output}}" > ${PR_URL_FILE}`,
        `test -s ${PR_URL_FILE}`,
        `echo "PR_URL=$(cat ${PR_URL_FILE})"`,
        `echo "BRANCH=${BRANCH}"`,
        `echo "VERDICT=$(cat ${VERDICT})"`,
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
      timeoutMs: 60_000,
    })

    .onError('fail-fast')
    .run({ cwd: process.cwd() });

  console.log(`Workflow status: ${result.status} (${result.id})`);
  console.log(`Branch: ${BRANCH}`);
}

runWorkflow().catch((error) => {
  console.error(error);
  process.exit(1);
});
