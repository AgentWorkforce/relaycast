// Cloud Web Migration — Phase 0: Traffic Recorder + R2
// ──────────────────────────────────────────────────────────────────────────────
// Wave: 0 (parallel). Worktree: cloud-phase0-recorder.
//
// Goal: Production traffic recording so the replay harness has a real corpus.
//
// NOTE: this workflow inlines setup-branch + install-deps instead of using
// `applyCloudRepoSetup` because that helper's install step passes a
// JSON.stringify'd multi-line bash script to `bash -lc`, and the runner
// passes the `\n` escape sequences literally — bash sees them as literal
// chars, not newlines. Single-line `cmd1 && cmd2` form here is bulletproof.
// ──────────────────────────────────────────────────────────────────────────────

import { workflow } from '@relayflows/core';
import { ClaudeModels, CodexModels } from '@agent-relay/config';

const NAME = 'migration-phase0-recorder';
const BRANCH = 'feat/migration-phase0-recorder';
const CHANNEL = `wf-${NAME}`;

const ALLOWED_DIRTY = [
  'package-lock\\.json',
  'package\\.json',
  'packages/router/.*',
  'infra/traffic-recorder\\.ts',
  '\\.logs/.*',
  '\\.trajectories/.*',
  'workflows/migration-phase0-recorder\\.ts',
  'workflows/lib/.*',
].join('|');

