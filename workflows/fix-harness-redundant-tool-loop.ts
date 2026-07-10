/**
 * fix-harness-redundant-tool-loop.ts
 *
 * Adds redundant-tool-loop detection to @agent-assistant/harness so a model
 * stuck calling the same tool with the same args (or different args returning
 * the same output) gets killed with a clear stopReason instead of burning
 * its iteration budget on a no-progress loop.
 *
 * THIS WORKFLOW RUNS FROM THE agent-assistant REPO. Run with:
 *   cd ../agent-assistant && agent-relay run ../cloud/workflows/fix-harness-redundant-tool-loop.ts
 *
 * Production trace (2026-04-26): Slack DM "explore the codebase structure
 * deeply" hit max_iterations_reached after 9 sage-side iterations because the
 * model called workspace_list with the same path 7 times in a row, getting
 * back byte-identical 12,604-char responses every time. The harness had no
 * way to detect "same tool + same output again — make a final answer or
 * give up", so it burned the budget and produced no useful reply.
 *
 * Files this workflow creates / edits in agent-assistant:
 *   MOD: packages/harness/src/types.ts                    (add 'redundant_tool_loop' to HarnessStopReason union; add 'redundant_tool_loop' to limit_reached event variant)
 *   MOD: packages/harness/src/harness.ts                  (track recent tool results in state; detect 3 consecutive identical outputs from same toolName; emit limit_reached + buildLimitResult)
 *   MOD: packages/harness/src/stop-reason-message.ts      (add user-facing copy for the new stop reason)
 *   MOD: packages/harness/src/stop-reason-message.test.ts (regression test)
 *   NEW: packages/harness/src/harness.redundant-loop.test.ts (focused tests for the detector)
 *
 * After merge: republish @agent-assistant/harness. Cloud's specialist-worker
 * picks up the new stopReason copy automatically via stopReasonToUserMessage
 * after the next sage release bumps the harness dep.
 */

import { workflow } from '@relayflows/core';
import { ClaudeModels, CodexModels } from '@agent-relay/config';

const NAME = 'fix-harness-redundant-tool-loop';
const BRANCH = 'feat/harness-redundant-tool-loop';
const CHANNEL = 'wf-redundant-tool-loop';

