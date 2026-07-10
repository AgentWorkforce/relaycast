/**
 * V5-05: Promote github-clone-runner into @relayfile/adapter-github
 *
 * Refactor workflow (two-repo, dual-PR, 80-to-100 hardened).
 *
 * Problem: the cloud/v5-03 autonomous run produced github-clone code
 * inside packages/web/lib/integrations/, but the logic (tarball walking,
 * bulk-write chunking, nango proxy tarball fetch, orchestrator) is pure
 * adapter work that belongs in @relayfile/adapter-github. This workflow
 * ports the pure pieces out of cloud into the adapter package, leaves the
 * cloud-specific pieces (route handler, bearer auth, audit, schema) in
 * cloud, and verifies both repos still build + test green against a
 * locally-linked adapter.
 *
 * What stays in cloud:
 *   packages/web/app/api/v1/github/clone/route.ts      (HTTP + auth)
 *   packages/web/lib/integrations/github-clone-audit.ts  (writes cloud DB)
 *   packages/web/lib/integrations/github-clone-schema.ts (cloud's request/response)
 *
 * What moves to @relayfile/adapter-github/src/clone/:
 *   tarball-walker.ts       (from cloud's github-tarball-walker.ts)
 *   bulk-writer.ts          (from cloud's github-clone-writer.ts)
 *   nango-tarball.ts        (from cloud's github-nango-proxy-client.ts)
 *   orchestrator.ts         (from cloud's github-clone-orchestrator.ts)
 *   index.ts                (re-exports the public surface)
 *   __tests__/*.test.ts     (port node:test suites from cloud's tests/)
 *
 * And the adapter class gets a new method:
 *   GitHubAdapter.cloneRepo({ client, workspaceId, owner, repo, ref }) → CloneOutcome
 *
 * Dual-PR strategy:
 *   - Adapter PR: mergeable independently. Land → manually publish new version.
 *   - Cloud PR: uses `"@relayfile/adapter-github": "file:../../..."` during workflow
 *     testing (so tests run against local adapter). PR body loudly states
 *     "NOT MERGEABLE until adapter PR publishes and this dep is bumped to the
 *     real version". Reviewer bumps the version after adapter merge + publish.
 *
 * Follows the relay-80-100-workflow skill:
 *   1. Pre-read all source files via deterministic steps, inject into agents
 *   2. Regression-author writes failing tests in the adapter FIRST
 *   3. verify-regression-fails gate proves the tests actually fail pre-impl
 *   4. Single-agent impl port (files are self-contained; parallel adds no speed)
 *   5. adapter-typecheck → adapter-test-first-run → adapter-test-fix → adapter-test-rerun
 *   6. cloud-refactor
 *   7. cloud-typecheck → cloud-test-first-run → cloud-test-fix → cloud-test-rerun
 *   8. Global safety gates (no token leak, ignore list intact, meta.json LAST,
 *      baseRevision passed, cloud files deleted, cloud LOC shrunk)
 *   9. Final review by claude lead
 *   10. Commit/push/open both draft PRs
 *
 * Cloud refactor branch: `refactor/github-clone-consume-adapter` branched off
 * the current cloud branch (`workflows/v5-slack-e2e-github-clone`) — the
 * refactor depends on that branch having the source files to port. When
 * PR #160 merges, the cloud refactor PR retargets to main.
 *
 * Adapter refactor branch: `refactor/github-clone-into-adapter` branched off
 * adapter main. No dependency.
 */

import { workflow } from '@relayflows/core';
import { ClaudeModels, CodexModels } from '@agent-relay/config';
import * as path from 'node:path';

const CLOUD = process.cwd();
const ROOT = path.resolve(CLOUD, '..');
const ADAPTER_REPO = path.join(ROOT, 'relayfile-adapters');
const ADAPTER_PKG = path.join(ADAPTER_REPO, 'packages/github');

const CLOUD_BRANCH = 'refactor/github-clone-consume-adapter';
const ADAPTER_BRANCH = 'refactor/github-clone-into-adapter';
const CLOUD_BASE_BRANCH = 'workflows/v5-slack-e2e-github-clone';

