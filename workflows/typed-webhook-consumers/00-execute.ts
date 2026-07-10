import { workflow } from '@relayflows/core';

/**
 * Master for typed-webhook-consumers. Runs inside a dedicated cloud
 * worktree at /Users/khaliqgant/Projects/AgentWorkforce/cloud-typed-webhook-consumers
 * on branch feat/typed-webhook-consumers so the user's main cloud
 * checkout stays untouched.
 *
 * Preflight asserts we are in the worktree (not main) — the workflow
 * refuses to run elsewhere to avoid accidentally committing to main.
 *
 * Sequence (sequential because edits overlap packages/web):
 *   01 new typed config module + tests
 *   02 rewire bootstrapRegistryFromEnv; deprecate JSON path
 *   03 SST secrets + env wiring
 *   04 integrated review + regression + push + PR
 *
 * Exit: `agent-relay run <sub>` exits 0 even on inner failure, so each
 * sub step greps the captured log for "Workflow status: failed". The
 * master itself also throws when the runner status is explicit failure
 * so the cloud bootstrap wrapper gets a non-zero exit.
 */

const EXPECTED_WORKTREE = '/Users/khaliqgant/Projects/AgentWorkforce/cloud-typed-webhook-consumers';
const EXPECTED_BRANCH = 'feat/typed-webhook-consumers';
const shq = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

