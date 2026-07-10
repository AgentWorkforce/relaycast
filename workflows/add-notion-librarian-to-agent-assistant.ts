/**
 * add-notion-librarian-to-agent-assistant.ts
 *
 * Adds the NotionLibrarian to @agent-assistant/specialists so cloud's
 * specialist-worker has something to wire an apiFallback against. Mirrors
 * the existing GitHubLibrarian / LinearLibrarian shape exactly.
 *
 * THIS WORKFLOW RUNS FROM THE agent-assistant REPO, not cloud. Run with:
 *   cd ../agent-assistant && agent-relay run ../cloud/workflows/add-notion-librarian-to-agent-assistant.ts
 *
 * (or copy into agent-assistant/workflows/ if a workflow harness exists there)
 *
 * Files this workflow creates / edits in the agent-assistant repo:
 *   NEW: packages/specialists/src/notion/types.ts
 *   NEW: packages/specialists/src/notion/librarian.ts
 *   NEW: packages/specialists/src/notion/index.ts
 *   NEW: packages/specialists/src/notion/librarian.test.ts
 *   MOD: packages/specialists/src/index.ts (re-export the notion module)
 *
 * After merge: publish @agent-assistant/specialists (typically a minor bump
 * since this is additive — new exports, no breaking changes). Then
 * fix-notion-specialist-apifallback.ts can run in cloud.
 *
 * Production trigger: Slack DM "do you see any info about our investors in
 * notion?" returned "I could not complete that request right now." because
 * cloud has no Notion specialist at all (the agent card advertises only
 * pr_investigation, github.enumerate, linear.enumerate). This workflow is
 * the upstream half of fixing that.
 */

import { workflow } from '@relayflows/core';
import { ClaudeModels, CodexModels } from '@agent-relay/config';

const NAME = 'add-notion-librarian-to-agent-assistant';
const BRANCH = 'feat/notion-librarian';
const CHANNEL = 'wf-notion-librarian';

