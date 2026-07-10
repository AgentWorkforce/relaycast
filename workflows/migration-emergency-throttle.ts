// Cloud Web Migration — Wave 0: Emergency Throttle Containment
// ──────────────────────────────────────────────────────────────────────────────
// Wave: 0. Worktree: cloud-emergency-throttle.
//
// Goal: reservedConcurrency carve-up on user-facing + admin SST functions so a
//       webhook storm cannot starve the user tier. Plus a read-only
//       CloudWatch diagnostic for the 2026-05-14 throttle storm.
//
// NOTE: inlines setup-branch + install-deps to avoid applyCloudRepoSetup's
// JSON.stringify multi-line bash bug (the helper passes `\n` as literal chars
// to `bash -lc` on this runtime). Single-line `cmd && cmd` form here.
// ──────────────────────────────────────────────────────────────────────────────

import { workflow } from '@relayflows/core';
import { ClaudeModels, CodexModels } from '@agent-relay/config';

const NAME = 'migration-emergency-throttle';
const BRANCH = 'feat/migration-emergency-throttle';
const CHANNEL = `wf-${NAME}`;

const AWS_PROFILE = '131935618863_ReadOnlyAccess';
const AWS_REGION = 'us-east-1';
const HOT_LAMBDA = 'clou-production-AgentRelayCloudWebServerUseast1Function-tmtvuwhn';

const RESERVED_CONCURRENCY = { cloudWeb: 5, relayWeb: 1, admin: 1 };

const ALLOWED_DIRTY = [
  'package-lock\\.json',
  'package\\.json',
  'infra/web\\.ts',
  'infra/admin\\.ts',
  'docs/incidents/.*',
  '\\.logs/.*',
  '\\.trajectories/.*',
  'workflows/migration-emergency-throttle\\.ts',
  'workflows/lib/.*',
].join('|');

