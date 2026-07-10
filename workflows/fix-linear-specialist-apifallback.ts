/**
 * fix-linear-specialist-apifallback.ts
 *
 * Builds the Linear apiFallback path so the Linear specialist returns real
 * data from Nango/Linear API when VFS is empty — same shape as GitHub today.
 *
 * Production trace (2026-04-26): a Slack DM "what linear issues are open?"
 * triggered the linear specialist's inner harness to call linear_enumerate
 * 9 times in a row (each returning outputLength:2 = empty `[]` with
 * warning='empty'), hit max_tool_calls_reached, and bubbled up as the canned
 * "I could not complete that request right now." Sage then fell back to
 * workspace_search + 8-way workspace_read fan-out to assemble an answer
 * (which Slack rejected). Root cause: `linear-specialist-agentic.ts:79`
 * calls `createLinearLibrarian({ vfs })` with no apiFallback because
 * cloud has no `linear-api-fallback.ts`, no `linear-api-client.ts`, and no
 * `/api/v1/linear/query` proxy endpoint. The librarian engine's apiFallback
 * safety net (PR #61) can't fire when there's no fallback to call.
 *
 * Files this workflow creates / edits:
 *   NEW: packages/web/app/api/v1/linear/query/route.ts
 *   NEW: packages/specialist-worker/src/specialist/linear-api-client.ts
 *   NEW: packages/specialist-worker/src/specialist/linear-api-fallback.ts
 *   MOD: packages/specialist-worker/src/specialist/linear-specialist-agentic.ts
 *   NEW: packages/web/app/api/v1/linear/query/route.test.ts
 *   NEW: packages/specialist-worker/src/specialist/linear-api-client.test.ts
 *   NEW: packages/specialist-worker/src/specialist/linear-api-fallback.test.ts
 *
 * Mirrors GitHub's three-file pattern:
 *   /api/v1/github/query/route.ts            (Nango proxy)
 *   specialist/github-api-client.ts          (LinearIntegration analog)
 *   specialist/github-api-fallback.ts        (LinearLibrarianApiFallback)
 *
 * Phases follow the relay-80-100 pattern: implement → self-review → write tests
 * → run-fix-rerun → typecheck → regression → peer review by Claude → fix peer
 * review findings → commit → open PR.
 */

import { workflow } from '@relayflows/core';
import { ClaudeModels, CodexModels } from '@agent-relay/config';

import { applyCloudRepoSetup } from './lib/cloud-repo-setup.ts';

const NAME = 'fix-linear-specialist-apifallback';
const BRANCH = 'feat/linear-specialist-apifallback';
const CHANNEL = 'wf-linear-specialist';