async function runWorkflow() {
  const ALLOWED_DIRTY = [
    'package-lock\\\\.json',
    // trail trajectory tracking is repo-wide noise — allow it as drift so
    // unrelated trail activity in the agent-assistant repo does not block
    // the workflow's preflight. The commit step uses explicit `git add`
    // paths so trajectories never accidentally get bundled into the PR.
    '\\\\.trajectories/.*',
    'packages/specialists/src/notion/types\\\\.ts',
    'packages/specialists/src/notion/librarian\\\\.ts',
    'packages/specialists/src/notion/librarian\\\\.test\\\\.ts',
    'packages/specialists/src/notion/index\\\\.ts',
    'packages/specialists/src/index\\\\.ts',
  ].join('|');

  const result = await workflow(NAME)
    .description(
      'Add NotionLibrarian to @agent-assistant/specialists so cloud can wire an apiFallback for Notion',
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
      role: 'Implements notion librarian + adapter + types',
      retries: 2,
    })
    .agent('tester', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      role: 'Writes and fixes tests',
      retries: 2,
    })

    // ─────────────────────────────────────────────────────────────────
    // Phase 0: setup branch + install + preflight
    // ─────────────────────────────────────────────────────────────────
    .step('setup-branch', {
      type: 'deterministic',
      command: [
        'set -e',
        'git config user.email "agent@agent-relay.com"',
        'git config user.name "Notion Librarian Bot"',
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
        // sanity: confirm we are in agent-assistant, not cloud
        'test -d packages/specialists/src/github || (echo "ERROR: not in agent-assistant repo (no specialists/src/github)"; exit 1)',
        'test -d packages/specialists/src/linear || (echo "ERROR: linear specialist missing — wrong branch base?"; exit 1)',
        `ALLOWED_DIRTY="${ALLOWED_DIRTY}"`,
        'DIRTY=$(git diff --name-only | grep -vE "^(${ALLOWED_DIRTY})$" || true)',
        'if [ -n "$DIRTY" ]; then echo "ERROR: unexpected drift:"; echo "$DIRTY"; exit 1; fi',
        'if ! git diff --cached --quiet; then echo "ERROR: staging dirty"; git diff --cached --stat; exit 1; fi',
        'gh auth status >/dev/null 2>&1 || (echo "ERROR: gh not authenticated"; exit 1)',
        'echo PREFLIGHT_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    // ─────────────────────────────────────────────────────────────────
    // Phase 1: read existing librarians (Linear is the closest analog —
    // GitHub is more bespoke because it has investigator + librarian split)
    // ─────────────────────────────────────────────────────────────────
    .step('read-linear-types', {
      type: 'deterministic',
      dependsOn: ['preflight'],
      command: 'cat packages/specialists/src/linear/types.ts',
      captureOutput: true,
      failOnError: true,
    })
    .step('read-linear-librarian', {
      type: 'deterministic',
      dependsOn: ['preflight'],
      command: 'cat packages/specialists/src/linear/librarian.ts',
      captureOutput: true,
      failOnError: true,
    })
    .step('read-linear-index', {
      type: 'deterministic',
      dependsOn: ['preflight'],
      command: 'cat packages/specialists/src/linear/index.ts',
      captureOutput: true,
      failOnError: true,
    })
    .step('read-linear-test', {
      type: 'deterministic',
      dependsOn: ['preflight'],
      command: 'cat packages/specialists/src/linear/librarian.test.ts',
      captureOutput: true,
      failOnError: true,
    })
    .step('read-engine', {
      type: 'deterministic',
      dependsOn: ['preflight'],
      command: 'cat packages/specialists/src/shared/librarian-engine.ts | head -120',
      captureOutput: true,
      failOnError: true,
    })
    .step('read-package-index', {
      type: 'deterministic',
      dependsOn: ['preflight'],
      command: 'cat packages/specialists/src/index.ts',
      captureOutput: true,
      failOnError: true,
    })

    // ─────────────────────────────────────────────────────────────────
    // Phase 2: implementation — types + librarian + module index
    // ─────────────────────────────────────────────────────────────────
    .step('impl-types', {
      agent: 'impl',
      dependsOn: ['read-linear-types', 'read-engine'],
      task: [
        'Create packages/specialists/src/notion/types.ts.',
        '',
        'Defines NotionEnumerationParams (the input shape for the librarian) and any related discriminated unions. Mirror Linear (below) but for Notion entity types.',
        '',
        'Notion entity types and filter keys (canonical):',
        '  entity types: "page" | "database" | "block" | "comment"',
        '  filter keys:  "type" | "database" | "title" | "tag" | "author" | "updated_window"',
        '  search provider: "notion"',
        '',
        'Properties carried on each entry (these are what the librarian engine post-filters on, and what the cloud-side apiFallback will need to populate):',
        '  - id (notion uuid)',
        '  - type (page/database/block/comment)',
        '  - title (page title or database name)',
        '  - parent (database id for pages, page id for blocks)',
        '  - tags / properties (notion property values)',
        '  - author (created_by user id or email)',
        '  - lastEditedAt',
        '  - url (notion.so URL)',
        '',
        '=== Linear types.ts (your template) ===',
        '{{steps.read-linear-types.output}}',
        '',
        '=== librarian-engine.ts (constrains the contract) ===',
        '{{steps.read-engine.output}}',
        '',
        'Only create the one file packages/specialists/src/notion/types.ts.',
      ].join('\n'),
      verification: { type: 'file_exists', value: 'packages/specialists/src/notion/types.ts' },
    })
    .step('impl-librarian', {
      agent: 'impl',
      dependsOn: ['read-linear-librarian', 'impl-types'],
      task: [
        'Create packages/specialists/src/notion/librarian.ts.',
        '',
        'Mirror Linear (below) — same overall structure: a NotionLibrarianAdapter object implementing LibrarianAdapter, then a createNotionLibrarian factory that wires it into createLibrarian.',
        '',
        'Required exports:',
        '  - NotionEnumerationType (union of "page"|"database"|"block"|"comment")',
        '  - NotionEnumerationEvidenceContent (the per-entry content shape)',
        '  - NotionEnumerationEvidence',
        '  - NotionLibrarianFindings',
        '  - NotionLibrarianSpecialist',
        '  - NotionLibrarianOptions { vfs, apiFallback? }',
        '  - createNotionLibrarian(options)',
        '  - enumerateNotion(params, options)  // sugar function',
        '',
        'Adapter implementation requirements:',
        '  - capability: "notion.enumerate"',
        '  - entityTypes: ["page", "database", "block", "comment"]',
        '  - filterKeys: ["type", "database", "title", "tag", "author"]',
        '  - searchProvider: "notion"',
        '  - listRoots(types, filters): build VFS prefix paths under /notion/ (mirror /github/repos and /linear)',
        '  - inferFilters(text, parsedFilters): infer type from "page"/"pages"/"database"/"databases" mentions',
        '  - valuesForFilter(entry, key): read entry.properties[key] (this is the bug class we keep hitting — entries MUST carry properties or post-filter drops everything)',
        '  - inferEntityType(entry): from properties.type, then from path prefix /notion/pages/ or /notion/databases/',
        '  - toEvidence(entry, type): build NotionEnumerationEvidence with id, kind:"enumeration_hit", content',
        '',
        '=== Linear librarian.ts (your template) ===',
        '{{steps.read-linear-librarian.output}}',
        '',
        'Only create the one file packages/specialists/src/notion/librarian.ts.',
      ].join('\n'),
      verification: { type: 'file_exists', value: 'packages/specialists/src/notion/librarian.ts' },
    })
    .step('impl-index', {
      agent: 'impl',
      dependsOn: ['read-linear-index', 'impl-librarian'],
      task: [
        'Create packages/specialists/src/notion/index.ts.',
        '',
        '=== Linear index.ts (your template) ===',
        '{{steps.read-linear-index.output}}',
        '',
        'Mirror exactly. Re-export from ./types.js, ./librarian.js.',
        '',
        'Then ALSO edit packages/specialists/src/index.ts (root index) to add `export * from "./notion/index.js";` next to the existing linear and github exports. Use the existing index as your template:',
        '',
        '=== root index.ts (current) ===',
        '{{steps.read-package-index.output}}',
      ].join('\n'),
      verification: { type: 'exit_code' },
    })
    .step('verify-impl', {
      type: 'deterministic',
      dependsOn: ['impl-types', 'impl-librarian', 'impl-index'],
      command: [
        'set -e',
        'test -f packages/specialists/src/notion/types.ts',
        'test -f packages/specialists/src/notion/librarian.ts',
        'test -f packages/specialists/src/notion/index.ts',
        'grep -q "createNotionLibrarian" packages/specialists/src/notion/librarian.ts',
        'grep -q "notion.enumerate" packages/specialists/src/notion/librarian.ts',
        'grep -q "./notion/index.js\\|./notion/index" packages/specialists/src/index.ts',
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
        'Self-review the new Notion librarian against Linear (the closest analog).',
        '',
        'Read these files:',
        '  1. cat packages/specialists/src/linear/types.ts',
        '  2. cat packages/specialists/src/notion/types.ts',
        '  3. cat packages/specialists/src/linear/librarian.ts',
        '  4. cat packages/specialists/src/notion/librarian.ts',
        '  5. cat packages/specialists/src/notion/index.ts',
        '  6. cat packages/specialists/src/index.ts',
        '',
        'Checklist (PASS or FAIL with line refs):',
        '  - Are all the type exports symmetric to Linear (no missing types)?',
        '  - Is `valuesForFilter(entry, key)` reading from entry.properties (not from random fields)? This is the bug class that broke github + linear.',
        '  - Does the adapter set capability="notion.enumerate" exactly?',
        '  - Does inferEntityType fall back to path-prefix detection if properties.type is absent?',
        '  - Does the root index.ts re-export the notion module?',
        '  - Does the notion/index.ts re-export both types and librarian?',
        '',
        'If any FAIL, fix in place. When all PASS, write SELF_REVIEW_OK.',
      ].join('\n'),
      verification: { type: 'output_contains', value: 'SELF_REVIEW_OK' },
      retries: 1,
    })

    // ─────────────────────────────────────────────────────────────────
    // Phase 4: tests — write, run, fix, rerun
    // ─────────────────────────────────────────────────────────────────
    .step('write-tests', {
      agent: 'tester',
      dependsOn: ['self-review', 'read-linear-test'],
      task: [
        'Write packages/specialists/src/notion/librarian.test.ts.',
        '',
        'Mirror Linear (below). Required cases:',
        '  - createNotionLibrarian({vfs}) with mock VFS returning entries with properties → matchesRequestedFilters works for type/database/title/tag.',
        '  - When apiFallback is supplied AND vfs returns 0 entries, the apiFallback fires.',
        '  - Post-filter-empty safety net (PR #61 behaviour): when vfs returns entries that all fail the filter AND apiFallback supplied, fallback is invoked and re-filtered.',
        '  - inferEntityType: from properties.type, then from /notion/pages/ path, then from /notion/databases/ path, then "unknown".',
        '  - valuesForFilter("type", entry) returns inferred type when properties.type absent.',
        '',
        '=== Linear librarian.test.ts (your template) ===',
        '{{steps.read-linear-test.output}}',
      ].join('\n'),
      verification: { type: 'file_exists', value: 'packages/specialists/src/notion/librarian.test.ts' },
    })
    .step('run-tests', {
      type: 'deterministic',
      dependsOn: ['write-tests'],
      command: 'npm test --workspace @agent-assistant/specialists 2>&1 | tail -60',
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
        'After each fix, re-run: npm test --workspace @agent-assistant/specialists',
        'Iterate until green. Do NOT skip tests or use `it.todo` to escape failures.',
      ].join('\n'),
      verification: { type: 'exit_code' },
      retries: 1,
    })
    .step('run-tests-final', {
      type: 'deterministic',
      dependsOn: ['fix-tests'],
      command: 'npm test --workspace @agent-assistant/specialists 2>&1 | tail -10',
      captureOutput: true,
      failOnError: true,
    })

    // ─────────────────────────────────────────────────────────────────
    // Phase 5: typecheck + regression
    // ─────────────────────────────────────────────────────────────────
    .step('typecheck', {
      type: 'deterministic',
      dependsOn: ['run-tests-final'],
      command: 'npx tsc -p packages/specialists/tsconfig.json --noEmit 2>&1 | tail -30 || echo TSC_FAIL',
      captureOutput: true,
      failOnError: false,
    })
    .step('fix-typecheck', {
      agent: 'impl',
      dependsOn: ['typecheck'],
      task: [
        'Fix typecheck errors below if any. If clean, exit 0.',
        '',
        '{{steps.typecheck.output}}',
        '',
        'Re-run: npx tsc -p packages/specialists/tsconfig.json --noEmit',
        'No `as any` casts.',
      ].join('\n'),
      verification: { type: 'exit_code' },
      retries: 1,
    })
    .step('typecheck-final', {
      type: 'deterministic',
      dependsOn: ['fix-typecheck'],
      command: 'npx tsc -p packages/specialists/tsconfig.json --noEmit && echo TSC_OK',
      captureOutput: true,
      failOnError: true,
    })

    // ─────────────────────────────────────────────────────────────────
    // Phase 6: PEER REVIEW
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
        'Senior peer review. Audit the diff below.',
        '',
        'Specifically:',
        '  1. Does NotionLibrarian export everything Linear exports? Symmetry.',
        '  2. Are types correctly constrained (no `any` leaking through)?',
        '  3. Does inferFilters handle the obvious natural-language patterns ("notion pages", "investor pages", etc.) — or is it too restrictive?',
        '  4. Does the adapter\'s listRoots produce sensible VFS prefixes for the entity types?',
        '  5. Test gaps: untested filter combinations, untested apiFallback paths.',
        '',
        '=== diff vs origin/main ===',
        '{{steps.peer-review-prep.output}}',
        '',
        'Output format: per finding, [P0|P1|P2] <file>:<line> <description>. End with ALL_CLEAR or ACTIONABLE_FINDINGS_BELOW.',
        '',
        'Do NOT fix in this step — report only.',
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
        'Fix every P0 and P1. After fixes:',
        '  npm test --workspace @agent-assistant/specialists',
        '  npx tsc -p packages/specialists/tsconfig.json --noEmit',
        '',
        'Confirm both pass. P2 → mark DEFERRED in your summary.',
      ].join('\n'),
      verification: { type: 'exit_code' },
      retries: 1,
    })
    .step('post-review-validate', {
      type: 'deterministic',
      dependsOn: ['address-peer-review'],
      command: [
        'set -e',
        'npm test --workspace @agent-assistant/specialists 2>&1 | tail -10',
        'npx tsc -p packages/specialists/tsconfig.json --noEmit',
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
        'git add packages/specialists/src/notion/types.ts',
        'git add packages/specialists/src/notion/librarian.ts',
        'git add packages/specialists/src/notion/librarian.test.ts',
        'git add packages/specialists/src/notion/index.ts',
        'git add packages/specialists/src/index.ts',
        'git diff --cached --quiet -- package-lock.json || git add package-lock.json',
        'MSG=$(mktemp)',
        'printf "%s\\n" \\',
        '  "feat(specialists): add NotionLibrarian (mirrors LinearLibrarian)" \\',
        '  "" \\',
        '  "Production trigger: cloud has no Notion specialist at all (the agent" \\',
        '  "card advertises only pr_investigation, github.enumerate, linear.enumerate)." \\',
        '  "Slack DM \\"do you see any info about our investors in notion?\\" returned" \\',
        '  "the canned \\"could not complete\\" reply because there\'s no specialist" \\',
        '  "for sage to delegate to." \\',
        '  "" \\',
        '  "This is the upstream half. Cloud-side wiring (notion-api-client +" \\',
        '  "notion-api-fallback + /api/v1/notion/query proxy + notion-specialist-agentic)" \\',
        '  "lands in fix-notion-specialist-apifallback workflow against the cloud repo" \\',
        '  "after this PR is merged and republished." \\',
        '  "" \\',
        '  "Mirrors LinearLibrarian shape: NotionLibrarianAdapter + createNotionLibrarian" \\',
        '  "factory + types + tests. No GitHubLibrarian-style investigator (Notion" \\',
        '  "doesn\'t have a clear investigation analog yet — add later if needed)." \\',
        '  "" \\',
        '  "Self-reviewed and peer-reviewed. Tests + typecheck green." \\',
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
        '  "Adds \\`NotionLibrarian\\` to \\`@agent-assistant/specialists\\`, mirroring the existing LinearLibrarian shape." \\',
        '  "" \\',
        '  "- New \\`packages/specialists/src/notion/types.ts\\`" \\',
        '  "- New \\`packages/specialists/src/notion/librarian.ts\\` with NotionLibrarianAdapter + createNotionLibrarian factory" \\',
        '  "- New \\`packages/specialists/src/notion/index.ts\\`" \\',
        '  "- Re-exported from root \\`packages/specialists/src/index.ts\\`" \\',
        '  "- Tests covering filter behaviour, apiFallback wiring, and the post-filter-empty safety net" \\',
        '  "" \\',
        '  "## Why" \\',
        '  "" \\',
        '  "Production: Slack DM asking sage about Notion content returns \\"I could not complete that request right now.\\" The agent card lists only github/linear/pr_investigation skills. Cloud has no Notion specialist to wire because the upstream librarian/adapter doesn\'t exist." \\',
        '  "" \\',
        '  "## Follow-up (separate PR)" \\',
        '  "" \\',
        '  "After this lands and \\`@agent-assistant/specialists\\` republishes, the cloud-side workflow \\`fix-notion-specialist-apifallback.ts\\` builds notion-api-client, notion-api-fallback, /api/v1/notion/query proxy, and the notion-specialist-agentic wiring." \\',
        '  "" \\',
        '  "## Validation" \\',
        '  "" \\',
        '  "- [x] specialists workspace tests green" \\',
        '  "- [x] tsc clean" \\',
        '  "- [x] self-reviewed against Linear analog" \\',
        '  "- [x] peer-reviewed by Claude Opus" \\',
        '  "" \\',
        '  "🤖 Generated with [Claude Code](https://claude.com/claude-code)" \\',
        '  > "$BODY"',
        'gh pr create --title "feat(specialists): add NotionLibrarian (mirrors LinearLibrarian)" --body-file "$BODY" 2>&1 | tee /tmp/notion-librarian-pr-url.txt',
        'rm -f "$BODY"',
        'echo "PR: $(tail -1 /tmp/notion-librarian-pr-url.txt)"',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
    .run({ cwd: process.cwd() });

  if (result.status !== 'completed') {
    throw new Error(`Workflow ended with status: ${result.status}`);
  }
  console.log('Notion librarian workflow complete.');
}

runWorkflow().catch((error) => {
  console.error(error);
  process.exit(1);
});
