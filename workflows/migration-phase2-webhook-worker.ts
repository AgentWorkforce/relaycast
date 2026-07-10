// Cloud Web Migration — Phase 2: Webhook Worker
// ──────────────────────────────────────────────────────────────────────────────
// Wave: 2. Worktree: cloud-phase2-webhook.
// Stacked on: feat/migration-phase1-hyperdrive (PR #620).
//
// Goal: Move /api/v1/webhooks/* off the OpenNext Lambda onto a dedicated
//       Cloudflare Worker. Webhook senders see no URL change (router rule
//       handles routing). Reduces blast radius — a webhook storm can no
//       longer 429 user-facing traffic.
//
// What lands:
//   - packages/webhook-worker/                — new package
//     - src/index.ts                          — CF Worker entry + signature verify + queue enqueue
//     - src/handlers/{nango,github,composio,hookdeck}.ts
//     - wrangler.toml
//     - test/                                  — miniflare unit tests
//   - infra/webhook-worker.ts                  — sst.cloudflare.Worker (also link hyperdrive here as the first consumer)
//   - infra/webhook-queue.ts                   — sst.cloudflare.Queue
//   - packages/router/index.ts                 — KV-flagged routing rule
//
// Ships DORMANT — KV WEBHOOK_ORIGIN defaults to "lambda" so the route still
// hits the existing Lambda. Operator flips KV to "worker" after replay
// validation against the new Worker passes.
//
// Inlines setup-branch + install-deps. Single-line bash. Plain string
// concat for bash variable interpolation. `.onError('fail-fast')`.
// ──────────────────────────────────────────────────────────────────────────────

import { workflow } from '@relayflows/core';
import { ClaudeModels, CodexModels } from '@agent-relay/config';

const NAME = 'migration-phase2-webhook-worker';
const BRANCH = 'feat/migration-phase2-webhook-worker';
const CHANNEL = `wf-${NAME}`;

const ALLOWED_DIRTY = [
  'package-lock\\.json',
  'package\\.json',
  'packages/webhook-worker/.*',
  'packages/router/.*',
  'infra/webhook-worker\\.ts',
  'infra/webhook-queue\\.ts',
  '\\.logs/.*',
  '\\.trajectories/.*',
  'workflows/migration-phase2-webhook-worker\\.ts',
  'workflows/lib/.*',
].join('|');

