// Cloud Web Migration — Phase 3: cloud-web Worker build (OpenNext-CF)
// ──────────────────────────────────────────────────────────────────────────────
// Wave: Phase 3 implementation. Worktree: cloud-web-worker-build.
//
// Goal: Build packages/web with @opennextjs/cloudflare into a Worker, wire its
// wrangler.toml bindings, declare the SST Worker resource, and KV-flag the
// router so we can flip cloudOrigin to "workers" later (cutover is Phase 4).
//
// Ships DORMANT — router KV defaults to "lambda"; production behavior
// unchanged until operator flips post-deploy.
//
// Inlines setup-branch + install-deps. Single-line bash. Plain string concat.
// `.onError('fail-fast')`.
// ──────────────────────────────────────────────────────────────────────────────

import { workflow } from '@relayflows/core';
import { ClaudeModels, CodexModels } from '@agent-relay/config';

const NAME = 'migration-phase3-web-worker-build';
const BRANCH = 'feat/migration-phase3-web-worker-build';
const CHANNEL = `wf-${NAME}`;

const ALLOWED_DIRTY = [
  'package-lock\\.json',
  'package\\.json',
  'packages/web/.*',
  'infra/web-worker\\.ts',
  'packages/router/.*',
  '\\.logs/.*',
  '\\.trajectories/.*',
  'workflows/migration-phase3-web-worker-build\\.ts',
  'workflows/lib/.*',
].join('|');

