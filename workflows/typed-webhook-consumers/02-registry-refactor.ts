import { workflow } from '@relayflows/core';
import { ClaudeModels, CodexModels } from '@agent-relay/config';

/**
 * Sub 02 — rewire bootstrapRegistryFromEnv to delegate to the typed
 * config module. Keep the JSON-parse branch as a deprecated fallback
 * with a warn log so prod doesn't lose consumers mid-rollout.
 */

async function runWorkflow() {
  const result = await workflow('twc-02-registry-refactor')
    .description('Delegate bootstrapRegistryFromEnv to typed config; deprecate JSON.')
    .pattern('dag')
    .channel('wf-twc-02')
    .maxConcurrency(3)
    .timeout(2_100_000)

    .agent('impl', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      preset: 'worker',
      role: 'Edits registry.ts + registry.test.ts.',
      retries: 2,
    })
    .agent('claude-reviewer', {
      cli: 'claude',
      model: ClaudeModels.OPUS,
      preset: 'reviewer',
      role: 'Reviews behaviour preservation + deprecation.',
      retries: 1,
    })
    .agent('codex-reviewer', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      preset: 'reviewer',
      role: 'Reviews for bugs + test coverage.',
      retries: 1,
    })

    .step('preflight', {
      type: 'deterministic',
      command: [
        'set -euo pipefail',
        'test -f packages/web/lib/integrations/webhook-consumers.config.ts || { echo "sub 01 artifact missing"; exit 1; }',
        'test -f packages/web/lib/integrations/webhook-consumer-registry.ts',
        'test -f packages/web/lib/integrations/webhook-consumer-registry.test.ts',
        'echo "Preflight OK"',
      ].join('\n'),
      captureOutput: true,
      failOnError: true,
    })

    .step('read-config-surface', {
      type: 'deterministic',
      dependsOn: ['preflight'],
      command: 'grep -nE "^export " packages/web/lib/integrations/webhook-consumers.config.ts',
      captureOutput: true,
      failOnError: true,
    })

    .step('read-registry', {
      type: 'deterministic',
      dependsOn: ['preflight'],
      command: 'cat packages/web/lib/integrations/webhook-consumer-registry.ts',
      captureOutput: true,
      failOnError: true,
    })

    .step('edit-registry', {
      agent: 'impl',
      dependsOn: ['read-config-surface', 'read-registry'],
      task: `Edit packages/web/lib/integrations/webhook-consumer-registry.ts.

Current:
{{steps.read-registry.output}}

Config module surface:
{{steps.read-config-surface.output}}

Changes:
1. Import { getConfiguredConsumers } from "./webhook-consumers.config.js".
2. Refactor bootstrapRegistryFromEnv(env, options):
   a. const typed = getConfiguredConsumers(env); register each typed consumer first
   b. If WEBHOOK_CONSUMERS_JSON env is set AND parses to >= 1 valid consumer: logger.warn('WEBHOOK_CONSUMERS_JSON is deprecated; migrate entries to typed SST secrets.'); register them AFTER typed (existing dedup in this.consumers replaces by id, so JSON entries override typed ones when ids match — preserves current prod msd-backend behaviour)
   c. If WEBHOOK_CONSUMERS_JSON is unset/empty/parse-failed/zero-valid: register typed list only, no warn
3. Delete createDefaultConsumers entirely.
4. Keep parseConsumerEntries + parseEnvConsumer — the deprecation branch still uses them.
5. Keep createRelayfilePrimaryConsumer exported — config module imports it.
6. Add: export { getConfiguredConsumers } from "./webhook-consumers.config.js"; so callers can import either module.

Only edit this one file.`,
      verification: { type: 'exit_code' },
    })

    .step('verify-registry-edit', {
      type: 'deterministic',
      dependsOn: ['edit-registry'],
      command: [
        'set -euo pipefail',
        'F=packages/web/lib/integrations/webhook-consumer-registry.ts',
        'git diff --quiet "$F" && { echo "NOT MODIFIED"; exit 1; }',
        'grep -q "getConfiguredConsumers" "$F" || { echo "typed path not wired"; exit 1; }',
        'grep -qE "deprecat(ed|ion)" "$F" || { echo "deprecation warning missing"; exit 1; }',
        'grep -q "createRelayfilePrimaryConsumer" "$F" || { echo "relayfile-primary factory lost"; exit 1; }',
        '! grep -qE "^function createDefaultConsumers" "$F" || { echo "createDefaultConsumers should be deleted"; exit 1; }',
        'echo "REGISTRY EDIT OK"',
      ].join('\n'),
      captureOutput: true,
      failOnError: true,
    })

    .step('read-registry-test', {
      type: 'deterministic',
      dependsOn: ['verify-registry-edit'],
      command: 'cat packages/web/lib/integrations/webhook-consumer-registry.test.ts',
      captureOutput: true,
      failOnError: true,
    })

    .step('edit-registry-test', {
      agent: 'impl',
      dependsOn: ['read-registry-test'],
      task: `Edit packages/web/lib/integrations/webhook-consumer-registry.test.ts.

Current:
{{steps.read-registry-test.output}}

Changes:
1. Rename the existing 'parses WEBHOOK_CONSUMERS_JSON and registers configured consumers' test to 'legacy WEBHOOK_CONSUMERS_JSON still registers consumers alongside typed defaults (deprecated path)'. Update assertion to expect typed defaults (sage + relayfile-primary) PLUS the JSON consumer AND a logger.warn call mentioning 'deprecated'.
2. Add test: 'defaults to typed config when WEBHOOK_CONSUMERS_JSON is unset' — bootstrap with empty env, expect exactly sage (slack) + relayfile-primary.
3. Add test: 'WEBHOOK_CONSUMERS_JSON id override: JSON entry with matching id replaces typed default' — bootstrap with { WEBHOOK_CONSUMERS_JSON: JSON.stringify({ consumers: [{ id: 'sage', provider: 'slack', kind: 'http', url: 'https://override.example.com' }] }) }, assert registered sage consumer url === override.
4. Keep all other existing tests (dispatch, fanout, predicate, timeout) unchanged.

Only edit this one file.`,
      verification: { type: 'exit_code' },
    })

    .step('verify-test-edit', {
      type: 'deterministic',
      dependsOn: ['edit-registry-test'],
      command: [
        'set -euo pipefail',
        'F=packages/web/lib/integrations/webhook-consumer-registry.test.ts',
        'git diff --quiet "$F" && { echo "NOT MODIFIED"; exit 1; }',
        'grep -q "deprecated" "$F"',
        'grep -qE "typed (config|defaults)" "$F"',
        'echo "REGISTRY TEST EDIT OK"',
      ].join('\n'),
      captureOutput: true,
      failOnError: true,
    })

    .step('read-for-review', {
      type: 'deterministic',
      dependsOn: ['verify-test-edit'],
      command: [
        'echo "===== registry.ts diff ====="',
        'git diff packages/web/lib/integrations/webhook-consumer-registry.ts | head -250',
        'echo "" && echo "===== registry.test.ts diff ====="',
        'git diff packages/web/lib/integrations/webhook-consumer-registry.test.ts | head -250',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('claude-review', {
      agent: 'claude-reviewer',
      dependsOn: ['read-for-review'],
      task: `Review.

{{steps.read-for-review.output}}

Check: typed defaults first, JSON consumers after (last-writer-wins per id); deprecation log only on non-empty JSON env with >=1 valid entry; sage + relayfile-primary always registered; current prod config (JSON with msd-backend only) now yields sage + relayfile-primary + msd-backend; no breaking API changes.

Verdict: CLAUDE_REVIEW_VERDICT: PASS | CHANGES_REQUESTED + numbered items.`,
    })

    .step('codex-review', {
      agent: 'codex-reviewer',
      dependsOn: ['read-for-review'],
      task: `Review.

{{steps.read-for-review.output}}

Check: JSON parse failures warn + fall through (no throw); tests cover no-env / env-override / env-new-id paths; no stale imports or dead code; createRelayfilePrimaryConsumer export intact.

Verdict format same.`,
    })

    .step('apply-review-feedback', {
      agent: 'impl',
      dependsOn: ['claude-review', 'codex-review'],
      task: `Apply feedback.

Claude: {{steps.claude-review.output}}
Codex:  {{steps.codex-review.output}}

If both PASS, print NO CHANGES and exit. Otherwise fix CHANGES_REQUESTED items in these two files only.`,
      verification: { type: 'exit_code' },
    })

    .step('run-tests', {
      type: 'deterministic',
      dependsOn: ['apply-review-feedback'],
      command:
        'npx tsx --test packages/web/lib/integrations/webhook-consumer-registry.test.ts packages/web/lib/integrations/webhook-consumers.config.test.ts 2>&1 | tail -120',
      captureOutput: true,
      failOnError: false,
    })

    .step('fix-tests', {
      agent: 'impl',
      dependsOn: ['run-tests'],
      task: `Fix failures.

{{steps.run-tests.output}}

Iterate until both files are green.`,
      verification: { type: 'exit_code' },
    })

    .step('run-tests-final', {
      type: 'deterministic',
      dependsOn: ['fix-tests'],
      command:
        'npx tsx --test packages/web/lib/integrations/webhook-consumer-registry.test.ts packages/web/lib/integrations/webhook-consumers.config.test.ts 2>&1 | tail -60',
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
        'git add packages/web/lib/integrations/webhook-consumer-registry.ts packages/web/lib/integrations/webhook-consumer-registry.test.ts',
        'git diff --cached --quiet && { echo "Nothing to commit"; exit 1; }',
        'git commit -m "refactor(web): delegate bootstrapRegistryFromEnv to typed config; deprecate JSON path"',
        'git log -1 --oneline',
      ].join('\n'),
      captureOutput: true,
      failOnError: true,
    })

    .onError('retry', { maxRetries: 2, retryDelayMs: 10_000 })
    .run({ cwd: process.cwd() });

  console.log('Workflow status:', result.status);
  if (result.status != null && result.status !== 'completed') {
    throw new Error(`sub-02 registry-refactor failed: ${String(result.status)}`);
  }
}

runWorkflow().catch((error) => {
  console.error(error);
  process.exit(1);
});