async function runWorkflow() {
  const wf = workflow(NAME)
    .description(
      'Wave 0 emergency containment. reservedConcurrency carve-up + CloudWatch diagnostic for the 2026-05-14 storm.',
    )
    .pattern('dag')
    .channel(CHANNEL)
    .maxConcurrency(3)
    .timeout(60 * 60 * 1000)

    .agent('sre-impl', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      role: 'Owns infra/*.ts edits. Adds reservedConcurrency to user-facing functions.',
      retries: 2,
    })
    .agent('sre-analyst', {
      cli: 'claude',
      model: ClaudeModels.OPUS,
      role: 'Reads CloudWatch output and writes docs/incidents/2026-05-14-throttle-storm.md.',
      retries: 1,
    });

  type StepChain = {
    step: (name: string, cfg: unknown) => StepChain;
    onError: (mode: string, opts?: unknown) => StepChain;
    run: (opts: { cwd: string }) => Promise<unknown>;
  };
  const chain = wf as unknown as StepChain;

  await chain
    .step('setup-branch', {
      type: 'deterministic',
      command: [
        'set -e',
        'git config user.email "agent@agent-relay.com"',
        'git config user.name "Migration Emergency Bot"',
        // Explicitly base the branch on origin/main rather than the caller's
        // current HEAD — guards against accidentally inheriting unrelated
        // commits if launched from the wrong branch.
        'git fetch origin main --quiet',
        'git checkout -B ' + BRANCH + ' origin/main',
        'git log -1 --oneline',
        'echo SETUP_BRANCH_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('install-deps', {
      type: 'deterministic',
      dependsOn: ['setup-branch'],
      command: [
        'set -e',
        'mkdir -p .logs',
        'npm install --legacy-peer-deps --no-audit --no-fund > .logs/npm-install.log 2>&1',
        'tail -10 .logs/npm-install.log',
        'echo INSTALL_DEPS_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('preflight', {
      type: 'deterministic',
      dependsOn: ['install-deps'],
      command: [
        'set -e',
        'BRANCH_NOW=$(git rev-parse --abbrev-ref HEAD)',
        'if [ "$BRANCH_NOW" != "' + BRANCH + '" ]; then echo "ERROR: wrong branch (got $BRANCH_NOW)"; exit 1; fi',
        'ALLOWED_DIRTY="' + ALLOWED_DIRTY + '"',
        'DIRTY=$({ git diff --name-only; git ls-files --others --exclude-standard; } | sort -u | grep -vE "^(${ALLOWED_DIRTY})$" || true)',
        'if [ -n "$DIRTY" ]; then echo "ERROR: unexpected drift:"; echo "$DIRTY"; exit 1; fi',
        'aws --profile ' + AWS_PROFILE + ' --region ' + AWS_REGION + ' sts get-caller-identity > /dev/null || (echo "ERROR: AWS profile unavailable"; exit 1)',
        'mkdir -p docs/incidents .logs',
        'echo PREFLIGHT_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('read-web-infra', {
      type: 'deterministic',
      dependsOn: ['preflight'],
      command: 'cat infra/web.ts',
      captureOutput: true,
      failOnError: true,
    })
    .step('read-admin-infra', {
      type: 'deterministic',
      dependsOn: ['preflight'],
      command: 'cat infra/admin.ts',
      captureOutput: true,
      failOnError: true,
    })

    .step('edit-web-reserved-concurrency', {
      agent: 'sre-impl',
      dependsOn: ['read-web-infra'],
      task: [
        'Edit infra/web.ts to add reservedConcurrency on the user-facing SST function(s).',
        '',
        'Current infra/web.ts:',
        '{{steps.read-web-infra.output}}',
        '',
        'Target: cloud-web (OpenNext) Lambda reservedConcurrency = ' + RESERVED_CONCURRENCY.cloudWeb + '; relay-web Lambda reservedConcurrency = ' + RESERVED_CONCURRENCY.relayWeb + '.',
        '',
        'SST exposes this via transform.function or the resource config directly. Confirm by reading node_modules/sst/dist/components/aws/ if unsure; do NOT guess.',
        '',
        'Rules: only ADD, do not lower existing values; comment cites docs/incidents/2026-05-14-throttle-storm.md; only edit infra/web.ts.',
        '',
        'Post EDIT_WEB_DONE.',
      ].join('\n'),
      verification: { type: 'exit_code' },
    })
    .step('verify-web-edit', {
      type: 'deterministic',
      dependsOn: ['edit-web-reserved-concurrency'],
      command: [
        'set -e',
        'if git diff --quiet infra/web.ts; then echo "FAIL: no diff in infra/web.ts"; exit 1; fi',
        // Assert exact target values, not just token presence, so the gate
        // catches "agent edited but used the wrong number" cases.
        'grep -qE "server\\(args\\)" infra/web.ts || (echo "FAIL: missing server transform"; exit 1)',
        'grep -qE "imageOptimizer\\(args\\)" infra/web.ts || (echo "FAIL: missing imageOptimizer transform"; exit 1)',
        'grep -qE "args\\.reservedConcurrentExecutions = 5" infra/web.ts || (echo "FAIL: cloud-web reserve != 5"; exit 1)',
        'grep -qE "args\\.reservedConcurrentExecutions = 1" infra/web.ts || (echo "FAIL: imageOptimizer reserve != 1"; exit 1)',
        'echo VERIFY_WEB_EDIT_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('edit-admin-reserved-concurrency', {
      agent: 'sre-impl',
      dependsOn: ['read-admin-infra', 'verify-web-edit'],
      task: [
        'Edit infra/admin.ts to add reservedConcurrency = ' + RESERVED_CONCURRENCY.admin + ' on the admin SST function.',
        '',
        'Current infra/admin.ts:',
        '{{steps.read-admin-infra.output}}',
        '',
        'Same rules as the web edit: only ADD, rationale comment, no application code.',
        '',
        'Post EDIT_ADMIN_DONE.',
      ].join('\n'),
      verification: { type: 'exit_code' },
    })
    .step('verify-admin-edit', {
      type: 'deterministic',
      dependsOn: ['edit-admin-reserved-concurrency'],
      command: [
        'set -e',
        'if git diff --quiet infra/admin.ts; then echo "FAIL: no diff in infra/admin.ts"; exit 1; fi',
        'grep -qE "server\\(args\\)" infra/admin.ts || (echo "FAIL: missing server transform"; exit 1)',
        'grep -qE "args\\.reservedConcurrentExecutions = 1" infra/admin.ts || (echo "FAIL: admin reserve != 1"; exit 1)',
        'echo VERIFY_ADMIN_EDIT_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('sst-typecheck', {
      type: 'deterministic',
      dependsOn: ['verify-admin-edit'],
      command: '(cd infra && npx tsc --noEmit) 2>&1 | tail -30 && echo SST_TYPECHECK_OK',
      captureOutput: true,
      failOnError: false,
    })
    .step('fix-sst-typecheck', {
      agent: 'sre-impl',
      dependsOn: ['sst-typecheck'],
      task: 'Fix any TypeScript errors. Output:\n{{steps.sst-typecheck.output}}\nIterate until clean.',
      verification: { type: 'exit_code' },
    })
    .step('sst-typecheck-final', {
      type: 'deterministic',
      dependsOn: ['fix-sst-typecheck'],
      command: '(cd infra && npx tsc --noEmit) && echo SST_TYPECHECK_FINAL_OK',
      captureOutput: true,
      failOnError: true,
    })

    .step('cloudwatch-run-queries', {
      type: 'deterministic',
      dependsOn: ['preflight'],
      command: [
        'set -e',
        'START_MS=$(node -e "console.log(Math.floor(new Date(\'2026-05-14T10:00:00Z\').getTime() / 1000))")',
        'END_MS=$(node -e "console.log(Math.floor(new Date(\'2026-05-14T11:30:00Z\').getTime() / 1000))")',
        'LOG_GROUP=/aws/lambda/' + HOT_LAMBDA,
        'QUERY="fields @timestamp, @message | parse @message /\\"path\\":\\"(?<path>[^\\"]+)\\"/ | filter ispresent(path) | stats count(*) as hits by path | sort hits desc | limit 20"',
        'QID=$(aws --profile ' + AWS_PROFILE + ' --region ' + AWS_REGION + ' logs start-query --log-group-name "$LOG_GROUP" --start-time "$START_MS" --end-time "$END_MS" --query-string "$QUERY" --query "queryId" --output text || echo "")',
        'echo "query id: $QID"',
        'if [ -n "$QID" ] && [ "$QID" != "None" ]; then for i in $(seq 1 30); do STATUS=$(aws --profile ' + AWS_PROFILE + ' --region ' + AWS_REGION + ' logs get-query-results --query-id "$QID" --query "status" --output text 2>/dev/null || echo ""); if [ "$STATUS" = "Complete" ]; then break; fi; sleep 2; done; aws --profile ' + AWS_PROFILE + ' --region ' + AWS_REGION + ' logs get-query-results --query-id "$QID" --output json > .logs/cw-result-top-paths.json 2>&1 || true; head -50 .logs/cw-result-top-paths.json; fi',
        'echo CW_RESULTS_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: false,
    })

    .step('write-incident-report', {
      agent: 'sre-analyst',
      dependsOn: ['cloudwatch-run-queries'],
      task: [
        'Write docs/incidents/2026-05-14-throttle-storm.md.',
        '',
        'Inputs:',
        '— CloudWatch output: {{steps.cloudwatch-run-queries.output}}',
        '— Storm: 27K invocations / 5 min on ' + HOT_LAMBDA + ' starting ~10:12 UTC on 2026-05-14.',
        '— Account-level Lambda concurrency cap: 10. Quota increase denied.',
        '',
        'Structure: # Symptom, ## Root cause, ## Likely caller (from CloudWatch), ## Containment (this PR — cloud-web=' + RESERVED_CONCURRENCY.cloudWeb + ', relay-web=' + RESERVED_CONCURRENCY.relayWeb + ', admin=' + RESERVED_CONCURRENCY.admin + '), ## What this does NOT fix, ## References (cloud#469).',
        '',
        'Fill from actual CloudWatch results — no placeholders.',
      ].join('\n'),
      verification: { type: 'file_exists', value: 'docs/incidents/2026-05-14-throttle-storm.md' },
    })

    .step('final-review', {
      agent: 'sre-analyst',
      dependsOn: ['sst-typecheck-final', 'write-incident-report'],
      task: [
        'Final sanity check. Write the result to .logs/emergency-review.md.',
        '',
        'Checks:',
        '1. git diff infra/web.ts infra/admin.ts shows ONLY reservedConcurrentExecutions added.',
        '2. Comment cites docs/incidents/2026-05-14-throttle-storm.md.',
        '3. Incident report has actual data, not placeholders.',
        '',
        'If all pass: write APPROVED (exactly).',
      ].join('\n'),
      verification: { type: 'file_exists', value: '.logs/emergency-review.md' },
    })
    .step('review-gate', {
      type: 'deterministic',
      dependsOn: ['final-review'],
      command: 'grep -qxF APPROVED .logs/emergency-review.md || (cat .logs/emergency-review.md; exit 1)',
      captureOutput: true,
      failOnError: true,
    })

    .step('commit', {
      type: 'deterministic',
      dependsOn: ['review-gate'],
      command: [
        'set -e',
        'git add infra/web.ts infra/admin.ts',
        'git add docs/incidents/2026-05-14-throttle-storm.md',
        'MSG=$(mktemp)',
        'printf "%s\\n" "fix(infra): reservedConcurrency carve-up — Lambda throttle containment" "" "Wave 0 emergency containment. AWS account capped at 10 concurrent Lambdas (quota denied). Partition: cloud-web=' + RESERVED_CONCURRENCY.cloudWeb + ' relay-web=' + RESERVED_CONCURRENCY.relayWeb + ' admin=' + RESERVED_CONCURRENCY.admin + '." "" "Incident: docs/incidents/2026-05-14-throttle-storm.md" "" "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>" > "$MSG"',
        'git commit -F "$MSG"',
        'rm -f "$MSG"',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })
    .step('push-and-pr', {
      type: 'deterministic',
      dependsOn: ['commit'],
      command: [
        'set -e',
        'git push -u origin ' + BRANCH,
        'BODY=$(mktemp)',
        'printf "%s\\n" "## Summary" "" "Emergency reservedConcurrency carve-up. AWS denied the quota increase. Partition the 10-slot pool so webhook storms cannot starve the user-facing tier." "" "## Reviewers" "" "ops:hotfix — fast-track. Please address coderabbit + codex bot feedback." "" "🤖 Generated with [Claude Code](https://claude.com/claude-code)" > "$BODY"',
        'gh pr create --title "fix(infra): reservedConcurrency carve-up — Lambda throttle containment" --body-file "$BODY" --base main --label ops:hotfix | tee .logs/emergency-pr-url.txt',
        'rm -f "$BODY"',
        'echo "PR: $(cat .logs/emergency-pr-url.txt)"',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .onError('fail-fast')
    .run({ cwd: process.cwd() });

  console.log('Workflow status:', 'done');
}

runWorkflow().catch((error) => {
  console.error(error);
  process.exit(1);
});
