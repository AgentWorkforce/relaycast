/**
 * bump-sage-after-harness-release.ts
 *
 * Pre-staged Wave 2 follow-up: after the agent-assistant harness PR merges
 * and `@agent-assistant/harness` is republished, this workflow bumps sage's
 * harness + specialists deps, runs sage's tests, cuts a sage release commit,
 * and opens a PR. Once that release lands, cloud bumps `@agentworkforce/sage`
 * to ship the redundant_tool_loop fix to production.
 *
 * THIS WORKFLOW RUNS FROM THE sage REPO. Run with:
 *   cd ../sage && agent-relay run ../cloud/workflows/bump-sage-after-harness-release.ts
 *
 * Preconditions (workflow's preflight hard-fails if not met):
 *   - @agent-assistant/harness latest published version exports the
 *     `redundant_tool_loop` HarnessStopReason variant (proves the upstream
 *     PR — the redundant-loop one — is merged + released)
 *   - sage main is clean
 *
 * Files this workflow edits in the sage repo:
 *   MOD: package.json (bumps @agent-assistant/harness + @agent-assistant/specialists; bumps sage version)
 *   MOD: package-lock.json
 *
 * Note on cloud follow-up: after this PR merges and sage republishes
 * @agentworkforce/sage, cloud needs a tiny PR bumping
 * packages/sage-worker/package.json's @agentworkforce/sage. That's small
 * enough to run via codex sub-agent (or manually) — not worth a separate
 * workflow.
 */

import { workflow } from '@relayflows/core';
import { ClaudeModels, CodexModels } from '@agent-relay/config';

const NAME = 'bump-sage-after-harness-release';
const BRANCH = 'chore/bump-aa-harness-redundant-loop';
const CHANNEL = 'wf-bump-sage-aa';

