// Writeback Reliability — preferred spec: docs/architecture/writeback-reliability.md (PR #448)
//
// Implements the cloud-side phases of the spec (plus / 2 / 3). The relayfile
// repo phases (1 mount-daemon, 4 CLI surfaces) are tracked separately.
//
// Pattern: relay-80-100. The workflow does not commit until:
//   - the new mock-Notion E2E test exists and FAILS against current consumer
//     (proves it's a real test, not a no-op)
//   - the consumer fix lands and the same test PASSES
//   - typecheck is clean
//   - existing test suites stay green
//   - token-issuance test asserts ops:read + sync:trigger appear
//
// Branch:   fix/writeback-reliability
// Repo:     cloud (this repo, no worktree split)
// Spec:     docs/architecture/writeback-reliability.md (with fallback resolution)
//
// Phases delivered here:
//   plus  — tests/relayfile-provider-writeback.e2e.test.ts gets a real
//           mock-Notion HTTP server and asserts the PATCH payload
//   2     — packages/relayfile/src/writeback/provider-executor.ts gets
//           per-attempt logging + the actual delivery fix
//   3     — packages/core/src/workspace/registry.ts adds ops:read and
//           sync:trigger to defaultJoinScopes
//
// Phases NOT delivered here (file separately or run a sibling workflow against
// the relayfile repo):
//   1     — relayfile/cmd/relayfile-cli/main.go mount-daemon writeback push
//   4     — relayfile/cmd/relayfile-cli/main.go new `writeback status`/`retry`

import { workflow } from '@relayflows/core';

const BRANCH = 'fix/writeback-reliability';
// Local-file candidates for the writeback-reliability spec, in priority
// order. ONLY include filenames whose contents are actually that spec —
// e.g. ricky-cloud-autofix-v1-plan.md is unrelated content and would
// mis-context every impl agent if used as a fallback. Stick to writeback*.
const SPEC_CANDIDATES = [
  'docs/architecture/writeback-reliability.md',
  'docs/architecture/writeback-reliability-spec.md',
] as const;
const SPEC_CANDIDATE_ARGS = SPEC_CANDIDATES.map((path) => `"${path}"`).join(' ');
const SPEC_FALLBACK = [
  '# Writeback Reliability Spec (Inline Fallback)',
  '',
  'This workflow still executes when the architecture spec file is missing.',
  'Use this fallback context to proceed with deterministic gates:',
  '- Phase plus: add mock-Notion E2E assertions for PATCH payload delivery.',
  '- Phase 2: fix provider-executor writeback delivery and add structured logs.',
  '- Phase 3: ensure join token scopes include ops:read and sync:trigger.',
  '- Keep 80-to-100 loop: failing baseline, implementation, deterministic validation, review, final hard gates.',
].join('\n');
const CONSUMER_PATH = 'packages/relayfile/src/writeback/provider-executor.ts';
const REGISTRY_PATH = 'packages/core/src/workspace/registry.ts';
const E2E_TEST_PATH = 'tests/relayfile-provider-writeback.e2e.test.ts';
const MOCK_NOTION_PATH = 'tests/helpers/mock-notion-server.ts';

