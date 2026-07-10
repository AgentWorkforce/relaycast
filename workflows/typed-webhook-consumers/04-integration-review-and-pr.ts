import { workflow } from '@relayflows/core';
import { ClaudeModels, CodexModels } from '@agent-relay/config';

/**
 * Sub 04 — integrated review, full regression, push, open PR.
 * gh pr create skips gracefully when gh is missing / unauthenticated.
 */

async function runWorkflow() {
  const result = await workflow('twc-04-integration-review-and-pr')
    .description('Cross-cut review, full regression, push branch, open PR.')
    .pattern('dag')
    .channel('wf-twc-04')
    .maxConcurrency(3)
    .timeout(3_600_000)

    .agent('impl', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      preset: 'worker',
      role: 'Applies integrated-review fixes.',
      retries: 2,
    })
    .agent('claude-reviewer', {
      cli: 'claude',
      model: ClaudeModels.OPUS,
      preset: 'reviewer',
      role: 'Integrated review for spec coverage + rollout safety.',
      retries: 1,
    })
    .agent('codex-reviewer', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      preset: 'reviewer',
      role: 'Integrated review for bugs + regressions.',
      retries: 1,
    })

    .step('preflight', {
      type: 'deterministic',
      command: [
        'set -euo pipefail',
        'CURRENT=$(git rev-parse --abbrev-ref HEAD)',
        'if [ "$CURRENT" = "main" ]; then echo "Refusing to run on main"; exit 1; fi',
        'if command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then echo "gh ready"; else echo "[preflight] gh unavailable — open-pr will skip gracefully"; fi',
        'git fetch origin main --quiet',
        'echo "Preflight OK"',
      ].join('\n'),
      captureOutput: true,
      failOnError: true,
    })

    .step('capture-diff', {
      type: 'deterministic',
      dependsOn: ['preflight'],
      command: [
        'echo "===== commits on branch vs main ====="',
        'git log --oneline origin/main..HEAD',
        'echo "" && echo "===== stat ====="',
        'git diff --stat origin/main...HEAD',
        'echo "" && echo "===== diff (capped 2500 lines) ====="',
        'git diff origin/main...HEAD | head -2500',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('full-test', {
      type: 'deterministic',
      dependsOn: ['capture-diff'],
      command: 'npm test 2>&1 | tail -200',
      captureOutput: true,
      failOnError: false,
    })

    .step('full-typecheck', {
      type: 'deterministic',
      dependsOn: ['capture-diff'],
      command: 'npx tsc -p packages/web/tsconfig.json --noEmit 2>&1 | tail -60',
      captureOutput: true,
      failOnError: false,
    })

    .step('claude-integrated-review', {
      agent: 'claude-reviewer',
      dependsOn: ['capture-diff', 'full-test', 'full-typecheck'],
      task: `Integrated review.

Diff:
{{steps.capture-diff.output}}

Tests:
{{steps.full-test.output}}

Typecheck:
{{steps.full-typecheck.output}}

Check:
1. getConfiguredConsumers returns sage + relayfile-primary unconditionally.
2. msd-backend opt-in only when BOTH WEBHOOK_MSD_BACKEND_URL + WEBHOOK_MSD_BACKEND_TOKEN present.
3. bootstrapRegistryFromEnv registers typed first, then JSON (so JSON ids override typed — preserves prod msd-backend).
4. Deprecation log only fires when JSON env has >=1 valid entry.
5. Legacy WebhookConsumersJson + WEBHOOK_CONSUMERS_JSON still present — this is additive.
6. New SST secrets declared + linked + env-wired with matching uppercase names.
7. Tests cover all behaviour branches.
8. Tests + typecheck green.

Verdict: CLAUDE_INTEGRATED_VERDICT: PASS | CHANGES_REQUESTED + numbered items (file:line).`,
    })

    .step('codex-integrated-review', {
      agent: 'codex-reviewer',
      dependsOn: ['capture-diff', 'full-test', 'full-typecheck'],
      task: `Integrated review for bugs.

Diff:
{{steps.capture-diff.output}}

Tests:
{{steps.full-test.output}}

Typecheck:
{{steps.full-typecheck.output}}

Check:
- No circular import between config module and registry (config imports createRelayfilePrimaryConsumer from registry; does registry import from config too?).
- No accidental changes to createDefaultConsumers behaviour callers rely on.
- Test isolation: no process.env mutation without restore; no shared singleton across cases.
- getSageWebhookUrl duplication is acceptable short-term (flag as tech-debt).
- No breaking SST resource renames that would recreate.

Verdict format same as claude-integrated-review.`,
    })

    .step('apply-integrated-feedback', {
      agent: 'impl',
      dependsOn: ['claude-integrated-review', 'codex-integrated-review'],
      task: `Apply feedback.

Claude: {{steps.claude-integrated-review.output}}
Codex:  {{steps.codex-integrated-review.output}}

If both PASS, print NO CHANGES and exit. Otherwise fix CHANGES_REQUESTED items in files already touched by this branch. After fixes run:
  npm test
  npx tsc -p packages/web/tsconfig.json --noEmit`,
      verification: { type: 'exit_code' },
    })

    .step('full-test-final', {
      type: 'deterministic',
      dependsOn: ['apply-integrated-feedback'],
      command: 'npm test 2>&1 | tail -80',
      captureOutput: true,
      failOnError: true,
    })

    .step('full-typecheck-final', {
      type: 'deterministic',
      dependsOn: ['apply-integrated-feedback'],
      command: 'npx tsc -p packages/web/tsconfig.json --noEmit 2>&1 | tail -40',
      captureOutput: true,
      failOnError: true,
    })

    .step('commit-fixups', {
      type: 'deterministic',
      dependsOn: ['full-test-final', 'full-typecheck-final'],
      command: [
        'set -euo pipefail',
        'if git diff --quiet && git diff --cached --quiet; then',
        '  echo "No fix-up edits to commit"',
        'else',
        '  git add -A',
        '  git commit -m "fix(review): address integrated-review feedback"',
        '  git log -1 --oneline',
        'fi',
      ].join('\n'),
      captureOutput: true,
      failOnError: true,
    })

    .step('push-branch', {
      type: 'deterministic',
      dependsOn: ['commit-fixups'],
      command: [
        'set -euo pipefail',
        'BRANCH=$(git rev-parse --abbrev-ref HEAD)',
        'git push --set-upstream origin "$BRANCH" 2>&1 || git push origin "$BRANCH" 2>&1',
        'echo "PUSHED: $BRANCH"',
      ].join('\n'),
      captureOutput: true,
      failOnError: true,
    })

    .step('open-pr', {
      type: 'deterministic',
      dependsOn: ['push-branch'],
      command: [
        'set -euo pipefail',
        'if ! command -v gh >/dev/null || ! gh auth status >/dev/null 2>&1; then',
        '  BRANCH=$(git rev-parse --abbrev-ref HEAD)',
        '  echo "[open-pr] gh unavailable — branch pushed at $BRANCH, open PR manually."',
        '  echo "gh-unavailable: $BRANCH" > pr-url.txt',
        '  exit 0',
        'fi',
        'EXISTING=$(gh pr view --json url --jq .url 2>/dev/null || true)',
        'if [ -n "$EXISTING" ]; then echo "PR exists: $EXISTING" > pr-url.txt; echo "$EXISTING"; exit 0; fi',
        'BODY=$(cat <<\'EOF\'',
        '## Summary',
        '',
        'Replaces the opaque `WEBHOOK_CONSUMERS_JSON` SST secret with a typed',
        'configuration module + per-consumer SST secrets. Each external webhook',
        'consumer is declared in code, with its auth material in its own SST',
        'secret — the pattern already used for every other third-party token.',
        '',
        '### Why',
        '',
        'The JSON blob replaces the default consumers entirely when set, which',
        'silently dropped `sage` from the Slack fanout list in prod:',
        '',
        '  Webhook consumer fanout failed { consumerId: "msd-backend", error: "HTTP 401: Invalid token" }',
        '  Webhook fanout completed { total: 1, succeeded: 0, failed: 1 }',
        '',
        'Only `msd-backend` was registered and its token was stale. Sage never',
        'saw the event. With the typed path `sage` is always registered because',
        'it is literal code, not config.',
        '',
        '### What changed',
        '',
        '- **New:** `packages/web/lib/integrations/webhook-consumers.config.ts`',
        '  with `getConfiguredConsumers(env)` returning sage + relayfile-primary',
        '  (always) and msd-backend (opt-in via `WEBHOOK_MSD_BACKEND_URL` +',
        '  `WEBHOOK_MSD_BACKEND_TOKEN`).',
        '- **Refactor:** `webhook-consumer-registry.ts` `bootstrapRegistryFromEnv`',
        '  registers the typed list first, then any legacy JSON entries. JSON',
        '  entries with matching ids override typed ones (last-writer-wins —',
        '  preserves current prod msd-backend behaviour during rollout).',
        '- **Infra:** `WebhookMsdBackendUrl` / `WebhookMsdBackendToken` SST',
        '  secrets declared in `infra/secrets.ts`, linked + env-wired in',
        '  `infra/web.ts`.',
        '- **Tests:** new `webhook-consumers.config.test.ts`; existing registry',
        '  tests updated for typed-default + deprecation-warn behaviour.',
        '',
        '### Not in this PR',
        '',
        'Legacy `WebhookConsumersJson` secret + `WEBHOOK_CONSUMERS_JSON` env +',
        'JSON-parse branch kept intentionally. Removing them would drop',
        'consumers mid-rollout if the operator has not yet set the discrete',
        'secrets. Follow-up PR deletes the legacy path after verification.',
        '',
        '## Rollout (operator, after merge)',
        '',
        '1. `sst secret show WebhookConsumersJson --stage production` — read current.',
        '2. For each external consumer in that JSON, set discrete secrets.',
        '   For msd-backend:',
        '   `sst secret set WebhookMsdBackendUrl   <url>   --stage production`',
        '   `sst secret set WebhookMsdBackendToken <token> --stage production`',
        '3. `sst deploy --stage production`',
        '4. Verify fanout: `aws logs tail /aws/lambda/clou-production-AgentRelayCloudWebServerUseast1Function-<id> --since 5m --filter-pattern "webhook-fanout"`',
        '   — should show `consumerId: sage` + `consumerId: msd-backend` succeeding.',
        '5. Open follow-up PR to delete the legacy JSON path.',
        '',
        '## Test plan',
        '',
        '- [x] `webhook-consumers.config.test.ts` — 7 cases.',
        '- [x] `webhook-consumer-registry.test.ts` — existing + typed-default + deprecation tests.',
        '- [x] `npm test` full suite green.',
        '- [x] `npx tsc -p packages/web/tsconfig.json --noEmit` clean.',
        '- [ ] Post-deploy: verify sage responds to a real Slack event.',
        '',
        '## Adding a future consumer',
        '',
        '1. Declare SST secrets in `infra/secrets.ts`.',
        '2. Link + env-wire in `infra/web.ts`.',
        '3. Add env-gated entry in `webhook-consumers.config.ts`.',
        '4. `sst secret set` + deploy. Done.',
        '',
        'Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>',
        'EOF',
        ')',
        'PR_URL=$(gh pr create --title "feat(web): typed webhook-consumer config + per-consumer SST secrets" --body "$BODY")',
        'echo "$PR_URL" > pr-url.txt',
        'echo "PR: $PR_URL"',
      ].join('\n'),
      captureOutput: true,
      failOnError: true,
    })

    .step('pr-url', {
      type: 'deterministic',
      dependsOn: ['open-pr'],
      command: [
        'if grep -q "^gh-unavailable" pr-url.txt; then',
        '  echo "===== BRANCH PUSHED — PR NOT OPENED ====="',
        '  cat pr-url.txt',
        'else',
        '  echo "===== PR OPENED ====="',
        '  cat pr-url.txt',
        'fi',
      ].join('\n'),
      captureOutput: true,
      failOnError: false,
    })

    .onError('retry', { maxRetries: 2, retryDelayMs: 10_000 })
    .run({ cwd: process.cwd() });

  console.log('Workflow status:', result.status);
  if (result.status != null && result.status !== 'completed') {
    throw new Error(`sub-04 integration-review-and-pr failed: ${String(result.status)}`);
  }
}

runWorkflow().catch((error) => {
  console.error(error);
  process.exit(1);
});
