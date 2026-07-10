import { workflow } from '@relayflows/core';
import { ClaudeModels, CodexModels } from '@agent-relay/config';

/**
 * Sub 03 — declare WebhookMsdBackendUrl / WebhookMsdBackendToken SST
 * secrets, link + env-wire them on the web Nextjs site.
 */

async function runWorkflow() {
  const result = await workflow('twc-03-infra-wiring')
    .description('Declare per-consumer SST secrets and wire them as env vars.')
    .pattern('dag')
    .channel('wf-twc-03')
    .maxConcurrency(3)
    .timeout(1_800_000)

    .agent('impl', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      preset: 'worker',
      role: 'Edits infra/secrets.ts + infra/web.ts.',
      retries: 2,
    })
    .agent('claude-reviewer', {
      cli: 'claude',
      model: ClaudeModels.OPUS,
      preset: 'reviewer',
      role: 'Reviews SST shape + env wiring.',
      retries: 1,
    })
    .agent('codex-reviewer', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      preset: 'reviewer',
      role: 'Reviews naming + ordering consistency.',
      retries: 1,
    })

    .step('preflight', {
      type: 'deterministic',
      command: [
        'set -euo pipefail',
        'test -f packages/web/lib/integrations/webhook-consumers.config.ts || { echo "sub 01 missing"; exit 1; }',
        'test -f infra/secrets.ts',
        'test -f infra/web.ts',
        'grep -q "WEBHOOK_MSD_BACKEND_URL" packages/web/lib/integrations/webhook-consumers.config.ts || { echo "config module does not reference expected env vars"; exit 1; }',
        'echo "Preflight OK"',
      ].join('\n'),
      captureOutput: true,
      failOnError: true,
    })

    .step('read-secrets', {
      type: 'deterministic',
      dependsOn: ['preflight'],
      command: 'cat infra/secrets.ts',
      captureOutput: true,
      failOnError: true,
    })

    .step('edit-secrets', {
      agent: 'impl',
      dependsOn: ['read-secrets'],
      task: `Edit infra/secrets.ts.

Current:
{{steps.read-secrets.output}}

Add two SST secrets colocated with webhookConsumersJson (same style, alphabetical):
  export const webhookMsdBackendUrl = new sst.Secret("WebhookMsdBackendUrl");
  export const webhookMsdBackendToken = new sst.Secret("WebhookMsdBackendToken");

Do NOT remove webhookConsumersJson (still needed during deprecation window).

Only edit this file.`,
      verification: { type: 'exit_code' },
    })

    .step('verify-secrets-edit', {
      type: 'deterministic',
      dependsOn: ['edit-secrets'],
      command: [
        'set -euo pipefail',
        'F=infra/secrets.ts',
        'git diff --quiet "$F" && { echo "NOT MODIFIED"; exit 1; }',
        'grep -q "WebhookMsdBackendUrl" "$F"',
        'grep -q "WebhookMsdBackendToken" "$F"',
        'grep -q "webhookConsumersJson" "$F" || { echo "legacy secret accidentally removed"; exit 1; }',
        'echo "SECRETS OK"',
      ].join('\n'),
      captureOutput: true,
      failOnError: true,
    })

    .step('read-web', {
      type: 'deterministic',
      dependsOn: ['verify-secrets-edit'],
      command: 'cat infra/web.ts',
      captureOutput: true,
      failOnError: true,
    })

    .step('edit-web', {
      agent: 'impl',
      dependsOn: ['read-web'],
      task: `Edit infra/web.ts.

Current:
{{steps.read-web.output}}

Changes:
1. Extend the import from "./secrets" to include webhookMsdBackendUrl + webhookMsdBackendToken (alphabetical).
2. Add both to the sst.aws.Nextjs link: [...] array (alphabetical).
3. In environment: {...} add:
     WEBHOOK_MSD_BACKEND_URL: webhookMsdBackendUrl.value,
     WEBHOOK_MSD_BACKEND_TOKEN: webhookMsdBackendToken.value,
   Place near WEBHOOK_CONSUMERS_JSON if it exists.

Do NOT remove webhookConsumersJson link or WEBHOOK_CONSUMERS_JSON env var.

Only edit this file.`,
      verification: { type: 'exit_code' },
    })

    .step('verify-web-edit', {
      type: 'deterministic',
      dependsOn: ['edit-web'],
      command: [
        'set -euo pipefail',
        'F=infra/web.ts',
        'git diff --quiet "$F" && { echo "NOT MODIFIED"; exit 1; }',
        'grep -q "webhookMsdBackendUrl" "$F"',
        'grep -q "webhookMsdBackendToken" "$F"',
        'grep -q "WEBHOOK_MSD_BACKEND_URL" "$F"',
        'grep -q "WEBHOOK_MSD_BACKEND_TOKEN" "$F"',
        'grep -q "webhookConsumersJson" "$F" || { echo "legacy secret link accidentally removed"; exit 1; }',
        'echo "WEB OK"',
      ].join('\n'),
      captureOutput: true,
      failOnError: true,
    })

    .step('read-for-review', {
      type: 'deterministic',
      dependsOn: ['verify-web-edit'],
      command: [
        'echo "===== infra/secrets.ts diff ====="',
        'git diff infra/secrets.ts',
        'echo "" && echo "===== infra/web.ts diff ====="',
        'git diff infra/web.ts',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('claude-review', {
      agent: 'claude-reviewer',
      dependsOn: ['read-for-review'],
      task: `Review.

{{steps.read-for-review.output}}

Check: secret names match convention (PascalCase matching string IDs); both linked to web Nextjs site; env var names exactly WEBHOOK_MSD_BACKEND_URL and WEBHOOK_MSD_BACKEND_TOKEN; legacy webhookConsumersJson preserved.

Verdict: CLAUDE_REVIEW_VERDICT: PASS | CHANGES_REQUESTED + numbered items.`,
    })

    .step('codex-review', {
      agent: 'codex-reviewer',
      dependsOn: ['read-for-review'],
      task: `Review.

{{steps.read-for-review.output}}

Check: naming cluster with other webhook* secrets; no duplicate imports; no stray env vars.

Verdict format same.`,
    })

    .step('apply-review-feedback', {
      agent: 'impl',
      dependsOn: ['claude-review', 'codex-review'],
      task: `Apply feedback.

Claude: {{steps.claude-review.output}}
Codex:  {{steps.codex-review.output}}

If both PASS, print NO CHANGES and exit. Otherwise fix infra/secrets.ts + infra/web.ts only.`,
      verification: { type: 'exit_code' },
    })

    .step('typecheck', {
      type: 'deterministic',
      dependsOn: ['apply-review-feedback'],
      command: 'npx tsc -p packages/web/tsconfig.json --noEmit 2>&1 | tail -30',
      captureOutput: true,
      failOnError: true,
    })

    .step('commit', {
      type: 'deterministic',
      dependsOn: ['typecheck'],
      command: [
        'set -euo pipefail',
        'git add infra/secrets.ts infra/web.ts',
        'git diff --cached --quiet && { echo "Nothing to commit"; exit 1; }',
        'git commit -m "feat(infra): declare per-consumer SST secrets for typed webhook consumers"',
        'git log -1 --oneline',
      ].join('\n'),
      captureOutput: true,
      failOnError: true,
    })

    .onError('retry', { maxRetries: 2, retryDelayMs: 10_000 })
    .run({ cwd: process.cwd() });

  console.log('Workflow status:', result.status);
  if (result.status != null && result.status !== 'completed') {
    throw new Error(`sub-03 infra-wiring failed: ${String(result.status)}`);
  }
}

runWorkflow().catch((error) => {
  console.error(error);
  process.exit(1);
});
