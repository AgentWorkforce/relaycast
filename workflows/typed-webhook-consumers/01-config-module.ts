import { workflow } from '@relayflows/core';
import { ClaudeModels, CodexModels } from '@agent-relay/config';

/**
 * Sub 01 — create the typed consumer config module + tests.
 *
 * Deliverables:
 *   packages/web/lib/integrations/webhook-consumers.config.ts
 *   packages/web/lib/integrations/webhook-consumers.config.test.ts
 *
 * Exports getConfiguredConsumers(env) returning:
 *   - sage (slack, always on)
 *   - relayfile-primary (always on — github + linear local handler)
 *   - msd-backend (opt-in via WEBHOOK_MSD_BACKEND_URL + WEBHOOK_MSD_BACKEND_TOKEN)
 */

async function runWorkflow() {
  const result = await workflow('twc-01-config-module')
    .description('Create typed webhook-consumers config module + tests.')
    .pattern('dag')
    .channel('wf-twc-01')
    .maxConcurrency(3)
    .timeout(1_800_000)

    .agent('impl', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      preset: 'worker',
      role: 'Creates webhook-consumers.config.ts + tests.',
      retries: 2,
    })
    .agent('claude-reviewer', {
      cli: 'claude',
      model: ClaudeModels.OPUS,
      preset: 'reviewer',
      role: 'Reviews typed config for API shape, env-gating correctness, test coverage.',
      retries: 1,
    })
    .agent('codex-reviewer', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      preset: 'reviewer',
      role: 'Reviews for code quality and test isolation.',
      retries: 1,
    })

    .step('preflight', {
      type: 'deterministic',
      command: [
        'set -euo pipefail',
        'test -f packages/web/lib/integrations/webhook-consumer-registry.ts || { echo "registry missing"; exit 1; }',
        '! test -f packages/web/lib/integrations/webhook-consumers.config.ts || { echo "config already exists"; exit 1; }',
        'echo "Preflight OK"',
      ].join('\n'),
      captureOutput: true,
      failOnError: true,
    })

    .step('read-registry', {
      type: 'deterministic',
      dependsOn: ['preflight'],
      command: 'sed -n "1,340p" packages/web/lib/integrations/webhook-consumer-registry.ts',
      captureOutput: true,
      failOnError: true,
    })

    .step('read-env-helper', {
      type: 'deterministic',
      dependsOn: ['preflight'],
      command: 'cat packages/web/lib/env.ts 2>/dev/null || echo "(no env.ts)"',
      captureOutput: true,
      failOnError: false,
    })

    .step('write-module', {
      agent: 'impl',
      dependsOn: ['read-registry', 'read-env-helper'],
      task: `Create packages/web/lib/integrations/webhook-consumers.config.ts.

Registry contents for reference (import types + createRelayfilePrimaryConsumer from it, DO NOT redefine):
{{steps.read-registry.output}}

optionalEnv helper:
{{steps.read-env-helper.output}}

Requirements:

1. Import WebhookConsumer type + createRelayfilePrimaryConsumer + WebhookProvider from ./webhook-consumer-registry.js.

2. Export ONE function:
     export function getConfiguredConsumers(env: Record<string, string | undefined>): WebhookConsumer[]

   Returns, in order:
     a. sage — slack, always on. url from getSageWebhookUrl(env):
        - read SAGE_WEBHOOK_URL env var
        - fall back to http://localhost:3777 when NODE_ENV=development, else https://sage.agentrelay.com
        - trim trailing slashes, append /api/webhooks/slack if not already there
     b. relayfile-primary — call createRelayfilePrimaryConsumer()
     c. msd-backend — gated on BOTH WEBHOOK_MSD_BACKEND_URL and WEBHOOK_MSD_BACKEND_TOKEN being non-empty.
        Shape: { id: 'msd-backend', provider: 'slack', kind: 'http', url, headers: { Authorization: 'Bearer ' + token } }

3. Private helper envGatedHttpConsumer({ id, provider, urlEnv, tokenEnv, env }): WebhookConsumer | null — returns null when either env missing/empty.

4. readEnvString(env, name): string | undefined — trimmed value or undefined; treats empty string as undefined.

IMPORTANT: write the file to disk, use .js extensions for imports (NodeNext), do not modify webhook-consumer-registry.ts.`,
      verification: { type: 'file_exists', value: 'packages/web/lib/integrations/webhook-consumers.config.ts' },
    })

    .step('verify-module', {
      type: 'deterministic',
      dependsOn: ['write-module'],
      command: [
        'set -euo pipefail',
        'F=packages/web/lib/integrations/webhook-consumers.config.ts',
        'test -f "$F"',
        'grep -q "export function getConfiguredConsumers" "$F" || { echo "missing export"; exit 1; }',
        'grep -q "createRelayfilePrimaryConsumer" "$F" || { echo "relayfile-primary not wired"; exit 1; }',
        'grep -q "WEBHOOK_MSD_BACKEND_URL" "$F" || { echo "msd URL env not referenced"; exit 1; }',
        'grep -q "WEBHOOK_MSD_BACKEND_TOKEN" "$F" || { echo "msd token env not referenced"; exit 1; }',
        'echo "MODULE OK"',
      ].join('\n'),
      captureOutput: true,
      failOnError: true,
    })

    .step('write-tests', {
      agent: 'impl',
      dependsOn: ['verify-module'],
      task: `Create packages/web/lib/integrations/webhook-consumers.config.test.ts using node:test + node:assert (match the repo's test style — see webhook-consumer-registry.test.ts).

Cases:
1. default env → exactly 2 consumers: sage (slack) + relayfile-primary
2. WEBHOOK_MSD_BACKEND_URL + WEBHOOK_MSD_BACKEND_TOKEN set → 3 consumers including msd-backend with kind:'http', matching url, headers.Authorization = 'Bearer ' + token
3. only URL set (no token) → msd-backend absent
4. only token set (no URL) → msd-backend absent
5. both empty string → msd-backend absent
6. SAGE_WEBHOOK_URL override → sage consumer url is override + /api/webhooks/slack
7. NODE_ENV=development with no override → sage url starts with http://localhost: and ends with /api/webhooks/slack

IMPORTANT: write file to disk, do not modify any other file.`,
      verification: { type: 'file_exists', value: 'packages/web/lib/integrations/webhook-consumers.config.test.ts' },
    })

    .step('verify-tests', {
      type: 'deterministic',
      dependsOn: ['write-tests'],
      command: [
        'set -euo pipefail',
        'F=packages/web/lib/integrations/webhook-consumers.config.test.ts',
        'test -f "$F"',
        'grep -q "describe" "$F"',
        'grep -q "getConfiguredConsumers" "$F"',
        'echo "TESTS OK"',
      ].join('\n'),
      captureOutput: true,
      failOnError: true,
    })

    .step('read-for-review', {
      type: 'deterministic',
      dependsOn: ['verify-tests'],
      command: [
        'echo "===== config.ts ====="',
        'cat packages/web/lib/integrations/webhook-consumers.config.ts',
        'echo "" && echo "===== config.test.ts ====="',
        'cat packages/web/lib/integrations/webhook-consumers.config.test.ts',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('claude-review', {
      agent: 'claude-reviewer',
      dependsOn: ['read-for-review'],
      task: `Review contract.

Source:
{{steps.read-for-review.output}}

Check: sage always included; relayfile-primary always included; msd-backend ONLY when BOTH URL + token non-empty (empty string treated as missing); Bearer auth shape; tests cover every branch.

Verdict format:
  CLAUDE_REVIEW_VERDICT: PASS
or
  CLAUDE_REVIEW_VERDICT: CHANGES_REQUESTED
  <numbered items, file:line>`,
    })

    .step('codex-review', {
      agent: 'codex-reviewer',
      dependsOn: ['read-for-review'],
      task: `Review quality.

Source:
{{steps.read-for-review.output}}

Check: env record not mutated; trailing slash normalization correct; .js extensions; envGatedHttpConsumer reusable; tests don't mutate process.env.

Verdict format same.`,
    })

    .step('apply-review-feedback', {
      agent: 'impl',
      dependsOn: ['claude-review', 'codex-review'],
      task: `Apply feedback.

Claude: {{steps.claude-review.output}}
Codex:  {{steps.codex-review.output}}

If both PASS, print NO CHANGES and exit. Otherwise fix every CHANGES_REQUESTED item in the two files only. Verify with:
  npx tsx --test packages/web/lib/integrations/webhook-consumers.config.test.ts`,
      verification: { type: 'exit_code' },
    })

    .step('run-tests', {
      type: 'deterministic',
      dependsOn: ['apply-review-feedback'],
      command: 'npx tsx --test packages/web/lib/integrations/webhook-consumers.config.test.ts 2>&1 | tail -80',
      captureOutput: true,
      failOnError: false,
    })

    .step('fix-tests', {
      agent: 'impl',
      dependsOn: ['run-tests'],
      task: `Fix failures.

{{steps.run-tests.output}}

If green, print TESTS GREEN and exit. Otherwise iterate until all pass. Do not weaken assertions.`,
      verification: { type: 'exit_code' },
    })

    .step('run-tests-final', {
      type: 'deterministic',
      dependsOn: ['fix-tests'],
      command: 'npx tsx --test packages/web/lib/integrations/webhook-consumers.config.test.ts 2>&1 | tail -40',
      captureOutput: true,
      failOnError: true,
    })

    .step('typecheck', {
      type: 'deterministic',
      dependsOn: ['run-tests-final'],
      command: 'npx tsc -p packages/web/tsconfig.json --noEmit 2>&1 | tail -40',
      captureOutput: true,
      failOnError: true,
    })

    .step('commit', {
      type: 'deterministic',
      dependsOn: ['typecheck'],
      command: [
        'set -euo pipefail',
        'git add packages/web/lib/integrations/webhook-consumers.config.ts packages/web/lib/integrations/webhook-consumers.config.test.ts',
        'git diff --cached --quiet && { echo "Nothing to commit"; exit 1; }',
        'git commit -m "feat(web): add typed webhook-consumers config module"',
        'git log -1 --oneline',
      ].join('\n'),
      captureOutput: true,
      failOnError: true,
    })

    .onError('retry', { maxRetries: 2, retryDelayMs: 10_000 })
    .run({ cwd: process.cwd() });

  console.log('Workflow status:', result.status);
  if (result.status != null && result.status !== 'completed') {
    throw new Error(`sub-01 config-module failed: ${String(result.status)}`);
  }
}

runWorkflow().catch((error) => {
  console.error(error);
  process.exit(1);
});