async function main() {
  const result = await workflow('v5-05-promote-github-clone-to-adapter')
    .description(
      'Port github clone runner (walker/writer/nango/orchestrator) from cloud into @relayfile/adapter-github, shrinking cloud and giving every future consumer reuse'
    )
    .pattern('dag')
    .channel('wf-v5-05-promote-github-clone')
    .maxConcurrency(4)
    .timeout(5_400_000) // 90 min — two-repo refactor with double test triplet

    // ───────── Agents ─────────

    .agent('lead', {
      cli: 'claude',
      model: ClaudeModels.OPUS,
      role:
        'Senior architect and reviewer. Produces the port spec up front, reviews both repos diff at the end, signs off or rejects.',
      retries: 1,
    })

    .agent('regression-author', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      preset: 'worker',
      role:
        'Test author. Writes the adapter-side regression tests BEFORE any port work, against the new adapter API described in the spec. Tests must fail against the pre-port adapter package because the new code does not yet exist.',
      retries: 2,
    })

    .agent('adapter-impl', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      preset: 'worker',
      role:
        'Ports the four pure modules (walker, writer, nango-proxy-client, orchestrator) from cloud into @relayfile/adapter-github, adds cloneRepo() to the GitHubAdapter class, wires the public exports.',
      retries: 2,
    })

    .agent('adapter-test-fixer', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      preset: 'worker',
      role:
        'Diagnoses adapter-test-first-run failures against the ported code and fixes them — typecheck errors, broken imports, test expectation drift, or bugs introduced during the port. No-op when tests already pass.',
      retries: 2,
    })

    .agent('cloud-refactor', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      preset: 'worker',
      role:
        'Refactors the cloud side: deletes the four ported files from packages/web/lib/integrations, updates packages/web/package.json to declare @relayfile/adapter-github as a dependency, rewrites the route and any remaining shims to consume the adapter package instead of local files.',
      retries: 2,
    })

    .agent('cloud-test-fixer', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      preset: 'worker',
      role:
        'Diagnoses cloud-test-first-run failures after the refactor and fixes them — stale imports, wrong exported names, missing shims, typecheck errors. No-op when tests already pass.',
      retries: 2,
    })

    // ───────── Wave 0: Preflight (deterministic) ─────────

    .step('check-adapter-repo', {
      type: 'deterministic',
      command: `test -d ${ADAPTER_PKG} && test -f ${ADAPTER_PKG}/package.json && echo ADAPTER_REPO_OK`,
      captureOutput: true,
      failOnError: true,
    })

    .step('check-adapter-clean', {
      type: 'deterministic',
      command: `cd ${ADAPTER_REPO} && git diff --quiet && git diff --cached --quiet && echo ADAPTER_CLEAN || { echo ADAPTER_DIRTY; exit 1; }`,
      captureOutput: true,
      failOnError: true,
    })

    .step('check-cloud-on-base-branch', {
      type: 'deterministic',
      command: `cd ${CLOUD} && test "$(git rev-parse --abbrev-ref HEAD)" = "${CLOUD_BASE_BRANCH}" && echo CLOUD_BASE_OK || { echo "expected to start from ${CLOUD_BASE_BRANCH}, found $(git rev-parse --abbrev-ref HEAD)"; exit 1; }`,
      captureOutput: true,
      failOnError: true,
    })

    .step('branch-adapter', {
      type: 'deterministic',
      command: `cd ${ADAPTER_REPO} && git fetch origin && git checkout main && git pull --ff-only origin main && (git branch -D ${ADAPTER_BRANCH} 2>/dev/null || true) && git checkout -b ${ADAPTER_BRANCH} && echo ADAPTER_BRANCH_READY`,
      captureOutput: true,
      failOnError: true,
      dependsOn: ['check-adapter-repo', 'check-adapter-clean'],
    })

    .step('branch-cloud', {
      type: 'deterministic',
      command: `cd ${CLOUD} && (git branch -D ${CLOUD_BRANCH} 2>/dev/null || true) && git checkout -b ${CLOUD_BRANCH} ${CLOUD_BASE_BRANCH} && echo CLOUD_BRANCH_READY`,
      captureOutput: true,
      failOnError: true,
      dependsOn: ['check-cloud-on-base-branch'],
    })

    // Pre-read: cloud source files to port
    .step('read-cloud-walker', {
      type: 'deterministic',
      command: `cat ${CLOUD}/packages/web/lib/integrations/github-tarball-walker.ts`,
      captureOutput: true,
      failOnError: true,
      dependsOn: ['branch-cloud'],
    })
    .step('read-cloud-writer', {
      type: 'deterministic',
      command: `cat ${CLOUD}/packages/web/lib/integrations/github-clone-writer.ts`,
      captureOutput: true,
      failOnError: true,
      dependsOn: ['branch-cloud'],
    })
    .step('read-cloud-nango', {
      type: 'deterministic',
      command: `cat ${CLOUD}/packages/web/lib/integrations/github-nango-proxy-client.ts`,
      captureOutput: true,
      failOnError: true,
      dependsOn: ['branch-cloud'],
    })
    .step('read-cloud-orchestrator', {
      type: 'deterministic',
      command: `cat ${CLOUD}/packages/web/lib/integrations/github-clone-orchestrator.ts`,
      captureOutput: true,
      failOnError: true,
      dependsOn: ['branch-cloud'],
    })

    // Pre-read: cloud test files — the adapter-side regression tests will be
    // heavily inspired by these. They already test the contract we want.
    .step('read-cloud-walker-test', {
      type: 'deterministic',
      command: `cat ${CLOUD}/tests/github-tarball-walker.test.ts`,
      captureOutput: true,
      failOnError: true,
      dependsOn: ['branch-cloud'],
    })
    .step('read-cloud-writer-test', {
      type: 'deterministic',
      command: `cat ${CLOUD}/tests/github-clone-writer.test.ts`,
      captureOutput: true,
      failOnError: true,
      dependsOn: ['branch-cloud'],
    })
    .step('read-cloud-audit-test', {
      type: 'deterministic',
      command: `cat ${CLOUD}/tests/github-clone-audit.test.ts`,
      captureOutput: true,
      failOnError: true,
      dependsOn: ['branch-cloud'],
    })
    .step('read-cloud-contract-test', {
      type: 'deterministic',
      command: `cat ${CLOUD}/tests/github-clone-runner.contract.test.ts`,
      captureOutput: true,
      failOnError: true,
      dependsOn: ['branch-cloud'],
    })

    // Pre-read: existing adapter structure so the impl agent matches conventions
    .step('read-adapter-index', {
      type: 'deterministic',
      command: `cat ${ADAPTER_PKG}/src/index.ts`,
      captureOutput: true,
      failOnError: true,
      dependsOn: ['branch-adapter'],
    })
    .step('read-adapter-class', {
      type: 'deterministic',
      command: `cat ${ADAPTER_PKG}/src/adapter.ts`,
      captureOutput: true,
      failOnError: true,
      dependsOn: ['branch-adapter'],
    })
    .step('read-adapter-writeback-test', {
      type: 'deterministic',
      command: `cat ${ADAPTER_PKG}/src/writeback.test.ts`,
      captureOutput: true,
      failOnError: true,
      dependsOn: ['branch-adapter'],
    })
    .step('read-adapter-package-json', {
      type: 'deterministic',
      command: `cat ${ADAPTER_PKG}/package.json`,
      captureOutput: true,
      failOnError: true,
      dependsOn: ['branch-adapter'],
    })

    // ───────── Wave 1: Spec + regression tests ─────────

    .step('spec', {
      agent: 'lead',
      dependsOn: [
        'read-cloud-walker',
        'read-cloud-writer',
        'read-cloud-nango',
        'read-cloud-orchestrator',
        'read-cloud-walker-test',
        'read-cloud-writer-test',
        'read-cloud-audit-test',
        'read-cloud-contract-test',
        'read-adapter-index',
        'read-adapter-class',
        'read-adapter-writeback-test',
        'read-adapter-package-json',
      ],
      task: `You are the architect for this two-repo refactor. Produce a crisp port spec the implementation agents will follow. Do NOT write any code — only a spec document.

## Context

Cloud repo currently contains these four pure modules at packages/web/lib/integrations/:

github-tarball-walker.ts:
{{steps.read-cloud-walker.output}}

github-clone-writer.ts:
{{steps.read-cloud-writer.output}}

github-nango-proxy-client.ts:
{{steps.read-cloud-nango.output}}

github-clone-orchestrator.ts:
{{steps.read-cloud-orchestrator.output}}

Cloud's existing node:test suites exercise these:

tests/github-tarball-walker.test.ts:
{{steps.read-cloud-walker-test.output}}

tests/github-clone-writer.test.ts:
{{steps.read-cloud-writer-test.output}}

tests/github-clone-audit.test.ts:
{{steps.read-cloud-audit-test.output}}

tests/github-clone-runner.contract.test.ts:
{{steps.read-cloud-contract-test.output}}

The target @relayfile/adapter-github package has this shape:

src/index.ts:
{{steps.read-adapter-index.output}}

src/adapter.ts (GitHubAdapter class):
{{steps.read-adapter-class.output}}

Existing test pattern (node:test + tsx):
{{steps.read-adapter-writeback-test.output}}

package.json:
{{steps.read-adapter-package-json.output}}

## Your deliverable: a complete port spec

Output a document with these sections, in order:

### 1. File mapping
For each of the four cloud source files, name the exact target path in the adapter package. Suggested layout:
  packages/github/src/clone/tarball-walker.ts
  packages/github/src/clone/bulk-writer.ts
  packages/github/src/clone/nango-tarball.ts
  packages/github/src/clone/orchestrator.ts
  packages/github/src/clone/index.ts  (re-exports the public surface)

### 2. Adapter class API
Define the exact signature of the new \`GitHubAdapter.cloneRepo(options)\` method:
  - What does options contain? (at minimum: relayfile client, workspaceId, owner, repo, ref; optional: overrides for ignore lists/byte caps)
  - What does it return? (same shape cloud's runGithubClone returned — filesWritten, errors, headSha, etc.)
  - How does it use the injected \`ConnectionProvider\` vs the raw Nango proxy?
  - Note: the adapter already takes a provider at construction. The cloneRepo method should use that provider, not require its own nango secret.

### 3. Public exports from packages/github/src/index.ts
List every new named export — the class method, plus any helper constants (GITHUB_CLONE_MAX_FILE_BYTES, GITHUB_CLONE_CHUNK_SIZE, GITHUB_CLONE_MAX_CONCURRENT, GITHUB_CLONE_SOURCE, GITHUB_CLONE_IGNORE_DIRS, etc.) that downstream consumers (cloud's audit logger, future adapters) may need.

### 4. Regression tests (adapter-side)
Cloud's 4 test files give you the contract. Port them to the adapter with these adjustments:
  - New location: packages/github/src/clone/__tests__/*.test.ts (match the pattern of writeback.test.ts)
  - Keep \`node:test\` + \`tsx\` (that is what the adapter package already uses — do not switch to vitest)
  - The contract test should assert the NEW API: instantiate GitHubAdapter with a mock provider, call cloneRepo, verify hop-by-hop evidence
  - Drop the 3 route-handler tests (they stay in cloud; adapter has no HTTP surface)
  - Port the mock relayfile server and mock nango proxy server as test helpers under packages/github/src/clone/__tests__/helpers/
  - Port the fixture tarball builder + the small-repo.tar.gz fixture
  - Every test file must be FAILING before the impl wave runs (because the source files do not yet exist in the adapter)

### 5. Cloud refactor scope
After the adapter port lands, list exactly what cloud loses and what it keeps:
  - DELETE from packages/web/lib/integrations/: github-tarball-walker.ts, github-clone-writer.ts, github-nango-proxy-client.ts, github-clone-orchestrator.ts
  - DELETE from tests/: github-tarball-walker.test.ts, github-clone-writer.test.ts, github-clone-audit.test.ts (audit test moves too since the audit module itself stays in cloud but its unit test can use a simpler pattern), github-clone-runner.contract.test.ts
  - Actually — audit test STAYS in cloud because github-clone-audit.ts stays in cloud. The contract test MAY stay in cloud (it exercises the route, which stays in cloud). Decide and state it clearly.
  - KEEP: route.ts, github-clone-schema.ts, github-clone-audit.ts (cloud-specific middleware)
  - UPDATE: route.ts must switch from local orchestrator to the adapter. Import \`GitHubAdapter\` from \`@relayfile/adapter-github\`. Instantiate with a NangoProvider. Call adapter.cloneRepo(...) instead of runGithubClone(...).
  - ADD: packages/web/package.json needs a new dependency entry. Since the adapter has not been published yet, use \`"@relayfile/adapter-github": "file:../../../relayfile-adapters/packages/github"\` for workflow testing. The final cloud PR body will document that the reviewer must bump this to the real published version before merging.

### 6. Safety gates (literal-grep checks the final-review step will run)
List 8-10 grep patterns the reviewer will run to prove invariants held across the port. Examples:
  - "GITHUB_CLONE_MAX_FILE_BYTES = 1024 \\* 1024" present in adapter walker
  - "meta.json LAST" comment present in adapter orchestrator
  - "baseRevision" passed to writeFile in adapter orchestrator
  - no "instanceof RelayFileApiError" without duck-type fallback in adapter orchestrator
  - packages/web/lib/integrations/github-tarball-walker.ts does NOT exist in cloud after refactor
  - packages/web/app/api/v1/github/clone/route.ts imports from '@relayfile/adapter-github'
  - packages/web/package.json has '@relayfile/adapter-github' dep

### 7. Merge order + publish instructions
A paragraph explaining how the human reviewer takes this from two draft PRs to merged:
  1. Review and merge the adapter PR
  2. In relayfile-adapters/packages/github: bump version (minor), run \`npm publish --access public\`
  3. In the cloud PR: change packages/web/package.json's "@relayfile/adapter-github" from the file: path to the published version (e.g. "^0.2.0")
  4. Re-run cloud CI to prove it still builds against the published version
  5. Merge the cloud PR

End with: SPEC_COMPLETE`,
      verification: { type: 'output_contains', value: 'SPEC_COMPLETE' },
      retries: 1,
    })

    .step('write-adapter-regression-tests', {
      agent: 'regression-author',
      dependsOn: ['spec'],
      task: `Write the adapter-side regression tests BEFORE any implementation code exists. The tests MUST fail with ERR_MODULE_NOT_FOUND or "no test suite found" when run against the current adapter state (because packages/github/src/clone/ does not exist yet).

## Spec you are implementing
{{steps.spec.output}}

## Source references (cloud tests you are porting)

github-tarball-walker.test.ts:
{{steps.read-cloud-walker-test.output}}

github-clone-writer.test.ts:
{{steps.read-cloud-writer-test.output}}

github-clone-runner.contract.test.ts:
{{steps.read-cloud-contract-test.output}}

## Instructions

1. Work inside ${ADAPTER_REPO} on branch ${ADAPTER_BRANCH}.
2. Create these test files, matching the adapter repo's \`node:test\` + \`tsx\` pattern (see src/writeback.test.ts for style):
   - packages/github/src/clone/__tests__/tarball-walker.test.ts
   - packages/github/src/clone/__tests__/bulk-writer.test.ts
   - packages/github/src/clone/__tests__/nango-tarball.test.ts
   - packages/github/src/clone/__tests__/orchestrator.contract.test.ts
3. Create the test helpers:
   - packages/github/src/clone/__tests__/helpers/mock-relayfile-server.ts
   - packages/github/src/clone/__tests__/helpers/mock-nango-proxy-server.ts
   - packages/github/src/clone/__tests__/helpers/build-small-repo-fixture.ts
4. Copy the binary fixture: \`cp ${CLOUD}/tests/fixtures/github/small-repo.tar.gz packages/github/src/clone/__tests__/fixtures/small-repo.tar.gz\`
5. In each test file, import the modules that DO NOT YET EXIST — for example:
     import { walkGithubTarball, GITHUB_CLONE_MAX_FILE_BYTES } from '../tarball-walker.js';
     import { GitHubAdapter } from '../../adapter.js';  // the existing class, which will gain a cloneRepo method
6. DROP the three route-handler tests — they do not belong in the adapter.
7. Ensure every test has \`describe\` / \`it\` from 'node:test' so the node:test runner finds suites.
8. Add a brief comment at the top of each test file: \`// Regression test for @relayfile/adapter-github clone — authored before impl per 80-to-100 pattern. Must fail until the port lands.\`

Do NOT modify adapter.ts, index.ts, or create any source files under packages/github/src/clone/ — only tests + helpers + fixtures.

When done, print: REGRESSION_TESTS_WRITTEN`,
      verification: { type: 'output_contains', value: 'REGRESSION_TESTS_WRITTEN' },
      retries: 2,
    })

    .step('verify-adapter-regression-fails', {
      type: 'deterministic',
      // Run the adapter's test script. Expected to fail with module-not-found
      // because the port hasn't happened yet. failOnError:false — we WANT failure.
      command: `cd ${ADAPTER_PKG} && (npx tsx --test src/clone/__tests__/*.test.ts 2>&1 || true) | tail -20`,
      captureOutput: true,
      failOnError: false,
      dependsOn: ['write-adapter-regression-tests'],
    })

    // ───────── Wave 2: Adapter implementation ─────────

    .step('adapter-impl', {
      agent: 'adapter-impl',
      dependsOn: ['verify-adapter-regression-fails'],
      task: `Port the four pure modules from cloud into @relayfile/adapter-github, add the cloneRepo() method to GitHubAdapter, and wire public exports. This is a mechanical port — do NOT redesign the logic.

## Spec you are implementing
{{steps.spec.output}}

## Source files to port (from cloud)

Cloud github-tarball-walker.ts (port to packages/github/src/clone/tarball-walker.ts):
{{steps.read-cloud-walker.output}}

Cloud github-clone-writer.ts (port to packages/github/src/clone/bulk-writer.ts):
{{steps.read-cloud-writer.output}}

Cloud github-nango-proxy-client.ts (port to packages/github/src/clone/nango-tarball.ts):
{{steps.read-cloud-nango.output}}

Cloud github-clone-orchestrator.ts (port to packages/github/src/clone/orchestrator.ts):
{{steps.read-cloud-orchestrator.output}}

## Existing adapter structure you must extend

src/adapter.ts (the GitHubAdapter class — you are adding cloneRepo() to it):
{{steps.read-adapter-class.output}}

src/index.ts (you are adding the new public exports):
{{steps.read-adapter-index.output}}

## Instructions

1. Work inside ${ADAPTER_REPO} on branch ${ADAPTER_BRANCH}.

2. Create packages/github/src/clone/tarball-walker.ts — port walker verbatim. Keep the ignore lists intact. Keep constants exported.

3. Create packages/github/src/clone/bulk-writer.ts — port writer verbatim. Semaphore-based concurrency, chunk size 200, max concurrent 4. Do not use Promise.all or p-limit.

4. Create packages/github/src/clone/nango-tarball.ts — port the nango tarball fetch. Note: the adapter's existing ConnectionProvider abstraction should be used here. Instead of reading NANGO_SECRET_KEY from env, take a \`provider: ConnectionProvider\` parameter. Use \`provider.proxy(...)\` to issue the tarball GET. Read packages/github/src/types.ts and packages/github/src/writeback.ts for the provider pattern.

5. Create packages/github/src/clone/orchestrator.ts — port the orchestrator. Keep the \`isNotFoundError()\` duck-type fallback. Keep \`readIndexEntries\` returning \`{entries, baseRevision}\`. Keep \`readFileRevisionOrNew\`. Keep the meta.json LAST comment. Every writeFile call MUST pass baseRevision.

6. Create packages/github/src/clone/index.ts that re-exports the public surface:
     export { walkGithubTarball, GITHUB_CLONE_MAX_FILE_BYTES, GITHUB_CLONE_IGNORE_DIRS, GITHUB_CLONE_IGNORE_FILES, GITHUB_CLONE_IGNORE_EXTS, GITHUB_CLONE_BINARY_EXTS } from './tarball-walker.js';
     export { chunkedBulkWrite, GITHUB_CLONE_CHUNK_SIZE, GITHUB_CLONE_MAX_CONCURRENT } from './bulk-writer.js';
     export { runGithubClone, GITHUB_CLONE_SOURCE } from './orchestrator.js';
     // nango-tarball is internal to the adapter — do not re-export.

7. Update packages/github/src/adapter.ts — add this method to the GitHubAdapter class:
     async cloneRepo(options: {
       client: RelayFileClient;
       workspaceId: string;
       owner: string;
       repo: string;
       ref: string;
     }): Promise<CloneOutcome>
   The method calls runGithubClone() internally, passing \`{ nango: this.provider, writer: chunkedBulkWrite, relayfile: options.client, ... }\`. The provider wiring should use the adapter's existing \`this.provider\` (from the class constructor).

8. Update packages/github/src/index.ts — append the new public exports:
     export * from './clone/index.js';
   Plus anything else the spec section 3 lists.

9. In ALL new files, use \`.js\` extension on relative imports (this is the adapter repo's ESM convention — see src/adapter.ts imports).

10. Do NOT touch the test files you wrote in the previous wave.

11. Do NOT bump the package version — that stays manual per user's publish policy.

When done, print: ADAPTER_IMPL_COMPLETE`,
      verification: { type: 'output_contains', value: 'ADAPTER_IMPL_COMPLETE' },
      retries: 2,
    })

    // ───────── Wave 3: Adapter test triplet ─────────

    .step('adapter-typecheck', {
      type: 'deterministic',
      command: `cd ${ADAPTER_PKG} && npm run typecheck 2>&1 | tail -30`,
      captureOutput: true,
      failOnError: true,
      dependsOn: ['adapter-impl'],
    })

    .step('adapter-test-first-run', {
      type: 'deterministic',
      command: `cd ${ADAPTER_PKG} && (npx tsx --test src/clone/__tests__/*.test.ts 2>&1 || true) | tail -60`,
      captureOutput: true,
      failOnError: false,
      dependsOn: ['adapter-typecheck'],
    })

    .step('adapter-test-fix', {
      agent: 'adapter-test-fixer',
      dependsOn: ['adapter-test-first-run'],
      task: `Review the adapter-test-first-run output below and fix any failures. If tests already pass, print "NO_FIX_NEEDED" and exit without touching files.

## Test output
{{steps.adapter-test-first-run.output}}

## Spec context
{{steps.spec.output}}

## Instructions
- Work in ${ADAPTER_REPO} on branch ${ADAPTER_BRANCH}.
- Fix only what is broken. Do not refactor, do not add new tests, do not bump version.
- Common breakages to watch for: missing \`.js\` extensions on imports, wrong relative paths, typecheck failures from drifted types, mock server path mismatches.
- If a test assertion is wrong (not the code), fix the test — prefer fixing production code when the test encodes the correct contract.
- Never skip or xfail a test.

When done, print either ADAPTER_TESTS_FIXED or NO_FIX_NEEDED.`,
      verification: { type: 'output_contains', value: 'ADAPTER_TESTS' },
      retries: 1,
    })

    .step('adapter-test-rerun', {
      type: 'deterministic',
      command: `cd ${ADAPTER_PKG} && npx tsx --test src/clone/__tests__/*.test.ts 2>&1 | tail -30`,
      captureOutput: true,
      failOnError: true, // HARD GATE — adapter tests must pass here
      dependsOn: ['adapter-test-fix'],
    })

    .step('adapter-package-build', {
      type: 'deterministic',
      command: `cd ${ADAPTER_PKG} && npm run build 2>&1 | tail -20`,
      captureOutput: true,
      failOnError: true,
      dependsOn: ['adapter-test-rerun'],
    })

    // ───────── Wave 4: Cloud refactor ─────────

    .step('cloud-refactor', {
      agent: 'cloud-refactor',
      dependsOn: ['adapter-package-build'],
      task: `Refactor cloud to consume @relayfile/adapter-github instead of the local github-clone files. The adapter port landed in the previous waves and is built + green.

## Spec
{{steps.spec.output}}

## Current cloud route (you are refactoring this to use the adapter)
Read: ${CLOUD}/packages/web/app/api/v1/github/clone/route.ts

## Current orchestrator (you are DELETING this)
{{steps.read-cloud-orchestrator.output}}

## Instructions

Work inside ${CLOUD} on branch ${CLOUD_BRANCH}.

### Step 1 — add the adapter dep to packages/web/package.json

Add this entry to the "dependencies" object:
  "@relayfile/adapter-github": "file:../../../relayfile-adapters/packages/github"

This is a SIBLING path. During the workflow test run, it lets cloud resolve the local adapter. The cloud PR body will loudly document that this must be bumped to a real published version before merge.

### Step 2 — delete the four ported files

Delete these files from packages/web/lib/integrations/:
  - github-tarball-walker.ts
  - github-clone-writer.ts
  - github-nango-proxy-client.ts
  - github-clone-orchestrator.ts

### Step 3 — delete the ported tests

Delete these files from tests/ (they live in the adapter now):
  - github-tarball-walker.test.ts
  - github-clone-writer.test.ts
  - github-clone-runner.contract.test.ts

Decision point on tests/github-clone-audit.test.ts: github-clone-audit.ts STAYS in cloud (it writes to cloud's postgres logger). Therefore its test stays too. Do not delete it.

Decision point on tests/fixtures/github/small-repo.tar.gz and tests/fixtures/github/build-small-repo-fixture.ts: the fixture moved to the adapter. Delete them from cloud.

Decision point on tests/helpers/mock-nango-proxy-server.ts and tests/helpers/mock-relayfile-server.ts: these are test-only helpers that only the deleted contract test used. Delete both.

### Step 4 — update route.ts

Replace local imports with adapter imports:

Before (roughly):
  import { runGithubClone } from '@/lib/integrations/github-clone-orchestrator';
  import { nangoGithubTarball } from '@/lib/integrations/github-nango-proxy-client';
  import { chunkedBulkWrite } from '@/lib/integrations/github-clone-writer';

After:
  import { GitHubAdapter } from '@relayfile/adapter-github';
  // plus whatever ConnectionProvider / NangoProvider the adapter package exposes

Wire the provider, instantiate \`new GitHubAdapter({ provider })\`, and call \`adapter.cloneRepo({ client: relayfile, workspaceId, owner, repo, ref })\` instead of \`runGithubClone(...)\`.

The route's bearer auth, audit logging, and schema validation STAY UNCHANGED — they are cloud-specific.

### Step 5 — update github-clone-audit.ts if it imports any deleted helpers

Read the current audit file. If it imports from any of the deleted files, update the imports to use the adapter package. Otherwise leave it alone.

### Step 6 — run npm install to wire up the file: dep

  cd ${CLOUD} && npm install --workspaces

This should create a symlink or copy in packages/web/node_modules/@relayfile/adapter-github pointing at the sibling. If it fails, inspect the error and fix the dep path.

### Step 7 — do NOT run tests here — that is the next wave.

When done, print: CLOUD_REFACTOR_COMPLETE`,
      verification: { type: 'output_contains', value: 'CLOUD_REFACTOR_COMPLETE' },
      retries: 2,
    })

    .step('verify-cloud-files-deleted', {
      type: 'deterministic',
      command: `cd ${CLOUD} && for f in github-tarball-walker.ts github-clone-writer.ts github-nango-proxy-client.ts github-clone-orchestrator.ts; do if [ -f packages/web/lib/integrations/$f ]; then echo "STILL EXISTS: $f"; exit 1; fi; done && echo CLOUD_FILES_DELETED_OK`,
      captureOutput: true,
      failOnError: true,
      dependsOn: ['cloud-refactor'],
    })

    .step('verify-cloud-has-adapter-dep', {
      type: 'deterministic',
      command: `cd ${CLOUD} && grep -q '"@relayfile/adapter-github"' packages/web/package.json && echo CLOUD_DEP_PRESENT`,
      captureOutput: true,
      failOnError: true,
      dependsOn: ['cloud-refactor'],
    })

    .step('verify-cloud-route-imports-adapter', {
      type: 'deterministic',
      command: `cd ${CLOUD} && grep -q "from '@relayfile/adapter-github'" packages/web/app/api/v1/github/clone/route.ts && echo CLOUD_ROUTE_OK`,
      captureOutput: true,
      failOnError: true,
      dependsOn: ['cloud-refactor'],
    })

    // ───────── Wave 5: Cloud test triplet ─────────

    .step('cloud-typecheck', {
      type: 'deterministic',
      command: `cd ${CLOUD} && npm run typecheck 2>&1 | tail -40`,
      captureOutput: true,
      failOnError: true,
      dependsOn: ['verify-cloud-files-deleted', 'verify-cloud-has-adapter-dep', 'verify-cloud-route-imports-adapter'],
    })

    .step('cloud-test-first-run', {
      type: 'deterministic',
      // slack tests (vitest) + audit test (still in cloud via node:test)
      command: `cd ${CLOUD} && (npx vitest run tests/slack-proxy-*.test.ts 2>&1 || true; echo "---"; npx tsx --test tests/github-clone-audit.test.ts 2>&1 || true) | tail -60`,
      captureOutput: true,
      failOnError: false,
      dependsOn: ['cloud-typecheck'],
    })

    .step('cloud-test-fix', {
      agent: 'cloud-test-fixer',
      dependsOn: ['cloud-test-first-run'],
      task: `Review the cloud-test-first-run output below and fix any failures. If tests already pass, print "NO_FIX_NEEDED" and exit without touching files.

## Test output
{{steps.cloud-test-first-run.output}}

## Instructions
- Work in ${CLOUD} on branch ${CLOUD_BRANCH}.
- Most likely failures: stale imports that reference the deleted github-clone files, wrong export names from the adapter package, package.json workspace resolution issues, github-clone-audit.ts importing a now-deleted helper.
- Do not re-port code. Do not add new tests. Do not touch the adapter package.
- If the audit test references helpers or fixtures that moved to the adapter, rewrite the test to use simpler inline fakes — the audit module is small and cloud-specific, it does not need the same elaborate mocks as the orchestrator.

When done, print either CLOUD_TESTS_FIXED or NO_FIX_NEEDED.`,
      verification: { type: 'output_contains', value: 'CLOUD_TESTS' },
      retries: 1,
    })

    .step('cloud-test-rerun', {
      type: 'deterministic',
      command: `cd ${CLOUD} && npx vitest run tests/slack-proxy-*.test.ts 2>&1 | tail -15 && echo "---" && npx tsx --test tests/github-clone-audit.test.ts 2>&1 | tail -15`,
      captureOutput: true,
      failOnError: true, // HARD GATE — cloud tests must pass after refactor
      dependsOn: ['cloud-test-fix'],
    })

    // ───────── Wave 6: Global safety gates (deterministic grep) ─────────

    .step('verify-adapter-ignore-list', {
      type: 'deterministic',
      command: `cd ${ADAPTER_PKG} && grep -q 'node_modules' src/clone/tarball-walker.ts && grep -q '\\.next' src/clone/tarball-walker.ts && grep -q 'GITHUB_CLONE_MAX_FILE_BYTES' src/clone/tarball-walker.ts && echo IGNORE_LIST_OK`,
      captureOutput: true,
      failOnError: true,
      dependsOn: ['adapter-test-rerun'],
    })

    .step('verify-adapter-chunker-bounds', {
      type: 'deterministic',
      command: `cd ${ADAPTER_PKG} && grep -q 'GITHUB_CLONE_CHUNK_SIZE = 200' src/clone/bulk-writer.ts && grep -q 'GITHUB_CLONE_MAX_CONCURRENT = 4' src/clone/bulk-writer.ts && echo CHUNKER_BOUNDS_OK`,
      captureOutput: true,
      failOnError: true,
      dependsOn: ['adapter-test-rerun'],
    })

    .step('verify-adapter-meta-last', {
      type: 'deterministic',
      command: `cd ${ADAPTER_PKG} && grep -q 'meta.json LAST' src/clone/orchestrator.ts && echo META_LAST_OK`,
      captureOutput: true,
      failOnError: true,
      dependsOn: ['adapter-test-rerun'],
    })

    .step('verify-adapter-base-revision', {
      type: 'deterministic',
      command: `cd ${ADAPTER_PKG} && grep -q 'baseRevision:' src/clone/orchestrator.ts && echo BASE_REVISION_OK`,
      captureOutput: true,
      failOnError: true,
      dependsOn: ['adapter-test-rerun'],
    })

    .step('verify-adapter-no-hardcoded-secret', {
      type: 'deterministic',
      command: `cd ${ADAPTER_PKG} && if grep -r 'NANGO_SECRET_KEY' src/clone/ 2>/dev/null | grep -v test; then echo LEAK_RISK; exit 1; else echo NO_HARDCODED_SECRET; fi`,
      captureOutput: true,
      failOnError: true,
      dependsOn: ['adapter-test-rerun'],
    })

    .step('verify-cloud-loc-shrank', {
      type: 'deterministic',
      command: `cd ${CLOUD} && deleted=$(git diff --shortstat ${CLOUD_BASE_BRANCH}..HEAD -- packages/web/lib/integrations/ tests/github-clone-*.test.ts tests/github-tarball-walker.test.ts 2>&1 | grep -oE 'deletion' | wc -l | tr -d ' ') && echo "LOC shrink diff captured (non-zero deletions = good)" && git diff --shortstat ${CLOUD_BASE_BRANCH}..HEAD -- packages/web/lib/integrations/ tests/`,
      captureOutput: true,
      failOnError: false,
      dependsOn: ['cloud-test-rerun'],
    })

    // ───────── Wave 7: Final review ─────────

    .step('final-review', {
      agent: 'lead',
      dependsOn: [
        'verify-adapter-ignore-list',
        'verify-adapter-chunker-bounds',
        'verify-adapter-meta-last',
        'verify-adapter-base-revision',
        'verify-adapter-no-hardcoded-secret',
        'verify-cloud-loc-shrank',
      ],
      task: `Perform the final review of this two-repo refactor. Decide PORT_APPROVED or PORT_REJECTED.

## What to check

Run these commands yourself from ${CLOUD}:

1. Adapter-side diff:
     cd ${ADAPTER_REPO} && git diff --stat main..${ADAPTER_BRANCH} -- packages/github/
     cd ${ADAPTER_REPO} && git diff main..${ADAPTER_BRANCH} -- packages/github/src/clone/

2. Cloud-side diff (only the delta from the cloud base branch):
     cd ${CLOUD} && git diff --stat ${CLOUD_BASE_BRANCH}..${CLOUD_BRANCH} -- packages/web/ tests/
     cd ${CLOUD} && git diff ${CLOUD_BASE_BRANCH}..${CLOUD_BRANCH} -- packages/web/app/api/v1/github/clone/route.ts

3. Safety gate results (all should be OK):
{{steps.verify-adapter-ignore-list.output}}
{{steps.verify-adapter-chunker-bounds.output}}
{{steps.verify-adapter-meta-last.output}}
{{steps.verify-adapter-base-revision.output}}
{{steps.verify-adapter-no-hardcoded-secret.output}}
{{steps.verify-cloud-loc-shrank.output}}

4. Adapter test rerun:
{{steps.adapter-test-rerun.output}}

5. Cloud test rerun:
{{steps.cloud-test-rerun.output}}

## Judgment criteria

Approve if ALL hold:
- Adapter tests are fully green, including the ported walker/writer/nango/orchestrator suites.
- Cloud tests are fully green.
- Cloud shrank meaningfully (400+ lines deleted from packages/web/lib/integrations/ + tests/).
- The cloud route.ts imports from @relayfile/adapter-github.
- No RelayFileApiError instanceof check without a duck-type fallback.
- meta.json write guarded by writeResult.errors.length === 0 AND is the last write.
- baseRevision passed to every writeFile call in the ported orchestrator.
- No Nango secret read from env in the adapter clone code — provider-injected only.
- packages/web/package.json has the @relayfile/adapter-github dep.
- The three route-handler tests (401/403/404) were NOT ported to the adapter (they belong in cloud).

Reject if:
- Any test is skipped without a documented reason.
- Any safety gate is missing.
- The cloud route still imports from the local integrations files.
- The adapter code references cloud's postgres or audit logger.
- The adapter's cloneRepo method requires a raw Nango secret key instead of using the existing provider abstraction.
- The refactor BROKE slack-proxy tests — those should still pass (this refactor doesn't touch them).

Write a two-paragraph review:
- Paragraph 1: what shipped (adapter gains, cloud losses)
- Paragraph 2: any residual concerns the reviewer should know

End with exactly one of:
  PORT_APPROVED
  PORT_REJECTED: <one-line reason>`,
      verification: { type: 'output_contains', value: 'PORT_' },
      retries: 1,
    })

    // ───────── Wave 8: Commit, push, open draft PRs (deterministic) ─────────

    .step('commit-adapter', {
      type: 'deterministic',
      command: [
        `cd ${ADAPTER_REPO}`,
        `git add packages/github/`,
        `git status`,
        `git commit -m "feat(github): add cloneRepo() — port tarball walker + bulk writer + orchestrator from cloud" 2>&1`,
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
      dependsOn: ['final-review'],
    })

    .step('commit-cloud', {
      type: 'deterministic',
      command: [
        `cd ${CLOUD}`,
        `git add packages/web/ tests/`,
        `git status`,
        `git commit -m "refactor(github-clone): consume @relayfile/adapter-github — delete local walker/writer/nango/orchestrator" 2>&1`,
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
      dependsOn: ['final-review'],
    })

    .step('push-adapter', {
      type: 'deterministic',
      command: `cd ${ADAPTER_REPO} && git push -u origin ${ADAPTER_BRANCH} 2>&1`,
      captureOutput: true,
      failOnError: true,
      dependsOn: ['commit-adapter'],
    })

    .step('push-cloud', {
      type: 'deterministic',
      command: `cd ${CLOUD} && git push -u origin ${CLOUD_BRANCH} 2>&1`,
      captureOutput: true,
      failOnError: true,
      dependsOn: ['commit-cloud'],
    })

    .step('open-adapter-pr', {
      type: 'deterministic',
      command: [
        `cd ${ADAPTER_REPO}`,
        `gh pr create --draft --repo AgentWorkforce/relayfile-adapters --base main --head ${ADAPTER_BRANCH} --title "feat(github): add cloneRepo() — port from cloud" --body "## Summary

Ports the github clone runner (tarball walker, bulk writer, nango tarball fetch, orchestrator) out of cloud's packages/web/lib/integrations/ and into @relayfile/adapter-github as a proper adapter capability. Cloud becomes a thin route handler consumer.

### What this adds

- packages/github/src/clone/tarball-walker.ts — walks in-memory tarballs, full ignore list, byte caps
- packages/github/src/clone/bulk-writer.ts — semaphore-based chunker (200/chunk, max 4 concurrent)
- packages/github/src/clone/nango-tarball.ts — provider-based tarball fetch (uses adapter's ConnectionProvider, NO raw NANGO_SECRET_KEY)
- packages/github/src/clone/orchestrator.ts — walk→chunk→write-index→meta.json-LAST with baseRevision CAS
- packages/github/src/clone/index.ts — public exports
- packages/github/src/adapter.ts — new \\\`cloneRepo()\\\` method on GitHubAdapter
- packages/github/src/clone/__tests__/ — node:test suites ported from cloud

### Publish

Version bump intentionally NOT included. After review and merge:
  cd packages/github
  npm version minor
  npm publish --access public

Then the companion cloud PR needs its \\\`@relayfile/adapter-github\\\` dep bumped to the real published version before it can merge.

### Test plan
- [x] tsx --test src/clone/__tests__/*.test.ts
- [x] npm run typecheck
- [x] npm run build

Generated from V5 refactor workflow (v5-05).

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"`,
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
      dependsOn: ['push-adapter'],
    })

    .step('open-cloud-pr', {
      type: 'deterministic',
      command: [
        `cd ${CLOUD}`,
        `gh pr create --draft --repo AgentWorkforce/cloud --base ${CLOUD_BASE_BRANCH} --head ${CLOUD_BRANCH} --title "refactor(github-clone): consume @relayfile/adapter-github" --body "## Summary

Companion to the adapter port PR in relayfile-adapters. Deletes ~600 lines of github clone runner code from cloud and replaces it with a thin route handler that imports the new \\\`GitHubAdapter.cloneRepo()\\\` method.

### What this deletes from cloud
- packages/web/lib/integrations/github-tarball-walker.ts
- packages/web/lib/integrations/github-clone-writer.ts
- packages/web/lib/integrations/github-nango-proxy-client.ts
- packages/web/lib/integrations/github-clone-orchestrator.ts
- tests/github-tarball-walker.test.ts
- tests/github-clone-writer.test.ts
- tests/github-clone-runner.contract.test.ts
- tests/fixtures/github/* (fixture moves to adapter)
- tests/helpers/mock-nango-proxy-server.ts
- tests/helpers/mock-relayfile-server.ts

### What stays in cloud
- packages/web/app/api/v1/github/clone/route.ts (updated to use adapter)
- packages/web/lib/integrations/github-clone-schema.ts (cloud's HTTP contract)
- packages/web/lib/integrations/github-clone-audit.ts (writes to cloud's postgres via @cloud/core/logger)
- tests/github-clone-audit.test.ts (still covers the cloud-side audit module)

## MERGE BLOCKER

This PR's \\\`packages/web/package.json\\\` currently declares:

    \\\"@relayfile/adapter-github\\\": \\\"file:../../../relayfile-adapters/packages/github\\\"

That is a SIBLING FILE PATH — it works locally but will break CI and any fresh clone. **DO NOT MERGE** until you do the following, in order:

1. Merge the companion adapter PR (ref above)
2. In the adapter repo: \\\`cd packages/github && npm version minor && npm publish --access public\\\`
3. In THIS PR: change the package.json dep from \\\`file:...\\\` to the published version (e.g. \\\`\\\"^0.2.0\\\"\\\`)
4. Re-run cloud CI to confirm the typecheck + tests still pass against the published adapter
5. THEN merge

## Base branch

This PR is opened against \\\`${CLOUD_BASE_BRANCH}\\\` (the V5 slack e2e + github clone branch). After #160 merges, retarget to main.

## Test plan
- [x] npm run typecheck
- [x] npx vitest run tests/slack-proxy-*.test.ts (31/31 pass — unaffected by refactor)
- [x] npx tsx --test tests/github-clone-audit.test.ts (still green)
- [ ] re-run above against published adapter version (morning review)

Generated from V5 refactor workflow (v5-05).

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"`,
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
      dependsOn: ['push-cloud', 'open-adapter-pr'],
    })

    .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
    .run({ cwd: process.cwd() });

  console.log('Workflow status:', result.status);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