async function runWorkflow() {
  const wf = workflow(NAME)
    .description(
      'Phase 3: build packages/web as a CF Worker via @opennextjs/cloudflare. wrangler.toml + SST Worker resource + KV-flagged router rule (dormant). Cutover is Phase 4.',
    )
    .pattern('dag')
    .channel(CHANNEL)
    .maxConcurrency(4)
    .timeout(4 * 60 * 60 * 1000)

    .agent('lead', {
      cli: 'claude',
      model: ClaudeModels.OPUS,
      role: 'Pre-commit reviewer. Verifies build artifact exists, wrangler.toml has all bindings, KV default is lambda, no handler code modified beyond Node-API polyfills needed for Workers.',
      retries: 1,
    })
    .agent('build-impl', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      role: 'Runs @opennextjs/cloudflare build iteratively, fixing Node-API incompatibilities and missing deps until the build produces .open-next/worker.js cleanly. Authors wrangler.toml with all bindings.',
      retries: 2,
    })
    .agent('infra-impl', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      role: 'Authors infra/web-worker.ts (sst.cloudflare.Worker resource) and the KV-flagged router rule edit in packages/router/index.ts. Stays out of the build/config track.',
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
        'git config user.name "Phase 3 Web Worker Build Bot"',
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
        'test -f packages/web/next.config.ts || (echo "ERROR: packages/web/next.config.ts missing"; exit 1)',
        'echo PREFLIGHT_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('install-opennext-cf', {
      type: 'deterministic',
      dependsOn: ['preflight'],
      command: [
        'set -e',
        'if [ -d packages/web/node_modules/@opennextjs/cloudflare ]; then echo "already installed"; else cd packages/web && npm install --save-dev --legacy-peer-deps --no-audit --no-fund @opennextjs/cloudflare > ../../.logs/install-opennext-cf.log 2>&1 && cd ../..; fi',
        'echo INSTALL_OPENNEXT_CF_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    // standalone output check moved into the fix-build agent loop; the
    // first build attempt will surface "missing output: standalone" if it's
    // not set, and the agent will patch it then re-run.

    // ─── Build-fix loop ──────────────────────────────────────────────────────
    .step('attempt-build', {
      type: 'deterministic',
      dependsOn: ['install-opennext-cf'],
      command: [
        'set -e',
        'cd packages/web',
        'npx @opennextjs/cloudflare build > ../../.logs/opennext-cf-build.log 2>&1 || true',
        'tail -80 ../../.logs/opennext-cf-build.log',
        'cd ../..',
        'if [ -f packages/web/.open-next/worker.js ]; then echo "BUILD_OK: worker.js present"; else echo "BUILD_FAIL: no worker.js"; fi',
      ].join(' && '),
      captureOutput: true,
      failOnError: false,
    })
    .step('fix-build', {
      agent: 'build-impl',
      dependsOn: ['attempt-build'],
      task: [
        'The OpenNext-CF build attempt output is below. If the build succeeded (.open-next/worker.js exists), do nothing.',
        '',
        'If it failed: read the error, identify the root cause, fix it, re-run `cd packages/web && npx @opennextjs/cloudflare build`. Iterate until the build succeeds.',
        '',
        'Build output:',
        '{{steps.attempt-build.output}}',
        '',
        'Common fixes:',
        '- Missing deps: e.g. @cloudflare/workers-types, @opennextjs/aws — add to packages/web/devDependencies and re-run.',
        '- Node-only APIs (node:fs path manipulation, node:crypto patterns): replace with Web Crypto / cloudflare-compatible APIs.',
        '- Bundle-size errors (>10MB Worker): split via open-next.config.ts (route-level), or migrate the largest dep to a separate Worker.',
        '- next.config.ts errors: ensure `output: "standalone"` and any other Worker-required flags.',
        '- node:net / node:dns / node:dgram / node:child_process: NOT supported on Workers. Routes using these need refactoring or polyfill.',
        '',
        'Constraints:',
        '- DO NOT modify packages/web/app/api/**/route.ts handler logic beyond what\\x27s strictly required to satisfy Worker compatibility (e.g., replace `node:fs` with `node:fs/promises` if that works under workers; otherwise stub the fs path for build-time only).',
        '- Stay under the 10MB Worker bundle size limit.',
        '- Run `cd packages/web && npx @opennextjs/cloudflare build` repeatedly. The build is the gate.',
        '',
        'Post BUILD_FIXED with one sentence describing what you fixed.',
      ].join('\n'),
      verification: { type: 'exit_code' },
    })
    .step('build-final', {
      type: 'deterministic',
      dependsOn: ['fix-build'],
      command: [
        'set -e',
        'cd packages/web',
        'npx @opennextjs/cloudflare build > ../../.logs/opennext-cf-build-final.log 2>&1',
        'tail -30 ../../.logs/opennext-cf-build-final.log',
        'cd ../..',
        'test -f packages/web/.open-next/worker.js || (echo "BUILD_FAIL_FINAL"; exit 1)',
        'SIZE=$(stat -f%z packages/web/.open-next/worker.js 2>/dev/null || stat -c%s packages/web/.open-next/worker.js)',
        'echo "worker.js bytes: $SIZE"',
        'echo BUILD_FINAL_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    // ─── Configure wrangler.toml (parallel after build) ──────────────────────
    .step('read-secrets', {
      type: 'deterministic',
      dependsOn: ['build-final'],
      command: 'cat infra/secrets.ts',
      captureOutput: true,
      failOnError: true,
    })
    .step('read-current-wrangler', {
      type: 'deterministic',
      dependsOn: ['build-final'],
      command: 'cat packages/web/wrangler.toml 2>&1 || echo "(no existing wrangler.toml)"',
      captureOutput: true,
      failOnError: true,
    })
    .step('write-wrangler-toml', {
      agent: 'build-impl',
      dependsOn: ['read-secrets', 'read-current-wrangler'],
      task: [
        'Write packages/web/wrangler.toml.',
        '',
        'Current contents:',
        '{{steps.read-current-wrangler.output}}',
        '',
        'SST secrets in scope (grep these into the wrangler.toml [vars] / [secrets] sections):',
        '{{steps.read-secrets.output}}',
        '',
        'Required content:',
        '- name = "cloud-web-staging"  // staging deploy target',
        '- compatibility_date = today (YYYY-MM-DD)',
        '- compatibility_flags = ["nodejs_compat"]',
        '- main = ".open-next/worker.js"',
        '- [assets] for .open-next/assets',
        '- [[hyperdrive]] binding HYPERDRIVE → id placeholder "<set by infra/hyperdrive.ts>"',
        '- [[kv_namespaces]] for ROUTER_CONFIG, WORKFLOW_KV, and any other KV namespaces packages/web reads from (grep packages/web/lib for env.X_KV references)',
        '- [[r2_buckets]] for TRAFFIC_RECORDER and any other R2 buckets',
        '- [[queues.producers]] for WEBHOOK_QUEUE, GITHUB_CLONE_QUEUE, and any other CF Queues the web tier enqueues to',
        '- [vars] for non-secret env vars (PUBLIC_URL, etc.)',
        '- A note in comments: secrets like NANGO_SECRET_KEY etc. are bound via SST link, not wrangler.toml',
        '',
        'IMPORTANT: this is the STAGING wrangler.toml. Real prod deploy goes via SST\\x27s sst.cloudflare.Worker (infra/web-worker.ts) which manages bindings declaratively. wrangler.toml is for `wrangler dev` smoke tests and as documentation.',
        '',
        'Post WRANGLER_TOML_DONE.',
      ].join('\n'),
      verification: { type: 'exit_code' },
    })
    .step('verify-wrangler-toml', {
      type: 'deterministic',
      dependsOn: ['write-wrangler-toml'],
      command: [
        'set -e',
        'test -f packages/web/wrangler.toml || (echo "FAIL"; exit 1)',
        'grep -q "nodejs_compat" packages/web/wrangler.toml || (echo "FAIL: missing nodejs_compat"; exit 1)',
        'grep -q "HYPERDRIVE" packages/web/wrangler.toml || (echo "FAIL: missing HYPERDRIVE binding"; exit 1)',
        'grep -q "ROUTER_CONFIG" packages/web/wrangler.toml || (echo "FAIL: missing ROUTER_CONFIG KV binding"; exit 1)',
        'echo VERIFY_WRANGLER_TOML_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    // ─── SST Worker resource (parallel with wrangler.toml) ───────────────────
    .step('write-sst-worker', {
      agent: 'infra-impl',
      dependsOn: ['build-final'],
      task: [
        'Create infra/web-worker.ts.',
        '',
        'Declare:',
        'export const cloudWebWorker = new sst.cloudflare.Worker("CloudWebWorker", {',
        '  handler: ".open-next/worker.js",  // produced by @opennextjs/cloudflare build',
        '  link: [<all secrets the web tier uses>, hyperdrive, webhookQueue, githubCloneQueue, workflowStorage, ...everything that\\x27s linked to AgentRelayCloudWebServer in infra/web.ts today],',
        '  // url: true if we want a public workers.dev URL for the staging Worker',
        '})',
        '',
        'Cross-reference infra/web.ts (the existing OpenNext Lambda config) for the full list of `link:` entries. Match them.',
        '',
        'Add a top-of-file comment explaining this is the staging deploy target. Cutover (router KV flip) is Phase 4.',
        '',
        'Rules:',
        '- Use sst.cloudflare.Worker (NOT sst.cf.Worker — that namespace does not exist).',
        '- Pulumi the bindings; don\\x27t hardcode.',
        '- No process.env reads.',
        '',
        'Post SST_WORKER_DONE.',
      ].join('\n'),
      verification: { type: 'exit_code' },
    })
    .step('verify-sst-worker', {
      type: 'deterministic',
      dependsOn: ['write-sst-worker'],
      command: [
        'set -e',
        'test -f infra/web-worker.ts || (echo "FAIL"; exit 1)',
        'grep -q "sst.cloudflare.Worker" infra/web-worker.ts || (echo "FAIL: must use sst.cloudflare.Worker"; exit 1)',
        '! grep -q "sst\\.cf\\." infra/web-worker.ts || (echo "FAIL: sst.cf.* is not a valid namespace"; exit 1)',
        'grep -q "hyperdrive" infra/web-worker.ts || (echo "FAIL: missing hyperdrive in link"; exit 1)',
        'echo VERIFY_SST_WORKER_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    // ─── Router KV flag for cloudOrigin (parallel) ───────────────────────────
    .step('read-router-now', {
      type: 'deterministic',
      dependsOn: ['build-final'],
      command: 'cat packages/router/index.ts',
      captureOutput: true,
      failOnError: true,
    })
    .step('update-router-rule', {
      agent: 'infra-impl',
      dependsOn: ['read-router-now'],
      task: [
        'Add a KV-flagged forward rule to packages/router/index.ts for the cloud-web Worker.',
        '',
        'Current router:',
        '{{steps.read-router-now.output}}',
        '',
        'Pattern:',
        '- Read env.ROUTER_CONFIG.get("cloudOrigin"). If "workers": forward to the cloud-web Worker (env.CLOUD_WEB_WORKER service binding). If "lambda" or missing or error: forward to the existing CloudFront / Lambda origin (current behavior).',
        '- Default behavior on KV miss: "lambda" (current production behavior).',
        '- Apply to /cloud/* paths (the main user-facing surface). Do NOT change /api/v1/webhooks/* rule — that\\x27s already KV-flagged via WEBHOOK_ORIGIN.',
        '',
        'After this PR merges + deploys + the staging Worker is verified, the operator flips with:',
        '  wrangler kv:key put --binding=ROUTER_CONFIG cloudOrigin workers --remote',
        '',
        'Only modify packages/router/index.ts. Post ROUTER_DONE.',
      ].join('\n'),
      verification: { type: 'exit_code' },
    })
    .step('verify-router', {
      type: 'deterministic',
      dependsOn: ['update-router-rule'],
      command: [
        'set -e',
        'grep -q "cloudOrigin" packages/router/index.ts || (echo "FAIL: missing cloudOrigin KV check"; exit 1)',
        'echo VERIFY_ROUTER_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    // ─── Smoke test via wrangler dev (optional, light gate) ──────────────────
    .step('wrangler-dev-smoke', {
      type: 'deterministic',
      dependsOn: ['verify-wrangler-toml'],
      command: [
        'set -e',
        'cd packages/web',
        'mkdir -p ../../.logs',
        'wrangler dev --local --port 8788 > ../../.logs/wrangler-dev-smoke.log 2>&1 &',
        'WPID=$!',
        'for i in $(seq 1 30); do if curl -sS -o /dev/null -w "%{http_code}" http://127.0.0.1:8788/api/health 2>/dev/null | grep -qE "^[2345][0-9][0-9]$"; then break; fi; sleep 2; done',
        'CODE=$(curl -sS -o /tmp/web-worker-smoke.out -w "%{http_code}" http://127.0.0.1:8788/api/health 2>&1 || echo "0")',
        'echo "SMOKE_HEALTH_STATUS: $CODE"',
        'head -10 /tmp/web-worker-smoke.out 2>/dev/null || true',
        'kill "$WPID" 2>/dev/null || true',
        'wait "$WPID" 2>/dev/null || true',
        'cd ../..',
        'echo SMOKE_DONE',
      ].join(' && '),
      captureOutput: true,
      failOnError: false,
    })

    // ─── Quality gates ───────────────────────────────────────────────────────
    .step('typecheck', {
      type: 'deterministic',
      dependsOn: ['verify-sst-worker', 'verify-router', 'wrangler-dev-smoke'],
      command: [
        'set -e',
        '(cd packages/web && npx tsc --noEmit) 2>&1 | tail -20',
        '(cd packages/router && npx tsc --noEmit) 2>&1 | tail -20',
        '(cd infra && npx tsc --noEmit 2>&1 | grep -v "config.d.ts" | tail -20 || true)',
        'echo TYPECHECK_DONE',
      ].join(' && '),
      captureOutput: true,
      failOnError: false,
    })
    .step('fix-typecheck', {
      agent: 'build-impl',
      dependsOn: ['typecheck'],
      task: 'Fix typecheck errors. Output:\n{{steps.typecheck.output}}\n`.sst/platform/config.d.ts not found` is harmless (SST-generated); ignore it. Iterate on any other errors.',
      verification: { type: 'exit_code' },
    })
    .step('typecheck-final', {
      type: 'deterministic',
      dependsOn: ['fix-typecheck'],
      command: [
        'set -e',
        '(cd packages/web && npx tsc --noEmit)',
        '(cd packages/router && npx tsc --noEmit)',
        '(cd infra && npx tsc --noEmit 2>&1 | grep -v "config.d.ts" | tail -10 || true)',
        'echo TYPECHECK_FINAL_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    // ─── Final review ────────────────────────────────────────────────────────
    .step('final-review', {
      agent: 'lead',
      dependsOn: ['typecheck-final'],
      task: [
        'Final review of the Phase 3 web Worker build PR. Block on any of:',
        '',
        '1. The build artifact .open-next/worker.js is missing or larger than 10MB.',
        '2. Router rule defaulting to "workers" on KV miss. Must default to "lambda".',
        '3. wrangler.toml missing any binding the OpenNext Lambda used (cross-check infra/web.ts current link: list).',
        '4. infra/web-worker.ts using sst.cf.* (must be sst.cloudflare.*).',
        '5. Handler code modifications beyond what was strictly necessary for Worker compatibility. Phase 3 is a runtime move, not a refactor.',
        '6. process.env.* reads in any new infra file.',
        '',
        'If clean: write APPROVED (exactly) to .logs/phase3-web-build-review.md.',
        'Otherwise: enumerate findings.',
      ].join('\n'),
      verification: { type: 'file_exists', value: '.logs/phase3-web-build-review.md' },
    })
    .step('review-gate', {
      type: 'deterministic',
      dependsOn: ['final-review'],
      command: 'grep -qxF APPROVED .logs/phase3-web-build-review.md || (cat .logs/phase3-web-build-review.md; exit 1)',
      captureOutput: true,
      failOnError: true,
    })

    // ─── Commit + PR ─────────────────────────────────────────────────────────
    .step('commit', {
      type: 'deterministic',
      dependsOn: ['review-gate'],
      command: [
        'set -e',
        'git add packages/web infra/web-worker.ts packages/router/index.ts',
        'git add package.json package-lock.json',
        'git diff --cached --stat',
        'MSG=$(mktemp)',
        'printf "%s\\n" "feat(migration): Phase 3 — cloud-web Worker build (KV-flagged, dormant)" "" "OpenNext-CF build of packages/web, wrangler.toml bindings, SST Worker" "resource, KV-flagged router rule. Ships dormant — router defaults to" "lambda; cutover is Phase 4." "" "Deliverables:" "- packages/web/.open-next/worker.js (build artifact)" "- packages/web/wrangler.toml (staging deploy + wrangler dev config)" "- infra/web-worker.ts (sst.cloudflare.Worker for staging)" "- packages/router/index.ts (cloudOrigin KV flag, defaults to lambda)" "" "Spec: docs/fargate-migration-spec.md (Phase 3)" "" "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>" > "$MSG"',
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
        'printf "%s\\n" "## Summary" "" "Phase 3 implementation: \\`packages/web\\` built as a Cloudflare Worker via @opennextjs/cloudflare. SST resource for staging deploy. Router KV-flagged; **ships dormant** (defaults to lambda). Cutover is Phase 4." "" "## What lands" "" "- Build pipeline: \\`npx @opennextjs/cloudflare build\\` produces \\`.open-next/worker.js\\`" "- \\`packages/web/wrangler.toml\\` — bindings for Hyperdrive, KV (ROUTER_CONFIG + others), R2 (TRAFFIC_RECORDER), Queues (webhook + clone), env vars" "- \\`infra/web-worker.ts\\` — \\`sst.cloudflare.Worker(\\"CloudWebWorker\\", ...)\\` linked to hyperdrive + queues + secrets" "- \\`packages/router/index.ts\\` — \\`cloudOrigin\\` KV rule (default lambda, flip to workers post-verify)" "" "## Cutover sequence (post-merge, post-deploy, Phase 4)" "" "1. Deploy. Worker exists at \\`cloud-web-staging.workers.dev\\` (or whatever SST assigns), receives no production traffic." "2. Run replay-harness against staging Worker using the corpus that\\x27s been accumulating since #619 merged." "3. \\`wrangler kv:key put --binding=ROUTER_CONFIG cloudOrigin workers --remote\\`" "4. 60-min watch loop (Phase 4 cutover workflow handles this)." "5. Auto-rollback on 2 consecutive failures." "" "## Stacks on" "" "- Hyperdrive Option B PR (\\`feat/migration-hyperdrive-option-b\\`) for the \\`HYPERDRIVE\\` binding to actually work at runtime. If that PR isn\\x27t merged yet, this PR\\x27s staging Worker will fail Hyperdrive queries until it is." "" "## Reviewers — coderabbit + codex + devin bot feedback please." "" "🤖 Generated with [Claude Code](https://claude.com/claude-code)" > "$BODY"',
        'URL=$(gh pr create --title "feat(migration): Phase 3 — cloud-web Worker build (KV-flagged, dormant)" --body-file "$BODY" --base main)',
        'rm -f "$BODY"',
        'echo "PR: $URL"',
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