async function runWorkflow() {
  const ALLOWED_DIRTY = [
    'package\\\\.json',
    'package-lock\\\\.json',
    // trail noise — tolerate
    '\\\\.trajectories/.*',
  ].join('|');

  const result = await workflow(NAME)
    .description(
      'Bump sage @agent-assistant/harness + specialists, cut sage release, open PR',
    )
    .pattern('dag')
    .channel(CHANNEL)
    .maxConcurrency(2)
    .timeout(1_800_000)
    .agent('lead', {
      cli: 'claude',
      model: ClaudeModels.OPUS,
      role: 'Reviews dep bump + release commit shape',
      retries: 1,
    })
    .agent('impl', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      role: 'Bumps deps + sage version',
      retries: 2,
    })

    // ─────────────────────────────────────────────────────────────────
    // Phase 0: branch + install + preflight
    // ─────────────────────────────────────────────────────────────────
    .step('setup-branch', {
      type: 'deterministic',
      command: [
        'set -e',
        'git config user.email "agent@agent-relay.com"',
        'git config user.name "Sage Release Bot"',
        `git checkout -B ${BRANCH}`,
        'git log -1 --oneline',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })
    .step('preflight', {
      type: 'deterministic',
      dependsOn: ['setup-branch'],
      command: [
        'set -e',
        'BRANCH=$(git rev-parse --abbrev-ref HEAD)',
        `if [ "$BRANCH" != "${BRANCH}" ]; then echo "ERROR: wrong branch ($BRANCH)"; exit 1; fi`,
        // sanity: confirm we are in sage repo
        'test -f src/harness/slack-runner.ts || (echo "ERROR: not in sage repo"; exit 1)',
        `ALLOWED_DIRTY="${ALLOWED_DIRTY}"`,
        'DIRTY=$(git diff --name-only | grep -vE "^(${ALLOWED_DIRTY})$" || true)',
        'if [ -n "$DIRTY" ]; then echo "ERROR: unexpected drift:"; echo "$DIRTY"; exit 1; fi',
        'if ! git diff --cached --quiet; then echo "ERROR: staging dirty"; exit 1; fi',
        'gh auth status >/dev/null 2>&1 || (echo "ERROR: gh not authenticated"; exit 1)',
        // CRITICAL: confirm upstream redundant_tool_loop landed and is published
        'LATEST_HARNESS=$(npm view @agent-assistant/harness version)',
        'echo "latest @agent-assistant/harness: $LATEST_HARNESS"',
        'curl -fsS "https://unpkg.com/@agent-assistant/harness@${LATEST_HARNESS}/dist/types.d.ts" 2>/dev/null | grep -q "redundant_tool_loop" || (echo "ERROR: @agent-assistant/harness@${LATEST_HARNESS} does NOT export redundant_tool_loop. The upstream PR (workflow E) must be merged + republished BEFORE this workflow runs."; exit 1)',
        'LATEST_SPEC=$(npm view @agent-assistant/specialists version)',
        'echo "latest @agent-assistant/specialists: $LATEST_SPEC"',
        'echo PREFLIGHT_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })
    .step('install-deps', {
      type: 'deterministic',
      dependsOn: ['preflight'],
      command: 'npm install --legacy-peer-deps --no-audit --no-fund 2>&1 | tail -10',
      captureOutput: true,
      failOnError: true,
    })

    // ─────────────────────────────────────────────────────────────────
    // Phase 1: bump deps + sage version
    // ─────────────────────────────────────────────────────────────────
    .step('read-package', {
      type: 'deterministic',
      dependsOn: ['install-deps'],
      command: 'cat package.json',
      captureOutput: true,
      failOnError: true,
    })
    .step('bump-deps', {
      type: 'deterministic',
      dependsOn: ['read-package'],
      command: [
        'set -e',
        // Bump both @agent-assistant deps to their latest published versions.
        // npm install resolves to the highest version satisfying the new range.
        'LATEST_HARNESS=$(npm view @agent-assistant/harness version)',
        'LATEST_SPEC=$(npm view @agent-assistant/specialists version)',
        'echo "bumping harness → ^${LATEST_HARNESS}, specialists → ^${LATEST_SPEC}"',
        'npm install @agent-assistant/harness@^${LATEST_HARNESS} @agent-assistant/specialists@^${LATEST_SPEC} --legacy-peer-deps --no-audit --no-fund 2>&1 | tail -10',
        // Confirm package.json now points at the new ranges
        'grep -q "@agent-assistant/harness" package.json',
        'grep -q "@agent-assistant/specialists" package.json',
        'echo "=== current dep ranges ==="',
        'grep -E "@agent-assistant/(harness|specialists)" package.json',
        'echo BUMP_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })
    .step('bump-sage-version', {
      agent: 'impl',
      dependsOn: ['bump-deps'],
      task: [
        'Edit package.json to bump the sage version. Current package.json:',
        '',
        '{{steps.read-package.output}}',
        '',
        'The current version field is something like "1.5.4" or "1.5.6". Bump the PATCH component by 1 (e.g. 1.5.6 → 1.5.7). This is a chore release shipping the @agent-assistant/harness redundant_tool_loop detector.',
        '',
        'Edit ONLY the "version" field in package.json. Nothing else. Do NOT touch CHANGELOG, README, or other files — sage release commits convention is just `release(sage): vX.Y.Z` with the version bump and lockfile.',
      ].join('\n'),
      verification: { type: 'exit_code' },
    })
    .step('verify-version-bumped', {
      type: 'deterministic',
      dependsOn: ['bump-sage-version'],
      command: [
        'set -e',
        'NEW_VERSION=$(node -p "require(\\"./package.json\\").version")',
        'echo "new sage version: $NEW_VERSION"',
        // Sanity: it must NOT match origin/main's version (else no bump happened)
        'ORIG_VERSION=$(git show origin/main:package.json | node -p "JSON.parse(require(\\"fs\\").readFileSync(0,\\"utf8\\")).version")',
        'echo "main sage version: $ORIG_VERSION"',
        'if [ "$NEW_VERSION" = "$ORIG_VERSION" ]; then echo "ERROR: version was not bumped"; exit 1; fi',
        'echo VERSION_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    // ─────────────────────────────────────────────────────────────────
    // Phase 2: run sage tests + typecheck against the new deps
    // ─────────────────────────────────────────────────────────────────
    .step('run-tests', {
      type: 'deterministic',
      dependsOn: ['verify-version-bumped'],
      command: 'npm test 2>&1 | tail -40',
      captureOutput: true,
      failOnError: false,
    })
    .step('fix-tests', {
      agent: 'impl',
      dependsOn: ['run-tests'],
      task: [
        'Fix any test failures from the dep bump. If clean, exit 0.',
        '',
        '{{steps.run-tests.output}}',
        '',
        'Most likely cause: the new @agent-assistant/harness version added "redundant_tool_loop" to HarnessStopReason — sage code that exhaustively switches on the union may need a new case. Look for switch statements over HarnessStopReason or the stopReasonToUserMessage import site in src/app/slack-webhooks.ts. The published stopReasonToUserMessage helper handles the new variant for you, so just consuming it via the helper avoids the case explosion.',
        '',
        'Re-run: npm test. Iterate until green.',
      ].join('\n'),
      verification: { type: 'exit_code' },
      retries: 1,
    })
    .step('run-tests-final', {
      type: 'deterministic',
      dependsOn: ['fix-tests'],
      command: 'npm test 2>&1 | tail -10',
      captureOutput: true,
      failOnError: true,
    })
    .step('typecheck', {
      type: 'deterministic',
      dependsOn: ['run-tests-final'],
      command: 'npx tsc --noEmit 2>&1 | tail -20 || echo TSC_FAIL',
      captureOutput: true,
      failOnError: false,
    })
    .step('fix-typecheck', {
      agent: 'impl',
      dependsOn: ['typecheck'],
      task: [
        'Fix typecheck errors. If clean, exit 0.',
        '',
        '{{steps.typecheck.output}}',
        '',
        'Re-run: npx tsc --noEmit. No `as any` casts.',
      ].join('\n'),
      verification: { type: 'exit_code' },
      retries: 1,
    })
    .step('typecheck-final', {
      type: 'deterministic',
      dependsOn: ['fix-typecheck'],
      command: 'npx tsc --noEmit && echo TSC_OK',
      captureOutput: true,
      failOnError: true,
    })

    // ─────────────────────────────────────────────────────────────────
    // Phase 3: peer review (small but deserves one look)
    // ─────────────────────────────────────────────────────────────────
    .step('peer-review-prep', {
      type: 'deterministic',
      dependsOn: ['typecheck-final'],
      command: 'git diff origin/main...HEAD',
      captureOutput: true,
      failOnError: true,
    })
    .step('peer-review', {
      agent: 'lead',
      dependsOn: ['peer-review-prep'],
      task: [
        'Senior peer review of the dep bump + sage release.',
        '',
        '{{steps.peer-review-prep.output}}',
        '',
        'Checklist:',
        '  - Only package.json + package-lock.json changed (no src code edits unless required for the harness type-union expansion)?',
        '  - sage version bumped by exactly one patch increment (e.g. 1.5.6 → 1.5.7)?',
        '  - Both @agent-assistant/harness AND @agent-assistant/specialists bumped, not just one?',
        '  - If src edits were required (e.g. a new switch case for redundant_tool_loop), is the case minimally invasive and correct?',
        '',
        'If any concerns, list them with file:line references. End with ALL_CLEAR or ACTIONABLE_FINDINGS_BELOW. Report only — do not fix in this step.',
      ].join('\n'),
      verification: { type: 'exit_code' },
      retries: 1,
    })
    .step('address-peer-review', {
      agent: 'impl',
      dependsOn: ['peer-review'],
      task: [
        'Read peer-review findings. If ALL_CLEAR, exit 0.',
        '',
        '{{steps.peer-review.output}}',
        '',
        'Fix every P0 + P1. Re-run npm test + npx tsc --noEmit. P2 → DEFERRED.',
      ].join('\n'),
      verification: { type: 'exit_code' },
      retries: 1,
    })
    .step('post-review-validate', {
      type: 'deterministic',
      dependsOn: ['address-peer-review'],
      command: [
        'set -e',
        'npm test 2>&1 | tail -10',
        'npx tsc --noEmit',
        'echo POST_REVIEW_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    // ─────────────────────────────────────────────────────────────────
    // Phase 4: commit + PR (sage release convention)
    // ─────────────────────────────────────────────────────────────────
    .step('commit', {
      type: 'deterministic',
      dependsOn: ['post-review-validate'],
      command: [
        'set -e',
        'git add package.json package-lock.json',
        // If src edits were required for the harness type expansion, stage them too
        'git add src/ 2>/dev/null || true',
        'NEW_VERSION=$(node -p "require(\\"./package.json\\").version")',
        'MSG=$(mktemp)',
        'printf "%s\\n" \\',
        '  "release(sage): v${NEW_VERSION} — bump @agent-assistant/harness for redundant_tool_loop detector" \\',
        '  "" \\',
        '  "Picks up @agent-assistant/harness with the new redundant_tool_loop" \\',
        '  "stopReason. After this release publishes and cloud bumps" \\',
        '  "@agentworkforce/sage in packages/sage-worker, the deployed sage" \\',
        '  "harness will fail-fast (~3 calls) instead of burning the iteration" \\',
        '  "budget on no-progress tool loops (the production trace that motivated" \\',
        '  "the upstream change: workspace_list called 7 times in a row with" \\',
        '  "byte-identical responses → max_iterations_reached)." \\',
        '  "" \\',
        '  "Also bumps @agent-assistant/specialists alongside for hygiene" \\',
        '  "(includes the NotionLibrarian addition, even though sage doesn\'t" \\',
        '  "directly call it)." \\',
        '  "" \\',
        '  "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>" \\',
        '  > "$MSG"',
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
        `git push -u origin ${BRANCH} 2>&1 | tail -3`,
        'NEW_VERSION=$(node -p "require(\\"./package.json\\").version")',
        'BODY=$(mktemp)',
        'printf "%s\\n" \\',
        '  "## Summary" \\',
        '  "" \\',
        '  "Sage release **v${NEW_VERSION}** picking up the @agent-assistant/harness redundant_tool_loop detector." \\',
        '  "" \\',
        '  "- Bumped \\`@agent-assistant/harness\\` to latest (carries the new redundant_tool_loop stopReason)." \\',
        '  "- Bumped \\`@agent-assistant/specialists\\` to latest (hygiene, includes NotionLibrarian)." \\',
        '  "- Sage version: bump → \\`v${NEW_VERSION}\\`." \\',
        '  "" \\',
        '  "## Why this matters" \\',
        '  "" \\',
        '  "Production trace (2026-04-26) showed sage burning a full timeout window calling \\`workspace_list\\` 7 times in a row getting byte-identical responses. With the new harness shipping in this release, the harness will fail-fast at the 3rd identical call with stopReason \\`redundant_tool_loop\\` instead of looping. The published \\`stopReasonToUserMessage\\` helper now also has a sensible user-facing copy for the new variant." \\',
        '  "" \\',
        '  "## Validation" \\',
        '  "" \\',
        '  "- [x] sage test suite green against bumped deps" \\',
        '  "- [x] tsc clean" \\',
        '  "- [x] peer-reviewed by Claude Opus" \\',
        '  "- [ ] After publish, bump \\`@agentworkforce/sage\\` to \\`v${NEW_VERSION}\\` in the cloud repos \\`packages/sage-worker/package.json\\` (small follow-up PR — codex sub-agent or manual)." \\',
        '  "" \\',
        '  "🤖 Generated with [Claude Code](https://claude.com/claude-code)" \\',
        '  > "$BODY"',
        'gh pr create --title "release(sage): v${NEW_VERSION} — bump @agent-assistant/harness for redundant_tool_loop" --body-file "$BODY" 2>&1 | tee /tmp/sage-release-pr-url.txt',
        'rm -f "$BODY"',
        'echo "PR: $(tail -1 /tmp/sage-release-pr-url.txt)"',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
    .run({ cwd: process.cwd() });

  if (result.status !== 'completed') {
    throw new Error(`Workflow ended with status: ${result.status}`);
  }
  console.log('Sage release workflow complete.');
}

runWorkflow().catch((error) => {
  console.error(error);
  process.exit(1);
});