async function runWorkflow() {
  let wf = workflow('writeback-reliability')
    .description(
      'Cloud-side fixes for the Notion writeback path: mock-Notion E2E test (phase plus), provider-executor delivery + logging fix (phase 2), and ops:read/sync:trigger token scopes (phase 3). Implements PR #448.',
    )
    .pattern('dag')
    .channel('wf-writeback-reliability')
    .maxConcurrency(5)
    .timeout(3_600_000)

    // Team split: codex implements, claude reviews. No lead step.
    //
    // Why no lead: in run 4fa4aff6 (relayfile) and run 42db9268 (this
    // workflow on 2026-05-05), codex-as-lead on a shared channel with
    // codex-as-impl made unilateral OWNER_DECISION calls that ended
    // the workflow before all phases finished. Codex doesn't reliably
    // distinguish "I'm coordinating, they implement" from "I'm a peer,
    // we all decide together." With three impl agents + one reviewer +
    // a shared channel, no separate lead is needed: each impl reads the
    // spec from {{steps.read-spec.output}}, reviewer-claude gates between
    // phases via review-phase-* steps, deterministic gates are the merge
    // criteria.
    .agent('impl-tests', {
      cli: 'codex',
      role:
        'Owns Phase plus: tests/helpers/mock-notion-server.ts (a small fetch-mock HTTP server that records PATCH /v1/pages/:id/markdown calls) and the extension to tests/relayfile-provider-writeback.e2e.test.ts that asserts the mock received the right payload.',
      retries: 2,
    })
    .agent('impl-consumer', {
      cli: 'codex',
      role:
        'Owns Phase 2: per-attempt structured logging at every branch in packages/relayfile/src/writeback/provider-executor.ts (start, adapter.resolved, provider.request, provider.response, provider.error, dead-letter) and the underlying delivery fix that makes the Notion PATCH actually fire. Must point at the *root cause* identified by the new logs, not paper over it.',
      retries: 2,
    })
    .agent('impl-scopes', {
      cli: 'codex',
      role:
        'Owns Phase 3: extend defaultJoinScopes in packages/core/src/workspace/registry.ts (and the relayauth scope grant in packages/relayauth/) to include ops:read and sync:trigger; add a unit test asserting the issued token contains both scopes.',
      retries: 2,
    })
    .agent('tester', {
      cli: 'codex',
      preset: 'worker',
      role:
        'Runs npx tsx --test on the new E2E test, npm run typecheck, and the existing suites. Fixes failures by reading the real test output and patching the right file. Iterates until everything green.',
      retries: 2,
    })
    .agent('reviewer-claude', {
      cli: 'claude',
      preset: 'reviewer',
      role:
        'Adversarial review of the diff after each phase. Runs `git diff main -- <files>`, posts an itemised verdict in #wf-writeback-reliability. Approves with "PHASE <name> APPROVED" once satisfied; otherwise lists specific fixes and impl-* iterates.',
      retries: 1,
    });

  // ── Repo setup: inline deterministic steps so install-deps is resumable
  //    and shell-safe in workflow runners that wrap commands.
  wf
    .step('setup-branch', {
      type: 'deterministic',
      command: [
        'set -e',
        'git config user.email "agent@agent-relay.com"',
        'git config user.name "Writeback Reliability Bot"',
        `git checkout -B ${BRANCH}`,
        'git log -1 --oneline',
        'echo SETUP_BRANCH_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })
    .step('install-deps', {
      type: 'deterministic',
      dependsOn: ['setup-branch'],
      // Keep this step free of positional shell parameters ($1/$@) so it can
      // be resumed safely via --start-from install-deps.
      command: [
        'set -euo pipefail',
        'mkdir -p .logs',
        'npm install --legacy-peer-deps --no-audit --no-fund > .logs/npm-install.log 2>&1',
        'tail -10 .logs/npm-install.log',
        'npm run build:platform > .logs/build-platform.log 2>&1',
        'tail -5 .logs/build-platform.log',
        'npm run build:core > .logs/build-core.log 2>&1',
        'tail -5 .logs/build-core.log',
        'echo INSTALL_DEPS_OK',
      ].join('\n'),
      captureOutput: true,
      failOnError: true,
    })
    .step('verify-install-deps', {
      type: 'deterministic',
      dependsOn: ['install-deps'],
      command: [
        'set -e',
        'test -s .logs/npm-install.log',
        'test -s .logs/build-platform.log',
        'test -s .logs/build-core.log',
        'grep -q "INSTALL_DEPS_OK" <<\'EOF\'',
        '{{steps.install-deps.output}}',
        'EOF',
        'echo VERIFY_INSTALL_DEPS_OK',
      ].join('\n'),
      captureOutput: true,
      failOnError: true,
    })

    // ── Preflight: validate environment + branch + clean tree (allow files
    //    the workflow will rewrite in case of resume). See skill §2b.
    .step('preflight', {
      type: 'deterministic',
      dependsOn: ['verify-install-deps'],
      command: [
        'set -e',
        'BRANCH=$(git rev-parse --abbrev-ref HEAD)',
        'echo "branch: $BRANCH"',
        `if [ "$BRANCH" != "${BRANCH}" ]; then echo "ERROR: wrong branch (expected ${BRANCH})"; exit 1; fi`,
        // Allow files this workflow will rewrite; everything else is drift.
        'ALLOWED_DIRTY="package-lock\\.json|package\\.json|tests/relayfile-provider-writeback\\.e2e\\.test\\.ts|tests/helpers/mock-notion-server\\.ts|packages/relayfile/src/writeback/provider-executor\\.ts|packages/core/src/workspace/registry\\.ts|packages/relayauth/.*"',
        'DIRTY=$({ git diff --name-only; git ls-files --others --exclude-standard; } | sort -u | grep -vE "^(${ALLOWED_DIRTY})$" || true)',
        'if [ -n "$DIRTY" ]; then echo "ERROR: unexpected tracked drift:"; echo "$DIRTY"; exit 1; fi',
        'if ! git diff --cached --quiet; then echo "ERROR: staging area is dirty"; git diff --cached --stat; exit 1; fi',
        'gh auth status >/dev/null 2>&1 || (echo "ERROR: gh CLI not authenticated"; exit 1)',
        `SPEC_FOUND=0; for candidate in ${SPEC_CANDIDATE_ARGS}; do if [ -f "$candidate" ]; then SPEC_FOUND=1; echo "spec_candidate: $candidate"; fi; done; if [ "$SPEC_FOUND" -eq 0 ]; then echo "WARN: no spec document found in expected paths; read-spec will use inline fallback context"; fi`,
        'echo PREFLIGHT_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    // ── Pre-inject context for all impl agents in one place ────────────
    //
    // Spec lives in PR #448's branch (`spec-writeback-reliability`) until
    // that PR merges. Resolution order:
    //   1. gh api against the spec PR branch (authoritative while #448 is open)
    //   2. gh api against main (covers post-merge case)
    //   3. local working tree (only if file is correctly named — otherwise
    //      we'd mis-context the impl agents with an unrelated doc)
    //   4. inline fallback summary (workflow never blocks on read-spec)
    .step('read-spec', {
      type: 'deterministic',
      dependsOn: ['preflight'],
      command: [
        'set -e',
        '# 1. Try fetching the open spec PR branch from GitHub.',
        'if SPEC=$(gh api -H "Accept: application/vnd.github.v3.raw" "/repos/AgentWorkforce/cloud/contents/docs/architecture/writeback-reliability.md?ref=spec-writeback-reliability" 2>/dev/null); then',
        '  echo "SPEC_SOURCE=gh:spec-writeback-reliability"',
        '  printf "%s\\n" "$SPEC"',
        '  exit 0',
        'fi',
        '# 2. Try main (covers the post-merge case).',
        'if SPEC=$(gh api -H "Accept: application/vnd.github.v3.raw" "/repos/AgentWorkforce/cloud/contents/docs/architecture/writeback-reliability.md?ref=main" 2>/dev/null); then',
        '  echo "SPEC_SOURCE=gh:main"',
        '  printf "%s\\n" "$SPEC"',
        '  exit 0',
        'fi',
        '# 3. Local working tree (only correctly-named files).',
        'FOUND=""',
        `for candidate in ${SPEC_CANDIDATE_ARGS}; do`,
        '  if [ -f "$candidate" ]; then',
        '    FOUND="$candidate"',
        '    break',
        '  fi',
        'done',
        'if [ -n "$FOUND" ]; then',
        '  echo "SPEC_SOURCE=local:$FOUND"',
        '  cat "$FOUND"',
        '  exit 0',
        'fi',
        '# 4. Final fallback: inline summary so the workflow is unblockable.',
        'echo "SPEC_SOURCE=inline-fallback"',
        "cat <<'EOF'",
        SPEC_FALLBACK,
        'EOF',
      ].join('\n'),
      captureOutput: true,
      failOnError: true,
    })
    .step('verify-read-spec', {
      type: 'deterministic',
      dependsOn: ['read-spec'],
      command: [
        'set -e',
        'cat <<\'EOF\' > /tmp/wf-writeback-read-spec.out',
        '{{steps.read-spec.output}}',
        'EOF',
        'grep -q "^SPEC_SOURCE=" /tmp/wf-writeback-read-spec.out',
        'echo VERIFY_READ_SPEC_OK',
      ].join('\n'),
      captureOutput: true,
      failOnError: true,
    })
    .step('read-consumer', {
      type: 'deterministic',
      dependsOn: ['preflight', 'verify-read-spec'],
      command: `cat ${CONSUMER_PATH}`,
      captureOutput: true,
      failOnError: true,
    })
    .step('read-registry', {
      type: 'deterministic',
      dependsOn: ['preflight', 'verify-read-spec'],
      command: `cat ${REGISTRY_PATH}`,
      captureOutput: true,
      failOnError: true,
    })
    .step('read-e2e-test', {
      type: 'deterministic',
      dependsOn: ['preflight', 'verify-read-spec'],
      command: `cat ${E2E_TEST_PATH}`,
      captureOutput: true,
      failOnError: true,
    })
    .step('read-notion-adapter', {
      type: 'deterministic',
      dependsOn: ['preflight', 'verify-read-spec'],
      // Read-only reference. The adapter itself doesn't change; we just want
      // impl-tests to know the request shape it's going to assert against.
      command: 'find node_modules/@relayfile/relayfile-adapters-notion -name writeback.ts 2>/dev/null | head -1 | xargs -r cat || echo "(adapter not available locally — agent will reference relayfile-adapters/packages/notion/src/writeback.ts in the sibling repo)"',
      captureOutput: true,
      failOnError: false,
    })

    // ──────────────────────────────────────────────────────────────────
    // PHASE plus — mock Notion + assertion E2E test
    // (No lead step — see agent-block comment above for why.)
    // ──────────────────────────────────────────────────────────────────
    .step('impl-mock-notion', {
      agent: 'impl-tests',
      dependsOn: ['read-e2e-test', 'read-notion-adapter'],
      task: [
        `Create tests/helpers/mock-notion-server.ts.`,
        '',
        'Export a function startMockNotion() that:',
        '  - boots an http.Server on a random localhost port',
        '  - returns { port, baseUrl, recorded, stop }',
        '  - recorded is an array of { method, path, headers, body } for every request',
        '  - responds 200 to PATCH /v1/pages/:id/markdown with a minimal Notion-ish body',
        '  - responds 200 to PATCH /v1/pages/:id with similar shape',
        '  - responds 404 to anything else',
        '',
        'Plain Node (http module + node:test friendly). No external deps. Self-contained.',
        '',
        'IMPORTANT: Write the file to disk. Do NOT output to stdout.',
      ].join('\n'),
      verification: { type: 'file_exists', value: MOCK_NOTION_PATH },
    })
    .step('verify-mock-notion', {
      type: 'deterministic',
      dependsOn: ['impl-mock-notion'],
      command: [
        'set -e',
        `test -f ${MOCK_NOTION_PATH}`,
        `grep -q "startMockNotion" ${MOCK_NOTION_PATH}`,
        `grep -q "recorded" ${MOCK_NOTION_PATH}`,
        `grep -q "PATCH" ${MOCK_NOTION_PATH}`,
        'echo OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('impl-extend-test', {
      agent: 'impl-tests',
      dependsOn: ['verify-mock-notion'],
      task: [
        `Extend ${E2E_TEST_PATH}.`,
        '',
        'Current test file:',
        '{{steps.read-e2e-test.output}}',
        '',
        'Add a new top-level test (or describe block) that:',
        '  1. startMockNotion() — capture recorded[]',
        '  2. point provider-executor at the mock baseUrl (override via env or constructor option, depending on what the file already supports)',
        '  3. enqueue a writeback for a content.md path with a known opId/pageId/markdown body',
        '  4. drive the queue synchronously (the test scaffolding already does this)',
        '  5. assert recorded.length === 1',
        '  6. assert recorded[0].method === "PATCH"',
        '  7. assert recorded[0].path matches /v1/pages/:pageId/markdown',
        '  8. assert recorded[0].body contains the markdown payload',
        '',
        'Do NOT modify any file other than this one test file.',
      ].join('\n'),
      verification: { type: 'exit_code', value: '0' },
    })
    .step('verify-extend-test', {
      type: 'deterministic',
      dependsOn: ['impl-extend-test'],
      command: [
        'set -e',
        `if git diff --quiet ${E2E_TEST_PATH}; then echo "NOT MODIFIED"; exit 1; fi`,
        `grep -q "startMockNotion" ${E2E_TEST_PATH}`,
        `grep -q "recorded" ${E2E_TEST_PATH}`,
        `grep -q "PATCH" ${E2E_TEST_PATH}`,
        'echo OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    // BASELINE: run the new test against the UNMODIFIED consumer.
    // We expect it to FAIL — proves it's a real test, not a tautology.
    .step('run-test-baseline', {
      type: 'deterministic',
      dependsOn: ['verify-extend-test'],
      command: `npx tsx --test ${E2E_TEST_PATH} 2>&1 | tail -80`,
      captureOutput: true,
      failOnError: false,
    })
    .step('assert-baseline-fails', {
      type: 'deterministic',
      dependsOn: ['run-test-baseline'],
      // The baseline run MUST contain a failure (non-zero summary or
      // "fail" in TAP output). If it passes, the test isn't actually
      // exercising the broken path and we'd ship a no-op.
      command: [
        'set -e',
        // node:test prints "# fail N" with N >= 1 when tests failed.
        'BASELINE_OUT={{steps.run-test-baseline.output}}',
        // Encode the expected sentinel: presence of "# fail 0" means all passed.
        'echo "{{steps.run-test-baseline.output}}" > /tmp/wf-baseline.log',
        'if grep -qE "^# fail 0$" /tmp/wf-baseline.log; then',
        '  echo "ERROR: baseline test PASSED — it is not exercising the broken consumer path"; exit 1;',
        'fi',
        'echo BASELINE_FAILS_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    // ──────────────────────────────────────────────────────────────────
    // PHASE 2 — fix the consumer + add logging
    // ──────────────────────────────────────────────────────────────────
    .step('impl-consumer-fix', {
      agent: 'impl-consumer',
      dependsOn: ['assert-baseline-fails'],
      task: [
        `Edit ${CONSUMER_PATH}.`,
        '',
        'Current file:',
        '{{steps.read-consumer.output}}',
        '',
        'Two changes, in this order:',
        '',
        'A. Add structured logging at every branch:',
        '   - console.log("writeback.start", { opId, workspaceId, provider, path })',
        '   - console.log("writeback.adapter.resolved", { action, endpoint, method })',
        '   - console.log("writeback.provider.request", { url, method })',
        '   - console.log("writeback.provider.response", { status, ok })',
        '   - on non-2xx: console.error("writeback.provider.error", { opId, status, bodyText })',
        '   - on dead-letter: console.error("writeback.dead_lettered", { opId, attempts, lastError })',
        '',
        'B. Fix the actual delivery bug. Use the new logs to diagnose; the spec',
        '   suggests Notion-Version header on the markdown PATCH endpoint may be',
        '   missing, or the access token may not be wired through. Identify the',
        '   ROOT cause from the logs and fix it. Do not paper over with a try/catch.',
        '',
        'Only edit this one file. Do NOT modify the test or the adapter.',
      ].join('\n'),
      verification: { type: 'exit_code', value: '0' },
    })
    .step('verify-consumer-fix', {
      type: 'deterministic',
      dependsOn: ['impl-consumer-fix'],
      command: [
        'set -e',
        `if git diff --quiet ${CONSUMER_PATH}; then echo "NOT MODIFIED"; exit 1; fi`,
        `grep -q "writeback.start" ${CONSUMER_PATH}`,
        `grep -q "writeback.provider.request" ${CONSUMER_PATH}`,
        `grep -q "writeback.provider.response" ${CONSUMER_PATH}`,
        'echo OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    // Test-fix-rerun loop on the E2E test (per relay-80-100 skill)
    .step('run-test-after-fix', {
      type: 'deterministic',
      dependsOn: ['verify-consumer-fix'],
      command: `npx tsx --test ${E2E_TEST_PATH} 2>&1 | tail -80`,
      captureOutput: true,
      failOnError: false,
    })
    .step('fix-test-failures', {
      agent: 'tester',
      dependsOn: ['run-test-after-fix'],
      task: [
        'Check the test output below. If all tests passed, do nothing.',
        'If failures: read the failing test, read the consumer, fix whichever is wrong (most likely the consumer if the test was already validated against the spec contract), re-run.',
        '',
        `Re-run command: npx tsx --test ${E2E_TEST_PATH}`,
        '',
        'Test output:',
        '{{steps.run-test-after-fix.output}}',
        '',
        'Iterate until ALL tests in the file pass.',
      ].join('\n'),
      verification: { type: 'exit_code', value: '0' },
    })
    .step('run-test-final', {
      // Hard gate. If this fails, the consumer fix isn't done.
      type: 'deterministic',
      dependsOn: ['fix-test-failures'],
      command: `npx tsx --test ${E2E_TEST_PATH} 2>&1`,
      captureOutput: true,
      failOnError: true,
    })

    .step('review-phase-plus-and-2', {
      agent: 'reviewer-claude',
      dependsOn: ['run-test-final'],
      task: [
        'Adversarial review of the Phase plus + Phase 2 diffs. Run:',
        `  git diff main -- ${MOCK_NOTION_PATH} ${E2E_TEST_PATH} ${CONSUMER_PATH}`,
        '',
        'Specifically check:',
        '  1. The new test really would fail if reverted to the original consumer (i.e., the assertion is over the recorded[] mock state, not over a side effect that already worked).',
        '  2. The mock-Notion server records request bodies as text/JSON that can be asserted, not as opaque buffers.',
        '  3. The consumer logs include enough detail (opId, status, body excerpt) that a sev-1 oncall could diagnose a real Notion outage from CloudWatch alone.',
        '  4. The delivery fix targets a root cause identified by the new logs (Notion-Version header, missing token, wrong endpoint) and is not a try/catch that papers over the failure.',
        '  5. No backwards-compatibility breakage with currently-deployed mounts that send the old payload shape.',
        '',
        'Post verdict in #wf-writeback-reliability. Approve with "PHASE plus APPROVED" and "PHASE 2 APPROVED" once satisfied; otherwise list the specific fixes and impl-tests / impl-consumer iterates.',
      ].join('\n'),
      verification: { type: 'exit_code', value: '0' },
    })

    // ──────────────────────────────────────────────────────────────────
    // PHASE 3 — token scopes
    // (Independent of phase 2, but sequenced after to keep diffs reviewable)
    // ──────────────────────────────────────────────────────────────────
    .step('impl-scopes-add', {
      agent: 'impl-scopes',
      dependsOn: ['review-phase-plus-and-2'],
      task: [
        `Edit ${REGISTRY_PATH}.`,
        '',
        'Current file:',
        '{{steps.read-registry.output}}',
        '',
        'Find defaultJoinScopes (or the equivalent constant that drives the',
        'scopes embedded in the JWT issued by createWorkspaceJoinAccess).',
        '',
        'Add two new scopes:',
        '  - "ops:read"',
        '  - "sync:trigger"',
        '',
        'If the same scope list is duplicated in packages/relayauth/ (the',
        'underlying scope grant), update it there too — keep them in lockstep.',
        '',
        'Only edit registry.ts (and packages/relayauth/ if needed). Do NOT',
        'touch the consumer or any test files.',
      ].join('\n'),
      verification: { type: 'exit_code', value: '0' },
    })
    .step('verify-scopes-add', {
      type: 'deterministic',
      dependsOn: ['impl-scopes-add'],
      command: [
        'set -e',
        `if git diff --quiet ${REGISTRY_PATH}; then echo "NOT MODIFIED"; exit 1; fi`,
        `grep -q "ops:read" ${REGISTRY_PATH} || (echo "MISSING ops:read in registry"; exit 1)`,
        `grep -q "sync:trigger" ${REGISTRY_PATH} || (echo "MISSING sync:trigger in registry"; exit 1)`,
        'echo OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('impl-scopes-test', {
      agent: 'impl-scopes',
      dependsOn: ['verify-scopes-add'],
      task: [
        'Add a unit test that asserts an issued workspace join token contains',
        'ops:read AND sync:trigger in its scopes claim.',
        '',
        'Place the test next to the existing workspace registry tests (look',
        'under tests/ for files matching workspace-registry or join — pick the',
        'closest neighbor and either extend it or create a sibling).',
        '',
        'Use the existing test infrastructure (whatever PGlite/mock helpers',
        'the neighboring tests use). Do NOT introduce new mocking frameworks.',
      ].join('\n'),
      verification: { type: 'exit_code', value: '0' },
    })

    .step('review-phase-3', {
      agent: 'reviewer-claude',
      dependsOn: ['impl-scopes-test'],
      task: [
        `Adversarial review of the Phase 3 diff. Run: git diff main -- ${REGISTRY_PATH} packages/relayauth/`,
        '',
        'Specifically check:',
        '  1. ops:read and sync:trigger are added to the canonical defaultJoinScopes — not to a parallel constant that no caller actually uses.',
        '  2. The relayauth-side scope grant (if updated) stays in lockstep with the cloud-side default.',
        '  3. The new token-scope test asserts both scopes appear in the issued JWT, not just in the request the workspace registry sends to relayauth.',
        '  4. No widening beyond ops:read + sync:trigger — adding e.g. fs:admin or workspace:* would silently grant agents broader access than needed.',
        '',
        'Approve with "PHASE 3 APPROVED" once satisfied.',
      ].join('\n'),
      verification: { type: 'exit_code', value: '0' },
    })

    // ──────────────────────────────────────────────────────────────────
    // Regression — typecheck + full test suite
    // ──────────────────────────────────────────────────────────────────
    .step('typecheck', {
      type: 'deterministic',
      dependsOn: ['review-phase-3'],
      command: 'npm run typecheck 2>&1 | tail -40',
      captureOutput: true,
      failOnError: false,
    })
    .step('fix-typecheck', {
      agent: 'tester',
      dependsOn: ['typecheck'],
      task: [
        'Fix any type errors. Output below.',
        'If clean, do nothing.',
        '',
        '{{steps.typecheck.output}}',
        '',
        'Re-run: npm run typecheck',
      ].join('\n'),
      verification: { type: 'exit_code', value: '0' },
    })
    .step('typecheck-final', {
      type: 'deterministic',
      dependsOn: ['fix-typecheck'],
      command: 'npm run typecheck 2>&1 | tail -10',
      captureOutput: true,
      failOnError: true,
    })

    .step('run-existing-tests', {
      type: 'deterministic',
      dependsOn: ['typecheck-final'],
      command: 'npm test 2>&1 | tail -60',
      captureOutput: true,
      failOnError: false,
    })
    .step('fix-regressions', {
      agent: 'tester',
      dependsOn: ['run-existing-tests'],
      task: [
        'Check the existing test suite for regressions. If clean, do nothing.',
        '',
        '{{steps.run-existing-tests.output}}',
        '',
        'If anything broke: most likely cause is the new logs hitting an',
        'existing snapshot test, or the new scopes failing a prior assertion',
        'about exact scope-list contents. Read the failing test, decide whether',
        'to update the test (if the assertion was over-strict) or revert the',
        'incidental change. Re-run: npm test',
      ].join('\n'),
      verification: { type: 'exit_code', value: '0' },
    })
    .step('run-existing-tests-final', {
      type: 'deterministic',
      dependsOn: ['fix-regressions'],
      command: 'npm test 2>&1 | tail -20',
      captureOutput: true,
      failOnError: true,
    })

    // ──────────────────────────────────────────────────────────────────
    // Final signoff — purely deterministic. The codex lead used to write
    // a free-form review here; in run 42db9268 it issued OWNER_DECISION:
    // COMPLETE while impl-scopes-add was still working and Phase 3 never
    // ran. The deterministic gates above (assert-baseline-fails,
    // run-test-final, typecheck-final, run-existing-tests-final, the per-
    // phase reviewer-claude approvals) are already the merge criteria.
    // This step just collates them as a single auditable evidence block.
    // ──────────────────────────────────────────────────────────────────
    .step('evidence-summary', {
      type: 'deterministic',
      dependsOn: ['run-existing-tests-final'],
      command: [
        'set -e',
        'echo "WORKFLOW_EVIDENCE_START"',
        'echo "baseline_gate=assert-baseline-fails"',
        'echo "post_fix_test=run-test-final"',
        'echo "typecheck=typecheck-final"',
        'echo "regression=run-existing-tests-final"',
        `git diff --name-only ${MOCK_NOTION_PATH} ${E2E_TEST_PATH} ${CONSUMER_PATH} ${REGISTRY_PATH} tests/ packages/relayauth/ | sed '/^$/d' | sort -u`,
        'echo "WORKFLOW_EVIDENCE_END"',
      ].join('\n'),
      captureOutput: true,
      failOnError: true,
    })

    .onError('retry', { maxRetries: 2, retryDelayMs: 10_000 });

  const result = await wf.run({ cwd: process.cwd() });
  console.log('Workflow status:', result.status);
}

runWorkflow().catch((error) => {
  console.error(error);
  process.exit(1);
});