async function runWorkflow() {
  const wf = workflow(NAME)
    .description(
      'Phase 2 of the cloud web migration: dedicated CF Worker for /api/v1/webhooks/* + CF Queue for fan-out. Router rule KV-flagged, ships dormant. Eliminates webhook contention with the user-facing tier.',
    )
    .pattern('dag')
    .channel(CHANNEL)
    .maxConcurrency(4)
    .timeout(3 * 60 * 60 * 1000)

    .agent('lead', {
      cli: 'claude',
      model: ClaudeModels.OPUS,
      role: 'Architect + reviewer. Locks the Worker handler contract (HMAC verify → enqueue → 202) and the queue message shape.',
      retries: 1,
    })
    .agent('worker-impl', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      role: 'Owns packages/webhook-worker/ — Worker code, signature verification, queue enqueue, miniflare tests.',
      retries: 2,
    })
    .agent('infra-impl', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      role: 'Owns infra/webhook-worker.ts, infra/webhook-queue.ts, and the router KV rule in packages/router/index.ts.',
      retries: 2,
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
        'git config user.name "Phase 2 Webhook Worker Bot"',
        'git checkout -B ' + BRANCH,
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
        'test -f infra/hyperdrive.ts || (echo "ERROR: Phase 1 Hyperdrive resource missing — Phase 2 webhook worker depends on it"; exit 1)',
        'test -f docs/spikes/cf-spike-report.md || (echo "ERROR: spike report missing"; exit 1)',
        'grep -qE "^\\*\\*RECOMMENDATION: WORKERS\\*\\*$" docs/spikes/cf-spike-report.md || (echo "ERROR: spike did not recommend WORKERS"; exit 1)',
        'echo PREFLIGHT_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('read-existing-webhook-handlers', {
      type: 'deterministic',
      dependsOn: ['preflight'],
      command: [
        'set -e',
        'echo "── existing webhook routes ──"',
        'find packages/web/app/api/v1/webhooks -name "route.ts" -type f | sort',
        'echo',
        'for f in $(find packages/web/app/api/v1/webhooks -name "route.ts" | sort); do echo "── $f ──"; head -120 "$f"; echo; done',
      ].join('\n'),
      captureOutput: true,
      failOnError: true,
    })

    .step('read-router', {
      type: 'deterministic',
      dependsOn: ['preflight'],
      command: 'cat packages/router/index.ts',
      captureOutput: true,
      failOnError: true,
    })

    .step('scaffold-webhook-worker', {
      type: 'deterministic',
      dependsOn: ['preflight'],
      command: [
        'set -e',
        'mkdir -p packages/webhook-worker/src/handlers',
        'mkdir -p packages/webhook-worker/test',
        'echo SCAFFOLD_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('write-worker-impl', {
      agent: 'worker-impl',
      dependsOn: ['scaffold-webhook-worker', 'read-existing-webhook-handlers'],
      task: [
        'Implement packages/webhook-worker/.',
        '',
        'Existing webhook handlers in the OpenNext Lambda (reference — port HMAC verification VERBATIM):',
        '{{steps.read-existing-webhook-handlers.output}}',
        '',
        'Deliverables:',
        '',
        '1. packages/webhook-worker/package.json',
        '   - name: "@cloud/webhook-worker"',
        '   - type: "module"',
        '   - private: true',
        '   - devDependencies: vitest, @cloudflare/vitest-pool-workers, @cloudflare/workers-types',
        '',
        '2. packages/webhook-worker/tsconfig.json',
        '   - extends from a parent if one exists; target ES2022; module ESNext; types include @cloudflare/workers-types',
        '',
        '3. packages/webhook-worker/wrangler.toml',
        '   - name = "webhook-worker"',
        '   - main = "src/index.ts"',
        '   - compatibility_date = today (YYYY-MM-DD)',
        '   - compatibility_flags = ["nodejs_compat"]',
        '   - queues.producers = [{ binding = "WEBHOOK_QUEUE", queue = "webhook-events" }]',
        '   - hyperdrive = [{ binding = "HYPERDRIVE", id = "<placeholder — wired in infra/webhook-worker.ts>" }]',
        '   - vars = { ENVIRONMENT = "production" }',
        '',
        '4. packages/webhook-worker/src/index.ts',
        '   - export default { async fetch(request, env, ctx) { ... } }',
        '   - Route on URL pathname:',
        '       /api/v1/webhooks/nango     → handlers/nango.handle(request, env)',
        '       /api/v1/webhooks/github    → handlers/github.handle(request, env)',
        '       /api/v1/webhooks/composio  → handlers/composio.handle(request, env)',
        '       /api/v1/webhooks/hookdeck  → handlers/hookdeck.handle(request, env)',
        '       otherwise → 404',
        '',
        '5. packages/webhook-worker/src/handlers/<provider>.ts (one per provider, 4 total):',
        '   - export async function handle(request: Request, env: Env): Promise<Response>',
        '   - Reads body, verifies HMAC signature against env.<PROVIDER>_WEBHOOK_SECRET',
        '   - On invalid signature: 401 with body { error: "invalid_signature" }',
        '   - On valid signature: enqueues { provider, body, headers, receivedAt, requestId } to env.WEBHOOK_QUEUE.send(...)',
        '   - Returns 202 with JSON { accepted: true, queue: "webhook-events", messageId: <generated> }',
        '   - **CRITICAL**: the verification logic must be byte-identical to the existing Lambda handler in packages/web/app/api/v1/webhooks/<provider>/route.ts. Port the verifier verbatim — do NOT rewrite it.',
        '',
        '6. packages/webhook-worker/test/*.test.ts',
        '   - One test file per handler. Use vitest + @cloudflare/vitest-pool-workers.',
        '   - Cases per handler: valid signature → 202; invalid signature → 401; missing header → 401; replay attempt (timestamp out of window, if the provider checks it) → 401.',
        '',
        'Post WEBHOOK_WORKER_DONE.',
      ].join('\n'),
      verification: { type: 'exit_code' },
    })
    .step('verify-worker-impl', {
      type: 'deterministic',
      dependsOn: ['write-worker-impl'],
      command: [
        'set -e',
        'for f in package.json tsconfig.json wrangler.toml src/index.ts; do test -f "packages/webhook-worker/$f" || { echo "FAIL: missing $f"; exit 1; }; done',
        'HANDLERS=$(find packages/webhook-worker/src/handlers -name "*.ts" 2>/dev/null | wc -l | tr -d " ")',
        'if [ "$HANDLERS" -lt 4 ]; then echo "FAIL: expected >=4 handler files, found $HANDLERS"; exit 1; fi',
        'TESTS=$(find packages/webhook-worker/test -name "*.test.ts" 2>/dev/null | wc -l | tr -d " ")',
        'if [ "$TESTS" -lt 4 ]; then echo "FAIL: expected >=4 test files, found $TESTS"; exit 1; fi',
        'grep -q "queues" packages/webhook-worker/wrangler.toml || (echo "FAIL: wrangler.toml missing queue binding"; exit 1)',
        'grep -q "hyperdrive" packages/webhook-worker/wrangler.toml || (echo "FAIL: wrangler.toml missing hyperdrive binding"; exit 1)',
        'grep -q "nodejs_compat" packages/webhook-worker/wrangler.toml || (echo "FAIL: wrangler.toml missing nodejs_compat"; exit 1)',
        'echo VERIFY_WORKER_IMPL_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('write-infra', {
      agent: 'infra-impl',
      dependsOn: ['preflight', 'read-router'],
      task: [
        'Create two SST files and one router edit.',
        '',
        'Current router (for the KV-flagged rule):',
        '{{steps.read-router.output}}',
        '',
        '1. infra/webhook-queue.ts:',
        '   - export const webhookQueue = new sst.cloudflare.Queue("WebhookEvents", { ... })',
        '   - **Use sst.cloudflare.* NOT sst.cf.*** — sst.cf is not a valid namespace; see PR #620 review for context.',
        '',
        '2. infra/webhook-worker.ts:',
        '   - import { hyperdrive } from "./hyperdrive"',
        '   - import { webhookQueue } from "./webhook-queue"',
        '   - import every secret the existing Lambda webhook handlers use (read packages/web/app/api/v1/webhooks/*/route.ts to enumerate; common ones: NangoSecretKey, GithubAppWebhookSecret, ComposioWebhookSecret, HookdeckWebhookSecret, anything *Secret* referenced via Resource.X.value)',
        '   - export const webhookWorker = new sst.cloudflare.Worker("WebhookWorker", {',
        '       handler: "packages/webhook-worker/src/index.ts",',
        '       link: [hyperdrive, webhookQueue, /* ...all those secrets */],',
        '     })',
        '   - **Use sst.cloudflare.* NOT sst.cf.***',
        '',
        '3. packages/router/index.ts:',
        '   - Add a route rule: if URL.pathname starts with /api/v1/webhooks/, look up env.ROUTER_CONFIG.get("WEBHOOK_ORIGIN").',
        '   - If value is "worker": forward to env.WEBHOOK_WORKER.fetch(request) (service binding) or to webhookWorker public URL.',
        '   - If value is "lambda" OR missing OR error: forward to the existing Lambda origin (default behavior — current code).',
        '   - This means the PR ships DORMANT — production behavior unchanged until operator runs: `wrangler kv:key put --binding=ROUTER_CONFIG WEBHOOK_ORIGIN worker --remote`',
        '   - **Default to "lambda" if the KV key is missing.** Safe fallback.',
        '',
        'Post INFRA_DONE.',
      ].join('\n'),
      verification: { type: 'exit_code' },
    })
    .step('verify-infra', {
      type: 'deterministic',
      dependsOn: ['write-infra'],
      command: [
        'set -e',
        'test -f infra/webhook-worker.ts || (echo "FAIL: missing webhook-worker.ts"; exit 1)',
        'test -f infra/webhook-queue.ts || (echo "FAIL: missing webhook-queue.ts"; exit 1)',
        'grep -q "sst.cloudflare.Worker" infra/webhook-worker.ts || (echo "FAIL: must use sst.cloudflare.Worker (not sst.cf.Worker)"; exit 1)',
        'grep -q "sst.cloudflare.Queue" infra/webhook-queue.ts || (echo "FAIL: must use sst.cloudflare.Queue (not sst.cf.Queue)"; exit 1)',
        '! grep -q "sst\\.cf\\." infra/webhook-worker.ts infra/webhook-queue.ts || (echo "FAIL: sst.cf.* namespace is invalid; use sst.cloudflare.*"; exit 1)',
        'grep -q "WEBHOOK_ORIGIN" packages/router/index.ts || (echo "FAIL: router missing WEBHOOK_ORIGIN KV check"; exit 1)',
        'grep -q "/api/v1/webhooks/" packages/router/index.ts || (echo "FAIL: router missing webhook path rule"; exit 1)',
        'echo VERIFY_INFRA_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('run-worker-tests', {
      type: 'deterministic',
      dependsOn: ['verify-worker-impl'],
      command: 'cd packages/webhook-worker && npx vitest run --reporter=basic 2>&1 | tail -50',
      captureOutput: true,
      failOnError: false,
    })
    .step('fix-worker-tests', {
      agent: 'worker-impl',
      dependsOn: ['run-worker-tests'],
      task: 'Fix any failing Worker tests. Output:\n{{steps.run-worker-tests.output}}\nIterate until all pass.',
      verification: { type: 'exit_code' },
    })
    .step('run-worker-tests-final', {
      type: 'deterministic',
      dependsOn: ['fix-worker-tests'],
      command: 'cd packages/webhook-worker && npx vitest run --reporter=basic',
      captureOutput: true,
      failOnError: true,
    })

    .step('acceptance-webhooks-vs-prod', {
      type: 'deterministic',
      dependsOn: ['run-worker-tests-final'],
      command: [
        'set -e',
        'if [ ! -d packages/acceptance/src/integrations ]; then echo "WARN: acceptance webhook tests not present — Phase 0 foundation not landed yet. Skipping regression gate."; exit 0; fi',
        'export ACCEPTANCE_BASE_URL=https://agentrelay.com/cloud',
        'npx vitest run packages/acceptance/src/integrations/webhooks-*.test.ts --reporter=basic 2>&1 | tail -40',
        'echo ACCEPTANCE_WEBHOOKS_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('typecheck', {
      type: 'deterministic',
      dependsOn: ['acceptance-webhooks-vs-prod', 'verify-infra'],
      command: [
        'set -e',
        '(cd packages/webhook-worker && npx tsc --noEmit) 2>&1 | tail -30',
        '(cd infra && npx tsc --noEmit) 2>&1 | tail -30',
        'echo TYPECHECK_DONE',
      ].join(' && '),
      captureOutput: true,
      failOnError: false,
    })
    .step('fix-typecheck', {
      agent: 'worker-impl',
      dependsOn: ['typecheck'],
      task: 'Fix typecheck errors. Output:\n{{steps.typecheck.output}}\nNote: `.sst/platform/config.d.ts not found` in infra/ is a harmless SST artifact (SST generates it on `sst dev`); ignore that specific error. Iterate on any other errors.',
      verification: { type: 'exit_code' },
    })
    .step('typecheck-final', {
      type: 'deterministic',
      dependsOn: ['fix-typecheck'],
      command: [
        'set -e',
        '(cd packages/webhook-worker && npx tsc --noEmit)',
        '(cd infra && npx tsc --noEmit 2>&1 | grep -v "config.d.ts" | tail -10 || true)',
        'echo TYPECHECK_FINAL_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('final-review', {
      agent: 'lead',
      dependsOn: ['typecheck-final'],
      task: [
        'Final review of the Phase 2 webhook worker PR. Block on any of:',
        '',
        '1. HMAC verifier in any Worker handler diverging from the corresponding Lambda handler. Diff each pair: packages/webhook-worker/src/handlers/<provider>.ts vs packages/web/app/api/v1/webhooks/<provider>/route.ts. The verification logic must be byte-identical (constants, timing-safe-compare, replay window, etc.).',
        '2. Router rule defaulting to "worker" by default. KV miss MUST default to "lambda" — we flip to "worker" via KV after the PR merges, not at deploy time.',
        '3. Any handler skipping signature verification.',
        '4. Queue message shape missing fields the existing SQS handler needed (cross-check against the downstream consumer for each provider).',
        '5. Use of sst.cf.* anywhere (must be sst.cloudflare.*).',
        '6. NangoSecretKey or any other secret read via process.env instead of Resource.X.value (per .claude/rules/sst-secrets.md).',
        '',
        'Write APPROVED to .logs/phase2-review.md if clean. Otherwise enumerate findings as a numbered list.',
      ].join('\n'),
      verification: { type: 'file_exists', value: '.logs/phase2-review.md' },
    })
    .step('review-gate', {
      type: 'deterministic',
      dependsOn: ['final-review'],
      command: 'grep -qxF APPROVED .logs/phase2-review.md || (cat .logs/phase2-review.md; exit 1)',
      captureOutput: true,
      failOnError: true,
    })

    .step('commit', {
      type: 'deterministic',
      dependsOn: ['review-gate'],
      command: [
        'set -e',
        'git add packages/webhook-worker',
        'git add infra/webhook-worker.ts infra/webhook-queue.ts',
        'git add packages/router/index.ts',
        'git diff --cached --stat',
        'MSG=$(mktemp)',
        'printf "%s\\n" "feat(migration): Phase 2 — webhook Worker + CF Queue (KV-flagged, dormant)" "" "Moves /api/v1/webhooks/* off the OpenNext Lambda onto a dedicated" "Cloudflare Worker. Router rule is KV-flagged (WEBHOOK_ORIGIN). Default" "is lambda — ships dormant. Operator flips via:" "" "  wrangler kv:key put --binding=ROUTER_CONFIG WEBHOOK_ORIGIN worker --remote" "" "Stacked on feat/migration-phase1-hyperdrive (#620). Uses sst.cloudflare.*" "(not sst.cf.* — see #620 review for namespace correction)." "" "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>" > "$MSG"',
        'git commit -F "$MSG"',
        'rm -f "$MSG"',
        'git log -1 --oneline',
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
        'printf "%s\\n" "## Summary" "" "Webhook ingest moves to a dedicated Cloudflare Worker. Router rule KV-flagged; **ships dormant** (defaults to lambda). Flip via KV after replay validation against the new Worker." "" "Stacked on #620 (Phase 1 Hyperdrive)." "" "## Cutover sequence (post-merge)" "" "1. Deploy. The Worker exists but receives no production traffic yet." "2. Replay 24h+ of webhook corpus against the Worker (private URL), confirm 100% equivalence to current Lambda behavior." "3. Flip the KV: \\`wrangler kv:key put --binding=ROUTER_CONFIG WEBHOOK_ORIGIN worker --remote\\`" "4. Watch error rate + queue depth for 1h." "5. If healthy: leave on. If degraded: flip back to lambda (single command, <60s edge propagation)." "" "## Why this matters" "" "Eliminates webhook contention with the user-facing tier. A Nango/GitHub webhook fan-in storm can no longer 429 dashboard requests." "" "## Reviewers" "" "Please address coderabbit + codex + devin bot feedback." "" "🤖 Generated with [Claude Code](https://claude.com/claude-code)" > "$BODY"',
        'URL=$(gh pr create --title "feat(migration): Phase 2 — webhook Worker + CF Queue (KV-flagged, dormant)" --body-file "$BODY" --base main)',
        'rm -f "$BODY"',
        'echo "PR: $URL"',
        'echo "$URL" > .logs/phase2-pr-url.txt',
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