async function runWorkflow() {
  const ALLOWED_DIRTY = [
    'package-lock\\\\.json',
    // trail trajectory tracking is repo-wide noise — allow as drift, the
    // commit step uses explicit `git add` paths so trajectories never
    // bundle into the PR.
    '\\\\.trajectories/.*',
    'packages/harness/src/types\\\\.ts',
    'packages/harness/src/harness\\\\.ts',
    'packages/harness/src/stop-reason-message\\\\.ts',
    'packages/harness/src/stop-reason-message\\\\.test\\\\.ts',
    'packages/harness/src/harness\\\\.redundant-loop\\\\.test\\\\.ts',
  ].join('|');

  const result = await workflow(NAME)
    .description(
      'Detect redundant-tool-loop in the harness so identical-output retries fail fast instead of exhausting the iteration budget',
    )
    .pattern('dag')
    .channel(CHANNEL)
    .maxConcurrency(4)
    .timeout(3_600_000)
    .agent('lead', {
      cli: 'claude',
      model: ClaudeModels.OPUS,
      role: 'Architect, peer reviewer',
      retries: 1,
    })
    .agent('impl', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      role: 'Implements detector + types + copy',
      retries: 2,
    })
    .agent('tester', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      role: 'Writes and fixes tests',
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
        'git config user.name "Harness Loop Bot"',
        `git checkout -B ${BRANCH}`,
        'git log -1 --oneline',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })
    .step('install-deps', {
      type: 'deterministic',
      dependsOn: ['setup-branch'],
      command: 'npm install --legacy-peer-deps --no-audit --no-fund 2>&1 | tail -10',
      captureOutput: true,
      failOnError: true,
    })
    .step('preflight', {
      type: 'deterministic',
      dependsOn: ['install-deps'],
      command: [
        'set -e',
        'BRANCH=$(git rev-parse --abbrev-ref HEAD)',
        `if [ "$BRANCH" != "${BRANCH}" ]; then echo "ERROR: wrong branch ($BRANCH)"; exit 1; fi`,
        'test -d packages/harness/src || (echo "ERROR: not in agent-assistant repo"; exit 1)',
        `ALLOWED_DIRTY="${ALLOWED_DIRTY}"`,
        'DIRTY=$(git diff --name-only | grep -vE "^(${ALLOWED_DIRTY})$" || true)',
        'if [ -n "$DIRTY" ]; then echo "ERROR: unexpected drift:"; echo "$DIRTY"; exit 1; fi',
        'if ! git diff --cached --quiet; then echo "ERROR: staging dirty"; exit 1; fi',
        'gh auth status >/dev/null 2>&1 || (echo "ERROR: gh not authenticated"; exit 1)',
        'echo PREFLIGHT_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    // ─────────────────────────────────────────────────────────────────
    // Phase 1: read targets so the impl agent has full context
    // ─────────────────────────────────────────────────────────────────
    .step('read-types', {
      type: 'deterministic',
      dependsOn: ['preflight'],
      command: 'cat packages/harness/src/types.ts',
      captureOutput: true,
      failOnError: true,
    })
    .step('read-harness', {
      type: 'deterministic',
      dependsOn: ['preflight'],
      command: 'cat packages/harness/src/harness.ts',
      captureOutput: true,
      failOnError: true,
    })
    .step('read-stop-reason', {
      type: 'deterministic',
      dependsOn: ['preflight'],
      command: 'cat packages/harness/src/stop-reason-message.ts',
      captureOutput: true,
      failOnError: true,
    })
    .step('read-stop-reason-test', {
      type: 'deterministic',
      dependsOn: ['preflight'],
      command: 'cat packages/harness/src/stop-reason-message.test.ts',
      captureOutput: true,
      failOnError: true,
    })

    // ─────────────────────────────────────────────────────────────────
    // Phase 2: implement — types + harness loop + stop-reason copy
    // ─────────────────────────────────────────────────────────────────
    .step('impl-types', {
      agent: 'impl',
      dependsOn: ['read-types'],
      task: [
        'Edit packages/harness/src/types.ts to add the new stop reason.',
        '',
        '1. Add `redundant_tool_loop` to the HarnessStopReason union (around line 321).',
        '2. Add `redundant_tool_loop` to the inline union on HarnessLimitReachedEvent.stopReason (around line 394 — same shape as max_tool_calls_reached etc).',
        '',
        'No other changes. The semantic: this stopReason fires when 3 consecutive successful tool results from the same toolName have byte-identical output content. It signals a model stuck in a no-progress loop.',
        '',
        'Current types.ts:',
        '{{steps.read-types.output}}',
        '',
        'Only edit packages/harness/src/types.ts.',
      ].join('\n'),
      verification: { type: 'exit_code' },
    })
    .step('impl-harness', {
      agent: 'impl',
      dependsOn: ['read-harness', 'impl-types'],
      task: [
        'Edit packages/harness/src/harness.ts to detect redundant-tool-loops.',
        '',
        'Specification:',
        '',
        '1. Extend MutableState (find the type/interface, around the top of the file) with:',
        '     recentToolResultHashes?: { toolName: string; outputHash: number }[];',
        '   Initialize as [] in the state-creation site (search for state initialization, e.g. `state.toolCallCount = 0`).',
        '',
        '2. After every SUCCESSFUL tool result is processed (find the block right after `state.transcript.push({ type: "tool_result", iteration, result })` and the success branch), compute:',
        '     const hash = djb2Hash(result.output ?? JSON.stringify(result.structuredOutput ?? {}));',
        '     state.recentToolResultHashes ??= [];',
        '     state.recentToolResultHashes.push({ toolName: result.toolName, outputHash: hash });',
        '     if (state.recentToolResultHashes.length > 5) state.recentToolResultHashes.shift();',
        '   Then check: if the LAST 3 entries are all from the SAME toolName AND same outputHash, fire:',
        '     finalResult = await buildLimitResult(config, input, state, "redundant_tool_loop");',
        '     return finalResult;',
        '',
        '3. Add a `djb2Hash(s: string): number` helper at the bottom of the file. djb2 is a simple non-crypto hash; 4 lines:',
        '     function djb2Hash(s: string): number {',
        '       let hash = 5381;',
        '       for (let i = 0; i < s.length; i++) hash = ((hash * 33) ^ s.charCodeAt(i)) | 0;',
        '       return hash;',
        '     }',
        '',
        '4. Update buildLimitResult to accept "redundant_tool_loop" in its `stopReason` parameter type (it currently constrains to `Extract<HarnessStopReason, "max_iterations_reached" | "max_tool_calls_reached" | "timeout_reached" | "budget_reached">` — widen to include "redundant_tool_loop").',
        '',
        '5. The `outcome` for redundant_tool_loop in buildLimitResult should be `failed`, NOT `deferred`. Reason: deferred implies "try again with more budget would help" — for a loop, more budget just burns more cost. failed signals "this is a model-side dead end; do not retry blindly."',
        '   Check buildLimitResult for the existing outcome assignment and conditionalize on stopReason if needed.',
        '',
        'Current harness.ts:',
        '{{steps.read-harness.output}}',
        '',
        'Only edit packages/harness/src/harness.ts.',
      ].join('\n'),
      verification: { type: 'exit_code' },
    })
    .step('impl-stop-reason-copy', {
      agent: 'impl',
      dependsOn: ['read-stop-reason', 'impl-types'],
      task: [
        'Edit packages/harness/src/stop-reason-message.ts to add user-facing copy for the new redundant_tool_loop stop reason.',
        '',
        'Add a case (mirror existing tone). Suggested copy:',
        '  default (canRetry=false):',
        '    "I got stuck repeating the same tool call without making progress. Try rephrasing or asking about a more specific entity."',
        '  canRetry=true variant:',
        '    "I got stuck in a loop on that tool call — let me retry with a different approach."',
        '',
        'redundant_tool_loop is NOT in the retryable set today. Treat canRetry handling consistently with how max_tool_calls_reached is handled.',
        '',
        'Current stop-reason-message.ts:',
        '{{steps.read-stop-reason.output}}',
        '',
        'Only edit packages/harness/src/stop-reason-message.ts.',
      ].join('\n'),
      verification: { type: 'exit_code' },
    })
    .step('verify-impl', {
      type: 'deterministic',
      dependsOn: ['impl-types', 'impl-harness', 'impl-stop-reason-copy'],
      command: [
        'set -e',
        // types union extended
        'grep -q "redundant_tool_loop" packages/harness/src/types.ts',
        // harness loop detector wired
        'grep -q "redundant_tool_loop" packages/harness/src/harness.ts',
        'grep -q "djb2Hash\\|outputHash" packages/harness/src/harness.ts',
        // user-facing copy added
        'grep -q "redundant_tool_loop" packages/harness/src/stop-reason-message.ts',
        'echo OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    // ─────────────────────────────────────────────────────────────────
    // Phase 3: SELF REVIEW
    // ─────────────────────────────────────────────────────────────────
    .step('self-review', {
      agent: 'lead',
      dependsOn: ['verify-impl'],
      task: [
        'Self-review the redundant-tool-loop detector. Read each file and check.',
        '',
        '  cat packages/harness/src/types.ts',
        '  cat packages/harness/src/harness.ts',
        '  cat packages/harness/src/stop-reason-message.ts',
        '',
        'Checklist (PASS or FAIL with line refs):',
        '  - HarnessStopReason union includes "redundant_tool_loop"?',
        '  - HarnessLimitReachedEvent.stopReason inline union includes "redundant_tool_loop"?',
        '  - State carries `recentToolResultHashes` initialized to []?',
        '  - The hash is computed AFTER successful tool result, not after errors (errors should not poison the loop detector)?',
        '  - The detector only fires when 3 CONSECUTIVE entries match (not 3 anywhere in the buffer)?',
        '  - The detector requires SAME toolName AND SAME outputHash (not either one alone)?',
        '  - buildLimitResult sets outcome to "failed" for redundant_tool_loop (not "deferred")?',
        '  - stop-reason-message handles redundant_tool_loop with sensible default + canRetry copy?',
        '  - djb2Hash is a pure function with no global state?',
        '',
        'If any FAIL, fix in place. When all PASS, write SELF_REVIEW_OK.',
      ].join('\n'),
      verification: { type: 'output_contains', value: 'SELF_REVIEW_OK' },
      retries: 1,
    })

    // ─────────────────────────────────────────────────────────────────
    // Phase 4: tests
    // ─────────────────────────────────────────────────────────────────
    .step('write-tests', {
      agent: 'tester',
      dependsOn: ['self-review', 'read-stop-reason-test'],
      task: [
        'Two test files to write/update:',
        '',
        '1. packages/harness/src/harness.redundant-loop.test.ts (NEW)',
        '   Use the existing harness.test.ts setup harness as a template (vi.fn mocks for adapter + tools). Cases:',
        '     a. Tool called 3 times with identical output → result.outcome === "failed", result.stopReason === "redundant_tool_loop"',
        '     b. Tool called 3 times with DIFFERENT outputs → no detection, harness continues normally',
        '     c. Two different tools each called twice with identical outputs → no detection (toolName differs)',
        '     d. Same tool called 5 times where outputs are X,X,Y,X,X → no detection (Y breaks the run)',
        '     e. Same tool called 3 times with same output BUT different inputs → still fires (intentional — output identity is the signal)',
        '     f. Tool errors do NOT contribute to the buffer (an error then 3 identical successes still fires; an error between two successes does NOT count as "3 consecutive")',
        '',
        '2. packages/harness/src/stop-reason-message.test.ts (UPDATE)',
        '   Add `redundant_tool_loop` to the ALL_STOP_REASONS array. Existing tests already iterate the array and assert non-empty, distinct copy — this should pass without further changes.',
        '   Add a focused test asserting redundant_tool_loop default copy mentions "loop" or "stuck" or "repeating" (one of those signals).',
        '',
        'Current stop-reason-message.test.ts (template):',
        '{{steps.read-stop-reason-test.output}}',
        '',
        'Use node:test (the convention in this repo). Match existing test style.',
      ].join('\n'),
      verification: { type: 'file_exists', value: 'packages/harness/src/harness.redundant-loop.test.ts' },
      retries: 1,
    })
    .step('run-tests', {
      type: 'deterministic',
      dependsOn: ['write-tests'],
      command: 'npm test --workspace @agent-assistant/harness 2>&1 | tail -60',
      captureOutput: true,
      failOnError: false,
    })
    .step('fix-tests', {
      agent: 'tester',
      dependsOn: ['run-tests'],
      task: [
        'Fix any test failures below. If everything passed, exit 0.',
        '',
        '{{steps.run-tests.output}}',
        '',
        'Re-run: npm test --workspace @agent-assistant/harness',
        'No skip / it.todo escapes.',
      ].join('\n'),
      verification: { type: 'exit_code' },
      retries: 1,
    })
    .step('run-tests-final', {
      type: 'deterministic',
      dependsOn: ['fix-tests'],
      command: 'npm test --workspace @agent-assistant/harness 2>&1 | tail -10',
      captureOutput: true,
      failOnError: true,
    })

    // ─────────────────────────────────────────────────────────────────
    // Phase 5: typecheck + regression
    // ─────────────────────────────────────────────────────────────────
    .step('typecheck', {
      type: 'deterministic',
      dependsOn: ['run-tests-final'],
      command: 'npx tsc -p packages/harness/tsconfig.json --noEmit 2>&1 | tail -30 || echo TSC_FAIL',
      captureOutput: true,
      failOnError: false,
    })
    .step('fix-typecheck', {
      agent: 'impl',
      dependsOn: ['typecheck'],
      task: [
        'Fix typecheck errors below. If clean, exit 0.',
        '',
        '{{steps.typecheck.output}}',
        '',
        'Re-run: npx tsc -p packages/harness/tsconfig.json --noEmit',
        'No `as any` casts.',
      ].join('\n'),
      verification: { type: 'exit_code' },
      retries: 1,
    })
    .step('typecheck-final', {
      type: 'deterministic',
      dependsOn: ['fix-typecheck'],
      command: 'npx tsc -p packages/harness/tsconfig.json --noEmit && echo TSC_OK',
      captureOutput: true,
      failOnError: true,
    })

    // ─────────────────────────────────────────────────────────────────
    // Phase 6: PEER REVIEW
    // ─────────────────────────────────────────────────────────────────
    .step('peer-review-prep', {
      type: 'deterministic',
      dependsOn: ['typecheck-final'],
      command: 'git diff --stat origin/main...HEAD; echo "---"; git diff origin/main...HEAD',
      captureOutput: true,
      failOnError: true,
    })
    .step('peer-review', {
      agent: 'lead',
      dependsOn: ['peer-review-prep'],
      task: [
        'Senior peer review. Audit the diff below.',
        '',
        'Specifically:',
        '  1. Hash collisions: djb2 has known weaknesses for short strings. Is the hash function reasonable for this use case (loop detection, not security)? Is there a risk of false positives where two genuinely different tool outputs hash the same?',
        '  2. False positives: any legitimate workflow where a tool returns the same output 3 times in a row but the model is making real progress? (Hard to imagine — 3 identical reads is itself a strong "no progress" signal.)',
        '  3. Stop reason copy: does the user-facing message actually help the user? Does it suggest a useful next action?',
        '  4. Test coverage: are the 6 cases in harness.redundant-loop.test.ts actually distinct? Any redundant tests? Any obvious case missing (e.g. tool result with no `output` field, only `structuredOutput`)?',
        '  5. State pollution across turns: if a harness instance runs multiple turns, does `recentToolResultHashes` get reset between turns? (It should — fresh state per turn.)',
        '  6. Buffer size choice: is 5 the right ring buffer size? Should it be configurable?',
        '',
        '=== diff vs origin/main ===',
        '{{steps.peer-review-prep.output}}',
        '',
        'Output: per finding, [P0|P1|P2] <file>:<line> <description>. End with ALL_CLEAR or ACTIONABLE_FINDINGS_BELOW. Report only.',
      ].join('\n'),
      verification: { type: 'exit_code' },
      retries: 1,
    })
    .step('address-peer-review', {
      agent: 'impl',
      dependsOn: ['peer-review'],
      task: [
        'Read peer-review findings below. If ALL_CLEAR, exit 0.',
        '',
        '{{steps.peer-review.output}}',
        '',
        'Fix every P0 + P1. After fixes:',
        '  npm test --workspace @agent-assistant/harness',
        '  npx tsc -p packages/harness/tsconfig.json --noEmit',
        '',
        'P2 → mark DEFERRED.',
      ].join('\n'),
      verification: { type: 'exit_code' },
      retries: 1,
    })
    .step('post-review-validate', {
      type: 'deterministic',
      dependsOn: ['address-peer-review'],
      command: [
        'set -e',
        'npm test --workspace @agent-assistant/harness 2>&1 | tail -10',
        'npx tsc -p packages/harness/tsconfig.json --noEmit',
        'echo POST_REVIEW_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    // ─────────────────────────────────────────────────────────────────
    // Phase 7: commit + PR
    // ─────────────────────────────────────────────────────────────────
    .step('commit', {
      type: 'deterministic',
      dependsOn: ['post-review-validate'],
      command: [
        'set -e',
        'git add packages/harness/src/types.ts',
        'git add packages/harness/src/harness.ts',
        'git add packages/harness/src/stop-reason-message.ts',
        'git add packages/harness/src/stop-reason-message.test.ts',
        'git add packages/harness/src/harness.redundant-loop.test.ts',
        'git diff --cached --quiet -- package-lock.json || git add package-lock.json',
        'MSG=$(mktemp)',
        'printf "%s\\n" \\',
        '  "feat(harness): detect redundant tool-call loops (3 consecutive identical outputs)" \\',
        '  "" \\',
        '  "Production trace 2026-04-26: Slack DM \\"explore the codebase structure" \\',
        '  "deeply\\" hit max_iterations_reached after sage\'s harness called" \\',
        '  "workspace_list with the same path 7 times in a row, getting back" \\',
        '  "byte-identical 12,604-char responses every time. The harness had no" \\',
        '  "way to detect \\"same tool + same output again — make a decision\\", so" \\',
        '  "it burned the budget and produced no useful reply." \\',
        '  "" \\',
        '  "This adds a 5-entry ring buffer of (toolName, outputHash) per turn." \\',
        '  "When the last 3 entries match on BOTH toolName and outputHash, the" \\',
        '  "harness exits with outcome=failed, stopReason=redundant_tool_loop —" \\',
        '  "failed (not deferred) because more budget will not help; the model" \\',
        '  "is dead-stuck on the same tool call and needs a different prompt or" \\',
        '  "tool surface to make progress." \\',
        '  "" \\',
        '  "User-facing copy added to stopReasonToUserMessage so consumers" \\',
        '  "(sage, specialist surfaces) automatically pick up a useful error" \\',
        '  "message instead of the generic \\"could not complete\\" fallback." \\',
        '  "" \\',
        '  "Self-reviewed and peer-reviewed by Claude Opus. Tests + typecheck green." \\',
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
        'BODY=$(mktemp)',
        'printf "%s\\n" \\',
        '  "## Summary" \\',
        '  "" \\',
        '  "Adds redundant-tool-loop detection to the harness. After every successful tool call, hashes the output and checks the last 3 entries in a 5-slot ring buffer. If 3 consecutive entries are from the same toolName and have the same outputHash, the harness exits with \\`outcome: failed, stopReason: redundant_tool_loop\\`." \\',
        '  "" \\',
        '  "- Failed (not deferred) because more budget will not unstick a model dead-looping on the same response." \\',
        '  "- 5-slot ring is per-turn; resets on new turn." \\',
        '  "- djb2 hash for output content (non-crypto; collision-tolerant for this use case — false-positive risk is multiple tool outputs hashing the same byte-for-byte, which is acceptable)." \\',
        '  "- User-facing copy added via stopReasonToUserMessage so sage/specialist surfaces inherit it for free." \\',
        '  "" \\',
        '  "## Production failure this catches" \\',
        '  "" \\',
        '  "Slack DM \\"explore the codebase structure deeply\\" → sage harness called \\`workspace_list\\` with the same path 7 times in a row (each returning byte-identical 12,604-char output) before hitting max_iterations_reached. With this PR, the harness exits at the 3rd identical response with a clear stopReason instead of burning the iteration budget." \\',
        '  "" \\',
        '  "## Validation" \\',
        '  "" \\',
        '  "- [x] harness workspace tests green (incl. 6 new cases in harness.redundant-loop.test.ts)" \\',
        '  "- [x] stop-reason-message tests green (new redundant_tool_loop case auto-covered by ALL_STOP_REASONS iteration)" \\',
        '  "- [x] tsc clean" \\',
        '  "- [x] self-reviewed and peer-reviewed" \\',
        '  "" \\',
        '  "## Downstream" \\',
        '  "" \\',
        '  "After merge + republish, cloud bumps \\`@agent-assistant/harness\\` and the next sage release picks up the new stopReason copy automatically." \\',
        '  "" \\',
        '  "🤖 Generated with [Claude Code](https://claude.com/claude-code)" \\',
        '  > "$BODY"',
        'gh pr create --title "feat(harness): detect redundant tool-call loops (3 consecutive identical outputs)" --body-file "$BODY" 2>&1 | tee /tmp/redundant-loop-pr-url.txt',
        'rm -f "$BODY"',
        'echo "PR: $(tail -1 /tmp/redundant-loop-pr-url.txt)"',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
    .run({ cwd: process.cwd() });

  if (result.status !== 'completed') {
    throw new Error(`Workflow ended with status: ${result.status}`);
  }
  console.log('Redundant-tool-loop workflow complete.');
}

runWorkflow().catch((error) => {
  console.error(error);
  process.exit(1);
});