async function runWorkflow() {
  // Files the workflow's edit / create steps will rewrite — every entry must
  // also be in `git add` at commit time so an accidentally-pre-existing
  // dirty version doesn't smuggle untracked content into the PR.
  // Escape regex metacharacters (dots, slashes are fine literal).
  const ALLOWED_DIRTY = [
    'package-lock\\\\.json',
    // trail trajectory tracking is repo-wide noise — allow as drift, the
    // commit step uses explicit `git add` paths so trajectories never bundle
    // into the PR.
    '\\\\.trajectories/.*',
    'packages/web/app/api/v1/linear/query/route\\\\.ts',
    'packages/web/app/api/v1/linear/query/route\\\\.test\\\\.ts',
    'packages/specialist-worker/src/specialist/linear-api-client\\\\.ts',
    'packages/specialist-worker/src/specialist/linear-api-client\\\\.test\\\\.ts',
    'packages/specialist-worker/src/specialist/linear-api-fallback\\\\.ts',
    'packages/specialist-worker/src/specialist/linear-api-fallback\\\\.test\\\\.ts',
    'packages/specialist-worker/src/specialist/linear-specialist-agentic\\\\.ts',
  ].join('|');

  const baseWf = workflow(NAME)
    .description(
      'Wire Linear apiFallback so linear specialist returns real data when VFS is empty',
    )
    .pattern('dag')
    .channel(CHANNEL)
    .maxConcurrency(5)
    .timeout(3_600_000)
    .agent('lead', {
      cli: 'claude',
      model: ClaudeModels.OPUS,
      role: 'Architect, peer reviewer, addresses senior-eng concerns',
      retries: 1,
    })
    .agent('impl-client', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      role: 'Implements linear-api-client.ts',
      retries: 2,
    })
    .agent('impl-proxy', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      role: 'Implements /api/v1/linear/query/route.ts',
      retries: 2,
    })
    .agent('impl-fallback', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      role: 'Implements linear-api-fallback.ts',
      retries: 2,
    })
    .agent('impl-wire', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      role: 'Wires apiFallback into linear-specialist-agentic.ts',
      retries: 2,
    })
    .agent('tester', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      role: 'Writes and fixes tests',
      retries: 2,
    });

  const wf = applyCloudRepoSetup(baseWf, {
    branch: BRANCH,
    committerName: 'Linear Specialist Bot',
  });

  const result = await wf
    // ─────────────────────────────────────────────────────────────────
    // Phase 0: preflight — environment validation + dirty-file allowlist
    // ─────────────────────────────────────────────────────────────────
    .step('preflight', {
      type: 'deterministic',
      dependsOn: ['install-deps'],
      command: [
        'set -e',
        'BRANCH=$(git rev-parse --abbrev-ref HEAD)',
        `if [ "$BRANCH" != "${BRANCH}" ]; then echo "ERROR: wrong branch ($BRANCH)"; exit 1; fi`,
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
    // Phase 1: read GitHub templates so workers have ground truth
    // (the GitHub trio is the proven analog the workers must mirror)
    // ─────────────────────────────────────────────────────────────────
    .step('read-github-proxy', {
      type: 'deterministic',
      dependsOn: ['preflight'],
      command: 'cat packages/web/app/api/v1/github/query/route.ts',
      captureOutput: true,
      failOnError: true,
    })
    .step('read-github-client', {
      type: 'deterministic',
      dependsOn: ['preflight'],
      command: 'cat packages/specialist-worker/src/specialist/github-api-client.ts',
      captureOutput: true,
      failOnError: true,
    })
    .step('read-github-fallback', {
      type: 'deterministic',
      dependsOn: ['preflight'],
      command: 'cat packages/specialist-worker/src/specialist/github-api-fallback.ts',
      captureOutput: true,
      failOnError: true,
    })
    .step('read-linear-agentic', {
      type: 'deterministic',
      dependsOn: ['preflight'],
      command: 'cat packages/specialist-worker/src/specialist/linear-specialist-agentic.ts',
      captureOutput: true,
      failOnError: true,
    })
    .step('read-linear-librarian-types', {
      type: 'deterministic',
      dependsOn: ['preflight'],
      command: [
        'echo "=== LinearLibrarianOptions + filter shape ==="',
        'cat node_modules/@agent-assistant/specialists/dist/linear/librarian.d.ts',
        'echo "=== LinearLibrarianApiFallback union ==="',
        'cat node_modules/@agent-assistant/specialists/dist/shared/librarian-engine.d.ts | head -120',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    // ─────────────────────────────────────────────────────────────────
    // Phase 2: implementation — three workers in parallel, each owns one file
    // ─────────────────────────────────────────────────────────────────
    .step('impl-client', {
      agent: 'impl-client',
      dependsOn: ['read-github-client', 'read-linear-librarian-types'],
      task: [
        'Create packages/specialist-worker/src/specialist/linear-api-client.ts.',
        '',
        'Mirror the GitHub equivalent (you have its full source below). Same overall structure: a `createLinearIntegration` factory that returns an object exposing typed methods. For Linear we need (matching the operations Nango will proxy):',
        '  - listIssues(opts?: { state?, team?, assignee?, labels?, limit? }): Promise<ListWrappedResult<unknown[]>>',
        '  - searchIssues(query: string, opts?: { limit? }): Promise<ListWrappedResult<{ items: unknown[] }>>',
        '  - getIssue(id: string): Promise<ListWrappedResult<unknown | null>>',
        '  - listProjects(opts?: { state?, team?, limit? }): Promise<ListWrappedResult<unknown[]>>',
        '  - listComments(issueId: string, opts?: { limit? }): Promise<ListWrappedResult<unknown[]>>',
        '',
        'Wire calls through cloud web at POST /api/v1/linear/query (the route the proxy worker is creating in parallel). Request body shape matches the github proxy:',
        '  { workspaceId, operation: "listIssues" | ..., params: {...} }',
        'Response shape: same wrapping as github (ListWrappedResult { data, source: "linear.cloud.nango", timestamp }).',
        '',
        'Hard rules:',
        '  - Use globalThis.fetch — never bare `fetch` (.claude/rules/workers-fetch.md).',
        '  - Read CLOUD_API_URL and CLOUD_API_TOKEN as constructor options (mirror GitHubApiClientOptions). Never read process.env directly inside Worker code (.claude/rules/sst-secrets.md).',
        '  - source must be `"linear.cloud.nango"` so traces can distinguish it from VFS results.',
        '  - Surface error responses with the same logFailure/logInvocation pattern github uses.',
        '',
        '=== GITHUB CLIENT (your template) ===',
        '{{steps.read-github-client.output}}',
        '',
        '=== LINEAR LIBRARIAN TYPES (constrains what your client must return) ===',
        '{{steps.read-linear-librarian-types.output}}',
        '',
        'Only edit/create the one file packages/specialist-worker/src/specialist/linear-api-client.ts. Do NOT touch other files.',
      ].join('\n'),
      verification: { type: 'file_exists', value: 'packages/specialist-worker/src/specialist/linear-api-client.ts' },
    })
    .step('impl-proxy', {
      agent: 'impl-proxy',
      dependsOn: ['read-github-proxy'],
      task: [
        'Create packages/web/app/api/v1/linear/query/route.ts.',
        '',
        'Mirror the github proxy below. Auth, schema validation, and Nango forwarding follow the same pattern. Differences:',
        '  - operations enum: ["listIssues", "searchIssues", "getIssue", "listProjects", "listComments"]',
        '  - Nango provider: "linear" instead of "github"',
        '  - No equivalent of clone request — Linear has no analog to `/api/v1/github/clone`. Skip that block.',
        '  - Accept header: Linear API uses application/json (single accept header).',
        '',
        'Use lib/integrations/linear-nango-proxy-client.ts if it exists (mirror github-nango-proxy-client). If it doesnt exist, INLINE the Nango proxy call inside this route (do NOT create the helper file in this PR — keep scope tight). The inline call should follow the same pattern: read NANGO_SECRET_KEY via the canonical helper (getNangoSecretKey), POST to https://api.nango.dev/v1/<integration_id>/proxy with appropriate headers.',
        '',
        'Hard rules:',
        '  - Read auth via readBearerTokenFromRequest + readConfiguredSpecialistCloudApiToken (same as github route).',
        '  - Resolve workspace integration via getWorkspaceIntegration("linear", workspaceId) (same as github).',
        '  - Use timingSafeEqual for token comparison (same as github).',
        '  - Use Zod for the request body schema (same as github).',
        '',
        '=== GITHUB PROXY (your template) ===',
        '{{steps.read-github-proxy.output}}',
        '',
        'Only create the one file packages/web/app/api/v1/linear/query/route.ts. Do NOT touch other files.',
      ].join('\n'),
      verification: { type: 'file_exists', value: 'packages/web/app/api/v1/linear/query/route.ts' },
    })
    .step('impl-fallback', {
      agent: 'impl-fallback',
      dependsOn: ['read-github-fallback', 'read-linear-librarian-types'],
      task: [
        'Create packages/specialist-worker/src/specialist/linear-api-fallback.ts.',
        '',
        'Mirror the github equivalent below. Provides createLinearLibrarianApiFallback(integration) returning a LinearLibrarianApiFallback function compatible with @agent-assistant/specialists\' LibrarianApiFallback<LinearEnumerationType> contract.',
        '',
        'Implementation steps:',
        '  1. Accept a LinearIntegration (the type from linear-api-client.ts the parallel worker is building).',
        '  2. Return an async function (request: LinearLibrarianFallbackRequest) => Promise<readonly FallbackVfsEntry[]>.',
        '  3. For each requested type (issue/project), call the integration\'s list/search method based on filters present.',
        '  4. Map each Linear API record to a FallbackVfsEntry with `properties` populated (state, team, assignee, priority, labels, project, updatedAt). PROPERTIES ARE MANDATORY — without them, the librarian\'s post-filter drops everything (this exact bug bit github before #371).',
        '  5. Set entry.path to /linear/issues/<id>.json (or /linear/projects/<id>.json for projects).',
        '  6. Catch errors per-type and continue (logFailure pattern from github).',
        '',
        'Critical (codex review feedback from PR #371): the GitHub equivalent had `itemMatchesQuery` substring filtering on the natural-language query text. That was wrong — it made GitHub return only PRs whose title/body happened to contain every query term. DO NOT REPLICATE THAT BUG. The structured filters in `request.filters` are the only thing that should constrain results. Pass them to the Linear API call directly. The natural-language `request.text` is metadata for the LLM, never a server-side substring predicate.',
        '',
        '=== GITHUB FALLBACK (your template — but skip itemMatchesQuery!) ===',
        '{{steps.read-github-fallback.output}}',
        '',
        '=== LINEAR LIBRARIAN TYPES (your contract) ===',
        '{{steps.read-linear-librarian-types.output}}',
        '',
        'Only create the one file packages/specialist-worker/src/specialist/linear-api-fallback.ts. Do NOT touch other files.',
      ].join('\n'),
      verification: { type: 'file_exists', value: 'packages/specialist-worker/src/specialist/linear-api-fallback.ts' },
    })

    // Verify gates after each impl — `git diff --quiet` fails if file unchanged
    .step('verify-client', {
      type: 'deterministic',
      dependsOn: ['impl-client'],
      command: [
        'set -e',
        'test -f packages/specialist-worker/src/specialist/linear-api-client.ts',
        'grep -q "createLinearIntegration\\|LinearIntegration" packages/specialist-worker/src/specialist/linear-api-client.ts',
        'grep -q "linear.cloud.nango" packages/specialist-worker/src/specialist/linear-api-client.ts',
        'echo OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })
    .step('verify-proxy', {
      type: 'deterministic',
      dependsOn: ['impl-proxy'],
      command: [
        'set -e',
        'test -f packages/web/app/api/v1/linear/query/route.ts',
        'grep -qE "listIssues|searchIssues|getIssue" packages/web/app/api/v1/linear/query/route.ts',
        'grep -q "linear" packages/web/app/api/v1/linear/query/route.ts',
        'echo OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })
    .step('verify-fallback', {
      type: 'deterministic',
      dependsOn: ['impl-fallback'],
      command: [
        'set -e',
        'test -f packages/specialist-worker/src/specialist/linear-api-fallback.ts',
        'grep -q "createLinearLibrarianApiFallback" packages/specialist-worker/src/specialist/linear-api-fallback.ts',
        // Defense: ensure we did NOT replicate the itemMatchesQuery bug
        'if grep -q "itemMatchesQuery" packages/specialist-worker/src/specialist/linear-api-fallback.ts; then echo "ERROR: linear-api-fallback replicated the github itemMatchesQuery bug — strip it"; exit 1; fi',
        'echo OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    // ─────────────────────────────────────────────────────────────────
    // Phase 3: wire-up — pass apiFallback into createLinearLibrarian
    // ─────────────────────────────────────────────────────────────────
    .step('impl-wire', {
      agent: 'impl-wire',
      dependsOn: ['verify-client', 'verify-proxy', 'verify-fallback', 'read-linear-agentic'],
      task: [
        'Edit packages/specialist-worker/src/specialist/linear-specialist-agentic.ts.',
        '',
        'Today line 79 reads:',
        '    const librarian = createLinearLibrarian({ vfs });',
        '',
        'Change it to construct a LinearLibrarianApiFallback (using the new linear-api-client.ts and linear-api-fallback.ts) when CLOUD_API_URL + SPECIALIST_CLOUD_API_TOKEN bindings are present, then pass it through:',
        '    const librarian = options.linearLibrarianApiFallback',
        '      ? createLinearLibrarian({ vfs, apiFallback: options.linearLibrarianApiFallback })',
        '      : createLinearLibrarian({ vfs });',
        '',
        'Also extend the LinearAgenticSpecialistOptions interface (add `linearLibrarianApiFallback?: LinearLibrarianApiFallback | null`).',
        '',
        'Then update routes/a2a-rpc.ts (where the linear specialist is constructed) to wire the apiFallback exactly the same way the github specialist does today. Reference the existing github wiring in routes/a2a-rpc.ts around line 404 (createGitHubLibrarianApiFallback).',
        '',
        'Imports needed:',
        '  - createLinearIntegration from ./linear-api-client.js',
        '  - createLinearLibrarianApiFallback from ./linear-api-fallback.js',
        '  - LinearLibrarianApiFallback type from @agent-assistant/specialists',
        '',
        'Current linear-specialist-agentic.ts:',
        '{{steps.read-linear-agentic.output}}',
        '',
        'Edit ONLY linear-specialist-agentic.ts and routes/a2a-rpc.ts (the wire-up). Do NOT touch other files.',
      ].join('\n'),
      verification: { type: 'exit_code' },
    })
    .step('verify-wire', {
      type: 'deterministic',
      dependsOn: ['impl-wire'],
      command: [
        'set -e',
        'grep -q "linearLibrarianApiFallback\\|createLinearLibrarianApiFallback" packages/specialist-worker/src/specialist/linear-specialist-agentic.ts',
        'grep -q "createLinearLibrarianApiFallback" packages/specialist-worker/src/routes/a2a-rpc.ts',
        'echo OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    // ─────────────────────────────────────────────────────────────────
    // Phase 4: SELF REVIEW (codex re-reads its own output and validates
    // against the github analog)
    // ─────────────────────────────────────────────────────────────────
    .step('self-review', {
      agent: 'lead',
      dependsOn: ['verify-wire'],
      task: [
        'Self-review the new Linear apiFallback against the GitHub one. Read both side-by-side and post any discrepancies that need fixing BEFORE we run tests.',
        '',
        'Read these files in this order:',
        '  1. cat packages/specialist-worker/src/specialist/github-api-client.ts',
        '  2. cat packages/specialist-worker/src/specialist/linear-api-client.ts',
        '  3. cat packages/specialist-worker/src/specialist/github-api-fallback.ts',
        '  4. cat packages/specialist-worker/src/specialist/linear-api-fallback.ts',
        '  5. cat packages/web/app/api/v1/github/query/route.ts',
        '  6. cat packages/web/app/api/v1/linear/query/route.ts',
        '  7. cat packages/specialist-worker/src/specialist/linear-specialist-agentic.ts',
        '  8. cat packages/specialist-worker/src/routes/a2a-rpc.ts | head -450',
        '',
        'Checklist (post each as PASS or FAIL with line refs):',
        '  - Does linear-api-client.ts use globalThis.fetch (not bare fetch)?',
        '  - Does linear-api-fallback.ts forward `properties` on every entry it returns?',
        '  - Does linear-api-fallback.ts AVOID the github itemMatchesQuery anti-pattern (no substring match on request.text)?',
        '  - Does the proxy route validate auth via readBearerTokenFromRequest + readConfiguredSpecialistCloudApiToken?',
        '  - Does the proxy route use timingSafeEqual for token comparison?',
        '  - Does the wire-up in linear-specialist-agentic.ts conditionally create the apiFallback only when bindings exist?',
        '  - Does routes/a2a-rpc.ts construct linearLibrarianApiFallback via createLinearLibrarianApiFallback identically to github?',
        '',
        'If any check FAILs, write the fix yourself by editing the relevant file. Do NOT re-spawn workers. After fixing, re-verify with the same commands and confirm all checks PASS.',
        '',
        'When all checks pass, write the literal token SELF_REVIEW_OK to stdout.',
      ].join('\n'),
      verification: { type: 'output_contains', value: 'SELF_REVIEW_OK' },
      retries: 1,
    })

    // ─────────────────────────────────────────────────────────────────
    // Phase 5: tests — write, run, fix, rerun
    // ─────────────────────────────────────────────────────────────────
    .step('write-tests', {
      agent: 'tester',
      dependsOn: ['self-review'],
      task: [
        'Write three test files mirroring the github test conventions:',
        '',
        '  1. packages/specialist-worker/src/specialist/linear-api-client.test.ts',
        '     - Mock globalThis.fetch via vi.stubGlobal.',
        '     - Assert listIssues/searchIssues/getIssue/listProjects/listComments POST to /api/v1/linear/query with correct body shape.',
        '     - Assert auth headers set correctly.',
        '     - Assert error responses raise (not silently swallow).',
        '',
        '  2. packages/specialist-worker/src/specialist/linear-api-fallback.test.ts',
        '     - Mock the LinearIntegration with fake list/search methods.',
        '     - Test: listIssues returns 5 items → fallback returns 5 entries with properties populated.',
        '     - Test: filters {state:["open"]} are passed through.',
        '     - Test: NO query-text substring filtering (mock returns 3 entries, fallback returns all 3 regardless of request.text).',
        '     - Test: each returned entry has properties.{state, team, assignee, priority, labels, project, updatedAt} where present in the source.',
        '',
        '  3. packages/web/app/api/v1/linear/query/route.test.ts',
        '     - Mirror the existing github query route tests if any exist (find with: find packages/web -name "route.test.ts" -path "*github*"). If none, write minimal tests: rejects without bearer token; rejects with bad token; happy-path POST with valid Zod-conformant body returns 200.',
        '',
        'Use vitest (consistent with the rest of specialist-worker). Use type-safe mocks (no `as any` shortcuts). Match the existing test conventions in packages/specialist-worker/src/specialist/relayfile-workspace-reader.test.ts for shape.',
      ].join('\n'),
      verification: { type: 'exit_code' },
      retries: 1,
    })
    .step('verify-tests-exist', {
      type: 'deterministic',
      dependsOn: ['write-tests'],
      command: [
        'set -e',
        'test -f packages/specialist-worker/src/specialist/linear-api-client.test.ts',
        'test -f packages/specialist-worker/src/specialist/linear-api-fallback.test.ts',
        'test -f packages/web/app/api/v1/linear/query/route.test.ts',
        'echo OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })
    .step('run-tests', {
      type: 'deterministic',
      dependsOn: ['verify-tests-exist'],
      command: [
        'set -e',
        'echo "=== specialist-worker tests ==="',
        'npx vitest run --root packages/specialist-worker 2>&1 | tail -80 || true',
        'echo "=== web tests (linear route) ==="',
        'npx vitest run packages/web/app/api/v1/linear/query/route.test.ts 2>&1 | tail -40 || true',
        'echo TESTS_DONE',
      ].join(' && '),
      captureOutput: true,
      failOnError: false,
    })
    .step('fix-tests', {
      agent: 'tester',
      dependsOn: ['run-tests'],
      task: [
        'Read the test output below and fix any failures. If everything passed, exit 0 immediately without writing.',
        '',
        '{{steps.run-tests.output}}',
        '',
        'If failures exist:',
        '  1. Read the failing test file AND the source file under test.',
        '  2. Decide whether the test or the source is wrong (the source we just wrote is more likely to need fixing for type errors / API mismatches; the test for assertion adjustments).',
        '  3. Fix the cause.',
        '  4. Re-run: npx vitest run --root packages/specialist-worker AND npx vitest run packages/web/app/api/v1/linear/query/route.test.ts',
        '  5. Iterate until every test passes.',
        '',
        'Do NOT delete tests to make them pass. Do NOT add `vi.skip` or `it.todo` to escape failures. The point of this phase is to prove the implementation works.',
      ].join('\n'),
      verification: { type: 'exit_code' },
      retries: 1,
    })
    .step('run-tests-final', {
      type: 'deterministic',
      dependsOn: ['fix-tests'],
      command: [
        'set -e',
        'npx vitest run --root packages/specialist-worker 2>&1 | tail -10',
        'npx vitest run packages/web/app/api/v1/linear/query/route.test.ts 2>&1 | tail -10',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    // ─────────────────────────────────────────────────────────────────
    // Phase 6: typecheck + regression
    // ─────────────────────────────────────────────────────────────────
    .step('typecheck', {
      type: 'deterministic',
      dependsOn: ['run-tests-final'],
      command: [
        'set -e',
        'echo "=== specialist-worker tsc ==="',
        'npx tsc -p packages/specialist-worker/tsconfig.json --noEmit 2>&1 | tail -30 || echo SPEC_TSC_FAIL',
        'echo "=== web tsc ==="',
        'npx tsc -p packages/web/tsconfig.json --noEmit 2>&1 | tail -30 || echo WEB_TSC_FAIL',
        'echo TSC_DONE',
      ].join(' && '),
      captureOutput: true,
      failOnError: false,
    })
    .step('fix-typecheck', {
      agent: 'impl-wire',
      dependsOn: ['typecheck'],
      task: [
        'Read the typecheck output and fix every error. If clean, exit 0.',
        '',
        '{{steps.typecheck.output}}',
        '',
        'After each fix, re-run:',
        '  npx tsc -p packages/specialist-worker/tsconfig.json --noEmit',
        '  npx tsc -p packages/web/tsconfig.json --noEmit',
        '',
        'Iterate until both are clean. Do NOT use `as any` casts as the fix — they hide real bugs. If a type genuinely needs widening, do it explicitly.',
      ].join('\n'),
      verification: { type: 'exit_code' },
      retries: 1,
    })
    .step('typecheck-final', {
      type: 'deterministic',
      dependsOn: ['fix-typecheck'],
      command: [
        'set -e',
        'npx tsc -p packages/specialist-worker/tsconfig.json --noEmit',
        'npx tsc -p packages/web/tsconfig.json --noEmit',
        'echo TSC_FINAL_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })
    .step('regression', {
      type: 'deterministic',
      dependsOn: ['typecheck-final'],
      command: [
        'set -e',
        'echo "=== full specialist-worker suite ==="',
        'npx vitest run --root packages/specialist-worker 2>&1 | tail -15',
        'echo REGRESSION_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    // ─────────────────────────────────────────────────────────────────
    // Phase 7: PEER REVIEW (Claude reviews codex's full diff with senior-eng eyes)
    // ─────────────────────────────────────────────────────────────────
    .step('peer-review-prep', {
      type: 'deterministic',
      dependsOn: ['regression'],
      command: 'git diff --stat origin/main...HEAD; echo "---"; git diff origin/main...HEAD',
      captureOutput: true,
      failOnError: true,
    })
    .step('peer-review', {
      agent: 'lead',
      dependsOn: ['peer-review-prep'],
      task: [
        'You are the senior reviewer. Read the full diff below and audit it.',
        '',
        'Specifically look for:',
        '  1. Bugs the implementer might have introduced (type confusion, off-by-one, swallowed errors, missing null checks).',
        '  2. Inconsistencies with the github analog (anything that should match but does not, with line refs).',
        '  3. Security issues (timingSafeEqual missing, token comparison via ===, secrets logged, env via process.env in worker code violating .claude/rules/sst-secrets.md).',
        '  4. Test gaps (untested error paths, untested filter combinations, tests that mock too much and miss real bugs).',
        '  5. The `itemMatchesQuery` anti-pattern (substring match on request.text) — must NOT exist in linear-api-fallback.ts.',
        '  6. Per-entry `properties` population on every Linear entity returned by the fallback (this was the github bug fixed in #371 — must not recur for Linear).',
        '',
        '=== full diff vs origin/main ===',
        '{{steps.peer-review-prep.output}}',
        '',
        'Output format (mandatory):',
        '  - For EACH finding: [severity P0/P1/P2] <file>:<line> <one-line description>',
        '  - At the end, write either ALL_CLEAR (no findings) or ACTIONABLE_FINDINGS_BELOW (followed by the list).',
        '',
        'If you find issues, do NOT fix them yourself in this step — just report them. The next step will fix them.',
      ].join('\n'),
      verification: { type: 'exit_code' },
      retries: 1,
    })
    .step('address-peer-review', {
      agent: 'impl-wire',
      dependsOn: ['peer-review'],
      task: [
        'Read the peer-review findings below. If the output ends with ALL_CLEAR, exit 0 immediately without writing.',
        '',
        '{{steps.peer-review.output}}',
        '',
        'For each P0 and P1 finding: fix it in the named file. After all fixes:',
        '  1. Re-run targeted tests: npx vitest run --root packages/specialist-worker',
        '  2. Re-run typecheck: npx tsc -p packages/specialist-worker/tsconfig.json --noEmit && npx tsc -p packages/web/tsconfig.json --noEmit',
        '  3. Confirm both pass.',
        '',
        'P2 findings can be deferred — note them in your output as DEFERRED so we can decide at PR review time.',
      ].join('\n'),
      verification: { type: 'exit_code' },
      retries: 1,
    })
    .step('post-review-validate', {
      type: 'deterministic',
      dependsOn: ['address-peer-review'],
      command: [
        'set -e',
        'npx tsc -p packages/specialist-worker/tsconfig.json --noEmit',
        'npx tsc -p packages/web/tsconfig.json --noEmit',
        'npx vitest run --root packages/specialist-worker 2>&1 | tail -10',
        'echo POST_REVIEW_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    // ─────────────────────────────────────────────────────────────────
    // Phase 8: commit + PR
    // ─────────────────────────────────────────────────────────────────
    .step('commit', {
      type: 'deterministic',
      dependsOn: ['post-review-validate'],
      command: [
        'set -e',
        'git add packages/web/app/api/v1/linear/query/route.ts',
        'git add packages/web/app/api/v1/linear/query/route.test.ts',
        'git add packages/specialist-worker/src/specialist/linear-api-client.ts',
        'git add packages/specialist-worker/src/specialist/linear-api-client.test.ts',
        'git add packages/specialist-worker/src/specialist/linear-api-fallback.ts',
        'git add packages/specialist-worker/src/specialist/linear-api-fallback.test.ts',
        'git add packages/specialist-worker/src/specialist/linear-specialist-agentic.ts',
        'git add packages/specialist-worker/src/routes/a2a-rpc.ts',
        // Lockfile if any new dep snuck in (none expected)
        'git diff --cached --quiet -- package-lock.json || git add package-lock.json',
        'MSG=$(mktemp)',
        'printf "%s\\n" \\',
        '  "feat(specialist): add Linear apiFallback so linear specialist returns real data" \\',
        '  "" \\',
        '  "Production trace 2026-04-26: Slack DM \\"what linear issues are open?\\" looped" \\',
        '  "9 linear_enumerate calls in the specialist (each returning [] with warning=empty)" \\',
        '  "and bubbled the canned \\"could not complete\\" reply because the linear" \\',
        '  "specialist had no apiFallback wired. Mirrors the github trio (api-client +" \\',
        '  "api-fallback + /api/v1/.../query proxy) so the librarian engine\'s" \\',
        '  "post-filter-empty safety net (PR #61) actually has something to fall back to." \\',
        '  "" \\',
        '  "Files added: linear-api-client.ts, linear-api-fallback.ts, route.ts +" \\',
        '  "tests for each. linear-specialist-agentic.ts and routes/a2a-rpc.ts wire" \\',
        '  "the new fallback through identically to github." \\',
        '  "" \\',
        '  "Self-reviewed against github analog. Peer-reviewed by Claude Opus." \\',
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
        '  "- New \\`/api/v1/linear/query\\` Nango proxy endpoint mirrors github." \\',
        '  "- New \\`linear-api-client.ts\\` LinearIntegration class." \\',
        '  "- New \\`linear-api-fallback.ts\\` LinearLibrarianApiFallback wrapper." \\',
        '  "- Wired \\`apiFallback\\` into \\`createLinearLibrarian\\` via routes/a2a-rpc.ts." \\',
        '  "- DELIBERATELY no \\`itemMatchesQuery\\` anti-pattern (the github bug we are still cleaning up)." \\',
        '  "- Each fallback entry carries \\`properties\\` (state/team/assignee/priority/labels/project) so the librarian post-filter actually finds matches." \\',
        '  "" \\',
        '  "## Production failure this fixes" \\',
        '  "" \\',
        '  "Slack DM \\"what linear issues are open?\\" → specialist hit max_tool_calls_reached after 9 empty linear_enumerate calls → sage returned canned \\"could not complete\\" reply. Trace and root-cause analysis in commit message." \\',
        '  "" \\',
        '  "## Validation" \\',
        '  "" \\',
        '  "- [x] specialist-worker vitest suite green (full)" \\',
        '  "- [x] linear route vitest green" \\',
        '  "- [x] tsc clean for specialist-worker AND packages/web" \\',
        '  "- [x] self-reviewed against github analog (file-by-file checklist)" \\',
        '  "- [x] peer-reviewed by Claude Opus (P0/P1 findings addressed; any DEFERRED items noted in PR comments)" \\',
        '  "- [ ] After deploy, retry \\"what linear issues are open?\\" — expect specialist to return real findings via the apiFallback path on a single linear_enumerate call." \\',
        '  "" \\',
        '  "🤖 Generated with [Claude Code](https://claude.com/claude-code)" \\',
        '  > "$BODY"',
        'gh pr create --title "feat(specialist): add Linear apiFallback so linear specialist returns real data" --body-file "$BODY" 2>&1 | tee /tmp/pr-url.txt',
        'rm -f "$BODY"',
        'echo "PR: $(tail -1 /tmp/pr-url.txt)"',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
    .run({ cwd: process.cwd() });

  // The runner exits 0 on workflow completion regardless of step status.
  // Throw on non-completed status so the master executor's wait $pid sees
  // a failure and the .catch propagates exit 1.
  if (result.status !== 'completed') {
    throw new Error(`Workflow ended with status: ${result.status}`);
  }
  console.log('Linear specialist apiFallback workflow complete.');
}

runWorkflow().catch((error) => {
  console.error(error);
  process.exit(1);
});