async function runWorkflow() {
  const result = await workflow('master-typed-webhook-consumers')
    .description(
      'Replace WEBHOOK_CONSUMERS_JSON with typed code + per-consumer SST secrets. Runs in a dedicated worktree.',
    )
    .pattern('dag')
    .channel('wf-master-typed-webhook-consumers')
    .maxConcurrency(1)
    .timeout(10_800_000) // 3h

    .step('preflight', {
      type: 'deterministic',
      command: [
        'set -euo pipefail',
        `EXPECTED_WORKTREE=${shq(EXPECTED_WORKTREE)}`,
        `EXPECTED_BRANCH=${shq(EXPECTED_BRANCH)}`,
        'ACTUAL_CWD=$(pwd -P)',
        'EXPECTED_RESOLVED=$(cd "$EXPECTED_WORKTREE" 2>/dev/null && pwd -P || echo "")',
        'if [ "$ACTUAL_CWD" != "$EXPECTED_RESOLVED" ]; then',
        '  echo "Refusing to run: cwd=$ACTUAL_CWD but this workflow must run inside $EXPECTED_WORKTREE"; exit 1;',
        'fi',
        'CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)',
        'if [ "$CURRENT_BRANCH" != "$EXPECTED_BRANCH" ]; then',
        '  echo "Refusing to run: on branch $CURRENT_BRANCH but this workflow must run on $EXPECTED_BRANCH"; exit 1;',
        'fi',
        'test -f package.json || { echo "Not in cloud repo root"; exit 1; }',
        'test -f packages/web/lib/integrations/webhook-consumer-registry.ts || { echo "registry missing — not the cloud repo?"; exit 1; }',
        'test -f infra/secrets.ts',
        'test -f infra/web.ts',
        'test -f workflows/typed-webhook-consumers/01-config-module.ts',
        'test -f workflows/typed-webhook-consumers/02-registry-refactor.ts',
        'test -f workflows/typed-webhook-consumers/03-infra-wiring.ts',
        'test -f workflows/typed-webhook-consumers/04-integration-review-and-pr.ts',
        'command -v agent-relay >/dev/null',
        'command -v git >/dev/null',
        'git fetch origin main --quiet || echo "[preflight] git fetch failed (non-fatal)"',
        'echo "Preflight OK — worktree=$ACTUAL_CWD branch=$CURRENT_BRANCH"',
      ].join('\n'),
      captureOutput: true,
      failOnError: true,
    })

    .step('install-deps', {
      type: 'deterministic',
      dependsOn: ['preflight'],
      command: [
        'set -euo pipefail',
        'if [ ! -d node_modules/vitest ] && [ ! -d node_modules/@cloud/core ]; then',
        '  echo "installing deps"; npm ci',
        'else',
        '  echo "node_modules present — skipping install"',
        'fi',
        'npm run build --workspace @cloud/platform',
      ].join('\n'),
      captureOutput: true,
      failOnError: true,
    })

    .step('sub-01-config-module', {
      type: 'deterministic',
      dependsOn: ['install-deps'],
      command:
        'LOG=$(mktemp) && agent-relay run workflows/typed-webhook-consumers/01-config-module.ts > "$LOG" 2>&1; ' +
        'STATUS=$?; tail -400 "$LOG"; ' +
        'if [ "$STATUS" -ne 0 ] || grep -q "Workflow status: failed" "$LOG"; then echo "SUB 01 FAILED"; exit 1; fi; ' +
        'echo "SUB 01 OK"',
      captureOutput: true,
      failOnError: true,
    })

    .step('sub-02-registry-refactor', {
      type: 'deterministic',
      dependsOn: ['sub-01-config-module'],
      command:
        'LOG=$(mktemp) && agent-relay run workflows/typed-webhook-consumers/02-registry-refactor.ts > "$LOG" 2>&1; ' +
        'STATUS=$?; tail -400 "$LOG"; ' +
        'if [ "$STATUS" -ne 0 ] || grep -q "Workflow status: failed" "$LOG"; then echo "SUB 02 FAILED"; exit 1; fi; ' +
        'echo "SUB 02 OK"',
      captureOutput: true,
      failOnError: true,
    })

    .step('sub-03-infra-wiring', {
      type: 'deterministic',
      dependsOn: ['sub-02-registry-refactor'],
      command:
        'LOG=$(mktemp) && agent-relay run workflows/typed-webhook-consumers/03-infra-wiring.ts > "$LOG" 2>&1; ' +
        'STATUS=$?; tail -300 "$LOG"; ' +
        'if [ "$STATUS" -ne 0 ] || grep -q "Workflow status: failed" "$LOG"; then echo "SUB 03 FAILED"; exit 1; fi; ' +
        'echo "SUB 03 OK"',
      captureOutput: true,
      failOnError: true,
    })

    .step('sub-04-integration-review-and-pr', {
      type: 'deterministic',
      dependsOn: ['sub-03-infra-wiring'],
      command:
        'LOG=$(mktemp) && agent-relay run workflows/typed-webhook-consumers/04-integration-review-and-pr.ts > "$LOG" 2>&1; ' +
        'STATUS=$?; tail -500 "$LOG"; ' +
        'if [ "$STATUS" -ne 0 ] || grep -q "Workflow status: failed" "$LOG"; then echo "SUB 04 FAILED"; exit 1; fi; ' +
        'echo "SUB 04 OK"',
      captureOutput: true,
      failOnError: true,
    })

    .step('summary', {
      type: 'deterministic',
      dependsOn: ['sub-04-integration-review-and-pr'],
      command: [
        'echo "=== TYPED WEBHOOK CONSUMERS MIGRATION COMPLETE ==="',
        'git log --oneline -6',
        'echo ""',
        'echo "Worktree: $(pwd)"',
        'echo "Branch:   $(git rev-parse --abbrev-ref HEAD)"',
        'echo ""',
        'echo "Operator follow-ups:"',
        'echo "  1. sst secret set WebhookMsdBackendUrl   <url>   --stage production"',
        'echo "  2. sst secret set WebhookMsdBackendToken <token> --stage production"',
        'echo "  3. sst deploy --stage production"',
        'echo "  4. Verify fanout in CloudWatch"',
        'echo "  5. Follow-up PR: delete legacy WebhookConsumersJson + JSON parse branch"',
        'echo ""',
        'echo "Cleanup (when merged):"',
        'echo "  cd /Users/khaliqgant/Projects/AgentWorkforce/cloud && git worktree remove ../cloud-typed-webhook-consumers"',
      ].join(' && '),
      captureOutput: true,
      failOnError: false,
    })

    .onError('fail-fast')
    .run({ cwd: process.cwd() });

  console.log('Master workflow status:', result.status);
  if (result.status != null && result.status !== 'completed') {
    throw new Error(`Master typed-webhook-consumers failed: ${String(result.status)}`);
  }
}

runWorkflow().catch((error) => {
  console.error(error);
  process.exit(1);
});