async function runWorkflow() {
  const wf = workflow(NAME)
    .description(
      'Adds production traffic recording to the existing Cloudflare router worker. NDJSON to R2, redaction, KV-tunable sample rate, 14-day lifecycle. Additive — no routing behavior change.',
    )
    .pattern('dag')
    .channel(CHANNEL)
    .maxConcurrency(3)
    .timeout(2 * 60 * 60 * 1000)

    .agent('lead', {
      cli: 'claude',
      model: ClaudeModels.OPUS,
      role: 'Architect + reviewer. Locks recording format, redaction rules, integration point.',
      retries: 1,
    })
    .agent('worker-impl', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      role: 'Owns packages/router/src/ additions: recorder.ts, redact.ts, integration into index.ts.',
      retries: 2,
    })
    .agent('infra-impl', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      role: 'Owns infra/traffic-recorder.ts: R2 bucket, lifecycle rule, KV namespace.',
      retries: 2,
    });

  type StepChain = {
    step: (name: string, cfg: unknown) => StepChain;
    onError: (mode: string, opts?: unknown) => StepChain;
    run: (opts: { cwd: string }) => Promise<unknown>;
  };
  const chain = (wf as unknown) as StepChain;

  await chain
    // ─── setup-branch (inlined, single-line) ─────────────────────────────────
    .step('setup-branch', {
      type: 'deterministic',
      command: [
        'set -e',
        'git config user.email "agent@agent-relay.com"',
        'git config user.name "Phase 0 Recorder Bot"',
        `git checkout -B ${BRANCH}`,
        'git log -1 --oneline',
        'echo SETUP_BRANCH_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    // ─── install-deps (inlined, single-line, no JSON.stringify wrapping) ─────
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

    // ─── Preflight ───────────────────────────────────────────────────────────
    // No template literals around bash variables — they get JS-interpreted.
    // Use plain strings + string concat for the few interpolations needed.
    .step('preflight', {
      type: 'deterministic',
      dependsOn: ['install-deps'],
      command: [
        'set -e',
        // Load repo-local env files without overwriting existing exports
        'if [ -f .env.local ]; then while IFS== read -r key val; do if [ -n "${key}" ]; then if [ -z "${!key+x}" ]; then export "$key"="$val"; fi; fi; done < ".env.local"; fi',
        'if [ -f .env ]; then while IFS== read -r key val; do if [ -n "${key}" ]; then if [ -z "${!key+x}" ]; then export "$key"="$val"; fi; fi; done < ".env"; fi',
        'BRANCH_NOW=$(git rev-parse --abbrev-ref HEAD)',
        'if [ "$BRANCH_NOW" != "' + BRANCH + '" ]; then echo "ERROR: wrong branch (got $BRANCH_NOW)"; exit 1; fi',
        'ALLOWED_DIRTY="' + ALLOWED_DIRTY + '"',
        'DIRTY=$({ git diff --name-only; git ls-files --others --exclude-standard; } | sort -u | grep -vE "^(${ALLOWED_DIRTY})$" || true)',
        'if [ -n "$DIRTY" ]; then echo "ERROR: unexpected drift:"; echo "$DIRTY"; exit 1; fi',
        'test -f packages/router/index.ts || (echo "ERROR: packages/router/index.ts missing"; exit 1)',
        'command -v wrangler >/dev/null || (echo "ERROR: wrangler missing"; exit 1)',
        'echo PREFLIGHT_OK',
      ].join(' && '),
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

    .step('write-redact', {
      agent: 'worker-impl',
      dependsOn: ['preflight'],
      task: [
        'Create packages/router/src/redact.ts.',
        '',
        '1. `redactHeaders(headers)` — replaces value with `[REDACTED:N]` for:',
        '   authorization, cookie, set-cookie, x-relayauth-token, x-api-key,',
        '   any header matching /(token|secret|password|signature)/i.',
        '   Keeps everything else.',
        '',
        '2. `redactBody(path, body, contentType)`:',
        '   - Deny-list (fully redact): /api/v1/workspaces/[^/]+/secrets, /api/auth, /api/v1/auth,',
        '     /api/v1/cli/auth, /api/v1/cli/login, /api/v1/integrations/nango/connect-link,',
        '     /api/v1/workspaces/[^/]+/integrations/connect-session',
        '   - JSON path scrub for application/json: $..token, $..accessToken, $..refreshToken,',
        '     $..secret, $..apiKey, $..password, $..clientSecret, $..privateKey',
        '',
        '3. `shouldRecord(path)` — false for /observer/, /api/health, /favicon.ico. True otherwise.',
        '',
        'Post REDACT_DONE.',
      ].join('\n'),
      verification: { type: 'exit_code' },
    })
    .step('verify-redact', {
      type: 'deterministic',
      dependsOn: ['write-redact'],
      command: [
        'set -e',
        'test -f packages/router/src/redact.ts || (echo "FAIL"; exit 1)',
        'for fn in redactHeaders redactBody shouldRecord; do grep -q "$fn" packages/router/src/redact.ts || (echo "FAIL: $fn missing"; exit 1); done',
        'echo VERIFY_REDACT_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })
    
    .step('write-recorder', {
      agent: 'worker-impl',
      dependsOn: ['verify-redact'],
      task: [
        'Create packages/router/src/recorder.ts.',
        '',
        '1. `interface RecorderEnv { TRAFFIC_RECORDER: R2Bucket; ROUTER_CONFIG: KVNamespace }`',
        '',
        '2. `async function maybeRecord(request, response, env, ctx)`:',
        '   - Read KV RECORDER_SAMPLE_RATE (default 100).',
        '   - shouldRecord(path) gate first.',
        '   - Math.random() * 100 >= rate → skip.',
        '   - Clone request and response before reading bodies.',
        '   - Build record: { ts, method, path, query, request_headers, request_body, response_status, response_headers, response_body, request_id }',
        '   - NDJSON serialize, key = corpus/YYYY/MM/DD/HH/<request_id>.ndjson',
        '   - ctx.waitUntil(env.TRAFFIC_RECORDER.put(key, line)) — must NOT block response.',
        '',
        '3. Defensive: try/catch the whole thing, console.error on failure, never propagate.',
        '',
        '4. Bodies >256 KB → `[OVERSIZE:N]` placeholder.',
        '',
        'Post RECORDER_DONE.',
      ].join('\n'),
      verification: { type: 'exit_code' },
    })
    .step('verify-recorder', {
      type: 'deterministic',
      dependsOn: ['write-recorder'],
      command: [
        'set -e',
        'test -f packages/router/src/recorder.ts || (echo "FAIL"; exit 1)',
        'grep -q "maybeRecord" packages/router/src/recorder.ts || (echo "FAIL"; exit 1)',
        'grep -q "ctx.waitUntil" packages/router/src/recorder.ts || (echo "FAIL: not using ctx.waitUntil"; exit 1)',
        'grep -q "OVERSIZE" packages/router/src/recorder.ts || (echo "FAIL: missing oversize handling"; exit 1)',
        'echo VERIFY_RECORDER_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('integrate-recorder', {
      agent: 'worker-impl',
      dependsOn: ['verify-recorder', 'read-router'],
      task: [
        'Integrate maybeRecord() into packages/router/index.ts.',
        '',
        'Current router:',
        '{{steps.read-router.output}}',
        '',
        'Rule: after the upstream response is back, BEFORE returning it:',
        '',
        '  if (env.TRAFFIC_RECORDER && env.ROUTER_CONFIG) {',
        '    ctx.waitUntil(maybeRecord(request, response.clone(), env, ctx));',
        '  }',
        '',
        'Rules:',
        '- response.clone() so body stream still goes to user.',
        '- No header changes, no timing changes, no error propagation.',
        '- Only edit packages/router/index.ts.',
        '',
        'Post INTEGRATION_DONE.',
      ].join('\n'),
      verification: { type: 'exit_code' },
    })
    .step('verify-integration', {
      type: 'deterministic',
      dependsOn: ['integrate-recorder'],
      command: [
        'set -e',
        'if git diff --quiet packages/router/index.ts; then echo "FAIL: not modified"; exit 1; fi',
        'grep -q "maybeRecord" packages/router/index.ts || (echo "FAIL: not invoked"; exit 1)',
        'grep -q "response.clone" packages/router/index.ts || (echo "FAIL: missing response.clone"; exit 1)',
        'grep -q "ctx.waitUntil" packages/router/index.ts || (echo "FAIL: missing ctx.waitUntil"; exit 1)',
        'echo VERIFY_INTEGRATION_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('write-infra', {
      agent: 'infra-impl',
      dependsOn: ['preflight'],
      task: [
        'Create infra/traffic-recorder.ts.',
        '',
        '1. `new sst.cf.Bucket("TrafficRecorder")` with 14-day lifecycle rule.',
        '2. `new sst.cf.Kv("RouterConfig")` if not already declared elsewhere.',
        '3. Wire TRAFFIC_RECORDER + ROUTER_CONFIG bindings to the router Worker.',
        '   Find the router worker declaration (likely infra/edge.ts) and ADD the bindings.',
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
        'test -f infra/traffic-recorder.ts || (echo "FAIL"; exit 1)',
        'grep -q "sst.cf.Bucket" infra/traffic-recorder.ts || (echo "FAIL: no R2 bucket"; exit 1)',
        'grep -q "14" infra/traffic-recorder.ts || (echo "FAIL: missing 14-day lifecycle"; exit 1)',
        'echo VERIFY_INFRA_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('write-tests', {
      agent: 'worker-impl',
      dependsOn: ['verify-recorder'],
      task: [
        'Create packages/router/test/redact.test.ts and packages/router/test/recorder.test.ts using vitest.',
        '',
        'redact.test.ts: header redaction, body deny-list, JSON path scrub, shouldRecord rules.',
        'recorder.test.ts: 100% rate writes record; 0% rate writes nothing; deny path no put; oversize body redacted; key format matches /^corpus/\\d{4}\\/\\d{2}\\/\\d{2}\\/\\d{2}\\/[a-f0-9-]+\\.ndjson$/.',
        '',
        'Use vitest with mock R2 + KV objects.',
        '',
        'Post TESTS_DONE.',
      ].join('\n'),
      verification: { type: 'exit_code' },
    })
    .step('run-tests', {
      type: 'deterministic',
      dependsOn: ['write-tests'],
      command: 'cd packages/router && npx vitest run --reporter=basic 2>&1 | tail -40',
      captureOutput: true,
      failOnError: false,
    })
    .step('fix-tests', {
      agent: 'worker-impl',
      dependsOn: ['run-tests'],
      task: 'Fix failing tests. Output:\n{{steps.run-tests.output}}\nIterate.',
      verification: { type: 'exit_code' },
    })
    .step('run-tests-final', {
      type: 'deterministic',
      dependsOn: ['fix-tests'],
      command: 'cd packages/router && npx vitest run --reporter=basic',
      captureOutput: true,
      failOnError: true,
    })

    .step('typecheck', {
      type: 'deterministic',
      dependsOn: ['run-tests-final', 'verify-integration', 'verify-infra'],
      command: '(cd packages/router && npx tsc --noEmit) 2>&1 | tail -30 && (cd infra && npx tsc --noEmit) 2>&1 | tail -30 && echo TYPECHECK_OK',
      captureOutput: true,
      failOnError: false,
    })
    .step('fix-typecheck', {
      agent: 'worker-impl',
      dependsOn: ['typecheck'],
      task: 'Fix typecheck. Output:\n{{steps.typecheck.output}}\nIterate.',
      verification: { type: 'exit_code' },
    })
    .step('typecheck-final', {
      type: 'deterministic',
      dependsOn: ['fix-typecheck'],
      command: '(cd packages/router && npx tsc --noEmit) && (cd infra && npx tsc --noEmit) && echo TYPECHECK_FINAL_OK',
      captureOutput: true,
      failOnError: true,
    })

    .step('final-review', {
      agent: 'lead',
      dependsOn: ['typecheck-final'],
      task: [
        'Final review. Block on:',
        '1. Any handler under packages/web/ modified.',
        '2. maybeRecord() not wrapped in ctx.waitUntil.',
        '3. Recording errors propagating to user.',
        '4. Deny-list missing any sensitive route.',
        '5. R2 lifecycle absent or > 14 days.',
        '',
        'Write APPROVED to .logs/recorder-review.md if clean.',
      ].join('\n'),
      verification: { type: 'file_exists', value: '.logs/recorder-review.md' },
    })
    .step('review-gate', {
      type: 'deterministic',
      dependsOn: ['final-review'],
      command: 'grep -qxF APPROVED .logs/recorder-review.md || (cat .logs/recorder-review.md; exit 1)',
      captureOutput: true,
      failOnError: true,
    })

    .step('commit', {
      type: 'deterministic',
      dependsOn: ['review-gate'],
      command: [
        'set -e',
        'git add packages/router infra sst.config.ts',
        'MSG=$(mktemp)\ncat > "$MSG" <<\'MSG\'\nfeat(migration): Phase 0 — production traffic recorder + R2\n\nAdds NDJSON request/response capture to the existing CF router worker.\nRedaction, deny-list for secret-bearing routes, 14-day R2 lifecycle.\nKV-tunable sample rate (default 100%).\n\nAdditive — no routing behavior change. Feeds Phase 3 Layer 3 replay corpus.\n\nCo-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>\nMSG\ngit commit -F "$MSG"\nrm -f "$MSG"',
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
        'printf "%s\\n" "## Summary" "" "Production traffic recording for the cloud web migration. Feeds the replay harness corpus required for Phase 3 Layer 3." "" "## Privacy" "" "Authorization / cookie / token headers redacted. Secret-bearing routes (workspaces/secrets, auth, CLI auth, OAuth) fully redacted. Other JSON bodies get token/secret JSON-path scrub. R2 14-day lifecycle." "" "## Cost" "" "~\\$2/mo (120 GB/wk R2 at \\$\{0.015/GB-mo\})." "" "## Reviewers — coderabbit + codex bot feedback please." "" "🤖 Generated with [Claude Code](https://claude.com/claude-code)" > "$BODY"',
        'gh pr create --title "feat(migration): Phase 0 — production traffic recorder + R2" --body-file "$BODY" --base main | tee .logs/recorder-pr-url.txt',
        'rm -f "$BODY"',
        'echo "PR: $(cat .logs/recorder-pr-url.txt)"',
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
