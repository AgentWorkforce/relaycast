/**
 * fix-notion-specialist-apifallback.ts
 *
 * Cloud-side build-out of the Notion specialist. Builds the api-client +
 * api-fallback + Nango proxy + notion-specialist-agentic wiring so sage can
 * delegate Notion questions to a real specialist with a live API fallback.
 *
 * **Prerequisite:** the upstream workflow add-notion-librarian-to-agent-assistant
 * must have merged AND `@agent-assistant/specialists` must be republished
 * with the NotionLibrarian export. This workflow bumps the dep version as
 * part of phase 0 and fails preflight if the published version doesn't
 * export createNotionLibrarian.
 *
 * Files this workflow creates / edits in the cloud repo:
 *   NEW: packages/web/app/api/v1/notion/query/route.ts
 *   NEW: packages/web/app/api/v1/notion/query/route.test.ts
 *   NEW: packages/specialist-worker/src/specialist/notion-api-client.ts
 *   NEW: packages/specialist-worker/src/specialist/notion-api-client.test.ts
 *   NEW: packages/specialist-worker/src/specialist/notion-api-fallback.ts
 *   NEW: packages/specialist-worker/src/specialist/notion-api-fallback.test.ts
 *   NEW: packages/specialist-worker/src/specialist/notion-specialist-agentic.ts
 *   MOD: packages/specialist-worker/src/routes/a2a-rpc.ts (route notion.enumerate)
 *   MOD: packages/specialist-worker/src/specialist/agent-card.ts (advertise notion.enumerate)
 *   MOD: packages/specialist-worker/package.json (bump @agent-assistant/specialists)
 *   MOD: package-lock.json (bump propagation)
 *
 * Mirrors the Linear pattern (fix-linear-specialist-apifallback.ts).
 */

import { workflow } from '@relayflows/core';
import { ClaudeModels, CodexModels } from '@agent-relay/config';

import { applyCloudRepoSetup } from './lib/cloud-repo-setup.ts';

const NAME = 'fix-notion-specialist-apifallback';
const BRANCH = 'feat/notion-specialist-apifallback';
const CHANNEL = 'wf-notion-specialist';

