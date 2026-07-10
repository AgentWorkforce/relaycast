// Cataloger Insights Redesign — see workflows/cataloger-insights-redesign-SPEC.md
//
// Replaces the placeholder `prs: []` / `byAssignee: {}` insight bodies with
// LLM-summarized, signal-scored output that's actually useful at a glance.
// Follow-up to cloud#382 (token scopes) + cloud#384 (path layout). Both shipped
// a *functioning but trivial* insight; this workflow makes them worth opening.
//
// Pattern: relay-80-100. The workflow does not commit until:
//   - unit tests pass (stubbed OpenRouter)
//   - typecheck is clean
//   - local E2E (fake relayfile + stubbed OpenRouter) asserts the new schema
//   - regression suites in cataloging-agent-{core,github,linear} stay green
//
// Branch:  feat/cataloger-insights-redesign
// Repo:    cloud (this repo, no worktree split)

import { workflow } from '@relayflows/core';
import { applyCloudRepoSetup } from './lib/cloud-repo-setup.ts';

const BRANCH = 'feat/cataloger-insights-redesign';

async function runWorkflow() {
  let wf = workflow('cataloger-insights-redesign')
    .description(
      'Redesign cataloger insights from flat lists to signal-bucketed + LLM-summarized output. Adds summarizeInsight() in cataloging-agent-core, extends active-prs / open-issues with reviews / checks / comments signals, and gates merge on a stubbed-OpenRouter local E2E.',
    )
    .pattern('dag')
    .channel('wf-cataloger-insights-redesign')
    .maxConcurrency(5)
    .timeout(3_600_000)

    .agent('lead', {
      cli: 'claude',
      role: 'Lead + reviewer. Locks the output schema, reviews diffs between rounds, calls the merge gate.',
      retries: 1,
    })
    .agent('impl-core', {
      cli: 'codex',
      role: 'Owns cataloging-agent-core: InsightGenerationResult schema rename, summarizeInsight helper, signal-fingerprint cache.',
      retries: 2,
    })
    .agent('impl-github', {
      cli: 'codex',
      role: 'Owns cataloging-agent-github: extend active-prs.ts to also walk reviews/checks and bucket signals (blocked-on-review, ci-failing, stale-draft, merge-conflict).',
      retries: 2,
    })
    .agent('impl-linear', {
      cli: 'codex',
      role: 'Owns cataloging-agent-linear: extend open-issues.ts to walk comments and bucket signals (unassigned-priority, stale-no-activity, customer-mentioned).',
      retries: 2,
    })
    .agent('tester', {
      cli: 'claude',
      preset: 'worker',
      role: 'Writes / fixes vitest suites with stubbed OpenRouter and the existing fake relayfile harness pattern. Iterates until tests are green.',
      retries: 2,
    });

  wf = applyCloudRepoSetup(wf, {
    branch: BRANCH,
    committerName: 'Cataloger Insights Bot',
    extraSetupCommands: [
      // Don't pre-build platform/core for this workflow — cataloging-agent-*
      // are leaf packages and the runtime/agent-persona builds aren't on the
      // critical path here. `applyCloudRepoSetup` builds them by default; we
      // skip via `skipWorkspaceBuild` below.
    ],
    skipWorkspaceBuild: true,
  });

  type StepChain = { step: (n: string, c: unknown) => StepChain };
  const chain = wf as unknown as StepChain;

  // ── Phase 1: Read current state + spec ───────────────────────────
  chain
    .step('read-spec', {
      type: 'deterministic',
      dependsOn: ['install-deps'],
      command: 'cat workflows/cataloger-insights-redesign-SPEC.md',
      captureOutput: true,
      failOnError: true,
    })
    .step('read-current-active-prs', {
      type: 'deterministic',
      dependsOn: ['install-deps'],
      command: 'cat packages/cataloging-agent-github/src/insights/active-prs.ts',
      captureOutput: true,
      failOnError: true,
    })
    .step('read-current-open-issues', {
      type: 'deterministic',
      dependsOn: ['install-deps'],
      command: 'cat packages/cataloging-agent-linear/src/insights/open-issues.ts',
      captureOutput: true,
      failOnError: true,
    })
    .step('read-insight-types', {
      type: 'deterministic',
      dependsOn: ['install-deps'],
      command: [
        'set -e',
        'echo "=== insight.ts ===" && cat packages/cataloging-agent-core/src/insight.ts',
        'echo "=== context.ts (head) ===" && head -120 packages/cataloging-agent-core/src/context.ts',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })
    .step('audit-consumers', {
      type: 'deterministic',
      dependsOn: ['install-deps'],
      command: [
        'set -e',
        'echo "=== readers of /insights/github/active-prs.json ==="',
        'grep -rn "active-prs.json" packages/ infra/ workflows/ 2>/dev/null | grep -v node_modules | grep -v ".trajectories" || echo "(none — no consumers to coordinate with)"',
        'echo',
        'echo "=== readers of /insights/linear/open-issues.json ==="',
        'grep -rn "open-issues.json" packages/ infra/ workflows/ 2>/dev/null | grep -v node_modules | grep -v ".trajectories" || echo "(none)"',
      ].join(' && '),
      captureOutput: true,
      failOnError: false,
    });

  // ── Phase 2: Schema lock ─────────────────────────────────────────
  // Single agent owns this. Everything downstream depends on the locked shape.
  chain.step('design-schema', {
    agent: 'lead',
    dependsOn: ['read-spec', 'read-insight-types', 'audit-consumers'],
    task: [
      'You are the lead on this workflow. Lock the output schema for the redesigned insights.',
      '',
      'Inputs:',
      '- Spec:',
      '{{steps.read-spec.output}}',
      '',
      '- Current insight type plumbing:',
      '{{steps.read-insight-types.output}}',
      '',
      '- Existing readers (none expected):',
      '{{steps.audit-consumers.output}}',
      '',
      'Deliverable: write a TypeScript type declaration block to packages/cataloging-agent-core/src/insight-schema.ts that defines:',
      '  - InsightSummary (the new top-level shape with `generatedAt`, `summary`, `highlights`, `metrics`, `all`).',
      '  - InsightHighlight (kind + headline + items array).',
      '  - SignalBuckets (the deterministic pre-LLM intermediate).',
      '',
      'Constraints:',
      '  - `all` keeps the existing flat shape so programmatic consumers stay readable.',
      '  - `summary` is `string | null` — null means the LLM step failed and the writer fell back.',
      '  - `highlights[].kind` is a discriminated union — github buckets and linear buckets each have their own `kind` literals.',
      '',
      'Write only this one file. Do not edit insight.ts or anything else in this step.',
    ].join('\n'),
    verification: { type: 'file_exists', value: 'packages/cataloging-agent-core/src/insight-schema.ts' },
  });

  chain.step('verify-schema', {
    type: 'deterministic',
    dependsOn: ['design-schema'],
    command: [
      'set -e',
      'test -f packages/cataloging-agent-core/src/insight-schema.ts || (echo "MISSING"; exit 1)',
      'grep -q "InsightSummary" packages/cataloging-agent-core/src/insight-schema.ts || (echo "MISSING TYPE InsightSummary"; exit 1)',
      'grep -q "InsightHighlight" packages/cataloging-agent-core/src/insight-schema.ts || (echo "MISSING TYPE InsightHighlight"; exit 1)',
      'grep -q "SignalBuckets" packages/cataloging-agent-core/src/insight-schema.ts || (echo "MISSING TYPE SignalBuckets"; exit 1)',
      'echo SCHEMA_OK',
    ].join(' && '),
    captureOutput: true,
    failOnError: true,
  });

  // ── Phase 3: summarizeInsight LLM helper ─────────────────────────
  chain.step('write-llm-helper', {
    agent: 'impl-core',
    dependsOn: ['verify-schema'],
    task: [
      'Add a new file packages/cataloging-agent-core/src/llm.ts that exports:',
      '',
      '  export async function summarizeInsight(input: {',
      '    domain: "github" | "linear";',
      '    signals: SignalBuckets;',
      '    metrics: Record<string, number>;',
      '    apiKey: string;',
      '    signal?: AbortSignal;',
      '  }): Promise<{ summary: string } | { summary: null; reason: string }>;',
      '',
      'Behavior:',
      '  - POST to https://openrouter.ai/api/v1/chat/completions with model "openai/gpt-4o-mini".',
      '  - Use globalThis.fetch (NOT bare fetch — see .claude/rules/workers-fetch.md, this runs in Cloudflare Workers).',
      '  - Headers: Authorization: "Bearer ${apiKey}", Content-Type: application/json.',
      '  - Body: { model, messages: [system, user] }. System prompt: morning-standup briefer. User prompt: structured JSON of signals + metrics + ask for ≤3 sentences.',
      '  - Hard timeout: 3000ms via AbortController. Wire input.signal as a parent.',
      '  - On any non-2xx, network error, timeout, or unparseable response: return { summary: null, reason: <short string> }. Never throw.',
      '',
      'Import SignalBuckets from ./insight-schema.js. Export the function.',
      '',
      'Only edit / create this one file. Do not modify insight.ts or active-prs.ts in this step.',
    ].join('\n'),
    verification: { type: 'file_exists', value: 'packages/cataloging-agent-core/src/llm.ts' },
  });

  chain.step('verify-llm-helper', {
    type: 'deterministic',
    dependsOn: ['write-llm-helper'],
    command: [
      'set -e',
      'grep -q "summarizeInsight" packages/cataloging-agent-core/src/llm.ts || (echo "MISSING export"; exit 1)',
      'grep -q "globalThis.fetch" packages/cataloging-agent-core/src/llm.ts || (echo "ERROR: must use globalThis.fetch (.claude/rules/workers-fetch.md)"; exit 1)',
      'grep -q "openrouter.ai" packages/cataloging-agent-core/src/llm.ts || (echo "MISSING OpenRouter URL"; exit 1)',
      '! grep -q "throw " packages/cataloging-agent-core/src/llm.ts || (echo "ERROR: summarizeInsight must never throw — return { summary: null } on failure"; exit 1)',
      'echo LLM_HELPER_OK',
    ].join(' && '),
    captureOutput: true,
    failOnError: true,
  });

  // ── Phase 4: Wire schema + cache into insight.ts ─────────────────
  chain.step('rewrite-insight-write', {
    agent: 'impl-core',
    dependsOn: ['verify-llm-helper'],
    task: [
      'Update packages/cataloging-agent-core/src/insight.ts to:',
      '',
      '1. Import the new types from ./insight-schema.js.',
      '2. Add a new exported helper `writeInsightWithSummary(context, insight, signals, summary, all)` that:',
      '   - Computes a signal fingerprint (sha256 over JSON.stringify({ signals, metrics })).',
      '   - Reads the existing file. If `existing.semantics.properties["cataloging.signalFingerprint"]` matches and the existing file already has a non-null `summary`, reuse the existing summary instead of calling the LLM (caller is responsible for the LLM call decision — see usage in active-prs.ts wiring step).',
      '   - Stores cataloging.signalFingerprint alongside the existing fingerprint properties.',
      '   - Writes the new InsightSummary shape.',
      '',
      '3. Keep the original `writeInsight` exported for backward compat with any caller not yet migrated. Add a JSDoc deprecation note pointing at writeInsightWithSummary.',
      '',
      'Only edit insight.ts. Do not touch active-prs.ts or open-issues.ts in this step.',
    ].join('\n'),
    verification: { type: 'exit_code' },
  });

  chain.step('verify-insight-rewrite', {
    type: 'deterministic',
    dependsOn: ['rewrite-insight-write'],
    command: [
      'set -e',
      'if git diff --quiet packages/cataloging-agent-core/src/insight.ts; then echo "NOT MODIFIED"; exit 1; fi',
      'grep -q "writeInsightWithSummary" packages/cataloging-agent-core/src/insight.ts || (echo "MISSING new helper"; exit 1)',
      'grep -q "signalFingerprint" packages/cataloging-agent-core/src/insight.ts || (echo "MISSING signal fingerprint"; exit 1)',
      'echo INSIGHT_REWRITE_OK',
    ].join(' && '),
    captureOutput: true,
    failOnError: true,
  });

  // ── Phase 5: Domain implementations (GitHub + Linear in parallel) ──
  chain.step('extend-active-prs', {
    agent: 'impl-github',
    dependsOn: ['verify-insight-rewrite'],
    task: [
      'Update packages/cataloging-agent-github/src/insights/active-prs.ts to produce the new InsightSummary shape.',
      '',
      'Inputs:',
      '- Current file:',
      '{{steps.read-current-active-prs.output}}',
      '',
      '- Spec:',
      '{{steps.read-spec.output}}',
      '',
      'Steps:',
      '1. Keep the two-phase walk for /github/repos. Add a parallel walk for {repoDir}/reviews and {repoDir}/checks at depth 2 — these are sibling subtrees of /pulls. Read each metadata file to extract review state + check_run conclusion + headSha.',
      '2. Compute SignalBuckets (blocked-on-review, ci-failing, stale-draft, merge-conflict) by joining PR + reviews + checks on PR headSha or PR number.',
      '3. Compute metrics (openCount, draftCount, p50AgeDays, p90AgeDays).',
      '4. Build the `all` array (the existing ActivePullRequest list, unchanged shape).',
      '5. Call summarizeInsight with the OPENROUTER_API_KEY from env. If it returns { summary: null }, fall back to a deterministic summary like `${signals.total} PRs need attention. See highlights for details.`',
      '6. Return InsightSummary. Use writeInsightWithSummary (it handles the signal-fingerprint cache).',
      '',
      'IMPORTANT: do NOT use bare fetch — it must be globalThis.fetch via the helper. The summarizeInsight helper handles this, but if you add any other HTTP calls, follow the same pattern.',
      '',
      'Only edit active-prs.ts. Update the existing test file in the next step.',
    ].join('\n'),
    verification: { type: 'exit_code' },
  });

  chain.step('extend-open-issues', {
    agent: 'impl-linear',
    dependsOn: ['verify-insight-rewrite'],
    task: [
      'Update packages/cataloging-agent-linear/src/insights/open-issues.ts to produce the new InsightSummary shape.',
      '',
      'Inputs:',
      '- Current file:',
      '{{steps.read-current-open-issues.output}}',
      '',
      '- Spec:',
      '{{steps.read-spec.output}}',
      '',
      'Steps:',
      '1. Keep the existing /linear/issues listing. Add a sibling walk for /linear/comments at depth 2 — read each to extract issue link + last-updated time, indexed by issueId.',
      '2. Compute SignalBuckets (unassigned-priority, stale-no-activity, customer-mentioned). For customer-mentioned: use a hardcoded keyword list for now (e.g., ["enterprise", "production outage", "blocker"]). Real customer keyword config comes in a follow-up.',
      '3. Compute metrics (openCount, p1Count, unassignedCount, p50AgeDays).',
      '4. Build the `all` array.',
      '5. Call summarizeInsight with OPENROUTER_API_KEY. Fallback identical to the GitHub side.',
      '6. Use writeInsightWithSummary.',
      '',
      'Only edit open-issues.ts.',
    ].join('\n'),
    verification: { type: 'exit_code' },
  });

  chain.step('verify-domain-impl', {
    type: 'deterministic',
    dependsOn: ['extend-active-prs', 'extend-open-issues'],
    command: [
      'set -e',
      'if git diff --quiet packages/cataloging-agent-github/src/insights/active-prs.ts; then echo "github NOT MODIFIED"; exit 1; fi',
      'if git diff --quiet packages/cataloging-agent-linear/src/insights/open-issues.ts; then echo "linear NOT MODIFIED"; exit 1; fi',
      'grep -q "summarizeInsight" packages/cataloging-agent-github/src/insights/active-prs.ts || (echo "github missing LLM call"; exit 1)',
      'grep -q "summarizeInsight" packages/cataloging-agent-linear/src/insights/open-issues.ts || (echo "linear missing LLM call"; exit 1)',
      'grep -q "writeInsightWithSummary" packages/cataloging-agent-github/src/insights/active-prs.ts || (echo "github not on new write path"; exit 1)',
      'grep -q "writeInsightWithSummary" packages/cataloging-agent-linear/src/insights/open-issues.ts || (echo "linear not on new write path"; exit 1)',
      'echo DOMAIN_IMPL_OK',
    ].join(' && '),
    captureOutput: true,
    failOnError: true,
  });

  // ── Phase 6: Tests (test-fix-rerun loop per relay-80-100) ────────
  chain.step('write-tests', {
    agent: 'tester',
    dependsOn: ['verify-domain-impl'],
    task: [
      'Update + extend the vitest suites for the new schema:',
      '',
      'Files to touch:',
      '- packages/cataloging-agent-github/test/active-prs.test.ts (extend existing)',
      '- packages/cataloging-agent-linear/test/open-issues.test.ts (create or extend)',
      '- packages/cataloging-agent-core/src/llm.test.ts (new — test summarizeInsight with stubbed globalThis.fetch)',
      '',
      'Patterns:',
      '- Reuse the existing fake relayfile harness (depth + dir/file semantics) from active-prs.test.ts. Add fixtures for /github/repos/{owner}/{repo}/reviews/{id}.json and /checks/{id}.json so the signal-bucketing path is covered.',
      '- For summarizeInsight: stub globalThis.fetch via vi.stubGlobal. Test happy path, non-2xx, timeout (use a fake AbortController), unparseable JSON. Assert all failure modes return { summary: null, reason } and never throw.',
      '- For active-prs / open-issues end-to-end: stub globalThis.fetch to return a canned LLM completion, assert the InsightSummary shape (summary present, highlights bucketed correctly, all has the flat list, metrics filled).',
      '- Add a test that exercises the signal-fingerprint cache: same input twice = LLM stub called once.',
      '',
      'Do not run the tests yet — the next step will run them and you will iterate from output.',
    ].join('\n'),
    verification: { type: 'exit_code' },
  });

  chain.step('run-tests', {
    type: 'deterministic',
    dependsOn: ['write-tests'],
    command: [
      'set +e',
      'echo "=== cataloging-agent-core ==="',
      '(cd packages/cataloging-agent-core && npx vitest run 2>&1 | tail -60)',
      'echo "=== cataloging-agent-github ==="',
      '(cd packages/cataloging-agent-github && npx vitest run 2>&1 | tail -60)',
      'echo "=== cataloging-agent-linear ==="',
      '(cd packages/cataloging-agent-linear && npx vitest run 2>&1 | tail -60)',
    ].join('\n'),
    captureOutput: true,
    failOnError: false,
  });

  chain.step('fix-tests', {
    agent: 'tester',
    dependsOn: ['run-tests'],
    task: [
      'Read the test output below and fix any failures. Iterate until all suites are green.',
      '',
      '{{steps.run-tests.output}}',
      '',
      'After fixes, re-run from each package directory:',
      '  (cd packages/cataloging-agent-core && npx vitest run)',
      '  (cd packages/cataloging-agent-github && npx vitest run)',
      '  (cd packages/cataloging-agent-linear && npx vitest run)',
      '',
      'If a failure looks like a bug in the implementation (not the test), fix the implementation. If it looks like a test expectation drift from the spec, fix the test. When in doubt, re-read the spec at workflows/cataloger-insights-redesign-SPEC.md.',
      '',
      'Do not stop until every suite is green.',
    ].join('\n'),
    verification: { type: 'exit_code' },
  });

  chain.step('run-tests-final', {
    type: 'deterministic',
    dependsOn: ['fix-tests'],
    command: [
      'set -e',
      '(cd packages/cataloging-agent-core && npx vitest run)',
      '(cd packages/cataloging-agent-github && npx vitest run)',
      '(cd packages/cataloging-agent-linear && npx vitest run)',
      'echo TESTS_GREEN',
    ].join(' && '),
    captureOutput: true,
    failOnError: true,
  });

  // ── Phase 7: Typecheck ───────────────────────────────────────────
  chain.step('typecheck', {
    type: 'deterministic',
    dependsOn: ['run-tests-final'],
    command: [
      'set +e',
      '(cd packages/cataloging-agent-core && npx tsc --noEmit 2>&1 | tail -40); echo "core EXIT: $?"',
      '(cd packages/cataloging-agent-github && npx tsc --noEmit 2>&1 | tail -40); echo "github EXIT: $?"',
      '(cd packages/cataloging-agent-linear && npx tsc --noEmit 2>&1 | tail -40); echo "linear EXIT: $?"',
    ].join('\n'),
    captureOutput: true,
    failOnError: false,
  });

  chain.step('fix-typecheck', {
    agent: 'impl-core',
    dependsOn: ['typecheck'],
    task: [
      'Fix any type errors. Output:',
      '',
      '{{steps.typecheck.output}}',
      '',
      'Re-run after each fix. Done when every package returns EXIT: 0.',
    ].join('\n'),
    verification: { type: 'exit_code' },
  });

  chain.step('typecheck-final', {
    type: 'deterministic',
    dependsOn: ['fix-typecheck'],
    command: [
      'set -e',
      '(cd packages/cataloging-agent-core && npx tsc --noEmit)',
      '(cd packages/cataloging-agent-github && npx tsc --noEmit)',
      '(cd packages/cataloging-agent-linear && npx tsc --noEmit)',
      'echo TYPECHECK_GREEN',
    ].join(' && '),
    captureOutput: true,
    failOnError: true,
  });

  // ── Phase 8: Local E2E gate (the 80→100) ─────────────────────────
  // We don't have a real cron-runner locally, but we can drive
  // activePrsInsight.generate(ctx) + openIssuesInsight.generate(ctx) directly
  // with the fake relayfile harness + stubbed OpenRouter and assert the new
  // schema end-to-end. This is the hard merge gate.
  chain.step('write-e2e-fixture', {
    agent: 'tester',
    dependsOn: ['typecheck-final'],
    task: [
      'Create packages/cataloging-agent-github/test/active-prs.e2e.test.ts that:',
      '  - Builds a fake workspace with 1 blocked-on-review PR, 1 ci-failing PR, 1 stale-draft PR, plus reviews/checks fixtures alongside.',
      '  - Stubs globalThis.fetch so OpenRouter returns: { choices: [{ message: { content: "3 PRs need attention. acme/repo#1 blocked on review for 5 days; acme/repo#2 has CI failures; acme/repo#3 is a stale draft." } }] }.',
      '  - Calls activePrsInsight.generate(ctx) directly.',
      '  - Asserts the returned object matches the InsightSummary shape: summary is the stubbed string, highlights has all three buckets non-empty, metrics.openCount === 3, all.length === 3.',
      '  - Asserts a SECOND call (with the same fixtures) does NOT trigger another globalThis.fetch — signal-fingerprint cache hit.',
      '',
      'Mirror the same pattern into packages/cataloging-agent-linear/test/open-issues.e2e.test.ts for unassigned-priority + stale-no-activity + customer-mentioned.',
    ].join('\n'),
    verification: { type: 'file_exists', value: 'packages/cataloging-agent-github/test/active-prs.e2e.test.ts' },
  });

  chain.step('run-e2e', {
    type: 'deterministic',
    dependsOn: ['write-e2e-fixture'],
    command: [
      'set +e',
      '(cd packages/cataloging-agent-github && npx vitest run test/active-prs.e2e.test.ts 2>&1 | tail -60)',
      '(cd packages/cataloging-agent-linear && npx vitest run test/open-issues.e2e.test.ts 2>&1 | tail -60)',
    ].join('\n'),
    captureOutput: true,
    failOnError: false,
  });

  chain.step('fix-e2e', {
    agent: 'tester',
    dependsOn: ['run-e2e'],
    task: [
      'E2E output:',
      '',
      '{{steps.run-e2e.output}}',
      '',
      'Fix until both E2E suites pass. The InsightSummary shape coming out of activePrsInsight.generate / openIssuesInsight.generate is the contract — if the test fails because the implementation is wrong, fix the implementation; if the test stub is wrong, fix the test.',
    ].join('\n'),
    verification: { type: 'exit_code' },
  });

  chain.step('run-e2e-final', {
    type: 'deterministic',
    dependsOn: ['fix-e2e'],
    command: [
      'set -e',
      '(cd packages/cataloging-agent-github && npx vitest run test/active-prs.e2e.test.ts)',
      '(cd packages/cataloging-agent-linear && npx vitest run test/open-issues.e2e.test.ts)',
      'echo E2E_GREEN',
    ].join(' && '),
    captureOutput: true,
    failOnError: true,
  });

  // ── Phase 9: Regression suites ───────────────────────────────────
  chain.step('regression', {
    type: 'deterministic',
    dependsOn: ['run-e2e-final'],
    command: [
      'set -e',
      '(cd packages/cataloging-agent-core && npx vitest run)',
      '(cd packages/cataloging-agent-github && npx vitest run)',
      '(cd packages/cataloging-agent-linear && npx vitest run)',
      'echo REGRESSION_GREEN',
    ].join(' && '),
    captureOutput: true,
    failOnError: true,
  });

  // ── Phase 10: Lead review + commit ───────────────────────────────
  chain.step('lead-review', {
    agent: 'lead',
    dependsOn: ['regression'],
    task: [
      'Final spec-conformance review. Read the diff:',
      '  git diff --stat',
      '  git diff packages/cataloging-agent-core/src/llm.ts',
      '  git diff packages/cataloging-agent-core/src/insight.ts',
      '  git diff packages/cataloging-agent-github/src/insights/active-prs.ts',
      '  git diff packages/cataloging-agent-linear/src/insights/open-issues.ts',
      '',
      'Verify against the spec at workflows/cataloger-insights-redesign-SPEC.md:',
      '  - InsightSummary shape matches what the spec describes (summary, highlights, metrics, all).',
      '  - summarizeInsight never throws — fallback is in place.',
      '  - signal-fingerprint cache is wired (cron tick with no input change = no LLM call).',
      '  - No bare `fetch(` in any file under packages/cataloging-agent-* (must be globalThis.fetch).',
      '  - Both adapters use the canonical VFS paths (no /github/pulls or /linear/issues fallbacks).',
      '',
      'If anything is wrong, fix it. When the diff matches the spec, write OK to /tmp/lead-review-ok and exit.',
    ].join('\n'),
    verification: { type: 'file_exists', value: '/tmp/lead-review-ok' },
  });

  chain.step('commit', {
    type: 'deterministic',
    dependsOn: ['lead-review'],
    command: [
      'set -e',
      'git add packages/cataloging-agent-core/src/insight-schema.ts packages/cataloging-agent-core/src/llm.ts packages/cataloging-agent-core/src/insight.ts packages/cataloging-agent-core/src/llm.test.ts packages/cataloging-agent-github/src/insights/active-prs.ts packages/cataloging-agent-github/test/active-prs.test.ts packages/cataloging-agent-github/test/active-prs.e2e.test.ts packages/cataloging-agent-linear/src/insights/open-issues.ts packages/cataloging-agent-linear/test/open-issues.test.ts packages/cataloging-agent-linear/test/open-issues.e2e.test.ts',
      'BODY=$(mktemp)',
      'printf "%s\\n" "feat(cataloger): LLM-summarized insights with signal buckets" "" "Replaces the placeholder \\\"prs: []\\\" / \\\"byAssignee: {}\\\" insight bodies with" "structured signal buckets (blocked-on-review, ci-failing, stale-draft," "unassigned-priority, stale-no-activity, customer-mentioned) plus a one-" "paragraph LLM-written summary." "" "- New InsightSummary schema (summary / highlights / metrics / all) in" "  cataloging-agent-core." "- summarizeInsight() helper that calls OpenRouter with a 3s timeout and" "  never throws — failure mode degrades to the structured payload only." "- signal-fingerprint cache so repeat cron ticks with unchanged input" "  reuse the existing summary instead of re-calling the LLM." "" "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>" > "$BODY"',
      'git commit -F "$BODY"',
      'rm -f "$BODY"',
      'git log -1 --stat',
    ].join(' && '),
    captureOutput: true,
    failOnError: true,
  });

  // ── Phase 11: Push + open PR ─────────────────────────────────────
  chain.step('push-and-pr', {
    type: 'deterministic',
    dependsOn: ['commit'],
    command: [
      'set -e',
      `git push -u origin ${BRANCH}`,
      'BODY=$(mktemp)',
      'printf "%s\\n" "## Summary" "" "Follows up cloud#382 (token scopes) and cloud#384 (path layout) by replacing the still-trivial cataloger insight bodies with signal-bucketed + LLM-summarized output." "" "- New InsightSummary schema (summary / highlights / metrics / all) in cataloging-agent-core." "- summarizeInsight() OpenRouter helper with hard 3s timeout, never throws." "- signal-fingerprint cache — repeat cron ticks with unchanged input skip the LLM." "- active-prs: blocked-on-review / ci-failing / stale-draft / merge-conflict buckets." "- open-issues: unassigned-priority / stale-no-activity / customer-mentioned buckets." "" "Authored end-to-end via workflows/cataloger-insights-redesign.ts (relay-80-100 pattern)." "" "## Test plan" "- [x] Unit tests in cataloging-agent-{core,github,linear} (stubbed OpenRouter)." "- [x] E2E tests asserting full InsightSummary shape + cache hit on repeat call." "- [x] tsc --noEmit clean across all three packages." "- [ ] Post-deploy: curl /cron and confirm the insight file summary mentions specific PRs / issues by name." > "$BODY"',
      'gh pr create --title "feat(cataloger): LLM-summarized insights with signal buckets" --body-file "$BODY"',
      'rm -f "$BODY"',
    ].join(' && '),
    captureOutput: true,
    failOnError: true,
  });

  const result = await wf
    .onError('retry', { maxRetries: 2, retryDelayMs: 10_000 })
    .run({ cwd: process.cwd() });

  console.log('Workflow status:', result.status);
}

runWorkflow().catch((error) => {
  console.error(error);
  process.exit(1);
});