async function runWorkflow() {
  const ALLOWED_DIRTY = [
    'package-lock\\\\.json',
    // trail trajectory tracking is repo-wide noise — allow as drift, the
    // commit step uses explicit `git add` paths so trajectories never bundle
    // into the PR.
    '\\\\.trajectories/.*',
    'packages/specialist-worker/package\\\\.json',
    'packages/web/app/api/v1/notion/query/route\\\\.ts',
    'packages/web/app/api/v1/notion/query/route\\\\.test\\\\.ts',
    'packages/specialist-worker/src/specialist/notion-api-client\\\\.ts',
    'packages/specialist-worker/src/specialist/notion-api-client\\\\.test\\\\.ts',
    'packages/specialist-worker/src/specialist/notion-api-fallback\\\\.ts',
    'packages/specialist-worker/src/specialist/notion-api-fallback\\\\.test\\\\.ts',
    'packages/specialist-worker/src/specialist/notion-specialist-agentic\\\\.ts',
    'packages/specialist-worker/src/routes/a2a-rpc\\\\.ts',
    'packages/specialist-worker/src/specialist/agent-card\\\\.ts',
  ].join('|');

  const baseWf = workflow(NAME)
    .description(
      'Build cloud-side Notion specialist + apiFallback so sage can answer notion queries',
    )
    .pattern('dag')
    .channel(CHANNEL)
    .maxConcurrency(5)
    .timeout(3_600_000)
    .agent('lead', {
      cli: 'claude',
      model: ClaudeModels.OPUS,
      role: 'Architect, peer reviewer',
      retries: 1,
    })
    .agent('impl-client', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      role: 'Implements notion-api-client.ts',
      retries: 2,
    })
    .agent('impl-proxy', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      role: 'Implements /api/v1/notion/query/route.ts',
      retries: 2,
    })
    .agent('impl-fallback', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      role: 'Implements notion-api-fallback.ts',
      retries: 2,
    })
    .agent('impl-agentic', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      role: 'Creates notion-specialist-agentic.ts and wires routes/a2a-rpc.ts + agent-card',
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
    committerName: 'Notion Specialist Bot',
  });

  const result = await wf
    // ─────────────────────────────────────────────────────────────────
    // Phase 0: bump @agent-assistant/specialists, then preflight
    // ─────────────────────────────────────────────────────────────────
    .step('bump-specialists-dep', {
      type: 'deterministic',
      dependsOn: ['install-deps'],
      command: [
        'set -e',
        'echo "=== current @agent-assistant/specialists ==="',
        'grep "@agent-assistant/specialists" packages/specialist-worker/package.json || true',
        'echo "=== latest published version ==="',
        'LATEST=$(npm view @agent-assistant/specialists version)',
        'echo "latest: $LATEST"',
        'npm install @agent-assistant/specialists@^$LATEST --workspace @cloud/specialist-worker --legacy-peer-deps --no-audit --no-fund 2>&1 | tail -5',
        // Sanity: ensure NotionLibrarian is actually published (the upstream PR must be merged + released)
        'INSTALLED=$(cat packages/specialist-worker/node_modules/@agent-assistant/specialists/package.json | grep version)',
        'echo "installed: $INSTALLED"',
        'grep -q "createNotionLibrarian\\|notion" packages/specialist-worker/node_modules/@agent-assistant/specialists/dist/index.d.ts || (echo "ERROR: published @agent-assistant/specialists does NOT export NotionLibrarian. Did add-notion-librarian-to-agent-assistant land + republish?"; exit 1)',
        'echo BUMP_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })
    .step('preflight', {
      type: 'deterministic',
      dependsOn: ['bump-specialists-dep'],
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
    // Phase 1: read templates (linear + github)
    // ─────────────────────────────────────────────────────────────────
    .step('read-linear-client', {
      type: 'deterministic',
      dependsOn: ['preflight'],
      command: 'cat packages/specialist-worker/src/specialist/linear-api-client.ts 2>/dev/null || cat packages/specialist-worker/src/specialist/github-api-client.ts',
      captureOutput: true,
      failOnError: true,
    })
    .step('read-linear-fallback', {
      type: 'deterministic',
      dependsOn: ['preflight'],
      command: 'cat packages/specialist-worker/src/specialist/linear-api-fallback.ts 2>/dev/null || cat packages/specialist-worker/src/specialist/github-api-fallback.ts',
      captureOutput: true,
      failOnError: true,
    })
    .step('read-linear-agentic', {
      type: 'deterministic',
      dependsOn: ['preflight'],
      command: 'cat packages/specialist-worker/src/specialist/linear-specialist-agentic.ts 2>/dev/null || cat packages/specialist-worker/src/specialist/github-specialist-agentic.ts',
      captureOutput: true,
      failOnError: true,
    })
    .step('read-github-proxy', {
      type: 'deterministic',
      dependsOn: ['preflight'],
      command: 'cat packages/web/app/api/v1/github/query/route.ts',
      captureOutput: true,
      failOnError: true,
    })
    .step('read-routes-rpc', {
      type: 'deterministic',
      dependsOn: ['preflight'],
      command: 'cat packages/specialist-worker/src/routes/a2a-rpc.ts',
      captureOutput: true,
      failOnError: true,
    })
    .step('read-agent-card', {
      type: 'deterministic',
      dependsOn: ['preflight'],
      command: 'cat packages/specialist-worker/src/specialist/agent-card.ts',
      captureOutput: true,
      failOnError: true,
    })
    .step('read-notion-librarian-types', {
      type: 'deterministic',
      dependsOn: ['preflight'],
      command: [
        'echo "=== published NotionLibrarian d.ts ==="',
        'cat packages/specialist-worker/node_modules/@agent-assistant/specialists/dist/notion/librarian.d.ts',
        'echo "=== Notion types ==="',
        'cat packages/specialist-worker/node_modules/@agent-assistant/specialists/dist/notion/types.d.ts',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    // ─────────────────────────────────────────────────────────────────
    // Phase 2: implementation — four workers in parallel
    // ─────────────────────────────────────────────────────────────────
    .step('impl-client', {
      agent: 'impl-client',
      dependsOn: ['read-linear-client', 'read-notion-librarian-types'],
      task: [
        'Create packages/specialist-worker/src/specialist/notion-api-client.ts.',
        '',
        'Mirror linear-api-client.ts (your template below). createNotionIntegration factory exposing:',
        '  - listPages(opts?: { database?, limit?, query? }): Promise<ListWrappedResult<unknown[]>>',
        '  - listDatabases(opts?: { limit? }): Promise<ListWrappedResult<unknown[]>>',
        '  - searchPages(query: string, opts?: { limit? }): Promise<ListWrappedResult<{ items: unknown[] }>>',
        '  - getPage(id: string): Promise<ListWrappedResult<unknown | null>>',
        '  - getDatabase(id: string): Promise<ListWrappedResult<unknown | null>>',
        '  - listBlocks(pageId: string, opts?: { limit? }): Promise<ListWrappedResult<unknown[]>>',
        '',
        'Wire calls through cloud web at POST /api/v1/notion/query (the proxy worker is creating it in parallel). Same body shape as linear/github: { workspaceId, operation, params }. source must be `"notion.cloud.nango"`.',
        '',
        'Hard rules:',
        '  - Use globalThis.fetch (.claude/rules/workers-fetch.md).',
        '  - Read CLOUD_API_URL + CLOUD_API_TOKEN as constructor options.',
        '  - Surface errors with logFailure pattern.',
        '',
        '=== Linear (template) ===',
        '{{steps.read-linear-client.output}}',
        '',
        '=== Notion librarian types (your contract) ===',
        '{{steps.read-notion-librarian-types.output}}',
        '',
        'Only create the one file packages/specialist-worker/src/specialist/notion-api-client.ts.',
      ].join('\n'),
      verification: { type: 'file_exists', value: 'packages/specialist-worker/src/specialist/notion-api-client.ts' },
    })
    .step('impl-proxy', {
      agent: 'impl-proxy',
      dependsOn: ['read-github-proxy'],
      task: [
        'Create packages/web/app/api/v1/notion/query/route.ts.',
        '',
        'Mirror github proxy below. Differences:',
        '  - operations enum: ["listPages", "listDatabases", "searchPages", "getPage", "getDatabase", "listBlocks"]',
        '  - Nango provider: "notion"',
        '  - No clone analog. Skip that block.',
        '  - Notion REST API content-type: application/json + Notion-Version header (use "2022-06-28" — current stable).',
        '',
        'Auth + workspace integration + Zod validation: identical to github route.',
        '',
        '=== github proxy (template) ===',
        '{{steps.read-github-proxy.output}}',
        '',
        'Only create packages/web/app/api/v1/notion/query/route.ts.',
      ].join('\n'),
      verification: { type: 'file_exists', value: 'packages/web/app/api/v1/notion/query/route.ts' },
    })
    .step('impl-fallback', {
      agent: 'impl-fallback',
      dependsOn: ['read-linear-fallback', 'read-notion-librarian-types'],
      task: [
        'Create packages/specialist-worker/src/specialist/notion-api-fallback.ts.',
        '',
        'Mirror linear-api-fallback.ts. createNotionLibrarianApiFallback(integration) returns a NotionLibrarianApiFallback function compatible with @agent-assistant/specialists\' LibrarianApiFallback<NotionEnumerationType>.',
        '',
        'For each requested type (page/database/block), call the integration\'s list/search method based on filters present. Map each Notion record to a FallbackVfsEntry with:',
        '  path: /notion/<type>s/<uuid>.json',
        '  type: "file"',
        '  provider: "notion"',
        '  properties: { type, title, parent, tags, author, lastEditedAt, url, ... }',
        '',
        'PROPERTIES ARE MANDATORY — without them, the librarian post-filter drops everything (this is the bug class we keep hitting).',
        '',
        'CRITICAL: do NOT replicate the github itemMatchesQuery anti-pattern. Structured filters in request.filters are the only thing that should constrain results. The natural-language request.text is metadata for the LLM, never a server-side substring predicate.',
        '',
        '=== Linear fallback (template — already correct, no itemMatchesQuery) ===',
        '{{steps.read-linear-fallback.output}}',
        '',
        '=== Notion librarian types (your contract) ===',
        '{{steps.read-notion-librarian-types.output}}',
        '',
        'Only create packages/specialist-worker/src/specialist/notion-api-fallback.ts.',
      ].join('\n'),
      verification: { type: 'file_exists', value: 'packages/specialist-worker/src/specialist/notion-api-fallback.ts' },
    })
    .step('impl-agentic', {
      agent: 'impl-agentic',
      dependsOn: ['read-linear-agentic'],
      task: [
        'Create packages/specialist-worker/src/specialist/notion-specialist-agentic.ts.',
        '',
        'Mirror linear-specialist-agentic.ts. Defines NotionAgenticSpecialistOptions, exposes createNotionAgenticSpecialist factory that constructs an agenticSpecialist wrapping createNotionLibrarian(...). Wire apiFallback conditionally (CLOUD_API_URL + token present).',
        '',
        '=== Linear agentic (template) ===',
        '{{steps.read-linear-agentic.output}}',
        '',
        'Only create packages/specialist-worker/src/specialist/notion-specialist-agentic.ts.',
      ].join('\n'),
      verification: { type: 'file_exists', value: 'packages/specialist-worker/src/specialist/notion-specialist-agentic.ts' },
    })

    // verify gates after each impl
    .step('verify-client', {
      type: 'deterministic',
      dependsOn: ['impl-client'],
      command: [
        'set -e',
        'test -f packages/specialist-worker/src/specialist/notion-api-client.ts',
        'grep -q "createNotionIntegration\\|NotionIntegration" packages/specialist-worker/src/specialist/notion-api-client.ts',
        'grep -q "notion.cloud.nango" packages/specialist-worker/src/specialist/notion-api-client.ts',
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
        'test -f packages/web/app/api/v1/notion/query/route.ts',
        'grep -qE "listPages|searchPages|getPage" packages/web/app/api/v1/notion/query/route.ts',
        'grep -q "notion" packages/web/app/api/v1/notion/query/route.ts',
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
        'test -f packages/specialist-worker/src/specialist/notion-api-fallback.ts',
        'grep -q "createNotionLibrarianApiFallback" packages/specialist-worker/src/specialist/notion-api-fallback.ts',
        'if grep -q "itemMatchesQuery" packages/specialist-worker/src/specialist/notion-api-fallback.ts; then echo "ERROR: notion-api-fallback replicated the github itemMatchesQuery bug"; exit 1; fi',
        'echo OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })
    .step('verify-agentic', {
      type: 'deterministic',
      dependsOn: ['impl-agentic'],
      command: [
        'set -e',
        'test -f packages/specialist-worker/src/specialist/notion-specialist-agentic.ts',
        'grep -q "createNotionAgenticSpecialist" packages/specialist-worker/src/specialist/notion-specialist-agentic.ts',
        'grep -q "createNotionLibrarian" packages/specialist-worker/src/specialist/notion-specialist-agentic.ts',
        'echo OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    // ─────────────────────────────────────────────────────────────────
    // Phase 3: wire-up — register notion specialist in routes/a2a-rpc and agent-card
    // ─────────────────────────────────────────────────────────────────
    .step('impl-wire', {
      agent: 'impl-agentic',
      dependsOn: ['verify-client', 'verify-proxy', 'verify-fallback', 'verify-agentic', 'read-routes-rpc', 'read-agent-card'],
      task: [
        'Two edits required:',
        '',
        '1. packages/specialist-worker/src/routes/a2a-rpc.ts',
        '   - Import createNotionAgenticSpecialist + createNotionIntegration + createNotionLibrarianApiFallback.',
        '   - Construct the notion specialist + its apiFallback exactly mirroring the linear case (same conditional cloud-bindings check).',
        '   - Add a switch case for capability "notion.enumerate" in the dispatch.',
        '',
        '2. packages/specialist-worker/src/specialist/agent-card.ts',
        '   - Add { id: "notion.enumerate", name: "Notion Enumeration", description: "..." } to the skills array.',
        '',
        '=== current routes/a2a-rpc.ts (find linear case as template) ===',
        '{{steps.read-routes-rpc.output}}',
        '',
        '=== current agent-card.ts ===',
        '{{steps.read-agent-card.output}}',
        '',
        'Edit ONLY these two files. Do NOT touch other files.',
      ].join('\n'),
      verification: { type: 'exit_code' },
    })
    .step('verify-wire', {
      type: 'deterministic',
      dependsOn: ['impl-wire'],
      command: [
        'set -e',
        'grep -q "createNotionAgenticSpecialist\\|notion.enumerate" packages/specialist-worker/src/routes/a2a-rpc.ts',
        'grep -q "notion.enumerate" packages/specialist-worker/src/specialist/agent-card.ts',
        'echo OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    // ─────────────────────────────────────────────────────────────────
    // Phase 4: SELF REVIEW
    // ─────────────────────────────────────────────────────────────────
    .step('self-review', {
      agent: 'lead',
      dependsOn: ['verify-wire'],
      task: [
        'Self-review notion specialist against linear (closest analog).',
        '',
        'Read in order:',
        '  1. cat packages/specialist-worker/src/specialist/linear-api-client.ts',
        '  2. cat packages/specialist-worker/src/specialist/notion-api-client.ts',
        '  3. cat packages/specialist-worker/src/specialist/linear-api-fallback.ts',
        '  4. cat packages/specialist-worker/src/specialist/notion-api-fallback.ts',
        '  5. cat packages/specialist-worker/src/specialist/linear-specialist-agentic.ts',
        '  6. cat packages/specialist-worker/src/specialist/notion-specialist-agentic.ts',
        '  7. cat packages/web/app/api/v1/notion/query/route.ts',
        '  8. cat packages/specialist-worker/src/routes/a2a-rpc.ts | grep -A 20 "notion"',
        '  9. cat packages/specialist-worker/src/specialist/agent-card.ts',
        '',
        'Checklist (PASS or FAIL with line refs):',
        '  - notion-api-client.ts uses globalThis.fetch (not bare fetch)?',
        '  - notion-api-fallback.ts forwards `properties` on every entry?',
        '  - notion-api-fallback.ts has NO itemMatchesQuery anti-pattern?',
        '  - proxy route uses readBearerTokenFromRequest + readConfiguredSpecialistCloudApiToken + timingSafeEqual?',
        '  - proxy route sets Notion-Version: 2022-06-28 header?',
        '  - notion-specialist-agentic conditionally creates apiFallback (only when bindings exist)?',
        '  - routes/a2a-rpc.ts dispatches notion.enumerate to the new specialist?',
        '  - agent-card.ts advertises notion.enumerate in skills?',
        '',
        'Fix in place if any FAIL. When all PASS, write SELF_REVIEW_OK.',
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
        'Write three test files mirroring linear test conventions:',
        '',
        '  1. packages/specialist-worker/src/specialist/notion-api-client.test.ts',
        '     - Mock globalThis.fetch via vi.stubGlobal',
        '     - Assert listPages/listDatabases/searchPages/getPage/getDatabase/listBlocks POST correctly',
        '     - Auth headers, error response handling',
        '',
        '  2. packages/specialist-worker/src/specialist/notion-api-fallback.test.ts',
        '     - Mock NotionIntegration with fake list/search methods',
        '     - listPages returns 5 items → fallback returns 5 entries with properties populated',
        '     - filters {database:["..."]} pass through',
        '     - NO query-text substring filtering (mock returns 3, fallback returns all 3 regardless of request.text)',
        '     - Each entry has properties.{type, title, parent, tags, author, lastEditedAt, url}',
        '',
        '  3. packages/web/app/api/v1/notion/query/route.test.ts',
        '     - Mirror github route tests if any exist; rejects without/bad bearer token; happy-path 200',
        '',
        'Use vitest. Type-safe mocks. Match conventions in packages/specialist-worker/src/specialist/relayfile-workspace-reader.test.ts.',
      ].join('\n'),
      verification: { type: 'exit_code' },
      retries: 1,
    })
    .step('verify-tests-exist', {
      type: 'deterministic',
      dependsOn: ['write-tests'],
      command: [
        'set -e',
        'test -f packages/specialist-worker/src/specialist/notion-api-client.test.ts',
        'test -f packages/specialist-worker/src/specialist/notion-api-fallback.test.ts',
        'test -f packages/web/app/api/v1/notion/query/route.test.ts',
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
        'echo "=== web notion route ==="',
        'npx vitest run packages/web/app/api/v1/notion/query/route.test.ts 2>&1 | tail -40 || true',
        'echo TESTS_DONE',
      ].join(' && '),
      captureOutput: true,
      failOnError: false,
    })
    .step('fix-tests', {
      agent: 'tester',
      dependsOn: ['run-tests'],
      task: [
        'Fix test failures below. If all passed, exit 0.',
        '',
        '{{steps.run-tests.output}}',
        '',
        'Fix → re-run → iterate. No vi.skip / it.todo escapes.',
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
        'npx vitest run packages/web/app/api/v1/notion/query/route.test.ts 2>&1 | tail -10',
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
      agent: 'impl-agentic',
      dependsOn: ['typecheck'],
      task: [
        'Fix typecheck errors below. If clean, exit 0.',
        '',
        '{{steps.typecheck.output}}',
        '',
        'Re-run both tsc commands. No `as any` casts.',
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
      command: 'npx vitest run --root packages/specialist-worker 2>&1 | tail -15 && echo REGRESSION_OK',
      captureOutput: true,
      failOnError: true,
    })

    // ─────────────────────────────────────────────────────────────────
    // Phase 7: PEER REVIEW
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
        'Senior peer review. Audit the diff below.',
        '',
        'Look for:',
        '  1. Bugs (type confusion, swallowed errors, missing null checks).',
        '  2. Inconsistencies with linear analog (with line refs).',
        '  3. Security: timingSafeEqual, no === for token comparison, no secrets logged, .claude/rules/sst-secrets.md compliance.',
        '  4. Test gaps: untested error paths, untested filter combos.',
        '  5. itemMatchesQuery anti-pattern in notion-api-fallback.ts (must NOT exist).',
        '  6. properties populated on every Notion entity returned by the fallback.',
        '  7. Notion-Version header present and current (2022-06-28).',
        '',
        '=== full diff vs origin/main ===',
        '{{steps.peer-review-prep.output}}',
        '',
        'Output: per finding, [P0|P1|P2] <file>:<line> <description>. End with ALL_CLEAR or ACTIONABLE_FINDINGS_BELOW. Report only — do not fix in this step.',
      ].join('\n'),
      verification: { type: 'exit_code' },
      retries: 1,
    })
    .step('address-peer-review', {
      agent: 'impl-agentic',
      dependsOn: ['peer-review'],
      task: [
        'Read peer-review findings below. If ALL_CLEAR, exit 0.',
        '',
        '{{steps.peer-review.output}}',
        '',
        'Fix every P0 + P1. After fixes:',
        '  npx vitest run --root packages/specialist-worker',
        '  npx tsc -p packages/specialist-worker/tsconfig.json --noEmit',
        '  npx tsc -p packages/web/tsconfig.json --noEmit',
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
        'git add packages/web/app/api/v1/notion/query/route.ts',
        'git add packages/web/app/api/v1/notion/query/route.test.ts',
        'git add packages/specialist-worker/src/specialist/notion-api-client.ts',
        'git add packages/specialist-worker/src/specialist/notion-api-client.test.ts',
        'git add packages/specialist-worker/src/specialist/notion-api-fallback.ts',
        'git add packages/specialist-worker/src/specialist/notion-api-fallback.test.ts',
        'git add packages/specialist-worker/src/specialist/notion-specialist-agentic.ts',
        'git add packages/specialist-worker/src/routes/a2a-rpc.ts',
        'git add packages/specialist-worker/src/specialist/agent-card.ts',
        'git add packages/specialist-worker/package.json',
        'git diff --cached --quiet -- package-lock.json || git add package-lock.json',
        'MSG=$(mktemp)',
        'printf "%s\\n" \\',
        '  "feat(specialist): add Notion specialist + apiFallback (cloud-side half)" \\',
        '  "" \\',
        '  "Production trace: Slack DM \\"do you see any info about our investors in" \\',
        '  "notion?\\" returned canned \\"could not complete\\" reply because cloud" \\',
        '  "had no Notion specialist at all. Agent card advertised only" \\',
        '  "pr_investigation, github.enumerate, linear.enumerate." \\',
        '  "" \\',
        '  "This PR adds the cloud-side trio + agentic wrapper + a2a-rpc dispatch" \\',
        '  "+ agent card advertisement, mirroring the linear specialist." \\',
        '  "Pairs with upstream NotionLibrarian addition in @agent-assistant/specialists" \\',
        '  "(separate PR, already merged + republished — this PR bumps the dep)." \\',
        '  "" \\',
        '  "Self-reviewed against linear analog. Peer-reviewed by Claude Opus." \\',
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
        '  "Cloud-side build-out of the Notion specialist:" \\',
        '  "" \\',
        '  "- New \\`/api/v1/notion/query\\` Nango proxy endpoint." \\',
        '  "- New \\`notion-api-client.ts\\` NotionIntegration class." \\',
        '  "- New \\`notion-api-fallback.ts\\` NotionLibrarianApiFallback wrapper." \\',
        '  "- New \\`notion-specialist-agentic.ts\\` factory (mirrors linear)." \\',
        '  "- Wired \\`routes/a2a-rpc.ts\\` to dispatch \\`notion.enumerate\\`." \\',
        '  "- Updated \\`agent-card.ts\\` to advertise \\`notion.enumerate\\` skill." \\',
        '  "- Bumped \\`@agent-assistant/specialists\\` to pull in \\`createNotionLibrarian\\`." \\',
        '  "- DELIBERATELY no \\`itemMatchesQuery\\` anti-pattern." \\',
        '  "- Each fallback entry carries \\`properties\\` so the librarian post-filter actually finds matches." \\',
        '  "" \\',
        '  "## Production failure this fixes" \\',
        '  "" \\',
        '  "Slack DM \\"do you see any info about our investors in notion?\\" → sage canned reply because no Notion specialist existed. After this PR, sage delegates to the new notion specialist which returns real Notion data via the apiFallback path." \\',
        '  "" \\',
        '  "## Validation" \\',
        '  "" \\',
        '  "- [x] specialist-worker vitest suite green" \\',
        '  "- [x] notion route vitest green" \\',
        '  "- [x] tsc clean for specialist-worker AND packages/web" \\',
        '  "- [x] self-reviewed against linear analog" \\',
        '  "- [x] peer-reviewed by Claude Opus" \\',
        '  "- [ ] After deploy, retry \\"do you see any info about our investors in notion?\\" — expect specialist to return real findings via apiFallback on a single notion_enumerate call." \\',
        '  "" \\',
        '  "🤖 Generated with [Claude Code](https://claude.com/claude-code)" \\',
        '  > "$BODY"',
        'gh pr create --title "feat(specialist): add Notion specialist + apiFallback (cloud-side half)" --body-file "$BODY" 2>&1 | tee /tmp/notion-cloud-pr-url.txt',
        'rm -f "$BODY"',
        'echo "PR: $(tail -1 /tmp/notion-cloud-pr-url.txt)"',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
    .run({ cwd: process.cwd() });

  if (result.status !== 'completed') {
    throw new Error(`Workflow ended with status: ${result.status}`);
  }
  console.log('Notion specialist apiFallback workflow complete.');
}

runWorkflow().catch((error) => {
  console.error(error);
  process.exit(1);
});
